import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FRESHNESS_GATE_RECORDS_DIR, freshnessGateRecordsDir, readFreshnessGateRecord, writeFreshnessGateRecord } from "../freshness-gate-record.js";

const SHA = "a".repeat(40);

function makeRoot(): string {
	return mkdtempSync(join(tmpdir(), "pelaggio-fresh-rec-"));
}

describe("freshness-gate-record store (#424)", () => {
	it("round-trips a record keyed by lowercase head sha under .dev/", () => {
		const root = makeRoot();
		const path = writeFreshnessGateRecord(root, { itemId: "TOOL-99", headSha: SHA.toUpperCase(), typecheck: "passed", recordedAt: "2026-08-15T00:00:00.000Z" });
		assert.ok(path.startsWith(join(root, ".dev", FRESHNESS_GATE_RECORDS_DIR)));
		assert.ok(path.endsWith(`${SHA}.json`), "sha key is lowercased");
		const record = readFreshnessGateRecord(root, SHA);
		assert.ok(record);
		assert.equal(record?.schemaVersion, 1);
		assert.equal(record?.itemId, "TOOL-99");
		assert.equal(record?.typecheck, "passed");
		// Case-insensitive lookup.
		assert.ok(readFreshnessGateRecord(root, SHA.toUpperCase()));
	});

	it("read fails closed: missing file, malformed JSON, invalid shape, and sha mismatch all read as null", () => {
		const root = makeRoot();
		assert.equal(readFreshnessGateRecord(root, SHA), null);

		const dir = freshnessGateRecordsDir(root);
		writeFreshnessGateRecord(root, { itemId: "TOOL-99", headSha: SHA, typecheck: "skipped", recordedAt: "2026-08-15T00:00:00.000Z" });
		writeFileSync(join(dir, `${"b".repeat(40)}.json`), "{nope");
		assert.equal(readFreshnessGateRecord(root, "b".repeat(40)), null);

		// A record whose embedded sha does not match its key must not authorize the key's head.
		const embedded = JSON.parse(readFileSync(join(dir, `${SHA}.json`), "utf8")) as Record<string, unknown>;
		writeFileSync(join(dir, `${"c".repeat(40)}.json`), JSON.stringify(embedded));
		assert.equal(readFreshnessGateRecord(root, "c".repeat(40)), null);

		writeFileSync(join(dir, `${"d".repeat(40)}.json`), JSON.stringify({ ...embedded, headSha: "d".repeat(40), typecheck: "maybe" }));
		assert.equal(readFreshnessGateRecord(root, "d".repeat(40)), null);
		writeFileSync(join(dir, `${"e".repeat(40)}.json`), JSON.stringify({ ...embedded, headSha: "e".repeat(40), schemaVersion: 2 }));
		assert.equal(readFreshnessGateRecord(root, "e".repeat(40)), null);
	});

	it("rejects invalid keys and invalid writes", () => {
		const root = makeRoot();
		assert.equal(readFreshnessGateRecord(root, "../escape"), null);
		assert.equal(readFreshnessGateRecord(root, ""), null);
		assert.throws(() => writeFreshnessGateRecord(root, { itemId: "TOOL-99", headSha: "not-a-sha", typecheck: "passed", recordedAt: "2026-08-15T00:00:00.000Z" }));
		assert.throws(() => writeFreshnessGateRecord(root, { itemId: "", headSha: SHA, typecheck: "passed", recordedAt: "2026-08-15T00:00:00.000Z" }));
		assert.throws(() => writeFreshnessGateRecord(root, { itemId: "TOOL-99", headSha: SHA, typecheck: "passed", recordedAt: "not-a-date" }));
	});
});
