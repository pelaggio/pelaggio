import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { deriveAuthoringReviewHostDependencyTargets, managedAuthoringReviewHostDependencyNames, resolveAuthoringReviewMainRepo, verifyOrRepairAuthoringReviewHostDependencies } from "../review/seat-deps.js";
import { authoringReviewSeatPath, cleanupAuthoringReviewSeat, type GitExec } from "../review/seats.js";

const SDK_DEPENDENCY = "@anthropic-ai/claude-agent-sdk";
const FIXTURE_RUNTIME_DEPENDENCIES = [SDK_DEPENDENCY, "diff", "tsx", "ulid", "yaml"] as const;
const FIXTURE_DEV_DEPENDENCIES = ["fixture-dev-only"] as const;
const FIXTURE_OPTIONAL_DEPENDENCIES = ["fixture-optional"] as const;
const FIXTURE_DEPENDENCIES = [...FIXTURE_RUNTIME_DEPENDENCIES, ...FIXTURE_DEV_DEPENDENCIES, ...FIXTURE_OPTIONAL_DEPENDENCIES];

interface Fixture {
	root: string;
	host: string;
	seat: string;
	key: { sha: string; seatId: string; pass: number };
	links: Map<string, string>;
	outside: string;
}

function writeLockfile(host: string): void {
	writeFileSync(
		resolve(host, "pnpm-lock.yaml"),
		[
			"lockfileVersion: '9.0'",
			"importers:",
			"  packages/pelaggio:",
			"    dependencies:",
			...FIXTURE_RUNTIME_DEPENDENCIES.flatMap((name) => [`      ${JSON.stringify(name)}:`, "        specifier: ^1.0.0", "        version: 1.0.0"]),
			"    devDependencies:",
			...FIXTURE_DEV_DEPENDENCIES.flatMap((name) => [`      ${JSON.stringify(name)}:`, "        specifier: ^1.0.0", "        version: 1.0.0"]),
			"    optionalDependencies:",
			...FIXTURE_OPTIONAL_DEPENDENCIES.flatMap((name) => [`      ${JSON.stringify(name)}:`, "        specifier: ^1.0.0", "        version: 1.0.0"]),
			"",
		].join("\n"),
	);
}

function makeFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pelaggio-seat-host-links-"));
	const host = resolve(root, "main");
	const outside = resolve(root, "outside");
	const key = { sha: "abc1234", seatId: "reviewer", pass: 1 };
	const seat = authoringReviewSeatPath(host, key);
	const packageNodeModules = resolve(host, "packages", "pelaggio", "node_modules");
	mkdirSync(packageNodeModules, { recursive: true });
	mkdirSync(outside, { recursive: true });
	mkdirSync(seat, { recursive: true });
	writeFileSync(
		resolve(host, "packages", "pelaggio", "package.json"),
		JSON.stringify({
			name: "pelaggio",
			dependencies: Object.fromEntries(FIXTURE_RUNTIME_DEPENDENCIES.map((name) => [name, "^1.0.0"])),
			devDependencies: Object.fromEntries(FIXTURE_DEV_DEPENDENCIES.map((name) => [name, "^1.0.0"])),
			optionalDependencies: Object.fromEntries(FIXTURE_OPTIONAL_DEPENDENCIES.map((name) => [name, "^1.0.0"])),
		}),
	);
	writeLockfile(host);

	const links = new Map<string, string>();
	for (const name of FIXTURE_DEPENDENCIES) {
		const target = resolve(host, "node_modules", ".pnpm", `${name.replace("/", "+")}@1.0.0`, "node_modules", ...name.split("/"));
		mkdirSync(target, { recursive: true });
		writeFileSync(resolve(target, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
		const link = resolve(packageNodeModules, ...name.split("/"));
		mkdirSync(dirname(link), { recursive: true });
		const targetRelative = relative(dirname(link), target);
		symlinkSync(targetRelative, link, "dir");
		links.set(link, targetRelative);
	}
	return { root, host, seat, key, links, outside };
}

function immediateLock(paths: string[]): Parameters<typeof verifyOrRepairAuthoringReviewHostDependencies>[1] {
	return async (path, fn) => {
		paths.push(path);
		return fn();
	};
}

function fakeCleanupGit(fx: Fixture): GitExec {
	return (args) => {
		if (args[0] === "worktree" && args[1] === "remove") rmSync(fx.seat, { recursive: true, force: true });
		return "";
	};
}

function corruptDependencyLink(fx: Fixture, name: string): string {
	const dependencyLink = resolve(fx.host, "packages", "pelaggio", "node_modules", ...name.split("/"));
	const seatTarget = resolve(fx.seat, "node_modules", ".pnpm", `${name.replace("/", "+")}@1.0.0`, "node_modules", ...name.split("/"));
	mkdirSync(seatTarget, { recursive: true });
	rmSync(dependencyLink);
	symlinkSync(seatTarget, dependencyLink, "dir");
	return dependencyLink;
}

describe("authoring-review host dependency restoration (#647)", () => {
	it("is a no-op in consumer repos without a packages/pelaggio lockfile importer", async () => {
		const root = mkdtempSync(join(tmpdir(), "pelaggio-seat-consumer-"));
		try {
			writeFileSync(resolve(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
			const result = await verifyOrRepairAuthoringReviewHostDependencies(root, immediateLock([]));
			assert.deepEqual(result, { status: "healthy", repaired: [] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("teardown restores a dangling SDK link from MAIN's lockfile and store", async () => {
		const fx = makeFixture();
		const lockPaths: string[] = [];
		try {
			const sdkLink = corruptDependencyLink(fx, SDK_DEPENDENCY);
			const result = await cleanupAuthoringReviewSeat(fx.host, fx.key, fakeCleanupGit(fx), (main) => verifyOrRepairAuthoringReviewHostDependencies(main, immediateLock(lockPaths)));

			assert.equal(result.status, "repaired");
			assert.deepEqual(
				result.repaired.map((link) => link.name),
				[SDK_DEPENDENCY],
			);
			assert.equal(readlinkSync(sdkLink), fx.links.get(sdkLink));
			assert.equal(realpathSync(sdkLink), resolve(dirname(sdkLink), fx.links.get(sdkLink)!));
			assert.deepEqual(lockPaths, [resolve(fx.host, ".dev", "node-modules-repair.lock")]);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("pre-ratchet repair restores an optional dependency from the lockfile-derived MAIN target", async () => {
		const fx = makeFixture();
		try {
			const optionalLink = corruptDependencyLink(fx, "fixture-optional");
			const seatTarget = realpathSync(optionalLink);
			const derivedTarget = resolve(dirname(optionalLink), fx.links.get(optionalLink)!);
			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]));

			assert.equal(result.status, "repaired");
			assert.equal(readlinkSync(optionalLink), fx.links.get(optionalLink));
			assert.equal(realpathSync(optionalLink), derivedTarget);
			assert.notEqual(realpathSync(optionalLink), seatTarget);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("rewrites a seat-relative target even when the seat store resolves into MAIN's store", async () => {
		const fx = makeFixture();
		const yamlLink = resolve(fx.host, "packages", "pelaggio", "node_modules", "yaml");
		const seatNodeModules = resolve(fx.seat, "node_modules");
		const seatStore = resolve(seatNodeModules, ".pnpm");
		const seatTarget = resolve(seatStore, "yaml@1.0.0", "node_modules", "yaml");
		try {
			mkdirSync(seatNodeModules, { recursive: true });
			symlinkSync(resolve(fx.host, "node_modules", ".pnpm"), seatStore, "dir");
			rmSync(yamlLink);
			symlinkSync(seatTarget, yamlLink, "dir");
			assert.equal(realpathSync(yamlLink), resolve(dirname(yamlLink), fx.links.get(yamlLink)!));

			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]));

			assert.equal(result.status, "repaired");
			assert.deepEqual(
				result.repaired.map((link) => link.name),
				["yaml"],
			);
			assert.equal(readlinkSync(yamlLink), fx.links.get(yamlLink));
			rmSync(fx.seat, { recursive: true, force: true });
			assert.equal(realpathSync(yamlLink), resolve(dirname(yamlLink), fx.links.get(yamlLink)!));
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("never executes a planted packages/pelaggio/node_modules/.bin/pnpm", async () => {
		const fx = makeFixture();
		const bin = resolve(fx.host, "packages", "pelaggio", "node_modules", ".bin", "pnpm");
		const sentinel = resolve(fx.outside, "executed");
		try {
			mkdirSync(dirname(bin), { recursive: true });
			writeFileSync(bin, `#!/bin/sh\ntouch ${sentinel}\n`);
			corruptDependencyLink(fx, "yaml");

			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]));

			assert.equal(result.status, "repaired");
			assert.equal(existsSync(sentinel), false);
			assert.match(readFileSync(bin, "utf8"), /touch/);
			const repairSource = readFileSync(resolve(fileURLToPath(new URL("..", import.meta.url)), "review", "seat-deps-core.js"), "utf8");
			assert.doesNotMatch(repairSource, /node:child_process|execFile|execSync|runner\.run|\.bin\/pnpm|from ["']yaml["']/);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("parks without writing outside when packages/pelaggio/node_modules is an escaping directory symlink", async () => {
		const fx = makeFixture();
		const packageNodeModules = resolve(fx.host, "packages", "pelaggio", "node_modules");
		const outsideSentinel = resolve(fx.outside, "sentinel");
		try {
			writeFileSync(outsideSentinel, "untouched");
			rmSync(packageNodeModules, { recursive: true });
			symlinkSync(fx.outside, packageNodeModules, "dir");

			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]));

			assert.equal(result.status, "park");
			if (result.status === "park") assert.equal(result.reason, "containment-escape");
			assert.equal(readFileSync(outsideSentinel, "utf8"), "untouched");
			for (const name of FIXTURE_DEPENDENCIES) assert.equal(existsSync(resolve(fx.outside, ...name.split("/"))), false);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("parks without writing outside when a scoped dependency directory is an escaping symlink", async () => {
		const fx = makeFixture();
		const scope = resolve(fx.host, "packages", "pelaggio", "node_modules", "@anthropic-ai");
		const outsideScope = resolve(fx.outside, "anthropic-scope");
		const outsideSentinel = resolve(outsideScope, "sentinel");
		try {
			rmSync(scope, { recursive: true });
			mkdirSync(outsideScope, { recursive: true });
			writeFileSync(outsideSentinel, "untouched");
			symlinkSync(outsideScope, scope, "dir");

			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]));

			assert.equal(result.status, "park");
			if (result.status === "park") assert.equal(result.reason, "containment-escape");
			assert.equal(readFileSync(outsideSentinel, "utf8"), "untouched");
			assert.deepEqual(readdirSync(outsideScope), ["sentinel"]);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("parks with a real directory in a managed link slot and preserves its inode", async () => {
		const fx = makeFixture();
		const yamlPath = resolve(fx.host, "packages", "pelaggio", "node_modules", "yaml");
		const sentinel = resolve(yamlPath, "sentinel");
		try {
			rmSync(yamlPath);
			mkdirSync(yamlPath);
			writeFileSync(sentinel, "preserved");
			const inode = lstatSync(yamlPath).ino;

			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]));

			assert.equal(result.status, "park");
			if (result.status === "park") {
				assert.equal(result.reason, "managed-slot-occupied");
				assert.match(result.detail, new RegExp(yamlPath));
				assert.match(result.detail, /non-symlink occupies this managed dependency link slot/);
			}
			assert.equal(lstatSync(yamlPath).ino, inode);
			assert.equal(readFileSync(sentinel, "utf8"), "preserved");
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("restores a non-symlink swapped into the slot after the final pre-removal check", async () => {
		const fx = makeFixture();
		const yamlLink = corruptDependencyLink(fx, "yaml");
		let swappedInode = 0;
		try {
			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]), {
				beforeSlotRemoval: (path) => {
					rmSync(path);
					mkdirSync(path);
					writeFileSync(resolve(path, "sentinel"), "preserved");
					swappedInode = lstatSync(path).ino;
				},
			});

			assert.equal(result.status, "park");
			if (result.status === "park") {
				assert.equal(result.reason, "managed-slot-occupied");
				assert.match(result.detail, /non-symlink occupies this managed dependency link slot/);
			}
			assert.equal(lstatSync(yamlLink).ino, swappedInode);
			assert.equal(readFileSync(resolve(yamlLink, "sentinel"), "utf8"), "preserved");
			assert.equal(
				readdirSync(dirname(yamlLink)).some((entry) => entry.includes(".quarantine-")),
				false,
			);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("a replacement-creation failure restores the old link so the slot stays retryable", async () => {
		const fx = makeFixture();
		const yamlLink = corruptDependencyLink(fx, "yaml");
		const corruptTarget = readlinkSync(yamlLink);
		try {
			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]), {
				// A collision planted after quarantine makes symlinkSync throw EEXIST —
				// the transient-creation-failure shape.
				afterQuarantine: (path) => writeFileSync(path, "collision"),
			});

			assert.equal(result.status, "park");
			if (result.status === "park") assert.equal(result.reason, "repair-failed");
			// The quarantined link is back in the slot, not absent: lstat-able and retryable.
			assert.equal(lstatSync(yamlLink).isSymbolicLink(), true);
			assert.equal(readlinkSync(yamlLink), corruptTarget);
			assert.equal(
				readdirSync(dirname(yamlLink)).some((entry) => entry.includes(".quarantine-")),
				false,
			);

			// The failure was transient: the next attempt repairs the restored link.
			const second = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]));
			assert.equal(second.status, "repaired");
			assert.equal(readlinkSync(yamlLink), fx.links.get(yamlLink));
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("a missing exact peer variant parks; a same-version sibling variant is never substituted", async () => {
		const fx = makeFixture();
		const lockfilePath = resolve(fx.host, "pnpm-lock.yaml");
		const store = resolve(fx.host, "node_modules", ".pnpm");
		try {
			// The importer resolves yaml to the peer-suffixed variant …
			writeFileSync(
				lockfilePath,
				readFileSync(lockfilePath, "utf8").replace(/("yaml":\n\s+specifier: \^1\.0\.0\n\s+version: )1\.0\.0/, (_, head: string) => `${head}1.0.0(left-pad@9.9.9)`),
			);
			// … the exact variant directory (pnpm's on-disk underscore encoding) is absent;
			// the store still holds the base version AND a DIFFERENT same-base-version
			// variant (the shape roll 13's survivor rewires to) — neither may be substituted.
			const siblingVariant = resolve(store, "yaml@1.0.0_other@3.0.0", "node_modules", "yaml");
			mkdirSync(siblingVariant, { recursive: true });
			writeFileSync(resolve(siblingVariant, "package.json"), JSON.stringify({ name: "yaml", version: "1.0.0" }));
			const yamlLink = corruptDependencyLink(fx, "yaml");
			const corruptTarget = readlinkSync(yamlLink);

			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]));

			assert.equal(result.status, "park");
			if (result.status === "park") {
				assert.equal(result.reason, "missing-store-content");
				assert.match(result.detail, /never substituted/);
				assert.match(result.detail, /yaml@1\.0\.0_left-pad@9\.9\.9/);
			}
			// Fail-closed means untouched: the link was not rewired to the sibling variant.
			assert.equal(readlinkSync(yamlLink), corruptTarget);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("a peer-suffixed resolution repairs to its exact store variant (no false fire)", async () => {
		const fx = makeFixture();
		const lockfilePath = resolve(fx.host, "pnpm-lock.yaml");
		const store = resolve(fx.host, "node_modules", ".pnpm");
		try {
			writeFileSync(
				lockfilePath,
				readFileSync(lockfilePath, "utf8").replace(/("yaml":\n\s+specifier: \^1\.0\.0\n\s+version: )1\.0\.0/, (_, head: string) => `${head}1.0.0(left-pad@9.9.9)`),
			);
			// pnpm's real on-disk peer encoding: `(peer@ver)` becomes `_peer@ver`.
			const exactVariant = resolve(store, "yaml@1.0.0_left-pad@9.9.9", "node_modules", "yaml");
			mkdirSync(exactVariant, { recursive: true });
			writeFileSync(resolve(exactVariant, "package.json"), JSON.stringify({ name: "yaml", version: "1.0.0" }));
			const yamlLink = corruptDependencyLink(fx, "yaml");

			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]));

			assert.equal(result.status, "repaired");
			assert.equal(realpathSync(yamlLink), realpathSync(exactVariant));
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("a lockfile that repeats an importer section parks invalid-lockfile, never silently overwrites", async () => {
		const fx = makeFixture();
		const lockfilePath = resolve(fx.host, "pnpm-lock.yaml");
		try {
			// A duplicate `dependencies:` section after the others would overwrite the
			// first one's parsed entries; duplicate mapping keys are invalid YAML.
			writeFileSync(lockfilePath, `${readFileSync(lockfilePath, "utf8")}    dependencies:\n      "left-pad":\n        specifier: ^1.0.0\n        version: 1.0.0\n`);

			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]));

			assert.equal(result.status, "park");
			if (result.status === "park") {
				assert.equal(result.reason, "invalid-lockfile");
				assert.match(result.detail, /repeats the dependencies section/);
			}
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("a pelaggio checkout with pruned node_modules and a broken lockfile parks, never healthy", async () => {
		const fx = makeFixture();
		try {
			// packages/pelaggio/package.json (name: pelaggio) identifies the workspace;
			// with node_modules pruned AND the importer gone, healthy would be a lie.
			rmSync(resolve(fx.host, "packages", "pelaggio", "node_modules"), { recursive: true });
			writeFileSync(resolve(fx.host, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");

			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]));

			assert.equal(result.status, "park");
			if (result.status === "park") assert.equal(result.reason, "invalid-lockfile");
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("a consumer repo with an unrelated or unparseable lockfile stays a healthy no-op", async () => {
		const root = mkdtempSync(join(tmpdir(), "pelaggio-consumer-broken-"));
		try {
			// No packages/pelaggio identity: whatever the lockfile looks like is none of
			// this module's business.
			writeFileSync(resolve(root, "pnpm-lock.yaml"), "not: [valid, pnpm, lock");

			const result = await verifyOrRepairAuthoringReviewHostDependencies(root, immediateLock([]));

			assert.deepEqual(result, { status: "healthy", repaired: [] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("a repair whose lock token is taken mid-section is discarded, not trusted (exit fence)", async () => {
		const fx = makeFixture();
		const lockPath = resolve(fx.host, ".dev", "node-modules-repair.lock");
		corruptDependencyLink(fx, "yaml");
		try {
			// Real default lock; a reclaimer that judged this holder stale replaces the
			// token during the critical section.
			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, undefined, {
				afterEntryValidation: () => writeFileSync(lockPath, `${Date.now() + 300_000}:intruder`),
			});

			assert.equal(result.status, "park");
			if (result.status === "park") {
				assert.equal(result.reason, "lock-unavailable");
				assert.match(result.detail, /lost .*node-modules-repair\.lock during the critical section/);
			}
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("the exit fence never fires on an uncontended default-lock repair (no false fire)", async () => {
		const fx = makeFixture();
		const lockPath = resolve(fx.host, ".dev", "node-modules-repair.lock");
		const yamlLink = corruptDependencyLink(fx, "yaml");
		try {
			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host);

			assert.equal(result.status, "repaired");
			assert.equal(readlinkSync(yamlLink), fx.links.get(yamlLink));
			assert.equal(existsSync(lockPath), false, "the lock is released after the section");
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("parks when packages/pelaggio/node_modules becomes a symlink after entry validation", async () => {
		const fx = makeFixture();
		const packageNodeModules = resolve(fx.host, "packages", "pelaggio", "node_modules");
		const displacedNodeModules = resolve(fx.host, "packages", "pelaggio", "node_modules-preserved");
		const outsideSentinel = resolve(fx.outside, "sentinel");
		const yamlLink = corruptDependencyLink(fx, "yaml");
		const yamlInode = lstatSync(yamlLink).ino;
		try {
			writeFileSync(outsideSentinel, "untouched");

			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]), {
				afterEntryValidation: () => {
					renameSync(packageNodeModules, displacedNodeModules);
					symlinkSync(fx.outside, packageNodeModules, "dir");
				},
			});

			assert.equal(result.status, "park");
			if (result.status === "park") assert.equal(result.reason, "containment-escape");
			assert.equal(readFileSync(outsideSentinel, "utf8"), "untouched");
			assert.deepEqual(readdirSync(fx.outside), ["sentinel"]);
			assert.equal(lstatSync(resolve(displacedNodeModules, "yaml")).ino, yamlInode);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("parks when a scope directory becomes a symlink after entry validation", async () => {
		const fx = makeFixture();
		const scope = resolve(fx.host, "packages", "pelaggio", "node_modules", "@anthropic-ai");
		const displacedScope = resolve(fx.host, "packages", "pelaggio", "node_modules", "@anthropic-ai-preserved");
		const outsideScope = resolve(fx.outside, "anthropic-scope");
		const outsideSentinel = resolve(outsideScope, "sentinel");
		const sdkLink = corruptDependencyLink(fx, SDK_DEPENDENCY);
		const sdkInode = lstatSync(sdkLink).ino;
		try {
			mkdirSync(outsideScope);
			writeFileSync(outsideSentinel, "untouched");

			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]), {
				afterEntryValidation: () => {
					renameSync(scope, displacedScope);
					symlinkSync(outsideScope, scope, "dir");
				},
			});

			assert.equal(result.status, "park");
			if (result.status === "park") assert.equal(result.reason, "containment-escape");
			assert.equal(readFileSync(outsideSentinel, "utf8"), "untouched");
			assert.deepEqual(readdirSync(outsideScope), ["sentinel"]);
			assert.equal(lstatSync(resolve(displacedScope, "claude-agent-sdk")).ino, sdkInode);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("manages every direct packages/pelaggio importer dependency", () => {
		const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
		const repoRoot = resolve(packageRoot, "../..");
		const lockfile = parseYaml(readFileSync(resolve(repoRoot, "pnpm-lock.yaml"), "utf8")) as {
			importers?: Record<string, { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> }>;
		};
		const importer = lockfile.importers?.["packages/pelaggio"];
		assert.ok(importer, "packages/pelaggio lockfile importer must exist");
		const importerNames = [...new Set([...Object.keys(importer.dependencies ?? {}), ...Object.keys(importer.devDependencies ?? {}), ...Object.keys(importer.optionalDependencies ?? {})])].sort((a, b) => a.localeCompare(b));
		const managedNames = managedAuthoringReviewHostDependencyNames(lockfile);
		assert.deepEqual(managedNames, importerNames);

		const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		};
		for (const name of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]) {
			assert.ok(managedNames.includes(name), `${name} is declared in package.json but absent from the managed lockfile set`);
		}
	});

	it("every importer dependency derives an existing real-store directory (encoding conformance)", () => {
		// The falsifier for pnpm's on-disk virtual-store grammar: derivation runs against
		// THIS repo's live pnpm-lock.yaml and node_modules/.pnpm, so a lockfile-vs-store
		// encoding mismatch (peer-suffix `_` encoding, sha256 hash-truncation) fails here
		// instead of parking every `pelaggio run` in production. Read-only — no repair.
		// Resolved through the primary checkout, as bin/pelaggio.js does: in a pelaggio
		// worktree or review seat packages/pelaggio/node_modules is a symlink to MAIN's,
		// which the derivation rightly refuses when handed the worktree root itself.
		const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
		const repoRoot = resolveAuthoringReviewMainRepo(resolve(packageRoot, "../.."));
		const entries = deriveAuthoringReviewHostDependencyTargets(repoRoot);
		assert.ok(entries.length >= 6, `expected the full importer set, derived ${entries.length}`);
		assert.ok(
			entries.some((entry) => entry.name === SDK_DEPENDENCY),
			"the peer-suffixed (hash-truncated) SDK dependency must derive",
		);
		for (const entry of entries) {
			assert.ok(lstatSync(entry.target).isDirectory(), `${entry.name}: derived store target does not exist: ${entry.target}`);
		}
	});

	it("has no code path that reads the removed authoring-review host-link snapshot", () => {
		const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
		const sourcePaths: string[] = [];
		const collect = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.name === "__tests__") continue;
				const path = resolve(dir, entry.name);
				if (entry.isDirectory()) collect(path);
				else if (entry.isFile() && entry.name.endsWith(".ts")) sourcePaths.push(path);
			}
		};
		collect(sourceRoot);
		for (const path of sourcePaths) {
			const source = readFileSync(path, "utf8");
			assert.doesNotMatch(source, /authoring-review-host-links\.json/);
			assert.doesNotMatch(source, /snapshotAuthoringReviewHostDependencies/);
		}
	});

	it("parks when lockfile-derived virtual-store content is missing", async () => {
		const fx = makeFixture();
		try {
			rmSync(resolve(fx.host, "node_modules", ".pnpm", "yaml@1.0.0"), { recursive: true, force: true });
			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]));

			assert.equal(result.status, "park");
			if (result.status === "park") assert.equal(result.reason, "missing-store-content");
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("does not rewrite a link whose normalized literal target already equals the derived target", async () => {
		const fx = makeFixture();
		try {
			const before = [...fx.links].map(([path, target]) => ({ path, target, ino: lstatSync(path).ino, mtimeMs: lstatSync(path).mtimeMs }));
			const result = await verifyOrRepairAuthoringReviewHostDependencies(fx.host, immediateLock([]));

			assert.deepEqual(result, { status: "healthy", repaired: [] });
			for (const link of before) {
				assert.equal(readlinkSync(link.path), link.target);
				assert.equal(lstatSync(link.path).ino, link.ino);
				assert.equal(lstatSync(link.path).mtimeMs, link.mtimeMs);
			}
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});
});
