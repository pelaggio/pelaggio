import { createHash, randomBytes } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, normalize, relative, resolve, sep } from "node:path";

/** @typedef {"containment-escape" | "invalid-lockfile" | "missing-store-content" | "managed-slot-occupied" | "repair-failed" | "verification-failed" | "lock-unavailable"} ParkReason */
/** @typedef {{ name: string; path: string; target: string }} RepairedLink */
/** @typedef {{ status: "healthy"; repaired: RepairedLink[] } | { status: "repaired"; repaired: RepairedLink[] } | { status: "park"; reason: ParkReason; detail: string; repaired: RepairedLink[] }} RepairResult */
/** @typedef {{ name: string; path: string; parent: string; parentRealpath: string; target: string }} RepairEntry */
/** @typedef {{ name: string; pathParts: string[]; version: string; resolution: string }} ImporterDependency */
/** @typedef {{ afterEntryValidation?: (path: string) => void; beforeSlotRemoval?: (path: string) => void; afterQuarantine?: (path: string) => void }} RepairHooks */
/** @template T @typedef {(path: string, fn: () => Promise<T> | T) => Promise<T>} RepairLock */

const REPAIR_LOCK_STALE_MS = Number(process.env.PELAGGIO_NODE_MODULES_LOCK_STALE_MS) || 300_000;
const REPAIR_LOCK_TIMEOUT_MS = Number(process.env.PELAGGIO_NODE_MODULES_LOCK_TIMEOUT_MS) || 60_000;
const LOCK_BACKOFF_MS = 50;

class HostDependencyRepairError extends Error {
	/**
	 * @param {Exclude<ParkReason, "lock-unavailable">} reason
	 * @param {string} message
	 * @param {ErrorOptions} [options]
	 */
	constructor(reason, message, options) {
		super(message, options);
		this.reason = reason;
	}
}

/** @param {string} path @param {string} root */
function pathIsInside(path, root) {
	return path === root || path.startsWith(`${root}${sep}`);
}

/** @param {string} value @param {string} context */
function parseScalar(value, context) {
	const scalar = value.trim();
	if (scalar.startsWith('"')) {
		try {
			const parsed = JSON.parse(scalar);
			if (typeof parsed === "string") return parsed;
		} catch {
			// Report the common fail-closed error below.
		}
	} else if (scalar.startsWith("'") && scalar.endsWith("'")) {
		return scalar.slice(1, -1).replaceAll("''", "'");
	} else if (scalar && !/[\s#[\]{},&*!|>`]/.test(scalar)) {
		return scalar;
	}
	throw new HostDependencyRepairError("invalid-lockfile", `pnpm-lock.yaml has an unsupported ${context}: ${value}`);
}

/** @param {string} line @param {string} context */
function mappingKey(line, context) {
	if (!line.endsWith(":")) throw new HostDependencyRepairError("invalid-lockfile", `pnpm-lock.yaml has an unsupported ${context}: ${line}`);
	return parseScalar(line.slice(0, -1), context);
}

/** @param {string} text @returns {Record<string, unknown>} */
function pelaggioImporterFromText(text) {
	/** @type {Record<string, Record<string, { version?: string }>>} */
	const importer = {};
	let foundImporter = false;
	/** @type {"dependencies" | "devDependencies" | "optionalDependencies" | undefined} */
	let section;
	/** @type {{ version?: string } | undefined} */
	let dependency;

	for (const rawLine of text.split(/\r?\n/)) {
		if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
		const leading = rawLine.match(/^ */)?.[0].length ?? 0;
		if (rawLine[leading] === "\t") throw new HostDependencyRepairError("invalid-lockfile", "pnpm-lock.yaml uses tabs in the packages/pelaggio importer");
		const line = rawLine.slice(leading);

		if (leading === 2) {
			if (line === "packages/pelaggio:") {
				if (foundImporter) throw new HostDependencyRepairError("invalid-lockfile", "pnpm-lock.yaml repeats the packages/pelaggio importer");
				foundImporter = true;
				section = undefined;
				dependency = undefined;
				continue;
			}
			if (foundImporter) break;
		}
		if (!foundImporter) continue;

		if (leading === 4) {
			const candidate = mappingKey(line, "packages/pelaggio section");
			section = candidate === "dependencies" || candidate === "devDependencies" || candidate === "optionalDependencies" ? candidate : undefined;
			dependency = undefined;
			if (section) {
				// A repeated section would silently overwrite the one already parsed —
				// duplicate mapping keys are invalid YAML and fail closed here.
				if (Object.hasOwn(importer, section)) throw new HostDependencyRepairError("invalid-lockfile", `packages/pelaggio repeats the ${section} section`);
				importer[section] = {};
			}
			continue;
		}
		if (!section) continue;

		if (leading === 6) {
			const name = mappingKey(line, `${section} dependency name`);
			if (Object.hasOwn(importer[section], name)) throw new HostDependencyRepairError("invalid-lockfile", `packages/pelaggio repeats dependency ${name}`);
			dependency = {};
			importer[section][name] = dependency;
			continue;
		}
		if (leading === 8 && dependency && line.startsWith("version:")) {
			if (dependency.version !== undefined) throw new HostDependencyRepairError("invalid-lockfile", "packages/pelaggio repeats a dependency version");
			dependency.version = parseScalar(line.slice("version:".length), "packages/pelaggio dependency version");
		}
	}

	if (!foundImporter) throw new HostDependencyRepairError("invalid-lockfile", "pnpm-lock.yaml has no packages/pelaggio importer");
	return /** @type {Record<string, unknown>} */ (importer);
}

/** @param {unknown} lockfile @returns {Record<string, unknown>} */
function pelaggioImporter(lockfile) {
	if (typeof lockfile === "string") return pelaggioImporterFromText(lockfile);
	if (!lockfile || typeof lockfile !== "object" || Array.isArray(lockfile)) {
		throw new HostDependencyRepairError("invalid-lockfile", "pnpm-lock.yaml is not a mapping");
	}
	const importers = /** @type {{ importers?: unknown }} */ (lockfile).importers;
	if (!importers || typeof importers !== "object" || Array.isArray(importers)) {
		throw new HostDependencyRepairError("invalid-lockfile", "pnpm-lock.yaml has no importers mapping");
	}
	const importer = /** @type {Record<string, unknown>} */ (importers)["packages/pelaggio"];
	if (!importer || typeof importer !== "object" || Array.isArray(importer)) {
		throw new HostDependencyRepairError("invalid-lockfile", "pnpm-lock.yaml has no packages/pelaggio importer");
	}
	return /** @type {Record<string, unknown>} */ (importer);
}

/** @param {string} name @returns {string[]} */
function dependencyPathParts(name) {
	const parts = name.split("/");
	const validShape = name.startsWith("@") ? parts.length === 2 && parts[0].length > 1 : parts.length === 1;
	if (!validShape || parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\"))) {
		throw new HostDependencyRepairError("invalid-lockfile", `pnpm-lock.yaml has an unsupported packages/pelaggio dependency name: ${name}`);
	}
	return parts;
}

/** @param {string} name @param {unknown} dependency @returns {{ version: string; resolution: string }} */
function dependencyVersion(name, dependency) {
	const rawVersion = typeof dependency === "string" ? dependency : dependency && typeof dependency === "object" && !Array.isArray(dependency) ? /** @type {{ version?: unknown }} */ (dependency).version : undefined;
	if (typeof rawVersion !== "string") {
		throw new HostDependencyRepairError("invalid-lockfile", `pnpm-lock.yaml has no resolved version for packages/pelaggio dependency ${name}`);
	}
	const version = rawVersion.split("(", 1)[0];
	if (!version || !/^[a-z0-9][a-z0-9.+_-]*$/i.test(version)) {
		throw new HostDependencyRepairError("invalid-lockfile", `pnpm-lock.yaml has an unsupported resolved version for ${name}: ${rawVersion}`);
	}
	// The peer-context suffix is part of the resolution's identity and is preserved for
	// exact store matching; a malformed suffix fails closed rather than being ignored.
	const suffix = rawVersion.slice(version.length);
	if (suffix !== "" && !/^\(.+\)$/.test(suffix)) {
		throw new HostDependencyRepairError("invalid-lockfile", `pnpm-lock.yaml has an unsupported peer-context suffix for ${name}: ${rawVersion}`);
	}
	return { version, resolution: rawVersion };
}

/** @param {unknown} lockfile @returns {ImporterDependency[]} */
function importerDependencies(lockfile) {
	const importer = pelaggioImporter(lockfile);
	const dependencies = new Map();
	for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
		const mapping = importer[section];
		if (mapping === undefined) continue;
		if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
			throw new HostDependencyRepairError("invalid-lockfile", `packages/pelaggio has an invalid ${section} mapping in pnpm-lock.yaml`);
		}
		for (const [name, dependency] of Object.entries(mapping)) {
			const { version, resolution } = dependencyVersion(name, dependency);
			const entry = { name, pathParts: dependencyPathParts(name), version, resolution };
			const existing = dependencies.get(name);
			if (existing && existing.resolution !== entry.resolution) {
				throw new HostDependencyRepairError("invalid-lockfile", `packages/pelaggio resolves ${name} to conflicting direct dependency versions`);
			}
			dependencies.set(name, entry);
		}
	}
	return [...dependencies.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {unknown} lockfile */
export function managedAuthoringReviewHostDependencyNames(lockfile) {
	return importerDependencies(lockfile).map((dependency) => dependency.name);
}

/**
 * pnpm 11's on-disk virtual-store directory name for a lockfile resolution
 * (depPathToFilename), reimplemented dependency-free and verified empirically against
 * MAIN's real store — including the hashed form (`@anthropic-ai/claude-agent-sdk`'s
 * observed directory reproduces exactly, sha256 prefix and all). The real-store
 * conformance test in authoring-review-seat.test.ts walks the live lockfile and store
 * and fails on any encoding drift.
 * @param {string} name @param {string} resolution
 */
export function authoringReviewStoreDirname(name, resolution) {
	let filename = `${name}@${resolution}`.replace(/\//g, "+");
	if (filename.includes("(")) {
		filename = filename.replace(/\)$/, "").replace(/(\)\()|\(|\)/g, "_");
	}
	if (filename.length > 120) {
		return `${filename.substring(0, 87)}_${createHash("sha256").update(filename).digest("hex").substring(0, 32)}`;
	}
	return filename;
}

/** Read-only derivation of the managed MAIN links and their store targets — the real-store conformance surface; never writes. */
/** @param {string} mainRepo @returns {Array<{ name: string; path: string; target: string }>} */
export function deriveAuthoringReviewHostDependencyTargets(mainRepo) {
	return deriveRepairEntries(mainRepo).map(({ name, path, target }) => ({ name, path, target }));
}

/** Resolve a linked worktree's primary checkout without loading config.ts or invoking git. */
/** @param {string} repo */
export function resolveAuthoringReviewMainRepo(repo) {
	const candidate = resolve(repo);
	const dotGit = resolve(candidate, ".git");
	try {
		if (lstatSync(dotGit).isDirectory()) return candidate;
		const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"));
		if (!match) return candidate;
		const gitDir = resolve(candidate, match[1]);
		const commonDir = resolve(gitDir, readFileSync(resolve(gitDir, "commondir"), "utf8").trim());
		return basename(commonDir) === ".git" ? dirname(commonDir) : candidate;
	} catch {
		return candidate;
	}
}

/** Repository identity: the pelaggio workspace carries packages/pelaggio/package.json with the published package name. */
/** @param {string} mainRepo */
function isPelaggioWorkspace(mainRepo) {
	try {
		return /** @type {{ name?: unknown }} */ (JSON.parse(readFileSync(resolve(mainRepo, "packages", "pelaggio", "package.json"), "utf8"))).name === "pelaggio";
	} catch {
		return false;
	}
}

/** @param {string} mainRepo @returns {RepairEntry[]} */
function deriveRepairEntries(mainRepo) {
	const packageNodeModules = resolve(mainRepo, "packages", "pelaggio", "node_modules");
	let packageNodeModulesStat;
	try {
		packageNodeModulesStat = lstatSync(packageNodeModules);
	} catch {
		// A consumer repository normally has no packages/pelaggio importer.
	}

	/** @type {ImporterDependency[]} */
	let dependencies;
	try {
		dependencies = importerDependencies(readFileSync(resolve(mainRepo, "pnpm-lock.yaml"), "utf8"));
	} catch (error) {
		// A genuine consumer repository (no packages/pelaggio identity) may have any
		// lockfile shape — none of this module's business. A checkout that identifies
		// as the pelaggio workspace must never report healthy on a missing or
		// unparseable lockfile, even with packages/pelaggio/node_modules pruned.
		if (!packageNodeModulesStat && !isPelaggioWorkspace(mainRepo)) return [];
		throw error;
	}

	let packageNodeModulesRealpath;
	try {
		if (!packageNodeModulesStat?.isDirectory() || packageNodeModulesStat.isSymbolicLink()) {
			throw new HostDependencyRepairError("containment-escape", `${packageNodeModules} is not a real directory`);
		}
		packageNodeModulesRealpath = realpathSync(packageNodeModules);
	} catch (error) {
		if (error instanceof HostDependencyRepairError) throw error;
		throw new HostDependencyRepairError("containment-escape", "cannot establish the packages/pelaggio/node_modules write boundary", { cause: error });
	}

	const store = resolve(mainRepo, "node_modules", ".pnpm");
	let storeRealpath;
	/** @type {string[]} */
	let storeEntries;
	try {
		storeRealpath = realpathSync(store);
		storeEntries = readdirSync(store);
	} catch (error) {
		throw new HostDependencyRepairError("missing-store-content", "cannot read MAIN's pnpm virtual store", { cause: error });
	}

	return dependencies.map(({ name, pathParts, resolution }) => {
		// The one exact store directory for this resolution, per pnpm 11's on-disk
		// depPathToFilename grammar (verified empirically against MAIN's virtual store,
		// hash included): `/` → `+`; a peer suffix drops its trailing `)` and turns each
		// `)(`, `(`, `)` into `_`; a name past 120 chars keeps its first 87 followed by
		// `_` + the first 32 hex chars of sha256(full escaped name). Only that directory
		// is accepted — a same-name/base-version sibling variant is never substituted;
		// if it is genuinely absent the repair parks missing-store-content.
		const expected = authoringReviewStoreDirname(name, resolution);
		const candidates = storeEntries
			.filter((entry) => entry === expected)
			.map((entry) => resolve(store, entry, "node_modules", ...pathParts))
			.filter((target) => {
				try {
					return lstatSync(target).isDirectory();
				} catch {
					return false;
				}
			});
		if (candidates.length !== 1) {
			throw new HostDependencyRepairError("missing-store-content", `expected MAIN virtual-store entry ${expected} for ${name}@${resolution}; a same-version peer variant is never substituted`);
		}
		const target = candidates[0];
		const targetRealpath = realpathSync(target);
		if (!pathIsInside(targetRealpath, storeRealpath)) {
			throw new HostDependencyRepairError("missing-store-content", `derived virtual-store target for ${name} escapes MAIN's store`);
		}
		const path = resolve(packageNodeModules, ...pathParts);
		const parent = resolve(path, "..");
		if (!pathIsInside(path, packageNodeModules) || !pathIsInside(parent, packageNodeModules)) {
			throw new HostDependencyRepairError("containment-escape", `${name} does not resolve inside packages/pelaggio/node_modules`);
		}
		let parentRealpath;
		try {
			const parentStat = lstatSync(parent);
			if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("dependency parent is not a real directory");
			parentRealpath = realpathSync(parent);
		} catch (error) {
			throw new HostDependencyRepairError("containment-escape", `cannot establish the parent of ${path}`, { cause: error });
		}
		if (!pathIsInside(parentRealpath, packageNodeModulesRealpath)) {
			throw new HostDependencyRepairError("containment-escape", `parent of ${path} escapes packages/pelaggio/node_modules`);
		}
		const entry = { name, path, parent, parentRealpath, target };
		assertWriteContained(entry, packageNodeModulesRealpath);
		return entry;
	});
}

/** @param {RepairEntry} entry */
function linkIsHealthy(entry) {
	try {
		const literalTarget = normalize(resolve(dirname(entry.path), readlinkSync(entry.path)));
		const derivedTarget = normalize(resolve(entry.target));
		return lstatSync(entry.path).isSymbolicLink() && literalTarget === derivedTarget;
	} catch {
		return false;
	}
}

/** @param {RepairEntry} entry @param {string} expectedParentRealpath */
function assertWriteContained(entry, expectedParentRealpath) {
	const packageNodeModules = entry.name.startsWith("@") ? resolve(entry.parent, "..") : entry.parent;
	let actualParentRealpath;
	try {
		const packageNodeModulesStat = lstatSync(packageNodeModules);
		const parentStat = lstatSync(entry.parent);
		if (!packageNodeModulesStat.isDirectory() || packageNodeModulesStat.isSymbolicLink() || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
			throw new Error("write boundary is not a real directory");
		}
		if (realpathSync(packageNodeModules) !== expectedParentRealpath) throw new Error("package node_modules boundary changed");
		actualParentRealpath = realpathSync(entry.parent);
	} catch (error) {
		throw new HostDependencyRepairError("containment-escape", `cannot resolve parent of ${entry.path}`, { cause: error });
	}
	if (actualParentRealpath !== entry.parentRealpath || !pathIsInside(actualParentRealpath, expectedParentRealpath)) {
		throw new HostDependencyRepairError("containment-escape", `parent of ${entry.path} changed or escapes packages/pelaggio/node_modules`);
	}
}

/** @param {string} mainRepo @param {RepairHooks} hooks @returns {RepairResult} */
function detectRepairVerify(mainRepo, hooks) {
	/** @type {RepairedLink[]} */
	const repaired = [];
	try {
		const entries = deriveRepairEntries(mainRepo);
		if (entries.length === 0) return { status: "healthy", repaired };
		const expectedParentRealpath = realpathSync(resolve(mainRepo, "packages", "pelaggio", "node_modules"));
		const unhealthy = entries.filter((entry) => !linkIsHealthy(entry));

		for (const entry of unhealthy) {
			assertWriteContained(entry, expectedParentRealpath);
			hooks.afterEntryValidation?.(entry.path);
			try {
				assertWriteContained(entry, expectedParentRealpath);
				const stat = lstatSync(entry.path);
				if (!stat.isSymbolicLink()) {
					throw new HostDependencyRepairError("managed-slot-occupied", `${entry.path}: a non-symlink occupies this managed dependency link slot; preserved without deletion`);
				}
				assertWriteContained(entry, expectedParentRealpath);
				hooks.beforeSlotRemoval?.(entry.path);
				// Rename-then-verify closes the lstat→unlink race by construction: the
				// atomic rename moves whatever occupies the slot aside intact, the lstat
				// decides on the moved inode itself, and only a verified symlink is
				// deleted — a concurrently swapped-in non-symlink is restored unharmed.
				const quarantine = `${entry.path}.quarantine-${randomBytes(4).toString("hex")}`;
				renameSync(entry.path, quarantine);
				if (!lstatSync(quarantine).isSymbolicLink()) {
					renameSync(quarantine, entry.path);
					throw new HostDependencyRepairError("managed-slot-occupied", `${entry.path}: a non-symlink occupies this managed dependency link slot; preserved without deletion`);
				}
				hooks.afterQuarantine?.(entry.path);
				// Create the replacement before destroying the quarantined link: if
				// symlinkSync fails, the old link is restored to the slot, so the park
				// leaves retryable state instead of an absent managed entry that every
				// later repair attempt would park on again.
				try {
					symlinkSync(relative(resolve(entry.path, ".."), entry.target), entry.path, "dir");
				} catch (creationError) {
					renameSync(quarantine, entry.path);
					throw creationError;
				}
				unlinkSync(quarantine);
				repaired.push({ name: entry.name, path: entry.path, target: entry.target });
			} catch (error) {
				if (error instanceof HostDependencyRepairError) throw error;
				throw new HostDependencyRepairError("repair-failed", `failed to recreate ${entry.path}`, { cause: error });
			}
		}

		for (const entry of entries) {
			assertWriteContained(entry, expectedParentRealpath);
			if (!linkIsHealthy(entry)) {
				throw new HostDependencyRepairError("verification-failed", `${entry.path} does not resolve to its lockfile-derived MAIN store target`);
			}
		}
		return { status: repaired.length === 0 ? "healthy" : "repaired", repaired };
	} catch (error) {
		const reason = error instanceof HostDependencyRepairError ? error.reason : "verification-failed";
		return { status: "park", reason, detail: error instanceof Error ? error.message : String(error), repaired };
	}
}

/** @param {string} path @param {string} expected */
function takeIfContent(path, expected) {
	const grave = `${path}.grave-${randomBytes(4).toString("hex")}`;
	try {
		renameSync(path, grave);
	} catch {
		return false;
	}
	let got = "";
	try {
		got = readFileSync(grave, "utf8");
	} catch {
		// An unreadable grave is not ours.
	}
	if (got === expected) {
		try {
			unlinkSync(grave);
		} catch {
			// A randomly named dead grave is harmless.
		}
		return true;
	}
	// The rename displaced a lock we do not own (it turned over after `expected`
	// was read). Restore it atomically: link cannot replace, so it either puts the
	// displaced holder's very inode back or yields to a newer acquirer — never a
	// rewritten copy racing a concurrent O_EXCL create.
	try {
		linkSync(grave, path);
	} catch {
		// A new acquirer owns the path now.
	}
	try {
		unlinkSync(grave);
	} catch {
		// A randomly named dead grave is harmless.
	}
	return false;
}

/** @param {string} path */
function stealIfStale(path) {
	let content;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return;
	}
	const expiresAt = Number.parseInt(content, 10);
	if (Number.isFinite(expiresAt) && Date.now() < expiresAt) return;
	takeIfContent(path, content);
}

/** @template T @param {string} path @param {() => Promise<T> | T} fn @returns {Promise<T>} */
async function defaultLock(path, fn) {
	mkdirSync(dirname(path), { recursive: true });
	const deadline = Date.now() + REPAIR_LOCK_TIMEOUT_MS;
	const hardCap = deadline + REPAIR_LOCK_STALE_MS + 2_000;
	let token = "";
	for (;;) {
		token = `${Date.now() + REPAIR_LOCK_STALE_MS}:${process.pid}-${randomBytes(8).toString("hex")}`;
		try {
			writeFileSync(path, token, { flag: "wx" });
			break;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
			if (Date.now() > deadline && Date.now() > hardCap) {
				throw new Error(`node_modules repair lock: timed out waiting on ${path} — if no other process is holding it, delete the lock file`);
			}
			if (Date.now() > deadline) {
				let expiresAt = Number.NaN;
				try {
					expiresAt = Number.parseInt(readFileSync(path, "utf8"), 10);
				} catch {
					// The holder released; retry immediately.
				}
				if (Number.isFinite(expiresAt) && expiresAt > hardCap) {
					throw new Error(`node_modules repair lock: timed out after ${REPAIR_LOCK_TIMEOUT_MS}ms waiting on ${path} — held live by another process`);
				}
			}
			stealIfStale(path);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_BACKOFF_MS + Math.floor(Math.random() * LOCK_BACKOFF_MS)));
		}
	}

	try {
		const result = await fn();
		// Exit fence — the point-of-use verify inside the exclusion primitive: if our
		// token did not survive the critical section (a reclaimer judged us stale and
		// displaced the lock), the section may have overlapped another holder's, so
		// the result is discarded fail-closed rather than trusted. A healthy/repaired
		// report therefore implies its reporter held the lock for the whole section.
		let held = "";
		try {
			held = readFileSync(path, "utf8");
		} catch {
			// An absent lock is equally not ours.
		}
		if (held !== token) {
			throw new Error(`node_modules repair lock: lost ${path} during the critical section (taken by another process) — discarding this repair result; the resume retries under the lock`);
		}
		return result;
	} finally {
		takeIfContent(path, token);
	}
}

/** Dependency-free cold-start verification plus the ordinary in-process repair path. */
/** @param {string} mainRepo @param {RepairLock<RepairResult>} [lock] @param {RepairHooks} [hooks] @returns {Promise<RepairResult>} */
export async function verifyOrRepairAuthoringReviewHostDependencies(mainRepo, lock = defaultLock, hooks = {}) {
	try {
		return await lock(resolve(mainRepo, ".dev", "node-modules-repair.lock"), () => detectRepairVerify(mainRepo, hooks));
	} catch (error) {
		return {
			status: "park",
			reason: "lock-unavailable",
			detail: error instanceof Error ? error.message : String(error),
			repaired: [],
		};
	}
}
