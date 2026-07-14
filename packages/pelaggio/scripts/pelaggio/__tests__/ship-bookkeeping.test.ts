import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExecFn, ShipBookkeepingDeps } from "../ship/bookkeeping.js";
import { commitStrayBookkeeping, runShipBookkeeping } from "../ship/bookkeeping.js";

// Records every command the tail issues (plus a "REPAIR" marker) into one
// ordered timeline, so tests can assert both the sequence and never-discard.
function makeExecSpy(opts: { throwOn?: (cmd: string) => boolean } = {}): { order: string[]; exec: ExecFn } {
	const order: string[] = [];
	const exec: ExecFn = (cmd) => {
		order.push(cmd);
		if (opts.throwOn?.(cmd)) throw new Error(`boom: ${cmd}`);
		return "";
	};
	return { order, exec };
}

function makeRoadmapSpy(over: { markDoneThrows?: string; archivePlanThrows?: string } = {}): { calls: { markDone: string[]; archivePlan: string[] }; roadmap: ShipBookkeepingDeps["roadmap"] } {
	const calls = { markDone: [] as string[], archivePlan: [] as string[] };
	return {
		calls,
		roadmap: {
			async markDone(id) {
				calls.markDone.push(id);
				if (over.markDoneThrows) throw new Error(over.markDoneThrows);
			},
			async archivePlan(id) {
				calls.archivePlan.push(id);
				if (over.archivePlanThrows) throw new Error(over.archivePlanThrows);
			},
		},
	};
}

const CTX = { mainRepo: "/main", worktree: "/wt", branch: "feat/tool-9", itemId: "TOOL-9" };
const DISCARD_RE = /checkout|reset --hard|git clean|stash drop/;

describe("runShipBookkeeping — happy path", () => {
	it("recovers(skip when clean) → markDone → archivePlan → push → repair → remove → branch-delete, in order", async () => {
		const { order, exec } = makeExecSpy();
		const { roadmap, calls } = makeRoadmapSpy();
		const result = await runShipBookkeeping(CTX, {
			roadmap,
			log: () => {},
			exec,
			status: () => "", // clean tree
			repairMain: () => {
				order.push("REPAIR");
			},
		});

		assert.deepEqual(result, { recovered: false, markedDone: true, archived: true, pushed: true, cleanedUp: true, ok: true });
		assert.deepEqual(calls.markDone, ["TOOL-9"]);
		assert.deepEqual(calls.archivePlan, ["TOOL-9"]);

		// Clean tree → no recover commit issued.
		assert.ok(!order.some((c) => /git commit/.test(c)), `no recover commit expected; got: ${order.join(" | ")}`);

		const push = order.indexOf("git push origin main");
		const repair = order.indexOf("REPAIR");
		const remove = order.findIndex((c) => /git worktree remove/.test(c));
		const branch = order.findIndex((c) => /git branch -d/.test(c));
		assert.ok(push >= 0 && repair > push && remove > repair && branch > remove, `unexpected order: ${order.join(" | ")}`);

		// Never a discard command.
		assert.ok(!order.some((c) => DISCARD_RE.test(c)), `discard command leaked: ${order.join(" | ")}`);
	});

	it("no-worktree mode (worktree === mainRepo): skips repair + worktree remove, still deletes branch", async () => {
		const { order, exec } = makeExecSpy();
		const { roadmap } = makeRoadmapSpy();
		let repairCalled = false;
		const result = await runShipBookkeeping({ ...CTX, worktree: "/main" }, { roadmap, log: () => {}, exec, status: () => "", repairMain: () => (repairCalled = true) });
		assert.equal(repairCalled, false);
		assert.ok(!order.some((c) => /git worktree remove/.test(c)));
		assert.ok(order.some((c) => /git branch -d/.test(c)));
		assert.equal(result.cleanedUp, true);
	});

	it("cleanedUp reflects reality: push succeeds but `git branch -d` fails → ok:true, cleanedUp:false (finding #8)", async () => {
		const { exec } = makeExecSpy({ throwOn: (c) => /git branch -d/.test(c) });
		const { roadmap } = makeRoadmapSpy();
		const result = await runShipBookkeeping(CTX, { roadmap, log: () => {}, exec, status: () => "", repairMain: () => {} });
		assert.equal(result.ok, true, "push + bookkeeping succeeded — the cycle shipped");
		assert.equal(result.pushed, true);
		assert.equal(result.cleanedUp, false, "cleanedUp must not be hardcoded true when branch deletion failed");
	});
});

describe("runShipBookkeeping — real adapter failures block branch destruction (finding #4)", () => {
	// The markdown adapter now no-ops an already-done item, so a markDone/archive
	// THROW is a genuine failure (format drift, gh/linear auth/network). It must
	// surface (`ok:false`) and stop before cleanup so the branch is not destroyed
	// and the item is not orphaned open forever — NOT swallowed as "already done".
	it("markDone throwing → ok:false, push + cleanup NOT run, branch left intact, no discard", async () => {
		const { order, exec } = makeExecSpy();
		const { roadmap, calls } = makeRoadmapSpy({ markDoneThrows: "could not locate open row for TOOL-9" });
		const result = await runShipBookkeeping(CTX, { roadmap, log: () => {}, exec, status: () => "", repairMain: () => {} });

		assert.equal(result.ok, false);
		assert.equal(result.markedDone, false);
		assert.equal(result.archived, false);
		assert.equal(result.pushed, false);
		assert.equal(result.cleanedUp, false);
		assert.match(result.error ?? "", /mark-done failed/);
		assert.deepEqual(calls.archivePlan, [], "archive must not run once markDone fails");
		assert.ok(!order.some((c) => c === "git push origin main"), "must not push after a real markDone failure");
		assert.ok(!order.some((c) => /git worktree remove|git branch -d/.test(c)), "must NOT destroy the branch");
		assert.ok(!order.some((c) => DISCARD_RE.test(c)), `discard command leaked: ${order.join(" | ")}`);
	});

	it("archivePlan throwing → ok:false (markedDone already committed), push + cleanup NOT run", async () => {
		const { order, exec } = makeExecSpy();
		const { roadmap } = makeRoadmapSpy({ archivePlanThrows: "git mv failed: dest exists" });
		const result = await runShipBookkeeping(CTX, { roadmap, log: () => {}, exec, status: () => "", repairMain: () => {} });

		assert.equal(result.ok, false);
		assert.equal(result.markedDone, true);
		assert.equal(result.archived, false);
		assert.equal(result.pushed, false);
		assert.equal(result.cleanedUp, false);
		assert.match(result.error ?? "", /archive-plan failed/);
		assert.ok(!order.some((c) => /git worktree remove|git branch -d/.test(c)), "must NOT destroy the branch");
	});
});

describe("runShipBookkeeping — never-discard", () => {
	it("dirty MAIN_REPO → `git add -A && git reset -- .dev` then a `git commit … --no-verify` is issued, no discard command ever emitted", async () => {
		const { order, exec } = makeExecSpy();
		const { roadmap } = makeRoadmapSpy();
		const result = await runShipBookkeeping(CTX, {
			roadmap,
			log: () => {},
			exec: (cmd, cwd) => (cmd === "git diff --cached --name-only" ? "docs/deferred.md" : exec(cmd, cwd)),
			status: () => "M docs/roadmap-core.md\n?? docs/deferred.md", // dirty
			repairMain: () => {},
			lock: async <T>(_repo: string, fn: () => Promise<T> | T): Promise<T> => await fn(),
		});

		assert.equal(result.recovered, true);
		assert.ok(order.includes("git add -A && git reset -- .dev"), `expected 'git add -A && git reset -- .dev'; got: ${order.join(" | ")}`);
		assert.ok(
			order.some((c) => /^git commit -m .*--no-verify$/.test(c)),
			`expected a recover commit; got: ${order.join(" | ")}`,
		);
		assert.ok(!order.some((c) => /:\(exclude\)/.test(c)), `pathspec exclude must not be used; got: ${order.join(" | ")}`);
		assert.ok(!order.some((c) => DISCARD_RE.test(c)), `discard command leaked: ${order.join(" | ")}`);
	});
});

describe("runShipBookkeeping — push failure blocks cleanup (finding #3)", () => {
	it("push rejected → pull + one retry; persistent failure → pushed:false, ok:false, branch NOT destroyed", async () => {
		const { order, exec } = makeExecSpy({ throwOn: (c) => c === "git push origin main" });
		const { roadmap } = makeRoadmapSpy();
		const result = await runShipBookkeeping(CTX, { roadmap, log: () => {}, exec, status: () => "", repairMain: () => {} });

		assert.equal(result.pushed, false);
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /push failed/);
		assert.ok(order.includes("git pull --no-rebase origin main"), "a pull retry must be attempted");
		assert.equal(order.filter((c) => c === "git push origin main").length, 2, "push attempted twice (initial + retry)");
		// Cleanup gated on a successful push — the branch holds recoverable work.
		assert.ok(!order.some((c) => /git worktree remove/.test(c)), "worktree must not be removed on push failure");
		assert.ok(!order.some((c) => /git branch -d/.test(c)), "branch must not be deleted on push failure");
	});
});

describe("runShipBookkeeping — pull conflict aborts, no cleanup (finding #2)", () => {
	it("push rejected then pull conflicts → `git merge --abort`, ok:false with a distinct conflict error, no cleanup", async () => {
		const { order, exec } = makeExecSpy({
			throwOn: (c) => c === "git push origin main" || c === "git pull --no-rebase origin main",
		});
		const { roadmap } = makeRoadmapSpy();
		const result = await runShipBookkeeping(CTX, { roadmap, log: () => {}, exec, status: () => "", repairMain: () => {} });

		assert.equal(result.ok, false);
		assert.equal(result.pushed, false);
		assert.match(result.error ?? "", /conflict/i);
		assert.ok(order.includes("git merge --abort"), "a conflicted pull must be aborted");
		// Only the initial push was attempted — no blind retry over a conflicted tree.
		assert.equal(order.filter((c) => c === "git push origin main").length, 1, "no retry push over a conflicted tree");
		assert.ok(!order.some((c) => /git worktree remove|git branch -d/.test(c)), "must NOT clean up over a conflicted tree");
	});

	it("push rejected, pull clean, but post-pull verify fails → ok:false, no retry push, no cleanup", async () => {
		const { order, exec } = makeExecSpy({ throwOn: (c) => c === "git push origin main" });
		const { roadmap } = makeRoadmapSpy();
		let verifyCalls = 0;
		const result = await runShipBookkeeping(CTX, {
			roadmap,
			log: () => {},
			exec,
			status: () => "",
			repairMain: () => {},
			verify: () => {
				verifyCalls++;
				return false; // integrated origin/main does not pass verification
			},
		});

		assert.equal(verifyCalls, 1, "verify must run after the pull, before the retry push");
		assert.equal(result.ok, false);
		assert.equal(result.pushed, false);
		assert.match(result.error ?? "", /verification/i);
		assert.ok(order.includes("git pull --no-rebase origin main"));
		assert.equal(order.filter((c) => c === "git push origin main").length, 1, "must not push an unverified auto-merge");
		assert.ok(!order.some((c) => /git worktree remove|git branch -d/.test(c)), "no cleanup when verify fails");
	});
});

describe("commitStrayBookkeeping — real temp repo", () => {
	function seedRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-bookkeeping-test-"));
		execSync("git init -q -b main", { cwd: dir });
		execSync("git config user.name t", { cwd: dir });
		execSync("git config user.email t@t", { cwd: dir });
		execSync("git config commit.gpgsign false", { cwd: dir });
		execSync("git commit --allow-empty -q -m init", { cwd: dir });
		return dir;
	}

	it("dirty tree → commit created, status clean after, file content preserved (not discarded)", async () => {
		const dir = seedRepo();
		writeFileSync(join(dir, "deferred.md"), "keep me — a deferred create-item");
		const logs: string[] = [];
		const recovered = await commitStrayBookkeeping(dir, "TOOL-9", (m) => logs.push(m));

		assert.equal(recovered, true);
		assert.equal(execSync("git status --porcelain", { cwd: dir, encoding: "utf-8" }).trim(), "", "tree must be clean after recover");
		assert.equal(readFileSync(join(dir, "deferred.md"), "utf-8"), "keep me — a deferred create-item", "content must be preserved");
		assert.match(execSync("git log -1 --format=%s", { cwd: dir, encoding: "utf-8" }).trim(), /recover uncommitted bookkeeping \(TOOL-9\)/);
	});

	it("clean tree → no commit, returns false", async () => {
		const dir = seedRepo();
		const before = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
		const recovered = await commitStrayBookkeeping(dir, "TOOL-9", () => {});
		assert.equal(recovered, false);
		assert.equal(execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim(), before, "no new commit on a clean tree");
	});

	// Regression for #185: `git add -A -- . ':(exclude).dev'` aborted with
	// "paths are ignored by one of your .gitignore files" whenever a gitignored
	// dir/file (e.g. `.dev`, a stray ignored file) was present alongside a real
	// change — the whole recover-commit was skipped and the real change stayed
	// staged-but-uncommitted.
	it("gitignored dir + stray untracked ignored file present alongside a real change → commit created, ignored paths never staged (#185)", async () => {
		const dir = seedRepo();
		writeFileSync(join(dir, ".gitignore"), ".dev/\nh\n");
		execSync("git add .gitignore && git commit -q -m gitignore", { cwd: dir });
		mkdirSync(join(dir, ".dev"));
		writeFileSync(join(dir, ".dev", "cache.json"), "cached state");
		writeFileSync(join(dir, "h"), "stray ignored file");
		writeFileSync(join(dir, "deferred.md"), "keep me — a deferred create-item");
		const logs: string[] = [];

		const recovered = await commitStrayBookkeeping(dir, "TOOL-9", (m) => logs.push(m));

		assert.equal(recovered, true, `expected a recover commit; logs: ${logs.join(" | ")}`);
		assert.equal(readFileSync(join(dir, "deferred.md"), "utf-8"), "keep me — a deferred create-item");
		const committed = execSync("git show --stat --format= HEAD", { cwd: dir, encoding: "utf-8" });
		assert.match(committed, /deferred\.md/);
		assert.ok(!committed.includes(".dev"), `ignored dir must not be committed; got: ${committed}`);
		assert.ok(!/(^|\s)h(\s|$)/.test(committed), `ignored file must not be committed; got: ${committed}`);
		// Ignored paths remain on disk, untouched — still there, still ignored.
		assert.equal(readFileSync(join(dir, ".dev", "cache.json"), "utf-8"), "cached state");
		assert.equal(readFileSync(join(dir, "h"), "utf-8"), "stray ignored file");
	});

	it("only gitignored paths dirty (no real change) → skips cleanly, returns false, no error, ignored paths untouched", async () => {
		const dir = seedRepo();
		writeFileSync(join(dir, ".gitignore"), ".dev/\nh\n");
		execSync("git add .gitignore && git commit -q -m gitignore", { cwd: dir });
		mkdirSync(join(dir, ".dev"));
		writeFileSync(join(dir, ".dev", "cache.json"), "cached state");
		writeFileSync(join(dir, "h"), "stray ignored file");
		const before = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
		const logs: string[] = [];

		const recovered = await commitStrayBookkeeping(dir, "TOOL-9", (m) => logs.push(m));

		assert.equal(recovered, false);
		assert.equal(execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim(), before, "no new commit when only ignored paths are dirty");
		assert.ok(!logs.some((m) => /failed/i.test(m)), `must skip cleanly, not error; logs: ${logs.join(" | ")}`);
		assert.equal(readFileSync(join(dir, ".dev", "cache.json"), "utf-8"), "cached state");
		assert.equal(readFileSync(join(dir, "h"), "utf-8"), "stray ignored file");
	});
});
