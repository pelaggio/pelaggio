import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ReviewLoopResult } from "../review/loop.js";
import { type DocReviewRecord, type DocReviewSeatTranscriptRecord, renderDocReviewRecord, validateDocReviewRecord, writeDocReviewRecord, writeDocReviewSeatTranscript } from "../review/record.js";

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

	it("accepts a POSIX-relative failed-seat transcript descriptor and rejects traversal or absolute paths", () => {
		const sha = "b".repeat(64);
		validateDocReviewRecord({ ...record(), failedSeatTranscript: { path: ".dev/doc-review-transcripts/doc-abc123-run.json", sha256: sha } });
		assert.throws(() => validateDocReviewRecord({ ...record(), failedSeatTranscript: { path: "/tmp/secret.json", sha256: sha } }), /transcript path/);
		assert.throws(() => validateDocReviewRecord({ ...record(), failedSeatTranscript: { path: ".dev/doc-review-transcripts/../secrets.json", sha256: sha } }), /transcript path/);
		assert.throws(() => validateDocReviewRecord({ ...record(), failedSeatTranscript: { path: ".dev/doc-review-transcripts/doc-abc123-run.json", sha256: "nope" } }), /transcript digest/);
	});

	it("renders a one-line local evidence pointer only when the descriptor is present", () => {
		assert.doesNotMatch(renderDocReviewRecord(record()), /Failed-seat transcript/);
		const withPointer = renderDocReviewRecord({ ...record(), failedSeatTranscript: { path: ".dev/doc-review-transcripts/doc-abc123-run.json", sha256: "c".repeat(64) } });
		assert.match(withPointer, /Failed-seat transcript \(local diagnostic, do not commit\): `\.dev\/doc-review-transcripts\/doc-abc123-run\.json`/);
		assert.doesNotMatch(withPointer, /PLANTED/);
	});
});

describe("DocReviewSeatTranscriptRecord (#677)", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "pelaggio-tx-"));
	});
	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const transcript = (): DocReviewSeatTranscriptRecord => ({
		schemaVersion: 1,
		runId: "doc-abc123-run",
		createdAt: new Date("2026-08-03T00:00:00Z").toISOString(),
		seats: [
			{
				role: "reviewer",
				seatId: "claude",
				provider: "claude",
				model: "claude-opus-5",
				pass: 1,
				attempt: 1,
				subtype: "success",
				turns: 14,
				parseCode: "block-not-found",
				source: { chars: 12, hasStartMarker: false, hasEndMarker: false },
				assistantText: "PLANTED_SECRET=sk-planted-not-real",
			},
		],
	});

	it("writes atomically under .dev/doc-review-transcripts with mode 0o600 and hashes the serialized bytes", () => {
		const written = writeDocReviewSeatTranscript(dir, transcript());
		assert.equal(written.path, ".dev/doc-review-transcripts/doc-abc123-run.json");
		assert.match(written.sha256, /^[a-f0-9]{64}$/);
		const absolute = join(dir, written.path);
		assert.equal(statSync(dirname(absolute)).mode & 0o777, 0o700);
		assert.equal(statSync(absolute).mode & 0o777, 0o600);
		const body = readFileSync(absolute, "utf-8");
		assert.equal(createHash("sha256").update(body).digest("hex"), written.sha256);
		assert.match(body, /PLANTED_SECRET=sk-planted-not-real/);
		assert.ok(!existsSync(`${absolute}.tmp-${process.pid}`));
	});

	it("refuses a pre-existing permissive temp file instead of publishing it as a transcript", () => {
		const planted = { ...transcript(), runId: "doc-stale-temp" };
		const absolute = join(dir, ".dev", "doc-review-transcripts", "doc-stale-temp.json");
		const temporary = `${absolute}.tmp-${process.pid}`;
		mkdirSync(join(dir, ".dev", "doc-review-transcripts"), { recursive: true });
		writeFileSync(temporary, "attacker-controlled stale file", { mode: 0o644 });
		chmodSync(temporary, 0o644);

		assert.throws(() => writeDocReviewSeatTranscript(dir, planted), { code: "EEXIST" });
		assert.equal(existsSync(absolute), false);
		assert.equal(readFileSync(temporary, "utf8"), "attacker-controlled stale file");
		assert.equal(statSync(temporary).mode & 0o777, 0o644);
		rmSync(temporary);
	});

	it("rejects symlinked private-directory components without writing outside .dev", () => {
		for (const linkedComponent of [".dev", "doc-review-transcripts"] as const) {
			const root = mkdtempSync(join(tmpdir(), `pelaggio-tx-${linkedComponent.replaceAll("-", "")}-`));
			const outside = mkdtempSync(join(tmpdir(), "pelaggio-tx-outside-"));
			try {
				chmodSync(outside, 0o755);
				if (linkedComponent === ".dev") {
					symlinkSync(outside, join(root, ".dev"), "dir");
				} else {
					mkdirSync(join(root, ".dev"));
					symlinkSync(outside, join(root, ".dev", "doc-review-transcripts"), "dir");
				}

				const runId = `doc-linked-${linkedComponent}`;
				assert.throws(() => writeDocReviewSeatTranscript(root, { ...transcript(), runId }), /plain directory/);
				const escaped = linkedComponent === ".dev" ? join(outside, "doc-review-transcripts", `${runId}.json`) : join(outside, `${runId}.json`);
				assert.equal(existsSync(escaped), false);
				assert.equal(statSync(outside).mode & 0o777, 0o755, "the symlink target mode must stay unchanged");
			} finally {
				rmSync(root, { recursive: true, force: true });
				rmSync(outside, { recursive: true, force: true });
			}
		}
	});

	it("does not leak transcript bytes onto the ordinary doc-review record", () => {
		const written = writeDocReviewSeatTranscript(dir, { ...transcript(), runId: "doc-separate" });
		const rec = { ...record(), runId: "doc-separate", failedSeatTranscript: written };
		const path = writeDocReviewRecord(dir, rec);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		assert.equal(parsed.failedSeatTranscript.path, written.path);
		assert.equal(parsed.failedSeatTranscript.sha256, written.sha256);
		assert.equal(JSON.stringify(parsed).includes("PLANTED_SECRET"), false);
		assert.equal(JSON.stringify(parsed).includes("assistantText"), false);
	});
});
