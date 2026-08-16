import { execSync } from "node:child_process";
import type { ShipDecisionEffect } from "../effects.js";
import { defaultGhRun, type GhRunner, parseGhJson } from "../roadmap/github-issues.js";
import { collectLoggedAssistedByIdentities, identitiesForProviders, withAssistedBy } from "./assisted-by.js";
import type { ExecFn } from "./bookkeeping.js";
import { assertCiNotRed } from "./ci-guard.js";

export interface ShipPrEffectsDeps {
	exec?: ExecFn;
	gh?: GhRunner;
	log: (msg: string) => void;
	assistedByProviders?: import("../types.js").ProviderName[];
}

/**
 * OIDs the harness observed when the deterministic gates passed. ADR-0025 — verification
 * bound to the candidate SHA, never a mutable ref — applied to the PR-ship path: the
 * writable ship agent runs AFTER typecheck + pre-flight review, so "the tree is clean"
 * proves nothing about WHAT is clean. `runShipPrEffects` refuses to ship unless the
 * worktree still matches both OIDs exactly. Fail closed; no auto-regate.
 */
export interface PrShipGateBinding {
	/** Worktree HEAD OID snapshotted by the pipeline when the last gate + pre-flight review passed. */
	gatedHeadOid: string;
	/** `origin/main` OID retained at fetch time by `preparePrShipFreshness`. */
	originMainOid: string;
}

const OID_RE = /^[0-9a-f]{7,40}$/i;

export interface ShipPrEffectsResult {
	prUrl: string;
	/** Forge PR number, or null when `pr create`'s URL did not parse. Carried as-is for the
	 *  #387 mid-run review enqueue; a null skips the enqueue (cold-start drain recovers the PR)
	 *  and NEVER fails the ship — the PR is already on the forge. */
	prNumber: number | null;
	/** Squashed HEAD OID just pushed, or null when it could not be read. Same skip-on-null contract. */
	headSha: string | null;
}

interface ExistingPr {
	number: number;
	url: string;
}

const defaultExec: ExecFn = (cmd, cwd) => {
	return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
};

export async function runShipPrEffects(
	ctx: {
		cwd: string;
		itemId: string;
		decision: ShipDecisionEffect;
		gate: PrShipGateBinding;
	},
	deps: ShipPrEffectsDeps,
): Promise<ShipPrEffectsResult> {
	const exec = deps.exec ?? defaultExec;
	const gh = deps.gh ?? defaultGhRun;
	const { cwd, decision, gate } = ctx;
	if (decision.target === "direct-push") throw new Error("ship.ShipDecision is not supported for direct-push");
	if (decision.itemId !== ctx.itemId) throw new Error(`ship decision itemId ${decision.itemId} does not match ${ctx.itemId}`);
	// Validated before shell interpolation below; the binding is harness-produced, so a
	// non-OID here is a wiring bug, not agent input.
	if (!OID_RE.test(gate.gatedHeadOid)) throw new Error(`gate binding gatedHeadOid is not a git OID: ${gate.gatedHeadOid}`);
	if (!OID_RE.test(gate.originMainOid)) throw new Error(`gate binding originMainOid is not a git OID: ${gate.originMainOid}`);

	const status = exec("git status --porcelain", cwd);
	if (status.trim() !== "") throw new Error("refusing PR ship with dirty worktree");

	const branch = exec("git branch --show-current", cwd).trim();
	if (branch !== decision.headBranch) throw new Error(`head branch mismatch: current ${branch || "(detached)"} does not match decision ${decision.headBranch}`);

	// ADR-0025 (verification bound to the candidate SHA) applied to the PR-ship path:
	// the SHA that passed typecheck and pre-flight review must be the exact SHA this
	// effect ships. The writable ship agent (Edit + Bash(git:*)) ran between the gates
	// and this dispatch, so require an exact pre-effect match against the gated HEAD
	// OID — a clean post-gate commit is NOT gated. Fail closed, no auto-regate.
	const head = exec("git rev-parse HEAD", cwd).trim();
	if (head !== gate.gatedHeadOid) {
		throw new Error(`refusing ship effect: HEAD ${head} does not match gated OID ${gate.gatedHeadOid} — post-gate commits are ungated`);
	}

	// Freshness is owned by the pipeline (author can repair a conflict). The effect
	// handler re-verifies the remote base against the OID retained at fetch time —
	// never the mutable ref, which an intervening agent step can move — then squashes
	// against that OID; resetting to local `main` after merging `origin/main` would
	// fold upstream-only commits into the feature squash.
	let originMainNow: string;
	try {
		originMainNow = exec("git rev-parse --verify origin/main", cwd).trim();
	} catch (e) {
		throw new Error(`origin/main does not resolve: ${short(e)}`);
	}
	if (originMainNow !== gate.originMainOid) {
		throw new Error(`refusing ship effect: origin/main ${originMainNow} does not match fetched OID ${gate.originMainOid} — ref moved after fetch`);
	}
	try {
		exec(`git merge-base --is-ancestor ${gate.originMainOid} HEAD`, cwd);
	} catch {
		throw new Error(`fetched origin/main OID ${gate.originMainOid} is not an ancestor of HEAD — branch is not fresh`);
	}

	const mergeBase = exec(`git merge-base ${gate.originMainOid} HEAD`, cwd).trim();
	if (!mergeBase) throw new Error("cannot determine merge-base with the fetched origin/main OID");
	exec(`git reset --soft ${shellQuote(mergeBase)}`, cwd);
	// Always-on Assisted-by trailers (#189): stamp realized cycle providers from the
	// cycle log when present; withAssistedBy falls back to the default identity.
	const assistedBody = withAssistedBy(decision.prBody, [...collectLoggedAssistedByIdentities(ctx.itemId), ...identitiesForProviders(deps.assistedByProviders ?? [])]);
	exec(`git commit -m ${shellQuote(decision.prTitle)} -m ${shellQuote(assistedBody)}`, cwd);

	const changed = exec(`git diff --name-only ${gate.originMainOid}...HEAD`, cwd)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("docs/plans/") && !line.startsWith("docs/decision-log/"));
	if (changed.length === 0) throw new Error("nothing to ship: branch only touches docs/plans/ and/or docs/decision-log/ after squash");

	pushBranch(exec, cwd, deps.log);
	// Read the squashed HEAD created by the commit above — the exact SHA the #387 review
	// status is posted against. Carried as-is (null on error); the enqueue skips on null and
	// the ship never fails on a missing enqueue input.
	const headSha = headShaOf(exec, cwd);
	const upserted = upsertPr(gh, decision);
	if (decision.target === "auto-merge-pr") {
		if (upserted.number === null) throw new Error("cannot enable auto-merge without a PR number");
		// Deterministic red-merge guard (#292): refuse to queue auto-merge onto a PR that
		// already has a confirmed-red check, independent of how branch protection is (or
		// isn't) configured. Pending checks are fine — `--auto` itself defers the merge.
		assertCiNotRed(gh, upserted.number);
		runGh(gh, ["pr", "merge", "--auto", "--squash", String(upserted.number)]);
		deps.log(`auto-merge enabled for ${upserted.url}`);
	}
	return { prUrl: upserted.url, prNumber: upserted.number, headSha };
}

/** HEAD OID of the just-pushed squash commit, or null if it can't be read. Never throws:
 *  a landed PR whose HEAD couldn't be resolved is still a shipped PR (see the null contract). */
function headShaOf(exec: ExecFn, cwd: string): string | null {
	try {
		const sha = exec("git rev-parse HEAD", cwd).trim();
		return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
	} catch {
		return null;
	}
}

function pushBranch(exec: ExecFn, cwd: string, log: (msg: string) => void): void {
	try {
		exec("git push -u origin HEAD", cwd);
		return;
	} catch (e) {
		log(`push rejected; retrying with --force-with-lease (${short(e)})`);
		exec("git push --force-with-lease -u origin HEAD", cwd);
	}
}

function upsertPr(gh: GhRunner, decision: ShipDecisionEffect): { number: number | null; url: string } {
	const existingRaw = runGh(gh, ["pr", "list", "--head", decision.headBranch, "--state", "open", "--json", "number,url", "--limit", "1"]).stdout;
	const existing = parseGhJson<ExistingPr[]>(existingRaw, isExistingPrList);
	const current = existing[0];
	if (current) {
		// REST, not `gh pr edit` (#474). `gh pr edit` resolves the PR through GraphQL, and that
		// query selects `projectCards` — a Projects (classic) field. On a repo where classic
		// projects have been sunset the whole call fails with
		//   GraphQL: Projects (classic) is being deprecated in favor of the new Projects experience
		// and the ship step dies with `effect_failed`, even though nothing here touches
		// projects and the only fields being changed are title and body. Observed on cycle 328.
		// The REST endpoint updates exactly those two fields and never queries projects.
		// `{owner}/{repo}` are gh placeholders resolved from the same repo context the
		// surrounding `pr list` / `pr create` calls already rely on.
		runGh(gh, ["api", `repos/{owner}/{repo}/pulls/${current.number}`, "-X", "PATCH", "-f", `title=${decision.prTitle}`, "-f", `body=${decision.prBody}`]);
		return { number: current.number, url: current.url };
	}
	const created = runGh(gh, ["pr", "create", "--title", decision.prTitle, "--body", decision.prBody, "--head", decision.headBranch]).stdout.trim();
	if (!created) throw new Error("gh pr create did not return a PR URL");
	return { number: parsePrNumber(created), url: created };
}

function runGh(gh: GhRunner, args: string[]): { stdout: string; stderr: string; status: number } {
	const result = gh(args);
	if (result.status !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `status ${result.status}`;
		throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${detail}`);
	}
	return result;
}

function isExistingPrList(value: unknown): value is ExistingPr[] {
	return Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.number === "number" && typeof entry.url === "string");
}

function parsePrNumber(url: string): number | null {
	const match = url.match(/\/pull\/(\d+)(?:\D*)?$/);
	return match ? Number.parseInt(match[1], 10) : null;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function short(e: unknown): string {
	return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
