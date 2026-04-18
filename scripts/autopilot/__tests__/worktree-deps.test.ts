import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { decideDepsAction, ensureWorktreeDeps } from "../worktree-deps.js";

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
