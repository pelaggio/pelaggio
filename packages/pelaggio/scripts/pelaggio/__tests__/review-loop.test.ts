import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuthoringReviewConfig } from "../config.js";
import { type AuthoringReviewFinding, isSafetyClass, materializeAuthoringFinding, type ReviewFindingClass, SAFETY_CLASSES } from "../review/findings.js";
import { classifyReviewOutcome, deduplicateCandidates, type ReviewCandidate, runReviewLoop } from "../review/loop.js";
import type { StepResult } from "../types.js";

const emptyClassification = { changedFiles: [] as string[] };

const effective = (className: ReviewFindingClass, severity: "must-fix" | "note" | "nice" = "must-fix", message = "problem"): AuthoringReviewFinding =>
	materializeAuthoringFinding(
		className === "judgment"
			? { severity, message, ruleId: "pelaggio/judgment/style" }
			: className === "security-and-secrets"
				? { severity, message, ruleId: "pelaggio/security/secret-leak" }
				: className === "data-loss/destructive-ops"
					? { severity, message, cwe: "CWE-404" }
					: className === "supply-chain/integrity"
						? { severity, message, ruleId: "pelaggio/supply-chain/lifecycle-script" }
						: className === "containment-escape"
							? { severity, message, ruleId: "pelaggio/containment/write-guard" }
							: className === "irreversible-git/unsafe-landing"
								? { severity, message, ruleId: "pelaggio/git/force-push" }
								: { severity, message }, // correctness-regression via default-safety
		emptyClassification,
	);

const candidate = (className: ReviewFindingClass, severity: "must-fix" | "note" = "must-fix"): ReviewCandidate => ({
	candidateId: "C1",
	fingerprint: "fp",
	sources: ["reviewer"],
	finding: effective(className, severity),
});

describe("authoring review outcome", () => {
	it("classifies every non-budget terminal family", () => {
		assert.equal(classifyReviewOutcome([], [], new Map(), true, 1), "converged-clean");
		assert.equal(classifyReviewOutcome([], [candidate("judgment", "note")], new Map(), true, 1), "converged-with-notes");
		assert.equal(classifyReviewOutcome([], [candidate("judgment", "note")], new Map(), true, 2), "ceiling");
		assert.equal(classifyReviewOutcome([candidate("judgment")], [], new Map([["C1", "judgment-dissent"]]), true, 2), "dissent");
		assert.equal(classifyReviewOutcome([candidate("security-and-secrets")], [], new Map([["C1", "judgment-dissent"]]), true, 2), "hard-block");
		assert.equal(classifyReviewOutcome([], [], new Map(), false, 1), "hard-block");
	});

	it("deduplicates deterministically and preserves a safety claim + classification", () => {
		const findings = deduplicateCandidates([
			{ source: "a", finding: effective("judgment", "must-fix", "same") },
			{ source: "b", finding: effective("security-and-secrets", "must-fix", "same") },
		]);
		assert.equal(findings.length, 1);
		assert.equal(findings[0].finding.class, "security-and-secrets");
		assert.equal(findings[0].finding.classification.kind, "matched");
		assert.deepEqual(findings[0].sources, ["a", "b"]);
	});

	it("treats all six safety classes as hard-block survivors", () => {
		for (const cls of SAFETY_CLASSES) {
			assert.equal(classifyReviewOutcome([candidate(cls)], [], new Map([["C1", "fixable-blocker"]]), true, 1), "hard-block");
			assert.ok(isSafetyClass(cls));
		}
	});
});

describe("authoring review loop controller", () => {
	const basePolicy: AuthoringReviewConfig = {
		enabled: true,
		reviewers: [{ id: "grok", provider: "grok" }],
		judge: { id: "judge", provider: "claude" },
		blockingBar: "must-fix",
		maxPasses: 2,
		maxRevisions: 1,
		budgetCap: 100,
		providerDiversity: "prefer",
	};
	const ok = (fullText: string): StepResult => ({ ok: true, subtype: "success", text: fullText, fullText, cost: 0, turns: 0 });
	/** schema v3 raw evidence — harness classifies. */
	const reviewerFindings = (kind: "safety" | "judgment" | "hint-judgment" | "unmatched") => {
		const finding =
			kind === "safety"
				? { severity: "must-fix", message: "boom", ruleId: "pelaggio/security/secret-leak" }
				: kind === "judgment"
					? { severity: "must-fix", message: "boom", ruleId: "pelaggio/judgment/style" }
					: kind === "hint-judgment"
						? { severity: "must-fix", message: "boom", classHint: "judgment" }
						: { severity: "must-fix", message: "boom" };
		return `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "s", findings: [finding] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
	};
	const judgeReport = (decisions: unknown[]) => `AUTHORING_REVIEW_JUDGE\n${JSON.stringify({ schemaVersion: 1, decisions })}\nEND_AUTHORING_REVIEW_JUDGE`;
	const run = (reviewerText: string, judgeText: string) =>
		runReviewLoop({
			policy: basePolicy,
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			runSeat: async (req) => ok(req.role === "reviewer" ? reviewerText : req.role === "judge" ? judgeText : ""),
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});

	it("excludes the artifact author from configured review seats", async () => {
		const invoked: string[] = [];
		const clean = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "clean", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy: { ...basePolicy, reviewers: [{ id: "author-seat", provider: "codex" }, ...basePolicy.reviewers] },
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			runSeat: async (request) => {
				invoked.push(request.slot.id);
				return ok(request.role === "judge" ? judgeReport([]) : clean);
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.equal(result.outcome, "converged-clean");
		assert.deepEqual(invoked, ["grok", "judge"]);
	});

	it("ingests a security must-fix from a NON-ok reviewer seat (no fail-open)", async () => {
		const empty = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "clean", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy: {
				...basePolicy,
				maxPasses: 1,
				reviewers: [
					{ id: "grok", provider: "grok" },
					{ id: "codex", provider: "codex" },
				],
			},
			author: { provider: "claude" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			runSeat: async (req) => {
				if (req.role === "judge") return ok(judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r", class: "security-and-secrets" }]));
				if (req.slot.provider === "grok") return ok(empty);
				return { ok: false, subtype: "error_max_turns", text: reviewerFindings("safety"), fullText: reviewerFindings("safety"), cost: 0, turns: 0 };
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.notEqual(result.outcome, "converged-clean");
		assert.ok(result.survivors.some((survivor) => survivor.finding.class === "security-and-secrets"));
	});

	it("escalates a stable pass/block split before invoking the Judge", async () => {
		let judgeCalls = 0;
		const policy = {
			...basePolicy,
			reviewers: [
				{ id: "reviewer-a", provider: "grok" as const },
				{ id: "reviewer-b", provider: "claude" as const },
			],
		};
		const pass = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "looks good", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const block = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "behavior is wrong", findings: [{ severity: "must-fix", message: "boom", ruleId: "pelaggio/judgment/style" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy,
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			runSeat: async (request) => {
				if (request.role === "judge") judgeCalls++;
				return ok(request.slot.id === "reviewer-a" ? pass : block);
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.equal(result.outcome, "dissent");
		assert.equal(judgeCalls, 0);
		assert.deepEqual(
			result.disagreement?.drivers.map(({ verdict }) => verdict),
			["pass", "block"],
		);
		assert.match(result.disagreement?.evidenceFingerprint ?? "", /^[a-f0-9]{64}$/);
	});

	it("retains a prior-pass safety blocker in a later pass/block escalation", async () => {
		const policy = {
			...basePolicy,
			reviewers: [
				{ id: "reviewer-a", provider: "grok" as const },
				{ id: "reviewer-b", provider: "claude" as const },
			],
		};
		const safetyBlock = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "security regression", findings: [{ severity: "must-fix", message: "unsafe", ruleId: "pelaggio/security/secret-leak" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const pass = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "looks good", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const judgmentBlock = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "behavior is debatable", findings: [{ severity: "must-fix", message: "debatable", ruleId: "pelaggio/judgment/style" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy,
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			runSeat: async (request) => {
				if (request.role === "judge") return ok(judgeReport([{ candidateId: "C1", decision: "survives", rationale: "revise", class: "security-and-secrets", ruling: "fixable-blocker" }]));
				if (request.role === "author") return ok("");
				if (request.pass === 1) return ok(safetyBlock);
				return ok(request.slot.id === "reviewer-a" ? pass : judgmentBlock);
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.disagreement?.pass, 2);
		assert.equal(result.disagreement?.hasSafetyBlocker, true);
		assert.equal(
			result.survivors.some((item) => item.finding.class === "security-and-secrets"),
			true,
		);
	});

	it("ships when the Judge cleanly refutes a judgment-allowlist must-fix", async () => {
		const result = await run(reviewerFindings("judgment"), judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r", class: "judgment" }]));
		assert.equal(result.outcome, "converged-clean");
		assert.equal(result.survivors.length, 0);
	});

	it("classHint judgment alone is harness-safety and cannot be cleared by Judge (hard-block)", async () => {
		const result = await run(reviewerFindings("hint-judgment"), judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r", class: "judgment" }]));
		assert.equal(result.outcome, "hard-block");
		assert.ok(isSafetyClass(result.survivors[0]?.finding.class ?? ""));
		assert.equal(result.survivors[0]?.finding.class, "correctness-regression");
		assert.equal(result.survivors[0]?.finding.classification.kind, "default-safety");
	});

	it("unmatched finding defaults to safety and hard-blocks", async () => {
		const result = await run(reviewerFindings("unmatched"), judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r" }]));
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.survivors[0]?.finding.classification.kind, "default-safety");
	});

	it("does not honor a single Judge's refutation of a safety-class must-fix (#272)", async () => {
		const result = await run(reviewerFindings("safety"), judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r", class: "security-and-secrets" }]));
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.at(-1)?.judge.valid, true);
		assert.equal(result.survivors[0]?.finding.class, "security-and-secrets");
	});

	it("fails closed when the Judge duplicates a decision for the sole blocker (does not ship)", async () => {
		const result = await run(
			reviewerFindings("judgment"),
			judgeReport([
				{ candidateId: "C1", decision: "refuted", rationale: "r", class: "judgment" },
				{ candidateId: "C1", decision: "survives", rationale: "r", class: "judgment" },
			]),
		);
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.at(-1)?.judge.valid, false);
	});

	it("keeps a same-fingerprint must-fix from being downgraded to a note by a higher-class nice", () => {
		const findings = deduplicateCandidates([
			{ source: "a", finding: effective("judgment", "must-fix", "same") },
			{ source: "b", finding: effective("security-and-secrets", "nice", "same") },
		]);
		assert.equal(findings.length, 1);
		assert.equal(findings[0].finding.severity, "must-fix");
	});

	it("fails closed when the Judge report references an unknown candidate (does not ship)", async () => {
		const result = await run(
			reviewerFindings("safety"),
			judgeReport([
				{ candidateId: "C1", decision: "refuted", rationale: "r", class: "security-and-secrets" },
				{ candidateId: "C2", decision: "refuted", rationale: "r", class: "judgment" },
			]),
		);
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.at(-1)?.judge.valid, false);
	});

	it("fails closed when the Judge reclassifies a safety candidate as judgment dissent", async () => {
		const result = await run(reviewerFindings("safety"), judgeReport([{ candidateId: "C1", decision: "survives", rationale: "r", class: "judgment", ruling: "judgment-dissent" }]));
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.at(-1)?.judge.valid, false);
		assert.equal(result.survivors[0]?.finding.class, "security-and-secrets");
	});

	it("honors a Judge decision that omits the optional class and refutes a non-safety finding (#280)", async () => {
		const result = await run(reviewerFindings("judgment"), judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r" }]));
		assert.equal(result.outcome, "converged-clean");
		assert.equal(result.passes.at(-1)?.judge.valid, true);
	});

	it("inherits the candidate's safety class for a class-less refutation, still retaining it (#280 + #272)", async () => {
		const result = await run(reviewerFindings("safety"), judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r" }]));
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.at(-1)?.judge.valid, true);
		assert.equal(result.survivors[0]?.finding.class, "security-and-secrets");
	});

	it("accepts a Judge elevating a non-safety candidate's class (elevation is not a downgrade)", async () => {
		const result = await run(reviewerFindings("judgment"), judgeReport([{ candidateId: "C1", decision: "survives", rationale: "r", class: "security-and-secrets", ruling: "fixable-blocker" }]));
		assert.equal(result.passes.at(-1)?.judge.valid, true);
		// Elevation request does not mutate the harness-owned candidate class today
		assert.equal(result.survivors[0]?.finding.class, "judgment");
	});

	it("carries initial harness classification across passes when later reviewers omit the finding", async () => {
		const policy = { ...basePolicy, maxPasses: 2 };
		const safety = reviewerFindings("safety");
		const clean = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "clean", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		let passCount = 0;
		const result = await runReviewLoop({
			policy,
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			runSeat: async (request) => {
				if (request.role === "judge") {
					return ok(judgeReport([{ candidateId: "C1", decision: "survives", rationale: "keep", class: "security-and-secrets", ruling: "fixable-blocker" }]));
				}
				if (request.role === "author") return ok("");
				passCount++;
				return ok(passCount === 1 ? safety : clean);
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.survivors[0]?.finding.class, "security-and-secrets");
		assert.equal(result.survivors[0]?.finding.classification.kind, "matched");
	});

	it("table-tests all six safety classes through Judge anti-downgrade retention", async () => {
		for (const cls of SAFETY_CLASSES) {
			const ruleFinding =
				cls === "security-and-secrets"
					? { severity: "must-fix", message: `m-${cls}`, ruleId: "pelaggio/security/secret-leak" }
					: cls === "data-loss/destructive-ops"
						? { severity: "must-fix", message: `m-${cls}`, cwe: "CWE-404" }
						: cls === "supply-chain/integrity"
							? { severity: "must-fix", message: `m-${cls}`, ruleId: "pelaggio/supply-chain/lifecycle-script" }
							: cls === "containment-escape"
								? { severity: "must-fix", message: `m-${cls}`, ruleId: "pelaggio/containment/write-guard" }
								: cls === "irreversible-git/unsafe-landing"
									? { severity: "must-fix", message: `m-${cls}`, ruleId: "pelaggio/git/force-push" }
									: { severity: "must-fix", message: `m-${cls}` };
			const text = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "s", findings: [ruleFinding] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
			const result = await run(text, judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r", class: cls }]));
			assert.equal(result.outcome, "hard-block", cls);
			assert.equal(result.survivors[0]?.finding.class, cls, cls);
			assert.ok(isSafetyClass(result.survivors[0]!.finding.class));
		}
	});
});
