import { execSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { CONFIG } from "../config.js";

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

// Message-parsing is a RACE-ONLY fallback (LC_ALL=C pins the locale): the
// branch-exists case is normally caught by the show-ref pre-check below. Only
// branch-shaped messages map to AlreadyClaimedError — a pre-existing worktree
// DIRECTORY is an environment problem and must stay a loud, distinct error
// (mapping it to exit 3 would livelock /pick next on the same item forever).
const BRANCH_EXISTS_RE = /branch named .* already exists|already checked out/i;

const GIT_ENV = { ...process.env, LC_ALL: "C" };

function branchExists(repo: string, branch: string): boolean {
	try {
		execSync(`git show-ref --verify --quiet ${JSON.stringify(`refs/heads/${branch}`)}`, { cwd: repo, stdio: "pipe", env: GIT_ENV });
		return true;
	} catch {
		return false;
	}
}

/** Shared by all adapters: create the claim branch (+ worktree unless noWorktree). */
export function createClaimWorkspace(repo: string, id: string, branch: string, opts?: { noWorktree?: boolean }): { branch: string; worktree: string } {
	if (branchExists(repo, branch)) throw new AlreadyClaimedError(id, branch);
	const run = (cmd: string) => {
		try {
			execSync(cmd, { cwd: repo, stdio: "pipe", env: GIT_ENV });
		} catch (err) {
			const msg = [(err as { stderr?: Buffer }).stderr?.toString(), (err as Error).message].filter(Boolean).join(" ");
			if (BRANCH_EXISTS_RE.test(msg)) throw new AlreadyClaimedError(id, branch); // lost a claim race
			// Any other failure (e.g. the worktree DIRECTORY already exists) may
			// still have created the branch as a side effect — git makes the branch
			// before staging the worktree dir. We know it didn't exist pre-check,
			// so delete the phantom or the item reads claimed-by-nobody forever.
			if (branchExists(repo, branch)) {
				try {
					execSync(`git branch -D ${JSON.stringify(branch)}`, { cwd: repo, stdio: "pipe", env: GIT_ENV });
				} catch {
					// leave it — the rethrown error below still names the real cause
				}
			}
			throw err;
		}
	};
	if (opts?.noWorktree) {
		run(`git checkout -b ${branch} main`);
		return { branch, worktree: repo };
	}
	// Documented precedence (env > worktree.prefix yml > basename), resolved
	// against THIS adapter's repo so temp-repo tests and consumers stay isolated.
	const prefix = process.env.CLAUDE_AUTOPILOT_WORKTREE_PREFIX ?? CONFIG.worktreePrefixFromYml ?? `${basename(repo)}-`;
	const worktree = resolve(repo, "..", `${prefix}${id.toLowerCase()}`);
	run(`git worktree add -b ${branch} ${worktree} main`);
	return { branch, worktree };
}

/**
 * IDs currently claimed in this repo, derived from feat/* branches. Consumed by
 * the markdown adapter's status overlay; github/linear read their own
 * server-side markers instead. A branch slug is attributed to the LONGEST known
 * id it extends at a `-` boundary, so hierarchical ids don't shadow each other
 * (feat/comp-11-c claims COMP-11-C, not COMP-11; feat/tool-1-fix claims TOOL-1,
 * never TOOL-10).
 */
export function claimedIds(repo: string, ids: string[]): Set<string> {
	let out: string;
	try {
		out = execSync("git for-each-ref --format='%(refname:short)' refs/heads/feat/", { cwd: repo, stdio: "pipe", encoding: "utf-8", env: GIT_ENV });
	} catch {
		return new Set(); // not a git repo / no refs — degrade open
	}
	const slugs = out
		.split("\n")
		.filter(Boolean)
		.map((b) => b.replace(/^feat\//, "").toLowerCase());
	const byLengthDesc = [...ids].sort((a, b) => b.length - a.length);
	const claimed = new Set<string>();
	for (const slug of slugs) {
		const winner = byLengthDesc.find((id) => {
			const idLower = id.toLowerCase();
			return slug === idLower || slug.startsWith(`${idLower}-`);
		});
		if (winner) claimed.add(winner);
	}
	return claimed;
}
