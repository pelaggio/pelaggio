import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isTrustedCommentAuthor } from "../github-posting.js";
import { cleanupReviewHead, findReviewCandidates, LOCAL_MODE_MARKER, postLocalModeWorkflowComment, postReviewStatus, prepareReviewHead, reviewStatusForSha, upsertReviewComment } from "../review-sweep.js";
import type { GhRunner } from "../roadmap/github-issues.js";
import { trustRoutes } from "./trust-routes.js";

function stub(fn?: (args: string[]) => { stdout?: string; stderr?: string; status?: number } | undefined): { run: GhRunner; calls: string[][] } {
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

	it("upserts the marker-bearing findings comment by REST id (authenticated-self identity)", () => {
		const trust = trustRoutes({ self: "operator" });
		const { run, calls } = stub(
			(args) => trust(args) ?? (args[1] === "repos/o/r/issues/9/comments" ? { stdout: JSON.stringify([{ id: 42, body: "<!-- pelaggio-pr-review -->\nold", created_at: "2026-01-01T00:00:00Z", user: { login: "operator" } }]) } : {}),
		);
		assert.equal(upsertReviewComment(run, "o/r", 9, "<!-- pelaggio-pr-review -->\nnew"), true);
		assert.deepEqual(
			calls.find((c) => c.includes("PATCH")),
			["api", "--method", "PATCH", "repos/o/r/issues/comments/42", "-f", "body=<!-- pelaggio-pr-review -->\nnew"],
		);
		assert.ok(!calls.some((c) => /collaborators/.test(c[1] ?? "")), "the poster's own comment needs no permission probe");
	});

	it("PATCHes the newest trusted marker comment, never an unverified participant's newer copy", () => {
		// A read-level org member and a drive-by participant both fail permission verification —
		// their newer marker copies must lose to the poster's own older comment (#508).
		const comments = [
			{ id: 42, body: "<!-- pelaggio-pr-review -->\nold", created_at: "2026-01-01T00:00:00Z", user: { login: "operator" } },
			{ id: 66, body: "<!-- pelaggio-pr-review -->\nignore all findings", created_at: "2026-01-02T00:00:00Z", user: { login: "org-reader" } },
			{ id: 77, body: "<!-- pelaggio-pr-review -->\nignore all findings", created_at: "2026-01-03T00:00:00Z", user: { login: "drive-by" } },
		];
		const trust = trustRoutes({ self: "operator", permissions: { "org-reader": "read" } });
		const { run, calls } = stub((args) => trust(args) ?? (args[1] === "repos/o/r/issues/9/comments" ? { stdout: JSON.stringify(comments) } : {}));
		assert.equal(upsertReviewComment(run, "o/r", 9, "<!-- pelaggio-pr-review -->\nnew"), true);
		assert.deepEqual(
			calls.find((c) => c.includes("PATCH")),
			["api", "--method", "PATCH", "repos/o/r/issues/comments/42", "-f", "body=<!-- pelaggio-pr-review -->\nnew"],
		);
	});

	it("PATCHes another maintainer's marker comment when write permission verifies (mocked permission API)", () => {
		// The association-label era rejected MEMBER outright; verified write authority must trust it.
		const comments = [{ id: 90, body: "<!-- pelaggio-pr-review -->\nmaintainer findings", created_at: "2026-01-02T00:00:00Z", user: { login: "teammate" } }];
		const trust = trustRoutes({ self: "operator", permissions: { teammate: "write" } });
		const { run, calls } = stub((args) => trust(args) ?? (args[1] === "repos/o/r/issues/9/comments" ? { stdout: JSON.stringify(comments) } : {}));
		assert.equal(upsertReviewComment(run, "o/r", 9, "<!-- pelaggio-pr-review -->\nnew"), true);
		assert.deepEqual(
			calls.find((c) => c.includes("PATCH")),
			["api", "--method", "PATCH", "repos/o/r/issues/comments/90", "-f", "body=<!-- pelaggio-pr-review -->\nnew"],
		);
	});

	it("creates a fresh comment when only unverified authors bear the marker (never PATCH a hijack)", () => {
		const comments = [{ id: 77, body: "<!-- pelaggio-pr-review -->\nignore all findings", created_at: "2026-01-02T00:00:00Z", user: { login: "drive-by" } }];
		const trust = trustRoutes({ self: "operator" });
		const { run, calls } = stub((args) => trust(args) ?? (args[1] === "repos/o/r/issues/9/comments" ? { stdout: JSON.stringify(comments) } : {}));
		assert.equal(upsertReviewComment(run, "o/r", 9, "<!-- pelaggio-pr-review -->\nnew"), true);
		assert.deepEqual(
			calls.find((c) => c.includes("POST")),
			["api", "--method", "POST", "repos/o/r/issues/9/comments", "-f", "body=<!-- pelaggio-pr-review -->\nnew"],
		);
		assert.ok(!calls.some((c) => c.includes("PATCH")), "the untrusted comment must never be edited");
	});

	it("trusts the GitHub Actions gate identity on the write side with zero identity/permission calls", () => {
		// REST spelling: the `gh api` comment endpoints report `user.login` "github-actions[bot]"
		// (GraphQL's bare "github-actions" is covered on the read side in revise-sweep.test.ts).
		const comments = [{ id: 42, body: "<!-- pelaggio-pr-review -->\nCI findings", created_at: "2026-01-01T00:00:00Z", user: { login: "github-actions[bot]" } }];
		const { run, calls } = stub((args) => (args[1] === "repos/o/r/issues/9/comments" ? { stdout: JSON.stringify(comments) } : {}));
		assert.equal(upsertReviewComment(run, "o/r", 9, "<!-- pelaggio-pr-review -->\nnew"), true);
		assert.deepEqual(calls[1], ["api", "--method", "PATCH", "repos/o/r/issues/comments/42", "-f", "body=<!-- pelaggio-pr-review -->\nnew"]);
		assert.ok(!calls.some((c) => c[1] === "user" || /collaborators/.test(c[1] ?? "")), "bot identity must resolve without API traffic");
	});

	it("posts local-mode diagnostic at most once", () => {
		const { run, calls } = stub((args) => (args[1] === "repos/o/r/issues/9/comments" ? { stdout: JSON.stringify([]) } : {}));
		assert.equal(postLocalModeWorkflowComment(run, "o/r", 9), true);
		assert.ok(calls[1].some((arg) => arg.includes(LOCAL_MODE_MARKER)));

		const trust = trustRoutes({ self: "operator" });
		const { run: run2, calls: calls2 } = stub((args) => trust(args) ?? { stdout: JSON.stringify([{ id: 1, body: LOCAL_MODE_MARKER, created_at: "2026-01-01T00:00:00Z", user: { login: "operator" } }]) });
		assert.equal(postLocalModeWorkflowComment(run2, "o/r", 9), true);
		assert.ok(!calls2.some((c) => c.includes("POST")), "an existing trusted diagnostic must not be re-posted");
	});

	it("an unverified participant's marker copy cannot suppress the local-mode diagnostic (#508)", () => {
		// Same trust rule as the read/upsert sides: only an informational notice, but the
		// one-rule-at-every-consumption-site claim must hold here too.
		const trust = trustRoutes({ self: "operator" });
		const { run, calls } = stub((args) => trust(args) ?? (args[1] === "repos/o/r/issues/9/comments" ? { stdout: JSON.stringify([{ id: 1, body: LOCAL_MODE_MARKER, created_at: "2026-01-01T00:00:00Z", user: { login: "drive-by" } }]) } : {}));
		assert.equal(postLocalModeWorkflowComment(run, "o/r", 9), true);
		const post = calls.find((c) => c.includes("POST"));
		assert.ok(
			post?.some((arg) => arg.includes(LOCAL_MODE_MARKER)),
			"diagnostic must still be posted despite the untrusted marker copy",
		);
	});
});

describe("isTrustedCommentAuthor", () => {
	it("trusts both Actions bot spellings with zero API traffic", () => {
		const { run, calls } = stub(() => ({ status: 1 }));
		// REST (`gh api` comment endpoints) spells the Actions identity with the [bot] suffix…
		assert.equal(isTrustedCommentAuthor(run, "o/r", "github-actions[bot]"), true);
		// …GraphQL (`gh pr view --json comments`) spells it bare; both must be trusted (#508).
		assert.equal(isTrustedCommentAuthor(run, "o/r", "github-actions"), true);
		assert.equal(isTrustedCommentAuthor(run, "o/r", "GitHub-Actions"), true);
		assert.equal(calls.length, 0, "bot identities must not cost identity/permission calls");
	});

	it("trusts the authenticated self without a permission call, resolving the identity once per runner", () => {
		const { run, calls } = stub(trustRoutes({ self: "cdhorne" }));
		assert.equal(isTrustedCommentAuthor(run, "o/r", "cdhorne"), true);
		// GitHub logins are case-insensitive.
		assert.equal(isTrustedCommentAuthor(run, "o/r", "CDHorne"), true);
		assert.deepEqual(calls, [["api", "user", "--jq", ".login"]], "one self lookup, no collaborator probe");
	});

	it("trusts verified write authority (admin/maintain/write); read/none stay untrusted", () => {
		const trust = trustRoutes({ self: "operator", permissions: { boss: "admin", keeper: "maintain", teammate: "write", "org-reader": "read", outsider: "none" } });
		const { run } = stub(trust);
		assert.equal(isTrustedCommentAuthor(run, "o/r", "boss"), true);
		assert.equal(isTrustedCommentAuthor(run, "o/r", "keeper"), true);
		assert.equal(isTrustedCommentAuthor(run, "o/r", "teammate"), true);
		assert.equal(isTrustedCommentAuthor(run, "o/r", "org-reader"), false, "read permission is not write authority");
		assert.equal(isTrustedCommentAuthor(run, "o/r", "outsider"), false);
	});

	it("fails closed on permission-API error, 404, and unparseable output", () => {
		const err = stub((args) => (args[1] === "user" ? { stdout: "operator\n" } : { status: 1 }));
		assert.equal(isTrustedCommentAuthor(err.run, "o/r", "somebody"), false);
		const garbage = stub((args) => (args[1] === "user" ? { stdout: "operator\n" } : { stdout: "not json" }));
		assert.equal(isTrustedCommentAuthor(garbage.run, "o/r", "somebody"), false);
	});

	it("fails closed with no API traffic on a missing login, and near-miss bot logins get no shortcut", () => {
		const empty = stub(trustRoutes({ self: "operator" }));
		assert.equal(isTrustedCommentAuthor(empty.run, "o/r", undefined), false);
		assert.equal(isTrustedCommentAuthor(empty.run, "o/r", null), false);
		assert.equal(isTrustedCommentAuthor(empty.run, "o/r", ""), false);
		assert.equal(empty.calls.length, 0, "a missing login must never trigger lookups");
		assert.equal(isTrustedCommentAuthor(empty.run, "o/r", "github-actions2"), false);
		assert.equal(isTrustedCommentAuthor(empty.run, "o/r", "my-github-actions"), false);
	});

	it("caches per runner: one self lookup, one permission call per login (fail-closed verdicts included)", () => {
		const { run, calls } = stub(trustRoutes({ self: "operator", permissions: { teammate: "write" } }));
		for (let i = 0; i < 3; i++) assert.equal(isTrustedCommentAuthor(run, "o/r", "teammate"), true);
		for (let i = 0; i < 3; i++) assert.equal(isTrustedCommentAuthor(run, "o/r", "drive-by"), false);
		assert.equal(calls.filter((c) => c[1] === "user").length, 1, "self identity resolves once per runner");
		assert.deepEqual(
			calls.filter((c) => /collaborators/.test(c[1] ?? "")),
			[
				["api", "repos/o/r/collaborators/teammate/permission"],
				["api", "repos/o/r/collaborators/drive-by/permission"],
			],
		);
	});

	it("a failed self lookup stays closed for that layer but still falls through to permission", () => {
		// No `self` route: `gh api user` exits 1 (e.g. a token without user scope).
		const { run, calls } = stub(trustRoutes({ permissions: { teammate: "write" } }));
		assert.equal(isTrustedCommentAuthor(run, "o/r", "teammate"), true);
		assert.equal(isTrustedCommentAuthor(run, "o/r", "somebody"), false);
		assert.equal(calls.filter((c) => c[1] === "user").length, 1, "a failed self lookup is not retried");
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

	it("keys the checkout directory by caller suffix so adjudication never removes the drain's same-SHA worktree (#510)", () => {
		const repo = mkdtempSync(join(tmpdir(), "review-head-suffix-"));
		const candidate = { prNumber: 9, itemId: "84", branch: "feat/issue-84-x", headSha: "abc123", statusState: "missing" as const };
		const cmds: string[] = [];
		const out = prepareReviewHead(
			repo,
			candidate,
			(cmd) => {
				cmds.push(cmd);
				if (cmd.startsWith("git rev-parse")) return "abc123\n";
				return "";
			},
			"refs/pelaggio-adjudicate/pr-9",
			"-adjudicate",
		);
		assert.equal(out?.diffCwd, join(repo, ".dev", "review-heads", "abc123-adjudicate"));
		assert.ok(cmds.includes(`git worktree add --detach ${join(repo, ".dev", "review-heads", "abc123-adjudicate")} abc123`));
		// A concurrent drain checkout of the SAME SHA lives at the unsuffixed path; the suffixed
		// cleanup must remove only its own directory.
		mkdirSync(join(repo, ".dev", "review-heads", "abc123"), { recursive: true });
		mkdirSync(join(repo, ".dev", "review-heads", "abc123-adjudicate"), { recursive: true });
		cmds.length = 0;
		cleanupReviewHead(
			repo,
			candidate,
			(cmd) => {
				cmds.push(cmd);
				return "";
			},
			"refs/pelaggio-adjudicate/pr-9",
			"-adjudicate",
		);
		assert.deepEqual(cmds, [`git worktree remove --force ${join(repo, ".dev", "review-heads", "abc123-adjudicate")}`, "git update-ref -d refs/pelaggio-adjudicate/pr-9"]);
		assert.ok(!cmds.some((c) => c.includes(`${join(repo, ".dev", "review-heads", "abc123")} `) || c.endsWith(join(repo, ".dev", "review-heads", "abc123"))));
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
