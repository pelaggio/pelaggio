import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuthoringReviewConfig } from "../config.js";
import { classifyReviewOutcome, deduplicateCandidates, type ReviewCandidate, runReviewLoop } from "../review/loop.js";
import type { StepResult } from "../types.js";

const candidate = (className: "security" | "judgment", severity: "must-fix" | "note" = "must-fix"): ReviewCandidate => ({
	candidateId: "C1",
	fingerprint: "fp",
	sources: ["reviewer"],
	finding: { severity, class: className, message: "problem" },
});

describe("authoring review outcome", () => {
	it("classifies every non-budget terminal family", () => {
		assert.equal(classifyReviewOutcome([], [], new Map(), true, 1), "converged-clean");
		assert.equal(classifyReviewOutcome([], [candidate("judgment", "note")], new Map(), true, 1), "converged-with-notes");
		assert.equal(classifyReviewOutcome([], [candidate("judgment", "note")], new Map(), true, 2), "ceiling");
		assert.equal(classifyReviewOutcome([candidate("judgment")], [], new Map([["C1", "judgment-dissent"]]), true, 2), "dissent");
		assert.equal(classifyReviewOutcome([candidate("security")], [], new Map([["C1", "judgment-dissent"]]), true, 2), "hard-block");
		assert.equal(classifyReviewOutcome([], [], new Map(), false, 1), "hard-block");
	});

	it("deduplicates deterministically and preserves a safety claim", () => {
		const findings = deduplicateCandidates([
			{ source: "a", finding: { severity: "must-fix", class: "judgment", message: "same" } },
			{ source: "b", finding: { severity: "must-fix", class: "security", message: "same" } },
		]);
		assert.equal(findings.length, 1);
		assert.equal(findings[0].finding.class, "security");
		assert.deepEqual(findings[0].sources, ["a", "b"]);
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
	const reviewerFindings = (className: "security" | "judgment") =>
		`AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 2, summary: "s", findings: [{ severity: "must-fix", class: className, message: "boom" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
	const judgeReport = (decisions: unknown[]) => `AUTHORING_REVIEW_JUDGE\n${JSON.stringify({ schemaVersion: 1, decisions })}\nEND_AUTHORING_REVIEW_JUDGE`;
	const run = (reviewerText: string, judgeText: string) =>
		runReviewLoop({
			policy: basePolicy,
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			runSeat: async (req) => ok(req.role === "reviewer" ? reviewerText : req.role === "judge" ? judgeText : ""),
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});

	it("ships when the Judge cleanly refutes the sole blocker", async () => {
		const result = await run(reviewerFindings("judgment"), judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r", class: "judgment" }]));
		assert.equal(result.outcome, "converged-clean");
	});

	it("fails closed when the Judge duplicates a decision for the sole blocker (does not ship)", async () => {
		// Duplicate decisions for C1 still cover every id, so the distinct-count check alone passes and
		// the survivor filter's first-match would silently drop the blocker (refuted-first → converged-clean).
		// The length check must invalidate the pass instead.
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
		// classRank alone would let the second (nice/security) finding replace the first (must-fix/judgment),
		// dropping it from carried blockers; blockingRank must keep the most-blocking severity.
		const findings = deduplicateCandidates([
			{ source: "a", finding: { severity: "must-fix", class: "judgment", message: "same" } },
			{ source: "b", finding: { severity: "nice", class: "security", message: "same" } },
		]);
		assert.equal(findings.length, 1);
		assert.equal(findings[0].finding.severity, "must-fix");
	});

	it("fails closed when the Judge report references an unknown candidate (does not ship)", async () => {
		// C2 does not exist among the deduped candidates → completeness check invalidates the pass.
		const result = await run(
			reviewerFindings("security"),
			judgeReport([
				{ candidateId: "C1", decision: "refuted", rationale: "r", class: "security" },
				{ candidateId: "C2", decision: "refuted", rationale: "r", class: "judgment" },
			]),
		);
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.at(-1)?.judge.valid, false);
	});
});
