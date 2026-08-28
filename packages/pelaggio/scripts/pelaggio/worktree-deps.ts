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
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { REPO } from "./config.js";
import { withFileLock } from "./file-lock.js";

export interface WorkspaceEntry {
	name: string;
	packagePath: string;
}

export type DepsAction =
	| { type: "noop" }
	| { type: "skip-read-only" }
	| { type: "isolated" }
	| { type: "link"; target: string }
	| { type: "relink"; target: string }
	| { type: "reinstall" }
	| { type: "install" }
	| { type: "restore"; target: string }
	| { type: "materialize"; mainNm: string; workspaceEntries: WorkspaceEntry[] };

export type IsolatedSeatDepsOutcome = "reused" | "installed";

export interface IsolatedSeatDepsReport {
	outcome: IsolatedSeatDepsOutcome;
	lockHash: string;
}

export type IsolatedSeatDepsErrorCode = "outside-seat" | "missing-lockfile" | "unsafe-importer" | "unsafe-local-target" | "install-failed" | "invalid-layout";

export class IsolatedSeatDepsError extends Error {
	constructor(
		readonly code: IsolatedSeatDepsErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "IsolatedSeatDepsError";
	}
}

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

export interface RunnerOptions {
	args?: readonly string[];
	env?: NodeJS.ProcessEnv;
}

export interface Runner {
	run: (cmd: string, cwd: string, options?: RunnerOptions) => void;
}

export interface EnsureWorktreeDepsOptions {
	runner?: Runner;
	workspaceAccess?: "read-only";
}

/** Cross-process lock seam — injectable so tests don't wait on real lock timing. */
export type LockFn = <T>(path: string, fn: () => Promise<T> | T) => Promise<T>;

const defaultRunner: Runner = {
	run: (cmd, cwd, options) => {
		if (options?.args) {
			execFileSync(cmd, [...options.args], { cwd, env: options.env, stdio: "inherit" });
			return;
		}
		execSync(cmd, { cwd, env: options?.env, stdio: "inherit" });
	},
};

/** Same directory name `authoringReviewSeatsRoot()` produces. Duplicated here so this
 *  module does not import `review/seats.ts` (prepare imports this helper). */
const AUTHORING_REVIEW_SEATS_DIR = "authoring-review-seats";
const ISOLATED_SEAT_DEPS_RECORDS_DIR = "authoring-review-seat-deps";
const ISOLATED_SEAT_PACKAGE_MANAGER = "pnpm@11.18.0+sha512.33d83c77da82f49fba836925c6f1b841181ec3132b670639bd012f7075f5c7cf634c5f870147c19aae7478fac01df09d8892e880454896edd23ee9b33757563c";
const PNPM_FROZEN_INSTALL = "pnpm install --frozen-lockfile --silent --ignore-scripts";
const PNPM_ISOLATED_SEAT_INSTALL_ARGS = ["install", "--frozen-lockfile", "--silent", "--ignore-scripts", "--ignore-pnpmfile", "--node-linker=isolated", "--config.enable-global-virtual-store=false"] as const;
const PNPM_ISOLATED_SEAT_ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;

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
 * Classify a real worktree node_modules dir. `correctly-materialized` → all
 * workspace entries resolve into `worktreeRoot` (pelaggio-emitted, current)
 * *and* every top-level entry MAIN carries is mirrored (so a dependency added
 * to MAIN after the snapshot doesn't stay silently missing). `incorrectly-
 * materialized` → at least one workspace entry resolves outside `worktreeRoot`
 * (pelaggio-emitted but stale, e.g. inherited from MAIN's pnpm layout via the
 * parent symlink), or MAIN gained an entry the mirror lacks. `user-managed` →
 * no workspace symlinks present at all.
 */
function inspectMaterializedShape(nmDir: string, mainNm: string, worktreeRoot: string, workspaceEntries: WorkspaceEntry[]): MaterializedShape {
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
	if (bad) return "incorrectly-materialized";

	let mainEntries: string[];
	try {
		mainEntries = readdirSync(mainNm);
	} catch {
		return "correctly-materialized";
	}
	for (const entry of mainEntries) {
		const worktreeEntry = join(nmDir, entry);
		try {
			lstatSync(worktreeEntry);
		} catch {
			return "incorrectly-materialized";
		}
		if (!entry.startsWith("@")) continue;

		let scopeEntries: string[];
		try {
			scopeEntries = readdirSync(join(mainNm, entry));
		} catch {
			continue;
		}
		for (const sub of scopeEntries) {
			try {
				lstatSync(join(worktreeEntry, sub));
			} catch {
				return "incorrectly-materialized";
			}
		}
	}
	return "correctly-materialized";
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
			const shape = inspectMaterializedShape(worktreeNm, mainNm, worktree, workspaceEntries);
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
			const shape = inspectMaterializedShape(worktreeNm, mainNm, worktree, workspaceEntries);
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

/** True when `worktree` is under `MAIN/.dev/authoring-review-seats/` — the checkout
 *  class whose defining property is that prefix, not an incidental path shape. */
function isAuthoringReviewSeatWorktree(worktree: string, mainRepo: string): boolean {
	try {
		const seatsRoot = realpathSync(resolve(mainRepo, ".dev", AUTHORING_REVIEW_SEATS_DIR));
		const realWorktree = realpathSync(resolve(worktree));
		return isStrictlyWithin(realWorktree, seatsRoot);
	} catch {
		return false;
	}
}

interface IsolatedSeatDepsRecord {
	schemaVersion: 1;
	seatRoot: string;
	lockHash: string;
	packageManager: string;
	dev: number;
	ino: number;
	ctimeMs: number;
}

function isolatedSeatDepsRecordPath(seatRoot: string, mainRepo: string): string {
	const recordId = createHash("sha256").update(seatRoot).digest("hex");
	return resolve(realpathSync(mainRepo), ".dev", ISOLATED_SEAT_DEPS_RECORDS_DIR, `${recordId}.json`);
}

function isolatedSeatIdentity(seatRoot: string): Pick<IsolatedSeatDepsRecord, "dev" | "ino" | "ctimeMs"> {
	const stat = statSync(seatRoot);
	return { dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs };
}

function readIsolatedSeatDepsRecord(seatRoot: string, mainRepo: string): IsolatedSeatDepsRecord | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(isolatedSeatDepsRecordPath(seatRoot, mainRepo), "utf8"));
		const record = objectRecord(parsed);
		if (
			record?.schemaVersion !== 1 ||
			record.seatRoot !== seatRoot ||
			typeof record.lockHash !== "string" ||
			record.packageManager !== ISOLATED_SEAT_PACKAGE_MANAGER ||
			typeof record.dev !== "number" ||
			typeof record.ino !== "number" ||
			typeof record.ctimeMs !== "number"
		) {
			return undefined;
		}
		return {
			schemaVersion: 1,
			seatRoot,
			lockHash: record.lockHash,
			packageManager: ISOLATED_SEAT_PACKAGE_MANAGER,
			dev: record.dev,
			ino: record.ino,
			ctimeMs: record.ctimeMs,
		};
	} catch {
		return undefined;
	}
}

function isolatedSeatDepsRecordMatches(seatRoot: string, mainRepo: string, lockHash: string): boolean {
	const record = readIsolatedSeatDepsRecord(seatRoot, mainRepo);
	if (!record || record.lockHash !== lockHash) return false;
	const identity = isolatedSeatIdentity(seatRoot);
	return record.dev === identity.dev && record.ino === identity.ino && record.ctimeMs === identity.ctimeMs;
}

function removeIsolatedSeatDepsRecord(seatRoot: string, mainRepo: string): void {
	rmSync(isolatedSeatDepsRecordPath(seatRoot, mainRepo), { force: true });
}

function writeIsolatedSeatDepsRecord(seatRoot: string, mainRepo: string, lockHash: string): void {
	const recordPath = isolatedSeatDepsRecordPath(seatRoot, mainRepo);
	const record: IsolatedSeatDepsRecord = {
		schemaVersion: 1,
		seatRoot,
		lockHash,
		packageManager: ISOLATED_SEAT_PACKAGE_MANAGER,
		...isolatedSeatIdentity(seatRoot),
	};
	mkdirSync(dirname(recordPath), { recursive: true });
	const tmp = `${recordPath}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(record)}\n`);
	renameSync(tmp, recordPath);
}

function isStrictlyWithin(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

interface ValidatedIsolatedSeatLayout {
	seatRoot: string;
	dependencyLayers: string[];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readSeatLockfile(worktree: string): Record<string, unknown> {
	const lockfile = resolve(worktree, "pnpm-lock.yaml");
	let parsed: unknown;
	try {
		parsed = parseYaml(readFileSync(lockfile, "utf8"));
	} catch (error) {
		throw new IsolatedSeatDepsError("invalid-layout", `isolated seat deps: cannot parse ${lockfile}`, { cause: error });
	}
	const root = objectRecord(parsed);
	if (!root || !objectRecord(root.importers)) {
		throw new IsolatedSeatDepsError("invalid-layout", `isolated seat deps: pnpm-lock.yaml has no importers map in ${worktree}`);
	}
	return root;
}

function localDependencyTarget(value: string): string | undefined {
	if (!value.startsWith("link:") && !value.startsWith("file:")) return undefined;
	const encoded = value.slice(value.indexOf(":") + 1);
	try {
		return decodeURIComponent(encoded);
	} catch {
		return encoded;
	}
}

function validateLocalDependencyValue(value: unknown, importerRoot: string, seatRoot: string, label: string): void {
	if (typeof value === "string") {
		const target = localDependencyTarget(value);
		if (target === undefined) return;
		const lexicalTarget = resolve(importerRoot, target);
		let realTarget: string;
		try {
			realTarget = realpathSync(lexicalTarget);
		} catch (error) {
			throw new IsolatedSeatDepsError("unsafe-local-target", `isolated seat deps: local dependency ${label} has an unreadable target ${JSON.stringify(value)}`, { cause: error });
		}
		if ((lexicalTarget !== seatRoot && !isStrictlyWithin(lexicalTarget, seatRoot)) || (realTarget !== seatRoot && !isStrictlyWithin(realTarget, seatRoot))) {
			throw new IsolatedSeatDepsError("unsafe-local-target", `isolated seat deps: local dependency ${label} escapes private seat root ${seatRoot}: ${JSON.stringify(value)}`);
		}
		return;
	}
	const record = objectRecord(value);
	if (!record) return;
	for (const [key, nested] of Object.entries(record)) {
		validateLocalDependencyValue(nested, importerRoot, seatRoot, `${label}.${key}`);
	}
}

function validateImporterLocalDependencies(importer: string, importerValue: unknown, importerRoot: string, seatRoot: string): void {
	validateLocalDependencyValue(importerValue, importerRoot, seatRoot, JSON.stringify(importer));
}

function validateLockfileLocalDependencies(lockfile: Record<string, unknown>, seatRoot: string): void {
	for (const [field, value] of Object.entries(lockfile)) {
		if (field !== "importers") validateLocalDependencyValue(value, seatRoot, seatRoot, field);
	}

	const packages = objectRecord(lockfile.packages);
	if (!packages) return;
	for (const [dependencyId, value] of Object.entries(packages)) {
		const resolution = objectRecord(objectRecord(value)?.resolution);
		if (resolution?.type !== "directory" || typeof resolution.directory !== "string") continue;
		validateLocalDependencyValue(`file:${resolution.directory}`, seatRoot, seatRoot, `packages.${dependencyId}.resolution.directory`);
	}
}

/** Resolve every lockfile-controlled importer and local dependency before mutation. */
function validateIsolatedSeatLayout(worktree: string, lockfile: Record<string, unknown>): ValidatedIsolatedSeatLayout {
	const abs = resolve(worktree);
	let seatRoot: string;
	try {
		if (lstatSync(abs).isSymbolicLink()) throw new Error("seat root is a symlink");
		seatRoot = realpathSync(abs);
	} catch (error) {
		throw new IsolatedSeatDepsError("unsafe-importer", `isolated seat deps: cannot resolve private seat root ${abs}`, { cause: error });
	}

	const importers = objectRecord(lockfile.importers);
	if (!importers) {
		throw new IsolatedSeatDepsError("invalid-layout", `isolated seat deps: pnpm-lock.yaml has no importers map in ${abs}`);
	}
	if (!Object.hasOwn(importers, ".")) {
		throw new IsolatedSeatDepsError("invalid-layout", `isolated seat deps: pnpm-lock.yaml has no root importer in ${abs}`);
	}
	const dependencyLayers = new Set<string>();
	for (const [importer, importerValue] of Object.entries(importers)) {
		const hasParentSegment = importer.split(/[\\/]/).includes("..");
		const importerPath = resolve(abs, importer);
		const lexicalInside = importer === "." ? importerPath === abs : isStrictlyWithin(importerPath, abs);
		if (importer.length === 0 || isAbsolute(importer) || hasParentSegment || !lexicalInside) {
			throw new IsolatedSeatDepsError("unsafe-importer", `isolated seat deps: unsafe lockfile importer ${JSON.stringify(importer)} in ${abs}`);
		}

		let realImporter: string;
		try {
			realImporter = realpathSync(importerPath);
		} catch (error) {
			throw new IsolatedSeatDepsError("unsafe-importer", `isolated seat deps: cannot resolve lockfile importer ${JSON.stringify(importer)} in ${abs}`, { cause: error });
		}
		const realInside = importer === "." ? realImporter === seatRoot : isStrictlyWithin(realImporter, seatRoot);
		const dependencyLayer = resolve(realImporter, "node_modules");
		if (!realInside || !isStrictlyWithin(dependencyLayer, seatRoot)) {
			throw new IsolatedSeatDepsError("unsafe-importer", `isolated seat deps: lockfile importer ${JSON.stringify(importer)} escapes private seat root ${seatRoot}`);
		}
		validateImporterLocalDependencies(importer, importerValue, realImporter, seatRoot);
		dependencyLayers.add(dependencyLayer);
	}
	validateLockfileLocalDependencies(lockfile, seatRoot);
	return { seatRoot, dependencyLayers: [...dependencyLayers] };
}

function dependencySymlinksStayWithin(path: string, seatRoot: string): boolean {
	let entries: string[];
	try {
		entries = readdirSync(path);
	} catch {
		return false;
	}
	for (const entry of entries) {
		const entryPath = join(path, entry);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(entryPath);
		} catch {
			return false;
		}
		if (stat.isSymbolicLink()) {
			let lexicalTarget: string;
			let realTarget: string;
			try {
				lexicalTarget = resolve(dirname(entryPath), readlinkSync(entryPath));
				realTarget = realpathSync(entryPath);
			} catch {
				return false;
			}
			if ((lexicalTarget !== seatRoot && !isStrictlyWithin(lexicalTarget, seatRoot)) || (realTarget !== seatRoot && !isStrictlyWithin(realTarget, seatRoot))) return false;
			continue;
		}
		if (stat.isDirectory() && !dependencySymlinksStayWithin(entryPath, seatRoot)) return false;
	}
	return true;
}

function dependencyLayerReady(path: string, seatRoot: string): boolean {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		return true;
	}
	return stat.isDirectory() && !stat.isSymbolicLink() && dependencySymlinksStayWithin(path, seatRoot);
}

function privateSeatLayoutReady(seatRoot: string, dependencyLayers: string[]): boolean {
	const nm = resolve(seatRoot, "node_modules");
	return isRealDir(nm) && isRealDir(join(nm, ".pnpm")) && dependencyLayers.every((layer) => dependencyLayerReady(layer, seatRoot));
}

/** Unlink a leftover symlink without following it; rm a real directory; skip absence. */
function removeSeatNodeModulesLayer(path: string): void {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		return;
	}
	if (stat.isSymbolicLink()) {
		unlinkSync(path);
		return;
	}
	if (stat.isDirectory()) {
		rmSync(path, { recursive: true, force: true });
	}
}

function removeSeatDependencyLayers(dependencyLayers: string[]): void {
	for (const layer of dependencyLayers) removeSeatNodeModulesLayer(layer);
}

/** Keep host credentials/config out of checkout-controlled pnpm evaluation and
 * pin every install destination before the unsandboxed package-manager launch. */
function isolatedSeatInstallOptions(seatRoot: string): RunnerOptions {
	const nodeModules = resolve(seatRoot, "node_modules");
	const configRoot = resolve(nodeModules, ".pelaggio-pnpm-config");
	const userConfig = resolve(configRoot, "user-npmrc");
	const xdgConfig = resolve(configRoot, "xdg-config");
	mkdirSync(xdgConfig, { recursive: true });
	writeFileSync(userConfig, "");

	const env: NodeJS.ProcessEnv = {};
	for (const name of PNPM_ISOLATED_SEAT_ENV_ALLOWLIST) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	env.HOME = configRoot;
	env.XDG_CONFIG_HOME = xdgConfig;
	env.XDG_CACHE_HOME = resolve(configRoot, "xdg-cache");
	env.XDG_DATA_HOME = resolve(configRoot, "xdg-data");
	env.XDG_STATE_HOME = resolve(configRoot, "xdg-state");
	env.NPM_CONFIG_USERCONFIG = userConfig;
	env.COREPACK_HOME = resolve(configRoot, "corepack");
	env.COREPACK_ENV_FILE = "0";

	return {
		args: [
			ISOLATED_SEAT_PACKAGE_MANAGER,
			"--dir",
			seatRoot,
			...PNPM_ISOLATED_SEAT_INSTALL_ARGS,
			`--lockfile-dir=${seatRoot}`,
			`--modules-dir=${nodeModules}`,
			`--virtual-store-dir=${resolve(nodeModules, ".pnpm")}`,
			`--store-dir=${resolve(nodeModules, ".pnpm-store")}`,
			`--cache-dir=${resolve(nodeModules, ".pnpm-cache")}`,
			`--config.state-dir=${resolve(nodeModules, ".pnpm-state")}`,
			`--config.config-dir=${xdgConfig}`,
			`--config.userconfig=${userConfig}`,
		],
		env,
	};
}

/**
 * Give a harness-owned authoring-review seat a private, lock-bound pnpm layout.
 * Refuses to run on any path that is not under `MAIN/.dev/authoring-review-seats/`.
 * Does not repair or rewrite MAIN.
 */
export function ensureIsolatedSeatDeps(worktree: string, mainRepo: string, options: { runner?: Runner } = {}): IsolatedSeatDepsReport {
	const abs = resolve(worktree);
	const seatsRoot = resolve(mainRepo, ".dev", AUTHORING_REVIEW_SEATS_DIR);
	if (!isAuthoringReviewSeatWorktree(abs, mainRepo)) {
		throw new IsolatedSeatDepsError("outside-seat", `isolated seat deps refused: ${abs} is not under ${seatsRoot}`);
	}

	const lockHash = hashFile(resolve(abs, "pnpm-lock.yaml"));
	if (!lockHash) {
		throw new IsolatedSeatDepsError("missing-lockfile", `isolated seat deps: missing pnpm-lock.yaml in ${abs}`);
	}
	const lockfile = readSeatLockfile(abs);
	const layout = validateIsolatedSeatLayout(abs, lockfile);

	if (isolatedSeatDepsRecordMatches(layout.seatRoot, mainRepo, lockHash) && privateSeatLayoutReady(layout.seatRoot, layout.dependencyLayers)) {
		return { outcome: "reused", lockHash };
	}

	removeIsolatedSeatDepsRecord(layout.seatRoot, mainRepo);
	removeSeatDependencyLayers(layout.dependencyLayers);

	const runner = options.runner ?? defaultRunner;
	try {
		runner.run("corepack", abs, isolatedSeatInstallOptions(layout.seatRoot));
	} catch (err) {
		throw new IsolatedSeatDepsError("install-failed", `isolated seat deps: pnpm install failed in ${abs}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
	}

	const installedLayout = validateIsolatedSeatLayout(abs, lockfile);
	if (!privateSeatLayoutReady(installedLayout.seatRoot, installedLayout.dependencyLayers)) {
		throw new IsolatedSeatDepsError("invalid-layout", `isolated seat deps: private layout postcondition failed in ${abs}`);
	}
	writeIsolatedSeatDepsRecord(installedLayout.seatRoot, mainRepo, lockHash);
	return { outcome: "installed", lockHash };
}

function applyAction(worktreeNm: string, action: DepsAction, worktreeCwd: string, runner: Runner): void {
	switch (action.type) {
		case "noop":
		case "skip-read-only":
		case "isolated":
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
			runner.run(PNPM_FROZEN_INSTALL, worktreeCwd);
			return;
		case "install":
			runner.run(PNPM_FROZEN_INSTALL, worktreeCwd);
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
 * Read-only reviewed checkouts return before any provisioning or repair. Their
 * seats inspect source and diffs without a resolved dependency tree.
 *
 * Authoring-review seats under `.dev/authoring-review-seats/` take the isolated
 * branch next: a private lock-bound tree, never shared-mode `link` / `relink` /
 * `restore` / `materialize` / `install`. Isolated is an early-out, not a
 * `decideDepsAction` result — that function stays the pure shared-mode decision.
 *
 * MAIN is repaired before any of its dependency entries are shared with the
 * worktree, preventing an earlier worktree-side install from propagating
 * outbound symlinks into a fresh or resumed worktree.
 *
 * When the root decision is `install` or `reinstall`, subpackages are skipped
 * — the install will provision every subpackage in one pass.
 */
export function ensureWorktreeDeps(worktree: string, mainRepo: string = REPO, options: EnsureWorktreeDepsOptions = {}): DepsReport {
	if (options.workspaceAccess === "read-only") {
		return { root: { type: "skip-read-only" }, subpackages: [] };
	}

	if (isAuthoringReviewSeatWorktree(worktree, mainRepo)) {
		ensureIsolatedSeatDeps(worktree, mainRepo, { runner: options.runner });
		return { root: { type: "isolated" }, subpackages: [] };
	}

	const runner = options.runner ?? defaultRunner;
	repairMainNodeModules(mainRepo, runner);

	const workspacePackages = listWorkspacePackageMap(mainRepo);
	const root = decideDepsAction(worktree, mainRepo, workspacePackages);
	const worktreeRootNm = resolve(worktree, "node_modules");

	applyAction(worktreeRootNm, root, worktree, runner);

	if (root.type === "install" || root.type === "reinstall") {
		return { root, subpackages: [] };
	}

	const rootWillRestore = root.type === "restore";
	const subpackages: Array<{ pkg: string; action: DepsAction }> = [];
	for (const pkg of listWorkspaceSubpackages(mainRepo)) {
		const action = decideSubpackageAction(worktree, mainRepo, pkg, rootWillRestore, workspacePackages);
		applyAction(resolve(worktree, pkg, "node_modules"), action, worktree, runner);
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

// `--parallel` workers each finish their own ship in a separate worktree but
// share one MAIN_REPO, so this repair can be entered concurrently. A cold
// pnpm store install runs far longer than a roadmap file edit, hence the
// wider envelope than roadmap/mutation-lock.ts's. Env overrides for tests.
const REPAIR_LOCK_STALE_MS = Number(process.env.PELAGGIO_NODE_MODULES_LOCK_STALE_MS) || 300_000;
const REPAIR_LOCK_TIMEOUT_MS = Number(process.env.PELAGGIO_NODE_MODULES_LOCK_TIMEOUT_MS) || 60_000;

const defaultLock: LockFn = (path, fn) => withFileLock(path, fn, { label: "node_modules repair lock", staleMs: REPAIR_LOCK_STALE_MS, acquireTimeoutMs: REPAIR_LOCK_TIMEOUT_MS });

/**
 * Detect-and-repair: if `findOutboundMainSymlinks` reports any entries, run
 * `pnpm install --frozen-lockfile --ignore-scripts` in `mainRepo` to re-stitch
 * the layout from the lockfile without running lifecycle scripts. No-op when
 * clean.
 *
 * Guarded by a cross-process lock (`file-lock.ts`) keyed on `mainRepo`:
 * concurrent `--parallel` workers otherwise race `pnpm install` against the
 * one shared `node_modules`. The outbound-symlink check is re-run after the
 * lock is acquired so a worker that waited behind another's repair sees the
 * now-clean tree and skips a redundant install.
 *
 * The `runner` and `lock` seams keep tests from spawning a real pnpm or
 * waiting on real lock timing.
 */
export async function repairMainNodeModules(mainRepo: string, runner: Runner = defaultRunner, lock: LockFn = defaultLock): Promise<RepairReport> {
	if (findOutboundMainSymlinks(mainRepo).length === 0) return { ranInstall: false, repaired: [] };
	return lock(resolve(mainRepo, ".dev", "node-modules-repair.lock"), () => {
		const outbound = findOutboundMainSymlinks(mainRepo);
		if (outbound.length === 0) return { ranInstall: false, repaired: [] };
		runner.run("pnpm install --frozen-lockfile --ignore-scripts", mainRepo);
		return { ranInstall: true, repaired: outbound };
	});
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
			const report = await repairMainNodeModules(mainRepo);
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
