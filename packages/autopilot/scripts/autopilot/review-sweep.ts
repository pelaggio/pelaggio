import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PR_REVIEW_MARKER } from "./pr-review-cli.js";
import { type GhRunner, parseGhJson } from "./roadmap/github-issues.js";

const REVIEW_CONTEXT = "review";
export const LOCAL_MODE_MARKER = "<!-- autopilot-pr-review-local-mode -->";

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

interface CommentEntry {
	id: number;
	body: string;
	created_at?: string;
	createdAt?: string;
}

function runGhSoft(gh: GhRunner, args: string[]): string | null {
	try {
		const r = gh(args);
		return r.status === 0 ? r.stdout : null;
	} catch {
		return null;
	}
}

function sameRepo(pr: PrListEntry, ghRepo: string): boolean {
	if (pr.headRepository?.nameWithOwner) return pr.headRepository.nameWithOwner.toLowerCase() === ghRepo.toLowerCase();
	const [owner, repo] = ghRepo.split("/");
	const headOwner = pr.headRepositoryOwner?.login ?? pr.headRepository?.owner?.login;
	const headName = pr.headRepository?.name;
	return !!headOwner && !!headName && headOwner.toLowerCase() === owner?.toLowerCase() && headName.toLowerCase() === repo?.toLowerCase();
}

function reviewStatus(rollup: RollupEntry[] | undefined): { state: "missing" | "pending" | "done"; startedAt?: string } {
	if (!Array.isArray(rollup)) return { state: "missing" };
	const statuses = rollup.filter((e) => (e.context ?? "").toLowerCase() === REVIEW_CONTEXT);
	for (const status of statuses) {
		const state = (status.state ?? "").toUpperCase();
		if (state === "SUCCESS" || state === "FAILURE" || state === "ERROR") return { state: "done" };
	}
	const pending = statuses.find((e) => (e.state ?? "").toUpperCase() === "PENDING");
	if (pending) return { state: "pending", startedAt: pending.startedAt ?? pending.createdAt ?? pending.updatedAt };
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
	const args = ["api", `repos/${ghRepo}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${REVIEW_CONTEXT}`, "-f", `description=${description}`];
	if (targetUrl) args.push("-f", `target_url=${targetUrl}`);
	return runGhSoft(gh, args) !== null;
}

function latestMarkerComment(comments: readonly CommentEntry[], marker: string): CommentEntry | null {
	const matches = comments.filter((c) => c.body.includes(marker));
	if (matches.length === 0) return null;
	return matches.reduce((a, b) => ((b.created_at ?? b.createdAt ?? "").localeCompare(a.created_at ?? a.createdAt ?? "") > 0 ? b : a));
}

export function upsertReviewComment(gh: GhRunner, ghRepo: string, prNumber: number, body: string): boolean {
	const out = runGhSoft(gh, ["api", `repos/${ghRepo}/issues/${prNumber}/comments`, "--paginate"]);
	if (out === null) return false;
	let comments: CommentEntry[];
	try {
		comments = parseGhJson<CommentEntry[]>(out, (v) => Array.isArray(v));
	} catch {
		return false;
	}
	const existing = latestMarkerComment(comments, PR_REVIEW_MARKER);
	const args = existing ? ["api", "--method", "PATCH", `repos/${ghRepo}/issues/comments/${existing.id}`, "-f", `body=${body}`] : ["api", "--method", "POST", `repos/${ghRepo}/issues/${prNumber}/comments`, "-f", `body=${body}`];
	return runGhSoft(gh, args) !== null;
}

export function postLocalModeWorkflowComment(gh: GhRunner, ghRepo: string, prNumber: number): boolean {
	const out = runGhSoft(gh, ["api", `repos/${ghRepo}/issues/${prNumber}/comments`, "--paginate"]);
	if (out === null) return false;
	let comments: CommentEntry[];
	try {
		comments = parseGhJson<CommentEntry[]>(out, (v) => Array.isArray(v));
	} catch {
		return false;
	}
	if (latestMarkerComment(comments, LOCAL_MODE_MARKER)) return true;
	const body = `${LOCAL_MODE_MARKER}\nThe \`review\` gate is posted by the local autopilot runner for this repo. If this PR stays without a \`review\` status, start a normal local autopilot run or switch \`review.runner\` back to \`ci\`.`;
	return runGhSoft(gh, ["api", "--method", "POST", `repos/${ghRepo}/issues/${prNumber}/comments`, "-f", `body=${body}`]) !== null;
}

export function prepareReviewHead(repo: string, candidate: ReviewCandidate, exec?: (cmd: string, cwd: string) => string): { diffCwd: string; baseRef: string; headRef: string } | null {
	const run = exec ?? ((cmd, cwd) => execSync(cmd, { cwd, encoding: "utf-8" }));
	const headRef = `refs/autopilot-review/pr-${candidate.prNumber}`;
	const path = resolve(repo, ".dev", "review-heads", candidate.headSha);
	try {
		mkdirSync(resolve(repo, ".dev", "review-heads"), { recursive: true });
		run(`git fetch origin refs/pull/${candidate.prNumber}/head:${headRef}`, repo);
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
export function cleanupReviewHead(repo: string, candidate: ReviewCandidate, exec?: (cmd: string, cwd: string) => string): void {
	const run = exec ?? ((cmd, cwd) => execSync(cmd, { cwd, encoding: "utf-8" }));
	const path = resolve(repo, ".dev", "review-heads", candidate.headSha);
	try {
		if (existsSync(path)) run(`git worktree remove --force ${path}`, repo);
		run(`git update-ref -d refs/autopilot-review/pr-${candidate.prNumber}`, repo);
	} catch {
		// best-effort; see doc comment
	}
}
