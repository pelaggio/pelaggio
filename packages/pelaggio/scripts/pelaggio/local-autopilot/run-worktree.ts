import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative as relativePath, resolve, sep } from "node:path";
import { localGit } from "./git.js";
import { checkedStatePath } from "./paths.js";
import { isOpaqueId } from "./transport.js";

export function worktreePathFor(cwd: string, runId: string): string {
	if (!isOpaqueId(runId)) throw new Error("runId is not an opaque id");
	return checkedStatePath(cwd, "worktrees", runId);
}

export function branchFor(runId: string): string {
	return `pelaggio/${runId}`;
}

export function createRunWorktree(cwd: string, runId: string): { path: string; branch: string } {
	const path = worktreePathFor(cwd, runId);
	const branch = branchFor(runId);
	mkdirSync(resolve(path, ".."), { recursive: true });
	localGit(cwd, ["worktree", "add", "-b", branch, path]);
	validateRunWorktree(cwd, runId);
	return { path, branch };
}

/** Validate physical Git ownership at every harness execution boundary, including after providers return. */
export function validateRunWorktree(cwd: string, runId: string): string {
	const path = worktreePathFor(cwd, runId);
	const marker = resolve(path, ".git");
	if (!lstatSync(marker).isFile()) throw new Error("run worktree requires its own regular .git file");
	const root = realpathSync(path);
	const top = realpathSync(localGit(path, ["rev-parse", "--show-toplevel"]).trim());
	const gitDir = realpathSync(localGit(path, ["rev-parse", "--absolute-git-dir"]).trim());
	const common = realpathSync(resolve(path, localGit(path, ["rev-parse", "--git-common-dir"]).trim()));
	const expectedCommon = realpathSync(resolve(cwd, localGit(cwd, ["rev-parse", "--git-common-dir"]).trim()));
	const branch = localGit(path, ["symbolic-ref", "--quiet", "HEAD"]).trim();
	if (top !== root || common !== expectedCommon || gitDir === common || branch !== `refs/heads/${branchFor(runId)}`) throw new Error("run worktree Git identity does not match its repository and branch");
	const backlink = readFileSync(resolve(gitDir, "gitdir"), "utf8").trim();
	if (realpathSync(resolve(gitDir, backlink)) !== realpathSync(marker)) throw new Error("run worktree Git directory belongs to another checkout");
	return path;
}

/** All harness-owned Git commands revalidate ownership immediately before executing. */
export function runWorktreeGit(cwd: string, runId: string, args: string[]): string {
	return localGit(validateRunWorktree(cwd, runId), args);
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
