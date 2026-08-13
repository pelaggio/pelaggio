import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cleanupReviewHead, findReviewCandidates, LOCAL_MODE_MARKER, postLocalModeWorkflowComment, postReviewStatus, prepareReviewHead, reviewStatusForSha, upsertReviewComment } from "../review-sweep.js";
import type { GhRunner } from "../roadmap/github-issues.js";

function stub(fn?: (args: string[]) => { stdout?: string; stderr?: string; status?: number }): { run: GhRunner; calls: string[][] } {
	const calls: string[][] = [];
	const run: GhRunner = (args) => {
		calls.push(args);
		const r = fn?.(args) ?? {};
		return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 0 };
	};
	return { run, calls };
}

describe("reviewStatusForSha", () => {
	it("returns done for a terminal review status, pending for pending, missing otherwise", () => {
		const done = stub(() => ({ stdout: JSON.stringify({ statuses: [{ context: "review", state: "success" }] }) }));
		assert.equal(reviewStatusForSha(done.run, "o/r", "sha1"), "done");
		assert.deepEqual(done.calls[0], ["api", "repos/o/r/commits/sha1/status"]);

		const pending = stub(() => ({ stdout: JSON.stringify({ statuses: [{ context: "review", state: "pending" }] }) }));
		assert.equal(reviewStatusForSha(pending.run, "o/r", "sha1"), "pending");

		const other = stub(() => ({ stdout: JSON.stringify({ statuses: [{ context: "ci", state: "success" }] }) }));
		assert.equal(reviewStatusForSha(other.run, "o/r", "sha1"), "missing");
	});

	it("fails soft to missing on a probe error or unparsable output (re-run, never drop)", () => {
		const failed = stub(() => ({ status: 1, stderr: "boom" }));
		assert.equal(reviewStatusForSha(failed.run, "o/r", "sha1"), "missing");
		const garbage = stub(() => ({ stdout: "not json" }));
		assert.equal(reviewStatusForSha(garbage.run, "o/r", "sha1"), "missing");
	});
});

describe("findReviewCandidates", () => {
	it("selects same-repo non-draft feat PRs with missing or pending local review status", () => {
		const prs = [
			{ number: 1, isDraft: false, headRefName: "feat/issue-84-local", headRefOid: "sha1", headRepository: { nameWithOwner: "o/r" }, updatedAt: "2026-07-08T10:00:00Z", statusCheckRollup: [] },
			{
				number: 2,
				isDraft: false,
				headRefName: "feat/issue-85-pending",
				headRefOid: "sha2",
				headRepository: { nameWithOwner: "o/r" },
				updatedAt: "2026-07-08T10:00:00Z",
				statusCheckRollup: [{ __typename: "StatusContext", context: "review", state: "PENDING", startedAt: "2026-07-08T11:00:00Z" }],
			},
			{ number: 3, isDraft: false, headRefName: "feat/issue-86-done", headRefOid: "sha3", headRepository: { nameWithOwner: "o/r" }, statusCheckRollup: [{ __typename: "StatusContext", context: "review", state: "SUCCESS" }] },
			{ number: 4, isDraft: false, headRefName: "feat/issue-87-fork", headRefOid: "sha4", headRepository: { nameWithOwner: "fork/r" }, statusCheckRollup: [] },
			{ number: 5, isDraft: true, headRefName: "feat/issue-88-draft", headRefOid: "sha5", headRepository: { nameWithOwner: "o/r" }, statusCheckRollup: [] },
		];
		const { run } = stub(() => ({ stdout: JSON.stringify(prs) }));
		const out = findReviewCandidates(run, "o/r", Date.parse("2026-07-08T13:00:00Z"), 2 * 60 * 60 * 1000);
		assert.deepEqual(out.candidates, [
			{ prNumber: 1, itemId: "84", branch: "feat/issue-84-local", headSha: "sha1", statusState: "missing", statusStartedAt: "2026-07-08T10:00:00Z" },
			{ prNumber: 2, itemId: "85", branch: "feat/issue-85-pending", headSha: "sha2", statusState: "pending", statusStartedAt: "2026-07-08T11:00:00Z" },
		]);
		assert.deepEqual(out.stranded, [{ prNumber: 1, itemId: "84", branch: "feat/issue-84-local", headSha: "sha1", statusState: "missing", statusStartedAt: "2026-07-08T10:00:00Z" }]);
	});

	it("ignores same-named CheckRun entries in local mode", () => {
		const prs = [{ number: 7, isDraft: false, headRefName: "feat/issue-7-x", headRefOid: "sha", headRepository: { nameWithOwner: "o/r" }, statusCheckRollup: [{ __typename: "CheckRun", name: "review", conclusion: "SUCCESS" }] }];
		const { run } = stub(() => ({ stdout: JSON.stringify(prs) }));
		assert.equal(findReviewCandidates(run, "o/r", Date.now(), 1).candidates.length, 1);
	});
});

describe("review status and comments", () => {
	it("posts commit statuses with context review", () => {
		const { run, calls } = stub();
		assert.equal(postReviewStatus(run, "o/r", "abc", "pending", "local review running"), true);
		assert.deepEqual(calls[0], ["api", "repos/o/r/statuses/abc", "-f", "state=pending", "-f", "context=review", "-f", "description=local review running"]);
	});

	it("upserts the marker-bearing findings comment by REST id", () => {
		const { run, calls } = stub((args) => (args[1] === "repos/o/r/issues/9/comments" ? { stdout: JSON.stringify([{ id: 42, body: "<!-- pelaggio-pr-review -->\nold", created_at: "2026-01-01T00:00:00Z" }]) } : {}));
		assert.equal(upsertReviewComment(run, "o/r", 9, "<!-- pelaggio-pr-review -->\nnew"), true);
		assert.deepEqual(calls[1], ["api", "--method", "PATCH", "repos/o/r/issues/comments/42", "-f", "body=<!-- pelaggio-pr-review -->\nnew"]);
	});

	it("posts local-mode diagnostic at most once", () => {
		const { run, calls } = stub((args) => (args[1] === "repos/o/r/issues/9/comments" ? { stdout: JSON.stringify([]) } : {}));
		assert.equal(postLocalModeWorkflowComment(run, "o/r", 9), true);
		assert.ok(calls[1].some((arg) => arg.includes(LOCAL_MODE_MARKER)));

		const { run: run2, calls: calls2 } = stub(() => ({ stdout: JSON.stringify([{ id: 1, body: LOCAL_MODE_MARKER, created_at: "2026-01-01T00:00:00Z" }]) }));
		assert.equal(postLocalModeWorkflowComment(run2, "o/r", 9), true);
		assert.equal(calls2.length, 1);
	});
});

describe("prepareReviewHead", () => {
	it("fetches the PR head and creates a detached data worktree", () => {
		const repo = mkdtempSync(join(tmpdir(), "review-head-"));
		const cmds: string[] = [];
		const out = prepareReviewHead(repo, { prNumber: 9, itemId: "84", branch: "feat/issue-84-x", headSha: "abc123", statusState: "missing" }, (cmd) => {
			cmds.push(cmd);
			// The fetched ref must resolve to the candidate SHA (the OID-match guard).
			if (cmd.startsWith("git rev-parse")) return "abc123\n";
			return "";
		});
		assert.deepEqual(out, { diffCwd: join(repo, ".dev", "review-heads", "abc123"), baseRef: "origin/main", headRef: "refs/pelaggio-review/pr-9" });
		assert.ok(cmds.includes("git fetch origin refs/pull/9/head:refs/pelaggio-review/pr-9"));
		assert.ok(cmds.includes(`git worktree add --detach ${join(repo, ".dev", "review-heads", "abc123")} abc123`));
		rmSync(repo, { recursive: true, force: true });
	});

	it("bails without a worktree when the fetched head no longer matches the candidate SHA (moved branch)", () => {
		const repo = mkdtempSync(join(tmpdir(), "review-head-moved-"));
		const cmds: string[] = [];
		const out = prepareReviewHead(repo, { prNumber: 9, itemId: "84", branch: "feat/issue-84-x", headSha: "abc123", statusState: "missing" }, (cmd) => {
			cmds.push(cmd);
			if (cmd.startsWith("git rev-parse")) return "def456\n";
			return "";
		});
		assert.equal(out, null, "a moved branch must not be reviewed under the stale SHA");
		assert.ok(!cmds.some((c) => c.startsWith("git worktree add")), "no worktree for a stale candidate");
		rmSync(repo, { recursive: true, force: true });
	});
});

describe("cleanupReviewHead", () => {
	it("removes the head worktree and deletes the fetched ref", () => {
		const repo = mkdtempSync(join(tmpdir(), "review-clean-"));
		mkdirSync(join(repo, ".dev", "review-heads", "abc123"), { recursive: true });
		const cmds: string[] = [];
		cleanupReviewHead(repo, { prNumber: 9, itemId: "84", branch: "feat/issue-84-x", headSha: "abc123", statusState: "missing" }, (cmd) => {
			cmds.push(cmd);
			return "";
		});
		assert.deepEqual(cmds, [`git worktree remove --force ${join(repo, ".dev", "review-heads", "abc123")}`, "git update-ref -d refs/pelaggio-review/pr-9"]);
		rmSync(repo, { recursive: true, force: true });
	});

	it("fetches and deletes an explicit adjudication ref without touching the drain ref", () => {
		const repo = mkdtempSync(join(tmpdir(), "review-head-adj-"));
		const cmds: string[] = [];
		const candidate = { prNumber: 9, itemId: "84", branch: "feat/issue-84-x", headSha: "abc123", statusState: "missing" as const };
		const out = prepareReviewHead(
			repo,
			candidate,
			(cmd) => {
				cmds.push(cmd);
				if (cmd.startsWith("git rev-parse")) return "abc123\n";
				return "";
			},
			"refs/pelaggio-adjudicate/pr-9",
		);
		assert.equal(out?.headRef, "refs/pelaggio-adjudicate/pr-9");
		assert.ok(cmds.includes("git fetch origin refs/pull/9/head:refs/pelaggio-adjudicate/pr-9"));
		assert.ok(!cmds.some((c) => c.includes("refs/pelaggio-review/pr-9")));
		cmds.length = 0;
		mkdirSync(join(repo, ".dev", "review-heads", "abc123"), { recursive: true });
		cleanupReviewHead(
			repo,
			candidate,
			(cmd) => {
				cmds.push(cmd);
				return "";
			},
			"refs/pelaggio-adjudicate/pr-9",
		);
		assert.deepEqual(cmds, [`git worktree remove --force ${join(repo, ".dev", "review-heads", "abc123")}`, "git update-ref -d refs/pelaggio-adjudicate/pr-9"]);
		rmSync(repo, { recursive: true, force: true });
	});

	it("skips the worktree remove when the path is absent and stays fail-soft on error", () => {
		const repo = mkdtempSync(join(tmpdir(), "review-clean-"));
		const cmds: string[] = [];
		cleanupReviewHead(repo, { prNumber: 9, itemId: "84", branch: "feat/issue-84-x", headSha: "gone", statusState: "missing" }, (cmd) => {
			cmds.push(cmd);
			if (cmd.startsWith("git update-ref")) throw new Error("no such ref");
			return "";
		});
		assert.deepEqual(cmds, ["git update-ref -d refs/pelaggio-review/pr-9"]);
		rmSync(repo, { recursive: true, force: true });
	});
});
