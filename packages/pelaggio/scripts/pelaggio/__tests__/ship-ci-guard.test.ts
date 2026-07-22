import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GhRunner } from "../roadmap/github-issues.js";
import { assertCiGreen, assertCiNotRed } from "../ship/ci-guard.js";

function makeGh(response: { stdout?: string; stderr?: string; status?: number }): { gh: GhRunner; calls: string[][] } {
	const calls: string[][] = [];
	const gh: GhRunner = (args) => {
		calls.push(args);
		return { stdout: response.stdout ?? "", stderr: response.stderr ?? "", status: response.status ?? 0 };
	};
	return { gh, calls };
}

const GREEN_ROLLUP = JSON.stringify({
	statusCheckRollup: [
		{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
		{ __typename: "StatusContext", context: "review", state: "SUCCESS" },
	],
});
const RED_CHECK_RUN = JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }] });
const RED_STATUS_CONTEXT = JSON.stringify({ statusCheckRollup: [{ __typename: "StatusContext", context: "review", state: "FAILURE" }] });
const PENDING_ROLLUP = JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS" }] });
const NEUTRAL_ROLLUP = JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "NEUTRAL" }] });

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
		assert.deepEqual(calls[0], ["pr", "view", "42", "--repo", "acme/widget", "--json", "statusCheckRollup"]);
	});
});

describe("assertCiGreen — immediate/--admin merge guard", () => {
	it("passes on an all-green rollup", () => {
		assert.doesNotThrow(() => assertCiGreen(makeGh({ stdout: GREEN_ROLLUP }).gh, 42));
	});

	it("passes on a neutral/skipped conclusion", () => {
		assert.doesNotThrow(() => assertCiGreen(makeGh({ stdout: NEUTRAL_ROLLUP }).gh, 42));
	});

	it("refuses on a still-pending check (unlike assertCiNotRed)", () => {
		assert.throws(() => assertCiGreen(makeGh({ stdout: PENDING_ROLLUP }).gh, 42), /red-merge guard.*not yet green.*pending/);
	});

	it("refuses on an empty rollup — never fails open", () => {
		assert.throws(() => assertCiGreen(makeGh({ stdout: JSON.stringify({ statusCheckRollup: [] }) }).gh, 42), /red-merge guard.*no CI status found/);
	});

	it("refuses on a red CheckRun conclusion", () => {
		assert.throws(() => assertCiGreen(makeGh({ stdout: RED_CHECK_RUN }).gh, 42), /red-merge guard.*CI is red/);
	});

	it("fails closed on a gh error", () => {
		assert.throws(() => assertCiGreen(makeGh({ stderr: "not authenticated", status: 1 }).gh, 42), /red-merge guard.*could not read CI status/);
	});
});
