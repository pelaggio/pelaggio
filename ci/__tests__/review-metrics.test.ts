import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBaselineRows, type GateRecord, summarize } from "../review-metrics.js";

function record(over: Partial<GateRecord> = {}): GateRecord {
	return {
		prNumber: 1,
		headSha: "a".repeat(40),
		gate: "block",
		ok: true,
		...over,
	};
}

describe("review-metrics closure modes (#756)", () => {
	it("counts only fleet-v2 classified confirmed-survivor observations in canonical order", () => {
		const records: GateRecord[] = [
			record({
				schemaVersion: 2,
				producer: "fleet",
				recurrenceFindings: [{ closure: "patch" }, { closure: "construction" }, { closure: "construction" }, { closure: "authority" }, { closure: "policy" }, {}, { closure: "nope" }, { closure: "" }],
			}),
			record({ schemaVersion: 2, producer: "fleet", prNumber: 2, headSha: "b".repeat(40) }),
			record({ schemaVersion: 2, producer: "fleet", prNumber: 3, headSha: "c".repeat(40), recurrenceFindings: [] }),
			record({ schemaVersion: 1, prNumber: 4, headSha: "d".repeat(40), recurrenceFindings: [{ closure: "patch" }] }),
			record({
				schemaVersion: 2,
				producer: "operator-adjudication",
				prNumber: 5,
				headSha: "e".repeat(40),
				recurrenceFindings: [{ closure: "policy" }],
			}),
		];
		const s = summarize(records);
		assert.deepEqual(s.closureModes, { patch: 1, construction: 2, authority: 1, policy: 1 });
		assert.deepEqual(Object.keys(s.closureModes), ["patch", "construction", "authority", "policy"]);
	});

	it("returns four zeroes without throwing when closure data is absent", () => {
		assert.deepEqual(summarize([]).closureModes, { patch: 0, construction: 0, authority: 0, policy: 0 });
		assert.deepEqual(summarize([record()]).closureModes, { patch: 0, construction: 0, authority: 0, policy: 0 });
		assert.deepEqual(summarize([record({ schemaVersion: 2, producer: "fleet", recurrenceFindings: undefined })]).closureModes, {
			patch: 0,
			construction: 0,
			authority: 0,
			policy: 0,
		});
	});

	it("appends the closure row after the existing table rows without rewording them", () => {
		const s = summarize([
			record({
				schemaVersion: 2,
				producer: "fleet",
				agreement: "disagreement",
				breakerReason: "invalid-pass",
				recurrenceFindings: [{ closure: "patch" }, { closure: "construction" }],
			}),
		]);
		const rows = formatBaselineRows(s).split("\n");
		assert.equal(rows[0], "  PRs gated                1");
		assert.ok(rows[1]?.startsWith("  rolls                    "));
		assert.ok(rows[2]?.startsWith("  single-roll / repeat     "));
		assert.ok(rows[3]?.startsWith("  reached a pass           "));
		assert.ok(rows[4]?.startsWith("  cost                     "));
		assert.ok(rows[5]?.startsWith("  survivors per block      "));
		assert.ok(rows[6]?.startsWith("  agreement               "));
		assert.equal(rows[7], "  mislabelled splits       1  (ok=true + disagreement stamped invalid-pass)");
		assert.equal(rows[8], "  closure modes            patch=1 construction=1 authority=0 policy=0   (classified confirmed-survivor observations)");
		assert.equal(rows.length, 9);
	});
});
