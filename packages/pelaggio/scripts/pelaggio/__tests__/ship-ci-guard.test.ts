import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GhRunner } from "../roadmap/github-issues.js";
import { assertCiGreen, assertCiNotRed, fetchPrLanding } from "../ship/ci-guard.js";

function makeGh(response: { stdout?: string; stderr?: string; status?: number }): { gh: GhRunner; calls: string[][] } {
	const calls: string[][] = [];
	const gh: GhRunner = (args) => {
		calls.push(args);
		return { stdout: response.stdout ?? "", stderr: response.stderr ?? "", status: response.status ?? 0 };
	};
	return { gh, calls };
}

describe("fetchPrLanding", () => {
	it("fails closed and returns a validated merge commit", () => {
		assert.deepEqual(fetchPrLanding(makeGh({ stdout: "[]" }).gh, "o/r", "feat/issue-1", "head-1"), { state: "not-merged" });
		assert.deepEqual(fetchPrLanding(makeGh({ stdout: JSON.stringify([{ number: 2, mergeCommit: { oid: "abc" }, headRefOid: "head-2" }]) }).gh, "o/r", "feat/issue-2", "head-2"), {
			state: "merged",
			prNumber: 2,
			mergeCommitOid: "abc",
		});
		assert.deepEqual(fetchPrLanding(makeGh({ stdout: "not-json" }).gh, "o/r", "feat/issue-2", "head-2"), { state: "unknown" });
		assert.deepEqual(fetchPrLanding(makeGh({ stdout: JSON.stringify([{ number: 2, mergeCommit: null, headRefOid: "head-2" }]) }).gh, "o/r", "feat/issue-2", "head-2"), { state: "unknown" });
	});

	it("does not accept a historical merge for a reused branch name", () => {
		const historical = JSON.stringify([{ number: 1, mergeCommit: { oid: "merged-old" }, headRefOid: "old-head" }]);
		assert.deepEqual(fetchPrLanding(makeGh({ stdout: historical }).gh, "o/r", "feat/issue-2", "new-head"), { state: "not-merged" });
	});

	it("selects the merged PR whose head matches the current branch tip", () => {
		const reused = JSON.stringify([
			{ number: 1, mergeCommit: { oid: "merged-old" }, headRefOid: "old-head" },
			{ number: 2, mergeCommit: { oid: "merged-current" }, headRefOid: "current-head" },
		]);
		assert.deepEqual(fetchPrLanding(makeGh({ stdout: reused }).gh, "o/r", "feat/issue-2", "current-head"), { state: "merged", prNumber: 2, mergeCommitOid: "merged-current" });
	});
});

const HEAD = "abc123headoid";
// A PR-view JSON with a resolvable head oid (required for assertCiGreen to pin the merge).
const pr = (entries: unknown[], headRefOid: string | undefined = HEAD) => JSON.stringify({ statusCheckRollup: entries, headRefOid });

const GREEN_ROLLUP = pr([
	{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
	{ __typename: "StatusContext", context: "review", state: "SUCCESS" },
]);
const RED_CHECK_RUN = pr([{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }]);
const RED_STATUS_CONTEXT = pr([{ __typename: "StatusContext", context: "review", state: "FAILURE" }]);
const PENDING_ROLLUP = pr([{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS" }]);
const NEUTRAL_ROLLUP = pr([{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "NEUTRAL" }]);

describe("assertCiNotRed — pipeline auto-merge-pr guard", () => {
	it("passes on an all-green rollup", () => {
		assert.doesNotThrow(() => assertCiNotRed(makeGh({ stdout: GREEN_ROLLUP }).gh, 42));
	});

	it("passes on a pending rollup (deferred merge will wait)", () => {
		assert.doesNotThrow(() => assertCiNotRed(makeGh({ stdout: PENDING_ROLLUP }).gh, 42));
	});

	it("passes on an empty rollup (checks not yet reported)", () => {
		assert.doesNotThrow(() => assertCiNotRed(makeGh({ stdout: JSON.stringify({ statusCheckRollup: [] }) }).gh, 42));
	});

	it("refuses on a red CheckRun conclusion", () => {
		assert.throws(() => assertCiNotRed(makeGh({ stdout: RED_CHECK_RUN }).gh, 42), /red-merge guard.*CI is red.*ci/);
	});

	it("refuses on a red StatusContext state", () => {
		assert.throws(() => assertCiNotRed(makeGh({ stdout: RED_STATUS_CONTEXT }).gh, 42), /red-merge guard.*CI is red.*review/);
	});

	it("fails closed on a gh error", () => {
		assert.throws(() => assertCiNotRed(makeGh({ stderr: "auth failed", status: 1 }).gh, 42), /red-merge guard.*could not read CI status.*auth failed/);
	});

	it("fails closed on unparseable JSON", () => {
		assert.throws(() => assertCiNotRed(makeGh({ stdout: "not json" }).gh, 42), /red-merge guard.*could not parse CI status/);
	});

	it("passes the PR number and optional repo through to gh", () => {
		const { gh, calls } = makeGh({ stdout: GREEN_ROLLUP });
		assertCiNotRed(gh, 42, "acme/widget");
		assert.deepEqual(calls[0], ["pr", "view", "42", "--repo", "acme/widget", "--json", "statusCheckRollup,headRefOid"]);
	});
});

describe("assertCiGreen — immediate/--admin merge guard", () => {
	it("passes when the required check is present + green, and returns the verified head oid to pin the merge", () => {
		assert.equal(assertCiGreen(makeGh({ stdout: GREEN_ROLLUP }).gh, 42, ["ci"]), HEAD);
	});

	it("passes on a neutral/skipped conclusion for a required check", () => {
		// NEUTRAL_ROLLUP is [lint: NEUTRAL]; neutral counts as green for the required `lint`.
		assert.doesNotThrow(() => assertCiGreen(makeGh({ stdout: NEUTRAL_ROLLUP }).gh, 42, ["lint"]));
	});

	it("refuses when a REQUIRED check is absent from the rollup (#292 fail-open) — e.g. only `review` reported, `ci` not yet created", () => {
		const REVIEW_ONLY = pr([{ __typename: "StatusContext", context: "review", state: "SUCCESS" }]);
		assert.throws(() => assertCiGreen(makeGh({ stdout: REVIEW_ONLY }).gh, 42, ["ci"]), /red-merge guard.*have not reported.*ci/);
	});

	it("refuses on a still-pending required check (unlike assertCiNotRed)", () => {
		assert.throws(() => assertCiGreen(makeGh({ stdout: PENDING_ROLLUP }).gh, 42, ["ci"]), /red-merge guard.*not yet green.*ci/);
	});

	it("refuses on an empty rollup — the required check is missing, never fails open", () => {
		assert.throws(() => assertCiGreen(makeGh({ stdout: pr([]) }).gh, 42, ["ci"]), /red-merge guard.*have not reported.*ci/);
	});

	it("refuses on a red NON-required check (red blocks any merge, required or not)", () => {
		const RED_NON_REQUIRED = pr([
			{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
			{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
		]);
		assert.throws(() => assertCiGreen(makeGh({ stdout: RED_NON_REQUIRED }).gh, 42, ["ci"]), /red-merge guard.*CI is red.*lint/);
	});

	it("escape hatch: an empty required set tolerates an empty rollup (no gating CI)", () => {
		assert.equal(assertCiGreen(makeGh({ stdout: pr([]) }).gh, 42, []), HEAD);
	});

	it("escape hatch still refuses a reported-red check", () => {
		assert.throws(() => assertCiGreen(makeGh({ stdout: RED_CHECK_RUN }).gh, 42, []), /red-merge guard.*CI is red/);
	});

	it("requires ALL instances of a required check to be green (one pending re-run refuses)", () => {
		const SPLIT = pr([
			{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
			{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS" },
		]);
		assert.throws(() => assertCiGreen(makeGh({ stdout: SPLIT }).gh, 42, ["ci"]), /red-merge guard.*not yet green.*ci/);
	});

	it("fails closed when the PR head oid cannot be resolved (cannot pin the merge)", () => {
		// Construct directly (not via `pr`, whose default would re-inject a head oid) so headRefOid is absent.
		const NO_HEAD = JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] });
		assert.throws(() => assertCiGreen(makeGh({ stdout: NO_HEAD }).gh, 42, ["ci"]), /red-merge guard.*could not resolve the PR head/);
	});

	it("fails closed on a gh error", () => {
		assert.throws(() => assertCiGreen(makeGh({ stderr: "not authenticated", status: 1 }).gh, 42, ["ci"]), /red-merge guard.*could not read CI status/);
	});
});
