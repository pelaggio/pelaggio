#!/usr/bin/env tsx

/**
 * Share `node_modules` across worktrees by symlinking to MAIN_REPO's
 * `node_modules` when lockfiles match. Falls back to `pnpm install` when
 * they drift. Root-only — workspace subpackages still install normally.
 *
 * Called from `/pick`'s Claim step (fresh worktree) and from `step-runner`
 * at the top of each worktree-cwd step (mid-cycle drift guard).
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO } from "./config.js";

export type DepsAction = { type: "noop" } | { type: "link"; target: string } | { type: "relink"; target: string } | { type: "reinstall" } | { type: "install" };

function hashFile(path: string): string | undefined {
	try {
		const buf = readFileSync(path);
		return createHash("sha256").update(buf).digest("hex");
	} catch {
		return undefined;
	}
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function isRealDir(path: string): boolean {
	try {
		const s = lstatSync(path);
		return s.isDirectory() && !s.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Pure decision: inspect the filesystem and return the action to take.
 * No side effects — safe to call repeatedly.
 */
export function decideDepsAction(worktree: string, mainRepo: string): DepsAction {
	const worktreeNm = resolve(worktree, "node_modules");
	const mainNm = resolve(mainRepo, "node_modules");
	const worktreeLock = resolve(worktree, "pnpm-lock.yaml");
	const mainLock = resolve(mainRepo, "pnpm-lock.yaml");

	// Real (non-symlink) directory: never mutate — user-managed, left alone.
	if (isRealDir(worktreeNm)) return { type: "noop" };

	const mainLockHash = hashFile(mainLock);
	const worktreeLockHash = hashFile(worktreeLock);
	const lockfilesMatch = mainLockHash !== undefined && mainLockHash === worktreeLockHash;
	const mainNmReady = isRealDir(mainNm);

	if (isSymlink(worktreeNm)) {
		let currentTarget: string | undefined;
		try {
			currentTarget = readlinkSync(worktreeNm);
		} catch {
			currentTarget = undefined;
		}
		if (lockfilesMatch && mainNmReady && currentTarget === mainNm) {
			return { type: "noop" };
		}
		if (lockfilesMatch && mainNmReady) {
			return { type: "relink", target: mainNm };
		}
		return { type: "reinstall" };
	}

	// No worktree node_modules at all.
	if (lockfilesMatch && mainNmReady) {
		return { type: "link", target: mainNm };
	}
	return { type: "install" };
}

/**
 * Apply the decided action: remove a stale symlink if needed, create a new
 * one, or invoke `pnpm install`. Returns the action taken so callers can log.
 */
export function ensureWorktreeDeps(worktree: string, mainRepo: string = REPO): DepsAction {
	const action = decideDepsAction(worktree, mainRepo);
	const worktreeNm = resolve(worktree, "node_modules");

	switch (action.type) {
		case "noop":
			return action;
		case "link":
			symlinkSync(action.target, worktreeNm, "dir");
			return action;
		case "relink":
			unlinkSync(worktreeNm);
			symlinkSync(action.target, worktreeNm, "dir");
			return action;
		case "reinstall":
			unlinkSync(worktreeNm);
			execSync("pnpm install --frozen-lockfile --silent", { cwd: worktree, stdio: "inherit" });
			return action;
		case "install":
			execSync("pnpm install --frozen-lockfile --silent", { cwd: worktree, stdio: "inherit" });
			return action;
	}
}

const isDirectInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
	const worktree = process.argv[2];
	if (!worktree) {
		console.error("usage: worktree-deps.ts <worktree-path>");
		process.exit(2);
	}
	try {
		const action = ensureWorktreeDeps(resolve(worktree), REPO);
		console.log(action.type);
		process.exit(0);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
