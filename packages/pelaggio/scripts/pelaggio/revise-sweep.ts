import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { withFileLock } from "./file-lock.js";
import { type GhRunner, parseGhJson } from "./roadmap/github-issues.js";

// ── Local revise sweep (issue #76) ─────────────────────────────────────
//
// Cohesive GitHub/git primitives for the orchestrator's revise sweep: find red-review PRs
// that are eligible for one automated revision, claim them atomically (label re-check + add
// under the cross-process revise-claim lock — `claimRevisionExclusive`), fetch the PR-review
// findings, recreate a missing worktree, and
// post the human-handoff comment. Each primitive is FAIL-SOFT — any gh/git error degrades to
// a skip (null / false / no-op), never a throw into the run (issue #76 decision 6). The
// orchestration loop lives in `pipeline.ts`; this module has no `runPipeline` coupling.

/** Shared one-pass bound label — identical to the one `.github/workflows/pr-review-revise.yml` uses. */
const REVISED_LABEL = "autopilot:revised";
/** The `review` job name in `pr-review.yml` surfaces as the check-run `name` in statusCheckRollup. */
const REVIEW_CHECK_NAME = "review";
/** Marker the pr-review CLI upserts on its findings comment (`pr-review-cli.ts`). */
const PR_REVIEW_MARKER = "<!-- pelaggio-pr-review -->";
/** Human-handoff marker — reused from CI so CI and local never double-post a park comment. */
const PARK_MARKER = "<!-- pelaggio-revise-parked -->";
/** Append-only operator-invocation audit — never upserted (`gh pr comment` POST, not PATCH). */
export const REVISE_INVOCATION_MARKER = "<!-- pelaggio-revise-invocation -->";
/** Claim-branch grammar shared with `findRevisablePrs` — load-bearing for git-ref safety. */
export const CLAIM_BRANCH_RE = /^feat\/issue-(\d+)(?:-[A-Za-z0-9._-]*)?$/;

export interface RevisablePr {
	prNumber: number;
	itemId: string;
	branch: string;
}

/** Fields the operator `revise --pr` command needs from a targeted lookup. */
export interface TargetedRevisablePr {
	prNumber: number;
	itemId: string;
	branch: string;
	/** Full head commit OID at lookup time — the checkout is bound to this before any revision work. */
	headOid: string;
	alreadyRevised: boolean;
}

export type ResolveReviseTargetResult = { kind: "ok"; target: TargetedRevisablePr } | { kind: "unavailable"; reason: string } | { kind: "ineligible"; reason: string };

export type ReviseInvocationDisposition = "accepted-first-pass" | "refused-repeat" | "accepted-repeat";

// gh `--json` shapes we consume (narrowed via `parseGhJson` shape guards below).
interface RollupEntry {
	__typename?: string;
	name?: string;
	conclusion?: string;
	context?: string;
	state?: string;
}
interface PrListEntry {
	number: number;
	isDraft: boolean;
	headRefName: string;
	labels?: { name: string }[];
	statusCheckRollup?: RollupEntry[];
}
interface PrViewEntry {
	state?: string;
	isDraft?: boolean;
	headRefName?: string;
	headRefOid?: string;
	headRepository?: { nameWithOwner?: string; owner?: { login?: string }; name?: string } | null;
	headRepositoryOwner?: { login?: string } | null;
	labels?: { name: string }[];
	statusCheckRollup?: RollupEntry[];
}
interface IssueLabels {
	labels?: { name: string }[];
}
interface PrComments {
	comments?: { body: string; createdAt: string }[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Run a gh command fail-soft: return stdout on exit 0, else `null`. A thrown error (ENOENT,
 * timeout, not-authenticated — see `defaultGhRun`) is swallowed to `null` too, so every sweep
 * primitive degrades to a skip rather than throwing into the run.
 */
function runGhSoft(gh: GhRunner, args: string[]): string | null {
	try {
		const r = gh(args);
		return r.status === 0 ? r.stdout : null;
	} catch {
		return null;
	}
}

/**
 * Absolute findings path, resolved against `<repo>/.dev/` (gitignored), so `runPipeline`'s
 * `readFileSync(findingsPath)` is cwd-independent. Filename matches CI's
 * `.dev/review-findings-<id>.md` so both revise paths write the same place.
 */
export function reviseFindingsPath(repo: string, id: string): string {
	return resolve(repo, ".dev", `review-findings-${id.toLowerCase()}.md`);
}

/**
 * GH Actions check runs surface in `statusCheckRollup` as
 * `{ __typename: "CheckRun", name: "review", status: "COMPLETED", conclusion: "FAILURE", ... }`.
 * The local review runner posts commit statuses, surfaced as `StatusContext` entries with
 * `context: "review"` and `state: "FAILURE"`. Matcher is defensive and fail-soft: non-arrays
 * return false, names/contexts are case-insensitive, and terminal states are uppercased.
 */
function hasReviewFailure(rollup: RollupEntry[] | undefined): boolean {
	if (!Array.isArray(rollup)) return false;
	return rollup.some((e) => {
		const checkRunFailed = (e.name ?? "").toLowerCase() === REVIEW_CHECK_NAME && (e.conclusion ?? "").toUpperCase() === "FAILURE";
		const statusFailed = (e.context ?? "").toLowerCase() === REVIEW_CHECK_NAME && (e.state ?? "").toUpperCase() === "FAILURE";
		return checkRunFailed || statusFailed;
	});
}

/**
 * ONE `gh pr list` call. Filters in JS to open + non-draft + `feat/issue-<n>` head + a failing
 * `review` check. Partitions by the one-pass label: unlabeled → `revisable` (eligible for a
 * revision), labeled → `labeledStillRed` (already spent its pass → human handoff). Fail-soft: a
 * gh error or unexpected JSON → both lists empty.
 */
/**
 * Same-repo check copied from `review-sweep.ts`'s private `sameRepo`: prefer
 * `headRepository.nameWithOwner` case-insensitively against `ghRepo`, then the
 * `headRepositoryOwner.login` + `headRepository.name` fallback.
 */
function sameRepo(pr: { headRepository?: PrViewEntry["headRepository"]; headRepositoryOwner?: PrViewEntry["headRepositoryOwner"] }, ghRepo: string): boolean {
	if (pr.headRepository?.nameWithOwner) return pr.headRepository.nameWithOwner.toLowerCase() === ghRepo.toLowerCase();
	const [owner, repo] = ghRepo.split("/");
	const headOwner = pr.headRepositoryOwner?.login ?? pr.headRepository?.owner?.login;
	const headName = pr.headRepository?.name;
	return !!headOwner && !!headName && headOwner.toLowerCase() === owner?.toLowerCase() && headName.toLowerCase() === repo?.toLowerCase();
}

export function findRevisablePrs(gh: GhRunner, ghRepo: string): { revisable: RevisablePr[]; labeledStillRed: RevisablePr[] } {
	const empty = { revisable: [] as RevisablePr[], labeledStillRed: [] as RevisablePr[] };
	const out = runGhSoft(gh, ["pr", "list", "--repo", ghRepo, "--state", "open", "--json", "number,isDraft,headRefName,labels,statusCheckRollup", "--limit", "200"]);
	if (out === null) return empty;
	let prs: PrListEntry[];
	try {
		prs = parseGhJson<PrListEntry[]>(out, (v) => Array.isArray(v));
	} catch {
		return empty;
	}
	const revisable: RevisablePr[] = [];
	const labeledStillRed: RevisablePr[] = [];
	for (const pr of prs) {
		if (pr.isDraft) continue;
		const branch = pr.headRefName ?? "";
		// End-anchored with a strict charset: headRefName is forge-controlled input and
		// flows into git commands — "feat/issue-1;payload" must never qualify.
		const m = branch.match(CLAIM_BRANCH_RE);
		const itemId = m?.[1];
		if (!itemId) continue;
		if (!hasReviewFailure(pr.statusCheckRollup)) continue;
		const entry: RevisablePr = { prNumber: pr.number, itemId, branch };
		if ((pr.labels ?? []).some((l) => l.name === REVISED_LABEL)) labeledStillRed.push(entry);
		else revisable.push(entry);
	}
	return { revisable, labeledStillRed };
}

/**
 * Targeted lookup for `pelaggio revise --pr <n>`. Uses `gh pr view` so a named PR is not
 * dependent on the sweep's 200-item listing window. Discriminates GitHub/shape failure
 * (`unavailable`) from a policy-ineligible PR (`ineligible`) so the operator CLI can fail
 * loud without message scraping. Does not weaken the sweep's fail-soft contract.
 */
export function resolveReviseTarget(gh: GhRunner, ghRepo: string, prNumber: number): ResolveReviseTargetResult {
	const out = runGhSoft(gh, ["pr", "view", String(prNumber), "--repo", ghRepo, "--json", "state,isDraft,headRefName,headRefOid,headRepository,headRepositoryOwner,labels,statusCheckRollup"]);
	if (out === null) return { kind: "unavailable", reason: "github lookup failed" };
	let pr: PrViewEntry;
	try {
		pr = parseGhJson<PrViewEntry>(out, isObject);
	} catch {
		return { kind: "unavailable", reason: "malformed pull request payload" };
	}
	if (pr.isDraft) return { kind: "ineligible", reason: "pull request is a draft" };
	if ((pr.state ?? "").toUpperCase() !== "OPEN") return { kind: "ineligible", reason: "pull request is not open" };
	if (!sameRepo(pr, ghRepo)) return { kind: "ineligible", reason: "pull request head is from another repository" };
	const branch = pr.headRefName ?? "";
	const m = branch.match(CLAIM_BRANCH_RE);
	const itemId = m?.[1];
	if (!itemId) return { kind: "ineligible", reason: "head branch is not a pelaggio claim branch" };
	if (!hasReviewFailure(pr.statusCheckRollup)) return { kind: "ineligible", reason: "review gate is not currently red" };
	// The head OID binds the checkout to THIS PR head before any revision work
	// (`verifyReviseWorktreeBinding`); without it a stale or mismatched worktree could be
	// revised and shipped while the requested PR is labeled and audited. Fail closed
	// (`unavailable`, retryable) when the forge payload lacks a well-formed full OID.
	const headOid = pr.headRefOid ?? "";
	if (!/^[0-9a-fA-F]{40}$/.test(headOid)) return { kind: "unavailable", reason: "pull request head OID unavailable" };
	return {
		kind: "ok",
		target: {
			prNumber,
			itemId,
			branch,
			headOid,
			alreadyRevised: (pr.labels ?? []).some((l) => l.name === REVISED_LABEL),
		},
	};
}

/**
 * Confirm the linked issue carries the roadmap label (mirrors CI's `autopilot`-label guard —
 * the sweep only touches pelaggio-managed PRs). Conservative skip (`false`) on any lookup error.
 * Cheap: only runs for the rare red candidate.
 */
export function isAutopilotManaged(gh: GhRunner, ghRepo: string, itemId: string, label: string): boolean {
	return autopilotManagedState(gh, ghRepo, itemId, label) === "managed";
}

/**
 * Tri-state variant for callers that take a DESTRUCTIVE action on the negative
 * (e.g. deleting a durable review-request record): a transient/malformed lookup is
 * "unknown", not "unmanaged" — only a positive label read may justify deletion.
 */
export function autopilotManagedState(gh: GhRunner, ghRepo: string, itemId: string, label: string): "managed" | "unmanaged" | "unknown" {
	const out = runGhSoft(gh, ["issue", "view", itemId, "--repo", ghRepo, "--json", "labels"]);
	if (out === null) return "unknown";
	try {
		const issue = parseGhJson<IssueLabels>(out, isObject);
		return (issue.labels ?? []).some((l) => l.name === label) ? "managed" : "unmanaged";
	} catch {
		return "unknown";
	}
}

/**
 * Raw one-pass label write: ensure the `autopilot:revised` label exists (best-effort — an
 * existing label makes `gh label create` fail, harmlessly), then add it to the PR. Returns
 * true if the label add succeeded, false on any gh error. The add is IDEMPOTENT (GitHub has
 * no label CAS — adding an already-present label still succeeds), so this alone is a check-
 * then-write, not a claim: call it only through `claimRevisionExclusive`, which makes the
 * label re-check + add one atomic step for every local caller.
 */
export function claimRevision(gh: GhRunner, ghRepo: string, prNumber: number): boolean {
	runGhSoft(gh, ["label", "create", REVISED_LABEL, "--repo", ghRepo, "--color", "BFD4F2", "--description", "Auto-revised once after a red PR review (issue #60)"]);
	return runGhSoft(gh, ["pr", "edit", String(prNumber), "--repo", ghRepo, "--add-label", REVISED_LABEL]) !== null;
}

/** Lock file guarding the revised-label test-and-set; lives beside the roadmap mutation lock. */
const CLAIM_LOCK_FILE = "revise-claim.lock";
// Critical section is three gh calls (label re-read, best-effort label create, label add),
// each bounded by gh's own 30s timeout; 120s covers worst-case network stalls. Env overrides
// for tests, read per call so `node --test` can set them without module-reload games.
const claimLockStaleMs = () => Number(process.env.PELAGGIO_REVISE_CLAIM_LOCK_STALE_MS) || 120_000;
const claimLockTimeoutMs = () => Number(process.env.PELAGGIO_REVISE_CLAIM_LOCK_TIMEOUT_MS) || 30_000;

/** Exposed for tests and diagnostics — the single serialization point for revision claims. */
export function reviseClaimLockPath(mainRepo: string): string {
	return resolve(mainRepo, ".dev", CLAIM_LOCK_FILE);
}

export type ClaimRevisionOutcome = "claimed" | "already-claimed" | "unavailable";

/** Fresh, targeted read of the one-pass label. `unknown` on any gh/shape failure. */
function revisedLabelState(gh: GhRunner, ghRepo: string, prNumber: number): "present" | "absent" | "unknown" {
	const out = runGhSoft(gh, ["pr", "view", String(prNumber), "--repo", ghRepo, "--json", "labels"]);
	if (out === null) return "unknown";
	try {
		const pr = parseGhJson<IssueLabels>(out, isObject);
		return (pr.labels ?? []).some((l) => l.name === REVISED_LABEL) ? "present" : "absent";
	} catch {
		return "unknown";
	}
}

/**
 * Atomic one-pass claim, shared by BOTH local caller classes — the in-run revise sweep
 * (`pipeline.ts`) and the operator `pelaggio revise --pr` CLI (`revise-cli.ts`).
 *
 * Guard class (docs/agent-context/guarded-actions.md §2.1): the label alone is a check, not
 * a hold — two callers can each observe "unlabeled" (sweep listing / `resolveReviseTarget`),
 * each "succeed" the idempotent add, and each start paid revision work in the same claim
 * worktree. This wraps the label RE-READ + add in one cross-process critical section
 * (`.dev/revise-claim.lock` in the main repo, via the shared `file-lock.ts` primitive) so
 * the test-and-set is atomic for every lock-taker; the loser observes the winner's label and
 * refuses. Fail-closed: lock-acquisition failure or an unreadable label state returns
 * `unavailable` — callers must NOT proceed to revision work without a `claimed`. Residual:
 * actors outside this host's lock (CI's `pr-review-revise.yml` on a runner) still see only
 * the idempotent label, unchanged from before.
 */
export async function claimRevisionExclusive(gh: GhRunner, ghRepo: string, mainRepo: string, prNumber: number): Promise<ClaimRevisionOutcome> {
	try {
		return await withFileLock(
			reviseClaimLockPath(mainRepo),
			() => {
				const state = revisedLabelState(gh, ghRepo, prNumber);
				if (state === "unknown") return "unavailable" as const;
				if (state === "present") return "already-claimed" as const;
				return claimRevision(gh, ghRepo, prNumber) ? ("claimed" as const) : ("unavailable" as const);
			},
			{ label: "revise claim lock", staleMs: claimLockStaleMs(), acquireTimeoutMs: claimLockTimeoutMs() },
		);
	} catch {
		return "unavailable"; // no lock → no claim → no paid revision work
	}
}

// ── Execution-scoped revision exclusion (PR #507 review finding) ───────
//
// The `autopilot:revised` label is a ONE-SHOT entitlement token, not an execution guard:
// `claimRevisionExclusive` releases its lock immediately after the label test-and-set, and
// `--allow-repeat` bypasses the label entirely. Without a separate guard, a repeat pass can
// run concurrently with an in-flight first pass (or with another repeat) in the SAME claim
// worktree — racing findings-file writes, commits, and pushes. The lease below is that guard.

/** Directory of per-item execution leases; `<root>/.lock` serializes every lease mutation. */
export function reviseExecLeaseRoot(mainRepo: string): string {
	return resolve(mainRepo, ".dev", "revise-exec");
}

// The short lock guards only a few fs operations per mutation; sizes mirror the claim lock.
// Env overrides for tests, read per call so `node --test` needs no module-reload games.
const execLockStaleMs = () => Number(process.env.PELAGGIO_REVISE_EXEC_LOCK_STALE_MS) || 120_000;
const execLockTimeoutMs = () => Number(process.env.PELAGGIO_REVISE_EXEC_LOCK_TIMEOUT_MS) || 30_000;

export interface ReviseExecutionLease {
	/** Remove the lease iff this holder still owns it (token compare). Idempotent, fail-soft. */
	release(): Promise<void>;
}

export type AcquireReviseExecutionResult = { kind: "acquired"; lease: ReviseExecutionLease } | { kind: "held"; holder: string } | { kind: "unavailable" };

interface ExecLeaseRecord {
	version: 1;
	itemId: string;
	pid: number;
	token: string;
	acquiredAt: number;
}

/** Parse an on-disk lease fail-soft: anything unreadable/malformed is reclaimable. */
function readExecLease(path: string): ExecLeaseRecord | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	} catch {
		return undefined;
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const o = raw as Record<string, unknown>;
	if (o.version !== 1) return undefined;
	if (typeof o.itemId !== "string") return undefined;
	if (typeof o.pid !== "number" || !Number.isInteger(o.pid) || o.pid <= 0) return undefined;
	if (typeof o.token !== "string" || o.token.length === 0) return undefined;
	const acquiredAt = typeof o.acquiredAt === "number" && Number.isFinite(o.acquiredAt) ? o.acquiredAt : 0;
	return { version: 1, itemId: o.itemId, pid: o.pid, token: o.token, acquiredAt };
}

/** kill(pid, 0) liveness; EPERM means the process exists but is not ours — still alive. */
function defaultExecPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Path-safe per-item lease name; mirrors attempt-identity's slug rule (ids come from adapters). */
function execLeaseSlug(itemId: string): string {
	const slug = itemId
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[.-]+/, "");
	return slug.length > 0 ? slug : "unknown";
}

/** Exposed for diagnostics and refusal messages — where the lease for `itemId` lives. */
export function reviseExecLeasePath(root: string, itemId: string): string {
	return resolve(root, `${execLeaseSlug(itemId)}.lease`);
}

/**
 * Acquire the per-item revision execution lease, held for the WHOLE revision run. Taken by
 * every path that executes a revision in the item's claim worktree — the in-run sweep
 * (`pipeline.ts`), an operator first pass, and an operator `--allow-repeat` repeat — so no
 * two of them can run concurrently in the same worktree.
 *
 * Guard class (docs/agent-context/guarded-actions.md §3–§4): an execution lease, fenced AT
 * THE REGISTER for cooperating harness processes on this host. The lease file is the single
 * register for "who may execute a revision for this item"; every mutation (acquire
 * test-and-set, token-compared release) runs under one short `withFileLock` critical
 * section, so contenders can never interleave a check-then-write. Deliberately NOT a
 * time-leased `withFileLock` hold: a revision runs for hours, and file-lock's `staleMs`
 * steal would silently strip a live holder's exclusion mid-run (its documented residual).
 * There is no theft here at all — only the holder's own token-compared release (or an
 * operator's manual removal of the lease file) frees the register. A dead holder pid is NOT
 * positive evidence the pass is over: step-runner and the providers spawn child processes
 * that can survive an orchestrator crash and keep mutating the worktree, so pid-death
 * auto-reclaim would let a second reviser start under an orphaned first one.
 * Descendant-aware reclaim (proving the holder's whole process tree is gone) is deferred to
 * the #453 one-shot-token successor design.
 *
 * Failure semantics, fail-closed throughout:
 * - live holder → `held` (refuse; the message names the holder pid and the lease path);
 * - crashed holder (pid probes dead) → still `held`; crash recovery is MANUAL — the refusal
 *   states that descendant provider processes may still be running and names the exact
 *   removal step (`rm <lease path>`) to take once the operator has verified they are not;
 * - lock unavailable → `unavailable` (no exclusion evidence → no revision work);
 * - a suspended-then-resumed holder KEEPS the lease (no time-based theft) — exclusion is
 *   never silently transferred under it.
 * Residuals: a crashed pass holds the lease closed until an operator removes the named lease
 * file (fail-closed, never fail-open); the register lives under `MAIN_REPO/.dev/`, which is
 * not in the agent-denied write set, so — like attempt-identity.ts — this is exclusion among
 * cooperating harness processes, never an authorization boundary against a forging agent.
 */
export async function acquireReviseExecution(root: string, itemId: string, opts: { isPidAlive?: (pid: number) => boolean } = {}): Promise<AcquireReviseExecutionResult> {
	const isPidAlive = opts.isPidAlive ?? defaultExecPidAlive;
	const leasePath = reviseExecLeasePath(root, itemId);
	const lockPath = resolve(root, ".lock");
	const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
	let acquired = false;
	let holder = "";
	try {
		await withFileLock(
			lockPath,
			() => {
				const cur = readExecLease(leasePath);
				if (cur) {
					// A valid lease ALWAYS refuses — even when the holder pid probes dead. A missing
					// parent pid is not positive evidence the pass ended: providers run child
					// processes that can outlive a crashed orchestrator and still mutate the
					// worktree, so reclaiming here could start a second reviser under them.
					holder = isPidAlive(cur.pid)
						? `held by pid ${cur.pid} since ${new Date(cur.acquiredAt).toISOString()}; if that process is not a live revision pass, remove ${leasePath}`
						: `held by pid ${cur.pid} (no longer running) since ${new Date(cur.acquiredAt).toISOString()}; crash recovery is manual — provider processes spawned by that pass may still be running and mutating the worktree. Verify none are, then run \`rm ${leasePath}\` to release the lease`;
					return;
				}
				// Absent or malformed register only — a readable lease is never auto-reclaimed.
				const record: ExecLeaseRecord = { version: 1, itemId, pid: process.pid, token, acquiredAt: Date.now() };
				writeFileSync(leasePath, `${JSON.stringify(record, null, "\t")}\n`);
				acquired = true;
			},
			{ label: "revise execution lease", staleMs: execLockStaleMs(), acquireTimeoutMs: execLockTimeoutMs() },
		);
	} catch {
		return { kind: "unavailable" };
	}
	if (!acquired) return { kind: "held", holder };
	let released = false;
	return {
		kind: "acquired",
		lease: {
			async release(): Promise<void> {
				if (released) return;
				released = true;
				try {
					await withFileLock(
						lockPath,
						() => {
							const cur = readExecLease(leasePath);
							if (cur && cur.token === token) unlinkSync(leasePath); // never a replacement's lease
						},
						{ label: "revise execution lease", staleMs: execLockStaleMs(), acquireTimeoutMs: execLockTimeoutMs() },
					);
				} catch {
					// Leave the lease. There is no automatic reclaim (see the acquire docstring):
					// an operator recovers it by removing the named lease file.
				}
			},
		},
	};
}

/**
 * Bind an existing checkout to the selected PR before any revision work (PR #507 finding 2):
 * the worktree path is item-derived, so a pre-existing directory may hold a different branch
 * or a stale HEAD, and revising it would ship code the labeled-and-audited PR never showed.
 * Fail-closed on mismatch with both observed and expected values in the reason — the caller
 * must NOT auto-reset or checkout over an existing tree (it may hold parked work).
 */
export function verifyReviseWorktreeBinding(worktreePath: string, branch: string, headOid: string, opts: { exec?: (cmd: string, cwd: string) => string } = {}): { ok: true } | { ok: false; reason: string } {
	const exec = opts.exec ?? ((cmd, cwd) => execSync(cmd, { cwd, encoding: "utf-8" }));
	let currentBranch: string;
	let currentHead: string;
	try {
		currentBranch = exec("git rev-parse --abbrev-ref HEAD", worktreePath).trim();
		currentHead = exec("git rev-parse HEAD", worktreePath).trim();
	} catch (e) {
		return { ok: false, reason: `could not read the checkout at ${worktreePath} (${e instanceof Error ? e.message : String(e)}) — refusing to revise an unverified worktree` };
	}
	if (currentBranch !== branch) {
		return { ok: false, reason: `worktree ${worktreePath} is checked out on "${currentBranch}", not the PR head branch "${branch}" — refusing to revise a mismatched checkout (nothing was reset; fix or remove the worktree and re-run)` };
	}
	if (currentHead.toLowerCase() !== headOid.toLowerCase()) {
		return { ok: false, reason: `worktree HEAD ${currentHead} does not match the PR head ${headOid} — refusing to revise a stale checkout (nothing was reset; push the local commits or remove the worktree so it is recreated at the PR head)` };
	}
	return { ok: true };
}

/**
 * Fetch the latest `<!-- pelaggio-pr-review -->` comment body and write it to `findingsPath`.
 * Returns true if written, false when there is no findings comment or on any gh/fs error.
 */
export function fetchReviewFindings(gh: GhRunner, ghRepo: string, prNumber: number, findingsPath: string): boolean {
	const out = runGhSoft(gh, ["pr", "view", String(prNumber), "--repo", ghRepo, "--json", "comments"]);
	if (out === null) return false;
	let parsed: PrComments;
	try {
		parsed = parseGhJson<PrComments>(out, isObject);
	} catch {
		return false;
	}
	const matches = (parsed.comments ?? []).filter((c) => c.body.includes(PR_REVIEW_MARKER));
	if (matches.length === 0) return false;
	// Most recent marker-bearing comment wins (the CLI upserts a single one, but be robust to dupes).
	const latest = matches.reduce((a, b) => (b.createdAt.localeCompare(a.createdAt) > 0 ? b : a));
	try {
		mkdirSync(dirname(findingsPath), { recursive: true });
		writeFileSync(findingsPath, latest.body);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure a worktree exists for the revision. PR-mode claims leave the worktree alive, so the
 * common case is a short-circuit on the existing dir (injected `exec` never runs). If it is
 * missing, recreate it from the branch: fetch `origin/<branch>` best-effort first (the local ref
 * may have been pruned), then `git worktree add`. Returns the path, or null on failure (fail-soft
 * → skip this PR). `exec` is injectable for tests.
 */
export function ensureReviseWorktree(worktreePath: string, branch: string, opts: { repo: string; exec?: (cmd: string, cwd: string) => string }): string | null {
	if (existsSync(worktreePath)) return worktreePath;
	// Fail closed before any exec: branch is forge-controlled. Allow only git-ref-safe
	// characters and forbid a leading dash (git option injection); the default exec is
	// a shell string, so any metacharacter here would be command injection.
	if (!/^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(branch)) return null;
	const exec = opts.exec ?? ((cmd, cwd) => execSync(cmd, { cwd, encoding: "utf-8" }));
	try {
		// The local branch ref may be gone (a prior `/tidy` pruned it) — recreate it from origin
		// so `git worktree add` has a ref to check out. Non-fatal if it fails (ref already local).
		try {
			exec(`git fetch origin ${branch}:${branch}`, opts.repo);
		} catch {
			// ignore — branch may already exist locally, or origin may lack it
		}
		exec(`git worktree add ${worktreePath} ${branch}`, opts.repo);
		return worktreePath;
	} catch {
		return null;
	}
}

/**
 * Idempotent, marker-guarded human-handoff comment for a PR that is still red after its one
 * revision pass (or that had no findings to act on). Reuses CI's `<!-- pelaggio-revise-parked -->`
 * marker so CI and local never double-post. Best-effort throughout (void): a lookup failure skips
 * posting rather than risk spamming.
 */
export function postParkComment(gh: GhRunner, ghRepo: string, prNumber: number): void {
	const out = runGhSoft(gh, ["pr", "view", String(prNumber), "--repo", ghRepo, "--json", "comments"]);
	if (out === null) return;
	let parsed: PrComments;
	try {
		parsed = parseGhJson<PrComments>(out, isObject);
	} catch {
		return;
	}
	if ((parsed.comments ?? []).some((c) => c.body.includes(PARK_MARKER))) return;
	runGhSoft(gh, [
		"pr",
		"comment",
		String(prNumber),
		"--repo",
		ghRepo,
		"--body",
		`${PARK_MARKER} 🛑 The \`review\` gate is still red after one automated revision pass — parking for human attention. Remove the \`${REVISED_LABEL}\` label to allow another auto-revision.`,
	]);
}

/**
 * Append-only operator-invocation record. Always POSTs a new comment (`gh pr comment`);
 * never PATCH/upserts. Deterministic CLI-owned body — no findings text. Returns false on
 * any gh error (caller fail-closes).
 */
export function recordReviseInvocation(gh: GhRunner, ghRepo: string, prNumber: number, disposition: ReviseInvocationDisposition, allowRepeat: boolean): boolean {
	const body = `${REVISE_INVOCATION_MARKER}\noperator revise --pr ${prNumber} disposition=${disposition} allow-repeat=${allowRepeat}`;
	return runGhSoft(gh, ["pr", "comment", String(prNumber), "--repo", ghRepo, "--body", body]) !== null;
}
