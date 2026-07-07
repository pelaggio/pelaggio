import { execSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Git-native claiming (issue #12): the feat/<id> branch IS the claim. git's own
 * ref locking makes creation atomic — when two picks race, exactly one
 * `worktree add -b` / `checkout -b` succeeds and the loser gets a legible
 * AlreadyClaimedError (CLI exit 3 → `pick-result: already-claimed`). Release is
 * branch deletion, which ship bookkeeping and /tidy already own. There is no
 * claims file, owner pid, or staleness lifecycle by design.
 */

export class AlreadyClaimedError extends Error {
	constructor(
		readonly id: string,
		readonly branch: string,
	) {
		super(`${id} is already claimed: branch ${branch} exists (a live cycle owns it, or a stale claim awaits /tidy)`);
		this.name = "AlreadyClaimedError";
	}
}

const EXISTS_RE = /already exists|already checked out|already used by worktree/i;

/**
 * Shared by all adapters: create the claim branch (+ worktree unless noWorktree).
 * `worktreeName` preserves each adapter's pre-existing naming; the markdown
 * default mirrors its historical env ?? basename prefix.
 */
export function createClaimWorkspace(repo: string, id: string, branch: string, opts?: { noWorktree?: boolean; worktreeName?: string }): { branch: string; worktree: string } {
	const run = (cmd: string) => {
		try {
			execSync(cmd, { cwd: repo, stdio: "pipe" });
		} catch (err) {
			const msg = [(err as { stderr?: Buffer }).stderr?.toString(), (err as Error).message].filter(Boolean).join(" ");
			if (EXISTS_RE.test(msg)) throw new AlreadyClaimedError(id, branch);
			throw err;
		}
	};
	if (opts?.noWorktree) {
		run(`git checkout -b ${branch} main`);
		return { branch, worktree: repo };
	}
	const prefix = process.env.CLAUDE_AUTOPILOT_WORKTREE_PREFIX ?? `${repo.split("/").pop()}-`;
	const worktree = resolve(repo, "..", opts?.worktreeName ?? `${prefix}${id.toLowerCase()}`);
	run(`git worktree add -b ${branch} ${worktree} main`);
	return { branch, worktree };
}

/**
 * IDs currently claimed in this repo, derived from feat/* branches. Consumed by
 * the markdown adapter's status overlay; github/linear read their own
 * server-side markers instead. `ids` are the roadmap's known item IDs — a
 * branch claims an id when its slug starts with the lowercased id at a word
 * boundary (feat/tool-9-fix claims TOOL-9, not TOOL-90).
 */
export function claimedIds(repo: string, ids: string[]): Set<string> {
	let out: string;
	try {
		out = execSync("git for-each-ref --format='%(refname:short)' refs/heads/feat/", { cwd: repo, stdio: "pipe", encoding: "utf-8" });
	} catch {
		return new Set(); // not a git repo / no refs — degrade open
	}
	const slugs = out
		.split("\n")
		.filter(Boolean)
		.map((b) => b.replace(/^feat\//, "").toLowerCase());
	const claimed = new Set<string>();
	for (const id of ids) {
		const idLower = id.toLowerCase();
		if (slugs.some((s) => s === idLower || s.startsWith(`${idLower}-`))) claimed.add(id);
	}
	return claimed;
}
