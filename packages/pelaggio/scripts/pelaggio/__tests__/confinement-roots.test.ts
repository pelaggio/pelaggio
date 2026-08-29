import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { createMainCheckoutDeltaObserver, diffForbiddenRootSnapshots, FORBIDDEN_ROOT_GONE, FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS, snapshotForbiddenRoot, snapshotRepoRefState, snapshotSiblingWorktree } from "../confinement/roots.js";

function makeFeatRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pelaggio-helpers-test-"));
	execSync("git init -q -b main", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config commit.gpgsign false", { cwd: dir });
	execSync("git commit --allow-empty -q -m init", { cwd: dir });
	execSync("git checkout -q -b feat/tool-99", { cwd: dir });
	return dir;
}

describe("snapshotForbiddenRoot", () => {
	it("returns the first successful porcelain after transient execution failures", () => {
		const sleeps: number[] = [];
		let calls = 0;
		const status = "?? leaked.txt";
		const result = snapshotForbiddenRoot("/tmp/forbidden-root", {
			attempts: 3,
			retryDelayMs: 25,
			exists: () => true,
			sleepSync: (ms) => {
				sleeps.push(ms);
			},
			run: () => {
				calls++;
				if (calls < 3) throw new Error("index.lock: File exists");
				return status;
			},
		});
		assert.equal(result, status);
		assert.equal(calls, 3);
		assert.deepEqual(sleeps, [25, 25]);
	});

	it("throws with root and underlying message after exhausting attempts", () => {
		const sleeps: number[] = [];
		let calls = 0;
		assert.throws(
			() =>
				snapshotForbiddenRoot("/tmp/broken-root", {
					attempts: FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS,
					retryDelayMs: 10,
					exists: () => true,
					sleepSync: (ms) => {
						sleeps.push(ms);
					},
					run: () => {
						calls++;
						const err = new Error("Command failed: git status");
						(err as Error & { stderr: string }).stderr = "fatal: Unable to create '.git/index.lock': File exists";
						throw err;
					},
				}),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /failed to snapshot forbidden root \/tmp\/broken-root:/);
				assert.match(e.message, /index\.lock/);
				return true;
			},
		);
		assert.equal(calls, FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS);
		assert.equal(sleeps.length, FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS - 1);
	});

	it("does not retry a successful dirty porcelain observation", () => {
		const sleeps: number[] = [];
		let calls = 0;
		const dirty = " M packages/pelaggio/scripts/pelaggio/helpers.ts";
		const result = snapshotForbiddenRoot("/tmp/dirty-root", {
			attempts: 3,
			retryDelayMs: 25,
			exists: () => true,
			sleepSync: (ms) => {
				sleeps.push(ms);
			},
			run: () => {
				calls++;
				return dirty;
			},
		});
		assert.equal(result, dirty);
		assert.equal(calls, 1);
		assert.deepEqual(sleeps, []);
	});

	it("returns the GONE sentinel for an already-absent root without spawning git (#308)", () => {
		let calls = 0;
		const result = snapshotForbiddenRoot("/tmp/orphaned-review-head", {
			exists: () => false,
			run: () => {
				calls++;
				return "";
			},
		});
		assert.equal(result, FORBIDDEN_ROOT_GONE);
		assert.equal(calls, 0, "must not run git status on a known-gone root");
	});

	it("returns GONE when the root disappears mid-step (run fails, absence then confirmed) (#308 TOCTOU)", () => {
		let calls = 0;
		let existsChecks = 0;
		const result = snapshotForbiddenRoot("/tmp/removed-mid-step", {
			attempts: 3,
			exists: () => existsChecks++ === 0, // present at the pre-check, gone once the run has failed
			sleepSync: () => {},
			run: () => {
				calls++;
				throw new Error("spawnSync /bin/sh ENOENT");
			},
		});
		assert.equal(result, FORBIDDEN_ROOT_GONE);
		assert.equal(calls, 1, "confirmed absence short-circuits the retry loop");
	});

	it("fails closed on a real error while the root still exists (missing git, not absence) (#308)", () => {
		let calls = 0;
		assert.throws(
			() =>
				snapshotForbiddenRoot("/tmp/present-but-broken", {
					attempts: 2,
					exists: () => true, // root is present the whole time — a real failure, not GONE
					sleepSync: () => {},
					run: () => {
						calls++;
						throw new Error("spawnSync git ENOENT");
					},
				}),
			/failed to snapshot forbidden root \/tmp\/present-but-broken/,
		);
		assert.equal(calls, 2, "a present root exhausts the retry budget then throws");
	});

	it("returns GONE for a present non-Git directory shell (diagnostic ∧ no .git) without retry (#339)", () => {
		const root = "/tmp/directory-shell-root";
		const sleeps: number[] = [];
		let calls = 0;
		const result = snapshotForbiddenRoot(root, {
			attempts: 3,
			retryDelayMs: 25,
			exists: (p) => p === root, // root present; <root>/.git absent
			sleepSync: (ms) => {
				sleeps.push(ms);
			},
			run: () => {
				calls++;
				const err = new Error("Command failed: git status");
				(err as Error & { stderr: string }).stderr = "fatal: not a git repository (or any of the parent directories): .git";
				throw err;
			},
		});
		assert.equal(result, FORBIDDEN_ROOT_GONE);
		assert.equal(calls, 1, "directory shell short-circuits without retry");
		assert.deepEqual(sleeps, []);
	});

	it("returns GONE for a real plain directory via the default Git runner (#339)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-non-git-shell-"));
		// Plain directory, no .git — production-shaped residual worktree shell.
		assert.equal(existsSync(join(dir, ".git")), false);
		const result = snapshotForbiddenRoot(dir);
		assert.equal(result, FORBIDDEN_ROOT_GONE);
	});

	it("fails closed when the non-repo diagnostic matches but .git is still present (#339 permission collision)", () => {
		const root = "/tmp/unreadable-git-root";
		const sleeps: number[] = [];
		let calls = 0;
		assert.throws(
			() =>
				snapshotForbiddenRoot(root, {
					attempts: FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS,
					retryDelayMs: 10,
					// Root and .git both present — unreadable .git still existsSync as true.
					exists: () => true,
					sleepSync: (ms) => {
						sleeps.push(ms);
					},
					run: () => {
						calls++;
						const err = new Error("Command failed: git status");
						(err as Error & { stderr: string }).stderr = "fatal: not a git repository (or any of the parent directories): .git";
						throw err;
					},
				}),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /failed to snapshot forbidden root \/tmp\/unreadable-git-root:/);
				assert.match(e.message, /fatal: not a git repository/);
				return true;
			},
		);
		assert.equal(calls, FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS);
		assert.equal(sleeps.length, FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS - 1);
	});

	it("fails closed on a nonmatching Git fatal while the root is present (#339)", () => {
		let calls = 0;
		const sleeps: number[] = [];
		assert.throws(
			() =>
				snapshotForbiddenRoot("/tmp/corrupt-index-root", {
					attempts: 2,
					retryDelayMs: 10,
					exists: () => true,
					sleepSync: (ms) => {
						sleeps.push(ms);
					},
					run: () => {
						calls++;
						const err = new Error("Command failed: git status");
						(err as Error & { stderr: string }).stderr = "fatal: .git/index: index file smaller than expected";
						throw err;
					},
				}),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /failed to snapshot forbidden root \/tmp\/corrupt-index-root:/);
				assert.match(e.message, /index file smaller than expected/);
				return true;
			},
		);
		assert.equal(calls, 2);
		assert.equal(sleeps.length, 1);
	});
});

describe("diffForbiddenRootSnapshots (#308 GONE-aware)", () => {
	const gone = FORBIDDEN_ROOT_GONE;
	it("flags a present→present root whose porcelain changed (clean→dirty)", () => {
		const before = new Map([["/wt", ""]]);
		const after = new Map([["/wt", "?? leaked.txt"]]);
		assert.deepEqual(diffForbiddenRootSnapshots(before, after), ["/wt"]);
	});
	it("does not flag an unchanged present→present root (dirty→dirty)", () => {
		const before = new Map([["/wt", " M x"]]);
		const after = new Map([["/wt", " M x"]]);
		assert.deepEqual(diffForbiddenRootSnapshots(before, after), []);
	});
	it("passes GONE→GONE (already-gone orphan — the live review-head case)", () => {
		assert.deepEqual(diffForbiddenRootSnapshots(new Map([["/wt", gone]]), new Map([["/wt", gone]])), []);
	});
	it("passes present→GONE without a false positive (removed mid-step, incl. dirty→gone)", () => {
		assert.deepEqual(diffForbiddenRootSnapshots(new Map([["/wt", " M x"]]), new Map([["/wt", gone]])), []);
	});
	it("passes GONE→present (root appeared mid-step — cannot be this step's mutation)", () => {
		assert.deepEqual(diffForbiddenRootSnapshots(new Map([["/wt", gone]]), new Map([["/wt", ""]])), []);
	});
});

describe("snapshotRepoRefState / snapshotSiblingWorktree (#510 round-2)", () => {
	it("detects a clean-to-clean --allow-empty commit that porcelain cannot see", () => {
		const dir = makeFeatRepo();
		const porcelainBefore = snapshotForbiddenRoot(dir);
		const refsBefore = snapshotRepoRefState(dir);
		execSync("git commit --allow-empty -q -m sneaky", { cwd: dir });
		assert.equal(snapshotForbiddenRoot(dir), porcelainBefore, "porcelain is blind to the empty commit");
		assert.notEqual(snapshotRepoRefState(dir), refsBefore, "ref-state digest sees the HEAD move");
	});

	it("detects a bare ref move (branch created without touching the working tree)", () => {
		const dir = makeFeatRepo();
		const before = snapshotRepoRefState(dir);
		execSync("git branch forged-branch", { cwd: dir });
		assert.notEqual(snapshotRepoRefState(dir), before);
	});

	it("throws on a non-repository root (callers fail closed)", () => {
		assert.throws(() => snapshotRepoRefState(mkdtempSync(join(tmpdir(), "pelaggio-refstate-notrepo-"))));
	});

	it("sibling snapshot combines porcelain and HEAD, and returns GONE for an absent root", () => {
		const dir = makeFeatRepo();
		const before = snapshotSiblingWorktree(dir);
		assert.match(before, /\n@[0-9a-f]{40}$/);
		writeFileSync(join(dir, "leaked.txt"), "x");
		const dirty = snapshotSiblingWorktree(dir);
		assert.notEqual(dirty, before, "working-tree write changes the snapshot");
		execSync("git add -A && git commit -q -m leak", { cwd: dir });
		// Porcelain is clean again (as before the write) but HEAD moved — clean-to-clean commits differ.
		assert.notEqual(snapshotSiblingWorktree(dir), before, "commit moves HEAD even once porcelain is clean again");
		assert.equal(snapshotSiblingWorktree(join(tmpdir(), "does-not-exist-pelaggio-510")), FORBIDDEN_ROOT_GONE);
	});
});

describe("createMainCheckoutDeltaObserver", () => {
	it("tolerates unchanged clean and pre-existing dirty baselines", () => {
		const dir = makeFeatRepo();
		writeFileSync(join(dir, "operator.txt"), "existing");
		const observer = createMainCheckoutDeltaObserver(dir);
		assert.deepEqual(observer.beforeTool("one"), { kind: "clean" });
		assert.deepEqual(observer.afterTool("one"), { kind: "clean" });
		assert.deepEqual(observer.finish(), { kind: "clean" });
	});

	it("retains a main delta after a later clean tool window", () => {
		const dir = makeFeatRepo();
		const observer = createMainCheckoutDeltaObserver(dir);
		observer.beforeTool("write");
		writeFileSync(join(dir, "escaped.txt"), "x");
		assert.deepEqual(observer.afterTool("write"), { kind: "violation", roots: [resolve(dir)] });
		observer.beforeTool("clean");
		observer.afterTool("clean");
		assert.deepEqual(observer.finish(), { kind: "violation", roots: [resolve(dir)] });
	});

	it("supports overlapping invocation baselines", () => {
		const dir = makeFeatRepo();
		const observer = createMainCheckoutDeltaObserver(dir);
		observer.beforeTool("a");
		observer.beforeTool("b");
		writeFileSync(join(dir, "escaped.txt"), "x");
		observer.afterTool("b");
		observer.afterTool("a");
		assert.equal(observer.finish().kind, "violation");
	});

	it("fails closed for duplicate, missing, open, and unsnapshotable invocations", () => {
		const duplicate = createMainCheckoutDeltaObserver(makeFeatRepo());
		duplicate.beforeTool("same");
		assert.deepEqual(duplicate.beforeTool("same").kind, "error");

		const missing = createMainCheckoutDeltaObserver(makeFeatRepo());
		assert.equal(missing.afterTool("absent").kind, "error");

		const open = createMainCheckoutDeltaObserver(makeFeatRepo());
		open.beforeTool("open");
		const openFinish = open.finish();
		assert.match(openFinish.kind === "error" ? openFinish.message : "", /unclosed/);

		const broken = createMainCheckoutDeltaObserver(join(tmpdir(), "does-not-exist-pelaggio"));
		assert.equal(broken.beforeTool("x").kind, "error");
		assert.deepEqual(broken.finish(), broken.finish(), "finish is idempotent");
	});

	it("fails closed when the main checkout is PRESENT but not a git repository (#339 security guarantee)", () => {
		// A main checkout that exists yet has no `.git` (corrupt/half-removed main) must NEVER be
		// GONE-tolerated the way a peer worktree shell is: it routes through the observer as a
		// fail-closed error. mainRepo is never accepted as FORBIDDEN_ROOT_GONE.
		const notARepo = mkdtempSync(join(tmpdir(), "pelaggio-main-notrepo-"));
		const observer = createMainCheckoutDeltaObserver(notARepo);
		const result = observer.beforeTool("x");
		assert.equal(result.kind, "error");
		assert.match(result.kind === "error" ? result.message : "", /main checkout root vanished/);
	});
});
