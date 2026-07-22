import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { main, parseLandArgs, runLand } from "../land-cli.js";
import type { GhRunner } from "../roadmap/github-issues.js";

function makeGh(responses: Array<{ match: string[]; stdout?: string; stderr?: string; status?: number }>): { gh: GhRunner; calls: string[][] } {
	const calls: string[][] = [];
	const gh: GhRunner = (args) => {
		calls.push(args);
		const next = responses.shift();
		assert.ok(next, `unexpected gh call: ${args.join(" ")}`);
		assert.deepEqual(args.slice(0, next.match.length), next.match);
		return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", status: next.status ?? 0 };
	};
	return { gh, calls };
}

const HEAD = "abc123headoid";
const GREEN = JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }], headRefOid: HEAD });
const RED = JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }], headRefOid: HEAD });
const PENDING = JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS" }], headRefOid: HEAD });

describe("parseLandArgs", () => {
	it("parses --pr, --admin, --repo", () => {
		assert.deepEqual(parseLandArgs(["--pr", "42", "--admin", "--repo", "acme/widget"]), { kind: "run", pr: 42, admin: true, ghRepo: "acme/widget" });
	});

	it("defaults admin to false and repo to undefined", () => {
		assert.deepEqual(parseLandArgs(["--pr", "42"]), { kind: "run", pr: 42, admin: false, ghRepo: undefined });
	});

	it("errors on a missing or non-numeric --pr", () => {
		assert.equal(parseLandArgs([]).kind, "error");
		assert.equal(parseLandArgs(["--pr", "nope"]).kind, "error");
	});

	it("errors on an unknown flag", () => {
		assert.equal(parseLandArgs(["--pr", "1", "--bogus"]).kind, "error");
	});
});

describe("runLand", () => {
	it("merges (without --admin) once CI is confirmed green", () => {
		const { gh, calls } = makeGh([
			{ match: ["pr", "view"], stdout: GREEN },
			{ match: ["pr", "merge"], stdout: "" },
		]);
		const log: string[] = [];
		const code = runLand({ pr: 42, admin: false, ghRepo: "acme/widget", requiredChecks: ["ci"] }, { gh, log: (m) => log.push(m) });
		assert.equal(code, 0);
		assert.deepEqual(calls[1], ["pr", "merge", "42", "--repo", "acme/widget", "--squash", "--delete-branch", "--match-head-commit", HEAD]);
		assert.match(log.join("\n"), /merged PR #42/);
	});

	it("adds --admin only when requested, and CI-green is still required", () => {
		const { gh, calls } = makeGh([
			{ match: ["pr", "view"], stdout: GREEN },
			{ match: ["pr", "merge"], stdout: "" },
		]);
		const code = runLand({ pr: 42, admin: true, ghRepo: "acme/widget", requiredChecks: ["ci"] }, { gh, log: () => {} });
		assert.equal(code, 0);
		assert.deepEqual(calls[1], ["pr", "merge", "42", "--repo", "acme/widget", "--squash", "--delete-branch", "--match-head-commit", HEAD, "--admin"]);
	});

	it("refuses to merge a red PR even with --admin (#292)", () => {
		const { gh, calls } = makeGh([{ match: ["pr", "view"], stdout: RED }]);
		const log: string[] = [];
		const code = runLand({ pr: 42, admin: true, ghRepo: "acme/widget", requiredChecks: ["ci"] }, { gh, log: (m) => log.push(m) });
		assert.equal(code, 1);
		assert.match(log.join("\n"), /red-merge guard.*CI is red/);
		assert.ok(!calls.some((c) => c[0] === "pr" && c[1] === "merge"), "must never call gh pr merge on a red PR");
	});

	it("refuses to merge on a still-pending PR — the --admin path requires terminal green", () => {
		const { gh } = makeGh([{ match: ["pr", "view"], stdout: PENDING }]);
		const log: string[] = [];
		const code = runLand({ pr: 42, admin: true, ghRepo: "acme/widget", requiredChecks: ["ci"] }, { gh, log: (m) => log.push(m) });
		assert.equal(code, 1);
		assert.match(log.join("\n"), /not yet green/);
	});

	it("refuses when the required `ci` check has not reported, even though `review` is green (#292 fail-open on --admin)", () => {
		const REVIEW_ONLY = JSON.stringify({ statusCheckRollup: [{ __typename: "StatusContext", context: "review", state: "SUCCESS" }], headRefOid: HEAD });
		const { gh, calls } = makeGh([{ match: ["pr", "view"], stdout: REVIEW_ONLY }]);
		const log: string[] = [];
		const code = runLand({ pr: 42, admin: true, ghRepo: "acme/widget", requiredChecks: ["ci"] }, { gh, log: (m) => log.push(m) });
		assert.equal(code, 1);
		assert.match(log.join("\n"), /have not reported.*ci/);
		assert.ok(!calls.some((c) => c[0] === "pr" && c[1] === "merge"), "must never admin-merge with the required check unreported");
	});

	it("escape hatch: an empty required set lets a no-CI repo land (green-less rollup)", () => {
		const { gh, calls } = makeGh([
			{ match: ["pr", "view"], stdout: JSON.stringify({ statusCheckRollup: [], headRefOid: HEAD }) },
			{ match: ["pr", "merge"], stdout: "" },
		]);
		const code = runLand({ pr: 42, admin: true, ghRepo: "acme/widget", requiredChecks: [] }, { gh, log: () => {} });
		assert.equal(code, 0);
		assert.ok(
			calls.some((c) => c[0] === "pr" && c[1] === "merge"),
			"empty required set is the opt-out escape hatch",
		);
	});

	it("surfaces a gh merge failure as exit 1", () => {
		const { gh } = makeGh([
			{ match: ["pr", "view"], stdout: GREEN },
			{ match: ["pr", "merge"], stderr: "branch protection: required review missing", status: 1 },
		]);
		const log: string[] = [];
		const code = runLand({ pr: 42, admin: false, ghRepo: "acme/widget", requiredChecks: ["ci"] }, { gh, log: (m) => log.push(m) });
		assert.equal(code, 1);
		assert.match(log.join("\n"), /merge failed.*required review missing/);
	});
});

describe("main", () => {
	it("exits 2 on usage error without calling gh", () => {
		let ghCalled = false;
		const gh: GhRunner = () => {
			ghCalled = true;
			return { stdout: "", stderr: "", status: 0 };
		};
		const code = main([], { gh, log: () => {} });
		assert.equal(code, 2);
		assert.equal(ghCalled, false);
	});

	it("uses the explicit --repo over any configured default", () => {
		const { gh, calls } = makeGh([
			{ match: ["pr", "view"], stdout: GREEN },
			{ match: ["pr", "merge"], stdout: "" },
		]);
		const code = main(["--pr", "7", "--repo", "acme/widget"], { gh, log: () => {} });
		assert.equal(code, 0);
		assert.deepEqual(calls[0], ["pr", "view", "7", "--repo", "acme/widget", "--json", "statusCheckRollup,headRefOid"]);
	});
});
