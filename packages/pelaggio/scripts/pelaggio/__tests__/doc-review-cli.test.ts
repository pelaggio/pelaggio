import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { CONFIG } from "../config.js";
import { DOC_REVIEW_SAFETY_FLOOR_NOTE, main, resolveDocReviewPolicy, reviewDocument, setDocReviewDepsForTests } from "../doc-review-cli.js";
import { snapshotDocument } from "../review/document.js";
import type { StepResult } from "../types.js";

const ok = (text: string): StepResult => ({ ok: true, subtype: "success", text, fullText: text, assistantText: text, cost: 0, turns: 1 });
const findings = (raw: unknown[]) => `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "s", findings: raw })}\nEND_AUTHORING_REVIEW_FINDINGS`;
const judge = (decisions: unknown[]) => `AUTHORING_REVIEW_JUDGE\n${JSON.stringify({ schemaVersion: 1, decisions })}\nEND_AUTHORING_REVIEW_JUDGE`;
const CLEAN = findings([]);
const BLOCK = findings([{ severity: "must-fix", message: "section 2 contradicts section 4", ruleId: "pelaggio/judgment/style" }]);

/** Canned runStep: reviewers (pr-review) → findings, judge (pr-verify) → judge report. */
const cannedRunStep = (reviewer: string, judgeBody: string, sink?: Array<{ name: string; prompt: string; cwd: string; itemId?: string }>) => {
	return (async (name, prompt, opts) => {
		sink?.push({ name, prompt, cwd: opts.cwd, itemId: opts.itemId });
		return ok(name === "pr-verify" ? judgeBody : reviewer);
	}) as Parameters<typeof reviewDocument>[0]["runStep"];
};

const T = 1_700_000_000_000;
const clock = () => T;

describe("doc-review CLI (#384)", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "pelaggio-docrev-"));
	});
	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	afterEach(() => {
		// Nothing to restore unless a test set deps; those restore inline.
	});

	const writeDoc = (name: string, body: string): string => {
		const path = join(dir, name);
		writeFileSync(path, body, "utf-8");
		return path;
	};

	it("usage: no positional path → exit 2", async () => {
		assert.equal(await main([]), 2);
	});

	it("usage: two positionals → exit 2", async () => {
		assert.equal(await main(["a.md", "b.md"]), 2);
	});

	it("missing path → exit 2 (input error, no report)", async () => {
		assert.equal(await main([join(dir, "does-not-exist.md")]), 2);
	});

	it("clean multi-seat review → exit 0 with a path+digest-bound report", async () => {
		const path = writeDoc("clean.md", "# Design\n\nAll good.\n");
		const snapshot = snapshotDocument(path);
		const result = await reviewDocument({ snapshot, cwd: dir, config: CONFIG, runStep: cannedRunStep(CLEAN, judge([])), clock });
		assert.equal(result.exitCode, 0);
		assert.equal(result.outcome, "converged-clean");
		assert.ok(result.recordPath && existsSync(result.recordPath));
		const parsed = JSON.parse(readFileSync(result.recordPath, "utf-8"));
		assert.equal(parsed.document.digest, snapshot.digest);
		assert.equal(parsed.document.path, snapshot.path);
		assert.equal(parsed.safetyFloor, "disabled");
		assert.equal(parsed.safetyFloorNote, DOC_REVIEW_SAFETY_FLOOR_NOTE);
		assert.equal(parsed.result.diversity.state, "met");
	});

	it("blocking survivor → exit 1", async () => {
		const path = writeDoc("block.md", "# Design\n\nContradictory.\n");
		const snapshot = snapshotDocument(path);
		const result = await reviewDocument({ snapshot, cwd: dir, config: CONFIG, runStep: cannedRunStep(BLOCK, judge([{ candidateId: "C1", decision: "survives", rationale: "real", ruling: "fixable-blocker" }])), clock });
		assert.equal(result.exitCode, 1);
		assert.equal(result.outcome, "hard-block");
	});

	it("seats run as pr-review/pr-verify on the plain cwd with --document args, no author role, no itemId, no seat worktree", async () => {
		const path = writeDoc("seats.md", "# Design\n\nInspect me.\n");
		const snapshot = snapshotDocument(path);
		const calls: Array<{ name: string; prompt: string; cwd: string; itemId?: string }> = [];
		await reviewDocument({ snapshot, cwd: dir, config: CONFIG, runStep: cannedRunStep(CLEAN, judge([]), calls), clock });
		assert.ok(calls.length >= 2);
		// Only pr-review / pr-verify — never an author (shakedown-code) or any other step.
		assert.deepEqual([...new Set(calls.map((c) => c.name))].sort(), ["pr-review", "pr-verify"]);
		// Plain cwd (never a detached authoring-review-seat checkout) and no roadmap item.
		for (const call of calls) {
			assert.equal(call.cwd, dir);
			assert.doesNotMatch(call.cwd, /authoring-review-seats/);
			assert.equal(call.itemId, undefined);
		}
		const reviewerCall = calls.find((c) => c.name === "pr-review");
		assert.ok(reviewerCall);
		assert.match(reviewerCall.prompt, /Arguments: --document/);
		assert.match(reviewerCall.prompt, /## DOCUMENT UNDER REVIEW/);
		assert.match(reviewerCall.prompt, new RegExp(snapshot.digest));
		const judgeCall = calls.find((c) => c.name === "pr-verify");
		assert.ok(judgeCall);
		assert.match(judgeCall.prompt, /--authoring-loop-judge/);
		assert.match(judgeCall.prompt, /TRUSTED_CANDIDATE_DATA/);
	});

	it("mid-run file change → exit 1 without a success report", async () => {
		const path = writeDoc("mutate.md", "# Original\n\nv1\n");
		const snapshot = snapshotDocument(path);
		// The file changes on disk after the snapshot but before the digest re-verification.
		writeFileSync(path, "# Tampered\n\nv2\n", "utf-8");
		const result = await reviewDocument({ snapshot, cwd: dir, config: CONFIG, runStep: cannedRunStep(CLEAN, judge([])), clock });
		assert.equal(result.exitCode, 1);
		assert.equal(result.outcome, "digest-changed");
		assert.equal(result.record, undefined);
		assert.equal(result.recordPath, undefined);
		// No record file was written for the changed input.
		const recordsDir = join(dir, ".dev", "doc-review-records");
		const written = existsSync(recordsDir) ? readdirSync(recordsDir) : [];
		assert.ok(!written.some((f) => f.includes(snapshot.digest.slice(0, 12))));
	});

	it("resolveDocReviewPolicy keeps every configured reviewer and forces maxRevisions:0", () => {
		const policy = resolveDocReviewPolicy(CONFIG, "standard");
		assert.equal(policy.maxRevisions, 0);
		assert.deepEqual(policy.reviewers.map((r) => r.provider).sort(), CONFIG.review.authoring.reviewers.map((r) => r.provider).sort());
	});

	it("main writes the JSON report to --out and prints JSON with --json (exit 0)", async () => {
		const path = writeDoc("main-json.md", "# Plan\n\nfine\n");
		const outPath = join(dir, "report.json");
		const restore = setDocReviewDepsForTests({ runStep: cannedRunStep(CLEAN, judge([])), clock });
		const previousCwd = process.cwd();
		const chunks: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			chunks.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		let code: number;
		try {
			process.chdir(dir);
			code = await main([path, "--json", "--out", outPath]);
		} finally {
			process.stdout.write = originalWrite;
			process.chdir(previousCwd);
			restore();
		}
		assert.equal(code, 0);
		assert.ok(existsSync(outPath));
		const outParsed = JSON.parse(readFileSync(outPath, "utf-8"));
		assert.equal(outParsed.document.digest, snapshotDocument(path).digest);
		// stdout carried the JSON record (not the markdown summary) under --json.
		const stdout = chunks.join("");
		assert.match(stdout, /"schemaVersion": 1/);
		assert.match(stdout, /"safetyFloor": "disabled"/);
	});
});
