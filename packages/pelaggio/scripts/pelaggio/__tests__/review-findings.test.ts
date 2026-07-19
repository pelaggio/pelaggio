import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyReviewPass,
	evaluateReviewConvergence,
	parseAuthoringReviewFindings,
	parseJudgeReport,
	parseReviewFindings,
	parseReviewVerification,
	ReviewFindingsParseError,
	reconcileReviewVerification,
	reviewFindingFingerprint,
	reviewFindingsGate,
} from "../review/findings.js";

function block(value: unknown): string {
	return `Review complete.\nREVIEW_FINDINGS\n${JSON.stringify(value)}\nEND_REVIEW_FINDINGS`;
}

function verificationBlock(value: unknown): string {
	return `Verification complete.\nREVIEW_VERIFICATION\n${JSON.stringify(value)}\nEND_REVIEW_VERIFICATION`;
}

function authoringBlock(value: unknown): string {
	return `Review complete.\nAUTHORING_REVIEW_FINDINGS\n${JSON.stringify(value)}\nEND_AUTHORING_REVIEW_FINDINGS`;
}

function judgeBlock(value: unknown): string {
	return `Ruling complete.\nAUTHORING_REVIEW_JUDGE\n${JSON.stringify(value)}\nEND_AUTHORING_REVIEW_JUDGE`;
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

describe("parseAuthoringReviewFindings", () => {
	it("parses a v2 class-tagged report", () => {
		const report = parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 2, summary: "Reviewed.", findings: [{ severity: "must-fix", class: "security", message: "Leak.", path: "a.ts", line: 3 }] }));
		assert.equal(report.schemaVersion, 2);
		assert.equal(report.findings[0].class, "security");
		assert.equal(report.findings[0].line, 3);
	});

	it("rejects the wrong schemaVersion and an invalid/absent finding class", () => {
		assert.throws(() => parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 1, summary: "Ok.", findings: [] })), ReviewFindingsParseError);
		for (const cls of [undefined, "style", ""]) assert.throws(() => parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 2, summary: "Ok.", findings: [{ severity: "must-fix", class: cls, message: "x" }] })), ReviewFindingsParseError);
	});
});

describe("parseJudgeReport", () => {
	it("parses refuted and surviving decisions with rulings", () => {
		const report = parseJudgeReport(
			judgeBlock({
				schemaVersion: 1,
				decisions: [
					{ candidateId: "C1", decision: "refuted", rationale: "Not reachable.", class: "security" },
					{ candidateId: "C2", decision: "survives", rationale: "Reproduced.", class: "correctness-regression", ruling: "fixable-blocker" },
				],
			}),
		);
		assert.equal(report.decisions[1].ruling, "fixable-blocker");
	});

	it("fails closed on a surviving decision without a ruling and on mismatched dissent class", () => {
		assert.throws(() => parseJudgeReport(judgeBlock({ schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "survives", rationale: "r", class: "judgment" }] })), ReviewFindingsParseError);
		assert.throws(() => parseJudgeReport(judgeBlock({ schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "survives", rationale: "r", class: "security", ruling: "judgment-dissent" }] })), ReviewFindingsParseError);
	});
});

describe("review convergence", () => {
	const first = { severity: "must-fix" as const, message: "  Broken   path ", path: "src/a.ts", line: 2 };
	const disposition = (finding = first, decision: "survives" | "refuted" = "survives") => ({ id: "C1", finding, decision, rationale: "Checked." });

	it("uses a stable normalized fingerprint independent of candidate IDs", () => {
		assert.equal(reviewFindingFingerprint(first), reviewFindingFingerprint({ ...first, message: "Broken path" }));
	});

	it("carries omissions and removes only explicit refutations", () => {
		const carried = applyReviewPass(new Map(), { valid: true, dispositions: [disposition()], cost: 1 });
		assert.equal(applyReviewPass(carried, { valid: true, dispositions: [], cost: 1 }).size, 1);
		assert.equal(applyReviewPass(carried, { valid: true, dispositions: [disposition(first, "refuted")], cost: 1 }).size, 0);
		assert.equal(applyReviewPass(carried, { valid: false, dispositions: [disposition(first, "refuted")], cost: 1 }).size, 1);
	});

	it("converges cleanly and types every breaker", () => {
		const empty = new Map();
		assert.equal(evaluateReviewConvergence({ carried: empty, summary: { valid: true, dispositions: [], cost: 0 }, hasNextPass: false, nextPassAffordable: true }).state, "converged");
		assert.deepEqual(evaluateReviewConvergence({ carried: empty, summary: { valid: false, dispositions: [], cost: 0 }, hasNextPass: true, nextPassAffordable: true }).state, "exhausted");
		const baseline = applyReviewPass(empty, { valid: true, dispositions: [disposition()], cost: 1 });
		for (const [hasNextPass, affordable, previous, reason] of [
			[false, true, undefined, "max-passes"],
			[true, false, undefined, "budget"],
			[true, true, 1, "diminishing-returns"],
		] as const) {
			const result = evaluateReviewConvergence({ carried: baseline, summary: { valid: true, dispositions: [], cost: 1 }, previousSurvivorCount: previous, hasNextPass, nextPassAffordable: affordable });
			assert.equal(result.state, "exhausted");
			if (result.state === "exhausted") assert.equal(result.reason, reason);
		}
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

describe("review verification", () => {
	it("parses mixed, all-refuted, and all-survives decisions", () => {
		for (const decisions of [
			[{ candidateId: "C1", decision: "refuted", rationale: "The guard handles it." }],
			[{ candidateId: "C1", decision: "survives", rationale: "The path remains reachable." }],
			[
				{ candidateId: "C1", decision: "refuted", rationale: "Covered." },
				{ candidateId: "C2", decision: "survives", rationale: "Reproduced." },
			],
		]) {
			assert.deepEqual(parseReviewVerification(verificationBlock({ schemaVersion: 1, decisions })).decisions, decisions);
		}
	});

	it("rejects malformed contracts", () => {
		const valid = { schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "refuted", rationale: "Covered." }] };
		for (const text of [
			"",
			`${verificationBlock(valid)}\n${verificationBlock(valid)}`,
			"REVIEW_VERIFICATION\n{nope}\nEND_REVIEW_VERIFICATION",
			verificationBlock([]),
			verificationBlock({ ...valid, schemaVersion: 2 }),
			verificationBlock({ ...valid, extra: true }),
			verificationBlock({ schemaVersion: 1, decisions: {} }),
		])
			assert.throws(() => parseReviewVerification(text), ReviewFindingsParseError);
	});

	it("rejects invalid decision fields", () => {
		for (const decision of [
			{},
			{ candidateId: "1", decision: "refuted", rationale: "Covered." },
			{ candidateId: "C0", decision: "refuted", rationale: "Covered." },
			{ candidateId: "C1", decision: "unknown", rationale: "Covered." },
			{ candidateId: "C1", decision: "refuted", rationale: "" },
			{ candidateId: "C1", decision: "refuted", rationale: "two\nlines" },
			{ candidateId: "C1", decision: "refuted", rationale: "Covered.", extra: true },
		])
			assert.throws(() => parseReviewVerification(verificationBlock({ schemaVersion: 1, decisions: [decision] })), ReviewFindingsParseError);
	});

	it("reconciles exactly one decision per original candidate without rewriting findings", () => {
		const finding = { severity: "must-fix" as const, message: "Original.", path: "src/a.ts", line: 3 };
		const candidates = [{ id: "C1", finding }];
		const dispositions = reconcileReviewVerification(candidates, parseReviewVerification(verificationBlock({ schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "survives", rationale: "Confirmed." }] })));
		assert.equal(dispositions[0].finding, finding);
		assert.deepEqual(dispositions[0], { id: "C1", finding, decision: "survives", rationale: "Confirmed." });
	});

	it("rejects missing, duplicate, unknown, and duplicate candidate IDs", () => {
		const candidates = [{ id: "C1", finding: { severity: "must-fix" as const, message: "Original." } }];
		for (const decisions of [
			[],
			[
				{ candidateId: "C1", decision: "refuted" as const, rationale: "A." },
				{ candidateId: "C1", decision: "survives" as const, rationale: "B." },
			],
			[{ candidateId: "C2", decision: "refuted" as const, rationale: "A." }],
		])
			assert.throws(() => reconcileReviewVerification(candidates, { schemaVersion: 1, decisions }), ReviewFindingsParseError);
		assert.throws(() => reconcileReviewVerification([candidates[0], candidates[0]], { schemaVersion: 1, decisions: [] }), ReviewFindingsParseError);
	});
});
