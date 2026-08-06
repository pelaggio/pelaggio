import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { confirmLanding, enumerateReapCandidates, reapItem, reconcileMutationLockPath, shouldReap } from "../reap-sweep.js";
import type { GhRunner } from "../roadmap/github-issues.js";

describe("reap sweep", () => {
	it("gates every destructive precondition", () => {
		const base = { enabled: true, shipIsPr: true, ghRepo: "o/r", noWorktree: false, dryRun: false };
		assert.equal(shouldReap(base), true);
		assert.equal(shouldReap({ ...base, enabled: false }), false);
		assert.equal(shouldReap({ ...base, shipIsPr: false }), false);
		assert.equal(shouldReap({ ...base, ghRepo: "" }), false);
		assert.equal(shouldReap({ ...base, noWorktree: true }), false);
		assert.equal(shouldReap({ ...base, dryRun: true }), false);
	});

	it("unions strict feature branches and worktrees", () => {
		const git = (args: string[]) => ({
			status: 0,
			stderr: "",
			stdout: args[0] === "worktree" ? "worktree /w/12\nbranch refs/heads/feat/issue-12-name\n\nworktree /w/nope\nbranch refs/heads/feat/freeform\n" : "feat/issue-12-name\nfeat/issue-34\nfeat/freeform\n",
		});
		assert.deepEqual(enumerateReapCandidates("/main", { git }), [
			{ itemId: "12", branch: "feat/issue-12-name", worktree: "/w/12" },
			{ itemId: "34", branch: "feat/issue-34", worktree: null },
		]);
	});

	it("requires merged forge state and ancestry", () => {
		const gh: GhRunner = () => ({ stdout: JSON.stringify([{ number: 9, mergeCommit: { oid: "abc" }, headRefOid: "head" }]), stderr: "", status: 0 });
		assert.deepEqual(confirmLanding(gh, "o/r", "/main", "feat/issue-9", "origin/main", { branchTip: () => "head", isAncestor: () => true }), { state: "landed", prNumber: 9 });
		assert.deepEqual(confirmLanding(gh, "o/r", "/main", "feat/issue-9", "origin/main", { branchTip: () => "head", isAncestor: () => false }), { state: "stale-ref", prNumber: 9 });
		assert.deepEqual(
			confirmLanding(() => ({ stdout: "nope", stderr: "", status: 0 }), "o/r", "/main", "feat/issue-9", "origin/main", { branchTip: () => "head" }),
			{ state: "unknown", prNumber: null },
		);
	});

	it("refuses a historical merged PR when the current branch tip differs", () => {
		const gh: GhRunner = () => ({ stdout: JSON.stringify([{ number: 9, mergeCommit: { oid: "abc" }, headRefOid: "old-head" }]), stderr: "", status: 0 });
		assert.deepEqual(confirmLanding(gh, "o/r", "/main", "feat/issue-9", "origin/main", { branchTip: () => "new-head", isAncestor: () => true }), { state: "not-merged", prNumber: null });
	});

	it("fails closed before the forge read when the local branch tip is unavailable", () => {
		let ghCalled = false;
		const gh: GhRunner = () => {
			ghCalled = true;
			return { stdout: "[]", stderr: "", status: 0 };
		};
		assert.deepEqual(confirmLanding(gh, "o/r", "/main", "feat/issue-9", "origin/main", { branchTip: () => null }), { state: "unknown", prNumber: null });
		assert.equal(ghCalled, false);
	});

	it("uses the shared lock path", () => {
		assert.equal(reconcileMutationLockPath("/repo"), "/repo/.dev/reconcile-mutation.lock");
	});

	it("deletes a branch only after mark-done succeeds", async () => {
		const calls: string[] = [];
		const roadmap = {
			async getItem() {
				return { id: "9", title: "x", deps: "", sourceRef: "9", status: "open" as const };
			},
			async markDone() {
				calls.push("mark");
			},
			async archivePlan() {
				calls.push("archive");
			},
		};
		const result = await reapItem(
			{ itemId: "9", branch: "feat/issue-9", worktree: null },
			{
				roadmap,
				mainRepo: "/repo",
				prNumber: 4,
				git: (args) => {
					calls.push(args.join(" "));
					// rev-parse supplies the merged tip the remote delete is leased against.
					return { stdout: args[0] === "rev-parse" ? "abc123" : "", stderr: "", status: 0 };
				},
			},
		);
		assert.equal(result.branchDeleted, true);
		assert.deepEqual(calls, [
			"mark",
			"archive",
			"worktree prune",
			"rev-parse --verify refs/heads/feat/issue-9^{commit}",
			"branch -D feat/issue-9",
			// Remote deletion is leased to the merged tip, never unconditional.
			"push origin --force-with-lease=refs/heads/feat/issue-9:abc123 :refs/heads/feat/issue-9",
		]);
	});

	// A remote that moved after landing is not the branch we confirmed merged. The lease must fail
	// the push and the branch must survive with a warning — deleting blind is irreversible data loss.
	it("retains the remote branch when the lease fails (remote advanced since landing)", async () => {
		const calls: string[] = [];
		const result = await reapItem(
			{ itemId: "9", branch: "feat/issue-9", worktree: null },
			{
				roadmap: {
					async getItem() {
						return { id: "9", title: "x", deps: "", sourceRef: "9", status: "open" as const };
					},
					async markDone() {},
					async archivePlan() {},
				},
				mainRepo: "/repo",
				prNumber: 4,
				git: (args) => {
					calls.push(args.join(" "));
					if (args[0] === "rev-parse") return { stdout: "abc123", stderr: "", status: 0 };
					// Simulate git rejecting the push because the remote ref no longer matches the lease.
					if (args[0] === "push") return { stdout: "", stderr: "stale info", status: 1 };
					return { stdout: "", stderr: "", status: 0 };
				},
			},
		);
		assert.ok(
			calls.some((c) => c.startsWith("push origin --force-with-lease=")),
			"deletion is attempted under a lease",
		);
		assert.ok(
			result.warnings.some((w) => w.includes("remote branch retained")),
			"a failed lease is surfaced as a retained remote branch, not swallowed",
		);
	});

	it("retains the claim branch when mark-done fails", async () => {
		const gitCalls: string[][] = [];
		const result = await reapItem(
			{ itemId: "9", branch: "feat/issue-9", worktree: null },
			{
				roadmap: {
					async getItem() {
						return { id: "9", title: "x", deps: "", sourceRef: "9", status: "open" as const };
					},
					async markDone() {
						throw new Error("offline");
					},
					async archivePlan() {},
				},
				mainRepo: "/repo",
				prNumber: 4,
				git: (args) => {
					gitCalls.push(args);
					return { stdout: "", stderr: "", status: 0 };
				},
			},
		);
		assert.equal(result.branchDeleted, false);
		assert.equal(
			gitCalls.some((args) => args[0] === "branch"),
			false,
		);
	});

	it("clears only the exact item resume log", async () => {
		const mainRepo = mkdtempSync(resolve(tmpdir(), "pelaggio-reap-residue-"));
		try {
			const dev = resolve(mainRepo, ".dev");
			mkdirSync(dev);
			const itemLog = resolve(dev, "pelaggio-resume-9.log");
			const siblingLog = resolve(dev, "pelaggio-resume-90.log");
			writeFileSync(itemLog, "item 9");
			writeFileSync(siblingLog, "item 90");
			await reapItem(
				{ itemId: "9", branch: "feat/issue-9", worktree: null },
				{
					roadmap: {
						async getItem() {
							return { id: "9", title: "x", deps: "", sourceRef: "9", status: "done" as const };
						},
						async markDone() {},
						async archivePlan() {},
					},
					mainRepo,
					prNumber: 4,
					git: () => ({ stdout: "", stderr: "", status: 0 }),
				},
			);
			assert.equal(existsSync(itemLog), false);
			assert.equal(existsSync(siblingLog), true);
		} finally {
			rmSync(mainRepo, { recursive: true, force: true });
		}
	});
});
