import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { hasMarkerComment, PR_REVIEW_MARKER, postCommitStatus, runGhSoft, upsertMarkerComment } from "./github-posting.js";
import { registerPath } from "./registers.js";
import { type GhRunner, parseGhJson } from "./roadmap/github-issues.js";

const REVIEW_CONTEXT = "review";
export const LOCAL_MODE_MARKER = "<!-- pelaggio-pr-review-local-mode -->";

export interface ReviewCandidate {
	prNumber: number;
	itemId: string;
	branch: string;
	headSha: string;
	statusState: "missing" | "pending";
	statusStartedAt?: string;
}

interface RollupEntry {
	__typename?: string;
	context?: string;
	state?: string;
	startedAt?: string;
	createdAt?: string;
	updatedAt?: string;
	/** REST /commits/:sha/status uses snake_case timestamps (GraphQL rollup is camelCase). */
	created_at?: string;
	updated_at?: string;
}

interface PrListEntry {
	number: number;
	isDraft: boolean;
	headRefName: string;
	headRefOid: string;
	headRepository?: { nameWithOwner?: string; owner?: { login?: string }; name?: string } | null;
	headRepositoryOwner?: { login?: string } | null;
	statusCheckRollup?: RollupEntry[];
	updatedAt?: string;
}

function sameRepo(pr: PrListEntry, ghRepo: string): boolean {
	if (pr.headRepository?.nameWithOwner) return pr.headRepository.nameWithOwner.toLowerCase() === ghRepo.toLowerCase();
	const [owner, repo] = ghRepo.split("/");
	const headOwner = pr.headRepositoryOwner?.login ?? pr.headRepository?.owner?.login;
	const headName = pr.headRepository?.name;
	return !!headOwner && !!headName && headOwner.toLowerCase() === owner?.toLowerCase() && headName.toLowerCase() === repo?.toLowerCase();
}

function statusTimestamp(entry: RollupEntry): number {
	// GraphQL rollup entries carry camelCase timestamps; REST /commits/:sha/status
	// carries snake_case. Read both, or every REST entry ties at 0 and recency
	// classification degrades to array-order accidents (#387 gate finding).
	const raw = entry.startedAt ?? entry.createdAt ?? entry.updatedAt ?? entry.created_at ?? entry.updated_at;
	const parsed = raw ? Date.parse(raw) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

function reviewStatus(rollup: RollupEntry[] | undefined): { state: "missing" | "pending" | "done"; startedAt?: string } {
	if (!Array.isArray(rollup)) return { state: "missing" };
	const statuses = rollup.filter((e) => (e.context ?? "").toLowerCase() === REVIEW_CONTEXT);
	if (statuses.length === 0) return { state: "missing" };
	// Classify by the MOST RECENT review status, not first-terminal-wins: a re-review
	// posts pending over an older success/failure, and treating the stale terminal as
	// "done" lets the drain delete a queue record while the effective context stays
	// pending forever (#387 gate finding). Untimestamped entries sort oldest.
	// Strict > keeps the FIRST entry on timestamp ties: the REST endpoint returns
	// newest-first, so first-wins is the correct degradation when timestamps are absent.
	const latest = statuses.reduce((a, b) => (statusTimestamp(b) > statusTimestamp(a) ? b : a));
	const state = (latest.state ?? "").toUpperCase();
	if (state === "SUCCESS" || state === "FAILURE" || state === "ERROR") return { state: "done" };
	if (state === "PENDING") return { state: "pending", startedAt: latest.startedAt ?? latest.createdAt ?? latest.updatedAt };
	return { state: "missing" };
}

export function findReviewCandidates(gh: GhRunner, ghRepo: string, now: number, statuslessAfterMs: number): { candidates: ReviewCandidate[]; stranded: ReviewCandidate[] } {
	const out = runGhSoft(gh, ["pr", "list", "--repo", ghRepo, "--state", "open", "--json", "number,isDraft,headRefName,headRepository,headRepositoryOwner,headRefOid,statusCheckRollup,labels,updatedAt", "--limit", "200"]);
	if (out === null) return { candidates: [], stranded: [] };
	let prs: PrListEntry[];
	try {
		prs = parseGhJson<PrListEntry[]>(out, (v) => Array.isArray(v));
	} catch {
		return { candidates: [], stranded: [] };
	}

	const candidates: ReviewCandidate[] = [];
	const stranded: ReviewCandidate[] = [];
	for (const pr of prs) {
		if (pr.isDraft) continue;
		if (!sameRepo(pr, ghRepo)) continue;
		const m = pr.headRefName.match(/^feat\/issue-(\d+)/);
		if (!m) continue;
		const status = reviewStatus(pr.statusCheckRollup);
		if (status.state === "done") continue;
		const candidate: ReviewCandidate = {
			prNumber: pr.number,
			itemId: m[1],
			branch: pr.headRefName,
			headSha: pr.headRefOid,
			statusState: status.state,
			...((status.startedAt ?? pr.updatedAt) ? { statusStartedAt: status.startedAt ?? pr.updatedAt } : {}),
		};
		candidates.push(candidate);
		if (candidate.statusState === "missing" && candidate.statusStartedAt) {
			const age = now - Date.parse(candidate.statusStartedAt);
			if (Number.isFinite(age) && age >= statuslessAfterMs) stranded.push(candidate);
		}
	}
	return { candidates, stranded };
}

export function postReviewStatus(gh: GhRunner, ghRepo: string, sha: string, state: "pending" | "success" | "failure", description: string, targetUrl?: string): boolean {
	return postCommitStatus(gh, ghRepo, sha, state, REVIEW_CONTEXT, description, targetUrl);
}

/**
 * Targeted `review` status probe for one commit SHA — the crash-between-post-and-dequeue
 * idempotency check (#387). `findReviewCandidates` drops done PRs, so an enqueued record that
 * is no longer a live candidate may already be terminal; the drain confirms that POSITIVELY
 * here before deleting the record (never "absent from the listing" as evidence). Fail-soft: a
 * probe error reads as `missing` so the drain re-runs (safe: status/comment upserts are
 * idempotent) rather than dropping un-reviewed intent.
 */
export function reviewStatusForSha(gh: GhRunner, ghRepo: string, sha: string): "missing" | "pending" | "done" {
	const out = runGhSoft(gh, ["api", `repos/${ghRepo}/commits/${sha}/status`]);
	if (out === null) return "missing";
	try {
		const parsed = JSON.parse(out) as { statuses?: RollupEntry[] };
		return reviewStatus(parsed.statuses).state;
	} catch {
		return "missing";
	}
}

export function upsertReviewComment(gh: GhRunner, ghRepo: string, prNumber: number, body: string): boolean {
	return upsertMarkerComment(gh, ghRepo, prNumber, PR_REVIEW_MARKER, body);
}

export function postLocalModeWorkflowComment(gh: GhRunner, ghRepo: string, prNumber: number): boolean {
	const exists = hasMarkerComment(gh, ghRepo, prNumber, LOCAL_MODE_MARKER);
	if (exists === null) return false;
	if (exists) return true;
	const body = `${LOCAL_MODE_MARKER}\nThe \`review\` gate is posted by the local pelaggio runner for this repo. If this PR stays without a \`review\` status, start a normal local pelaggio run or switch \`review.runner\` back to \`ci\`.`;
	return runGhSoft(gh, ["api", "--method", "POST", `repos/${ghRepo}/issues/${prNumber}/comments`, "-f", `body=${body}`]) !== null;
}

/** True when `root` is a throwaway PR-head review worktree (or under one). These detached,
 *  SHA-keyed checkouts under `.dev/review-heads/` are the same shape as authoring-review seats:
 *  harness-managed, gitignored, never the item's tracked work. Like seats, they must be exempt
 *  from a concurrent step's confinement audit — and an orphaned (crashed-cleanup) one that stays
 *  registered in `git worktree list` must not trip the snapshot. (#308) */
export function isReviewHeadPath(root: string, repo: string): boolean {
	const headsRoot = registerPath(repo, "review-heads");
	const abs = resolve(root);
	return abs === headsRoot || abs.startsWith(`${headsRoot}/`);
}

export function prepareReviewHead(
	repo: string,
	candidate: ReviewCandidate,
	exec?: (cmd: string, cwd: string) => string,
	headRef = `refs/pelaggio-review/pr-${candidate.prNumber}`,
	// Caller-keyed directory suffix (#510): the drain and `pr-adjudicate` can hold checkouts of
	// the SAME head SHA concurrently, and adjudication's finally-block force-remove must never
	// tear down the drain's live checkout. Distinct callers pass distinct suffixes.
	pathSuffix = "",
): { diffCwd: string; baseRef: string; headRef: string } | null {
	const run = exec ?? ((cmd, cwd) => execSync(cmd, { cwd, encoding: "utf-8" }));
	const path = registerPath(repo, "review-heads", `${candidate.headSha}${pathSuffix}`);
	try {
		mkdirSync(registerPath(repo, "review-heads"), { recursive: true });
		run(`git fetch origin refs/pull/${candidate.prNumber}/head:${headRef}`, repo);
		// The status will be posted for candidate.headSha — the reviewed ref MUST be
		// that exact commit. If the branch moved between listing and fetch, reviewing
		// the new head while certifying the old SHA is a phantom sign-off; bail and
		// let the next drain round re-list with the fresh SHA.
		const fetched = run(`git rev-parse ${headRef}`, repo).trim();
		if (fetched !== candidate.headSha) return null;
		if (!existsSync(path)) run(`git worktree add --detach ${path} ${candidate.headSha}`, repo);
		return { diffCwd: path, baseRef: "origin/main", headRef };
	} catch {
		return null;
	}
}

/** Tear down the throwaway PR-head worktree and fetched ref created by `prepareReviewHead`.
 *  These are keyed by head SHA and detached, so `/tidy`'s branch-merged/recent-commit heuristics
 *  never sweep them — an uncleaned watcher would grow `.dev/review-heads/` without bound. Best-effort:
 *  a leaked worktree is inert (gitignored, unreferenced) and is retried on the next same-SHA sweep. */
export function cleanupReviewHead(repo: string, candidate: ReviewCandidate, exec?: (cmd: string, cwd: string) => string, headRef = `refs/pelaggio-review/pr-${candidate.prNumber}`, pathSuffix = ""): void {
	const run = exec ?? ((cmd, cwd) => execSync(cmd, { cwd, encoding: "utf-8" }));
	const path = registerPath(repo, "review-heads", `${candidate.headSha}${pathSuffix}`);
	try {
		if (existsSync(path)) run(`git worktree remove --force ${path}`, repo);
		run(`git update-ref -d ${headRef}`, repo);
	} catch {
		// best-effort; see doc comment
	}
}
