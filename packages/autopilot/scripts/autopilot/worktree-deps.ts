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
import { lstatSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO } from "./config.js";

export type DepsAction = { type: "noop" } | { type: "link"; target: string } | { type: "relink"; target: string } | { type: "reinstall" } | { type: "install" };

export interface OutboundSymlink {
	name: string;
	target: string;
	resolvedAbsolute: string;
}

export interface RepairReport {
	ranInstall: boolean;
	repaired: OutboundSymlink[];
}

export interface Runner {
	run: (cmd: string, cwd: string) => void;
}

const defaultRunner: Runner = {
	run: (cmd, cwd) => {
		execSync(cmd, { cwd, stdio: "inherit" });
	},
};

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

/**
 * Scan `<mainRepo>/node_modules/` (top level + one level into `@scope/`) for
 * symlinks whose resolved target lies outside `<mainRepo>`. That set is the
 * TOOL-52 corruption signature: pnpm running inside a worktree (while the
 * worktree's `node_modules` was a symlink into main) re-pointed top-level
 * symlinks at the worktree's `.pnpm` store. After the worktree is removed,
 * the targets vanish.
 *
 * Pnpm's own internals (`.pnpm`, `.bin`, `.modules.yaml`) are skipped. Workspace
 * package symlinks (e.g. `@scope/pkg → ../../packages/pkg`) resolve outside
 * `node_modules/` but still inside the repo root — those are legitimate and
 * NOT flagged. Boundary is the repo root, not the `node_modules/` dir.
 */
export function findOutboundMainSymlinks(mainRepo: string): OutboundSymlink[] {
	const repoRoot = resolve(mainRepo);
	const nm = join(repoRoot, "node_modules");
	if (!isRealDir(nm)) return [];

	const out: OutboundSymlink[] = [];
	const repoPrefix = repoRoot + sep;

	function scanDir(dir: string, depth: number): void {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.startsWith(".")) continue;
			const p = join(dir, entry);
			let stat: ReturnType<typeof lstatSync>;
			try {
				stat = lstatSync(p);
			} catch {
				continue;
			}
			if (stat.isSymbolicLink()) {
				let target: string;
				try {
					target = readlinkSync(p);
				} catch {
					continue;
				}
				const abs = resolve(dirname(p), target);
				if (!abs.startsWith(repoPrefix) && abs !== repoRoot) {
					out.push({ name: relative(nm, p), target, resolvedAbsolute: abs });
				}
			} else if (stat.isDirectory() && entry.startsWith("@") && depth === 0) {
				scanDir(p, depth + 1);
			}
		}
	}

	scanDir(nm, 0);
	return out;
}

/**
 * Detect-and-repair: if `findOutboundMainSymlinks` reports any entries, run
 * `pnpm install --frozen-lockfile` in `mainRepo` to re-stitch the layout from
 * the lockfile (the same recovery a user would run manually). No-op when clean.
 *
 * The `runner` seam keeps tests from spawning a real pnpm.
 */
export function repairMainNodeModules(mainRepo: string, runner: Runner = defaultRunner): RepairReport {
	const outbound = findOutboundMainSymlinks(mainRepo);
	if (outbound.length === 0) return { ranInstall: false, repaired: [] };
	runner.run("pnpm install --frozen-lockfile", mainRepo);
	return { ranInstall: true, repaired: outbound };
}

const isDirectInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
	const arg = process.argv[2];
	if (!arg) {
		console.error("usage: worktree-deps.ts <worktree-path> | --check-main | --repair-main");
		process.exit(2);
	}

	if (arg === "--check-main") {
		const outbound = findOutboundMainSymlinks(REPO);
		if (outbound.length === 0) {
			console.log(`clean: no outbound symlinks found in ${join(REPO, "node_modules")}`);
			process.exit(0);
		}
		console.log(`corruption detected: ${outbound.length} outbound symlinks`);
		for (const o of outbound) console.log(`  ${o.name} -> ${o.target}`);
		process.exit(1);
	}

	if (arg === "--repair-main") {
		try {
			const report = repairMainNodeModules(REPO);
			if (!report.ranInstall) {
				console.log(`clean: no outbound symlinks found in ${join(REPO, "node_modules")}`);
				process.exit(0);
			}
			console.log(`corruption detected: ${report.repaired.length} outbound symlinks`);
			for (const o of report.repaired) console.log(`  ${o.name} -> ${o.target}`);
			console.log("repaired");
			process.exit(0);
		} catch (err) {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
	}

	try {
		const action = ensureWorktreeDeps(resolve(arg), REPO);
		console.log(action.type);
		process.exit(0);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
