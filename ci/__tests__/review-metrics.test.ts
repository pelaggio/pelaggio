import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrReviewSecurityTelemetry } from "../../packages/pelaggio/scripts/pelaggio/pr-review-gate-record.js";
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
		assert.equal(rows[9], "  security-review coverage  0 / 1 instrumented fleet rolls");
		assert.equal(rows[10], "  red-team trigger rate     0 / 0 (0%)");
		assert.equal(rows[11], "  red-team-only must-fixes  0   (verified surviving digest set-difference)");
		assert.equal(rows.length, 12);
	});
});

describe("review-metrics security-review telemetry (#746)", () => {
	function telemetry(over: Partial<PrReviewSecurityTelemetry> = {}): PrReviewSecurityTelemetry {
		return {
			triggered: true,
			reasons: ["path:packages/server/src/config.ts"],
			standardMustFixDigests: [],
			redTeamMustFixDigests: [],
			...over,
		};
	}

	it("counts coverage only from well-shaped fleet-v2 objects and excludes operator/historical", () => {
		const records: GateRecord[] = [
			record({ schemaVersion: 2, producer: "fleet", securityReview: telemetry() }),
			record({ schemaVersion: 2, producer: "fleet", prNumber: 2, headSha: "b".repeat(40), securityReview: telemetry({ triggered: false, reasons: [] }) }),
			record({ schemaVersion: 2, producer: "fleet", prNumber: 3, headSha: "c".repeat(40) }),
			record({ schemaVersion: 2, producer: "fleet", prNumber: 4, headSha: "d".repeat(40), securityReview: { triggered: true, reasons: [] } }),
			record({ schemaVersion: 1, prNumber: 5, headSha: "e".repeat(40), securityReview: telemetry() }),
			record({
				schemaVersion: 2,
				producer: "operator-adjudication",
				prNumber: 6,
				headSha: "f".repeat(40),
				securityReview: telemetry({ redTeamMustFixDigests: ["a".repeat(64)] }),
			}),
		];
		const s = summarize(records);
		assert.equal(s.securityReview.fleetRolls, 4);
		assert.equal(s.securityReview.instrumented, 2);
		assert.equal(s.securityReview.triggered, 1);
		assert.equal(s.securityReview.redTeamOnlyMustFixes, 0);
	});

	it("counts red-team-only must-fixes as a per-record set difference", () => {
		const shared = "a".repeat(64);
		const only = "b".repeat(64);
		const s = summarize([
			record({
				schemaVersion: 2,
				producer: "fleet",
				securityReview: telemetry({
					standardMustFixDigests: [shared],
					redTeamMustFixDigests: [shared, only],
				}),
			}),
			record({
				schemaVersion: 2,
				producer: "fleet",
				prNumber: 2,
				headSha: "b".repeat(40),
				securityReview: telemetry({
					standardMustFixDigests: [only],
					redTeamMustFixDigests: [only],
				}),
			}),
		]);
		assert.equal(s.securityReview.redTeamOnlyMustFixes, 1);
		assert.equal(s.securityReview.triggered, 2);
		assert.equal(s.securityReview.instrumented, 2);
	});

	it("uses the fleet-v2 validator and excludes malformed telemetry from evidence", () => {
		const valid = telemetry({ redTeamMustFixDigests: ["b".repeat(64)] });
		const records: GateRecord[] = [
			record({ schemaVersion: 2, producer: "fleet", securityReview: valid }),
			record({ schemaVersion: 2, producer: "fleet", prNumber: 2, headSha: "b".repeat(40), securityReview: { ...valid, reasons: [123] } }),
			record({ schemaVersion: 2, producer: "fleet", prNumber: 3, headSha: "c".repeat(40), securityReview: { ...valid, redTeamMustFixDigests: ["not-a-digest"] } }),
		];
		const s = summarize(records);
		assert.deepEqual(s.securityReview, { fleetRolls: 3, instrumented: 1, triggered: 1, redTeamOnlyMustFixes: 1 });
	});

	it("returns zeros without throwing when telemetry is absent", () => {
		assert.deepEqual(summarize([]).securityReview, { fleetRolls: 0, instrumented: 0, triggered: 0, redTeamOnlyMustFixes: 0 });
		assert.deepEqual(summarize([record()]).securityReview, { fleetRolls: 0, instrumented: 0, triggered: 0, redTeamOnlyMustFixes: 0 });
	});
});
