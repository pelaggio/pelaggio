import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuthoringReviewConfig } from "../config.js";
import { type AuthoringReviewFinding, isSafetyClass, type JudgeRuling, materializeAuthoringFinding, type ReviewFindingClass, SAFETY_CLASSES } from "../review/findings.js";
import { classifyReviewDisagreement, classifyReviewOutcome, type DriverIdentity, deduplicateCandidates, type ReviewCandidate, type ReviewLoopResult, type ReviewPassRecord, runReviewLoop, type SeatAttemptRecord } from "../review/loop.js";
import { renderReviewRecord } from "../review/record.js";
import { BASELINE_TAXONOMY, resolveTaxonomy } from "../review/taxonomy.js";
import type { StepResult, TokenUsage } from "../types.js";

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
		assert.equal(classifyReviewOutcome([], [], new Map(), 1), "converged-clean");
		assert.equal(classifyReviewOutcome([], [candidate("judgment", "note")], new Map(), 1), "converged-with-notes");
		assert.equal(classifyReviewOutcome([], [candidate("judgment", "note")], new Map(), 2), "ceiling");
		assert.equal(classifyReviewOutcome([candidate("judgment")], [], new Map([["C1", "judgment-dissent"]]), 2), "dissent");
		assert.equal(classifyReviewOutcome([candidate("security-and-secrets")], [], new Map([["C1", "judgment-dissent"]]), 2), "hard-block");
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
			assert.equal(classifyReviewOutcome([candidate(cls)], [], new Map([["C1", "fixable-blocker"]]), 1), "hard-block");
			assert.ok(isSafetyClass(cls));
		}
	});

	it("hard-blocks a survivor whose class is a taxonomy-extended safety class (#294)", () => {
		const taxonomy = resolveTaxonomy({ classes: { "experimental-lint": "safety" } });
		// Judgment rule + safety-tier classHint elevates the finding to the extended safety class.
		const finding = materializeAuthoringFinding({ severity: "must-fix", message: "extended", ruleId: "pelaggio/judgment/style", classHint: "experimental-lint" }, emptyClassification, taxonomy);
		const extended: ReviewCandidate = { candidateId: "C1", fingerprint: "fp", sources: ["reviewer"], finding };
		assert.equal(finding.class, "experimental-lint");
		assert.equal(classifyReviewOutcome([extended], [], new Map([["C1", "fixable-blocker"]]), 1, taxonomy), "hard-block");
		// Under the baseline taxonomy the same token is still safety (unknown ⇒ safety), so it also blocks.
		assert.equal(classifyReviewOutcome([extended], [], new Map([["C1", "fixable-blocker"]]), 1), "hard-block");
	});
});

describe("authoring review loop controller", () => {
	const basePolicy: AuthoringReviewConfig = {
		enabled: "local" as const,
		reviewers: [{ id: "grok", provider: "grok" }],
		judge: { id: "judge", provider: "claude" },
		blockingBar: "must-fix",
		maxPasses: 5,
		maxRevisions: 4,
		budgetCap: 1000,
		providerDiversity: "prefer",
	};
	const ok = (fullText: string): StepResult => ({ ok: true, subtype: "success", text: fullText, fullText, assistantText: fullText, cost: 0, turns: 0 });
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
			taxonomy: BASELINE_TAXONOMY,
			runSeat: async (req) => ok(req.role === "reviewer" ? reviewerText : req.role === "judge" ? judgeText : ""),
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});

	it("retains returned reviewer and Judge tokens and leaves rejected/skipped seats tokenless", async () => {
		const tokens: TokenUsage = { input: 11, output: 7, cacheCreation: 1, cacheRead: 2 };
		const judgeTokens: TokenUsage = { input: 5, output: 3, cacheCreation: 0, cacheRead: 0 };
		const clean = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "clean", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy: {
				...basePolicy,
				reviewers: [
					{ id: "grok", provider: "grok" },
					{ id: "codex", provider: "codex" },
				],
			},
			author: { provider: "claude" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			runSeat: async (req) => {
				if (req.role === "reviewer" && req.slot.provider === "codex") throw new Error("seat rejected");
				if (req.role === "judge") return { ...ok(judgeReport([])), tokens: judgeTokens, cost: 0.2, turns: 2 };
				return { ...ok(clean), tokens, cost: 0.1, turns: 1 };
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.equal(result.outcome, "converged-clean");
		const grok = result.passes[0]?.reviewers.find((seat) => seat.identity.seatId === "grok");
		const rejected = result.passes[0]?.reviewers.find((seat) => seat.identity.seatId === "codex");
		assert.deepEqual(grok?.tokens, tokens);
		assert.equal(grok?.attempts?.[0]?.completion, "returned");
		assert.deepEqual(grok?.attempts?.[0]?.completion === "returned" ? grok.attempts[0].tokens : undefined, tokens);
		assert.ok(rejected);
		assert.equal("tokens" in rejected, false);
		assert.equal(rejected.attempts?.[0]?.completion, "rejected");
		assert.equal(rejected.attempts?.[0] && "tokens" in rejected.attempts[0], false);
		assert.deepEqual(result.passes[0]?.judge.tokens, judgeTokens);
		assert.equal(result.passes[0]?.judge.attempts?.[0]?.completion, "returned");
		assert.deepEqual(result.passes[0]?.judge.attempts?.[0]?.completion === "returned" ? result.passes[0].judge.attempts[0].tokens : undefined, judgeTokens);
	});

	it("excludes the artifact author from configured review seats", async () => {
		const invoked: string[] = [];
		const clean = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "clean", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy: { ...basePolicy, reviewers: [{ id: "author-seat", provider: "codex" }, ...basePolicy.reviewers] },
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
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
			taxonomy: BASELINE_TAXONOMY,
			runSeat: async (req) => {
				if (req.role === "judge") return ok(judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r", class: "security-and-secrets" }]));
				if (req.slot.provider === "grok") return ok(empty);
				return { ok: false, subtype: "error_max_turns", text: reviewerFindings("safety"), fullText: reviewerFindings("safety"), assistantText: reviewerFindings("safety"), cost: 0, turns: 0 };
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
			taxonomy: BASELINE_TAXONOMY,
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
		const clean = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "looks good", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const exampleEcho = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "Concise single-line summary.", findings: [{ severity: "must-fix", message: "Concrete single-line finding.", path: "src/file.ts", line: 1 }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy,
			author: { provider: "grok" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
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
		assert.equal(codexRecord?.diagnostic, "authoring review findings parse failure");
		const attempt = codexRecord?.attempts?.[0];
		assert.equal(attempt?.completion === "returned" && attempt.output.state === "unreadable" && attempt.output.code, "schema-example-parroted");
		assert.deepEqual(result.diversity, { state: "softened", explanation: "reviewer seats did not complete: codex" });
	});

	it("escalates a safety-class must-fix on pass 1 with no author revision (escalate-early)", async () => {
		// A safety-class must-fix is retained every pass (#272) and can never self-clear, so revising +
		// re-reviewing is wasted work: raise to a human on first detection. Even a Judge `survives` +
		// `fixable-blocker` ruling cannot make it fixable — the safety class dominates. Assert the author
		// revise seat was never invoked and the loop ran exactly one pass.
		const policy = {
			...basePolicy,
			reviewers: [
				{ id: "reviewer-a", provider: "grok" as const },
				{ id: "reviewer-b", provider: "claude" as const },
			],
		};
		const roles: string[] = [];
		const safetyBlock = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "security regression", findings: [{ severity: "must-fix", message: "unsafe", ruleId: "pelaggio/security/secret-leak" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy,
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			runSeat: async (request) => {
				roles.push(request.role);
				if (request.role === "judge") return ok(judgeReport([{ candidateId: "C1", decision: "survives", rationale: "revise", class: "security-and-secrets", ruling: "fixable-blocker" }]));
				return ok(safetyBlock);
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.length, 1);
		assert.equal(
			roles.some((role) => role === "author"),
			false,
		);
		assert.equal(
			result.survivors.some((item) => item.finding.class === "security-and-secrets"),
			true,
		);
	});

	it("escalates an `unfixable-blocker` non-safety survivor on pass 1 with no author revision (escalate-early)", async () => {
		const roles: string[] = [];
		const result = await runReviewLoop({
			policy: { ...basePolicy },
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			runSeat: async (request) => {
				roles.push(request.role);
				if (request.role === "judge") return ok(judgeReport([{ candidateId: "C1", decision: "survives", rationale: "cannot be fixed here", class: "judgment", ruling: "unfixable-blocker" }]));
				return ok(reviewerFindings("judgment"));
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.length, 1);
		assert.equal(
			roles.some((role) => role === "author"),
			false,
		);
	});

	it("escalates a mixed fixable+safety survivor set immediately without revising (escalate-early)", async () => {
		// A pass carrying BOTH a fixable non-safety must-fix AND a safety-class must-fix can never converge:
		// the safety survivor is retained forever (#272). The guard must raise on ANY unclearable survivor,
		// not only when none is fixable — otherwise `.some(fixable)` burns all 5 passes on a hopeless set.
		const roles: string[] = [];
		// C1 fixable judgment (ruleId), C2 safety (harness-classified security-and-secrets via ruleId).
		const mixed = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({
			schemaVersion: 3,
			summary: "mixed",
			findings: [
				{ severity: "must-fix", message: "fixable", ruleId: "pelaggio/judgment/style" },
				{ severity: "must-fix", message: "unsafe", ruleId: "pelaggio/security/secret-leak" },
			],
		})}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy: { ...basePolicy },
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			runSeat: async (request) => {
				roles.push(request.role);
				if (request.role === "judge")
					return ok(
						judgeReport([
							{ candidateId: "C1", decision: "survives", rationale: "revise", ruling: "fixable-blocker" },
							{ candidateId: "C2", decision: "survives", rationale: "unsafe", ruling: "fixable-blocker" },
						]),
					);
				return ok(mixed);
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.length, 1);
		assert.equal(
			roles.some((role) => role === "author"),
			false,
		);
	});

	it("honors maxRevisions: 0 by escalating a fixable survivor with no author revision", async () => {
		// max-revisions:0 means review-but-never-auto-revise. A fixable must-fix must hard-block on pass 1;
		// the loop must consume policy.maxRevisions, not bound revisions only by maxPasses.
		const roles: string[] = [];
		const result = await runReviewLoop({
			policy: { ...basePolicy, maxRevisions: 0 },
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			runSeat: async (request) => {
				roles.push(request.role);
				if (request.role === "judge") return ok(judgeReport([{ candidateId: "C1", decision: "survives", rationale: "revise", ruling: "fixable-blocker" }]));
				return ok(reviewerFindings("judgment"));
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.length, 1);
		assert.equal(
			roles.some((role) => role === "author"),
			false,
		);
	});

	it("persists the failed pass + per-seat diagnostics when no reviewer seat completes, and renders them (#268 legibility)", async () => {
		// A 0-reviewer-seats-ok hard-block used to return passes:[] — dropping the per-seat diagnostics
		// just built — so the operator had no idea WHY the review failed. Now the pass is persisted and
		// each seat's reason survives in the review record.
		const result = await runReviewLoop({
			policy: { ...basePolicy },
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			runSeat: async (request) => {
				if (request.role === "reviewer") throw new Error("provider crashed: ECONNRESET");
				return ok("");
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.length, 1);
		assert.ok(result.passes[0].reviewers.length > 0);
		assert.ok(result.passes[0].reviewers.every((seat) => seat.diagnostic?.includes("ECONNRESET")));
		assert.equal(result.passes[0].judge.diagnostic, "skipped: no reviewer seat completed");
		const md = renderReviewRecord({ schemaVersion: 1, runId: "cycle-1-legibility", itemId: "L", createdAt: new Date("2026-01-01T00:00:00Z").toISOString(), blockingBar: "must-fix", result });
		assert.match(md, /Seat diagnostics/);
		assert.match(md, /ECONNRESET/);
	});

	it("iterates a fixable must-fix to convergence before the pass ceiling", async () => {
		// A non-safety must-fix the Judge rules `survives`/`fixable-blocker` for two passes (author revises
		// between them), then the fix lands: on pass 3 the reviewer stops raising it and the Judge refutes
		// the carried candidate, so it leaves `carried` and the pass converges clean — well before maxPasses
		// (5). The author revise seat ran exactly twice (once after each of the two unresolved passes).
		let reviewPass = 0;
		let authorCalls = 0;
		const block = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "fix me", findings: [{ severity: "must-fix", message: "boom", ruleId: "pelaggio/judgment/style" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const clean = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "clean", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy: { ...basePolicy },
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			runSeat: async (request) => {
				if (request.role === "author") {
					authorCalls++;
					return ok("");
				}
				if (request.role === "reviewer") {
					reviewPass++;
					// Reviewer blocks on passes 1 and 2, then passes on pass 3 (revision landed).
					return ok(reviewPass >= 3 ? clean : block);
				}
				// Judge: the carried must-fix survives while the reviewer still raises it (passes 1-2); once
				// the fix lands (pass 3) the reviewer drops it but it is re-seeded as carried, and the Judge
				// now refutes it — the only way a fixable candidate clears `carried`.
				const survives = reviewPass < 3;
				return ok(judgeReport([{ candidateId: "C1", decision: survives ? "survives" : "refuted", rationale: "r", class: "judgment", ...(survives ? { ruling: "fixable-blocker" as const } : {}) }]));
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.equal(result.outcome, "converged-clean");
		assert.equal(result.passes.length, 3);
		assert.equal(authorCalls, 2);
	});

	it("hard-blocks when a fixable must-fix survives all 5 passes", async () => {
		let authorCalls = 0;
		const block = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "fix me", findings: [{ severity: "must-fix", message: "boom", ruleId: "pelaggio/judgment/style" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const result = await runReviewLoop({
			policy: { ...basePolicy },
			author: { provider: "codex" },
			parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" },
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			runSeat: async (request) => {
				if (request.role === "author") {
					authorCalls++;
					return ok("");
				}
				if (request.role === "judge") return ok(judgeReport([{ candidateId: "C1", decision: "survives", rationale: "still broken", class: "judgment", ruling: "fixable-blocker" }]));
				return ok(block);
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.length, 5);
		// One revise seat between each of the first four passes; none after the terminal pass.
		assert.equal(authorCalls, 4);
		assert.equal(result.survivors.length, 1);
	});

	it("escalates a cross-model disagreement immediately regardless of the raised pass ceiling", async () => {
		let judgeCalls = 0;
		let authorCalls = 0;
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
			taxonomy: BASELINE_TAXONOMY,
			runSeat: async (request) => {
				if (request.role === "judge") judgeCalls++;
				if (request.role === "author") authorCalls++;
				return ok(request.slot.id === "reviewer-a" ? pass : block);
			},
			prompts: { review: () => "r", judge: () => "j", revise: () => "rev" },
		});
		assert.equal(result.outcome, "dissent");
		assert.equal(result.passes.length, 1);
		assert.equal(judgeCalls, 0);
		assert.equal(authorCalls, 0);
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
			taxonomy: BASELINE_TAXONOMY,
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

describe("authoring review loop — no-revise + safety floor (#384)", () => {
	const ok = (fullText: string): StepResult => ({ ok: true, subtype: "success", text: fullText, fullText, assistantText: fullText, cost: 0, turns: 0 });
	const findings = (raw: unknown[]) => `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "s", findings: raw })}\nEND_AUTHORING_REVIEW_FINDINGS`;
	const clean = findings([]);
	const judgeReport = (decisions: unknown[]) => `AUTHORING_REVIEW_JUDGE\n${JSON.stringify({ schemaVersion: 1, decisions })}\nEND_AUTHORING_REVIEW_JUDGE`;
	const parkSignal = () => ({ parked: false, resetsAt: 0, limitType: "", triggerWorker: "" });
	const noRevisePolicy: AuthoringReviewConfig = {
		enabled: "local",
		reviewers: [{ id: "grok", provider: "grok" }],
		judge: { id: "judge", provider: "claude" },
		blockingBar: "must-fix",
		maxPasses: 3,
		maxRevisions: 4,
		budgetCap: 1000,
		providerDiversity: "prefer",
	};

	it("never requests an author seat — a fixable survivor hard-blocks on pass 1 (revision branch unreachable)", async () => {
		const roles: string[] = [];
		const result = await runReviewLoop({
			policy: noRevisePolicy,
			parkSignal: parkSignal(),
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			mode: "no-revise",
			// `prompts` intentionally has no `revise` key — the no-revise branch type-checks without it.
			prompts: { review: () => "r", judge: () => "j" },
			runSeat: async (request) => {
				roles.push(request.role);
				if (request.role === "judge") return ok(judgeReport([{ candidateId: "C1", decision: "survives", rationale: "revise", ruling: "fixable-blocker" }]));
				return ok(findings([{ severity: "must-fix", message: "boom", ruleId: "pelaggio/judgment/style" }]));
			},
		});
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.passes.length, 1);
		assert.equal(roles.includes("author"), false);
		assert.equal(result.safetyFloor, "enabled");
	});

	it("safetyFloor disabled lets the Judge refute a default-safety must-fix (no #272 retention)", async () => {
		const result = await runReviewLoop({
			policy: noRevisePolicy,
			parkSignal: parkSignal(),
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			mode: "no-revise",
			safetyFloor: "disabled",
			safetyFloorNote: "document review: code-diff path-signal floor not applied",
			prompts: { review: () => "r", judge: () => "j" },
			// Unmatched evidence → correctness-regression via default-safety; under the enabled floor this
			// is retained forever, but with the floor disabled the Judge's refutation clears it.
			runSeat: async (request) => ok(request.role === "judge" ? judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "not a real blocker" }]) : findings([{ severity: "must-fix", message: "boom" }])),
		});
		assert.equal(result.outcome, "converged-clean");
		assert.equal(result.survivors.length, 0);
		assert.equal(result.safetyFloor, "disabled");
		assert.equal(result.safetyFloorNote, "document review: code-diff path-signal floor not applied");
		assert.equal(result.passes.at(-1)?.judge.valid, true);
	});

	it("safetyFloor disabled lets the Judge refute a security-class must-fix", async () => {
		const result = await runReviewLoop({
			policy: noRevisePolicy,
			parkSignal: parkSignal(),
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			mode: "no-revise",
			safetyFloor: "disabled",
			prompts: { review: () => "r", judge: () => "j" },
			runSeat: async (request) =>
				ok(
					request.role === "judge"
						? judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "not exploitable here", class: "security-and-secrets" }])
						: findings([{ severity: "must-fix", message: "boom", ruleId: "pelaggio/security/secret-leak" }]),
				),
		});
		assert.equal(result.outcome, "converged-clean");
		assert.equal(result.survivors.length, 0);
	});

	it("safetyFloor disabled: a Judge reclassifying a default-safety finding does not fail-close the pass (downgrade guard respects the floor)", async () => {
		const seats = (request: { role: string }) => ok(request.role === "judge" ? judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "just a doc nit", class: "judgment" }]) : findings([{ severity: "must-fix", message: "boom" }]));
		const disabled = await runReviewLoop({
			policy: noRevisePolicy,
			parkSignal: parkSignal(),
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			mode: "no-revise",
			safetyFloor: "disabled",
			prompts: { review: () => "r", judge: () => "j" },
			runSeat: async (request) => seats(request),
		});
		assert.equal(disabled.passes.at(-1)?.judge.valid, true);
		assert.equal(disabled.outcome, "converged-clean");
		// Control: with the floor ENABLED the same safety→judgment reclassification fails closed (a
		// harness safety class cannot be downgraded), so the Judge report is invalidated and the pass blocks.
		const enabled = await runReviewLoop({
			policy: noRevisePolicy,
			parkSignal: parkSignal(),
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			mode: "no-revise",
			prompts: { review: () => "r", judge: () => "j" },
			runSeat: async (request) => seats(request),
		});
		assert.equal(enabled.passes.at(-1)?.judge.valid, false);
		assert.equal(enabled.outcome, "hard-block");
	});

	it("classifyReviewOutcome honors the safety-floor param (dissent ruling on a safety survivor)", () => {
		const survivor = candidate("security-and-secrets");
		const rulings = new Map<string, JudgeRuling>([["C1", "judgment-dissent"]]);
		assert.equal(classifyReviewOutcome([survivor], [], rulings, 2, BASELINE_TAXONOMY, "enabled"), "hard-block");
		assert.equal(classifyReviewOutcome([survivor], [], rulings, 2, BASELINE_TAXONOMY, "disabled"), "dissent");
	});

	it("classifyReviewDisagreement drops hasSafetyBlocker when the floor is disabled", () => {
		const mkIdentity = (seatId: string, provider: DriverIdentity["provider"]): DriverIdentity => ({ role: "reviewer", seatId, provider, sessionId: `s-${seatId}` });
		const records: ReviewPassRecord["reviewers"] = [
			{ identity: mkIdentity("a", "grok"), ok: true, cost: 0, turns: 0, verdict: { verdict: "pass", rationale: "ok" } },
			{ identity: mkIdentity("b", "claude"), ok: true, cost: 0, turns: 0, verdict: { verdict: "block", rationale: "no" } },
		];
		const cands = [candidate("correctness-regression")];
		assert.equal(classifyReviewDisagreement(1, records, cands, BASELINE_TAXONOMY, "enabled")?.hasSafetyBlocker, true);
		assert.equal(classifyReviewDisagreement(1, records, cands, BASELINE_TAXONOMY, "disabled")?.hasSafetyBlocker, false);
	});

	it("records diversity from reviewers + judge with no author present", async () => {
		const met = await runReviewLoop({
			policy: {
				...noRevisePolicy,
				reviewers: [
					{ id: "grok", provider: "grok" },
					{ id: "codex", provider: "codex" },
					{ id: "claude", provider: "claude" },
				],
			},
			parkSignal: parkSignal(),
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			mode: "no-revise",
			prompts: { review: () => "r", judge: () => "j" },
			runSeat: async (request) => ok(request.role === "judge" ? judgeReport([]) : clean),
		});
		assert.deepEqual(met.diversity, { state: "met" });
		const softened = await runReviewLoop({
			policy: { ...noRevisePolicy, reviewers: [{ id: "grok", provider: "grok" }], judge: { id: "judge", provider: "grok" } },
			parkSignal: parkSignal(),
			classificationContext: emptyClassification,
			taxonomy: BASELINE_TAXONOMY,
			mode: "no-revise",
			prompts: { review: () => "r", judge: () => "j" },
			runSeat: async (request) => ok(request.role === "judge" ? judgeReport([]) : clean),
		});
		assert.equal(softened.diversity.state, "softened");
	});
});

describe("authoring review loop — seat output observations (#677)", () => {
	const ok = (fullText: string, extra: Partial<StepResult> = {}): StepResult => ({
		ok: true,
		subtype: "success",
		text: fullText,
		fullText,
		assistantText: fullText,
		cost: 0,
		turns: 0,
		...extra,
	});
	const findings = (raw: unknown[]) => `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "s", findings: raw })}\nEND_AUTHORING_REVIEW_FINDINGS`;
	const judgeReport = (decisions: unknown[]) => `AUTHORING_REVIEW_JUDGE\n${JSON.stringify({ schemaVersion: 1, decisions })}\nEND_AUTHORING_REVIEW_JUDGE`;
	const parkSignal = () => ({ parked: false, resetsAt: 0, limitType: "", triggerWorker: "" });
	const policy: AuthoringReviewConfig = {
		enabled: "local",
		reviewers: [{ id: "grok", provider: "grok" }],
		judge: { id: "judge", provider: "claude" },
		blockingBar: "must-fix",
		maxPasses: 1,
		maxRevisions: 0,
		budgetCap: 1000,
		providerDiversity: "prefer",
	};
	const loopOpts = (runSeat: Parameters<typeof runReviewLoop>[0]["runSeat"], extra: { policy?: AuthoringReviewConfig; onSeatAttempt?: NonNullable<Parameters<typeof runReviewLoop>[0]["onSeatAttempt"]> } = {}) => ({
		policy: extra.policy ?? policy,
		parkSignal: parkSignal(),
		classificationContext: emptyClassification,
		taxonomy: BASELINE_TAXONOMY,
		mode: "no-revise" as const,
		prompts: { review: () => "r", judge: () => "j" },
		runSeat,
		...(extra.onSeatAttempt ? { onSeatAttempt: extra.onSeatAttempt } : {}),
	});
	const firstPass = (result: ReviewLoopResult) => {
		const pass = result.passes[0];
		if (!pass) throw new Error("expected a recorded pass");
		return pass;
	};
	const firstReviewer = (result: ReviewLoopResult) => {
		const reviewer = firstPass(result).reviewers[0];
		if (!reviewer) throw new Error("expected a reviewer record");
		return reviewer;
	};
	const firstReturned = (record: { attempts?: SeatAttemptRecord[] }) => {
		const attempt = record.attempts?.[0];
		if (attempt?.completion !== "returned") throw new Error("expected a returned attempt");
		return attempt;
	};

	it("records readable/empty for a successful reviewer with findings:[] and does not soften diversity", async () => {
		const result = await runReviewLoop(
			loopOpts(async (request) => ok(request.role === "judge" ? judgeReport([]) : findings([])), {
				policy: {
					...policy,
					reviewers: [
						{ id: "grok", provider: "grok" },
						{ id: "claude", provider: "claude" },
						{ id: "codex", provider: "codex" },
					],
				},
			}),
		);
		const reviewer = firstReviewer(result);
		assert.equal(reviewer.ok, true);
		assert.deepEqual(reviewer.attempts, [{ completion: "returned", attempt: 1, ok: true, subtype: "success", cost: 0, turns: 0, output: { state: "readable", payload: "empty" } }]);
		assert.deepEqual(result.diversity, { state: "met" });
	});

	it("records readable/empty for a successful Judge with decisions:[] and zero candidates (completeness 0===0)", async () => {
		const result = await runReviewLoop(loopOpts(async (request) => ok(request.role === "judge" ? judgeReport([]) : findings([]))));
		const judge = firstPass(result).judge;
		assert.equal(judge.valid, true);
		assert.deepEqual(judge.attempts, [{ completion: "returned", attempt: 1, ok: true, subtype: "success", cost: 0, turns: 0, output: { state: "readable", payload: "empty" } }]);
		assert.equal(result.outcome, "converged-clean");
	});

	it("records readable/non-empty for valid non-empty reviewer and Judge blocks", async () => {
		const result = await runReviewLoop(
			loopOpts(async (request) =>
				ok(request.role === "judge" ? judgeReport([{ candidateId: "C1", decision: "survives", rationale: "keep", ruling: "fixable-blocker" }]) : findings([{ severity: "must-fix", message: "boom", ruleId: "pelaggio/judgment/style" }])),
			),
		);
		const reviewerOut = firstReturned(firstReviewer(result)).output;
		assert.equal(reviewerOut.state === "readable" && reviewerOut.payload, "non-empty");
		const judgeOut = firstReturned(firstPass(result).judge).output;
		assert.equal(judgeOut.state === "readable" && judgeOut.payload, "non-empty");
	});

	it("distinguishes empty text, prose without delimiters, and an unclosed start marker as unreadable/block-not-found", async () => {
		const cases: Array<{ text: string; chars: number; hasStartMarker: boolean; hasEndMarker: boolean }> = [
			{ text: "", chars: 0, hasStartMarker: false, hasEndMarker: false },
			{ text: "ordinary prose with no delimiters", chars: "ordinary prose with no delimiters".length, hasStartMarker: false, hasEndMarker: false },
			{ text: 'AUTHORING_REVIEW_FINDINGS\n{"schemaVersion":3}', chars: 'AUTHORING_REVIEW_FINDINGS\n{"schemaVersion":3}'.length, hasStartMarker: true, hasEndMarker: false },
		];
		for (const fixture of cases) {
			const result = await runReviewLoop(loopOpts(async (request) => ok(request.role === "reviewer" ? fixture.text : judgeReport([]))));
			const reviewer = firstReviewer(result);
			const attempt = firstReturned(reviewer);
			if (attempt.output.state !== "unreadable") throw new Error("expected unreadable");
			assert.equal(attempt.output.code, "block-not-found");
			assert.deepEqual(attempt.output.source, { chars: fixture.chars, hasStartMarker: fixture.hasStartMarker, hasEndMarker: fixture.hasEndMarker });
			assert.equal(reviewer.diagnostic, "authoring review findings parse failure");
		}
	});

	it("keeps a malformed block's fixed parse code out of rendered review provenance", async () => {
		const leaked = 'AUTHORING_REVIEW_FINDINGS\n{"schemaVersion":3,"summary":"s","findings":[],"sk-planted":"nope"}\nEND_AUTHORING_REVIEW_FINDINGS';
		const result = await runReviewLoop(loopOpts(async (request) => ok(request.role === "reviewer" ? leaked : judgeReport([]))));
		const reviewer = firstReviewer(result);
		const attempt = firstReturned(reviewer);
		assert.equal(attempt.output.state === "unreadable" && attempt.output.code, "unknown-key");
		assert.equal(reviewer.diagnostic, "authoring review findings parse failure");
		assert.doesNotMatch(reviewer.diagnostic ?? "", /sk-planted/);
		const rendered = renderReviewRecord({ schemaVersion: 1, runId: "cycle-parse-failure", itemId: "677", createdAt: new Date("2026-08-28T00:00:00Z").toISOString(), blockingBar: "must-fix", result });
		assert.doesNotMatch(rendered, /unknown-key|sk-planted/);
		assert.match(rendered, /authoring review findings parse failure/);
	});

	it("keeps a parsed-but-incomplete Judge readable with valid:false and the harness completeness diagnostic", async () => {
		const incomplete = await runReviewLoop(loopOpts(async (request) => ok(request.role === "judge" ? judgeReport([]) : findings([{ severity: "must-fix", message: "boom", ruleId: "pelaggio/judgment/style" }]))));
		const judge = firstPass(incomplete).judge;
		assert.equal(judge.valid, false);
		assert.match(judge.diagnostic ?? "", /incomplete/);
		assert.doesNotMatch(judge.diagnostic ?? "", /parse-error/);
		const output = firstReturned(judge).output;
		assert.equal(output.state, "readable");
		assert.equal(output.state === "readable" && output.payload, "empty");
	});

	it("skips the Judge on cross-model split with attempts:[] and does not invoke the callback", async () => {
		const observed: string[] = [];
		const pass = findings([]);
		const block = findings([{ severity: "must-fix", message: "boom", ruleId: "pelaggio/judgment/style" }]);
		const result = await runReviewLoop(
			loopOpts(
				async (request) => {
					if (request.role === "judge") throw new Error("judge must not run");
					return ok(request.slot.id === "a" ? pass : block);
				},
				{
					policy: {
						...policy,
						reviewers: [
							{ id: "a", provider: "grok" },
							{ id: "b", provider: "claude" },
						],
					},
					onSeatAttempt: (event) => observed.push(event.role),
				},
			),
		);
		const judge = firstPass(result).judge;
		assert.equal(judge.skipped, "cross-model-split");
		assert.deepEqual(judge.attempts, []);
		assert.equal(judge.diagnostic, "skipped: human adjudication required");
		assert.deepEqual(observed, ["reviewer", "reviewer"]);
	});

	it("skips the Judge when no reviewer completes, with attempts:[] and skipped: no-reviewer-completed", async () => {
		const observed: string[] = [];
		const result = await runReviewLoop(
			loopOpts(
				async () => {
					throw new Error("provider crashed: ECONNRESET");
				},
				{ onSeatAttempt: (event) => observed.push(event.role) },
			),
		);
		const pass = firstPass(result);
		assert.equal(pass.judge.skipped, "no-reviewer-completed");
		assert.deepEqual(pass.judge.attempts, []);
		assert.equal(pass.judge.diagnostic, "skipped: no reviewer seat completed");
		assert.deepEqual(observed, []);
		const reviewer = firstReviewer(result);
		assert.equal(reviewer.attempts?.[0]?.completion, "rejected");
		assert.equal(reviewer.diagnostic, "Error: provider crashed: ECONNRESET");
	});

	it("scrubs rejected reviewer provider errors before persisting them", async () => {
		const planted = "sk-proj-abcdefghijklmnop";
		const result = await runReviewLoop(
			loopOpts(async () => {
				throw new Error(`reviewer crashed with ${planted}`);
			}),
		);
		const diagnostic = firstReviewer(result).diagnostic ?? "";
		assert.doesNotMatch(diagnostic, new RegExp(planted));
		assert.match(diagnostic, /\[REDACTED\]/);
	});

	it("records Judge rejection as softened provenance without vetoing a clean reviewer verdict", async () => {
		const result = await runReviewLoop(
			loopOpts(async (request) => {
				if (request.role === "judge") throw new Error("judge crashed");
				return ok(findings([]));
			}),
		);
		assert.equal(result.outcome, "converged-clean");
		assert.equal(result.diversity.state, "softened");
		assert.match(result.diversity.state === "softened" ? result.diversity.explanation : "", /judge seat did not complete: judge/);
		assert.equal(result.passes.length, 1);
		const pass = firstPass(result);
		assert.equal(firstReviewer(result).ok, true);
		assert.equal(pass.judge.valid, false);
		assert.equal(pass.judge.attempts?.[0]?.completion, "rejected");
		assert.match(pass.judge.diagnostic ?? "", /judge crashed/);
	});

	it("retains reviewer must-fixes when the Judge runSeat throws", async () => {
		const result = await runReviewLoop(
			loopOpts(async (request) => {
				if (request.role === "judge") throw new Error("judge crashed");
				return ok(findings([{ severity: "must-fix", message: "boom", ruleId: "pelaggio/judgment/style" }]));
			}),
		);
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.survivors.length, 1);
		assert.equal(firstPass(result).carriedAfter.length, 1);
	});

	it("scrubs a rejected Judge provider error before persisting or rendering it", async () => {
		const planted = "sk-proj-abcdefghijklmnop";
		const result = await runReviewLoop(
			loopOpts(async (request) => {
				if (request.role === "judge") throw new Error(`judge crashed with ${planted}`);
				return ok(findings([]));
			}),
		);
		const diagnostic = firstPass(result).judge.diagnostic ?? "";
		assert.doesNotMatch(diagnostic, new RegExp(planted));
		assert.match(diagnostic, /\[REDACTED\]/);
		const rendered = renderReviewRecord({ schemaVersion: 1, runId: "cycle-judge-rejection", itemId: "677", createdAt: new Date("2026-08-28T00:00:00Z").toISOString(), blockingBar: "must-fix", result });
		assert.doesNotMatch(rendered, new RegExp(planted));
	});

	it("records subtype:error_max_turns plus unreadable output when a provider hits the cap with no block", async () => {
		const result = await runReviewLoop(
			loopOpts(async (request) => {
				if (request.role === "judge") return ok(judgeReport([]));
				return { ok: false, subtype: "error_max_turns", text: "", fullText: "", assistantText: "", cost: 0, turns: 12 };
			}),
		);
		const attempt = firstReturned(firstReviewer(result));
		assert.equal(attempt.subtype, "error_max_turns");
		assert.equal(attempt.output.state === "unreadable" && attempt.output.code, "block-not-found");
		assert.equal(attempt.output.state === "unreadable" && attempt.output.source.chars, 0);
	});

	it("ingests a parseable safety finding from a non-ok seat and still blocks", async () => {
		const safety = findings([{ severity: "must-fix", message: "unsafe", ruleId: "pelaggio/security/secret-leak" }]);
		const result = await runReviewLoop(
			loopOpts(
				async (request) => {
					if (request.role === "judge") return ok(judgeReport([{ candidateId: "C1", decision: "refuted", rationale: "r", class: "security-and-secrets" }]));
					if (request.slot.id === "grok") return ok(findings([]));
					return { ok: false, subtype: "error_max_turns", text: safety, fullText: safety, assistantText: safety, cost: 0, turns: 12 };
				},
				{
					policy: {
						...policy,
						reviewers: [
							{ id: "grok", provider: "grok" },
							{ id: "codex", provider: "codex" },
						],
					},
				},
			),
		);
		assert.notEqual(result.outcome, "converged-clean");
		assert.ok(result.survivors.some((s) => s.finding.class === "security-and-secrets"));
		const codex = firstPass(result).reviewers.find((r) => r.identity.seatId === "codex");
		if (!codex) throw new Error("expected codex reviewer");
		const attempt = firstReturned(codex);
		assert.equal(attempt.ok, false);
		assert.equal(attempt.output.state === "readable" && attempt.output.payload, "non-empty");
	});

	it("excludes an unreadable reviewer from verdicts and softens diversity", async () => {
		const result = await runReviewLoop(
			loopOpts(
				async (request) => {
					if (request.role === "judge") return ok(judgeReport([]));
					if (request.slot.id === "broken") return ok("no block here");
					return ok(findings([]));
				},
				{
					policy: {
						...policy,
						reviewers: [
							{ id: "grok", provider: "grok" },
							{ id: "broken", provider: "claude" },
						],
					},
				},
			),
		);
		const broken = firstPass(result).reviewers.find((r) => r.identity.seatId === "broken");
		if (!broken) throw new Error("expected broken reviewer");
		assert.equal(broken.ok, false);
		assert.equal(broken.verdict, undefined);
		assert.equal(result.diversity.state, "softened");
	});

	it("treats an unreadable Judge as invalid and carries every candidate unchanged", async () => {
		const result = await runReviewLoop(
			loopOpts(async (request) => {
				if (request.role === "judge") return ok("Judge prose with no delimiters");
				return ok(findings([{ severity: "must-fix", message: "boom", ruleId: "pelaggio/judgment/style" }]));
			}),
		);
		const judge = firstPass(result).judge;
		assert.equal(judge.valid, false);
		assert.equal(judge.diagnostic, "authoring review Judge parse failure");
		assert.equal(result.survivors.length, 1);
		assert.equal(result.outcome, "hard-block");
		assert.equal(result.diversity.state, "softened");
		assert.match(result.diversity.state === "softened" ? result.diversity.explanation : "", /judge seat did not complete: judge/);
	});

	it("records an unreadable Judge as provenance without vetoing a clean reviewer verdict", async () => {
		const result = await runReviewLoop(loopOpts(async (request) => ok(request.role === "judge" ? "Judge prose with no delimiters" : findings([]))));
		assert.equal(result.outcome, "converged-clean");
		assert.equal(firstPass(result).judge.valid, false);
		assert.equal(result.diversity.state, "softened");
		assert.match(result.diversity.state === "softened" ? result.diversity.explanation : "", /judge seat did not complete: judge/);
	});

	it("preserves a Judge rate-limit park instead of turning unavailability into a verdict", async () => {
		const options = loopOpts(async (request) => {
			if (request.role === "judge") {
				Object.assign(request.parkSignal, { parked: true, resetsAt: 123, limitType: "tokens", triggerWorker: "judge" });
				return ok("Judge prose with no delimiters");
			}
			return ok(findings([]));
		});
		const result = await runReviewLoop(options);
		assert.equal(result.outcome, "budget");
		assert.deepEqual(options.parkSignal, { parked: true, resetsAt: 123, limitType: "tokens", triggerWorker: "judge" });
	});

	it("preserves a reviewer-seat rate-limit park as budget, and a non-parked reviewer never trips the guard", async () => {
		const parked = loopOpts(async (request) => {
			if (request.role === "reviewer") Object.assign(request.parkSignal, { parked: true, resetsAt: 456, limitType: "tokens", triggerWorker: "reviewer" });
			return ok(request.role === "judge" ? judgeReport([]) : findings([]));
		});
		const parkedResult = await runReviewLoop(parked);
		assert.equal(parkedResult.outcome, "budget");
		assert.deepEqual(parked.parkSignal, { parked: true, resetsAt: 456, limitType: "tokens", triggerWorker: "reviewer" });

		const clean = loopOpts(async (request) => ok(request.role === "judge" ? judgeReport([]) : findings([])));
		const cleanResult = await runReviewLoop(clean);
		assert.equal(cleanResult.outcome, "converged-clean");
		assert.equal(clean.parkSignal.parked, false);
	});

	it("invokes the observation callback once per returned seat and never for retries in this slice", async () => {
		const events: Array<{ role: string; attempt: number }> = [];
		await runReviewLoop(loopOpts(async (request) => ok(request.role === "judge" ? judgeReport([]) : findings([])), { onSeatAttempt: (event) => events.push({ role: event.role, attempt: event.attempt }) }));
		assert.deepEqual(events, [
			{ role: "reviewer", attempt: 1 },
			{ role: "judge", attempt: 1 },
		]);
	});
});
