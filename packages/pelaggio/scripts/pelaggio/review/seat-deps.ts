import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const HOST_DEPENDENCY_SNAPSHOT = "authoring-review-host-links.json";

interface HostDependencyLinkSnapshot {
	name: string;
	path: string;
	target: string;
}

interface HostDependencySnapshotRecord {
	schemaVersion: 3;
	lockHash: string;
	links: Record<string, string>;
	binHashes: Record<string, string>;
}

interface HostDependencySnapshot {
	links: HostDependencyLinkSnapshot[];
	binHashes: Record<string, string>;
}

export type AuthoringReviewHostDependencyRepair = "none" | "restore" | "install";

export interface RestoredHostDependencyLink {
	name: string;
	target: string;
	resolvedAbsolute: string;
}

function pathIsInside(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

function dependencyLinkPath(mainRepo: string, name: string): string {
	return resolve(mainRepo, "packages", "pelaggio", "node_modules", name);
}

function directDependencyNames(mainRepo: string): string[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(resolve(mainRepo, "packages", "pelaggio", "package.json"), "utf8"));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const manifest = parsed as { dependencies?: unknown; peerDependencies?: unknown };
	const names = new Set<string>();
	for (const section of [manifest.dependencies, manifest.peerDependencies]) {
		if (section === undefined) continue;
		if (!section || typeof section !== "object" || Array.isArray(section)) return undefined;
		for (const name of Object.keys(section as Record<string, unknown>)) {
			if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) return undefined;
			names.add(name);
		}
	}
	return [...names].sort();
}

function currentLockHash(mainRepo: string): string | undefined {
	try {
		return createHash("sha256")
			.update(readFileSync(resolve(mainRepo, "pnpm-lock.yaml")))
			.digest("hex");
	} catch {
		return undefined;
	}
}

function targetIsCanonical(mainRepo: string, path: string, target: string, expectedName: string): boolean {
	const store = resolve(mainRepo, "node_modules", ".pnpm");
	const lexicalTarget = resolve(dirname(path), target);
	try {
		const realTarget = realpathSync(lexicalTarget);
		if (!pathIsInside(lexicalTarget, store) || !pathIsInside(realTarget, realpathSync(store))) return false;
		const packageJson = JSON.parse(readFileSync(resolve(realTarget, "package.json"), "utf8")) as { name?: unknown };
		return packageJson.name === expectedName;
	} catch {
		return false;
	}
}

function snapshotRecordPath(mainRepo: string): string {
	return resolve(mainRepo, ".dev", HOST_DEPENDENCY_SNAPSHOT);
}

function readSnapshotRecord(mainRepo: string): HostDependencySnapshot | undefined {
	const lockHash = currentLockHash(mainRepo);
	if (!lockHash) return undefined;
	const dependencyNames = directDependencyNames(mainRepo);
	if (!dependencyNames) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(snapshotRecordPath(mainRepo), "utf8"));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as { schemaVersion?: unknown; lockHash?: unknown; links?: unknown; binHashes?: unknown };
	if (
		record.schemaVersion !== 3 ||
		record.lockHash !== lockHash ||
		!record.links ||
		typeof record.links !== "object" ||
		Array.isArray(record.links) ||
		!record.binHashes ||
		typeof record.binHashes !== "object" ||
		Array.isArray(record.binHashes)
	)
		return undefined;
	const links = record.links as Record<string, unknown>;
	if (Object.keys(links).sort().join("\0") !== dependencyNames.join("\0")) return undefined;
	const snapshot: HostDependencyLinkSnapshot[] = [];
	for (const name of dependencyNames) {
		const target = links[name];
		const path = dependencyLinkPath(mainRepo, name);
		if (typeof target !== "string" || !targetIsCanonical(mainRepo, path, target, name)) return undefined;
		snapshot.push({ name, path, target });
	}
	const binHashes = record.binHashes as Record<string, unknown>;
	const validatedBinHashes: Record<string, string> = {};
	for (const [name, hash] of Object.entries(binHashes)) {
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return undefined;
		validatedBinHashes[name] = hash;
	}
	if (currentLockHash(mainRepo) !== lockHash) return undefined;
	return { links: snapshot, binHashes: validatedBinHashes };
}

function writeSnapshotRecord(mainRepo: string, snapshot: HostDependencyLinkSnapshot[], binHashes: Record<string, string>, lockHash: string): void {
	const links: Record<string, string> = {};
	for (const link of snapshot) links[link.name] = link.target;
	const record: HostDependencySnapshotRecord = { schemaVersion: 3, lockHash, links, binHashes };
	const path = snapshotRecordPath(mainRepo);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	writeFileSync(tmp, `${JSON.stringify(record)}\n`);
	if (currentLockHash(mainRepo) !== lockHash) {
		rmSync(tmp, { force: true });
		throw new Error("authoring review seat: pnpm-lock.yaml changed while snapshotting host dependency links");
	}
	renameSync(tmp, path);
}

/** Return every direct-importer pnpm link, [] when this is not a Pelaggio checkout,
 *  or undefined when the checkout exists but is incomplete/outbound. */
function observeCanonicalHostDependencyLinks(mainRepo: string): HostDependencyLinkSnapshot[] | undefined {
	const nodeModules = resolve(mainRepo, "packages", "pelaggio", "node_modules");
	if (!existsSync(nodeModules)) return [];
	const dependencyNames = directDependencyNames(mainRepo);
	if (!dependencyNames) return undefined;
	const links: HostDependencyLinkSnapshot[] = [];
	for (const name of dependencyNames) {
		const path = dependencyLinkPath(mainRepo, name);
		try {
			if (!lstatSync(path).isSymbolicLink()) return undefined;
			const target = readlinkSync(path);
			if (!targetIsCanonical(mainRepo, path, target, name)) return undefined;
			links.push({ name, path, target });
		} catch {
			return undefined;
		}
	}
	return links;
}

function observeHostBinHashes(mainRepo: string): Record<string, string> | undefined {
	const binDir = resolve(mainRepo, "packages", "pelaggio", "node_modules", ".bin");
	if (!existsSync(binDir)) return {};
	const hashes: Record<string, string> = {};
	try {
		for (const name of readdirSync(binDir).sort()) {
			if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return undefined;
			const contents = readFileSync(resolve(binDir, name));
			hashes[name] = createHash("sha256").update(contents).digest("hex");
		}
		return hashes;
	} catch {
		return undefined;
	}
}

function binHashesMatch(observed: Record<string, string> | undefined, expected: Record<string, string>): boolean {
	if (!observed) return false;
	const observedNames = Object.keys(observed).sort();
	const expectedNames = Object.keys(expected).sort();
	return observedNames.join("\0") === expectedNames.join("\0") && observedNames.every((name) => observed[name] === expected[name]);
}

/** Persist one canonical pre-seat snapshot shared by every SHA/process. A later
 *  prepare refreshes it only from a complete pnpm-owned layout, never from a seat. */
export function snapshotAuthoringReviewHostDependencies(mainRepo: string): void {
	const lockHash = currentLockHash(mainRepo);
	const observed = observeCanonicalHostDependencyLinks(mainRepo);
	const dependencyNames = directDependencyNames(mainRepo);
	if (dependencyNames && observed?.length === dependencyNames.length) {
		if (!lockHash || currentLockHash(mainRepo) !== lockHash) {
			throw new Error("authoring review seat: cannot bind host dependency links to a stable pnpm-lock.yaml");
		}
		const binHashes = observeHostBinHashes(mainRepo);
		if (!binHashes) throw new Error("authoring review seat: cannot fingerprint packages/pelaggio/node_modules/.bin");
		const existing = readSnapshotRecord(mainRepo);
		if (existing && !binHashesMatch(binHashes, existing.binHashes)) return;
		writeSnapshotRecord(mainRepo, observed, binHashes, lockHash);
		return;
	}
	if (observed?.length === 0) return;
	if (!readSnapshotRecord(mainRepo)) {
		throw new Error("authoring review seat: host dependency links are not canonical and no valid restoration snapshot exists");
	}
}

export function authoringReviewHostDependencyRepair(mainRepo: string): AuthoringReviewHostDependencyRepair {
	const observed = observeCanonicalHostDependencyLinks(mainRepo);
	if (observed?.length === 0) return "none";
	const dependencyNames = directDependencyNames(mainRepo);
	const snapshot = readSnapshotRecord(mainRepo);
	if (dependencyNames && observed?.length === dependencyNames.length) {
		if (snapshot && !binHashesMatch(observeHostBinHashes(mainRepo), snapshot.binHashes)) return "install";
		return "none";
	}
	return snapshot && binHashesMatch(observeHostBinHashes(mainRepo), snapshot.binHashes) ? "restore" : "install";
}

/** Restore only missing/non-symlink/outbound entries. A different healthy pnpm
 *  target is a concurrent legitimate install and is deliberately left alone. */
export function restoreAuthoringReviewHostDependencies(mainRepo: string): RestoredHostDependencyLink[] {
	const snapshot = readSnapshotRecord(mainRepo);
	if (!snapshot) return [];
	const restored: RestoredHostDependencyLink[] = [];
	let failure: Error | undefined;
	for (const link of snapshot.links) {
		try {
			let currentTarget = "<missing>";
			try {
				if (lstatSync(link.path).isSymbolicLink()) {
					currentTarget = readlinkSync(link.path);
					if (currentTarget === link.target || targetIsCanonical(mainRepo, link.path, currentTarget, link.name)) continue;
				}
			} catch {
				// Recreate a missing link below.
			}
			rmSync(link.path, { recursive: true, force: true });
			mkdirSync(dirname(link.path), { recursive: true });
			symlinkSync(link.target, link.path, "dir");
			restored.push({ name: `packages/pelaggio/node_modules/${link.name}`, target: currentTarget, resolvedAbsolute: resolve(dirname(link.path), currentTarget) });
		} catch (error) {
			failure ??= new Error(`authoring review seat: failed to restore ${link.path}`, { cause: error });
		}
	}
	if (failure) throw failure;
	return restored;
}
