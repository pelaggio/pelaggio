import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type GhRunner, parseGhJson } from "./roadmap/github-issues.js";

// ── Local revise sweep (issue #76) ─────────────────────────────────────
//
// Cohesive GitHub/git primitives for the orchestrator's revise sweep: find red-review PRs
// that are eligible for one automated revision, claim them atomically via the shared
// `autopilot:revised` label, fetch the PR-review findings, recreate a missing worktree, and
// post the human-handoff comment. Each primitive is FAIL-SOFT — any gh/git error degrades to
// a skip (null / false / no-op), never a throw into the run (issue #76 decision 6). The
// orchestration loop lives in `pipeline.ts`; this module has no `runPipeline` coupling.

/** Shared one-pass bound label — identical to the one `.github/workflows/pr-review-revise.yml` uses. */
const REVISED_LABEL = "autopilot:revised";
/** The `review` job name in `pr-review.yml` surfaces as the check-run `name` in statusCheckRollup. */
const REVIEW_CHECK_NAME = "review";
/** Marker the pr-review CLI upserts on its findings comment (`pr-review-cli.ts`). */
const PR_REVIEW_MARKER = "<!-- autopilot-pr-review -->";
/** Human-handoff marker — reused from CI so CI and local never double-post a park comment. */
const PARK_MARKER = "<!-- autopilot-revise-parked -->";

export interface RevisablePr {
	prNumber: number;
	itemId: string;
	branch: string;
}

// gh `--json` shapes we consume (narrowed via `parseGhJson` shape guards below).
interface RollupEntry {
	__typename?: string;
	name?: string;
	conclusion?: string;
}
interface PrListEntry {
	number: number;
	isDraft: boolean;
	headRefName: string;
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
 * The `review` job name in `pr-review.yml` IS the check-run `name`. Legacy StatusContext entries
 * carry `context`/`state` instead of `name`/`conclusion`, so keying on name+conclusion ignores
 * them for free. Matcher is defensive: case-insensitive `name`, uppercased `conclusion`. If a
 * live rollup ever keys `review` under `workflowName` instead of `name`, widen this to check both.
 */
function hasReviewFailure(rollup: RollupEntry[] | undefined): boolean {
	if (!Array.isArray(rollup)) return false;
	return rollup.some((e) => (e.name ?? "").toLowerCase() === REVIEW_CHECK_NAME && (e.conclusion ?? "").toUpperCase() === "FAILURE");
}

/**
 * ONE `gh pr list` call. Filters in JS to open + non-draft + `feat/issue-<n>` head + a failing
 * `review` check. Partitions by the one-pass label: unlabeled → `revisable` (eligible for a
 * revision), labeled → `labeledStillRed` (already spent its pass → human handoff). Fail-soft: a
 * gh error or unexpected JSON → both lists empty.
 */
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
		const m = branch.match(/^feat\/issue-(\d+)/);
		if (!m) continue;
		if (!hasReviewFailure(pr.statusCheckRollup)) continue;
		const entry: RevisablePr = { prNumber: pr.number, itemId: m[1], branch };
		if ((pr.labels ?? []).some((l) => l.name === REVISED_LABEL)) labeledStillRed.push(entry);
		else revisable.push(entry);
	}
	return { revisable, labeledStillRed };
}

/**
 * Confirm the linked issue carries the roadmap label (mirrors CI's `autopilot`-label guard —
 * the sweep only touches autopilot-managed PRs). Conservative skip (`false`) on any lookup error.
 * Cheap: only runs for the rare red candidate.
 */
export function isAutopilotManaged(gh: GhRunner, ghRepo: string, itemId: string, label: string): boolean {
	const out = runGhSoft(gh, ["issue", "view", itemId, "--repo", ghRepo, "--json", "labels"]);
	if (out === null) return false;
	try {
		const issue = parseGhJson<IssueLabels>(out, isObject);
		return (issue.labels ?? []).some((l) => l.name === label);
	} catch {
		return false;
	}
}

/**
 * One-pass bound: ensure the `autopilot:revised` label exists (best-effort — an existing label
 * makes `gh label create` fail, harmlessly), then add it to the PR. Returns true if the label
 * add succeeded (claimed), false on any gh error (skip → fail-soft). Called BEFORE any revision
 * work so a crash/park after this point cannot trigger a second pass.
 */
export function claimRevision(gh: GhRunner, ghRepo: string, prNumber: number): boolean {
	runGhSoft(gh, ["label", "create", REVISED_LABEL, "--repo", ghRepo, "--color", "BFD4F2", "--description", "Auto-revised once after a red PR review (issue #60)"]);
	return runGhSoft(gh, ["pr", "edit", String(prNumber), "--repo", ghRepo, "--add-label", REVISED_LABEL]) !== null;
}

/**
 * Fetch the latest `<!-- autopilot-pr-review -->` comment body and write it to `findingsPath`.
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
 * revision pass (or that had no findings to act on). Reuses CI's `<!-- autopilot-revise-parked -->`
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
