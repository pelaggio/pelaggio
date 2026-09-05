import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, relative as relativePath, resolve, sep } from "node:path";
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
	const root = realpathSync(worktree);
	const target = resolve(root, relative);
	const inside = (path: string): boolean => path === root || path.startsWith(`${root}${sep}`);
	if (!inside(target)) throw new Error(`path escapes worktree: ${relative}`);
	let existing = target;
	for (;;) {
		try {
			lstatSync(existing);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			existing = dirname(existing);
		}
	}
	const physical = resolve(realpathSync(existing), relativePath(existing, target));
	if (!inside(physical)) throw new Error(`path escapes worktree through symlink: ${relative}`);
	return physical;
}
