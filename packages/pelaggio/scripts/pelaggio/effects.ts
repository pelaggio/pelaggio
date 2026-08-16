import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REVIEW_CONFIG, type ReviewRunner, ROADMAP_GITHUB, ROADMAP_SOURCE } from "./config.js";
import { buildEffectsManifestReceipt, ExecutionReceiptError, type GitRevisionBinding, writeExecutionReceipt } from "./execution-receipt.js";
import { checkpoint, ensureCheckpointed, mainWorktree } from "./helpers.js";
import { enqueueReviewRequest, type NewReviewRequest } from "./review-request-queue.js";
import type { RoadmapSource } from "./roadmap/index.js";
import { SHIP_TARGET_NAMES } from "./ship/index.js";
import { type PrShipGateBinding, runShipPrEffects, type ShipPrEffectsResult } from "./ship/pr-effects.js";
import type { ExecutionReceiptDescriptor, ProviderName, ReviewOutcome, Step } from "./types.js";

export const EFFECTS_SCHEMA_VERSION = 1;

export interface ShipDecisionEffect {
	kind: "ship.ShipDecision";
	target: "pull-request" | "auto-merge-pr" | "direct-push";
	itemId: string;
	headBranch: string;
	prTitle: string;
	prBody: string;
}

/** Closed review-loop outcomes accepted on `review.Verdict`. */
export const REVIEW_OUTCOMES: readonly ReviewOutcome[] = ["converged-clean", "converged-with-notes", "ceiling", "dissent", "hard-block", "budget"];

export interface ReviewSeatIdentity {
	role: "author" | "reviewer" | "judge";
	seatId: string;
	provider: ProviderName;
	model?: string;
}

/**
 * Aggregate authoring-review verdict attestation (#337). Validate-and-log only —
 * durable review records stay on `writeReviewRecord`; this effect binds provenance
 * to the typed effects seam without double-writing.
 */
export interface ReviewVerdictEffect {
	kind: "review.Verdict";
	itemId: string;
	reviewedSha: string;
	reviewRecordSource: string;
	outcome: ReviewOutcome;
	seats: ReviewSeatIdentity[];
}

/**
 * Authoring-review disagreement escalation attestation. Validate-and-log only —
 * durable escalations stay on `appendReviewEscalation`.
 */
export interface ReviewEscalationEffect {
	kind: "review.Escalation";
	itemId: string;
	reviewedSha: string;
	reviewRecordSource: string;
	evidenceFingerprint: string;
	hasSafetyBlocker: boolean;
}

export type ImplementedEffect = { kind: "checkpoint"; label: string } | { kind: "plan.publish"; planPath?: string } | ShipDecisionEffect | ReviewVerdictEffect | ReviewEscalationEffect;

export type ReservedEffect = ({ kind: "pick.explainSelection" } & Record<string, unknown>) | ({ kind: "shakedown.deferredItems" } & Record<string, unknown>);

export type Effect = ImplementedEffect | ReservedEffect;

export interface EffectsManifest {
	schemaVersion: typeof EFFECTS_SCHEMA_VERSION;
	runId: string;
	itemId: string;
	step: Step;
	attempt: number;
	cwd: string;
	preSha: string | null;
	effects: Effect[];
}

export interface EffectsContext {
	runId: string;
	itemId: string;
	step: Step;
	attempt: number;
	cwd: string;
	preSha: string | null;
}

export type EffectsManifestErrorCode = "missing_manifest" | "invalid_manifest" | "provenance_mismatch" | "unknown_effect_kind" | "effect_failed" | "receipt_failed";

export interface EffectsDispatchContext extends EffectsContext {
	roadmap: RoadmapSource;
	log: (msg: string) => void;
	assistedByProviders?: ProviderName[];
	/** 32-byte challenge for this cycle; required for receipt production. */
	challenge: Uint8Array;
	provider: ProviderName;
	model: string;
	/**
	 * Post-dispatch Git observation. Default supplied by pipeline.
	 * `worktree` is the normalized identity (relative-to-main or basename).
	 */
	observeGit: () => { worktree: string | null; headSha: string | null; branch: string | null };
	/** ISO timestamp clock; tests inject a fixed clock. Defaults to `new Date().toISOString()`. */
	now?: () => string;
	/**
	 * Mid-run review-request enqueue seam (#387). Defaults read module-level config
	 * (`REVIEW_CONFIG.runner`, the github-issues `ghRepo`) and write through `mainWorktree()`;
	 * tests override to exercise both runners / a null-key skip without touching real `.dev/`.
	 */
	reviewEnqueue?: ReviewEnqueueDeps;
	/**
	 * Gated-OID binding for `ship.ShipDecision` (ADR-0025 applied to the PR-ship path).
	 * Harness-observed, in-process only — never read from disk. Required to dispatch a
	 * PR ship decision; the handler fails closed when absent.
	 */
	shipGate?: PrShipGateBinding;
}

export interface ReviewEnqueueDeps {
	runner?: ReviewRunner;
	/** Non-empty only for the github-issues roadmap source — the drain can run this repo. */
	ghRepo?: string;
	/** Resolve the tree holding `refs/heads/main` from the ship worktree cwd. */
	mainRepo?: (cwd: string) => string;
	enqueue?: (mainRepo: string, record: NewReviewRequest) => void;
}

export interface EffectsDispatchResult {
	appendText?: string;
	receipt?: ExecutionReceiptDescriptor;
}

export interface LoadedEffectsManifest {
	manifest: EffectsManifest;
	/** Exact UTF-8 source-file bytes used for `manifestDigest` (never re-serialized). */
	rawText: string;
}

export class EffectsManifestError extends Error {
	constructor(
		readonly code: EffectsManifestErrorCode,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "EffectsManifestError";
	}
}

type EffectHandler<K extends ImplementedEffect["kind"]> = (effect: Extract<ImplementedEffect, { kind: K }>, ctx: EffectsDispatchContext) => Promise<EffectsDispatchResult | undefined> | EffectsDispatchResult | undefined;

const EFFECT_HANDLERS: { [K in ImplementedEffect["kind"]]: EffectHandler<K> } = {
	checkpoint(effect, ctx) {
		const committed = checkpoint(ctx.cwd, effect.label);
		ctx.log(committed ? `${effect.label} committed` : `no changes to commit (${effect.label})`);
		ensureCheckpointed(ctx.cwd, effect.label, ctx.log);
	},
	async "plan.publish"(effect, ctx) {
		// #98 parity: publishing the plan (idempotent comment upsert) is best-effort. The plan file is
		// committed locally by the checkpoint effect and the implement prompt reads it from disk, so a
		// missing file (nothing to publish yet) or a transient roadmap/API failure must NOT fail the
		// cycle. Manifest validation (kind / provenance / preSha) stays fail-closed in loadAndValidate.
		const planPath = effect.planPath ?? ctx.roadmap.resolvePlanPath({ id: ctx.itemId, worktree: ctx.cwd });
		if (!existsSync(planPath)) {
			ctx.log(`plan not published (no file at ${planPath})`);
			return;
		}
		try {
			await ctx.roadmap.publishPlan(readFileSync(planPath, "utf-8"), { id: ctx.itemId, worktree: ctx.cwd });
			ctx.log("plan published");
		} catch (e) {
			ctx.log(`plan publish failed (non-fatal, committed locally): ${e instanceof Error ? e.message : String(e)}`);
		}
	},
	async "ship.ShipDecision"(effect, ctx) {
		if (effect.target === "direct-push") throw new EffectsManifestError("unknown_effect_kind", "ship.ShipDecision is not implemented for direct-push");
		if (effect.itemId !== ctx.itemId) throw new EffectsManifestError("provenance_mismatch", `ship decision itemId ${effect.itemId} does not match ${ctx.itemId}`);
		// ADR-0025: a dispatch without the harness-observed gated-OID binding is ungated
		// by definition — refuse rather than ship whatever HEAD currently is.
		if (!ctx.shipGate) throw new EffectsManifestError("provenance_mismatch", "ship.ShipDecision dispatched without a gated-OID binding (shipGate) — refusing to ship ungated");
		const result = await runShipPrEffects({ cwd: ctx.cwd, itemId: ctx.itemId, decision: effect, gate: ctx.shipGate }, { log: ctx.log, assistedByProviders: ctx.assistedByProviders });
		// #387: after a successful PR ship, enqueue a durable review-request into the main tree so
		// the trusted reconciler posts the `review` status mid-run. Never fails the ship (below).
		maybeEnqueueReviewRequest(effect, ctx, result);
		return { appendText: result.prUrl };
	},
	// Validate-and-log attestation only: durable review records / escalations stay on the
	// existing pipeline path (writeReviewRecord / appendReviewEscalation). Handlers re-check
	// provenance so a stale or mismatched payload cannot be attributed to the wrong revision.
	"review.Verdict"(effect, ctx) {
		if (effect.itemId !== ctx.itemId) throw new EffectsManifestError("provenance_mismatch", `review.Verdict itemId ${effect.itemId} does not match ${ctx.itemId}`);
		if (ctx.preSha !== null && effect.reviewedSha !== ctx.preSha) {
			throw new EffectsManifestError("provenance_mismatch", `review.Verdict reviewedSha ${effect.reviewedSha} does not match preSha ${ctx.preSha}`);
		}
		ctx.log(`review.Verdict ${effect.outcome} @ ${effect.reviewedSha.slice(0, 7)} (${effect.reviewRecordSource})`);
	},
	"review.Escalation"(effect, ctx) {
		if (effect.itemId !== ctx.itemId) throw new EffectsManifestError("provenance_mismatch", `review.Escalation itemId ${effect.itemId} does not match ${ctx.itemId}`);
		if (ctx.preSha !== null && effect.reviewedSha !== ctx.preSha) {
			throw new EffectsManifestError("provenance_mismatch", `review.Escalation reviewedSha ${effect.reviewedSha} does not match preSha ${ctx.preSha}`);
		}
		ctx.log(`review.Escalation fingerprint=${effect.evidenceFingerprint.slice(0, 12)}… safety=${effect.hasSafetyBlocker} @ ${effect.reviewedSha.slice(0, 7)}`);
	},
};

/**
 * Conditional ship-tail enqueue of a mid-run review-request (#387). Writes at most one main-tree
 * record and only when ALL hold: local review runner, a PR-mode ship, a repo the drain can run
 * (github-issues `ghRepo`), and BOTH key fields present. Any miss logs and skips — cold-start
 * `findReviewCandidates` re-derives `prNumber`/`headSha` from the forge and recovers the PR next
 * drain. Enqueue failures (fs errors or null keys) are non-fatal to the ship: the PR is already on
 * the forge, so throwing here would misreport a landed ship as a failed cycle.
 */
function maybeEnqueueReviewRequest(effect: ShipDecisionEffect, ctx: EffectsDispatchContext, result: ShipPrEffectsResult): void {
	const deps = ctx.reviewEnqueue ?? {};
	const runner = deps.runner ?? REVIEW_CONFIG.runner;
	const ghRepo = deps.ghRepo ?? (ROADMAP_SOURCE === "github-issues" ? ROADMAP_GITHUB.ghRepo : "");
	if (runner !== "local") return; // ci runner: CI posts the `review` status, never the harness
	if (effect.target !== "pull-request" && effect.target !== "auto-merge-pr") return;
	if (!ghRepo) return; // non-github-issues source: the drain cannot run this repo
	if (result.prNumber === null || result.headSha === null) {
		ctx.log(`review-request enqueue skipped (prNumber=${String(result.prNumber)} headSha=${String(result.headSha)}); cold-start drain will recover`);
		return;
	}
	const enqueue = deps.enqueue ?? enqueueReviewRequest;
	const resolveMain = deps.mainRepo ?? mainWorktree;
	const now = ctx.now ?? (() => new Date().toISOString());
	try {
		enqueue(resolveMain(ctx.cwd), { prNumber: result.prNumber, headSha: result.headSha, itemId: ctx.itemId, headBranch: effect.headBranch, enqueuedAt: now() });
		ctx.log(`review-request enqueued for PR #${result.prNumber} @ ${result.headSha.slice(0, 7)}`);
	} catch (e) {
		ctx.log(`review-request enqueue failed (non-fatal, cold-start drain recovers): ${e instanceof Error ? e.message : String(e)}`);
	}
}

export function effectManifestPath(ctx: EffectsContext): string {
	return join(ctx.cwd, ".dev", "effects", ctx.runId, `${ctx.step}-${ctx.attempt}.json`);
}

export function writeEffectsManifest(ctx: EffectsContext, effects: readonly Effect[]): void {
	const path = effectManifestPath(ctx);
	mkdirSync(dirname(path), { recursive: true });
	const manifest: EffectsManifest = {
		schemaVersion: EFFECTS_SCHEMA_VERSION,
		runId: ctx.runId,
		itemId: ctx.itemId,
		step: ctx.step,
		attempt: ctx.attempt,
		cwd: ctx.cwd,
		preSha: ctx.preSha,
		effects: [...effects],
	};
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function loadAndValidateEffectsManifest(ctx: EffectsContext): LoadedEffectsManifest {
	const path = effectManifestPath(ctx);
	if (!existsSync(path)) throw new EffectsManifestError("missing_manifest", `effects manifest not found: ${path}`);

	let rawText: string;
	try {
		rawText = readFileSync(path, "utf-8");
	} catch (e) {
		throw new EffectsManifestError("invalid_manifest", `effects manifest is not readable: ${path}`, { cause: e });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch (e) {
		throw new EffectsManifestError("invalid_manifest", `effects manifest is not valid JSON: ${path}`, { cause: e });
	}

	if (!isRecord(parsed)) throw new EffectsManifestError("invalid_manifest", "effects manifest must be an object");
	if (parsed.schemaVersion !== EFFECTS_SCHEMA_VERSION) throw new EffectsManifestError("invalid_manifest", "unsupported effects manifest schemaVersion");
	if (parsed.runId !== ctx.runId) throw new EffectsManifestError("provenance_mismatch", `manifest runId ${String(parsed.runId)} does not match ${ctx.runId}`);
	if (parsed.itemId !== ctx.itemId) throw new EffectsManifestError("provenance_mismatch", `manifest itemId ${String(parsed.itemId)} does not match ${ctx.itemId}`);
	if (parsed.step !== ctx.step) throw new EffectsManifestError("provenance_mismatch", `manifest step ${String(parsed.step)} does not match ${ctx.step}`);
	if (parsed.attempt !== ctx.attempt) throw new EffectsManifestError("provenance_mismatch", `manifest attempt ${String(parsed.attempt)} does not match ${ctx.attempt}`);
	if (typeof parsed.cwd !== "string" || resolve(parsed.cwd) !== resolve(ctx.cwd)) throw new EffectsManifestError("provenance_mismatch", `manifest cwd does not match ${ctx.cwd}`);
	if (parsed.preSha !== ctx.preSha) throw new EffectsManifestError("provenance_mismatch", "manifest preSha does not match current step provenance");
	if (!Array.isArray(parsed.effects) || parsed.effects.length === 0) throw new EffectsManifestError("invalid_manifest", "effects manifest must contain at least one effect");

	const effects = parsed.effects.map(validateEffect);
	// Provenance fields were checked equal to ctx above; use ctx's typed values so the
	// return is well-typed without re-validating JSON-parsed unknowns.
	return {
		manifest: {
			schemaVersion: EFFECTS_SCHEMA_VERSION,
			runId: ctx.runId,
			itemId: ctx.itemId,
			step: ctx.step,
			attempt: ctx.attempt,
			cwd: ctx.cwd,
			preSha: ctx.preSha,
			effects,
		},
		rawText,
	};
}

export async function dispatchStepEffects(ctx: EffectsDispatchContext): Promise<EffectsDispatchResult> {
	const path = effectManifestPath(ctx);
	const { manifest, rawText } = loadAndValidateEffectsManifest(ctx);
	const appendText: string[] = [];
	try {
		for (const effect of manifest.effects) {
			// Per-arm handler calls keep the discriminated effect type; a computed
			// EFFECT_HANDLERS[kind](effect) collapses the parameter to `never`.
			let result: EffectsDispatchResult | undefined;
			switch (effect.kind) {
				case "checkpoint":
					result = await EFFECT_HANDLERS.checkpoint(effect, ctx);
					break;
				case "plan.publish":
					result = await EFFECT_HANDLERS["plan.publish"](effect, ctx);
					break;
				case "ship.ShipDecision":
					result = await EFFECT_HANDLERS["ship.ShipDecision"](effect, ctx);
					break;
				case "review.Verdict":
					result = await EFFECT_HANDLERS["review.Verdict"](effect, ctx);
					break;
				case "review.Escalation":
					result = await EFFECT_HANDLERS["review.Escalation"](effect, ctx);
					break;
				default:
					throw new EffectsManifestError("unknown_effect_kind", `effect kind is not implemented: ${effect.kind}`);
			}
			if (result?.appendText) appendText.push(result.appendText);
		}
	} catch (e) {
		if (e instanceof EffectsManifestError) throw e;
		throw new EffectsManifestError("effect_failed", e instanceof Error ? e.message : String(e), { cause: e });
	}

	// Receipt-before-delete: bind exact pre-delete manifest bytes + post-dispatch
	// Git observation. Fail closed and retain the manifest if receipt write fails.
	const joinedAppend = appendText.length > 0 ? appendText.join("\n") : undefined;
	const receipt = issueEffectsManifestReceipt(ctx, {
		rawText,
		effectKinds: manifest.effects.map((e) => e.kind),
		appendText: joinedAppend,
	});
	rmSync(path);
	return {
		...(joinedAppend !== undefined ? { appendText: joinedAppend } : {}),
		receipt,
	};
}

/**
 * Build + atomically write the execution receipt after handlers succeed.
 * Maps ExecutionReceiptError → EffectsManifestError (receipt_failed or
 * provenance_mismatch) so the pipeline's existing dispatch-error path fires.
 */
function issueEffectsManifestReceipt(ctx: EffectsDispatchContext, input: { rawText: string; effectKinds: Effect["kind"][]; appendText?: string }): ExecutionReceiptDescriptor {
	if (!(ctx.challenge instanceof Uint8Array) || ctx.challenge.byteLength !== 32) {
		throw new EffectsManifestError("receipt_failed", "dispatch context requires a 32-byte challenge for receipt production");
	}
	if (typeof ctx.provider !== "string" || ctx.provider.trim() === "") {
		throw new EffectsManifestError("receipt_failed", "dispatch context requires a provider for receipt production");
	}
	if (typeof ctx.model !== "string" || ctx.model.trim() === "") {
		throw new EffectsManifestError("receipt_failed", "dispatch context requires a model for receipt production");
	}
	if (typeof ctx.observeGit !== "function") {
		throw new EffectsManifestError("receipt_failed", "dispatch context requires observeGit for receipt production");
	}

	const now = ctx.now ?? (() => new Date().toISOString());
	const issuedAt = now();
	let postObservation: { worktree: string | null; headSha: string | null; branch: string | null };
	try {
		postObservation = ctx.observeGit();
	} catch (e) {
		throw new EffectsManifestError("receipt_failed", `observeGit failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
	}
	const completedAt = now();

	const preGit: GitRevisionBinding = { headSha: ctx.preSha, branch: postObservation.branch };
	const postGit: GitRevisionBinding = { headSha: postObservation.headSha, branch: postObservation.branch };

	try {
		const receipt = buildEffectsManifestReceipt({
			challenge: ctx.challenge,
			itemId: ctx.itemId,
			runId: ctx.runId,
			step: ctx.step,
			attempt: ctx.attempt,
			worktree: postObservation.worktree,
			preGit,
			postGit,
			provider: ctx.provider,
			model: ctx.model,
			manifestRawText: input.rawText,
			effectKinds: input.effectKinds,
			appendText: input.appendText,
			issuedAt,
			completedAt,
		});
		return writeExecutionReceipt(ctx.cwd, receipt);
	} catch (e) {
		if (e instanceof ExecutionReceiptError) {
			if (e.code === "provenance_mismatch" || e.code === "challenge_mismatch") {
				throw new EffectsManifestError("provenance_mismatch", e.message, { cause: e });
			}
			throw new EffectsManifestError("receipt_failed", e.message, { cause: e });
		}
		throw new EffectsManifestError("receipt_failed", e instanceof Error ? e.message : String(e), { cause: e });
	}
}

const PROVIDER_NAMES: readonly ProviderName[] = ["claude", "codex", "grok", "opencode"];
const SEAT_ROLES = ["author", "reviewer", "judge"] as const;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/i;

function validateEffect(effect: unknown): Effect {
	if (!isRecord(effect) || typeof effect.kind !== "string") throw new EffectsManifestError("invalid_manifest", "effect must be an object with a kind");
	switch (effect.kind) {
		case "checkpoint":
			if (typeof effect.label !== "string" || effect.label.trim() === "") throw new EffectsManifestError("invalid_manifest", "checkpoint effect requires a non-empty label");
			return { kind: "checkpoint", label: effect.label };
		case "plan.publish":
			if (effect.planPath !== undefined && typeof effect.planPath !== "string") throw new EffectsManifestError("invalid_manifest", "plan.publish planPath must be a string when present");
			return effect.planPath === undefined ? { kind: "plan.publish" } : { kind: "plan.publish", planPath: effect.planPath };
		case "ship.ShipDecision":
			return validateShipDecisionEffect(effect);
		case "review.Verdict":
			return validateReviewVerdictEffect(effect);
		case "review.Escalation":
			return validateReviewEscalationEffect(effect);
		case "pick.explainSelection":
		case "shakedown.deferredItems":
			return { ...effect, kind: effect.kind };
		default:
			throw new EffectsManifestError("unknown_effect_kind", `unknown effect kind: ${effect.kind}`);
	}
}

function validateReviewSeat(seat: unknown, label: string): ReviewSeatIdentity {
	if (!isRecord(seat)) throw new EffectsManifestError("invalid_manifest", `${label} must be an object`);
	if (!(SEAT_ROLES as readonly string[]).includes(seat.role as string)) throw new EffectsManifestError("invalid_manifest", `${label}.role must be author|reviewer|judge`);
	if (!isNonEmptyString(seat.seatId)) throw new EffectsManifestError("invalid_manifest", `${label}.seatId must be a non-empty string`);
	if (!(PROVIDER_NAMES as readonly string[]).includes(seat.provider as string)) throw new EffectsManifestError("invalid_manifest", `${label}.provider must be a known provider`);
	if (seat.model !== undefined && typeof seat.model !== "string") throw new EffectsManifestError("invalid_manifest", `${label}.model must be a string when present`);
	return {
		role: seat.role as ReviewSeatIdentity["role"],
		seatId: seat.seatId,
		provider: seat.provider as ProviderName,
		...(typeof seat.model === "string" ? { model: seat.model } : {}),
	};
}

function validateReviewVerdictEffect(effect: Record<string, unknown>): ReviewVerdictEffect {
	if (!isNonEmptyString(effect.itemId)) throw new EffectsManifestError("invalid_manifest", "review.Verdict itemId must be a non-empty string");
	if (!isNonEmptyString(effect.reviewedSha) || !SHA_RE.test(effect.reviewedSha)) throw new EffectsManifestError("invalid_manifest", "review.Verdict reviewedSha must be a git SHA");
	if (!isNonEmptyString(effect.reviewRecordSource)) throw new EffectsManifestError("invalid_manifest", "review.Verdict reviewRecordSource must be a non-empty string");
	if (!(REVIEW_OUTCOMES as readonly string[]).includes(effect.outcome as string)) throw new EffectsManifestError("invalid_manifest", "review.Verdict outcome must be a known ReviewOutcome");
	if (!Array.isArray(effect.seats) || effect.seats.length === 0) throw new EffectsManifestError("invalid_manifest", "review.Verdict seats must be a non-empty array");
	const seats = effect.seats.map((seat, i) => validateReviewSeat(seat, `review.Verdict seats[${i}]`));
	return {
		kind: "review.Verdict",
		itemId: effect.itemId,
		reviewedSha: effect.reviewedSha,
		reviewRecordSource: effect.reviewRecordSource,
		outcome: effect.outcome as ReviewOutcome,
		seats,
	};
}

function validateReviewEscalationEffect(effect: Record<string, unknown>): ReviewEscalationEffect {
	if (!isNonEmptyString(effect.itemId)) throw new EffectsManifestError("invalid_manifest", "review.Escalation itemId must be a non-empty string");
	if (!isNonEmptyString(effect.reviewedSha) || !SHA_RE.test(effect.reviewedSha)) throw new EffectsManifestError("invalid_manifest", "review.Escalation reviewedSha must be a git SHA");
	if (!isNonEmptyString(effect.reviewRecordSource)) throw new EffectsManifestError("invalid_manifest", "review.Escalation reviewRecordSource must be a non-empty string");
	if (!isNonEmptyString(effect.evidenceFingerprint) || !FINGERPRINT_RE.test(effect.evidenceFingerprint)) {
		throw new EffectsManifestError("invalid_manifest", "review.Escalation evidenceFingerprint must be a 64-char hex digest");
	}
	if (typeof effect.hasSafetyBlocker !== "boolean") throw new EffectsManifestError("invalid_manifest", "review.Escalation hasSafetyBlocker must be a boolean");
	return {
		kind: "review.Escalation",
		itemId: effect.itemId,
		reviewedSha: effect.reviewedSha,
		reviewRecordSource: effect.reviewRecordSource,
		evidenceFingerprint: effect.evidenceFingerprint,
		hasSafetyBlocker: effect.hasSafetyBlocker,
	};
}

function validateShipDecisionEffect(effect: Record<string, unknown>): ShipDecisionEffect {
	if (!SHIP_TARGET_NAMES.includes(effect.target as ShipDecisionEffect["target"])) throw new EffectsManifestError("invalid_manifest", "ship.ShipDecision target must be a valid ship target");
	if (!isNonEmptyString(effect.itemId)) throw new EffectsManifestError("invalid_manifest", "ship.ShipDecision itemId must be a non-empty string");
	if (!isNonEmptyString(effect.headBranch)) throw new EffectsManifestError("invalid_manifest", "ship.ShipDecision headBranch must be a non-empty string");
	if (!isNonEmptyString(effect.prTitle)) throw new EffectsManifestError("invalid_manifest", "ship.ShipDecision prTitle must be a non-empty string");
	if (!isNonEmptyString(effect.prBody)) throw new EffectsManifestError("invalid_manifest", "ship.ShipDecision prBody must be a non-empty string");
	return {
		kind: "ship.ShipDecision",
		target: effect.target as ShipDecisionEffect["target"],
		itemId: effect.itemId,
		headBranch: effect.headBranch,
		prTitle: effect.prTitle,
		prBody: effect.prBody,
	};
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
