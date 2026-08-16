import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { __clearFreshnessGateRecordsForTests, FRESHNESS_GATE_RECORDS_DIR, freshnessGateRecordsDir, readFreshnessGateRecord, writeFreshnessGateRecord } from "../freshness-gate-record.js";

const SHA = "a".repeat(40);

function makeRoot(): string {
	return mkdtempSync(join(tmpdir(), "pelaggio-fresh-rec-"));
}

describe("freshness-gate-record store (#424 → #511 in-process trust)", () => {
	beforeEach(() => {
		__clearFreshnessGateRecordsForTests();
	});

	it("write seeds process-local trust: the same process reads the record back (case-insensitive)", () => {
		const root = makeRoot();
		writeFreshnessGateRecord(root, { itemId: "TOOL-99", headSha: SHA.toUpperCase(), typecheck: "passed", recordedAt: "2026-08-15T00:00:00.000Z" });
		const record = readFreshnessGateRecord(root, SHA);
		assert.ok(record);
		assert.equal(record?.schemaVersion, 1);
		assert.equal(record?.itemId, "TOOL-99");
		assert.equal(record?.typecheck, "passed");
		assert.ok(readFreshnessGateRecord(root, SHA.toUpperCase()), "case-insensitive lookup");
		assert.equal(readFreshnessGateRecord(root, "b".repeat(40)), null, "other shas stay unrecorded");
		assert.equal(readFreshnessGateRecord(makeRoot(), SHA), null, "trust is keyed per mainRepo");
	});

	it("still writes a validated observability record on disk, keyed by lowercase sha", () => {
		const root = makeRoot();
		const path = writeFreshnessGateRecord(root, { itemId: "TOOL-99", headSha: SHA.toUpperCase(), typecheck: "skipped", recordedAt: "2026-08-15T00:00:00.000Z" });
		assert.ok(path.startsWith(join(root, ".dev", FRESHNESS_GATE_RECORDS_DIR)));
		assert.ok(path.endsWith(`${SHA}.json`), "sha key is lowercased");
		assert.ok(existsSync(path));
		const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		assert.equal(onDisk.schemaVersion, 1);
		assert.equal(onDisk.itemId, "TOOL-99");
		assert.equal(onDisk.typecheck, "skipped");
	});

	it("the on-disk store is never authorization: a cross-process resume (cleared registry) reads null despite the file", () => {
		const root = makeRoot();
		const path = writeFreshnessGateRecord(root, { itemId: "TOOL-99", headSha: SHA, typecheck: "passed", recordedAt: "2026-08-15T00:00:00.000Z" });
		assert.ok(existsSync(path), "observability file persists");
		__clearFreshnessGateRecordsForTests(); // simulate a fresh process
		assert.equal(readFreshnessGateRecord(root, SHA), null, "cross-process skip is gone — gates re-run");
	});

	it("a planted (forged) exact-SHA disk record has no value — reads never consult disk", () => {
		const root = makeRoot();
		const dir = freshnessGateRecordsDir(root);
		mkdirSync(dir, { recursive: true });
		const forged = { schemaVersion: 1, itemId: "TOOL-99", headSha: SHA, typecheck: "passed", recordedAt: "2026-08-15T00:00:00.000Z" };
		writeFileSync(join(dir, `${SHA}.json`), JSON.stringify(forged));
		assert.equal(readFreshnessGateRecord(root, SHA), null, "a seat-forged record must not skip the deterministic gates");
	});

	it("rejects invalid keys and invalid writes", () => {
		const root = makeRoot();
		assert.equal(readFreshnessGateRecord(root, "../escape"), null);
		assert.equal(readFreshnessGateRecord(root, ""), null);
		assert.throws(() => writeFreshnessGateRecord(root, { itemId: "TOOL-99", headSha: "not-a-sha", typecheck: "passed", recordedAt: "2026-08-15T00:00:00.000Z" }));
		assert.throws(() => writeFreshnessGateRecord(root, { itemId: "", headSha: SHA, typecheck: "passed", recordedAt: "2026-08-15T00:00:00.000Z" }));
		assert.throws(() => writeFreshnessGateRecord(root, { itemId: "TOOL-99", headSha: SHA, typecheck: "passed", recordedAt: "not-a-date" }));
		assert.equal(readFreshnessGateRecord(root, SHA), null, "a rejected write must not seed trust");
	});
});
