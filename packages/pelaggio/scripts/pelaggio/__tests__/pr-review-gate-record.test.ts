import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { listPrReviewGateRecords, type NewPrReviewGateRecord, readPrReviewGateRecord, validatePrReviewGateRecord, writePrReviewGateRecord } from "../pr-review-gate-record.js";

const HEAD = "abc123abc123abc123abc123abc123abc123abcd";
const SECOND_HEAD = "def456def456def456def456def456def456defa";
const dirs: string[] = [];

function root(): string {
	const dir = mkdtempSync(join(tmpdir(), "pr-review-gate-record-"));
	dirs.push(dir);
	return dir;
}

function record(overrides: Partial<NewPrReviewGateRecord> = {}): NewPrReviewGateRecord {
	return {
		prNumber: 201,
		headSha: HEAD,
		itemId: "328",
		gate: "pass",
		ok: true,
		subtype: "success",
		agreement: "consensus-pass",
		cost: 0.25,
		costEstimated: false,
		turns: 3,
		runner: "local",
		reviewedAt: "2026-08-05T12:00:00.000Z",
		...overrides,
	};
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PR review gate record store", () => {
	it("writes and reads pass and block records", () => {
		const dir = root();
		const passPath = writePrReviewGateRecord(dir, record({ iterations: 2, survivorCount: 1 }));
		assert.equal(passPath, join(dir, `201-${HEAD}.json`));
		assert.equal(JSON.parse(readFileSync(passPath, "utf8")).schemaVersion, 1);
		assert.deepEqual(readPrReviewGateRecord(dir, 201, HEAD), { schemaVersion: 1, ...record({ iterations: 2, survivorCount: 1 }) });

		writePrReviewGateRecord(dir, record({ prNumber: 202, headSha: SECOND_HEAD, gate: "block", ok: false, subtype: "error_budget", agreement: "consensus-block", breakerReason: "budget" }));
		assert.equal(readPrReviewGateRecord(dir, 202, SECOND_HEAD)?.breakerReason, "budget");
	});

	it("idempotently overwrites a key and lists records in stable filename order", () => {
		const dir = root();
		writePrReviewGateRecord(dir, record({ subtype: "first" }));
		writePrReviewGateRecord(dir, record({ subtype: "last" }));
		writePrReviewGateRecord(dir, record({ prNumber: 100, headSha: SECOND_HEAD }));
		assert.deepEqual(
			listPrReviewGateRecords(dir).map((entry) => [entry.prNumber, entry.subtype]),
			[
				[100, "success"],
				[201, "last"],
			],
		);
		assert.deepEqual(listPrReviewGateRecords(join(dir, "missing")), []);
	});

	it("rejects every invalid wire field", () => {
		const valid = { schemaVersion: 1 as const, ...record() };
		const invalid: unknown[] = [
			{ ...valid, schemaVersion: 2 },
			{ ...valid, prNumber: 0 },
			{ ...valid, prNumber: 1.5 },
			{ ...valid, headSha: "bad" },
			{ ...valid, itemId: "" },
			{ ...valid, gate: "park" },
			{ ...valid, ok: "yes" },
			{ ...valid, subtype: "" },
			{ ...valid, agreement: "maybe" },
			{ ...valid, breakerReason: "unknown" },
			{ ...valid, iterations: -1 },
			{ ...valid, survivorCount: Number.POSITIVE_INFINITY },
			{ ...valid, cost: Number.NaN },
			{ ...valid, costEstimated: 1 },
			{ ...valid, turns: -1 },
			{ ...valid, runner: "ci" },
			{ ...valid, reviewedAt: "not-a-date" },
		];
		for (const value of invalid) assert.throws(() => validatePrReviewGateRecord(value as never));
	});

	it("fails soft for malformed and filename-mismatched records", () => {
		const dir = root();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `201-${HEAD}.json`), "not json");
		assert.equal(readPrReviewGateRecord(dir, 201, HEAD), null);
		assert.deepEqual(listPrReviewGateRecords(dir), []);

		const original = writePrReviewGateRecord(dir, record());
		renameSync(original, join(dir, `202-${HEAD}.json`));
		assert.equal(readPrReviewGateRecord(dir, 202, HEAD), null);
		assert.deepEqual(listPrReviewGateRecords(dir), []);
	});
});
