import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	fleetAgreementOf,
	listPrReviewGateRecords,
	type NewPrReviewFleetGateRecord,
	type NewPrReviewOperatorGateRecord,
	type PrReviewFleetGateRecordV2,
	type PrReviewGateRecord,
	type PrReviewOperatorGateRecordV2,
	readPrReviewGateRecord,
	validatePrReviewGateRecord,
	writePrReviewGateRecord,
} from "../pr-review-gate-record.js";

const HEAD = "abc123abc123abc123abc123abc123abc123abcd";
const SECOND_HEAD = "def456def456def456def456def456def456defa";
const DIGEST = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const dirs: string[] = [];

function root(): string {
	const dir = mkdtempSync(join(tmpdir(), "pr-review-gate-record-"));
	dirs.push(dir);
	return dir;
}

function fleetRecord(overrides: Partial<NewPrReviewFleetGateRecord> = {}): NewPrReviewFleetGateRecord {
	return {
		producer: "fleet",
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

function operatorRecord(overrides: Partial<NewPrReviewOperatorGateRecord> = {}): NewPrReviewOperatorGateRecord {
	return {
		producer: "operator-adjudication",
		agreement: "not-run",
		prNumber: 201,
		itemId: "328",
		headSha: HEAD,
		gate: "pass",
		runner: "local",
		reviewedAt: "2026-08-05T12:00:00.000Z",
		adjudicator: "operator@example.com",
		reviewedSourceSha: SECOND_HEAD,
		interdiffDigest: DIGEST,
		dispositions: {
			"fixed-fp": { disposition: "fixed", rationale: "addressed in the interdiff" },
			"refuted-fp": { disposition: "refuted", rationale: "not a real defect" },
			"accepted-fp": { disposition: "accepted", rationale: "shipping with this finding" },
		},
		...overrides,
	};
}

function v1Fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
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

function listedIdentity(entry: PrReviewGateRecord): [number, number, string | undefined] {
	return [entry.prNumber, entry.schemaVersion, entry.schemaVersion === 2 ? entry.producer : undefined];
}

function assertFleet(record: PrReviewGateRecord | null | undefined): asserts record is PrReviewFleetGateRecordV2 {
	assert.ok(record && record.schemaVersion === 2 && record.producer === "fleet");
}

function assertOperator(record: PrReviewGateRecord | null | undefined): asserts record is PrReviewOperatorGateRecordV2 {
	assert.ok(record && record.schemaVersion === 2 && record.producer === "operator-adjudication");
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PR review gate record store", () => {
	it("writes and reads v2 fleet pass and block records", () => {
		const dir = root();
		const passPath = writePrReviewGateRecord(dir, fleetRecord({ iterations: 2, survivorCount: 1 }));
		assert.equal(passPath, join(dir, `201-${HEAD}.json`));
		assert.equal(statSync(passPath).mode & 0o777, 0o600);
		const persisted = JSON.parse(readFileSync(passPath, "utf8"));
		assert.equal(persisted.schemaVersion, 2);
		assert.equal(persisted.producer, "fleet");
		const pass = readPrReviewGateRecord(dir, 201, HEAD);
		assertFleet(pass);
		assert.deepEqual(pass, { schemaVersion: 2, ...fleetRecord({ iterations: 2, survivorCount: 1 }) });

		writePrReviewGateRecord(dir, fleetRecord({ prNumber: 202, headSha: SECOND_HEAD, gate: "block", ok: false, subtype: "error_budget", agreement: "consensus-block", breakerReason: "budget" }));
		const block = readPrReviewGateRecord(dir, 202, SECOND_HEAD);
		assertFleet(block);
		assert.equal(block.breakerReason, "budget");
		assert.equal(block.agreement, "consensus-block");
	});

	it("writes and reads v2 operator adjudications, including empty dispositions and identity interdiffs", () => {
		const dir = root();
		const path = writePrReviewGateRecord(dir, operatorRecord());
		const stored = readPrReviewGateRecord(dir, 201, HEAD);
		assertOperator(stored);
		assert.equal(stored.agreement, "not-run");
		assert.equal(stored.adjudicator, "operator@example.com");
		assert.equal(stored.reviewedSourceSha, SECOND_HEAD);
		assert.equal(stored.interdiffDigest, DIGEST);
		assert.deepEqual(stored.dispositions, operatorRecord().dispositions);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).schemaVersion, 2);

		writePrReviewGateRecord(
			dir,
			operatorRecord({
				prNumber: 203,
				headSha: SECOND_HEAD,
				reviewedSourceSha: SECOND_HEAD,
				adjudicator: "  alice  ",
				dispositions: { "  fp-1  ": { disposition: "fixed", rationale: "  done  " } },
			}),
		);
		const identity = readPrReviewGateRecord(dir, 203, SECOND_HEAD);
		assertOperator(identity);
		assert.equal(identity.reviewedSourceSha, identity.headSha);
		assert.equal(identity.adjudicator, "alice");
		assert.deepEqual(identity.dispositions, { "fp-1": { disposition: "fixed", rationale: "done" } });

		writePrReviewGateRecord(dir, operatorRecord({ prNumber: 204, headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", dispositions: {} }));
		const empty = readPrReviewGateRecord(dir, 204, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		assertOperator(empty);
		assert.deepEqual(empty.dispositions, {});
	});

	it("idempotently overwrites a key and lists records in stable filename order", () => {
		const dir = root();
		writePrReviewGateRecord(dir, fleetRecord({ subtype: "first" }));
		writePrReviewGateRecord(dir, fleetRecord({ subtype: "last" }));
		writePrReviewGateRecord(dir, fleetRecord({ prNumber: 100, headSha: SECOND_HEAD }));
		const listed = listPrReviewGateRecords(dir);
		assert.deepEqual(listed.map(listedIdentity), [
			[100, 2, "fleet"],
			[201, 2, "fleet"],
		]);
		const overwritten = listed.find((entry) => entry.prNumber === 201);
		assertFleet(overwritten);
		assert.equal(overwritten.subtype, "last");
		assert.deepEqual(listPrReviewGateRecords(join(dir, "missing")), []);
	});

	it("reads hand-authored schema-v1 files without rewriting them and lists mixed versions", () => {
		const dir = root();
		const v1Path = join(dir, `100-${SECOND_HEAD}.json`);
		const v1Bytes = `${JSON.stringify(v1Fixture({ prNumber: 100, headSha: SECOND_HEAD, extra: "keep-me" }), null, 2)}\n`;
		writeFileSync(v1Path, v1Bytes);
		writePrReviewGateRecord(dir, fleetRecord());
		writePrReviewGateRecord(dir, operatorRecord({ prNumber: 202, headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }));

		const v1 = readPrReviewGateRecord(dir, 100, SECOND_HEAD);
		assert.ok(v1);
		assert.equal(v1.schemaVersion, 1);
		assert.equal("producer" in v1, false);
		assert.equal(Reflect.get(v1, "extra"), "keep-me");
		assert.equal(readFileSync(v1Path, "utf8"), v1Bytes);

		const listed = listPrReviewGateRecords(dir);
		assert.deepEqual(listed.map(listedIdentity), [
			[100, 1, undefined],
			[201, 2, "fleet"],
			[202, 2, "operator-adjudication"],
		]);
	});

	it("returns stored fleet agreement and never treats operator gate pass as consensus", () => {
		const v1 = validatePrReviewGateRecord(v1Fixture({ agreement: "disagreement" }));
		const fleet = validatePrReviewGateRecord({ schemaVersion: 2, ...fleetRecord({ agreement: "consensus-block" }) });
		const operatorPass = validatePrReviewGateRecord({ schemaVersion: 2, ...operatorRecord({ gate: "pass" }) });
		assert.equal(fleetAgreementOf(v1), "disagreement");
		assert.equal(fleetAgreementOf(fleet), "consensus-block");
		assert.equal(fleetAgreementOf(operatorPass), null);
	});

	it("rejects every invalid wire field", () => {
		const validV1 = v1Fixture();
		const validFleet = { schemaVersion: 2 as const, ...fleetRecord() };
		const validOperator = { schemaVersion: 2 as const, ...operatorRecord() };
		const invalid: unknown[] = [
			null,
			[],
			"record",
			{ ...validV1, schemaVersion: 3 },
			{ ...validV1, schemaVersion: 0 },
			{ ...validV1, prNumber: 0 },
			{ ...validV1, prNumber: 1.5 },
			{ ...validV1, headSha: "bad" },
			{ ...validV1, itemId: "" },
			{ ...validV1, gate: "park" },
			{ ...validV1, ok: "yes" },
			{ ...validV1, subtype: "" },
			{ ...validV1, agreement: "maybe" },
			{ ...validV1, breakerReason: "unknown" },
			{ ...validV1, iterations: -1 },
			{ ...validV1, survivorCount: Number.POSITIVE_INFINITY },
			{ ...validV1, cost: Number.NaN },
			{ ...validV1, costEstimated: 1 },
			{ ...validV1, turns: -1 },
			{ ...validV1, runner: "ci" },
			{ ...validV1, reviewedAt: "not-a-date" },
			{ ...validFleet, schemaVersion: 3 },
			{ ...validFleet, producer: "operator-adjudication" },
			{ ...validFleet, producer: "human" },
			{ ...validFleet, agreement: "not-run" },
			{ ...validFleet, adjudicator: "alice" },
			{ ...validOperator, agreement: "consensus-pass" },
			{ ...validOperator, agreement: "consensus-block" },
			{ ...validOperator, agreement: "disagreement" },
			{ ...validOperator, agreement: "invalid" },
			{ ...validOperator, ok: true },
			{ ...validOperator, adjudicator: "" },
			{ ...validOperator, adjudicator: "   " },
			{ ...validOperator, reviewedSourceSha: "bad" },
			{ ...validOperator, interdiffDigest: DIGEST.toUpperCase() },
			{ ...validOperator, interdiffDigest: DIGEST.slice(0, 63) },
			{ ...validOperator, interdiffDigest: `sha256:${DIGEST}` },
			{ ...validOperator, dispositions: null },
			{ ...validOperator, dispositions: [] },
			{ ...validOperator, dispositions: { "": { disposition: "fixed", rationale: "x" } } },
			{ ...validOperator, dispositions: { "  ": { disposition: "fixed", rationale: "x" } } },
			{ ...validOperator, dispositions: { fp: { disposition: "maybe", rationale: "x" } } },
			{ ...validOperator, dispositions: { fp: { disposition: "fixed", rationale: "" } } },
			{ ...validOperator, dispositions: { fp: { disposition: "fixed", rationale: "   " } } },
			{ ...validOperator, dispositions: { fp: { disposition: "fixed", rationale: "x", extra: true } } },
			{ ...validOperator, dispositions: { fp: "fixed" } },
			{ ...validOperator, dispositions: { "fp-1": { disposition: "fixed", rationale: "x" }, " fp-1 ": { disposition: "refuted", rationale: "y" } } },
		];
		for (const value of invalid) assert.throws(() => validatePrReviewGateRecord(value));
	});

	it("fails soft for malformed and filename-mismatched records", () => {
		const dir = root();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `201-${HEAD}.json`), "not json");
		assert.equal(readPrReviewGateRecord(dir, 201, HEAD), null);
		assert.deepEqual(listPrReviewGateRecords(dir), []);

		const original = writePrReviewGateRecord(dir, fleetRecord());
		renameSync(original, join(dir, `202-${HEAD}.json`));
		assert.equal(readPrReviewGateRecord(dir, 202, HEAD), null);
		assert.deepEqual(listPrReviewGateRecords(dir), []);
	});
});
