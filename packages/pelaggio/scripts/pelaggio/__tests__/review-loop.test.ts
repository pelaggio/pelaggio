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

	it("excludes the artifact author from configured review seats", async () => {
		const invoked: string[] = [];
		const clean = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 2, summary: "clean", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy: { ...basePolicy, reviewers: [{ id: "author-seat", provider: "codex" }, ...basePolicy.reviewers] },
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
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
		// #244 regression: findings were dropped from a non-ok seat, so an ok empty seat could ship a
		// security must-fix. author=judge=claude lets both grok+codex reviewer seats survive the filter.
		const empty = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 2, summary: "clean", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
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
			runSeat: async (req) => {
				if (req.role === "judge") return ok(judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r", class: "security" }]));
				if (req.slot.provider === "grok") return ok(empty);
				// non-ok seat (max-turns) that still parsed a security must-fix
				return { ok: false, subtype: "error_max_turns", text: reviewerFindings("security"), fullText: reviewerFindings("security"), cost: 0, turns: 0 };
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.notEqual(result.outcome, "converged-clean");
		assert.ok(result.survivors.some((survivor) => survivor.finding.class === "security"));
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
		const pass = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 2, summary: "looks good", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const block = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 2, summary: "behavior is wrong", findings: [{ severity: "must-fix", class: "judgment", message: "boom" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy,
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
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

	it("does not manufacture a split when a reviewer echoes the SKILL.md schema example", async () => {
		// Reproduces the observed codex-seat failure (item #205 review-records): one reviewer echoed the
		// pr-review SKILL.md AUTHORING_REVIEW_FINDINGS example verbatim (fake must-fix at src/file.ts:1),
		// while the other genuinely passed. Before the fail-closed guard this schema-valid echo produced a
		// cross-model pass/block split, a safety-classed disagreement, and a spurious escalation/park. Now
		// the echoing seat is rejected fail-closed (recorded ok:false w/ diagnostic), so the clean seat
		// carries the pass with no disagreement.
		const policy = {
			...basePolicy,
			maxPasses: 1,
			reviewers: [
				{ id: "claude", provider: "claude" as const },
				{ id: "codex", provider: "codex" as const },
			],
		};
		const clean = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 2, summary: "looks good", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const exampleEcho = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 2, summary: "Concise single-line summary.", findings: [{ severity: "must-fix", class: "correctness-regression", message: "Concrete single-line finding.", path: "src/file.ts", line: 1 }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy,
			author: { provider: "grok" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			runSeat: async (request) => {
				if (request.role === "judge") return ok(judgeReport([]));
				return ok(request.slot.id === "codex" ? exampleEcho : clean);
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.equal(result.outcome, "converged-clean");
		assert.equal(result.disagreement, undefined);
		assert.equal(result.survivors.length, 0);
		const codexRecord = result.passes[0].reviewers.find((r) => r.identity.seatId === "codex");
		assert.equal(codexRecord?.ok, false);
		assert.match(codexRecord?.diagnostic ?? "", /schema example/);
	});

	it("retains a prior-pass safety blocker in a later pass/block escalation", async () => {
		const policy = {
			...basePolicy,
			reviewers: [
				{ id: "reviewer-a", provider: "grok" as const },
				{ id: "reviewer-b", provider: "claude" as const },
			],
		};
		const safetyBlock = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 2, summary: "security regression", findings: [{ severity: "must-fix", class: "security", message: "unsafe" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const pass = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 2, summary: "looks good", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const judgmentBlock = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 2, summary: "behavior is debatable", findings: [{ severity: "must-fix", class: "judgment", message: "debatable" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy,
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			runSeat: async (request) => {
				if (request.role === "judge") return ok(judgeReport([{ candidateId: "C1", decision: "survives", rationale: "revise", class: "security", ruling: "fixable-blocker" }]));
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
			result.survivors.some((item) => item.finding.class === "security"),
			true,
		);
	});

	it("ships when the Judge cleanly refutes the sole blocker", async () => {
		const result = await run(reviewerFindings("judgment"), judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r", class: "judgment" }]));
		assert.equal(result.outcome, "converged-clean");
	});

	it("does not honor a single Judge's refutation of a safety-class must-fix (#272)", async () => {
		const result = await run(reviewerFindings("security"), judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r", class: "security" }]));
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.at(-1)?.judge.valid, true);
		assert.equal(result.survivors[0]?.finding.class, "security");
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

	it("fails closed when the Judge reclassifies a safety candidate as judgment dissent", async () => {
		const result = await run(reviewerFindings("security"), judgeReport([{ candidateId: "C1", decision: "survives", rationale: "r", class: "judgment", ruling: "judgment-dissent" }]));
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.at(-1)?.judge.valid, false);
		assert.equal(result.survivors[0]?.finding.class, "security");
	});

	it("honors a Judge decision that omits the optional class and refutes a non-safety finding (#280)", async () => {
		const result = await run(reviewerFindings("judgment"), judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r" }]));
		assert.equal(result.outcome, "converged-clean");
		assert.equal(result.passes.at(-1)?.judge.valid, true);
	});

	it("inherits the candidate's safety class for a class-less refutation, still retaining it (#280 + #272)", async () => {
		const result = await run(reviewerFindings("security"), judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r" }]));
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.at(-1)?.judge.valid, true);
		assert.equal(result.survivors[0]?.finding.class, "security");
	});

	it("accepts a Judge elevating a non-safety candidate's class (elevation is not a downgrade)", async () => {
		const result = await run(reviewerFindings("judgment"), judgeReport([{ candidateId: "C1", decision: "survives", rationale: "r", class: "security", ruling: "fixable-blocker" }]));
		assert.equal(result.passes.at(-1)?.judge.valid, true);
	});
});
