import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ReviewLoopResult } from "../review/loop.js";
import { type DocReviewRecord, type ReviewRecord, renderDocReviewRecord, renderReviewRecord, validateDocReviewRecord, validateReviewRecord, writeDocReviewRecord, writeReviewRecord } from "../review/record.js";

const DIGEST = "a".repeat(64);

const cleanResult: ReviewLoopResult = {
	outcome: "converged-clean",
	diversity: { state: "met" },
	passes: [
		{
			pass: 1,
			reviewers: [{ identity: { role: "reviewer", seatId: "grok", provider: "grok", sessionId: "s" }, ok: true, cost: 0, turns: 1, verdict: { verdict: "pass", rationale: "ok" } }],
			judge: { identity: { role: "judge", seatId: "judge", provider: "claude", sessionId: "j" }, valid: true, cost: 0, turns: 1 },
			carriedBefore: [],
			carriedAfter: [],
		},
	],
	survivors: [],
	notes: [],
	cost: 0.12,
	safetyFloor: "disabled",
	safetyFloorNote: "document review: code-diff path-signal floor not applied",
};

const record = (): DocReviewRecord => ({
	schemaVersion: 1,
	runId: "doc-abc123-run",
	createdAt: new Date("2026-08-03T00:00:00Z").toISOString(),
	document: { path: "docs/plans/384.md", digest: DIGEST, byteLength: 4096 },
	blockingBar: "must-fix",
	safetyFloor: "disabled",
	safetyFloorNote: "document review: code-diff path-signal floor not applied",
	result: cleanResult,
});

const authoringResult: ReviewLoopResult = {
	outcome: "converged-clean",
	diversity: { state: "met" },
	passes: [
		{
			pass: 1,
			reviewers: [{ identity: { role: "reviewer", seatId: "codex", provider: "codex", sessionId: "s" }, ok: true, cost: 0, turns: 1, verdict: { verdict: "pass", rationale: "ok" } }],
			judge: { identity: { role: "judge", seatId: "judge", provider: "claude", sessionId: "j" }, valid: true, cost: 0, turns: 1 },
			carriedBefore: [],
			carriedAfter: [],
		},
	],
	survivors: [],
	notes: [],
	cost: 0.05,
	safetyFloor: "enabled",
};

const authoringRecord = (stage: "plan" | "code"): ReviewRecord => ({
	schemaVersion: 1,
	runId: `cycle-1-277-${stage}`,
	itemId: "277",
	stage,
	createdAt: new Date("2026-08-03T00:00:00Z").toISOString(),
	blockingBar: "must-fix",
	result: authoringResult,
});

describe("DocReviewRecord (#384)", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "pelaggio-rec-"));
	});
	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes a path+digest-bound record atomically under .dev/doc-review-records", () => {
		const path = writeDocReviewRecord(dir, record());
		assert.equal(path, join(dir, ".dev", "doc-review-records", "doc-abc123-run.json"));
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		assert.equal(parsed.document.digest, DIGEST);
		assert.equal(parsed.safetyFloor, "disabled");
		assert.equal(parsed.result.outcome, "converged-clean");
	});

	it("renders the document binding, disabled safety floor, outcome, and diversity", () => {
		const md = renderDocReviewRecord(record());
		assert.match(md, /## Document review record/);
		assert.match(md, /docs\/plans\/384\.md/);
		assert.match(md, new RegExp(DIGEST));
		assert.match(md, /Safety floor: \*\*disabled\*\*/);
		assert.match(md, /Outcome: \*\*converged-clean\*\*/);
		assert.match(md, /Diversity: \*\*met\*\*/);
	});

	it("rejects a malformed digest and a non-disabled floor", () => {
		assert.throws(() => validateDocReviewRecord({ ...record(), document: { path: "d.md", digest: "nope", byteLength: 1 } }), /document binding/);
		assert.throws(() => validateDocReviewRecord({ ...record(), safetyFloor: "enabled" as "disabled" }), /safety floor must be disabled/);
	});
});

describe("ReviewRecord stage binding (#277)", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "pelaggio-auth-rec-"));
	});
	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("requires stage and rejects a missing stage (never defaults to code)", () => {
		assert.throws(() => validateReviewRecord({ ...authoringRecord("code"), stage: undefined as unknown as "code" }), /stage/);
		assert.throws(() => validateReviewRecord({ ...authoringRecord("code"), stage: "ship" as "code" }), /stage/);
	});

	it("writes plan and code records under distinct runIds and surfaces stage in render", () => {
		const planPath = writeReviewRecord(dir, authoringRecord("plan"));
		const codePath = writeReviewRecord(dir, authoringRecord("code"));
		assert.equal(planPath, join(dir, ".dev", "review-records", "cycle-1-277-plan.json"));
		assert.equal(codePath, join(dir, ".dev", "review-records", "cycle-1-277-code.json"));
		assert.notEqual(planPath, codePath);

		const planMd = renderReviewRecord(authoringRecord("plan"));
		const codeMd = renderReviewRecord(authoringRecord("code"));
		assert.match(planMd, /Stage: \*\*plan\*\*/);
		assert.match(codeMd, /Stage: \*\*code\*\*/);
		assert.match(planMd, /Outcome: \*\*converged-clean\*\*/);
	});
});
