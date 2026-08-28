import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { CONFIG } from "../config.js";
import { DOC_REVIEW_SAFETY_FLOOR_NOTE, main, resolveDocReviewPolicy, reviewDocument, setDocReviewDepsForTests } from "../doc-review-cli.js";
import { snapshotDocument } from "../review/document.js";
import type { StepResult } from "../types.js";

// Pin the review pool: diversity assertions ("met" needs three distinct providers)
// must not float with the host .pelaggio.yml, whose pools shrink operationally
// (e.g. a provider's balance running out).
const TEST_CONFIG = ((): typeof CONFIG => {
	const c = JSON.parse(JSON.stringify(CONFIG)) as typeof CONFIG;
	// JSON cloning isolates mutable seating arrays but cannot preserve the resolved taxonomy's Map.
	c.review.taxonomy = CONFIG.review.taxonomy;
	for (const selections of Object.values(c.profileProviders)) {
		if (selections["pr-review"]) selections["pr-review"] = ["claude", "codex", "grok"];
	}
	c.review.authoring.reviewers = [
		{ id: "claude", provider: "claude" },
		{ id: "codex", provider: "codex" },
		{ id: "grok", provider: "grok" },
	] as typeof c.review.authoring.reviewers;
	return c;
})();

const ok = (text: string): StepResult => ({ ok: true, subtype: "success", text, fullText: text, assistantText: text, cost: 0, turns: 1 });
const findings = (raw: unknown[]) => `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "s", findings: raw })}\nEND_AUTHORING_REVIEW_FINDINGS`;
const judge = (decisions: unknown[]) => `AUTHORING_REVIEW_JUDGE\n${JSON.stringify({ schemaVersion: 1, decisions })}\nEND_AUTHORING_REVIEW_JUDGE`;
const CLEAN = findings([]);
const BLOCK = findings([{ severity: "must-fix", message: "section 2 contradicts section 4", ruleId: "pelaggio/judgment/style" }]);

/** Canned runStep: reviewers (pr-review) → findings, judge (pr-verify) → judge report. */
const cannedRunStep = (reviewer: string, judgeBody: string, sink?: Array<{ name: string; prompt: string; cwd: string; itemId?: string; workspaceAccess?: "read-only" }>) => {
	return (async (name, prompt, opts) => {
		sink?.push({ name, prompt, cwd: opts.cwd, itemId: opts.itemId, workspaceAccess: opts.workspaceAccess });
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
		const result = await reviewDocument({ snapshot, cwd: dir, config: TEST_CONFIG, runStep: cannedRunStep(CLEAN, judge([])), clock });
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
		const result = await reviewDocument({ snapshot, cwd: dir, config: TEST_CONFIG, runStep: cannedRunStep(BLOCK, judge([{ candidateId: "C1", decision: "survives", rationale: "real", ruling: "fixable-blocker" }])), clock });
		assert.equal(result.exitCode, 1);
		assert.equal(result.outcome, "hard-block");
	});

	it("seats run as pr-review/pr-verify on the plain cwd with --document args, no author role, no itemId, no seat worktree", async () => {
		const path = writeDoc("seats.md", "# Design\n\nInspect me.\n");
		const snapshot = snapshotDocument(path);
		const calls: Array<{ name: string; prompt: string; cwd: string; itemId?: string; workspaceAccess?: "read-only" }> = [];
		await reviewDocument({ snapshot, cwd: dir, config: TEST_CONFIG, runStep: cannedRunStep(CLEAN, judge([]), calls), clock });
		assert.ok(calls.length >= 2);
		// Only pr-review / pr-verify — never an author (shakedown-code) or any other step.
		assert.deepEqual([...new Set(calls.map((c) => c.name))].sort(), ["pr-review", "pr-verify"]);
		// Plain cwd (never a detached authoring-review-seat checkout) and no roadmap item.
		for (const call of calls) {
			assert.equal(call.cwd, dir);
			assert.doesNotMatch(call.cwd, /authoring-review-seats/);
			assert.equal(call.itemId, undefined);
			assert.equal(call.workspaceAccess, "read-only");
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
		const result = await reviewDocument({ snapshot, cwd: dir, config: TEST_CONFIG, runStep: cannedRunStep(CLEAN, judge([])), clock });
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

	it("does not write a transcript or descriptor when capture is disabled", async () => {
		const path = writeDoc("no-capture.md", "# Design\n\nAll good.\n");
		const snapshot = snapshotDocument(path);
		const result = await reviewDocument({ snapshot, cwd: dir, config: TEST_CONFIG, runStep: cannedRunStep("no block here", "no judge block"), clock });
		assert.equal(result.record?.failedSeatTranscript, undefined);
		assert.equal(existsSync(join(dir, ".dev", "doc-review-transcripts")), false);
	});

	it("does not write an empty transcript when capture is enabled and every seat is readable", async () => {
		const path = writeDoc("all-readable.md", "# Design\n\nAll good.\n");
		const snapshot = snapshotDocument(path);
		const result = await reviewDocument({ snapshot, cwd: dir, config: TEST_CONFIG, runStep: cannedRunStep(CLEAN, judge([])), clock, captureFailedSeats: true });
		assert.equal(result.exitCode, 0);
		assert.equal(result.record?.failedSeatTranscript, undefined);
		assert.equal(existsSync(join(dir, ".dev", "doc-review-transcripts")), false);
	});

	it("writes a private digest-bound transcript for unreadable seats and keeps raw text off the ordinary record", async () => {
		const planted = "PLANTED_SECRET=sk-planted-not-real ordinary prose";
		const path = writeDoc("unreadable.md", "# Design\n\nInspect me.\n");
		const snapshot = snapshotDocument(path);
		const result = await reviewDocument({
			snapshot,
			cwd: dir,
			config: TEST_CONFIG,
			runStep: cannedRunStep(planted, planted),
			clock,
			captureFailedSeats: true,
		});
		assert.ok(result.record?.failedSeatTranscript);
		const descriptor = result.record.failedSeatTranscript;
		assert.equal(descriptor.path, `.dev/doc-review-transcripts/${result.record.runId}.json`);
		assert.match(descriptor.sha256, /^[a-f0-9]{64}$/);
		const transcriptPath = join(dir, descriptor.path);
		assert.equal(statSync(transcriptPath).mode & 0o777, 0o600);
		const body = readFileSync(transcriptPath, "utf-8");
		assert.equal(createHash("sha256").update(body).digest("hex"), descriptor.sha256);
		const parsed = JSON.parse(body);
		assert.equal(parsed.schemaVersion, 1);
		assert.equal(parsed.runId, result.record.runId);
		assert.ok(parsed.seats.length > 0);
		for (const seat of parsed.seats) {
			assert.equal(typeof seat.assistantText, "string");
			assert.equal(seat.parseCode, "block-not-found");
			assert.equal("prompt" in seat, false);
			assert.equal("fullText" in seat, false);
			assert.equal("outputTail" in seat, false);
		}
		assert.match(body, /PLANTED_SECRET=sk-planted-not-real/);
		const ordinary = JSON.stringify(result.record);
		assert.equal(ordinary.includes("PLANTED_SECRET"), false);
		assert.equal(ordinary.includes("assistantText"), false);
		assert.doesNotMatch(result.body, /PLANTED_SECRET/);
		assert.match(result.body, /Failed-seat transcript \(local diagnostic, do not commit\)/);
	});

	it("keeps a planted secret out of --json and --out while capture is enabled", async () => {
		const planted = "PLANTED_SECRET=sk-planted-not-real";
		const path = writeDoc("secret-json.md", "# Plan\n\nsecret\n");
		const outPath = join(dir, "secret-report.json");
		const restore = setDocReviewDepsForTests({ runStep: cannedRunStep(planted, planted), clock });
		const previousCwd = process.cwd();
		const chunks: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			chunks.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			process.chdir(dir);
			await main([path, "--json", "--out", outPath, "--capture-failed-seats"]);
		} finally {
			process.stdout.write = originalWrite;
			process.chdir(previousCwd);
			restore();
		}
		const stdout = chunks.join("");
		assert.equal(stdout.includes("PLANTED_SECRET"), false);
		assert.equal(readFileSync(outPath, "utf-8").includes("PLANTED_SECRET"), false);
	});

	it("digest-changed still writes no success record; a captured transcript cannot authorize success", async () => {
		const planted = "PLANTED_SECRET=sk-planted-not-real";
		const path = writeDoc("mutate-capture.md", "# Original\n\nv1\n");
		const snapshot = snapshotDocument(path);
		writeFileSync(path, "# Tampered\n\nv2\n", "utf-8");
		const result = await reviewDocument({
			snapshot,
			cwd: dir,
			config: TEST_CONFIG,
			runStep: cannedRunStep(planted, planted),
			clock,
			captureFailedSeats: true,
		});
		assert.equal(result.exitCode, 1);
		assert.equal(result.outcome, "digest-changed");
		assert.equal(result.record, undefined);
		assert.equal(result.recordPath, undefined);
		const recordsDir = join(dir, ".dev", "doc-review-records");
		const written = existsSync(recordsDir) ? readdirSync(recordsDir) : [];
		assert.ok(!written.some((f) => f.includes(snapshot.digest.slice(0, 12))));
		const runId = `doc-${snapshot.digest.slice(0, 12)}-${T.toString(36)}`;
		assert.equal(existsSync(join(dir, ".dev", "doc-review-transcripts", `${runId}.json`)), true, "orphaned capture remains a local diagnostic and must not authorize success");
		assert.doesNotMatch(result.body, /PLANTED_SECRET/);
	});
});
