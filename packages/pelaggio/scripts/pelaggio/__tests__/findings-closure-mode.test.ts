import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { renderFindingClosureGuidance, verificationPrompt } from "../pr-review-gate.js";
import { buildAdjudicationSourceDraft } from "../review/adjudication.js";
import { buildCarryDispositionDraft } from "../review/carry.js";
import {
	materializeAuthoringFinding,
	parseAuthoringReviewFindings,
	parseReviewFindings,
	parseReviewVerification,
	REVIEW_FINDING_CLOSURES,
	type ReviewFinding,
	type ReviewFindingClosure,
	ReviewFindingsParseError,
	type ReviewFindingsParseErrorCode,
	reviewFindingFingerprint,
	SCHEMA_EXAMPLE_FINDINGS,
} from "../review/findings.js";
import { BASELINE_TAXONOMY } from "../review/taxonomy.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");

function findingsBlock(value: unknown): string {
	return `Review complete.\nREVIEW_FINDINGS\n${JSON.stringify(value)}\nEND_REVIEW_FINDINGS`;
}

function authoringBlock(value: unknown): string {
	return `Review complete.\nAUTHORING_REVIEW_FINDINGS\n${JSON.stringify(value)}\nEND_AUTHORING_REVIEW_FINDINGS`;
}

function verificationBlock(value: unknown): string {
	return `Verification complete.\nREVIEW_VERIFICATION\n${JSON.stringify(value)}\nEND_REVIEW_VERIFICATION`;
}

function codeOf(fn: () => unknown): ReviewFindingsParseErrorCode {
	try {
		fn();
	} catch (error) {
		assert.ok(error instanceof ReviewFindingsParseError, "expected a ReviewFindingsParseError");
		return error.code;
	}
	throw new assert.AssertionError({ message: "expected a parse failure" });
}

function inspectionDiff(): string {
	return ["diff --git a/src/a.ts b/src/a.ts", "index 1111111..2222222 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -8,5 +8,5 @@", " context", " context", "-old line", "+new line", " context", " context", ""].join("\n");
}

describe("optional finding closure (#756)", () => {
	it("parses every mode through schema v1 and authoring schema v3", () => {
		for (const closure of REVIEW_FINDING_CLOSURES) {
			const v1 = parseReviewFindings(findingsBlock({ schemaVersion: 1, summary: "Reviewed.", findings: [{ severity: "must-fix", message: "Bug.", path: "src/a.ts", line: 2, closure }] }));
			assert.equal(v1.findings[0]?.closure, closure);
			const v3 = parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 3, summary: "Reviewed.", findings: [{ severity: "must-fix", message: "Bug.", path: "src/a.ts", line: 2, closure }] }));
			assert.equal(v3.findings[0]?.closure, closure);
		}
	});

	it("rejects unknown keys as unknown-key and present invalid values as invalid-closure", () => {
		assert.equal(
			codeOf(() => parseReviewFindings(findingsBlock({ schemaVersion: 1, summary: "Ok.", findings: [{ severity: "note", message: "x", closureMode: "patch" }] }))),
			"unknown-key",
		);
		assert.equal(
			codeOf(() => parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 3, summary: "Ok.", findings: [{ severity: "note", message: "x", extra: true }] }))),
			"unknown-key",
		);
		for (const closure of [null, 1, "", "Patch", "legacy", "  patch  "]) {
			assert.equal(
				codeOf(() => parseReviewFindings(findingsBlock({ schemaVersion: 1, summary: "Ok.", findings: [{ severity: "note", message: "x", closure }] }))),
				"invalid-closure",
			);
			assert.equal(
				codeOf(() => parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 3, summary: "Ok.", findings: [{ severity: "note", message: "x", closure }] }))),
				"invalid-closure",
			);
		}
	});

	it("omits closure when the field is absent — no synthesized property", () => {
		const v1 = parseReviewFindings(findingsBlock({ schemaVersion: 1, summary: "Reviewed.", findings: [{ severity: "must-fix", message: "Bug.", path: "src/a.ts", line: 2 }] }));
		assert.equal(Object.hasOwn(v1.findings[0] ?? {}, "closure"), false);
		assert.equal("closure" in (v1.findings[0] ?? {}), false);
		assert.deepEqual(v1.findings[0], { severity: "must-fix", message: "Bug.", path: "src/a.ts", line: 2 });
		const v3 = parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 3, summary: "Reviewed.", findings: [{ severity: "must-fix", message: "Bug." }] }));
		assert.equal(Object.hasOwn(v3.findings[0] ?? {}, "closure"), false);
	});

	it("materializeAuthoringFinding copies a present mode and still omits it when absent", () => {
		const withMode = materializeAuthoringFinding({ severity: "must-fix", message: "Bug.", closure: "policy" }, { changedFiles: [] });
		assert.equal(withMode.closure, "policy");
		const without = materializeAuthoringFinding({ severity: "must-fix", message: "Bug." }, { changedFiles: [] });
		assert.equal(Object.hasOwn(without, "closure"), false);
	});

	it("keeps reviewFindingFingerprint independent of closure", () => {
		const base: ReviewFinding = { severity: "must-fix", message: "Same bug.", path: "src/a.ts", line: 4 };
		const expected = reviewFindingFingerprint(base);
		for (const closure of [undefined, ...REVIEW_FINDING_CLOSURES] as const) {
			assert.equal(reviewFindingFingerprint({ ...base, ...(closure !== undefined ? { closure } : {}) }), expected);
		}
	});

	it("verificationPrompt includes present closure and the decision schema stays unchanged", () => {
		const finding: ReviewFinding = { severity: "must-fix", message: "Bug.", path: "src/a.ts", line: 4, closure: "construction" };
		const prompt = verificationPrompt([{ id: "C1", finding }], "");
		assert.match(prompt, /"closure":"construction"/);
		assert.match(prompt, /"candidateId":"C1"/);
		assert.equal(
			codeOf(() =>
				parseReviewVerification(
					verificationBlock({
						schemaVersion: 1,
						decisions: [{ candidateId: "C1", decision: "survives", rationale: "Still present.", closure: "patch" }],
					}),
				),
			),
			"unknown-key",
		);
		const report = parseReviewVerification(verificationBlock({ schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "survives", rationale: "Still present." }] }));
		assert.deepEqual(Object.keys(report.decisions[0] ?? {}).sort(), ["candidateId", "decision", "rationale"]);
	});

	it("sidecar drafts still write finding objects without a closure key", () => {
		const finding: ReviewFinding = { severity: "must-fix", message: "Null deref in the parser.", path: "src/a.ts", line: 10, closure: "authority" };
		const fingerprint = reviewFindingFingerprint(finding);
		const carry = buildCarryDispositionDraft({
			prNumber: 495,
			itemId: "495",
			reviewedSha: "d".repeat(40),
			gate: "block",
			agreement: "consensus-block",
			ok: true,
			survivors: new Map([[fingerprint, finding]]),
			verifications: new Map([[fingerprint, { id: "C1", decision: "survives", rationale: "Confirmed." }]]),
			refutedThisRun: new Map(),
			autoRefutable: new Map(),
			carriedForward: [],
			changedFiles: ["src/a.ts"],
			taxonomy: BASELINE_TAXONOMY,
		});
		assert.ok(carry);
		assert.equal("closure" in carry.survived[0]!.finding, false);
		assert.deepEqual(carry.survived[0]?.finding, { severity: "must-fix", message: finding.message, path: finding.path, line: finding.line });

		const adjudication = buildAdjudicationSourceDraft({
			prNumber: 497,
			itemId: "497",
			reviewedSha: "a".repeat(40),
			agreement: "consensus-block",
			requiredCells: 1,
			completedCells: 1,
			ok: true,
			survivors: [finding],
			verifications: new Map([[fingerprint, { id: "C1", decision: "survives", rationale: "Still present." }]]),
			inspectionDiff: inspectionDiff(),
			changedFiles: ["src/a.ts"],
			taxonomy: BASELINE_TAXONOMY,
		});
		assert.ok(adjudication);
		assert.equal("closure" in adjudication.survivors[0]!.finding, false);
		assert.deepEqual(adjudication.survivors[0]?.finding, { severity: "must-fix", message: finding.message, path: finding.path, line: finding.line });
	});
});

describe("renderFindingClosureGuidance", () => {
	it("returns undefined for absent and patch, and the exact strings otherwise", () => {
		assert.equal(renderFindingClosureGuidance(undefined), undefined);
		assert.equal(renderFindingClosureGuidance("patch"), undefined);
		assert.equal(renderFindingClosureGuidance("construction"), "instance patch predicts recurrence — close by construction or record a residual");
		assert.equal(renderFindingClosureGuidance("authority"), "survivors recur in a class this item may not own — consider re-chartering");
		assert.equal(renderFindingClosureGuidance("policy"), "routed decision required");
	});

	it("is exhaustive over the canonical tuple", () => {
		const rendered = new Map<ReviewFindingClosure, string | undefined>();
		for (const mode of REVIEW_FINDING_CLOSURES) rendered.set(mode, renderFindingClosureGuidance(mode));
		assert.equal(rendered.size, 4);
		assert.equal(rendered.get("patch"), undefined);
		assert.ok(rendered.get("construction"));
		assert.ok(rendered.get("authority"));
		assert.ok(rendered.get("policy"));
	});
});

describe("operator guidance (#756 AC-5)", () => {
	it("supervised-run.md routes new mechanism through an authoring pass or chartered slice", () => {
		const body = readFileSync(resolve(repoRoot, "docs/agent-context/supervised-run.md"), "utf8");
		assert.match(body, /authoring pass or a separately chartered slice/);
		assert.match(body, /documented residual/);
		assert.match(body, /safety survivor is still not acknowledged through/);
		assert.match(body, /never an acknowledgement-through of a safety survivor/);
	});
});

describe("schema-example sentinels", () => {
	it("keeps packaged v3 and v1 (message, path, line) tuples", () => {
		assert.deepEqual(SCHEMA_EXAMPLE_FINDINGS, [
			{ message: "Concrete single-line finding.", path: "src/file.ts", line: 1 },
			{ message: "Concise single-line finding.", path: "src/file.ts", line: 12 },
		]);
	});
});
