import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mainWorktree } from "../git.js";
import {
	claimReviewRequest,
	completeReviewRequest,
	enqueueReviewRequest,
	listReviewRequests,
	type NewReviewRequest,
	REVIEW_CLAIM_STALE_MS,
	reclaimStaleReviewClaims,
	reviewRequestsDir,
	unclaimReviewRequest,
} from "../review-request-queue.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function tmpMain(): string {
	return mkdtempSync(join(tmpdir(), "pelaggio-review-queue-"));
}

function record(over: Partial<NewReviewRequest> = {}): NewReviewRequest {
	return { prNumber: 42, headSha: SHA_A, itemId: "387", headBranch: "feat/issue-387", enqueuedAt: "2026-08-03T12:00:00.000Z", ...over };
}

describe("review-request-queue — enqueue", () => {
	it("writes one record file under .dev/review-requests/ with mode 0o600", () => {
		const main = tmpMain();
		enqueueReviewRequest(main, record());
		const dir = reviewRequestsDir(main);
		assert.deepEqual(readdirSync(dir), [`42-${SHA_A}.json`]);
		const parsed = JSON.parse(readFileSync(join(dir, `42-${SHA_A}.json`), "utf8"));
		assert.deepEqual(parsed, { schemaVersion: 1, prNumber: 42, headSha: SHA_A, itemId: "387", headBranch: "feat/issue-387", enqueuedAt: "2026-08-03T12:00:00.000Z" });
		assert.equal(statSync(join(dir, `42-${SHA_A}.json`)).mode & 0o777, 0o600);
	});

	it("is idempotent on (prNumber, headSha): re-enqueue is a no-op single file", () => {
		const main = tmpMain();
		enqueueReviewRequest(main, record());
		enqueueReviewRequest(main, record({ enqueuedAt: "2026-08-03T13:00:00.000Z" }));
		const dir = reviewRequestsDir(main);
		assert.deepEqual(readdirSync(dir), [`42-${SHA_A}.json`]);
		// First write wins — the second (idempotent) enqueue must not overwrite the timestamp.
		assert.equal(JSON.parse(readFileSync(join(dir, `42-${SHA_A}.json`), "utf8")).enqueuedAt, "2026-08-03T12:00:00.000Z");
	});

	it("does not re-enqueue a key that is already claimed (in-flight)", () => {
		const main = tmpMain();
		enqueueReviewRequest(main, record());
		const dir = reviewRequestsDir(main);
		claimReviewRequest(dir, 42, SHA_A);
		enqueueReviewRequest(main, record());
		assert.deepEqual(readdirSync(dir).sort(), [`42-${SHA_A}.claimed`]);
	});

	it("a new head SHA is a distinct second file", () => {
		const main = tmpMain();
		enqueueReviewRequest(main, record());
		enqueueReviewRequest(main, record({ headSha: SHA_B }));
		assert.deepEqual(readdirSync(reviewRequestsDir(main)).sort(), [`42-${SHA_A}.json`, `42-${SHA_B}.json`]);
	});

	it("rejects an invalid prNumber or headSha (never a half-record)", () => {
		const main = tmpMain();
		assert.throws(() => enqueueReviewRequest(main, record({ prNumber: 0 })), /invalid prNumber/);
		assert.throws(() => enqueueReviewRequest(main, record({ headSha: "not-a-sha" })), /invalid headSha/);
		assert.equal(existsSync(reviewRequestsDir(main)), false, "no directory or file created on invalid input");
	});
});

describe("review-request-queue — enqueue redirects to the main worktree", () => {
	it("a write resolved through mainWorktree(worktree) lands in main's .dev, not the sibling worktree", () => {
		const parent = mkdtempSync(join(tmpdir(), "pelaggio-review-queue-wt-"));
		const main = join(parent, "main");
		mkdirSync(main);
		execSync("git init -q -b main", { cwd: main });
		execSync("git config user.name t && git config user.email t@t && git config commit.gpgsign false", { cwd: main });
		execSync("git commit --allow-empty -q -m init", { cwd: main });
		const wt = join(parent, "wt-387");
		execSync(`git worktree add -q -b feat/issue-387 ${wt}`, { cwd: main });

		// A ship worktree resolves the main tree before writing.
		enqueueReviewRequest(mainWorktree(wt), record());

		assert.equal(existsSync(join(reviewRequestsDir(main), `42-${SHA_A}.json`)), true, "record must land in the main worktree");
		assert.equal(existsSync(reviewRequestsDir(wt)), false, "record must not land in the sibling worktree's .dev");
	});
});

describe("review-request-queue — list", () => {
	it("returns pending records in stable FIFO order (enqueuedAt)", () => {
		const main = tmpMain();
		enqueueReviewRequest(main, record({ prNumber: 2, headSha: SHA_B, enqueuedAt: "2026-08-03T14:00:00.000Z" }));
		enqueueReviewRequest(main, record({ prNumber: 1, headSha: SHA_A, enqueuedAt: "2026-08-03T12:00:00.000Z" }));
		const listed = listReviewRequests(reviewRequestsDir(main));
		assert.deepEqual(
			listed.map((l) => l.record.prNumber),
			[1, 2],
		);
	});

	it("skips .claimed files, malformed JSON, and non-matching names fail-soft", () => {
		const main = tmpMain();
		const dir = reviewRequestsDir(main);
		enqueueReviewRequest(main, record());
		claimReviewRequest(dir, 42, SHA_A); // becomes .claimed → excluded from list
		enqueueReviewRequest(main, record({ prNumber: 7, headSha: SHA_B }));
		writeFileSync(join(dir, `9-${SHA_A}.json`), "{ not json"); // malformed → skipped
		writeFileSync(join(dir, "README.txt"), "ignore me"); // non-matching name → skipped
		const listed = listReviewRequests(dir);
		assert.deepEqual(
			listed.map((l) => l.record.prNumber),
			[7],
		);
	});

	it("a missing queue directory is an empty list, not an error", () => {
		assert.deepEqual(listReviewRequests(reviewRequestsDir(tmpMain())), []);
	});

	it("rejects a record whose filename disagrees with its content", () => {
		const main = tmpMain();
		const dir = reviewRequestsDir(main);
		mkdirSync(dir, { recursive: true });
		// Filename says PR 99 but the body says PR 42 → tamper-guard drops it.
		writeFileSync(join(dir, `99-${SHA_A}.json`), JSON.stringify({ schemaVersion: 1, ...record() }));
		assert.deepEqual(listReviewRequests(dir), []);
	});
});

describe("review-request-queue — claim / complete / unclaim", () => {
	it("claim renames to .claimed; a second claim returns null", () => {
		const main = tmpMain();
		const dir = reviewRequestsDir(main);
		enqueueReviewRequest(main, record());
		const claimed = claimReviewRequest(dir, 42, SHA_A);
		assert.ok(claimed?.endsWith(`42-${SHA_A}.claimed`));
		assert.equal(existsSync(join(dir, `42-${SHA_A}.json`)), false);
		assert.equal(claimReviewRequest(dir, 42, SHA_A), null, "re-claim of the same key is null");
	});

	it("complete removes both pending and claimed forms", () => {
		const main = tmpMain();
		const dir = reviewRequestsDir(main);
		enqueueReviewRequest(main, record());
		claimReviewRequest(dir, 42, SHA_A);
		completeReviewRequest(dir, 42, SHA_A);
		assert.deepEqual(readdirSync(dir), []);
	});

	it("unclaim renames .claimed back to pending (park handback)", () => {
		const main = tmpMain();
		const dir = reviewRequestsDir(main);
		enqueueReviewRequest(main, record());
		claimReviewRequest(dir, 42, SHA_A);
		unclaimReviewRequest(dir, 42, SHA_A);
		assert.deepEqual(readdirSync(dir), [`42-${SHA_A}.json`]);
		// The record is once again eligible for the next drain.
		assert.equal(listReviewRequests(dir).length, 1);
	});
});

describe("review-request-queue — stale reclaim", () => {
	it("reclaims a .claimed file older than the stale window back to pending", () => {
		const main = tmpMain();
		const dir = reviewRequestsDir(main);
		enqueueReviewRequest(main, record());
		claimReviewRequest(dir, 42, SHA_A);
		const claimedFile = join(dir, `42-${SHA_A}.claimed`);
		const old = new Date("2026-08-03T00:00:00.000Z");
		utimesSync(claimedFile, old, old);
		const now = Date.parse("2026-08-03T00:00:00.000Z") + REVIEW_CLAIM_STALE_MS + 1;
		reclaimStaleReviewClaims(dir, now);
		assert.deepEqual(readdirSync(dir), [`42-${SHA_A}.json`]);
	});

	it("leaves a fresh .claimed file in place", () => {
		const main = tmpMain();
		const dir = reviewRequestsDir(main);
		enqueueReviewRequest(main, record());
		claimReviewRequest(dir, 42, SHA_A);
		const claimedFile = join(dir, `42-${SHA_A}.claimed`);
		const mtime = statSync(claimedFile).mtimeMs;
		reclaimStaleReviewClaims(dir, mtime + 1_000); // 1s later — well within the window
		assert.deepEqual(readdirSync(dir), [`42-${SHA_A}.claimed`]);
	});
});
