import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { claimRevision, ensureReviseWorktree, fetchReviewFindings, findRevisablePrs, isAutopilotManaged, postParkComment, reviseFindingsPath } from "../revise-sweep.js";
import type { GhRunner } from "../roadmap/github-issues.js";

/** Records every gh call; `fn` returns the response (defaults to exit-0, empty stdout). */
function stub(fn?: (args: string[]) => { stdout?: string; stderr?: string; status?: number }): { run: GhRunner; calls: string[][] } {
	const calls: string[][] = [];
	const run: GhRunner = (args) => {
		calls.push(args);
		const r = fn?.(args) ?? {};
		return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 0 };
	};
	return { run, calls };
}

const throwingGh: GhRunner = () => {
	throw Object.assign(new Error("gh not found"), { code: "ENOENT" });
};

const PR_LIST_FIXTURE = JSON.stringify([
	// revisable: open, non-draft, feat/issue head, unlabeled, review=FAILURE
	{
		number: 101,
		isDraft: false,
		headRefName: "feat/issue-76-thing",
		labels: [{ name: "pelaggio" }],
		statusCheckRollup: [
			{ __typename: "CheckRun", name: "review", conclusion: "FAILURE" },
			{ __typename: "CheckRun", name: "ci", conclusion: "SUCCESS" },
		],
	},
	// excluded: draft
	{ number: 102, isDraft: true, headRefName: "feat/issue-77-draft", labels: [], statusCheckRollup: [{ __typename: "CheckRun", name: "review", conclusion: "FAILURE" }] },
	// excluded: non-feat head
	{ number: 103, isDraft: false, headRefName: "chore/cleanup", labels: [], statusCheckRollup: [{ __typename: "CheckRun", name: "review", conclusion: "FAILURE" }] },
	// excluded: review passed
	{ number: 104, isDraft: false, headRefName: "feat/issue-78-ok", labels: [], statusCheckRollup: [{ __typename: "CheckRun", name: "review", conclusion: "SUCCESS" }] },
	// labeledStillRed: already spent its one pass but still red
	{ number: 105, isDraft: false, headRefName: "feat/issue-79-spent", labels: [{ name: "pelaggio:revised" }], statusCheckRollup: [{ __typename: "CheckRun", name: "review", conclusion: "FAILURE" }] },
	// excluded: a different check failed, review is green
	{
		number: 106,
		isDraft: false,
		headRefName: "feat/issue-80-ci-red",
		labels: [],
		statusCheckRollup: [
			{ __typename: "CheckRun", name: "ci", conclusion: "FAILURE" },
			{ __typename: "CheckRun", name: "review", conclusion: "SUCCESS" },
		],
	},
]);

describe("findRevisablePrs", () => {
	it("partitions the candidate set: only the eligible red PR is revisable, the labeled one is handoff", () => {
		const { run } = stub((args) => (args[0] === "pr" && args[1] === "list" ? { stdout: PR_LIST_FIXTURE } : {}));
		const { revisable, labeledStillRed } = findRevisablePrs(run, "o/r");
		assert.deepEqual(revisable, [{ prNumber: 101, itemId: "76", branch: "feat/issue-76-thing" }]);
		assert.deepEqual(labeledStillRed, [{ prNumber: 105, itemId: "79", branch: "feat/issue-79-spent" }]);
	});

	it("issues exactly one gh call with statusCheckRollup requested", () => {
		const { run, calls } = stub((args) => (args[0] === "pr" && args[1] === "list" ? { stdout: PR_LIST_FIXTURE } : {}));
		findRevisablePrs(run, "o/r");
		assert.equal(calls.length, 1);
		assert.ok(calls[0].join(" ").includes("statusCheckRollup"), `expected statusCheckRollup in the --json field list; got ${calls[0].join(" ")}`);
	});

	it("matches the review check case-insensitively (name + conclusion)", () => {
		const fixture = JSON.stringify([{ number: 7, isDraft: false, headRefName: "feat/issue-7-x", labels: [], statusCheckRollup: [{ __typename: "CheckRun", name: "Review", conclusion: "failure" }] }]);
		const { run } = stub(() => ({ stdout: fixture }));
		const { revisable } = findRevisablePrs(run, "o/r");
		assert.deepEqual(revisable, [{ prNumber: 7, itemId: "7", branch: "feat/issue-7-x" }]);
	});

	it("matches a local review commit status failure (context + state)", () => {
		const fixture = JSON.stringify([{ number: 8, isDraft: false, headRefName: "feat/issue-8-x", labels: [], statusCheckRollup: [{ __typename: "StatusContext", context: "Review", state: "failure" }] }]);
		const { run } = stub(() => ({ stdout: fixture }));
		const { revisable } = findRevisablePrs(run, "o/r");
		assert.deepEqual(revisable, [{ prNumber: 8, itemId: "8", branch: "feat/issue-8-x" }]);
	});

	it("fail-soft: gh non-zero status → both lists empty", () => {
		const { run } = stub(() => ({ status: 1, stderr: "boom" }));
		assert.deepEqual(findRevisablePrs(run, "o/r"), { revisable: [], labeledStillRed: [] });
	});

	it("fail-soft: a thrown gh error (ENOENT) → both lists empty, no throw", () => {
		assert.deepEqual(findRevisablePrs(throwingGh, "o/r"), { revisable: [], labeledStillRed: [] });
	});

	it("fail-soft: non-JSON stdout → both lists empty", () => {
		const { run } = stub(() => ({ stdout: "not json" }));
		assert.deepEqual(findRevisablePrs(run, "o/r"), { revisable: [], labeledStillRed: [] });
	});
});

describe("isAutopilotManaged", () => {
	const labelsJson = (names: string[]) => JSON.stringify({ labels: names.map((name) => ({ name })) });

	it("true when the issue carries the roadmap label", () => {
		const { run } = stub(() => ({ stdout: labelsJson(["pelaggio", "bug"]) }));
		assert.equal(isAutopilotManaged(run, "o/r", "76", "pelaggio"), true);
	});

	it("false when the label is absent", () => {
		const { run } = stub(() => ({ stdout: labelsJson(["bug"]) }));
		assert.equal(isAutopilotManaged(run, "o/r", "76", "pelaggio"), false);
	});

	it("false (conservative skip) on a lookup error", () => {
		const { run } = stub(() => ({ status: 1, stderr: "not found" }));
		assert.equal(isAutopilotManaged(run, "o/r", "76", "pelaggio"), false);
		assert.equal(isAutopilotManaged(throwingGh, "o/r", "76", "pelaggio"), false);
	});
});

describe("claimRevision", () => {
	it("ensures the label exists then adds it, returning true", () => {
		const { run, calls } = stub();
		assert.equal(claimRevision(run, "o/r", 101), true);
		assert.equal(calls[0][0], "label");
		assert.equal(calls[0][1], "create");
		assert.ok(calls[0].includes("pelaggio:revised"));
		const edit = calls.find((c) => c[0] === "pr" && c[1] === "edit");
		assert.ok(edit, "expected a `pr edit` call");
		assert.ok(edit.includes("--add-label") && edit.includes("pelaggio:revised"));
	});

	it("returns true even when `label create` fails (label already exists)", () => {
		const { run } = stub((args) => (args[0] === "label" ? { status: 1, stderr: "already exists" } : {}));
		assert.equal(claimRevision(run, "o/r", 101), true);
	});

	it("returns false when the add-label edit fails", () => {
		const { run } = stub((args) => (args[0] === "pr" && args[1] === "edit" ? { status: 1, stderr: "boom" } : {}));
		assert.equal(claimRevision(run, "o/r", 101), false);
	});
});

describe("fetchReviewFindings", () => {
	function tmpFile(): string {
		return join(mkdtempSync(join(tmpdir(), "revise-findings-")), "findings.md");
	}

	it("writes the latest marker-bearing comment body and returns true", () => {
		const path = tmpFile();
		const comments = JSON.stringify({
			comments: [
				{ body: "<!-- pelaggio-pr-review -->\nold findings", createdAt: "2026-01-01T00:00:00Z" },
				{ body: "unrelated chatter", createdAt: "2026-01-02T00:00:00Z" },
				{ body: "<!-- pelaggio-pr-review -->\nNEW findings", createdAt: "2026-01-03T00:00:00Z" },
			],
		});
		const { run } = stub(() => ({ stdout: comments }));
		assert.equal(fetchReviewFindings(run, "o/r", 101, path), true);
		assert.ok(readFileSync(path, "utf-8").includes("NEW findings"));
	});

	it("returns false and writes nothing when there is no findings comment", () => {
		const path = tmpFile();
		const { run } = stub(() => ({ stdout: JSON.stringify({ comments: [{ body: "just a note", createdAt: "2026-01-01T00:00:00Z" }] }) }));
		assert.equal(fetchReviewFindings(run, "o/r", 101, path), false);
		assert.equal(existsSync(path), false);
	});

	it("fail-soft: gh error → false", () => {
		assert.equal(fetchReviewFindings(throwingGh, "o/r", 101, tmpFile()), false);
	});
});

describe("ensureReviseWorktree", () => {
	it("returns the existing worktree path without invoking git", () => {
		const dir = mkdtempSync(join(tmpdir(), "revise-wt-"));
		let execRan = false;
		const path = ensureReviseWorktree(dir, "feat/issue-76-x", {
			repo: dir,
			exec: () => {
				execRan = true;
				return "";
			},
		});
		assert.equal(path, dir);
		assert.equal(execRan, false, "exec must not run when the worktree already exists");
		rmSync(dir, { recursive: true, force: true });
	});

	it("recreates a missing worktree via `git worktree add` and returns the path", () => {
		const missing = join(tmpdir(), `revise-wt-missing-${process.pid}`);
		const cmds: string[] = [];
		const path = ensureReviseWorktree(missing, "feat/issue-76-x", {
			repo: "/repo",
			exec: (cmd) => {
				cmds.push(cmd);
				return "";
			},
		});
		assert.equal(path, missing);
		assert.ok(
			cmds.some((c) => c.startsWith(`git worktree add ${missing} feat/issue-76-x`)),
			`expected a git worktree add command; got ${JSON.stringify(cmds)}`,
		);
	});

	it("returns null when `git worktree add` throws (fail-soft)", () => {
		const missing = join(tmpdir(), `revise-wt-fail-${process.pid}`);
		const path = ensureReviseWorktree(missing, "feat/issue-76-x", {
			repo: "/repo",
			exec: (cmd) => {
				if (cmd.startsWith("git worktree add")) throw new Error("no such branch");
				return "";
			},
		});
		assert.equal(path, null);
	});
});

describe("postParkComment", () => {
	it("posts the handoff comment once when none exists yet", () => {
		const { run, calls } = stub((args) => (args[0] === "pr" && args[1] === "view" ? { stdout: JSON.stringify({ comments: [] }) } : {}));
		postParkComment(run, "o/r", 101);
		const comment = calls.find((c) => c[0] === "pr" && c[1] === "comment");
		assert.ok(comment, "expected a `pr comment` call");
		assert.ok(comment.some((a) => a.includes("<!-- pelaggio-revise-parked -->")));
	});

	it("is idempotent: skips posting when a park comment already exists", () => {
		const { run, calls } = stub((args) => (args[0] === "pr" && args[1] === "view" ? { stdout: JSON.stringify({ comments: [{ body: "<!-- pelaggio-revise-parked -->\nparked", createdAt: "2026-01-01T00:00:00Z" }] }) } : {}));
		postParkComment(run, "o/r", 101);
		assert.equal(
			calls.some((c) => c[0] === "pr" && c[1] === "comment"),
			false,
			"must not post a second park comment",
		);
	});

	it("fail-soft: a lookup error skips posting (no throw)", () => {
		assert.doesNotThrow(() => postParkComment(throwingGh, "o/r", 101));
	});
});

describe("reviseFindingsPath", () => {
	it("is absolute, under <repo>/.dev/, with a lowercased id", () => {
		const p = reviseFindingsPath("/home/x/repo", "ENG-42");
		assert.equal(p, "/home/x/repo/.dev/review-findings-eng-42.md");
	});
});
