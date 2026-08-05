import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { listWorktreesIn } from "./helpers.js";
import { isReviewHeadPath } from "./review-sweep.js";
import { reviseFindingsPath } from "./revise-sweep.js";
import type { GhRunner } from "./roadmap/github-issues.js";
import type { RoadmapSource } from "./roadmap/types.js";
import { fetchPrLanding } from "./ship/ci-guard.js";
import { shipBodyFile } from "./ship/decision.js";

export interface ReapCandidate {
	itemId: string;
	branch: string;
	worktree: string | null;
}

export type LandingState = "landed" | "not-merged" | "stale-ref" | "unknown";
export interface ReapItemResult {
	markedDone: boolean;
	archived: boolean;
	worktreeRemoved: boolean;
	branchDeleted: boolean;
	warnings: string[];
}

export type GitRunner = (args: string[], cwd: string) => { stdout: string; stderr: string; status: number };
const defaultGit: GitRunner = (args, cwd) => {
	try {
		return { stdout: execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", status: 0 };
	} catch (error) {
		const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
		return { stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? ""), status: failure.status ?? 1 };
	}
};

export function shouldReap(opts: { enabled: boolean; shipIsPr: boolean; ghRepo: string; noWorktree: boolean; dryRun: boolean }): boolean {
	return opts.enabled && opts.shipIsPr && !!opts.ghRepo && !opts.noWorktree && !opts.dryRun;
}

function itemIdForBranch(branch: string): string | null {
	return branch.match(/^feat\/issue-(\d+)(?:-[A-Za-z0-9._-]*)?$/)?.[1] ?? null;
}

export function enumerateReapCandidates(mainRepo: string, io: { git?: GitRunner } = {}): ReapCandidate[] {
	const git = io.git ?? defaultGit;
	const worktrees = git(["worktree", "list", "--porcelain"], mainRepo);
	const branches = git(["branch", "--list", "feat/*", "--format=%(refname:short)"], mainRepo);
	if (worktrees.status !== 0 || branches.status !== 0) return [];
	const byBranch = new Map<string, string>();
	for (const block of worktrees.stdout.trim().split(/\n\n+/)) {
		const lines = block.split("\n");
		const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
		const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
		if (path && branch && itemIdForBranch(branch)) byBranch.set(branch, path);
	}
	const candidates = new Map<string, ReapCandidate>();
	for (const branch of [...branches.stdout.split("\n"), ...byBranch.keys()]) {
		const normalized = branch.trim().replace(/^\*\s+/, "");
		const itemId = itemIdForBranch(normalized);
		if (itemId) candidates.set(normalized, { itemId, branch: normalized, worktree: byBranch.get(normalized) ?? null });
	}
	return [...candidates.values()].sort((a, b) => a.branch.localeCompare(b.branch));
}

export function refreshLandingBase(mainRepo: string, io: { git?: GitRunner } = {}): { state: "fresh"; ref: string } | { state: "unknown" } {
	const result = (io.git ?? defaultGit)(["fetch", "origin", "main:refs/remotes/origin/main"], mainRepo);
	return result.status === 0 ? { state: "fresh", ref: "refs/remotes/origin/main" } : { state: "unknown" };
}

export function confirmLanding(gh: GhRunner, ghRepo: string, branch: string, landingRef: string, io: { isAncestor?: (oid: string, ref: string) => boolean | null } = {}): { state: LandingState; prNumber: number | null } {
	const landing = fetchPrLanding(gh, ghRepo, branch);
	if (landing.state !== "merged") return { state: landing.state, prNumber: null };
	const isAncestor = io.isAncestor ?? ((oid, ref) => defaultGit(["merge-base", "--is-ancestor", oid, ref], process.cwd()).status === 0);
	try {
		const ancestor = isAncestor(landing.mergeCommitOid, landingRef);
		if (ancestor === null) return { state: "unknown", prNumber: landing.prNumber };
		return { state: ancestor ? "landed" : "stale-ref", prNumber: landing.prNumber };
	} catch {
		return { state: "unknown", prNumber: landing.prNumber };
	}
}

function clearResidue(mainRepo: string, candidate: ReapCandidate, prNumber: number): void {
	rmSync(reviseFindingsPath(mainRepo, candidate.itemId), { force: true });
	const dev = resolve(mainRepo, ".dev");
	if (existsSync(dev)) {
		for (const name of readdirSync(dev)) if (name.startsWith(`pelaggio-resume-${candidate.itemId.toLowerCase()}`)) rmSync(resolve(dev, name), { force: true, recursive: true });
		const requests = resolve(dev, "review-requests");
		if (existsSync(requests)) for (const name of readdirSync(requests)) if (name.startsWith(`${prNumber}-`) && (name.endsWith(".json") || name.endsWith(".claimed"))) rmSync(resolve(requests, name), { force: true });
	}
	if (candidate.worktree) rmSync(resolve(candidate.worktree, shipBodyFile(candidate.itemId)), { force: true });
}

export async function reapItem(
	candidate: ReapCandidate,
	deps: {
		roadmap: Pick<RoadmapSource, "getItem" | "markDone" | "archivePlan">;
		mainRepo: string;
		prNumber: number;
		git?: GitRunner;
		status?: (cwd: string) => string;
	},
): Promise<ReapItemResult> {
	const warnings: string[] = [];
	const git = deps.git ?? defaultGit;
	let markedDone = false;
	let archived = false;
	let worktreeRemoved = candidate.worktree === null;
	let branchDeleted = false;
	try {
		const item = await deps.roadmap.getItem(candidate.itemId);
		if (!item) return { markedDone, archived, worktreeRemoved: false, branchDeleted, warnings: [`could not read item ${candidate.itemId}`] };
		if (item.status !== "done") await deps.roadmap.markDone(candidate.itemId, { note: `reaped — PR #${deps.prNumber} merged` });
		markedDone = true;
	} catch (error) {
		warnings.push(`mark-done failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		await deps.roadmap.archivePlan(candidate.itemId);
		archived = true;
	} catch (error) {
		warnings.push(`archive failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (candidate.worktree) {
		const dirty = (deps.status ?? ((cwd) => git(["status", "--porcelain"], cwd).stdout.trim()))(candidate.worktree);
		if (dirty) warnings.push(`dirty worktree retained: ${candidate.worktree}`);
		else {
			clearResidue(deps.mainRepo, candidate, deps.prNumber);
			const removed = git(["worktree", "remove", candidate.worktree], deps.mainRepo);
			worktreeRemoved = removed.status === 0;
			if (!worktreeRemoved) warnings.push(`worktree removal failed: ${candidate.worktree}`);
		}
	} else clearResidue(deps.mainRepo, candidate, deps.prNumber);
	git(["worktree", "prune"], deps.mainRepo);
	if (markedDone && worktreeRemoved) {
		const local = git(["branch", "-D", candidate.branch], deps.mainRepo);
		if (local.status === 0) {
			branchDeleted = true;
			git(["push", "origin", "--delete", candidate.branch], deps.mainRepo);
		} else warnings.push(`branch deletion failed: ${candidate.branch}`);
	}
	return { markedDone, archived, worktreeRemoved, branchDeleted, warnings };
}

export function reapReviewHeadOrphans(mainRepo: string, io: { listWorktrees?: (repo: string) => string[]; git?: GitRunner } = {}): number {
	const git = io.git ?? defaultGit;
	const orphans = (io.listWorktrees ?? listWorktreesIn)(mainRepo).filter((path) => isReviewHeadPath(path, mainRepo));
	for (const path of orphans) git(["worktree", "remove", "--force", path], mainRepo);
	git(["worktree", "prune"], mainRepo);
	return orphans.length;
}

export function reconcileMutationLockPath(mainRepo: string): string {
	return resolve(mainRepo, ".dev", "reconcile-mutation.lock");
}
