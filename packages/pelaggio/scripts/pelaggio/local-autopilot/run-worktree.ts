import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { policyDir } from "./paths.js";

export function worktreePathFor(cwd: string, runId: string): string {
	return resolve(policyDir(cwd), "worktrees", runId);
}

export function branchFor(runId: string): string {
	return `pelaggio/${runId}`;
}

export function createRunWorktree(cwd: string, runId: string): { path: string; branch: string } {
	const path = worktreePathFor(cwd, runId);
	const branch = branchFor(runId);
	mkdirSync(resolve(path, ".."), { recursive: true });
	execFileSync("git", ["worktree", "add", "-b", branch, path], { cwd, encoding: "utf8" });
	return { path, branch };
}

export function containedPath(worktree: string, relative: string): string {
	const resolved = resolve(worktree, relative);
	const root = resolve(worktree);
	if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error(`path escapes worktree: ${relative}`);
	return resolved;
}
