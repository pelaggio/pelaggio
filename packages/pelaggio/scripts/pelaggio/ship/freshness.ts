/** PR-ship freshness and landing verification against origin/main (L2). */
import { execSync } from "node:child_process";
import { defaultGitArgvExec, type GitArgvExec, hasMergeHead, oidIsAncestorOfHead, porcelainStatus, resolveOriginMainOid, tryGitArgv, unmergedPaths, upstreamTouchedFrom } from "../git.js";

/**
 * Parse a structured `ship-merged: <ID>` line from the /ship or /shipwreck
 * hand-off-gate output. Last occurrence wins (the skill may restate it in a
 * summary). The ID grammar is permissive — uppercase-prefixed markdown IDs
 * (`COMP-11C-II`), Linear keys (`ENG-123`), AND the bare numeric IDs
 * github-issues emits (`37`) — because the caller validates the real
 * constraint (equality to the resolved itemId). Malformed / absent → null.
 */
export function parseShipMerged(text: string): string | null {
	const re = /^[ \t]*ship-merged:[ \t]*([^\s][^\n]*?)[ \t]*$/gim;
	let last: string | null = null;
	for (const m of text.matchAll(re)) last = m[1];
	if (last === null) return null;
	return /^[A-Za-z0-9][\w-]*$/.test(last) ? last : null;
}

/**
 * Non-failed results retain `originMainOid` — the OID `origin/main` resolved to when this
 * run observed it (immediately post-fetch, or at classification time on the no-fetch
 * resume path). ADR-0025: every later freshness check and the ship effect bind to this
 * OID, never to the mutable `origin/main` ref name, which a subsequent writable author
 * step can move. `conflicted` carries `null` only when `origin/main` does not resolve at
 * all (pathological resume); the pipeline fails closed on a null OID before shipping.
 */
export type PrShipFreshnessResult =
	| { kind: "up-to-date"; originMainOid: string }
	| { kind: "merged"; upstreamTouchedFiles: string[]; originMainOid: string }
	| { kind: "conflicted"; unmergedFiles: string[]; upstreamTouchedFiles: string[]; originMainOid: string | null }
	| { kind: "failed"; detail: string };

export type PrShipFreshnessVerification = { ok: true } | { ok: false; detail: string };

/**
 * Fetch `origin/main` and merge it into the claim worktree.
 *
 * `conflicted` includes the resume-after-park case: `parkExit()` → `checkpoint()`
 * cannot commit an unresolved merge, so a parked tree is dirty-with-`MERGE_HEAD`,
 * not a generic dirty input. Treating that as `failed` would abort resume.
 *
 * Never runs `merge --abort`, reset, or clean.
 */
export function preparePrShipFreshness(worktree: string, exec?: GitArgvExec): PrShipFreshnessResult {
	const run = exec ?? defaultGitArgvExec;
	const mergeInProgress = hasMergeHead(run, worktree);
	const unmerged = unmergedPaths(run, worktree);
	if (mergeInProgress || unmerged.length > 0) {
		// No fetch on this resume path: retain whatever origin/main resolves to NOW. Still
		// observed before the writable author step runs, so OID-bound verification rejects
		// any movement the author causes afterwards.
		const originMainOid = resolveOriginMainOid(run, worktree);
		const incoming = mergeInProgress ? "MERGE_HEAD" : originMainOid;
		return {
			kind: "conflicted",
			unmergedFiles: unmerged,
			upstreamTouchedFiles: incoming ? upstreamTouchedFrom(run, worktree, incoming) : [],
			originMainOid,
		};
	}
	const status = porcelainStatus(run, worktree);
	if (!status.ok) return { kind: "failed", detail: status.detail };
	if (status.dirty) return { kind: "failed", detail: "worktree is dirty (no merge in progress)" };

	const fetched = tryGitArgv(run, ["fetch", "origin", "main"], worktree);
	if (!fetched.ok) return { kind: "failed", detail: fetched.detail || "git fetch origin main failed" };
	// ADR-0025: resolve and retain the fetched OID once, immediately post-fetch. Every
	// subsequent check (including the merge below) uses this OID, never the ref name.
	const originMainOid = resolveOriginMainOid(run, worktree);
	if (!originMainOid) return { kind: "failed", detail: "origin/main does not resolve after fetch" };
	if (oidIsAncestorOfHead(run, worktree, originMainOid)) return { kind: "up-to-date", originMainOid };

	const upstreamTouchedFiles = upstreamTouchedFrom(run, worktree, originMainOid);
	const merged = tryGitArgv(run, ["merge", "--no-edit", originMainOid], worktree);
	if (merged.ok) return { kind: "merged", upstreamTouchedFiles, originMainOid };

	const afterUnmerged = unmergedPaths(run, worktree);
	if (hasMergeHead(run, worktree) || afterUnmerged.length > 0) {
		return { kind: "conflicted", unmergedFiles: afterUnmerged, upstreamTouchedFiles, originMainOid };
	}
	return { kind: "failed", detail: merged.detail || "git merge --no-edit origin/main failed" };
}

/**
 * Deterministic Git gate before PR pre-flight or ship. Accepts only a clean,
 * conflict-free worktree whose HEAD already contains the origin/main OID retained
 * at fetch time (`expectedOriginMainOid`, from `preparePrShipFreshness`).
 * Never aborts, resets, or cleans.
 *
 * ADR-0025: verification binds to the fetched OID, never the mutable ref name — a
 * writable author step between fetch and this gate can move `origin/main` (e.g. to an
 * older ancestor) and leave a clean tree that a ref-name check would accept. ANY
 * movement fails closed with both OIDs named; a legitimately-advanced upstream also
 * fails here, and the resume re-fetches — correct and self-healing.
 */
export function verifyPrShipFreshness(worktree: string, expectedOriginMainOid: string, exec?: GitArgvExec): PrShipFreshnessVerification {
	const run = exec ?? defaultGitArgvExec;
	if (hasMergeHead(run, worktree)) return { ok: false, detail: "merge in progress (MERGE_HEAD present)" };
	const unmerged = unmergedPaths(run, worktree);
	if (unmerged.length > 0) return { ok: false, detail: `unmerged paths: ${unmerged.join(", ")}` };
	const status = porcelainStatus(run, worktree);
	if (!status.ok) return { ok: false, detail: status.detail };
	if (status.dirty) return { ok: false, detail: "worktree is dirty" };
	const currentOid = resolveOriginMainOid(run, worktree);
	if (!currentOid) return { ok: false, detail: "origin/main does not resolve" };
	if (currentOid !== expectedOriginMainOid) {
		return { ok: false, detail: `origin/main moved after fetch: fetched ${expectedOriginMainOid}, now ${currentOid} — rejecting ref movement` };
	}
	if (!oidIsAncestorOfHead(run, worktree, expectedOriginMainOid)) return { ok: false, detail: `fetched origin/main OID ${expectedOriginMainOid} is not an ancestor of HEAD` };
	return { ok: true };
}

/**
 * Capture the state needed to verify a direct-push ship landed. Returns null
 * if either git command fails (e.g. no main branch). The caller (pipeline.ts)
 * fails the cycle closed on a null result for direct-push rather than shipping
 * blind — a repo that can't answer `rev-parse` is not shippable.
 */
export function captureShipState(mainRepo: string, worktree: string): { mainSha: string; featSha: string; branch: string } | null {
	try {
		const mainSha = execSync("git rev-parse main", { cwd: mainRepo, encoding: "utf-8" }).trim();
		const featSha = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
		// The worktree is on the feature branch at capture time (pre-merge). The
		// pipeline-owned bookkeeping tail needs this name to clean up the branch
		// after the merge lands.
		const branch = execSync("git branch --show-current", { cwd: worktree, encoding: "utf-8" }).trim();
		return { mainSha, featSha, branch };
	} catch {
		return null;
	}
}

/**
 * Returns true if main advanced after a direct-push ship: either the sha
 * changed or the pre-ship feat tip is now reachable from main (fast-forward).
 * **Fails closed** — a git error during verification returns false, so the
 * merge is treated as *not* landed and routes to /shipwreck (which assesses the
 * real state) rather than to a blind push. Failing open here would classify a
 * ghost-ship-plus-git-error as merged and push it, defeating the very gate this
 * implements.
 */
export function verifyShipLanded(mainRepo: string, mainShaBefore: string, featShaBefore: string): boolean {
	try {
		const mainShaAfter = execSync("git rev-parse main", { cwd: mainRepo, encoding: "utf-8" }).trim();
		if (mainShaAfter !== mainShaBefore) return true;
		try {
			execSync(`git merge-base --is-ancestor ${featShaBefore} main`, { cwd: mainRepo, stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	} catch {
		return false;
	}
}

// ── Main-checkout guard (issue #216) ────────────────────────────────────

/**
 * Guard against a detached (or off-branch) main checkout silently becoming
 * the base for the next cycle. `createClaimWorkspace` always branches off the
 * literal `main` ref, not HEAD, so a detached checkout can't corrupt a *new*
 * claim — but it does break an operator's between-cycle `git merge --ff-only
 * origin/main` and makes `git log -1` in the main checkout misleading.
 * Self-heals with a plain `git checkout <branch>` (never `-f`, so it can't
 * discard uncommitted work); returns false only if that checkout itself
 * fails, in which case the caller should stop rather than claim blind.
 */
export function ensureMainCheckoutOnBranch(mainRepo: string, branch: string, log?: (msg: string) => void): boolean {
	let current: string;
	try {
		current = execSync("git branch --show-current", { cwd: mainRepo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch {
		return false;
	}
	if (current === branch) return true;
	log?.(`⚠ main checkout was on ${current || "detached HEAD"}, not ${branch} — reattaching`);
	try {
		execSync(`git checkout ${branch}`, { cwd: mainRepo, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

export { type GitArgvExec, verifyConflictRepairComplete } from "../git.js";
