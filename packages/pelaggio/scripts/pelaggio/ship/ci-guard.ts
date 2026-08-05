import { type GhRunner, parseGhJson } from "../roadmap/github-issues.js";

// ── Deterministic red-merge guard (issue #292) ───────────────────────────
//
// Neither `gh pr merge --auto` nor `gh pr merge --admin` is, by itself, a
// guarantee that a red PR cannot land: `--auto` only defers to whatever
// branch protection happens to require, and `--admin` explicitly bypasses
// branch protection altogether. This module reads the PR's CI status
// directly from `statusCheckRollup` — independent of how (or whether)
// branch protection is configured — so the guard is deterministic and the
// harness, not an operator's discipline, is what refuses a red merge.
//
// Per ADR-0015/ADR-0018 this is condition (1) alone (CI green); the
// attestation half of condition (2) is not wired until #188 lands, so
// today's guard is CI-green-alone by design — it degrades, but never fails
// open: a gh error, unparseable response, or empty rollup all refuse.

interface RollupEntry {
	__typename?: string;
	name?: string;
	context?: string;
	/** CheckRun only: QUEUED | IN_PROGRESS | COMPLETED. */
	status?: string;
	/** CheckRun only, once `status` is COMPLETED: SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ACTION_REQUIRED | STALE. */
	conclusion?: string;
	/** StatusContext only: SUCCESS | FAILURE | ERROR | PENDING | EXPECTED. */
	state?: string;
}

interface PrView {
	statusCheckRollup?: RollupEntry[];
	/** The commit the reviewed status belongs to — used to pin `--admin` merges (see below). */
	headRefOid?: string;
}

interface PrStatus {
	rollup: RollupEntry[];
	headOid: string;
}

export type PrLanding = { state: "merged"; prNumber: number; mergeCommitOid: string } | { state: "not-merged" } | { state: "unknown" };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkLabel(e: RollupEntry): string {
	return e.name || e.context || "(unnamed check)";
}

function isCheckRun(e: RollupEntry): boolean {
	return e.conclusion !== undefined || e.status !== undefined;
}

/** A check that has *already* reported a failing terminal conclusion/state. */
function isRed(e: RollupEntry): boolean {
	if (isCheckRun(e)) {
		if ((e.status ?? "").toUpperCase() !== "COMPLETED") return false;
		return ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE"].includes((e.conclusion ?? "").toUpperCase());
	}
	return ["FAILURE", "ERROR"].includes((e.state ?? "").toUpperCase());
}

/** A check that has completed with a passing terminal conclusion/state. */
function isGreen(e: RollupEntry): boolean {
	if (isCheckRun(e)) {
		if ((e.status ?? "").toUpperCase() !== "COMPLETED") return false;
		return ["SUCCESS", "NEUTRAL", "SKIPPED"].includes((e.conclusion ?? "").toUpperCase());
	}
	return (e.state ?? "").toUpperCase() === "SUCCESS";
}

function fetchPrStatus(gh: GhRunner, prNumber: number, ghRepo?: string): PrStatus {
	const args = ["pr", "view", String(prNumber), ...(ghRepo ? ["--repo", ghRepo] : []), "--json", "statusCheckRollup,headRefOid"];
	const result = gh(args);
	if (result.status !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `status ${result.status}`;
		throw new Error(`red-merge guard: could not read CI status for PR #${prNumber} (${detail}) — refusing to merge`);
	}
	let parsed: PrView;
	try {
		parsed = parseGhJson<PrView>(result.stdout, isObject);
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		throw new Error(`red-merge guard: could not parse CI status for PR #${prNumber} (${detail}) — refusing to merge`);
	}
	return {
		rollup: Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : [],
		headOid: typeof parsed.headRefOid === "string" ? parsed.headRefOid : "",
	};
}

/** Fail-closed forge read used before destructive post-merge reconciliation. */
export function fetchPrLanding(gh: GhRunner, ghRepo: string, headBranch: string): PrLanding {
	try {
		const result = gh(["pr", "list", "--head", headBranch, "--state", "merged", "--json", "number,mergeCommit", "--limit", "10", "--repo", ghRepo]);
		if (result.status !== 0) return { state: "unknown" };
		const parsed = parseGhJson<unknown[]>(result.stdout, Array.isArray);
		if (parsed.length === 0) return { state: "not-merged" };
		const row = parsed[0];
		if (!isObject(row) || typeof row.number !== "number" || !isObject(row.mergeCommit) || typeof row.mergeCommit.oid !== "string" || row.mergeCommit.oid.length === 0) {
			return { state: "unknown" };
		}
		return { state: "merged", prNumber: row.number, mergeCommitOid: row.mergeCommit.oid };
	} catch {
		return { state: "unknown" };
	}
}

/**
 * Defense-in-depth before queuing deferred auto-merge (`gh pr merge --auto`): refuses only
 * when a check has ALREADY reported red. A pending or empty rollup does not block here —
 * GitHub's own `--auto` mechanism defers the actual merge until required checks complete, so
 * this does not need (or assume) that branch protection is configured; it only stops queuing
 * auto-merge onto a PR that is already known-broken.
 */
export function assertCiNotRed(gh: GhRunner, prNumber: number, ghRepo?: string): void {
	const red = fetchPrStatus(gh, prNumber, ghRepo).rollup.filter(isRed).map(checkLabel);
	if (red.length > 0) throw new Error(`red-merge guard: refusing to queue auto-merge for PR #${prNumber} — CI is red: ${red.join(", ")}`);
}

/**
 * Immediate, unconditional merges (the out-of-band `--admin` land path) happen NOW, not
 * deferred — and `--admin` bypasses branch protection, so the harness is the ONLY gate. It
 * must therefore be fail-closed against a *missing* required check, not just a reported-red
 * one: checking only "every check present in the rollup is green" reads a partial rollup —
 * e.g. a local `review=SUCCESS` posted before GitHub Actions has even created the `ci`
 * CheckRun — as green, and admin-merges with the required CI never having run (issue #292).
 *
 * `requiredChecks` is pelaggio's own contract for what must be green on this path, NOT
 * branch protection's required set — deliberately, because `--admin` bypasses the review-pin
 * that branch protection *would* require, so the two sets differ (here: `[ci]`, not
 * `[ci, review]`). Every required check must be PRESENT in the rollup and green; a required
 * check that has not reported is treated as not-green and refuses. A reported-red check
 * refuses regardless of whether it is required — never merge onto a visibly-red PR. An
 * explicitly empty `requiredChecks` is the operator escape hatch ("this repo has no gating
 * CI"): red still refuses, but an empty/pending rollup is then tolerated. A gh/parse error
 * always refuses (fetchPrStatus throws) — never fails open.
 *
 * Returns the `headRefOid` the green status was observed on. The caller MUST pass it to
 * `gh pr merge --match-head-commit <oid>`: without pinning, a push landing between this read
 * and the merge could swap the verified-green head for an untested commit that `--admin` then
 * merges (a TOCTOU fail-open). A missing head oid fails closed — we cannot pin, so we refuse.
 */
export function assertCiGreen(gh: GhRunner, prNumber: number, requiredChecks: readonly string[], ghRepo?: string): string {
	const { rollup, headOid } = fetchPrStatus(gh, prNumber, ghRepo);
	if (!headOid) throw new Error(`red-merge guard: refusing to merge PR #${prNumber} — could not resolve the PR head commit to pin the merge`);
	// A reported-red check blocks any merge, required or not — never land onto visible red.
	const red = rollup.filter(isRed).map(checkLabel);
	if (red.length > 0) throw new Error(`red-merge guard: refusing to merge PR #${prNumber} — CI is red: ${red.join(", ")}`);
	// Escape hatch: an explicitly empty required set asserts "no CI gates admin-land here".
	// Red was already refused above; with no required checks a pending/empty rollup is tolerated.
	if (requiredChecks.length === 0) return headOid;
	// Every required check must be PRESENT and green. A required check absent from the rollup
	// (Actions has not created its CheckRun yet) or with any non-green instance refuses — this
	// is the fail-closed-on-missing that a "green if all present checks are green" test misses.
	const missing: string[] = [];
	const notGreen: string[] = [];
	for (const name of requiredChecks) {
		const instances = rollup.filter((e) => checkLabel(e) === name);
		if (instances.length === 0) missing.push(name);
		else if (!instances.every(isGreen)) notGreen.push(name);
	}
	if (missing.length > 0) throw new Error(`red-merge guard: refusing to merge PR #${prNumber} — required check(s) have not reported: ${missing.join(", ")} (required: ${requiredChecks.join(", ")})`);
	if (notGreen.length > 0) throw new Error(`red-merge guard: refusing to merge PR #${prNumber} — required check(s) not yet green: ${notGreen.join(", ")}`);
	return headOid;
}
