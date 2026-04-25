import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { decideDepsAction, decideSubpackageAction, ensureWorktreeDeps, findOutboundMainSymlinks, listWorkspaceSubpackages, repairMainNodeModules } from "../worktree-deps.js";

interface Setup {
	main: string;
	worktree: string;
}

interface SubpackageSpec {
	name: string;
	mainNm?: "dir" | null;
	worktreeNm?: "dir" | "symlink-to-main-sub" | "symlink-to-wrong" | null;
}

function buildLock(body: string | null | undefined, subpackages: SubpackageSpec[] | undefined): string | null | undefined {
	if (body === null || body === undefined) return body;
	if (!subpackages || subpackages.length === 0) return body;
	// Encode the body as a YAML comment so the file's sha256 still varies with
	// `body` (the hash gate's signal) while the parsed document is a clean
	// mapping with a usable `importers:` block.
	const importerLines = ["importers:", "  .: {}"];
	for (const sp of subpackages) {
		importerLines.push(`  ${sp.name}: {}`);
	}
	return `# tag: ${body}\n${importerLines.join("\n")}\n`;
}

function makeSetup(opts: { mainLock?: string | null; worktreeLock?: string | null; mainNm?: "dir" | null; worktreeNm?: "dir" | "symlink-to-main" | null; worktreePnpmStore?: boolean; subpackages?: SubpackageSpec[] }): Setup {
	const root = mkdtempSync(join(tmpdir(), "worktree-deps-test-"));
	const main = resolve(root, "main");
	const worktree = resolve(root, "worktree");
	mkdirSync(main, { recursive: true });
	mkdirSync(worktree, { recursive: true });

	const mainLock = buildLock(opts.mainLock, opts.subpackages);
	const worktreeLock = buildLock(opts.worktreeLock, opts.subpackages);
	if (mainLock !== null && mainLock !== undefined) {
		writeFileSync(resolve(main, "pnpm-lock.yaml"), mainLock);
	}
	if (worktreeLock !== null && worktreeLock !== undefined) {
		writeFileSync(resolve(worktree, "pnpm-lock.yaml"), worktreeLock);
	}
	if (opts.mainNm === "dir") {
		mkdirSync(resolve(main, "node_modules"));
	}
	const worktreeNm = resolve(worktree, "node_modules");
	if (opts.worktreeNm === "dir") {
		mkdirSync(worktreeNm);
	} else if (opts.worktreeNm === "symlink-to-main") {
		symlinkSync(resolve(main, "node_modules"), worktreeNm, "dir");
	}
	if (opts.worktreePnpmStore) {
		mkdirSync(resolve(worktreeNm, ".pnpm"), { recursive: true });
	}

	for (const sp of opts.subpackages ?? []) {
		const mainSubNm = resolve(main, sp.name, "node_modules");
		const worktreeSubNm = resolve(worktree, sp.name, "node_modules");
		mkdirSync(resolve(main, sp.name), { recursive: true });
		mkdirSync(resolve(worktree, sp.name), { recursive: true });
		if (sp.mainNm === "dir") mkdirSync(mainSubNm);
		if (sp.worktreeNm === "dir") {
			mkdirSync(worktreeSubNm);
		} else if (sp.worktreeNm === "symlink-to-main-sub") {
			symlinkSync(mainSubNm, worktreeSubNm, "dir");
		} else if (sp.worktreeNm === "symlink-to-wrong") {
			symlinkSync(resolve(root, "elsewhere"), worktreeSubNm, "dir");
		}
	}

	return { main, worktree };
}

describe("decideDepsAction", () => {
	it("links when lockfiles match, main nm exists, worktree nm absent", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			mainNm: "dir",
			worktreeNm: null,
		});
		const action = decideDepsAction(worktree, main);
		assert.equal(action.type, "link");
		if (action.type === "link") {
			assert.equal(action.target, resolve(main, "node_modules"));
		}
	});

	it("noop when existing symlink already targets main nm and lockfiles match", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			mainNm: "dir",
			worktreeNm: "symlink-to-main",
		});
		assert.equal(decideDepsAction(worktree, main).type, "noop");
	});

	it("installs when lockfiles match but main nm is absent", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			mainNm: null,
			worktreeNm: null,
		});
		assert.equal(decideDepsAction(worktree, main).type, "install");
	});

	it("installs when lockfiles differ and worktree nm is absent", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "B",
			mainNm: "dir",
			worktreeNm: null,
		});
		assert.equal(decideDepsAction(worktree, main).type, "install");
	});

	it("reinstalls when lockfiles differ and worktree nm is a symlink", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "B",
			mainNm: "dir",
			worktreeNm: "symlink-to-main",
		});
		assert.equal(decideDepsAction(worktree, main).type, "reinstall");
	});

	it("installs when worktree lockfile is missing", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: null,
			mainNm: "dir",
			worktreeNm: null,
		});
		assert.equal(decideDepsAction(worktree, main).type, "install");
	});

	it("noop when worktree has a real directory (same-hash lockfiles)", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			mainNm: "dir",
			worktreeNm: "dir",
		});
		assert.equal(decideDepsAction(worktree, main).type, "noop");
	});

	it("noop when worktree has a real directory (different-hash lockfiles)", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "B",
			mainNm: "dir",
			worktreeNm: "dir",
		});
		assert.equal(decideDepsAction(worktree, main).type, "noop");
	});

	it("restores when worktree has a real directory with .pnpm/ store and lockfiles match", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			mainNm: "dir",
			worktreeNm: "dir",
			worktreePnpmStore: true,
		});
		const action = decideDepsAction(worktree, main);
		assert.equal(action.type, "restore");
		if (action.type === "restore") {
			assert.equal(action.target, resolve(main, "node_modules"));
		}
	});

	it("noop when corruption signature exists but lockfiles drift (restore unsafe)", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "B",
			mainNm: "dir",
			worktreeNm: "dir",
			worktreePnpmStore: true,
		});
		assert.equal(decideDepsAction(worktree, main).type, "noop");
	});

	it("noop when corruption signature exists but main nm is missing (restore unsafe)", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			mainNm: null,
			worktreeNm: "dir",
			worktreePnpmStore: true,
		});
		assert.equal(decideDepsAction(worktree, main).type, "noop");
	});

	it("noop when worktree has a real dir without .pnpm/ store (user-managed, not pnpm)", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			mainNm: "dir",
			worktreeNm: "dir",
		});
		assert.equal(decideDepsAction(worktree, main).type, "noop");
	});
});

describe("listWorkspaceSubpackages", () => {
	it("returns [] when pnpm-lock.yaml is absent", () => {
		const { main } = makeSetup({ mainLock: null, worktreeLock: null });
		assert.deepEqual(listWorkspaceSubpackages(main), []);
	});

	it("returns [] when lockfile parses but has no importers block", () => {
		const { main } = makeSetup({ mainLock: "lockfileVersion: '9.0'\n" });
		assert.deepEqual(listWorkspaceSubpackages(main), []);
	});

	it("returns relative subpackage paths excluding the root '.' entry", () => {
		const { main } = makeSetup({
			mainLock: "lockfileVersion: '9.0'\n",
			subpackages: [{ name: "packages/a" }, { name: "packages/b" }],
		});
		assert.deepEqual(listWorkspaceSubpackages(main).sort(), ["packages/a", "packages/b"]);
	});
});

describe("decideSubpackageAction", () => {
	it("link when worktree sub-nm absent + main sub-nm present + lockfiles match", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			subpackages: [{ name: "packages/a", mainNm: "dir", worktreeNm: null }],
		});
		const action = decideSubpackageAction(worktree, main, "packages/a", false);
		assert.equal(action.type, "link");
		if (action.type === "link") assert.equal(action.target, resolve(main, "packages/a", "node_modules"));
	});

	it("noop when worktree sub-nm absent + lockfiles drift (root install will handle)", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "B",
			subpackages: [{ name: "packages/a", mainNm: "dir", worktreeNm: null }],
		});
		assert.equal(decideSubpackageAction(worktree, main, "packages/a", false).type, "noop");
	});

	it("noop when symlink already targets main sub-nm + lockfiles match", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			subpackages: [{ name: "packages/a", mainNm: "dir", worktreeNm: "symlink-to-main-sub" }],
		});
		assert.equal(decideSubpackageAction(worktree, main, "packages/a", false).type, "noop");
	});

	it("relink when symlink targets wrong path + lockfiles match", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			subpackages: [{ name: "packages/a", mainNm: "dir", worktreeNm: "symlink-to-wrong" }],
		});
		const action = decideSubpackageAction(worktree, main, "packages/a", false);
		assert.equal(action.type, "relink");
		if (action.type === "relink") assert.equal(action.target, resolve(main, "packages/a", "node_modules"));
	});

	it("noop when real dir + rootWillRestore=false (user-managed)", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			subpackages: [{ name: "packages/a", mainNm: "dir", worktreeNm: "dir" }],
		});
		assert.equal(decideSubpackageAction(worktree, main, "packages/a", false).type, "noop");
	});

	it("restore when real dir + rootWillRestore=true + lockfiles match + main sub-nm present", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			subpackages: [{ name: "packages/a", mainNm: "dir", worktreeNm: "dir" }],
		});
		const action = decideSubpackageAction(worktree, main, "packages/a", true);
		assert.equal(action.type, "restore");
		if (action.type === "restore") assert.equal(action.target, resolve(main, "packages/a", "node_modules"));
	});

	it("noop when real dir + rootWillRestore=true but lockfiles drift", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "B",
			subpackages: [{ name: "packages/a", mainNm: "dir", worktreeNm: "dir" }],
		});
		assert.equal(decideSubpackageAction(worktree, main, "packages/a", true).type, "noop");
	});

	it("noop when real dir + rootWillRestore=true but main sub-nm missing", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			subpackages: [{ name: "packages/a", mainNm: null, worktreeNm: "dir" }],
		});
		assert.equal(decideSubpackageAction(worktree, main, "packages/a", true).type, "noop");
	});
});

describe("ensureWorktreeDeps", () => {
	it("creates a symlink on the link action (happy path, no pnpm invoked)", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			mainNm: "dir",
			worktreeNm: null,
		});
		const report = ensureWorktreeDeps(worktree, main);
		assert.equal(report.root.type, "link");
		assert.deepEqual(report.subpackages, []);
		const link = resolve(worktree, "node_modules");
		assert.ok(lstatSync(link).isSymbolicLink(), "node_modules should be a symlink");
		assert.equal(readlinkSync(link), resolve(main, "node_modules"));
	});

	it("removes the corrupted dir and recreates a symlink on the restore action", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			mainNm: "dir",
			worktreeNm: "dir",
			worktreePnpmStore: true,
		});
		const worktreeNm = resolve(worktree, "node_modules");
		// Plant a marker file inside the corrupted dir so we can verify deletion.
		writeFileSync(resolve(worktreeNm, ".pnpm", "marker.txt"), "stale");
		assert.ok(existsSync(resolve(worktreeNm, ".pnpm", "marker.txt")));

		const report = ensureWorktreeDeps(worktree, main);
		assert.equal(report.root.type, "restore");
		assert.deepEqual(report.subpackages, []);
		assert.ok(lstatSync(worktreeNm).isSymbolicLink(), "node_modules should be a symlink after restore");
		assert.equal(readlinkSync(worktreeNm), resolve(main, "node_modules"));
		// The stale marker is gone (its directory was removed before the symlink was created).
		assert.equal(existsSync(resolve(worktreeNm, ".pnpm", "marker.txt")), false);
	});

	it("links root + each subpackage on a fresh worktree (lockfiles match, mains ready)", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			mainNm: "dir",
			worktreeNm: null,
			subpackages: [
				{ name: "packages/a", mainNm: "dir", worktreeNm: null },
				{ name: "packages/b", mainNm: "dir", worktreeNm: null },
			],
		});
		const report = ensureWorktreeDeps(worktree, main);
		assert.equal(report.root.type, "link");
		assert.deepEqual(
			report.subpackages.map((s) => ({ pkg: s.pkg, type: s.action.type })),
			[
				{ pkg: "packages/a", type: "link" },
				{ pkg: "packages/b", type: "link" },
			],
		);
		assert.ok(lstatSync(resolve(worktree, "node_modules")).isSymbolicLink());
		assert.ok(lstatSync(resolve(worktree, "packages/a/node_modules")).isSymbolicLink());
		assert.ok(lstatSync(resolve(worktree, "packages/b/node_modules")).isSymbolicLink());
		assert.equal(readlinkSync(resolve(worktree, "packages/a/node_modules")), resolve(main, "packages/a/node_modules"));
	});

	it("restores root + couples each subpackage real dir to the root restore", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			mainNm: "dir",
			worktreeNm: "dir",
			worktreePnpmStore: true,
			subpackages: [
				{ name: "packages/a", mainNm: "dir", worktreeNm: "dir" },
				{ name: "packages/b", mainNm: "dir", worktreeNm: null },
			],
		});
		const report = ensureWorktreeDeps(worktree, main);
		assert.equal(report.root.type, "restore");
		assert.deepEqual(
			report.subpackages.map((s) => ({ pkg: s.pkg, type: s.action.type })),
			[
				{ pkg: "packages/a", type: "restore" },
				{ pkg: "packages/b", type: "link" },
			],
		);
		assert.ok(lstatSync(resolve(worktree, "node_modules")).isSymbolicLink());
		assert.ok(lstatSync(resolve(worktree, "packages/a/node_modules")).isSymbolicLink());
		assert.ok(lstatSync(resolve(worktree, "packages/b/node_modules")).isSymbolicLink());
	});

	it("decides install at the root when lockfiles drift (subpackage logic is skipped by ensureWorktreeDeps's early return)", () => {
		// Side-effect verification (that pnpm install runs and subpackages are not
		// touched) requires a real pnpm — out of scope for unit tests. Asserting the
		// pure decision documents the contract that drives the early return.
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "B",
			mainNm: "dir",
			worktreeNm: null,
			subpackages: [{ name: "packages/a", mainNm: "dir", worktreeNm: null }],
		});
		assert.equal(decideDepsAction(worktree, main).type, "install");
	});

	it("leaves a subpackage real dir alone when root decision is noop", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			mainNm: "dir",
			worktreeNm: "symlink-to-main",
			subpackages: [{ name: "packages/a", mainNm: "dir", worktreeNm: "dir" }],
		});
		// Plant a marker so we can verify the dir is untouched.
		writeFileSync(resolve(worktree, "packages/a/node_modules", "marker.txt"), "user-managed");
		const report = ensureWorktreeDeps(worktree, main);
		assert.equal(report.root.type, "noop");
		assert.equal(report.subpackages[0].action.type, "noop");
		assert.ok(existsSync(resolve(worktree, "packages/a/node_modules", "marker.txt")));
	});

	it("relinks a subpackage symlink that targets the wrong path (lockfiles match)", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			mainNm: "dir",
			worktreeNm: "symlink-to-main",
			subpackages: [{ name: "packages/a", mainNm: "dir", worktreeNm: "symlink-to-wrong" }],
		});
		const report = ensureWorktreeDeps(worktree, main);
		assert.equal(report.subpackages[0].action.type, "relink");
		assert.equal(readlinkSync(resolve(worktree, "packages/a/node_modules")), resolve(main, "packages/a/node_modules"));
	});
});

function makeMain(): string {
	const root = mkdtempSync(join(tmpdir(), "outbound-symlinks-test-"));
	const main = resolve(root, "main");
	mkdirSync(join(main, "node_modules"), { recursive: true });
	return main;
}

describe("findOutboundMainSymlinks", () => {
	it("returns empty list when main/node_modules is absent", () => {
		const root = mkdtempSync(join(tmpdir(), "outbound-symlinks-test-"));
		const main = resolve(root, "main");
		mkdirSync(main, { recursive: true });
		assert.deepEqual(findOutboundMainSymlinks(main), []);
	});

	it("returns empty list when only inbound symlinks exist (relative to node_modules)", () => {
		const main = makeMain();
		const nm = join(main, "node_modules");
		mkdirSync(join(nm, ".pnpm", "tsx@4.21.0", "node_modules", "tsx"), { recursive: true });
		symlinkSync("./.pnpm/tsx@4.21.0/node_modules/tsx", join(nm, "tsx"), "dir");
		assert.deepEqual(findOutboundMainSymlinks(main), []);
	});

	it("returns empty list when a symlink resolves to a workspace package inside the repo", () => {
		const main = makeMain();
		const nm = join(main, "node_modules");
		mkdirSync(join(main, "packages", "autopilot"), { recursive: true });
		mkdirSync(join(nm, "@cdhorne"), { recursive: true });
		symlinkSync("../../packages/autopilot", join(nm, "@cdhorne", "claude-autopilot"), "dir");
		assert.deepEqual(findOutboundMainSymlinks(main), []);
	});

	it("ignores .pnpm, .bin, .modules.yaml dotfiles", () => {
		const main = makeMain();
		const nm = join(main, "node_modules");
		mkdirSync(join(nm, ".pnpm"));
		mkdirSync(join(nm, ".bin"));
		writeFileSync(join(nm, ".modules.yaml"), "");
		symlinkSync("/somewhere/else", join(nm, ".bin", "stub"), "file");
		assert.deepEqual(findOutboundMainSymlinks(main), []);
	});

	it("detects a top-level symlink pointing into a sibling worktree's .pnpm store", () => {
		const main = makeMain();
		const nm = join(main, "node_modules");
		const sibling = "../../sibling-worktree/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx";
		symlinkSync(sibling, join(nm, "tsx"), "dir");
		const result = findOutboundMainSymlinks(main);
		assert.equal(result.length, 1);
		assert.equal(result[0].name, "tsx");
		assert.equal(result[0].target, sibling);
	});

	it("detects an @scope/pkg symlink pointing into a sibling worktree's .pnpm store", () => {
		const main = makeMain();
		const nm = join(main, "node_modules");
		mkdirSync(join(nm, "@biomejs"));
		const sibling = "../../../sibling-worktree/node_modules/.pnpm/@biomejs+biome@2.4.13/node_modules/@biomejs/biome";
		symlinkSync(sibling, join(nm, "@biomejs", "biome"), "dir");
		const result = findOutboundMainSymlinks(main);
		assert.equal(result.length, 1);
		assert.equal(result[0].name, join("@biomejs", "biome"));
		assert.equal(result[0].target, sibling);
	});

	it("does not recurse beyond @scope/* one level deep", () => {
		const main = makeMain();
		const nm = join(main, "node_modules");
		mkdirSync(join(nm, "@scope", "pkg", "subdir"), { recursive: true });
		symlinkSync("/somewhere/outside", join(nm, "@scope", "pkg", "subdir", "stub"), "file");
		assert.deepEqual(findOutboundMainSymlinks(main), []);
	});

	it("treats a dangling outbound symlink (target deleted) as outbound", () => {
		const main = makeMain();
		const nm = join(main, "node_modules");
		const dangling = "../../gone-worktree/node_modules/.pnpm/typescript@6.0.3/node_modules/typescript";
		symlinkSync(dangling, join(nm, "typescript"), "dir");
		const result = findOutboundMainSymlinks(main);
		assert.equal(result.length, 1);
		assert.equal(result[0].name, "typescript");
	});
});

describe("repairMainNodeModules", () => {
	it("returns { ranInstall: false, repaired: [] } when main is clean", () => {
		const main = makeMain();
		const calls: Array<{ cmd: string; cwd: string }> = [];
		const runner = { run: (cmd: string, cwd: string) => calls.push({ cmd, cwd }) };
		const report = repairMainNodeModules(main, runner);
		assert.equal(report.ranInstall, false);
		assert.deepEqual(report.repaired, []);
		assert.deepEqual(calls, []);
	});

	it("invokes the runner with `pnpm install --frozen-lockfile` and the main repo cwd when corruption is detected", () => {
		const main = makeMain();
		symlinkSync("../../sibling/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx", join(main, "node_modules", "tsx"), "dir");
		const calls: Array<{ cmd: string; cwd: string }> = [];
		const runner = { run: (cmd: string, cwd: string) => calls.push({ cmd, cwd }) };
		const report = repairMainNodeModules(main, runner);
		assert.equal(report.ranInstall, true);
		assert.deepEqual(calls, [{ cmd: "pnpm install --frozen-lockfile", cwd: main }]);
	});

	it("reports the outbound entries it observed in the repaired list", () => {
		const main = makeMain();
		symlinkSync("../../sibling/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx", join(main, "node_modules", "tsx"), "dir");
		symlinkSync("../../sibling/node_modules/.pnpm/typescript@6.0.3/node_modules/typescript", join(main, "node_modules", "typescript"), "dir");
		const runner = { run: () => {} };
		const report = repairMainNodeModules(main, runner);
		assert.equal(report.repaired.length, 2);
		const names = report.repaired.map((r) => r.name).sort();
		assert.deepEqual(names, ["tsx", "typescript"]);
	});
});
