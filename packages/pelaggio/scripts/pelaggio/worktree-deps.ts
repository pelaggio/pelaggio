#!/usr/bin/env tsx

/**
 * Share `node_modules` across worktrees by symlinking to MAIN_REPO's
 * `node_modules` when lockfiles match. Falls back to `pnpm install` when
 * they drift. Root-only — workspace subpackages still install normally.
 *
 * Called from `/pick`'s Claim step (fresh worktree) and from `step-runner`
 * at the top of each worktree-cwd step (mid-cycle drift guard).
 */

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { REPO } from "./config.js";

export interface WorkspaceEntry {
	name: string;
	packagePath: string;
}

export type DepsAction =
	| { type: "noop" }
	| { type: "link"; target: string }
	| { type: "relink"; target: string }
	| { type: "reinstall" }
	| { type: "install" }
	| { type: "restore"; target: string }
	| { type: "materialize"; mainNm: string; workspaceEntries: WorkspaceEntry[] };

export interface DepsReport {
	root: DepsAction;
	subpackages: Array<{ pkg: string; action: DepsAction }>;
}

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
 * Build a name → worktree-relative path map for every workspace subpackage by
 * reading each one's `package.json`. The map is the source of truth for "is
 * this top-level node_modules entry a workspace package?" — same set pnpm
 * derives from `pnpm-lock.yaml` + manifests. Entries with missing or
 * unparseable `package.json` are skipped.
 */
export function listWorkspacePackageMap(mainRepo: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const subpkg of listWorkspaceSubpackages(mainRepo)) {
		const pkgJsonPath = resolve(mainRepo, subpkg, "package.json");
		let raw: string;
		try {
			raw = readFileSync(pkgJsonPath, "utf8");
		} catch {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		if (parsed && typeof parsed === "object" && typeof (parsed as { name?: unknown }).name === "string") {
			map.set((parsed as { name: string }).name, subpkg);
		}
	}
	return map;
}

/**
 * Intersect the workspace name set against `nmDir`'s top-level + `@scope/`
 * entries — the entries we'd materialize as worktree-local symlinks. Returns
 * `[]` when `nmDir` doesn't exist or contains no workspace packages.
 */
export function findWorkspaceEntriesIn(nmDir: string, workspacePackages: Map<string, string>): WorkspaceEntry[] {
	if (!isRealDir(nmDir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(nmDir);
	} catch {
		return [];
	}
	const out: WorkspaceEntry[] = [];
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		if (entry.startsWith("@")) {
			let subs: string[];
			try {
				subs = readdirSync(join(nmDir, entry));
			} catch {
				continue;
			}
			for (const sub of subs) {
				const name = `${entry}/${sub}`;
				const wsPath = workspacePackages.get(name);
				if (wsPath !== undefined) out.push({ name, packagePath: wsPath });
			}
			continue;
		}
		const wsPath = workspacePackages.get(entry);
		if (wsPath !== undefined) out.push({ name: entry, packagePath: wsPath });
	}
	return out;
}

type MaterializedShape = "correctly-materialized" | "incorrectly-materialized" | "user-managed";

/**
 * Classify a real worktree node_modules dir by the resolved targets of its
 * workspace-name symlinks. `correctly-materialized` → all workspace entries
 * resolve into `worktreeRoot` (pelaggio-emitted, current). `incorrectly-
 * materialized` → at least one resolves outside (pelaggio-emitted but stale,
 * e.g. inherited from MAIN's pnpm layout via the parent symlink). `user-
 * managed` → no workspace symlinks present at all.
 */
function inspectMaterializedShape(nmDir: string, worktreeRoot: string, workspaceEntries: WorkspaceEntry[]): MaterializedShape {
	let resolvedRoot: string;
	try {
		resolvedRoot = realpathSync(worktreeRoot);
	} catch {
		resolvedRoot = worktreeRoot;
	}
	let saw = false;
	let bad = false;
	for (const { name } of workspaceEntries) {
		const p = join(nmDir, name);
		if (!isSymlink(p)) continue;
		saw = true;
		let resolved: string;
		try {
			resolved = realpathSync(p);
		} catch {
			bad = true;
			continue;
		}
		if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
			bad = true;
		}
	}
	if (!saw) return "user-managed";
	return bad ? "incorrectly-materialized" : "correctly-materialized";
}

/**
 * Pure decision: inspect the filesystem and return the action to take.
 * No side effects — safe to call repeatedly.
 *
 * `workspacePackages` may be precomputed by `ensureWorktreeDeps` to avoid
 * re-reading every importer's `package.json` per subpackage; direct callers
 * can omit it and the map is built on demand.
 */
export function decideDepsAction(worktree: string, mainRepo: string, workspacePackages?: Map<string, string>): DepsAction {
	const worktreeNm = resolve(worktree, "node_modules");
	const mainNm = resolve(mainRepo, "node_modules");
	const worktreeLock = resolve(worktree, "pnpm-lock.yaml");
	const mainLock = resolve(mainRepo, "pnpm-lock.yaml");

	const mainLockHash = hashFile(mainLock);
	const worktreeLockHash = hashFile(worktreeLock);
	const lockfilesMatch = mainLockHash !== undefined && mainLockHash === worktreeLockHash;
	const mainNmReady = isRealDir(mainNm);

	const wsPackages = workspacePackages ?? listWorkspacePackageMap(mainRepo);
	const workspaceEntries = mainNmReady ? findWorkspaceEntriesIn(mainNm, wsPackages) : [];
	const hasWorkspaceEntries = workspaceEntries.length > 0;

	// Real (non-symlink) directory: corruption recovery / materialize fixup.
	// A real `.pnpm/` directory (lstat — *not* `existsSync`, since after a
	// previous materialize `.pnpm` is a symlink and we must NOT re-classify
	// that as corruption) confirms the dir was created by `pnpm install`.
	// Without the signature, leave the dir alone — user-managed.
	if (isRealDir(worktreeNm)) {
		const hasPnpmStore = isRealDir(join(worktreeNm, ".pnpm"));
		if (hasWorkspaceEntries && lockfilesMatch && mainNmReady) {
			const shape = inspectMaterializedShape(worktreeNm, worktree, workspaceEntries);
			if (shape === "correctly-materialized") return { type: "noop" };
			if (shape === "incorrectly-materialized" || hasPnpmStore) {
				return { type: "materialize", mainNm, workspaceEntries };
			}
			return { type: "noop" };
		}
		if (hasPnpmStore && lockfilesMatch && mainNmReady) {
			return { type: "restore", target: mainNm };
		}
		return { type: "noop" };
	}

	if (isSymlink(worktreeNm)) {
		let currentTarget: string | undefined;
		try {
			currentTarget = readlinkSync(worktreeNm);
		} catch {
			currentTarget = undefined;
		}
		if (hasWorkspaceEntries && lockfilesMatch && mainNmReady) {
			return { type: "materialize", mainNm, workspaceEntries };
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
	if (hasWorkspaceEntries && lockfilesMatch && mainNmReady) {
		return { type: "materialize", mainNm, workspaceEntries };
	}
	if (lockfilesMatch && mainNmReady) {
		return { type: "link", target: mainNm };
	}
	return { type: "install" };
}

/**
 * Read the workspace subpackage manifest from `<mainRepo>/pnpm-lock.yaml`'s
 * `importers:` keys, dropping the root `.` entry. The lockfile is the
 * authoritative manifest of what is *actually installed* — same source the
 * lockfile-hash gate already trusts. Returns `[]` on missing or unparseable
 * lockfile (the root install/reinstall fallback will provision everything).
 */
export function listWorkspaceSubpackages(mainRepo: string): string[] {
	const lock = resolve(mainRepo, "pnpm-lock.yaml");
	let raw: string;
	try {
		raw = readFileSync(lock, "utf8");
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object") return [];
	const importers = (parsed as { importers?: unknown }).importers;
	if (!importers || typeof importers !== "object") return [];
	return Object.keys(importers as Record<string, unknown>).filter((k) => k !== ".");
}

/**
 * Per-subpackage decision. Mirrors `decideDepsAction` minus `install` /
 * `reinstall` — root install handles drift, so we never invoke `pnpm install`
 * per-subpackage. The corruption-signature gate at the subpackage level
 * couples to the root: pnpm only writes `.pnpm/` at the root, so the only
 * trustworthy signal that a subpackage's real dir is pnpm-managed (not
 * user data) is that the same incident corrupted the root.
 */
export function decideSubpackageAction(worktree: string, mainRepo: string, pkg: string, rootWillRestore: boolean, workspacePackages?: Map<string, string>): DepsAction {
	const worktreeNm = resolve(worktree, pkg, "node_modules");
	const mainNm = resolve(mainRepo, pkg, "node_modules");
	const worktreeLock = resolve(worktree, "pnpm-lock.yaml");
	const mainLock = resolve(mainRepo, "pnpm-lock.yaml");

	const mainLockHash = hashFile(mainLock);
	const worktreeLockHash = hashFile(worktreeLock);
	const lockfilesMatch = mainLockHash !== undefined && mainLockHash === worktreeLockHash;
	const mainNmReady = isRealDir(mainNm);

	const wsPackages = workspacePackages ?? listWorkspacePackageMap(mainRepo);
	const workspaceEntries = mainNmReady ? findWorkspaceEntriesIn(mainNm, wsPackages) : [];
	const hasWorkspaceEntries = workspaceEntries.length > 0;

	if (isRealDir(worktreeNm)) {
		if (hasWorkspaceEntries && lockfilesMatch && mainNmReady) {
			const shape = inspectMaterializedShape(worktreeNm, worktree, workspaceEntries);
			if (shape === "correctly-materialized") return { type: "noop" };
			if (shape === "incorrectly-materialized" || rootWillRestore) {
				return { type: "materialize", mainNm, workspaceEntries };
			}
			return { type: "noop" };
		}
		if (rootWillRestore && lockfilesMatch && mainNmReady) {
			return { type: "restore", target: mainNm };
		}
		return { type: "noop" };
	}

	if (isSymlink(worktreeNm)) {
		let currentTarget: string | undefined;
		try {
			currentTarget = readlinkSync(worktreeNm);
		} catch {
			currentTarget = undefined;
		}
		if (hasWorkspaceEntries && lockfilesMatch && mainNmReady) {
			return { type: "materialize", mainNm, workspaceEntries };
		}
		if (lockfilesMatch && mainNmReady && currentTarget === mainNm) {
			return { type: "noop" };
		}
		if (lockfilesMatch && mainNmReady) {
			return { type: "relink", target: mainNm };
		}
		return { type: "noop" };
	}

	if (hasWorkspaceEntries && lockfilesMatch && mainNmReady) {
		return { type: "materialize", mainNm, workspaceEntries };
	}
	if (lockfilesMatch && mainNmReady) {
		return { type: "link", target: mainNm };
	}
	return { type: "noop" };
}

function applyAction(worktreeNm: string, action: DepsAction, worktreeCwd: string): void {
	switch (action.type) {
		case "noop":
			return;
		case "link":
			mkdirSync(dirname(worktreeNm), { recursive: true });
			symlinkSync(action.target, worktreeNm, "dir");
			return;
		case "relink":
			unlinkSync(worktreeNm);
			symlinkSync(action.target, worktreeNm, "dir");
			return;
		case "reinstall":
			unlinkSync(worktreeNm);
			execSync("pnpm install --frozen-lockfile --silent", { cwd: worktreeCwd, stdio: "inherit" });
			return;
		case "install":
			execSync("pnpm install --frozen-lockfile --silent", { cwd: worktreeCwd, stdio: "inherit" });
			return;
		case "restore":
			// Only reachable when the decision confirmed the dir contains a `.pnpm/`
			// store (root) or coupled to a root restore (subpackage), and lockfiles
			// match. The recursive rm is safe under that gate.
			rmSync(worktreeNm, { recursive: true, force: true });
			symlinkSync(action.target, worktreeNm, "dir");
			return;
		case "materialize": {
			// Tear down any existing entry — symlink (was sharing MAIN's nm) or
			// real dir (was a stale materialize / pnpm-emitted dir we own).
			if (isSymlink(worktreeNm)) {
				unlinkSync(worktreeNm);
			} else if (isRealDir(worktreeNm)) {
				rmSync(worktreeNm, { recursive: true, force: true });
			}
			mkdirSync(worktreeNm, { recursive: true });

			// Mirror MAIN's top-level entries. Workspace packages → absolute
			// symlinks into the worktree's source. Everything else (.pnpm/,
			// .bin/, .modules.yaml, external deps) → absolute symlinks into
			// MAIN, preserving the shared store.
			const workspaceMap = new Map(action.workspaceEntries.map((e) => [e.name, e.packagePath] as const));
			let mainEntries: string[];
			try {
				mainEntries = readdirSync(action.mainNm);
			} catch {
				return;
			}
			for (const entry of mainEntries) {
				const dest = join(worktreeNm, entry);
				if (entry.startsWith("@")) {
					const scopeMain = join(action.mainNm, entry);
					let scopeEntries: string[];
					try {
						scopeEntries = readdirSync(scopeMain);
					} catch {
						// Edge case: @scope is itself a symlink/file in MAIN. Treat as leaf.
						symlinkSync(resolve(action.mainNm, entry), dest, "dir");
						continue;
					}
					mkdirSync(dest);
					for (const sub of scopeEntries) {
						const fullName = `${entry}/${sub}`;
						const subDest = join(dest, sub);
						const wsPath = workspaceMap.get(fullName);
						if (wsPath !== undefined) {
							symlinkSync(resolve(worktreeCwd, wsPath), subDest, "dir");
						} else {
							symlinkSync(resolve(scopeMain, sub), subDest, "dir");
						}
					}
					continue;
				}
				const wsPath = workspaceMap.get(entry);
				if (wsPath !== undefined) {
					symlinkSync(resolve(worktreeCwd, wsPath), dest, "dir");
				} else {
					symlinkSync(resolve(action.mainNm, entry), dest, "dir");
				}
			}
			return;
		}
	}
}

/**
 * Apply the decided actions: root first, then each workspace subpackage.
 * Returns the report of all actions taken so callers can log.
 *
 * When the root decision is `install` or `reinstall`, subpackages are skipped
 * — the install will provision every subpackage in one pass.
 */
export function ensureWorktreeDeps(worktree: string, mainRepo: string = REPO): DepsReport {
	const workspacePackages = listWorkspacePackageMap(mainRepo);
	const root = decideDepsAction(worktree, mainRepo, workspacePackages);
	const worktreeRootNm = resolve(worktree, "node_modules");

	applyAction(worktreeRootNm, root, worktree);

	if (root.type === "install" || root.type === "reinstall") {
		return { root, subpackages: [] };
	}

	const rootWillRestore = root.type === "restore";
	const subpackages: Array<{ pkg: string; action: DepsAction }> = [];
	for (const pkg of listWorkspaceSubpackages(mainRepo)) {
		const action = decideSubpackageAction(worktree, mainRepo, pkg, rootWillRestore, workspacePackages);
		applyAction(resolve(worktree, pkg, "node_modules"), action, worktree);
		subpackages.push({ pkg, action });
	}

	return { root, subpackages };
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

/** Resolve the primary checkout that owns a repo's shared Git directory. */
export function resolveMainRepo(cwd: string = REPO, resolveCommonDir: (cwd: string) => string = (repo) => execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, encoding: "utf8" })): string {
	const commonDir = resolveCommonDir(cwd).trim();
	return dirname(commonDir);
}

const isDirectInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
	const arg = process.argv[2];
	if (!arg) {
		console.error("usage: worktree-deps.ts <worktree-path> | --check-main | --repair-main");
		process.exit(2);
	}
	const mainRepo = resolveMainRepo();

	if (arg === "--check-main") {
		const outbound = findOutboundMainSymlinks(mainRepo);
		if (outbound.length === 0) {
			console.log(`clean: no outbound symlinks found in ${join(mainRepo, "node_modules")}`);
			process.exit(0);
		}
		console.log(`corruption detected: ${outbound.length} outbound symlinks`);
		for (const o of outbound) console.log(`  ${o.name} -> ${o.target}`);
		process.exit(1);
	}

	if (arg === "--repair-main") {
		try {
			const report = repairMainNodeModules(mainRepo);
			if (!report.ranInstall) {
				console.log(`clean: no outbound symlinks found in ${join(mainRepo, "node_modules")}`);
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
		const report = ensureWorktreeDeps(resolve(arg), mainRepo);
		console.log(report.root.type);
		for (const { pkg, action } of report.subpackages) {
			if (action.type !== "noop") console.log(`  ${pkg}: ${action.type}`);
		}
		process.exit(0);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
