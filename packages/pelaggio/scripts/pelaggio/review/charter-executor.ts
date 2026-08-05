import { type AuthoringReviewConfig, CONFIG, type ResolvedConfig, type ReviewSlot, resolveStepSettings, type StepSettings } from "../config.js";
import { expandPackagedSkill } from "../helpers.js";
import type { Scope } from "../roadmap/types.js";
import { type RunStepFn, runStep } from "../step-runner.js";
import type { ParkSignal, StepEmit } from "../types.js";
import type { CharterReviewConfig } from "./charter-policy.js";
import { type CharterAndon, type CharterReviewEvidence, type CharterReviewOrigin, type CharterReviewRecord, type CharterReviewVerdict, charterReviewInputs, writeCharterReviewRecord } from "./charter-record.js";
import type { ReviewLoopResult } from "./loop.js";
import { runReviewLoop } from "./loop.js";

/** The code-diff safety floor is the wrong floor for a bare charter spec — recorded honestly (mirrors doc-review). */
export const CHARTER_REVIEW_SAFETY_FLOOR_NOTE = "charter review: code-diff path-signal floor not applied";

/** Loop outcomes that clear the gate → `ship` (no deferral recommended). Everything else defers/errors. */
const SHIP_OUTCOMES = new Set<ReviewLoopResult["outcome"]>(["converged-clean", "converged-with-notes", "ceiling"]);

/** Minimal stderr progress emitter (no pipeline TUI here) — mirrors doc-review-cli. */
const emit: StepEmit = (event) => {
	switch (event.type) {
		case "step_header":
			process.stderr.write(`▶ charter-review — model=${event.model} budget=$${event.budget}\n`);
			break;
		case "rate_limit":
			process.stderr.write(`  ⏸ rate limit (${event.limitType})\n`);
			break;
		case "sdk_error":
			process.stderr.write(`  ✗ SDK error: ${event.message}\n`);
			break;
	}
};

function fillReviewSlot(slot: ReviewSlot, defaults: StepSettings): ReviewSlot {
	if (slot.provider === "codex") {
		const codexModel = slot.codexModel ?? defaults.codexModel;
		return codexModel ? { ...slot, codexModel } : { ...slot };
	}
	const model = slot.model ?? defaults.model;
	return model ? { ...slot, model } : { ...slot };
}

/** Build the `runReviewLoop` policy from charter seats: reviewer models from pr-review, judge from pr-verify. */
export function resolveCharterExecutionPolicy(config: ResolvedConfig, profile: string, charter: CharterReviewConfig): AuthoringReviewConfig {
	const reviewerDefaults = resolveStepSettings(config, profile, "pr-review");
	const judgeDefaults = resolveStepSettings(config, profile, "pr-verify");
	return {
		enabled: true,
		reviewers: charter.reviewers.map((slot) => fillReviewSlot(slot, reviewerDefaults)),
		judge: fillReviewSlot(charter.judge, judgeDefaults),
		blockingBar: "must-fix",
		maxPasses: charter.maxPasses,
		maxRevisions: 0,
		budgetCap: config.review.budgetCap,
		providerDiversity: "prefer",
	};
}

function executionOverrideFor(slot: ReviewSlot) {
	return { provider: slot.provider, ...(slot.provider === "codex" ? (slot.codexModel ? { codexModel: slot.codexModel } : {}) : slot.model ? { model: slot.model } : {}) };
}

function emptyParkSignal(): ParkSignal {
	return { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };
}

/** Data-delimited charter prompt. Title/scope/body are injected as trusted data, never as instructions. */
function formatCharterUnderReview(title: string, body: string, scope: Scope | undefined): string {
	return ["TRUSTED_CHARTER_DATA", `Title: ${title}`, `Scope: ${scope ?? "unspecified"}`, "", "Charter body:", body.trim() === "" ? "(no body provided)" : body, "END_TRUSTED_CHARTER_DATA"].join("\n");
}

function lastPassEvidence(loop: ReviewLoopResult): CharterReviewEvidence["seats"] {
	const pass = loop.passes[loop.passes.length - 1];
	if (!pass) return [];
	return [
		...pass.reviewers.map((r) => ({
			role: "reviewer" as const,
			seatId: r.identity.seatId,
			provider: r.identity.provider,
			ok: r.ok,
			...(r.verdict ? { verdict: r.verdict.verdict } : {}),
			...(r.diagnostic ? { diagnostic: r.diagnostic } : {}),
		})),
		{ role: "judge" as const, seatId: pass.judge.identity.seatId, provider: pass.judge.identity.provider, ok: pass.judge.valid, ...(pass.judge.diagnostic ? { diagnostic: pass.judge.diagnostic } : {}) },
	];
}

export interface CharterExecutorOptions {
	title: string;
	/** Exact charter body bytes bound into the record (empty string for legacy/body-less callers). */
	body: string;
	scope?: Scope;
	origin: CharterReviewOrigin;
	policy: CharterReviewConfig;
	config?: ResolvedConfig;
	profile?: string;
	cwd?: string;
	runStep?: RunStepFn;
	/** Injected clock for deterministic ids/timestamps in tests. */
	clock?: () => number;
}

export interface CharterExecutorResult {
	verdict: CharterReviewVerdict;
	record: CharterReviewRecord;
	digest: string;
	recordPath: string;
}

/**
 * Run the configured charter panel over a snapshotted title/body/policy and write a digest-bound record.
 * Never creates a worktree/claim branch/roadmap item and never revises. A degenerate run (no completed
 * reviewer seat) or a rate-limit park can never map to `ship`; a non-ship loop outcome recommends
 * deferral. The returned record is evidence, never a caller-supplied credential. (#367)
 */
export async function executeCharterReview(options: CharterExecutorOptions): Promise<CharterExecutorResult> {
	const title = options.title;
	if (title.trim() === "") throw new Error("charter review requires a non-empty title");
	const body = options.body;
	const config = options.config ?? CONFIG;
	const profile = options.profile ?? "standard";
	const cwd = options.cwd ?? process.cwd();
	const runStepImpl = options.runStep ?? runStep;
	const ms = (options.clock ?? (() => Date.now()))();
	const policy = options.policy;
	const execPolicy = resolveCharterExecutionPolicy(config, profile, policy);
	const parkSignal = emptyParkSignal();
	const charterBlock = formatCharterUnderReview(title, body, options.scope);

	const loop = await runReviewLoop({
		policy: execPolicy,
		mode: "no-revise",
		parkSignal,
		classificationContext: { changedFiles: [] },
		taxonomy: config.review.taxonomy,
		safetyFloor: "disabled",
		safetyFloorNote: CHARTER_REVIEW_SAFETY_FLOOR_NOTE,
		runSeat: async ({ role, slot, prompt, parkSignal: child }) => runStepImpl(role === "judge" ? "pr-verify" : "pr-review", prompt, { cwd, profile, trace: false, parkSignal: child, executionOverride: executionOverrideFor(slot) }, emit),
		prompts: {
			review: () => `${expandPackagedSkill("pr-review", "--document")}\n\n${charterBlock}`,
			judge: (candidates) => `${expandPackagedSkill("pr-verify", "--authoring-loop-judge")}\n\nTRUSTED_CANDIDATE_DATA\n${JSON.stringify(candidates)}\nEND_TRUSTED_CANDIDATE_DATA`,
		},
	});

	// A run where no reviewer seat completed has no trustworthy evidence — never ship (guards the
	// PR #363 empty/degenerate-artifact class). A rate-limit park is an execution error, not a defer.
	const anyReviewerOk = loop.passes.some((pass) => pass.reviewers.some((seat) => seat.ok));
	let verdict: CharterReviewVerdict;
	if (!anyReviewerOk) verdict = "degenerate";
	else if (parkSignal.parked || loop.outcome === "budget") verdict = "execution-error";
	else if (SHIP_OUTCOMES.has(loop.outcome)) verdict = "ship";
	else verdict = "defer";

	const evidence: CharterReviewEvidence = {
		outcome: loop.outcome,
		diversity: loop.diversity.state,
		passes: loop.passes.length,
		survivors: loop.survivors.length,
		notes: loop.notes.length,
		cost: loop.cost,
		seats: lastPassEvidence(loop),
	};

	const inputs = charterReviewInputs(title, body, policy);
	const andon: CharterAndon | undefined =
		verdict === "ship"
			? undefined
			: {
					id: `andon-${inputs.titleSha256.slice(0, 12)}-${ms.toString(36)}`,
					status: "active",
					kind: verdict === "execution-error" ? "execution-error" : verdict === "degenerate" ? "degenerate" : "non-ship",
					reason:
						verdict === "execution-error"
							? `charter review could not complete (outcome ${loop.outcome})`
							: verdict === "degenerate"
								? "no reviewer seat produced auditable evidence"
								: `charter review recommends deferral (outcome ${loop.outcome})`,
				};

	const record: CharterReviewRecord = {
		schemaVersion: 1,
		recordId: `charter-${inputs.titleSha256.slice(0, 12)}-${ms.toString(36)}`,
		createdAt: new Date(ms).toISOString(),
		...(options.scope ? { scope: options.scope } : {}),
		origin: options.origin,
		verdict,
		inputs,
		policy,
		evidence,
		...(andon ? { andon } : {}),
	};

	const { path, digest } = writeCharterReviewRecord(config.repo, record);
	return { verdict, record, digest, recordPath: path };
}
