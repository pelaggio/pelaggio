import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { decideDepsAction, decideSubpackageAction, ensureWorktreeDeps, findOutboundMainSymlinks, findWorkspaceEntriesIn, listWorkspacePackageMap, listWorkspaceSubpackages, repairMainNodeModules, resolveMainRepo } from "../worktree-deps.js";

interface Setup {
	main: string;
	worktree: string;
}

interface SubpackageSpec {
	name: string;
	mainNm?: "dir" | null;
	worktreeNm?: "dir" | "symlink-to-main-sub" | "symlink-to-wrong" | null;
}

describe("resolveMainRepo", () => {
	it("returns the primary checkout when invoked from a linked worktree", () => {
		const worktree = "/repos/project-230";
		assert.equal(
			resolveMainRepo(worktree, (cwd) => {
				assert.equal(cwd, worktree);
				return "/repos/project/.git\n";
			}),
			"/repos/project",
		);
	});

	it("returns the same checkout when invoked from the primary repo itself", () => {
		const main = "/repos/project";
		assert.equal(
			resolveMainRepo(main, (cwd) => {
				assert.equal(cwd, main);
				return "/repos/project/.git\n";
			}),
			"/repos/project",
		);
	});
});

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

// ── Materialize setup ──────────────────────────────────────────────────
//
// The decideDepsAction/materialize tests need richer setup than makeSetup:
// MAIN-side workspace symlinks (so `findWorkspaceEntriesIn` finds entries),
// package.json with `name` (so `listWorkspacePackageMap` resolves them),
// and varied worktree shapes (correctly/incorrectly materialized real dirs).

interface MaterializeSetup {
	main: string;
	worktree: string;
}

interface MaterializeOpts {
	mainLock?: string | null;
	worktreeLock?: string | null;
	// Workspace packages: each gets a <main>/<pkg>/package.json + <worktree>/<pkg> dir.
	workspaces: Array<{ pkg: string; name: string }>;
	// Top-level <main>/node_modules entries.
	rootMainNm?: {
		// Workspace-name symlinks (will land in findWorkspaceEntriesIn's intersection).
		// `targetPkg` is worktree-relative; we plant a symlink to <main>/<targetPkg>
		// so following the symlink (via the worktree's symlink-to-main parent) lands
		// at <main>/<targetPkg>, mimicking the bug.
		workspaceLinks?: Array<{ name: string; targetPkg: string }>;
		// External entries (NOT workspace names) — should keep pointing at MAIN.
		externals?: string[];
		// Mark .pnpm/, .bin/, .modules.yaml as present (each as a real dir/file).
		pnpmInfra?: boolean;
	};
	// Initial worktree root-level node_modules state.
	worktreeNm?: { kind: "absent" } | { kind: "symlink-to-main" } | { kind: "real-with-pnpm-store" } | { kind: "real-correctly-materialized" } | { kind: "real-incorrectly-materialized" };
	// Per-subpackage state (subset of workspaces; ones to actually configure).
	subpackages?: Array<{
		pkg: string;
		mainNm?: {
			workspaceLinks?: Array<{ name: string; targetPkg: string }>;
			externals?: string[];
		};
		worktreeNm?: { kind: "absent" } | { kind: "symlink-to-main-sub" } | { kind: "real-correctly-materialized" } | { kind: "real-incorrectly-materialized" };
	}>;
}

function plantSymlink(parent: string, name: string, target: string): void {
	const slash = name.indexOf("/");
	if (slash >= 0) {
		mkdirSync(join(parent, name.slice(0, slash)), { recursive: true });
	} else {
		mkdirSync(parent, { recursive: true });
	}
	symlinkSync(target, join(parent, name), "dir");
}

function plantNmEntries(nmDir: string, mainRepo: string, links?: Array<{ name: string; targetPkg: string }>, externals?: string[], pnpmInfra?: boolean): void {
	mkdirSync(nmDir, { recursive: true });
	if (pnpmInfra) {
		mkdirSync(join(nmDir, ".pnpm"));
		mkdirSync(join(nmDir, ".bin"));
		writeFileSync(join(nmDir, ".modules.yaml"), "");
	}
	for (const link of links ?? []) {
		plantSymlink(nmDir, link.name, resolve(mainRepo, link.targetPkg));
	}
	for (const ext of externals ?? []) {
		// External entries: real subdirs (or symlinks to elsewhere). Use a real
		// dir so MAIN's nm has a stable target; the materialize symlink will
		// point at it absolutely.
		mkdirSync(join(nmDir, ext), { recursive: true });
	}
}

function plantMaterializedEntries(nmDir: string, mainNm: string, worktree: string, links?: Array<{ name: string; targetPkg: string }>): void {
	const workspaceMap = new Map((links ?? []).map((link) => [link.name, link.targetPkg] as const));
	mkdirSync(nmDir);
	for (const entry of readdirSync(mainNm)) {
		const dest = join(nmDir, entry);
		if (entry.startsWith("@")) {
			let scopeEntries: string[];
			try {
				scopeEntries = readdirSync(join(mainNm, entry));
			} catch {
				symlinkSync(join(mainNm, entry), dest, "dir");
				continue;
			}
			mkdirSync(dest);
			for (const sub of scopeEntries) {
				const name = `${entry}/${sub}`;
				const targetPkg = workspaceMap.get(name);
				symlinkSync(targetPkg === undefined ? join(mainNm, name) : resolve(worktree, targetPkg), join(dest, sub), "dir");
			}
			continue;
		}
		const targetPkg = workspaceMap.get(entry);
		symlinkSync(targetPkg === undefined ? join(mainNm, entry) : resolve(worktree, targetPkg), dest, "dir");
	}
}

function makeMaterializeSetup(opts: MaterializeOpts): MaterializeSetup {
	const root = mkdtempSync(join(tmpdir(), "worktree-materialize-test-"));
	const main = resolve(root, "main");
	const worktree = resolve(root, "worktree");
	mkdirSync(main, { recursive: true });
	mkdirSync(worktree, { recursive: true });

	// Lockfile bodies — the workspaces list also produces an `importers:` block
	// so `listWorkspaceSubpackages` returns the configured packages.
	const importerLines = ["importers:", "  .: {}"];
	for (const w of opts.workspaces) importerLines.push(`  ${w.pkg}: {}`);
	const mainLockBody = opts.mainLock === undefined ? "A" : opts.mainLock;
	const worktreeLockBody = opts.worktreeLock === undefined ? mainLockBody : opts.worktreeLock;
	if (mainLockBody !== null) {
		writeFileSync(resolve(main, "pnpm-lock.yaml"), `# tag: ${mainLockBody}\n${importerLines.join("\n")}\n`);
	}
	if (worktreeLockBody !== null) {
		writeFileSync(resolve(worktree, "pnpm-lock.yaml"), `# tag: ${worktreeLockBody}\n${importerLines.join("\n")}\n`);
	}

	// Workspace packages exist in both main and worktree as real dirs with
	// distinct source files we can probe for resolution correctness.
	for (const w of opts.workspaces) {
		mkdirSync(resolve(main, w.pkg), { recursive: true });
		mkdirSync(resolve(worktree, w.pkg), { recursive: true });
		writeFileSync(resolve(main, w.pkg, "package.json"), JSON.stringify({ name: w.name }));
		writeFileSync(resolve(worktree, w.pkg, "package.json"), JSON.stringify({ name: w.name }));
		// Marker file lets us assert which side a symlink resolved to.
		writeFileSync(resolve(main, w.pkg, "marker.txt"), "main");
		writeFileSync(resolve(worktree, w.pkg, "marker.txt"), "worktree");
	}

	// MAIN root nm.
	if (opts.rootMainNm) {
		plantNmEntries(resolve(main, "node_modules"), main, opts.rootMainNm.workspaceLinks, opts.rootMainNm.externals, opts.rootMainNm.pnpmInfra);
	}

	// Worktree root nm initial state.
	const worktreeNm = resolve(worktree, "node_modules");
	const wState = opts.worktreeNm?.kind ?? "absent";
	if (wState === "symlink-to-main") {
		symlinkSync(resolve(main, "node_modules"), worktreeNm, "dir");
	} else if (wState === "real-with-pnpm-store") {
		mkdirSync(worktreeNm, { recursive: true });
		mkdirSync(join(worktreeNm, ".pnpm"));
	} else if (wState === "real-correctly-materialized") {
		plantMaterializedEntries(worktreeNm, resolve(main, "node_modules"), worktree, opts.rootMainNm?.workspaceLinks);
	} else if (wState === "real-incorrectly-materialized") {
		// Real dir but the workspace entries point at MAIN instead of worktree.
		mkdirSync(worktreeNm);
		for (const link of opts.rootMainNm?.workspaceLinks ?? []) {
			plantSymlink(worktreeNm, link.name, resolve(main, link.targetPkg));
		}
	}

	// Subpackages.
	for (const sp of opts.subpackages ?? []) {
		if (sp.mainNm) {
			plantNmEntries(resolve(main, sp.pkg, "node_modules"), main, sp.mainNm.workspaceLinks, sp.mainNm.externals, false);
		}
		const wsubNm = resolve(worktree, sp.pkg, "node_modules");
		const sState = sp.worktreeNm?.kind ?? "absent";
		if (sState === "symlink-to-main-sub") {
			symlinkSync(resolve(main, sp.pkg, "node_modules"), wsubNm, "dir");
		} else if (sState === "real-correctly-materialized") {
			plantMaterializedEntries(wsubNm, resolve(main, sp.pkg, "node_modules"), worktree, sp.mainNm?.workspaceLinks);
		} else if (sState === "real-incorrectly-materialized") {
			mkdirSync(wsubNm);
			for (const link of sp.mainNm?.workspaceLinks ?? []) {
				plantSymlink(wsubNm, link.name, resolve(main, link.targetPkg));
			}
		}
	}

	return { main, worktree };
}

describe("listWorkspacePackageMap", () => {
	it("maps each subpackage's package.json `name` to its relative path", () => {
		const { main } = makeMaterializeSetup({
			workspaces: [
				{ pkg: "packages/a", name: "@scope/a" },
				{ pkg: "packages/b", name: "b-pkg" },
			],
		});
		const map = listWorkspacePackageMap(main);
		assert.equal(map.size, 2);
		assert.equal(map.get("@scope/a"), "packages/a");
		assert.equal(map.get("b-pkg"), "packages/b");
	});

	it("skips subpackages whose package.json is missing", async () => {
		const { rmSync } = await import("node:fs");
		const { main } = makeMaterializeSetup({
			workspaces: [
				{ pkg: "packages/a", name: "@scope/a" },
				{ pkg: "packages/b", name: "b-pkg" },
			],
		});
		rmSync(resolve(main, "packages/b/package.json"));
		const map = listWorkspacePackageMap(main);
		assert.equal(map.size, 1);
		assert.equal(map.get("@scope/a"), "packages/a");
	});

	it("skips subpackages whose package.json is malformed JSON", () => {
		const { main } = makeMaterializeSetup({
			workspaces: [
				{ pkg: "packages/a", name: "@scope/a" },
				{ pkg: "packages/b", name: "b" },
			],
		});
		writeFileSync(resolve(main, "packages/a/package.json"), "{ not json");
		const map = listWorkspacePackageMap(main);
		assert.equal(map.size, 1);
		assert.equal(map.get("b"), "packages/b");
	});

	it("returns an empty map when the workspace has no subpackages", () => {
		const { main } = makeMaterializeSetup({ workspaces: [] });
		assert.equal(listWorkspacePackageMap(main).size, 0);
	});
});

describe("findWorkspaceEntriesIn", () => {
	it("matches top-level workspace name entries", () => {
		const root = mkdtempSync(join(tmpdir(), "find-ws-test-"));
		const nm = join(root, "node_modules");
		mkdirSync(nm);
		symlinkSync(resolve(root, "external"), join(nm, "external"), "dir");
		symlinkSync(resolve(root, "myws"), join(nm, "myws"), "dir");
		const result = findWorkspaceEntriesIn(nm, new Map([["myws", "packages/x"]]));
		assert.deepEqual(result, [{ name: "myws", packagePath: "packages/x" }]);
	});

	it("matches @scope/pkg workspace entries", () => {
		const root = mkdtempSync(join(tmpdir(), "find-ws-test-"));
		const nm = join(root, "node_modules");
		mkdirSync(join(nm, "@scope"), { recursive: true });
		symlinkSync(resolve(root, "a"), join(nm, "@scope", "a"), "dir");
		symlinkSync(resolve(root, "b"), join(nm, "@scope", "b"), "dir");
		const result = findWorkspaceEntriesIn(nm, new Map([["@scope/a", "packages/a"]]));
		assert.deepEqual(result, [{ name: "@scope/a", packagePath: "packages/a" }]);
	});

	it("returns [] when nmDir does not exist", () => {
		const root = mkdtempSync(join(tmpdir(), "find-ws-test-"));
		assert.deepEqual(findWorkspaceEntriesIn(join(root, "absent"), new Map()), []);
	});

	it("ignores dotfile entries (.pnpm, .bin, .modules.yaml)", () => {
		const root = mkdtempSync(join(tmpdir(), "find-ws-test-"));
		const nm = join(root, "node_modules");
		mkdirSync(join(nm, ".pnpm"), { recursive: true });
		writeFileSync(join(nm, ".modules.yaml"), "");
		// Even if a workspace map (mistakenly) contained ".pnpm", we never match it.
		assert.deepEqual(findWorkspaceEntriesIn(nm, new Map([[".pnpm", "x"]])), []);
	});

	it("returns no false positives when nm contains only externals", () => {
		const root = mkdtempSync(join(tmpdir(), "find-ws-test-"));
		const nm = join(root, "node_modules");
		mkdirSync(join(nm, "tsx"), { recursive: true });
		mkdirSync(join(nm, "@biomejs", "biome"), { recursive: true });
		assert.deepEqual(findWorkspaceEntriesIn(nm, new Map([["myws", "packages/x"]])), []);
	});
});

describe("decideDepsAction (materialize)", () => {
	it("materializes when worktree nm is absent and main nm contains workspace entries", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [
				{ pkg: "packages/a", name: "@scope/a" },
				{ pkg: "packages/b", name: "@scope/b" },
			],
			rootMainNm: { workspaceLinks: [{ name: "@scope/a", targetPkg: "packages/a" }], externals: ["tsx"] },
			worktreeNm: { kind: "absent" },
		});
		const action = decideDepsAction(worktree, main);
		assert.equal(action.type, "materialize");
		if (action.type === "materialize") {
			assert.equal(action.mainNm, resolve(main, "node_modules"));
			assert.deepEqual(action.workspaceEntries, [{ name: "@scope/a", packagePath: "packages/a" }]);
		}
	});

	it("materializes when worktree nm is a symlink to main and main nm contains workspace entries", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [{ pkg: "packages/a", name: "@scope/a" }],
			rootMainNm: { workspaceLinks: [{ name: "@scope/a", targetPkg: "packages/a" }] },
			worktreeNm: { kind: "symlink-to-main" },
		});
		assert.equal(decideDepsAction(worktree, main).type, "materialize");
	});

	it("noop when worktree nm is correctly materialized (workspace symlinks resolve into worktree)", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [{ pkg: "packages/a", name: "@scope/a" }],
			rootMainNm: { workspaceLinks: [{ name: "@scope/a", targetPkg: "packages/a" }], pnpmInfra: true },
			worktreeNm: { kind: "real-correctly-materialized" },
		});
		assert.equal(decideDepsAction(worktree, main).type, "noop");
	});

	it("materializes when worktree nm is real with workspace symlinks pointing into MAIN (incorrectly materialized)", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [{ pkg: "packages/a", name: "@scope/a" }],
			rootMainNm: { workspaceLinks: [{ name: "@scope/a", targetPkg: "packages/a" }] },
			worktreeNm: { kind: "real-incorrectly-materialized" },
		});
		assert.equal(decideDepsAction(worktree, main).type, "materialize");
	});

	it("materializes (not restore) when worktree nm has .pnpm/ store AND workspace entries are present", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [{ pkg: "packages/a", name: "@scope/a" }],
			rootMainNm: { workspaceLinks: [{ name: "@scope/a", targetPkg: "packages/a" }] },
			worktreeNm: { kind: "real-with-pnpm-store" },
		});
		assert.equal(decideDepsAction(worktree, main).type, "materialize");
	});

	it("noop on a correctly-materialized layer even with .pnpm symlinked (lstat-based check)", () => {
		// Regression for the existsSync(.pnpm) false positive: after a previous
		// materialize, .pnpm exists as a symlink (existsSync follows it → true).
		// The lstat-based check correctly identifies it as not a real .pnpm/ store.
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [{ pkg: "packages/a", name: "@scope/a" }],
			rootMainNm: { workspaceLinks: [{ name: "@scope/a", targetPkg: "packages/a" }], pnpmInfra: true },
			worktreeNm: { kind: "real-correctly-materialized" },
		});
		// Sanity: .pnpm in worktree is a symlink to a real .pnpm in main.
		const wtPnpm = resolve(worktree, "node_modules/.pnpm");
		assert.ok(lstatSync(wtPnpm).isSymbolicLink());
		assert.ok(existsSync(wtPnpm));
		assert.equal(decideDepsAction(worktree, main).type, "noop");
	});

	it("materializes when MAIN gains an unscoped external entry", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [{ pkg: "packages/a", name: "@scope/a" }],
			rootMainNm: { workspaceLinks: [{ name: "@scope/a", targetPkg: "packages/a" }], externals: ["tsx"] },
			worktreeNm: { kind: "real-correctly-materialized" },
		});
		mkdirSync(resolve(main, "node_modules/react"));
		assert.equal(decideDepsAction(worktree, main).type, "materialize");
	});

	it("materializes when MAIN gains a child beneath an existing scope", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [{ pkg: "packages/a", name: "@scope/a" }],
			rootMainNm: { workspaceLinks: [{ name: "@scope/a", targetPkg: "packages/a" }], externals: ["@scope/external"] },
			worktreeNm: { kind: "real-correctly-materialized" },
		});
		mkdirSync(resolve(main, "node_modules/@scope/new-dependency"));
		assert.equal(decideDepsAction(worktree, main).type, "materialize");
	});

	it("leaves a user-managed real directory alone when it lacks MAIN entries", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [{ pkg: "packages/a", name: "@scope/a" }],
			rootMainNm: { workspaceLinks: [{ name: "@scope/a", targetPkg: "packages/a" }], externals: ["tsx"] },
			worktreeNm: { kind: "absent" },
		});
		mkdirSync(resolve(worktree, "node_modules"));
		assert.equal(decideDepsAction(worktree, main).type, "noop");
	});
});

describe("decideSubpackageAction (materialize)", () => {
	it("materializes when worktree sub-nm is absent and main sub-nm contains workspace entries", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [
				{ pkg: "packages/web", name: "@scope/web" },
				{ pkg: "packages/server", name: "@scope/server" },
			],
			subpackages: [{ pkg: "packages/web", mainNm: { workspaceLinks: [{ name: "@scope/server", targetPkg: "packages/server" }] }, worktreeNm: { kind: "absent" } }],
		});
		const map = listWorkspacePackageMap(main);
		const action = decideSubpackageAction(worktree, main, "packages/web", false, map);
		assert.equal(action.type, "materialize");
		if (action.type === "materialize") {
			assert.deepEqual(action.workspaceEntries, [{ name: "@scope/server", packagePath: "packages/server" }]);
		}
	});

	it("materializes when worktree sub-nm is a symlink to main sub-nm and main sub-nm has workspace entries", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [
				{ pkg: "packages/web", name: "@scope/web" },
				{ pkg: "packages/server", name: "@scope/server" },
			],
			subpackages: [{ pkg: "packages/web", mainNm: { workspaceLinks: [{ name: "@scope/server", targetPkg: "packages/server" }] }, worktreeNm: { kind: "symlink-to-main-sub" } }],
		});
		assert.equal(decideSubpackageAction(worktree, main, "packages/web", false).type, "materialize");
	});

	it("noop when worktree sub-nm is correctly materialized", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [
				{ pkg: "packages/web", name: "@scope/web" },
				{ pkg: "packages/server", name: "@scope/server" },
			],
			subpackages: [{ pkg: "packages/web", mainNm: { workspaceLinks: [{ name: "@scope/server", targetPkg: "packages/server" }] }, worktreeNm: { kind: "real-correctly-materialized" } }],
		});
		assert.equal(decideSubpackageAction(worktree, main, "packages/web", false).type, "noop");
	});

	it("materializes when worktree sub-nm is real with workspace symlinks pointing into MAIN", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [
				{ pkg: "packages/web", name: "@scope/web" },
				{ pkg: "packages/server", name: "@scope/server" },
			],
			subpackages: [{ pkg: "packages/web", mainNm: { workspaceLinks: [{ name: "@scope/server", targetPkg: "packages/server" }] }, worktreeNm: { kind: "real-incorrectly-materialized" } }],
		});
		assert.equal(decideSubpackageAction(worktree, main, "packages/web", false).type, "materialize");
	});

	it("materializes when a MAIN subpackage gains an external entry", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [
				{ pkg: "packages/web", name: "@scope/web" },
				{ pkg: "packages/server", name: "@scope/server" },
			],
			subpackages: [
				{
					pkg: "packages/web",
					mainNm: { workspaceLinks: [{ name: "@scope/server", targetPkg: "packages/server" }], externals: ["react"] },
					worktreeNm: { kind: "real-correctly-materialized" },
				},
			],
		});
		mkdirSync(resolve(main, "packages/web/node_modules/zod"));
		assert.equal(decideSubpackageAction(worktree, main, "packages/web", false).type, "materialize");
	});
});

describe("ensureWorktreeDeps (materialize)", () => {
	it("materializes the root and each workspace-bearing subpackage", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [
				{ pkg: "packages/web", name: "@scope/web" },
				{ pkg: "packages/server", name: "@scope/server" },
			],
			rootMainNm: {
				workspaceLinks: [
					{ name: "@scope/web", targetPkg: "packages/web" },
					{ name: "@scope/server", targetPkg: "packages/server" },
				],
				externals: ["tsx"],
				pnpmInfra: true,
			},
			worktreeNm: { kind: "absent" },
			subpackages: [{ pkg: "packages/web", mainNm: { workspaceLinks: [{ name: "@scope/server", targetPkg: "packages/server" }], externals: ["react"] }, worktreeNm: { kind: "absent" } }],
		});
		const report = ensureWorktreeDeps(worktree, main);
		assert.equal(report.root.type, "materialize");
		assert.equal(report.subpackages[0].action.type, "materialize");

		// Root: workspace symlinks resolve into the worktree.
		const webLink = resolve(worktree, "node_modules/@scope/web");
		assert.ok(lstatSync(webLink).isSymbolicLink());
		assert.equal(realpathSync(webLink), realpathSync(resolve(worktree, "packages/web")));

		// Root: external + pnpm infra preserved as absolute symlinks to MAIN.
		const tsxLink = resolve(worktree, "node_modules/tsx");
		assert.ok(lstatSync(tsxLink).isSymbolicLink());
		assert.equal(readlinkSync(tsxLink), resolve(main, "node_modules/tsx"));
		const pnpmLink = resolve(worktree, "node_modules/.pnpm");
		assert.ok(lstatSync(pnpmLink).isSymbolicLink());
		assert.equal(readlinkSync(pnpmLink), resolve(main, "node_modules/.pnpm"));

		// Subpkg: workspace symlink in packages/web resolves to worktree's server.
		const serverLink = resolve(worktree, "packages/web/node_modules/@scope/server");
		assert.ok(lstatSync(serverLink).isSymbolicLink());
		assert.equal(realpathSync(serverLink), realpathSync(resolve(worktree, "packages/server")));

		// Subpkg: external preserved as absolute symlink to MAIN.
		const reactLink = resolve(worktree, "packages/web/node_modules/react");
		assert.ok(lstatSync(reactLink).isSymbolicLink());
		assert.equal(readlinkSync(reactLink), resolve(main, "packages/web/node_modules/react"));
	});

	it("is idempotent — running again on a correctly-materialized layer is noop", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [{ pkg: "packages/a", name: "@scope/a" }],
			rootMainNm: { workspaceLinks: [{ name: "@scope/a", targetPkg: "packages/a" }], externals: ["tsx"], pnpmInfra: true },
			worktreeNm: { kind: "absent" },
		});
		const first = ensureWorktreeDeps(worktree, main);
		assert.equal(first.root.type, "materialize");
		const second = ensureWorktreeDeps(worktree, main);
		assert.equal(second.root.type, "noop");
		// Layout still correct after the no-op pass.
		assert.equal(realpathSync(resolve(worktree, "node_modules/@scope/a")), realpathSync(resolve(worktree, "packages/a")));
	});

	it("refreshes a materialized snapshot when MAIN gains an entry, then returns to noop", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [{ pkg: "packages/a", name: "@scope/a" }],
			rootMainNm: { workspaceLinks: [{ name: "@scope/a", targetPkg: "packages/a" }], externals: ["tsx"] },
			worktreeNm: { kind: "absent" },
		});
		assert.equal(ensureWorktreeDeps(worktree, main).root.type, "materialize");

		const mainReact = resolve(main, "node_modules/react");
		mkdirSync(mainReact);
		const refresh = ensureWorktreeDeps(worktree, main);
		assert.equal(refresh.root.type, "materialize");
		const worktreeReact = resolve(worktree, "node_modules/react");
		assert.ok(lstatSync(worktreeReact).isSymbolicLink());
		assert.equal(readlinkSync(worktreeReact), mainReact);

		assert.equal(ensureWorktreeDeps(worktree, main).root.type, "noop");
	});

	it("does not modify MAIN's node_modules during materialize", () => {
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [{ pkg: "packages/a", name: "@scope/a" }],
			rootMainNm: { workspaceLinks: [{ name: "@scope/a", targetPkg: "packages/a" }], externals: ["tsx"], pnpmInfra: true },
			worktreeNm: { kind: "absent" },
		});
		const mainNm = resolve(main, "node_modules");
		const snapshot = (dir: string): Array<{ name: string; kind: string; target?: string }> =>
			readdirSync(dir).map((name) => {
				const p = join(dir, name);
				const s = lstatSync(p);
				if (s.isSymbolicLink()) return { name, kind: "symlink", target: readlinkSync(p) };
				if (s.isDirectory()) return { name, kind: "dir" };
				return { name, kind: "file" };
			});
		const before = snapshot(mainNm);
		ensureWorktreeDeps(worktree, main);
		const after = snapshot(mainNm);
		assert.deepEqual(after, before);
	});

	it("end-to-end regression: cross-package workspace import resolves into the worktree's source", () => {
		// Closes the issue's acceptance criterion 3. Mirrors the bug's exact
		// shape: packages/web imports @pelaggio/server; the
		// MAIN-side <web>/node_modules/@pelaggio/server symlink
		// targets MAIN's source. Without the fix, the worktree's import resolves
		// through that symlink to MAIN. After ensureWorktreeDeps with materialize,
		// it must resolve into the worktree.
		const { main, worktree } = makeMaterializeSetup({
			workspaces: [
				{ pkg: "packages/web", name: "@pelaggio/web" },
				{ pkg: "packages/server", name: "@pelaggio/server" },
			],
			rootMainNm: {
				workspaceLinks: [
					{ name: "@pelaggio/web", targetPkg: "packages/web" },
					{ name: "@pelaggio/server", targetPkg: "packages/server" },
				],
				pnpmInfra: true,
			},
			worktreeNm: { kind: "symlink-to-main" },
			subpackages: [{ pkg: "packages/web", mainNm: { workspaceLinks: [{ name: "@pelaggio/server", targetPkg: "packages/server" }] }, worktreeNm: { kind: "absent" } }],
		});

		// Plant a marker source file that distinguishes worktree from main.
		writeFileSync(resolve(worktree, "packages/server/types.ts"), "export type WorktreeOnly = 'wt';\n");
		assert.equal(existsSync(resolve(main, "packages/server/types.ts")), false);

		ensureWorktreeDeps(worktree, main);

		// The @pelaggio/server symlink under packages/web resolves
		// to the worktree's source — readable via realpathSync.
		const importPath = resolve(worktree, "packages/web/node_modules/@pelaggio/server");
		assert.ok(lstatSync(importPath).isSymbolicLink());
		assert.equal(realpathSync(importPath), realpathSync(resolve(worktree, "packages/server")));
		// The worktree-only marker file is reachable via the symlink path.
		assert.ok(existsSync(join(importPath, "types.ts")));
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
		mkdirSync(join(main, "packages", "pelaggio"), { recursive: true });
		symlinkSync("../packages/pelaggio", join(nm, "pelaggio"), "dir");
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
	it("returns { ranInstall: false, repaired: [] } when main is clean", async () => {
		const main = makeMain();
		const calls: Array<{ cmd: string; cwd: string }> = [];
		const runner = { run: (cmd: string, cwd: string) => calls.push({ cmd, cwd }) };
		const report = await repairMainNodeModules(main, runner);
		assert.equal(report.ranInstall, false);
		assert.deepEqual(report.repaired, []);
		assert.deepEqual(calls, []);
	});

	it("invokes a lifecycle-script-free frozen install in the main repo when corruption is detected", async () => {
		const main = makeMain();
		symlinkSync("../../sibling/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx", join(main, "node_modules", "tsx"), "dir");
		const calls: Array<{ cmd: string; cwd: string }> = [];
		const runner = { run: (cmd: string, cwd: string) => calls.push({ cmd, cwd }) };
		const report = await repairMainNodeModules(main, runner);
		assert.equal(report.ranInstall, true);
		assert.deepEqual(calls, [{ cmd: "pnpm install --frozen-lockfile --ignore-scripts", cwd: main }]);
	});

	it("reports the outbound entries it observed in the repaired list", async () => {
		const main = makeMain();
		symlinkSync("../../sibling/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx", join(main, "node_modules", "tsx"), "dir");
		symlinkSync("../../sibling/node_modules/.pnpm/typescript@6.0.3/node_modules/typescript", join(main, "node_modules", "typescript"), "dir");
		const runner = { run: () => {} };
		const report = await repairMainNodeModules(main, runner);
		assert.equal(report.repaired.length, 2);
		const names = report.repaired.map((r) => r.name).sort();
		assert.deepEqual(names, ["tsx", "typescript"]);
	});

	it("guards the install through the injected lock, keyed on mainRepo's .dev directory", async () => {
		const main = makeMain();
		symlinkSync("../../sibling/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx", join(main, "node_modules", "tsx"), "dir");
		const lockPaths: string[] = [];
		const lock = async <T>(path: string, fn: () => Promise<T> | T) => {
			lockPaths.push(path);
			return fn();
		};
		const runner = { run: () => {} };
		const report = await repairMainNodeModules(main, runner, lock);
		assert.equal(report.ranInstall, true);
		assert.deepEqual(lockPaths, [resolve(main, ".dev", "node-modules-repair.lock")]);
	});

	it("re-checks for outbound symlinks once the lock is held, skipping a redundant install if another holder already repaired", async () => {
		const main = makeMain();
		symlinkSync("../../sibling/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx", join(main, "node_modules", "tsx"), "dir");
		const calls: Array<{ cmd: string; cwd: string }> = [];
		const runner = { run: (cmd: string, cwd: string) => calls.push({ cmd, cwd }) };
		const lock = async <T>(_path: string, fn: () => Promise<T> | T) => {
			unlinkSync(join(main, "node_modules", "tsx")); // simulate another holder's repair completing first
			return fn();
		};
		const report = await repairMainNodeModules(main, runner, lock);
		assert.equal(report.ranInstall, false);
		assert.deepEqual(calls, []);
	});
});

describe("ensureWorktreeDeps main repair", () => {
	it("repairs outbound main symlinks before sharing main node_modules", () => {
		const root = makeSetup({ mainLock: "A", worktreeLock: "A", mainNm: "dir", worktreeNm: null });
		const siblingTarget = "../../sibling/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx";
		symlinkSync(siblingTarget, resolve(root.main, "node_modules", "tsx"), "dir");
		const calls: Array<{ cmd: string; cwd: string }> = [];
		const runner = { run: (cmd: string, cwd: string) => calls.push({ cmd, cwd }) };

		ensureWorktreeDeps(root.worktree, root.main, runner);

		assert.deepEqual(calls, [{ cmd: "pnpm install --frozen-lockfile --ignore-scripts", cwd: root.main }]);
	});
});
