import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyReviewPass,
	CLASSIFICATION_RULES,
	classifyAuthoringReviewFinding,
	evaluateReviewConvergence,
	extractDiffPathSignals,
	isSafetyClass,
	materializeAuthoringFinding,
	normalizeCwe,
	parseAuthoringReviewFindings,
	parseJudgeReport,
	parseReviewFindings,
	parseReviewVerification,
	type RawAuthoringReviewFinding,
	type ReviewFindingClass,
	ReviewFindingsParseError,
	reconcileReviewVerification,
	reviewFindingFingerprint,
	reviewFindingsGate,
	SAFETY_CLASSES,
} from "../review/findings.js";
import { resolveTaxonomy } from "../review/taxonomy.js";

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

const emptyCtx = { fingerprint: '["x","",0]', changedFiles: [] as string[], pathSignals: [] as const };

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

describe("parseAuthoringReviewFindings (schema v3)", () => {
	it("parses a valid v3 empty and populated report", () => {
		const empty = parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 3, summary: "Clean.", findings: [] }));
		assert.equal(empty.schemaVersion, 3);
		assert.deepEqual(empty.findings, []);
		const report = parseAuthoringReviewFindings(
			authoringBlock({
				schemaVersion: 3,
				summary: "Reviewed.",
				findings: [{ severity: "must-fix", message: "Leak.", path: "a.ts", line: 3, ruleId: "pelaggio/security/secret-leak", cwe: "CWE-798", classHint: "security-and-secrets" }],
			}),
		);
		assert.equal(report.findings[0].ruleId, "pelaggio/security/secret-leak");
		assert.equal(report.findings[0].cwe, "CWE-798");
		assert.equal(report.findings[0].classHint, "security-and-secrets");
		assert.equal(report.findings[0].line, 3);
		// Wire has no harness-owned class
		assert.equal("class" in report.findings[0], false);
	});

	it("normalizes CWE identifiers and rejects malformed evidence", () => {
		const report = parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 3, summary: "Ok.", findings: [{ severity: "note", message: "x", cwe: "cwe-079" }] }));
		assert.equal(report.findings[0].cwe, "CWE-79");
		assert.equal(normalizeCwe("CWE-079"), "CWE-79");
		for (const finding of [
			{ severity: "must-fix", message: "x", class: "security-and-secrets" },
			{ severity: "must-fix", message: "x", fingerprint: "abc" },
			{ severity: "must-fix", message: "x", cwe: "not-a-cwe" },
			{ severity: "must-fix", message: "x", ruleId: "" },
			{ severity: "must-fix", message: "x", ruleId: "a\nb" },
			// #294: classHint grammar is validated (kebab tokens), not a closed list.
			{ severity: "must-fix", message: "x", classHint: "Style" },
			{ severity: "must-fix", message: "x", classHint: "bad hint" },
		]) {
			assert.throws(() => parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 3, summary: "Ok.", findings: [finding] })), ReviewFindingsParseError);
		}
	});

	it("accepts a well-formed unknown classHint on the wire (#294 open grammar)", () => {
		const report = parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 3, summary: "Ok.", findings: [{ severity: "must-fix", message: "x", classHint: "experimental-lint" }] }));
		assert.equal(report.findings[0].classHint, "experimental-lint");
		// Unmatched by any emission rule ⇒ still default-safety (classHint alone never classifies).
		const materialized = materializeAuthoringFinding(report.findings[0], { changedFiles: [] });
		assert.equal(materialized.classification.kind, "default-safety");
		assert.equal(materialized.class, "correctness-regression");
	});

	it("rejects v2, mixed schemas, and unsupported versions", () => {
		assert.throws(() => parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 2, summary: "Ok.", findings: [] })), ReviewFindingsParseError);
		assert.throws(() => parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 1, summary: "Ok.", findings: [] })), ReviewFindingsParseError);
		const v3 = authoringBlock({ schemaVersion: 3, summary: "Ok.", findings: [] });
		const v2 = authoringBlock({ schemaVersion: 2, summary: "Old.", findings: [{ severity: "must-fix", class: "security", message: "x" }] });
		assert.throws(() => parseAuthoringReviewFindings(`${v3}\n${v2}`), ReviewFindingsParseError);
	});

	it("unions findings across multiple v3 blocks instead of dropping the seat (#280)", () => {
		const two = `${authoringBlock({ schemaVersion: 3, summary: "First.", findings: [{ severity: "must-fix", message: "Leak.", ruleId: "pelaggio/security/secret-leak" }] })}\n${authoringBlock({ schemaVersion: 3, summary: "Second.", findings: [{ severity: "note", message: "Style.", ruleId: "pelaggio/judgment/style" }] })}`;
		const report = parseAuthoringReviewFindings(two);
		assert.equal(report.findings.length, 2);
		assert.equal(report.summary, "First.");
	});

	it("still fails closed when one of several blocks is malformed (#280)", () => {
		const good = authoringBlock({ schemaVersion: 3, summary: "Ok.", findings: [{ severity: "must-fix", message: "Leak." }] });
		assert.throws(() => parseAuthoringReviewFindings(`${good}\nAUTHORING_REVIEW_FINDINGS\n{nope}\nEND_AUTHORING_REVIEW_FINDINGS`), ReviewFindingsParseError);
	});

	it("rejects the SKILL.md schema example echoed verbatim instead of a real review", () => {
		// The exact placeholder from `.claude/skills/pr-review/SKILL.md`'s AUTHORING_REVIEW_FINDINGS
		// example. Observed from the codex reviewer seat parroting the example (1 turn, no diff read),
		// which manufactured a fake must-fix / correctness-regression at src/file.ts:1 and a spurious
		// cross-model split. Fail closed so the seat reads as incomplete, not as a real blocker.
		const echoed = authoringBlock({
			schemaVersion: 3,
			summary: "Concise single-line summary.",
			findings: [{ severity: "must-fix", message: "Concrete single-line finding.", path: "src/file.ts", line: 1 }],
		});
		assert.throws(() => parseAuthoringReviewFindings(echoed), ReviewFindingsParseError);
		// A fake-clean echo (example summary, no findings) is rejected too.
		assert.throws(() => parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 3, summary: "Concise single-line summary.", findings: [] })), ReviewFindingsParseError);
		// The example finding smuggled under a real summary is still rejected.
		assert.throws(
			() => parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 3, summary: "Reviewed the claim-branch delete gating.", findings: [{ severity: "must-fix", message: "Concrete single-line finding.", path: "src/file.ts", line: 1 }] })),
			ReviewFindingsParseError,
		);
		// A genuine review that merely mentions the example path in a real message is NOT rejected.
		const real = parseAuthoringReviewFindings(authoringBlock({ schemaVersion: 3, summary: "Real review.", findings: [{ severity: "must-fix", message: "Token leaked in src/file.ts logging.", path: "src/file.ts", line: 42 }] }));
		assert.equal(real.findings.length, 1);
	});
});

describe("classifyAuthoringReviewFinding", () => {
	const base: RawAuthoringReviewFinding = { severity: "must-fix", message: "problem" };

	it("maps every safety class via rules and judgment via allowlist", () => {
		const cases: Array<{ raw: RawAuthoringReviewFinding; path?: string; expected: ReviewFindingClass }> = [
			{ raw: { ...base, ruleId: "pelaggio/security/secret-leak" }, expected: "security-and-secrets" },
			{ raw: { ...base, cwe: "CWE-404" }, expected: "data-loss/destructive-ops" },
			{ raw: { ...base, ruleId: "pelaggio/supply-chain/lifecycle-script" }, expected: "supply-chain/integrity" },
			{ raw: { ...base, ruleId: "pelaggio/containment/write-guard" }, expected: "containment-escape" },
			{ raw: { ...base, ruleId: "pelaggio/git/force-push" }, expected: "irreversible-git/unsafe-landing" },
			{ raw: { ...base, message: "unmatched alone" }, expected: "correctness-regression" },
			{ raw: { ...base, ruleId: "pelaggio/judgment/style" }, expected: "judgment" },
		];
		for (const { raw, expected } of cases) {
			const pathSignals = extractDiffPathSignals(raw.path);
			const result = classifyAuthoringReviewFinding(raw, { ...emptyCtx, fingerprint: reviewFindingFingerprint(raw), pathSignals });
			assert.equal(result.class, expected, `expected ${expected} for ${JSON.stringify(raw)}`);
		}
		// path signal
		const pathFinding: RawAuthoringReviewFinding = { severity: "must-fix", message: "workflow risk", path: ".github/workflows/ci.yml" };
		const pathResult = classifyAuthoringReviewFinding(pathFinding, {
			fingerprint: reviewFindingFingerprint(pathFinding),
			changedFiles: [".github/workflows/ci.yml"],
			pathSignals: extractDiffPathSignals(pathFinding.path),
		});
		assert.equal(pathResult.class, "security-and-secrets");
		assert.equal(pathResult.kind, "matched");
	});

	it("defaults unmatched, unknown ruleId, and classHint-only to safety (load-bearing)", () => {
		for (const raw of [
			{ severity: "must-fix" as const, message: "no evidence" },
			{ severity: "must-fix" as const, message: "unknown rule", ruleId: "pelaggio/unknown/thing" },
			{ severity: "must-fix" as const, message: "hint only", classHint: "judgment" as const },
			{ severity: "must-fix" as const, message: "hint security only", classHint: "security-and-secrets" as const },
			{ severity: "must-fix" as const, message: "unknown cwe", cwe: "CWE-99999" },
		]) {
			const result = classifyAuthoringReviewFinding(raw, { ...emptyCtx, fingerprint: reviewFindingFingerprint(raw) });
			assert.equal(result.kind, "default-safety");
			assert.equal(result.class, "correctness-regression");
			assert.ok(isSafetyClass(result.class));
		}
	});

	it("never yields judgment from classHint alone", () => {
		const raw: RawAuthoringReviewFinding = { severity: "must-fix", message: "style?", classHint: "judgment" };
		const result = classifyAuthoringReviewFinding(raw, { ...emptyCtx, fingerprint: reviewFindingFingerprint(raw) });
		assert.notEqual(result.class, "judgment");
		assert.equal(result.kind, "default-safety");
	});

	it("safety beats judgment when signals conflict", () => {
		const raw: RawAuthoringReviewFinding = {
			severity: "must-fix",
			message: "both",
			ruleId: "pelaggio/judgment/style",
			cwe: "CWE-78",
		};
		const result = classifyAuthoringReviewFinding(raw, { ...emptyCtx, fingerprint: reviewFindingFingerprint(raw) });
		assert.equal(result.class, "security-and-secrets");
		assert.equal(result.kind, "matched");
	});

	it("conflicting safety classes pick winner by SAFETY_CLASSES precedence and record conflict", () => {
		// CWE-78 → security-and-secrets; CWE-404 is separate — use ruleId + path for two safety classes
		const raw: RawAuthoringReviewFinding = {
			severity: "must-fix",
			message: "conflict",
			ruleId: "pelaggio/containment/write-guard",
			path: "package.json",
		};
		const pathSignals = extractDiffPathSignals(raw.path);
		const result = classifyAuthoringReviewFinding(raw, {
			fingerprint: reviewFindingFingerprint(raw),
			changedFiles: ["package.json"],
			pathSignals,
		});
		assert.equal(result.kind, "matched");
		if (result.kind === "matched") {
			// supply-chain (lifecycle-manifest) vs containment-escape — security precedence: supply-chain is earlier than containment
			assert.equal(result.class, "supply-chain/integrity");
			assert.ok(result.conflict);
			assert.ok(result.conflict?.losers.includes("containment-escape"));
		}
	});

	it("elevates judgment-rule match when classHint is a safety class", () => {
		const raw: RawAuthoringReviewFinding = {
			severity: "must-fix",
			message: "elevated",
			ruleId: "pelaggio/judgment/style",
			classHint: "data-loss/destructive-ops",
		};
		const result = classifyAuthoringReviewFinding(raw, { ...emptyCtx, fingerprint: reviewFindingFingerprint(raw) });
		assert.equal(result.class, "data-loss/destructive-ops");
		assert.equal(result.kind, "matched");
		if (result.kind === "matched") assert.equal(result.signal, "classHint-elevation");
	});

	it("materializeAuthoringFinding attaches harness class and classification", () => {
		const raw: RawAuthoringReviewFinding = { severity: "must-fix", message: "secret", ruleId: "pelaggio/security/secret-leak" };
		const finding = materializeAuthoringFinding(raw, { changedFiles: [] });
		assert.equal(finding.class, "security-and-secrets");
		assert.equal(finding.classification.kind, "matched");
	});

	it("elevates a judgment-rule match to a taxonomy-extended safety class (#294)", () => {
		const taxonomy = resolveTaxonomy({ classes: { "experimental-lint": "safety" } });
		const raw: RawAuthoringReviewFinding = { severity: "must-fix", message: "elevated", ruleId: "pelaggio/judgment/style", classHint: "experimental-lint" };
		// Baseline taxonomy: experimental-lint is unknown ⇒ safety, so it already elevates; the point is the
		// finding resolves to safety and materialize threads the taxonomy through to the same class.
		const result = classifyAuthoringReviewFinding(raw, { ...emptyCtx, fingerprint: reviewFindingFingerprint(raw) }, taxonomy);
		assert.equal(result.class, "experimental-lint");
		assert.equal(isSafetyClass("experimental-lint", taxonomy), true);
		assert.equal(materializeAuthoringFinding(raw, { changedFiles: [] }, taxonomy).class, "experimental-lint");
	});

	it("exposes a non-empty rule table and closed safety set", () => {
		assert.ok(CLASSIFICATION_RULES.length > 0);
		assert.equal(SAFETY_CLASSES.length, 6);
		assert.ok(CLASSIFICATION_RULES.every((r) => r.id && r.signal && r.class));
		// fingerprint inventory intentionally empty in this item
		assert.equal(CLASSIFICATION_RULES.filter((r) => r.signal === "fingerprint").length, 0);
	});
});

describe("extractDiffPathSignals", () => {
	it("maps representative paths to closed signal kinds", () => {
		assert.deepEqual(extractDiffPathSignals(".github/workflows/ci.yml"), ["workflow"]);
		assert.deepEqual(extractDiffPathSignals("package.json"), ["lifecycle-manifest"]);
		assert.deepEqual(extractDiffPathSignals("pnpm-lock.yaml"), ["dependency-lock"]);
		assert.deepEqual(extractDiffPathSignals("packages/pelaggio/scripts/pelaggio/step-runner.ts"), ["confinement-surface"]);
		assert.deepEqual(extractDiffPathSignals("packages/pelaggio/scripts/pelaggio/ship/direct-push.ts"), ["ship-landing"]);
		assert.deepEqual(extractDiffPathSignals("packages/server/src/auth.ts"), ["secrets-adjacent"]);
		assert.deepEqual(extractDiffPathSignals(undefined), []);
		assert.deepEqual(extractDiffPathSignals("docs/readme.md"), []);
	});
});

describe("parseJudgeReport", () => {
	it("parses refuted and surviving decisions with rulings and six-class tokens", () => {
		const report = parseJudgeReport(
			judgeBlock({
				schemaVersion: 1,
				decisions: [
					{ candidateId: "C1", decision: "refuted", rationale: "Not reachable.", class: "security-and-secrets" },
					{ candidateId: "C2", decision: "survives", rationale: "Reproduced.", class: "correctness-regression", ruling: "fixable-blocker" },
					{ candidateId: "C3", decision: "survives", rationale: "Bad dep.", class: "supply-chain/integrity", ruling: "unfixable-blocker" },
				],
			}),
		);
		assert.equal(report.decisions[1].ruling, "fixable-blocker");
		assert.equal(report.decisions[2].class, "supply-chain/integrity");
	});

	it("fails closed on a surviving decision without a ruling and on mismatched dissent class", () => {
		assert.throws(() => parseJudgeReport(judgeBlock({ schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "survives", rationale: "r", class: "judgment" }] })), ReviewFindingsParseError);
		assert.throws(() => parseJudgeReport(judgeBlock({ schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "survives", rationale: "r", class: "security-and-secrets", ruling: "judgment-dissent" }] })), ReviewFindingsParseError);
		// #294: malformed (non-kebab) class tokens rejected; a well-formed unknown token now parses.
		assert.throws(() => parseJudgeReport(judgeBlock({ schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "refuted", rationale: "r", class: "Security" }] })), ReviewFindingsParseError);
		assert.equal(parseJudgeReport(judgeBlock({ schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "refuted", rationale: "r", class: "experimental-lint" }] })).decisions[0].class, "experimental-lint");
	});

	it("treats decision class as optional, inherited from the candidate (#280)", () => {
		const refuted = parseJudgeReport(judgeBlock({ schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "refuted", rationale: "Not reachable." }] }));
		assert.equal(refuted.decisions[0].class, undefined);
		const surviving = parseJudgeReport(judgeBlock({ schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "survives", rationale: "Reproduced.", ruling: "fixable-blocker" }] }));
		assert.equal(surviving.decisions[0].class, undefined);
		assert.equal(surviving.decisions[0].ruling, "fixable-blocker");
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
