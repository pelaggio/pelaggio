import assert from "node:assert/strict";
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
		const gh: GhRunner = () => ({ stdout: JSON.stringify([{ number: 9, mergeCommit: { oid: "abc" } }]), stderr: "", status: 0 });
		assert.deepEqual(confirmLanding(gh, "o/r", "feat/issue-9", "origin/main", { isAncestor: () => true }), { state: "landed", prNumber: 9 });
		assert.deepEqual(confirmLanding(gh, "o/r", "feat/issue-9", "origin/main", { isAncestor: () => false }), { state: "stale-ref", prNumber: 9 });
		assert.deepEqual(
			confirmLanding(() => ({ stdout: "nope", stderr: "", status: 0 }), "o/r", "feat/issue-9", "origin/main"),
			{ state: "unknown", prNumber: null },
		);
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
					return { stdout: "", stderr: "", status: 0 };
				},
			},
		);
		assert.equal(result.branchDeleted, true);
		assert.deepEqual(calls, ["mark", "archive", "worktree prune", "branch -D feat/issue-9", "push origin --delete feat/issue-9"]);
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
});
