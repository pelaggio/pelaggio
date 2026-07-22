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
}

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

function fetchRollup(gh: GhRunner, prNumber: number, ghRepo?: string): RollupEntry[] {
	const args = ["pr", "view", String(prNumber), ...(ghRepo ? ["--repo", ghRepo] : []), "--json", "statusCheckRollup"];
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
	return Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : [];
}

/**
 * Defense-in-depth before queuing deferred auto-merge (`gh pr merge --auto`): refuses only
 * when a check has ALREADY reported red. A pending or empty rollup does not block here —
 * GitHub's own `--auto` mechanism defers the actual merge until required checks complete, so
 * this does not need (or assume) that branch protection is configured; it only stops queuing
 * auto-merge onto a PR that is already known-broken.
 */
export function assertCiNotRed(gh: GhRunner, prNumber: number, ghRepo?: string): void {
	const red = fetchRollup(gh, prNumber, ghRepo).filter(isRed).map(checkLabel);
	if (red.length > 0) throw new Error(`red-merge guard: refusing to queue auto-merge for PR #${prNumber} — CI is red: ${red.join(", ")}`);
}

/**
 * Immediate, unconditional merges (the out-of-band `--admin` land path) happen NOW, not
 * deferred — so "pending" cannot be treated as "will become green later" the way `--auto`
 * can. Requires every reported check to have completed with a passing conclusion, and fails
 * closed (refuses) on an empty rollup, a still-running check, a red check, or a gh/parse
 * error — never fails open.
 */
export function assertCiGreen(gh: GhRunner, prNumber: number, ghRepo?: string): void {
	const rollup = fetchRollup(gh, prNumber, ghRepo);
	if (rollup.length === 0) throw new Error(`red-merge guard: refusing to merge PR #${prNumber} — no CI status found (cannot confirm green)`);
	const red = rollup.filter(isRed).map(checkLabel);
	if (red.length > 0) throw new Error(`red-merge guard: refusing to merge PR #${prNumber} — CI is red: ${red.join(", ")}`);
	const notGreen = rollup.filter((e) => !isGreen(e)).map(checkLabel);
	if (notGreen.length > 0) throw new Error(`red-merge guard: refusing to merge PR #${prNumber} — CI is not yet green (pending): ${notGreen.join(", ")}`);
}
