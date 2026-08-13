import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
	acquireReviseExecution,
	claimRevision,
	claimRevisionExclusive,
	ensureReviseWorktree,
	fetchReviewFindings,
	findRevisablePrs,
	isAutopilotManaged,
	postParkComment,
	REVISE_INVOCATION_MARKER,
	recordReviseInvocation,
	resolveReviseTarget,
	reviseClaimLockPath,
	reviseExecLeasePath,
	reviseFindingsPath,
	verifyReviseWorktreeBinding,
} from "../revise-sweep.js";
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
		labels: [{ name: "autopilot" }],
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
	{ number: 105, isDraft: false, headRefName: "feat/issue-79-spent", labels: [{ name: "autopilot:revised" }], statusCheckRollup: [{ __typename: "CheckRun", name: "review", conclusion: "FAILURE" }] },
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

	it("rejects branch names with shell metacharacters after the issue prefix (injection guard)", () => {
		const fixture = JSON.stringify(
			["feat/issue-1;id", "feat/issue-1$(cmd)", "feat/issue-1 --upload-pack=x", "feat/issue-1-ok`x`"].map((headRefName, i) => ({
				number: i + 1,
				isDraft: false,
				headRefName,
				labels: [],
				statusCheckRollup: [{ __typename: "CheckRun", name: "review", conclusion: "failure" }],
			})),
		);
		const { run } = stub(() => ({ stdout: fixture }));
		assert.deepEqual(findRevisablePrs(run, "o/r"), { revisable: [], labeledStillRed: [] });
	});
});

describe("isAutopilotManaged", () => {
	const labelsJson = (names: string[]) => JSON.stringify({ labels: names.map((name) => ({ name })) });

	it("true when the issue carries the roadmap label", () => {
		const { run } = stub(() => ({ stdout: labelsJson(["autopilot", "bug"]) }));
		assert.equal(isAutopilotManaged(run, "o/r", "76", "autopilot"), true);
	});

	it("false when the label is absent", () => {
		const { run } = stub(() => ({ stdout: labelsJson(["bug"]) }));
		assert.equal(isAutopilotManaged(run, "o/r", "76", "autopilot"), false);
	});

	it("false (conservative skip) on a lookup error", () => {
		const { run } = stub(() => ({ status: 1, stderr: "not found" }));
		assert.equal(isAutopilotManaged(run, "o/r", "76", "autopilot"), false);
		assert.equal(isAutopilotManaged(throwingGh, "o/r", "76", "autopilot"), false);
	});
});

describe("claimRevision", () => {
	it("ensures the label exists then adds it, returning true", () => {
		const { run, calls } = stub();
		assert.equal(claimRevision(run, "o/r", 101), true);
		assert.equal(calls[0][0], "label");
		assert.equal(calls[0][1], "create");
		assert.ok(calls[0].includes("autopilot:revised"));
		const edit = calls.find((c) => c[0] === "pr" && c[1] === "edit");
		assert.ok(edit, "expected a `pr edit` call");
		assert.ok(edit.includes("--add-label") && edit.includes("autopilot:revised"));
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

describe("claimRevisionExclusive", () => {
	/**
	 * gh stub over a SHARED mutable label store, mimicking GitHub's semantics: the
	 * label read returns current state, and `--add-label` is idempotent (succeeds
	 * even when the label is already present — the exact property that makes the
	 * bare `claimRevision` a check-then-write rather than a claim).
	 */
	function labelStore(initial: string[] = []): { run: GhRunner; calls: string[][]; labels: Set<string> } {
		const labels = new Set(initial);
		const calls: string[][] = [];
		const run: GhRunner = (args) => {
			calls.push(args);
			if (args[0] === "pr" && args[1] === "view" && args.includes("labels")) {
				return { stdout: JSON.stringify({ labels: [...labels].map((name) => ({ name })) }), stderr: "", status: 0 };
			}
			if (args[0] === "pr" && args[1] === "edit" && args.includes("--add-label")) {
				labels.add("autopilot:revised");
				return { stdout: "", stderr: "", status: 0 };
			}
			return { stdout: "", stderr: "", status: 0 };
		};
		return { run, calls, labels };
	}

	const addCalls = (calls: string[][]) => calls.filter((c) => c[0] === "pr" && c[1] === "edit" && c.includes("--add-label"));

	function tmpRepo(): string {
		return mkdtempSync(join(tmpdir(), "revise-claim-"));
	}

	it("claims when the label is absent: re-reads under the lock, then adds", async () => {
		const repo = tmpRepo();
		const { run, calls, labels } = labelStore();
		assert.equal(await claimRevisionExclusive(run, "o/r", repo, 101), "claimed");
		const viewIdx = calls.findIndex((c) => c[0] === "pr" && c[1] === "view");
		const editIdx = calls.findIndex((c) => c[0] === "pr" && c[1] === "edit");
		assert.ok(viewIdx >= 0 && editIdx > viewIdx, "the label must be re-read before the add, inside the critical section");
		assert.ok(labels.has("autopilot:revised"));
		rmSync(repo, { recursive: true, force: true });
	});

	it("refuses when the label is present at claim time — a stale earlier read is corrected under the lock", async () => {
		const repo = tmpRepo();
		// Simulates the TOCTOU window: the caller's earlier listing/resolve saw no label,
		// but by claim time a peer has labeled the PR.
		const { run, calls } = labelStore(["autopilot:revised"]);
		assert.equal(await claimRevisionExclusive(run, "o/r", repo, 101), "already-claimed");
		assert.equal(addCalls(calls).length, 0, "a refused claim must never write the label");
		rmSync(repo, { recursive: true, force: true });
	});

	it("two concurrent claimants: exactly one wins, the loser observes the winner and refuses", async () => {
		const repo = tmpRepo();
		const { run, calls } = labelStore();
		const [a, b] = await Promise.all([claimRevisionExclusive(run, "o/r", repo, 101), claimRevisionExclusive(run, "o/r", repo, 101)]);
		assert.deepEqual([a, b].sort(), ["already-claimed", "claimed"], `expected one winner and one refusal; got ${a}/${b}`);
		assert.equal(addCalls(calls).length, 1, "the pass must be claimed exactly once");
		rmSync(repo, { recursive: true, force: true });
	});

	it("fail-closed: an unreadable label state is unavailable and never adds", async () => {
		const repo = tmpRepo();
		const calls: string[][] = [];
		const run: GhRunner = (args) => {
			calls.push(args);
			return { stdout: "", stderr: "boom", status: 1 };
		};
		assert.equal(await claimRevisionExclusive(run, "o/r", repo, 101), "unavailable");
		assert.equal(addCalls(calls).length, 0);
		rmSync(repo, { recursive: true, force: true });
	});

	it("fail-closed: a live lock holder means unavailable — no claim proceeds without the lock", async () => {
		const repo = tmpRepo();
		const lockPath = reviseClaimLockPath(repo);
		mkdirSync(dirname(lockPath), { recursive: true });
		// A live (far-future expiry) holder, per file-lock.ts's `<expiresAt>:<token>` format.
		writeFileSync(lockPath, `${Date.now() + 60 * 60 * 1000}:live-holder`);
		process.env.PELAGGIO_REVISE_CLAIM_LOCK_TIMEOUT_MS = "100";
		process.env.PELAGGIO_REVISE_CLAIM_LOCK_STALE_MS = "200";
		try {
			const { run, calls } = labelStore();
			assert.equal(await claimRevisionExclusive(run, "o/r", repo, 101), "unavailable");
			assert.equal(calls.length, 0, "the critical section must never run without the lock");
		} finally {
			delete process.env.PELAGGIO_REVISE_CLAIM_LOCK_TIMEOUT_MS;
			delete process.env.PELAGGIO_REVISE_CLAIM_LOCK_STALE_MS;
			rmSync(repo, { recursive: true, force: true });
		}
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

	it("refuses a branch with shell metacharacters without invoking exec (injection guard)", () => {
		const missing = join(tmpdir(), `revise-wt-inject-${process.pid}`);
		for (const branch of ["feat/issue-1;id", "feat/issue-1$(cmd)", "-feat/issue-1", "feat/issue-1 x"]) {
			let execRan = false;
			const path = ensureReviseWorktree(missing, branch, {
				repo: "/repo",
				exec: () => {
					execRan = true;
					return "";
				},
			});
			assert.equal(path, null, `branch ${JSON.stringify(branch)} must be refused`);
			assert.equal(execRan, false, `exec must never run for ${JSON.stringify(branch)}`);
		}
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

const VIEW_HEAD_OID = "0123456789abcdef0123456789abcdef01234567";

function viewPayload(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		state: "OPEN",
		isDraft: false,
		headRefName: "feat/issue-498-revise",
		headRefOid: VIEW_HEAD_OID,
		headRepository: { nameWithOwner: "o/r" },
		headRepositoryOwner: { login: "o" },
		labels: [],
		statusCheckRollup: [{ __typename: "CheckRun", name: "review", conclusion: "FAILURE" }],
		...over,
	});
}

describe("resolveReviseTarget", () => {
	it("accepts an open, non-draft red-review claim-branch PR, carrying the head OID for the binding check", () => {
		const { run, calls } = stub((args) => (args[0] === "pr" && args[1] === "view" ? { stdout: viewPayload({ labels: [{ name: "autopilot" }] }) } : {}));
		assert.deepEqual(resolveReviseTarget(run, "o/r", 42), {
			kind: "ok",
			target: { prNumber: 42, itemId: "498", branch: "feat/issue-498-revise", headOid: VIEW_HEAD_OID, alreadyRevised: false },
		});
		const joined = (calls.at(0) ?? []).join(" ");
		assert.ok(joined.includes("headRepository"));
		assert.ok(joined.includes("headRepositoryOwner"));
		assert.ok(joined.includes("statusCheckRollup"));
		assert.ok(joined.includes("headRefOid"), `the head OID must be requested so the checkout can be bound to it; got ${joined}`);
	});

	it("a missing or malformed head OID is unavailable (retryable), never ok", () => {
		for (const headRefOid of [undefined, "", "not-a-sha", "abc123", `${VIEW_HEAD_OID}f`]) {
			const { run } = stub(() => ({ stdout: viewPayload({ headRefOid }) }));
			const result = resolveReviseTarget(run, "o/r", 1);
			assert.equal(result.kind, "unavailable", `headRefOid=${JSON.stringify(headRefOid)} must be unavailable`);
		}
	});

	it("reports alreadyRevised when the one-pass label is present", () => {
		const { run } = stub(() => ({ stdout: viewPayload({ labels: [{ name: "autopilot:revised" }] }) }));
		const result = resolveReviseTarget(run, "o/r", 42);
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") assert.equal(result.target.alreadyRevised, true);
	});

	it("matches both failed CheckRun and StatusContext forms case-insensitively", () => {
		const check = stub(() => ({ stdout: viewPayload({ statusCheckRollup: [{ __typename: "CheckRun", name: "Review", conclusion: "failure" }] }) }));
		const status = stub(() => ({ stdout: viewPayload({ statusCheckRollup: [{ __typename: "StatusContext", context: "Review", state: "failure" }] }) }));
		assert.equal(resolveReviseTarget(check.run, "o/r", 1).kind, "ok");
		assert.equal(resolveReviseTarget(status.run, "o/r", 1).kind, "ok");
	});

	it("discriminates unavailable (gh/json) from ineligible (policy)", () => {
		assert.equal(resolveReviseTarget(stub(() => ({ status: 1, stderr: "boom" })).run, "o/r", 1).kind, "unavailable");
		assert.equal(resolveReviseTarget(throwingGh, "o/r", 1).kind, "unavailable");
		assert.equal(resolveReviseTarget(stub(() => ({ stdout: "not json" })).run, "o/r", 1).kind, "unavailable");
		assert.equal(resolveReviseTarget(stub(() => ({ stdout: viewPayload({ isDraft: true }) })).run, "o/r", 1).kind, "ineligible");
		assert.equal(resolveReviseTarget(stub(() => ({ stdout: viewPayload({ state: "CLOSED" }) })).run, "o/r", 1).kind, "ineligible");
		assert.equal(resolveReviseTarget(stub(() => ({ stdout: viewPayload({ state: "MERGED" }) })).run, "o/r", 1).kind, "ineligible");
	});

	it("rejects a cross-repository head via nameWithOwner and the owner/name fallback", () => {
		const named = stub(() => ({ stdout: viewPayload({ headRepository: { nameWithOwner: "other/fork" } }) }));
		assert.equal(resolveReviseTarget(named.run, "o/r", 1).kind, "ineligible");
		// Clear nameWithOwner so the fallback path is used.
		const parsed = JSON.parse(viewPayload()) as Record<string, unknown>;
		parsed.headRepository = { name: "fork" };
		parsed.headRepositoryOwner = { login: "other" };
		const { run } = stub(() => ({ stdout: JSON.stringify(parsed) }));
		assert.equal(resolveReviseTarget(run, "o/r", 1).kind, "ineligible");
	});

	it("accepts a same-repo head via the owner/name fallback when nameWithOwner is absent", () => {
		const parsed = JSON.parse(viewPayload()) as Record<string, unknown>;
		parsed.headRepository = { name: "r" };
		parsed.headRepositoryOwner = { login: "O" };
		const { run } = stub(() => ({ stdout: JSON.stringify(parsed) }));
		assert.equal(resolveReviseTarget(run, "o/r", 1).kind, "ok");
	});

	it("rejects green, pending, and missing review status", () => {
		assert.equal(resolveReviseTarget(stub(() => ({ stdout: viewPayload({ statusCheckRollup: [{ name: "review", conclusion: "SUCCESS" }] }) })).run, "o/r", 1).kind, "ineligible");
		assert.equal(resolveReviseTarget(stub(() => ({ stdout: viewPayload({ statusCheckRollup: [{ name: "review", conclusion: "PENDING" }] }) })).run, "o/r", 1).kind, "ineligible");
		assert.equal(resolveReviseTarget(stub(() => ({ stdout: viewPayload({ statusCheckRollup: [] }) })).run, "o/r", 1).kind, "ineligible");
		assert.equal(resolveReviseTarget(stub(() => ({ stdout: viewPayload({ statusCheckRollup: undefined }) })).run, "o/r", 1).kind, "ineligible");
	});

	it("rejects unsafe or unrelated head branches", () => {
		for (const headRefName of ["chore/cleanup", "feat/issue-1;id", "feat/issue-1$(cmd)", "main", "feat/other-1"]) {
			assert.equal(resolveReviseTarget(stub(() => ({ stdout: viewPayload({ headRefName }) })).run, "o/r", 1).kind, "ineligible", headRefName);
		}
	});
});

describe("recordReviseInvocation", () => {
	it("POSTs one new marker-bearing comment with the deterministic disposition body", () => {
		const { run, calls } = stub();
		assert.equal(recordReviseInvocation(run, "o/r", 42, "accepted-first-pass", false), true);
		const comment = calls.find((c) => c[0] === "pr" && c[1] === "comment");
		assert.ok(comment, "expected a `pr comment` call");
		assert.ok(!calls.some((c) => c.includes("PATCH") || c[1] === "edit"), "must POST, never PATCH/upsert");
		const body = comment.find((_a, i) => comment[i - 1] === "--body");
		assert.ok(body?.includes(REVISE_INVOCATION_MARKER));
		assert.equal(body, `${REVISE_INVOCATION_MARKER}\noperator revise --pr 42 disposition=accepted-first-pass allow-repeat=false`);
		assert.ok(!body?.toLowerCase().includes("finding"), "must not interpolate review findings");
	});

	it("records refused-repeat and accepted-repeat without findings text", () => {
		const { run, calls } = stub();
		assert.equal(recordReviseInvocation(run, "o/r", 7, "refused-repeat", false), true);
		assert.equal(recordReviseInvocation(run, "o/r", 7, "accepted-repeat", true), true);
		const bodies = calls.filter((c) => c[0] === "pr" && c[1] === "comment").map((c) => c[c.indexOf("--body") + 1]);
		assert.ok(bodies.at(0)?.includes("disposition=refused-repeat") && bodies.at(0)?.includes("allow-repeat=false"));
		assert.ok(bodies.at(1)?.includes("disposition=accepted-repeat") && bodies.at(1)?.includes("allow-repeat=true"));
	});

	it("returns false on GitHub failure", () => {
		assert.equal(recordReviseInvocation(stub(() => ({ status: 1, stderr: "boom" })).run, "o/r", 1, "accepted-first-pass", false), false);
		assert.equal(recordReviseInvocation(throwingGh, "o/r", 1, "accepted-first-pass", false), false);
	});
});

describe("acquireReviseExecution", () => {
	function tmpRoot(): string {
		return mkdtempSync(join(tmpdir(), "revise-exec-"));
	}

	it("acquires when no lease exists; release removes the lease file", async () => {
		const root = tmpRoot();
		const r = await acquireReviseExecution(root, "498");
		assert.equal(r.kind, "acquired");
		assert.ok(existsSync(reviseExecLeasePath(root, "498")), "the lease file must exist while held");
		if (r.kind === "acquired") await r.lease.release();
		assert.equal(existsSync(reviseExecLeasePath(root, "498")), false, "release must remove the holder's own lease");
		rmSync(root, { recursive: true, force: true });
	});

	it("refuses while a live holder owns the lease, naming the holder pid and the lease path", async () => {
		const root = tmpRoot();
		const first = await acquireReviseExecution(root, "498");
		assert.equal(first.kind, "acquired");
		// Default liveness probe: the recorded pid is THIS process — provably alive.
		const second = await acquireReviseExecution(root, "498");
		assert.equal(second.kind, "held");
		if (second.kind === "held") {
			assert.ok(second.holder.includes(String(process.pid)), `holder description must name the pid; got ${second.holder}`);
			assert.ok(second.holder.includes(reviseExecLeasePath(root, "498")), "holder description must name the lease path for manual remediation");
		}
		if (first.kind === "acquired") await first.lease.release();
		rmSync(root, { recursive: true, force: true });
	});

	it("leases are per-item: holding item A does not block item B", async () => {
		const root = tmpRoot();
		const a = await acquireReviseExecution(root, "498");
		const b = await acquireReviseExecution(root, "499");
		assert.equal(a.kind, "acquired");
		assert.equal(b.kind, "acquired");
		if (a.kind === "acquired") await a.lease.release();
		if (b.kind === "acquired") await b.lease.release();
		rmSync(root, { recursive: true, force: true });
	});

	it("a dead holder pid still refuses — crash recovery is manual and fail-closed (#507 round 3)", async () => {
		const root = tmpRoot();
		mkdirSync(root, { recursive: true });
		writeFileSync(reviseExecLeasePath(root, "498"), `${JSON.stringify({ version: 1, itemId: "498", pid: 4_000_000, token: "crashed-holder", acquiredAt: Date.now() })}\n`);
		// A missing parent pid is NOT positive evidence the pass ended: providers spawn child
		// processes that can outlive a crashed orchestrator and keep mutating the worktree.
		const r = await acquireReviseExecution(root, "498", { isPidAlive: () => false });
		assert.equal(r.kind, "held", "a dead-pid lease must never be auto-reclaimed — a second reviser could start under orphaned provider children");
		if (r.kind === "held") {
			assert.ok(/manual/i.test(r.holder), `refusal must state crash recovery is manual; got ${r.holder}`);
			assert.ok(r.holder.includes(`rm ${reviseExecLeasePath(root, "498")}`), `refusal must name the exact removal step for the lease file; got ${r.holder}`);
			assert.ok(/still be running/i.test(r.holder), `refusal must warn that processes from the pass may still be running; got ${r.holder}`);
		}
		assert.ok(existsSync(reviseExecLeasePath(root, "498")), "the crashed holder's lease must be left in place");
		rmSync(root, { recursive: true, force: true });
	});

	it("never steals from a live holder on time alone: an old lease with a live pid still refuses", async () => {
		const root = tmpRoot();
		mkdirSync(root, { recursive: true });
		// acquiredAt far in the past — a suspended-then-resumed holder must keep exclusion.
		writeFileSync(reviseExecLeasePath(root, "498"), `${JSON.stringify({ version: 1, itemId: "498", pid: process.pid, token: "long-runner", acquiredAt: Date.now() - 24 * 60 * 60 * 1000 })}\n`);
		const r = await acquireReviseExecution(root, "498", { isPidAlive: () => true });
		assert.equal(r.kind, "held", "there is no TTL theft — only a dead pid or the holder's release frees the lease");
		rmSync(root, { recursive: true, force: true });
	});

	it("a malformed lease is reclaimable (harness-owned register, mirrors file-lock's stale handling)", async () => {
		const root = tmpRoot();
		mkdirSync(root, { recursive: true });
		writeFileSync(reviseExecLeasePath(root, "498"), "not json");
		const r = await acquireReviseExecution(root, "498", { isPidAlive: () => true });
		assert.equal(r.kind, "acquired");
		if (r.kind === "acquired") await r.lease.release();
		rmSync(root, { recursive: true, force: true });
	});

	it("two concurrent acquires: exactly one wins", async () => {
		const root = tmpRoot();
		const [a, b] = await Promise.all([acquireReviseExecution(root, "498"), acquireReviseExecution(root, "498")]);
		assert.deepEqual([a.kind, b.kind].sort(), ["acquired", "held"], `expected one winner and one refusal; got ${a.kind}/${b.kind}`);
		for (const r of [a, b]) if (r.kind === "acquired") await r.lease.release();
		rmSync(root, { recursive: true, force: true });
	});

	it("release is token-guarded: a stale holder never removes a replacement's lease", async () => {
		const root = tmpRoot();
		const first = await acquireReviseExecution(root, "498");
		assert.equal(first.kind, "acquired");
		// Simulate the register changing hands (crash + reclaim by another process).
		writeFileSync(reviseExecLeasePath(root, "498"), `${JSON.stringify({ version: 1, itemId: "498", pid: process.pid, token: "replacement", acquiredAt: Date.now() })}\n`);
		if (first.kind === "acquired") await first.lease.release();
		assert.ok(existsSync(reviseExecLeasePath(root, "498")), "the replacement's lease must survive a stale release");
		rmSync(root, { recursive: true, force: true });
	});

	it("fail-closed: a live short-lock holder means unavailable — no lease decision without the lock", async () => {
		const root = tmpRoot();
		mkdirSync(root, { recursive: true });
		// A live (far-future expiry) short-lock holder, per file-lock.ts's `<expiresAt>:<token>` format.
		writeFileSync(join(root, ".lock"), `${Date.now() + 60 * 60 * 1000}:live-holder`);
		process.env.PELAGGIO_REVISE_EXEC_LOCK_TIMEOUT_MS = "100";
		process.env.PELAGGIO_REVISE_EXEC_LOCK_STALE_MS = "200";
		try {
			const r = await acquireReviseExecution(root, "498");
			assert.equal(r.kind, "unavailable");
			assert.equal(existsSync(reviseExecLeasePath(root, "498")), false, "no lease may be written without the lock");
		} finally {
			delete process.env.PELAGGIO_REVISE_EXEC_LOCK_TIMEOUT_MS;
			delete process.env.PELAGGIO_REVISE_EXEC_LOCK_STALE_MS;
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("verifyReviseWorktreeBinding", () => {
	const OID = "0123456789abcdef0123456789abcdef01234567";
	const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

	function gitStub(branch: string, head: string): (cmd: string, cwd: string) => string {
		return (cmd) => {
			if (cmd === "git rev-parse --abbrev-ref HEAD") return `${branch}\n`;
			if (cmd === "git rev-parse HEAD") return `${head}\n`;
			throw new Error(`unexpected command: ${cmd}`);
		};
	}

	it("accepts a checkout on the PR branch at the PR head (case-insensitive OID compare)", () => {
		assert.deepEqual(verifyReviseWorktreeBinding("/wt", "feat/issue-498-x", OID, { exec: gitStub("feat/issue-498-x", OID) }), { ok: true });
		assert.deepEqual(verifyReviseWorktreeBinding("/wt", "feat/issue-498-x", OID.toUpperCase(), { exec: gitStub("feat/issue-498-x", OID) }), { ok: true });
	});

	it("refuses a checkout on a different branch, naming both branches, without touching HEAD state", () => {
		const r = verifyReviseWorktreeBinding("/wt", "feat/issue-498-x", OID, { exec: gitStub("main", OID) });
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(r.reason.includes('"main"') && r.reason.includes('"feat/issue-498-x"'), r.reason);
			assert.ok(r.reason.includes("nothing was reset"), "the refusal must promise the tree was not touched");
		}
	});

	it("refuses a stale HEAD, naming both SHAs", () => {
		const r = verifyReviseWorktreeBinding("/wt", "feat/issue-498-x", OID, { exec: gitStub("feat/issue-498-x", OTHER) });
		assert.equal(r.ok, false);
		if (!r.ok) assert.ok(r.reason.includes(OTHER) && r.reason.includes(OID), `the refusal must name both the observed and expected SHA; got ${r.reason}`);
	});

	it("fails closed when git cannot be read in the worktree", () => {
		const r = verifyReviseWorktreeBinding("/wt", "feat/issue-498-x", OID, {
			exec: () => {
				throw new Error("not a git repository");
			},
		});
		assert.equal(r.ok, false);
		if (!r.ok) assert.ok(r.reason.includes("not a git repository"));
	});
});
