import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { decideDepsAction, ensureWorktreeDeps, findOutboundMainSymlinks, repairMainNodeModules } from "../worktree-deps.js";

interface Setup {
	main: string;
	worktree: string;
}

function makeSetup(opts: { mainLock?: string | null; worktreeLock?: string | null; mainNm?: "dir" | null; worktreeNm?: "dir" | "symlink-to-main" | null }): Setup {
	const root = mkdtempSync(join(tmpdir(), "worktree-deps-test-"));
	const main = resolve(root, "main");
	const worktree = resolve(root, "worktree");
	mkdirSync(main, { recursive: true });
	mkdirSync(worktree, { recursive: true });

	if (opts.mainLock !== null && opts.mainLock !== undefined) {
		writeFileSync(resolve(main, "pnpm-lock.yaml"), opts.mainLock);
	}
	if (opts.worktreeLock !== null && opts.worktreeLock !== undefined) {
		writeFileSync(resolve(worktree, "pnpm-lock.yaml"), opts.worktreeLock);
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
});

describe("ensureWorktreeDeps", () => {
	it("creates a symlink on the link action (happy path, no pnpm invoked)", () => {
		const { main, worktree } = makeSetup({
			mainLock: "A",
			worktreeLock: "A",
			mainNm: "dir",
			worktreeNm: null,
		});
		const action = ensureWorktreeDeps(worktree, main);
		assert.equal(action.type, "link");
		const link = resolve(worktree, "node_modules");
		assert.ok(lstatSync(link).isSymbolicLink(), "node_modules should be a symlink");
		assert.equal(readlinkSync(link), resolve(main, "node_modules"));
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
