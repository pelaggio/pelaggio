import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
const CLAIM_BRANCH_RE = /^feat\/issue-(\d+)(?:-[A-Za-z0-9._-]*)?$/;

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
	const out = runGhSoft(gh, ["pr", "view", String(prNumber), "--repo", ghRepo, "--json", "state,isDraft,headRefName,headRepository,headRepositoryOwner,labels,statusCheckRollup"]);
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
	return {
		kind: "ok",
		target: {
			prNumber,
			itemId,
			branch,
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
// Critical section is two gh calls (label re-read + add), each bounded by gh's own 30s
// timeout; 120s covers worst-case network stalls. Env overrides for tests, read per call
// so `node --test` can set them without module-reload games.
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
