import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseReviewFindings, ReviewFindingsParseError, reviewFindingsGate } from "../review/findings.js";

function block(value: unknown): string {
	return `Review complete.\nREVIEW_FINDINGS\n${JSON.stringify(value)}\nEND_REVIEW_FINDINGS`;
}

describe("parseReviewFindings", () => {
	it("parses empty and severity-tagged reports surrounded by prose", () => {
		const clean = parseReviewFindings(block({ schemaVersion: 1, summary: "Clean review.", findings: [] }));
		assert.deepEqual(clean, { schemaVersion: 1, summary: "Clean review.", findings: [] });
		for (const severity of ["must-fix", "nice", "note"] as const) {
			const report = parseReviewFindings(block({ schemaVersion: 1, summary: "Reviewed.", findings: [{ severity, message: "Finding.", path: "src/a.ts", line: 2 }] }));
			assert.equal(report.findings[0].severity, severity);
		}
	});

	it("rejects missing, duplicate, invalid JSON, unsupported versions, and non-object roots", () => {
		for (const text of [
			"",
			`${block({ schemaVersion: 1, summary: "Ok.", findings: [] })}\n${block({ schemaVersion: 1, summary: "Ok.", findings: [] })}`,
			"REVIEW_FINDINGS\n{nope}\nEND_REVIEW_FINDINGS",
			block({ schemaVersion: 2, summary: "Ok.", findings: [] }),
			block([]),
		]) {
			assert.throws(() => parseReviewFindings(text), ReviewFindingsParseError);
		}
	});

	it("rejects unknown, missing, and wrongly typed report fields", () => {
		for (const value of [
			{ schemaVersion: 1, summary: "Ok.", findings: [], extra: true },
			{ schemaVersion: 1, findings: [] },
			{ schemaVersion: 1, summary: 2, findings: [] },
			{ schemaVersion: 1, summary: "Ok.", findings: {} },
		])
			assert.throws(() => parseReviewFindings(block(value)), ReviewFindingsParseError);
	});

	it("rejects invalid finding fields and locations", () => {
		const invalid = [
			{},
			{ severity: "other", message: "Bad." },
			{ severity: "note", message: "" },
			{ severity: "note", message: "two\nlines" },
			{ severity: "note", message: "Bad.", extra: true },
			{ severity: "note", message: "Bad.", path: "" },
			{ severity: "note", message: "Bad.", path: "a\nb" },
			{ severity: "note", message: "Bad.", line: 1 },
			{ severity: "note", message: "Bad.", path: "a.ts", line: 0 },
			{ severity: "note", message: "Bad.", path: "a.ts", line: 1.5 },
		];
		for (const finding of invalid) assert.throws(() => parseReviewFindings(block({ schemaVersion: 1, summary: "Ok.", findings: [finding] })), ReviewFindingsParseError);
		for (const summary of ["", "two\nlines"]) assert.throws(() => parseReviewFindings(block({ schemaVersion: 1, summary, findings: [] })), ReviewFindingsParseError);
	});
});

describe("reviewFindingsGate", () => {
	it("blocks only must-fix findings", () => {
		for (const findings of [[], [{ severity: "nice", message: "Improve." }], [{ severity: "note", message: "Context." }]]) {
			assert.equal(reviewFindingsGate({ schemaVersion: 1, summary: "Reviewed.", findings } as ReturnType<typeof parseReviewFindings>), "pass");
		}
		assert.equal(reviewFindingsGate(parseReviewFindings(block({ schemaVersion: 1, summary: "Blocked.", findings: [{ severity: "must-fix", message: "Bug." }] }))), "block");
	});
});
