import type { Step } from "./config.js";

export type { Step };

// ── Step results ───────────────────────────────────────────────────────

export interface TokenUsage {
	input: number;
	output: number;
	cacheCreation: number;
	cacheRead: number;
}

export interface Decision {
	fork: string;
	chosen?: string;
	alternatives?: string;
}

/** Lifecycle identity assigned at emission; semantic payload remains `Decision`. */
export interface EmittedDecision {
	/** Opaque UUID assigned once when the decision is emitted. */
	id: string;
	/** SHA-256 hex of normalized fork/chosen/alternatives (dedupe content axis). */
	contentFingerprint: string;
	decision: Decision;
}

export interface ReviewEscalationDriver {
	identity: { role: "reviewer"; seatId: string; provider: ProviderName; model?: string; sessionId: string };
	verdict: "pass" | "block";
	rationale: string;
}

export interface ReviewEscalation {
	kind: "review-escalation";
	itemId: string;
	step: "shakedown-code";
	reviewedSha: string;
	evidenceFingerprint: string;
	reviewRecordSource: string;
	hasSafetyBlocker: boolean;
	drivers: ReviewEscalationDriver[];
}

export interface ReviewResolution {
	disposition: "proceed" | "block";
	actor: string;
	rationale: string;
	timestamp: string;
	adr?: string;
}

/**
 * Structured effects-manifest failure codes. Inlined (not imported from effects.ts) so
 * types.ts stays type-only and free of a cycle with effects.ts → Step.
 */
export type EffectsErrorCode = "missing_manifest" | "invalid_manifest" | "provenance_mismatch" | "unknown_effect_kind" | "effect_failed" | "receipt_failed";

/**
 * Descriptor for a harness-issued execution receipt written under
 * `.dev/execution-receipts/`. Path is worktree-relative; sha256 digests the
 * exact on-disk receipt file bytes (evidence-registry identity for
 * `effects-manifest` entries).
 */
export interface ExecutionReceiptDescriptor {
	/** Worktree-relative path, e.g. `.dev/execution-receipts/{runId}/{step}-{attempt}.json` */
	path: string;
	sha256: string;
}

export interface StepResult {
	ok: boolean;
	subtype: string;
	/**
	 * The provider/pipeline's final operational result. May be replaced by a failure
	 * diagnosis or extended with a harness-issued effect result.
	 */
	text: string;
	/**
	 * Ordered assistant chunks plus only the model-authored command string and optional
	 * command description from tool calls. Excludes tool results/output (`output`,
	 * `aggregated_output`, `stdout`, `stderr`, errors) and every other tool-input field,
	 * especially Edit/Write file bodies. The one intentional production reader is the
	 * auto-pick last-resort item-id parse.
	 */
	fullText: string;
	/**
	 * Required, ordered model-authored assistant chunks only — no tool inputs or outputs.
	 * This is the only structured model-output parse source: `text` is the FINAL chunk on
	 * some providers (opencode overwrites it per streamed part) and so truncates a block
	 * split across parts, while `fullText` intentionally carries command/description input.
	 */
	assistantText: string;
	cost: number;
	/** True when `cost` is a provider-side estimate rather than billed USD. */
	costEstimated?: boolean;
	turns: number;
	tokens?: TokenUsage;
	toolCounts?: Record<string, number>;
	outputTail?: string;
	/**
	 * Structured effects-manifest failure (in-memory). Carries a phase discriminant so
	 * ship orchestration can retry only resolve-phase `invalid_manifest` before any
	 * forge write/dispatch. Not a substitute for confinement's string `errorDetail`.
	 */
	effectsError?: {
		code: EffectsErrorCode;
		message: string;
		/** Where the throw happened. Retry policy uses this; omitted from StepLog by default. */
		phase: "resolve" | "write" | "dispatch";
	};
	/** Observe-only stall heuristic: the final message ended in a question / offer-to-continue (no `BLOCKED:` sentinel). Never fails a step. */
	stalledAsk?: boolean;
	/** Emitted decisions with lifecycle IDs retained for cycle-log audit. */
	decisions?: EmittedDecision[];
}

export interface StepLog {
	name: string;
	/** Realized execution backend. Optional only for legacy log compatibility. */
	provider?: ProviderName;
	model: string;
	cost: number;
	turns: number;
	ok: boolean;
	/** Failure category from `step-runner.ts` — present only on failed steps. */
	subtype?: string;
	tokens?: TokenUsage;
	/** 1-indexed attempt number; absent means 1. */
	attempt?: number;
	/** Set when this attempt re-entered the step after the prior attempt hit its turn limit
	 *  (issue #33). Distinguishes turn-exhaustion retries from edit-loop retries in stats. */
	retriedMaxTurns?: boolean;
	/** Verdict from shakedown-plan only. */
	verdict?: "APPROVE" | "REVISE" | "RETHINK";
	/** True when `cost` is a provider-side token-price estimate, not billed USD (e.g. the Codex
	 *  provider on a subscription). Rendered with a `~` prefix so estimates never read as real USD. */
	costEstimated?: boolean;
	toolCounts?: Record<string, number>;
	outputTail?: string;
	/**
	 * Full pipeline-owned failure diagnosis (e.g. confinement audit / changed roots).
	 * Optional for legacy log compatibility; present only when the pipeline overrides the
	 * provider result with its own diagnosis. Unbounded so JSONL retains complete root lists
	 * and Git stderr while `outputTail` stays the bounded display field.
	 */
	errorDetail?: string;
	/**
	 * Structured effects-manifest failure pair for log-only repro. Phase is intentionally
	 * omitted — it is retry policy only and lives on the in-memory StepResult.
	 */
	effectsError?: {
		code: EffectsErrorCode;
		message: string;
	};
	filesChanged?: string[];
	/** Observe-only stall heuristic — the step ended in a question / offer-to-continue. Telemetry only; never fails the step. */
	stalledAsk?: boolean;
	/** Emitted decisions with lifecycle IDs retained for cycle-log audit. */
	decisions?: EmittedDecision[];
	/**
	 * Descriptor for the execution receipt written after successful effects
	 * dispatch (#188). Optional for legacy log compatibility.
	 */
	executionReceipt?: ExecutionReceiptDescriptor;
}

export interface CycleDriverProvenance {
	provider: ProviderName;
	model: string;
}

export interface CycleGitBinding {
	branch: string | null;
	worktree: string | null;
	mainShaAtStart: string | null;
	headSha: string | null;
}

export interface CycleVersionProvenance {
	pelaggio: string;
	node: string;
	drivers: Partial<Record<ProviderName, string>>;
}

export interface CycleProvenance {
	runId: string;
	durationMs: number;
	drivers: CycleDriverProvenance[];
	git: CycleGitBinding;
	versions: CycleVersionProvenance;
	prUrl?: string;
	unavailable?: string[];
	/**
	 * Domain-separated digest of the per-cycle challenge held in process memory
	 * only (#188). Never the raw challenge bytes. Optional for legacy logs.
	 */
	challengeDigest?: string;
	/**
	 * Descriptors for every execution receipt written during this cycle
	 * (ordinary steps + aggregate authoring-review attempt 0). Optional for
	 * legacy log compatibility.
	 */
	executionReceipts?: ExecutionReceiptDescriptor[];
	/**
	 * Unattended signals suppressed by the per-invocation `PELAGGIO_OPERATOR_ATTENDED`
	 * attestation (#276). Persisted on every exit path (success, failure, park) so an
	 * attested headless run is reconstructible from the cycle log alone — the
	 * resolution-time console line is not durable. Present only when non-empty.
	 */
	unattendedSignalSuppressions?: string[];
}

// ── Log entries (read from .dev/pelaggio-log.jsonl) ───────────────────

/**
 * Closed set of park causes. Assigned by `classifyParkReason` in helpers.ts.
 *
 * Known gap on `sdk-outage` (#458): sustained-outage detection (#128) lives in `runOrchestrator`,
 * which relabels the tripping cycle's in-memory result *after* `runPipeline`'s `finish()` has
 * already appended that cycle's log entry. The append-only log is never reconciled, so the cycle
 * that trips the outage persists as an ordinary `transient sdk error` failure — counted by
 * `failuresByCause`, not `parksByClass`.
 *
 * It does NOT simply land on the next cycle: the relabel sets `resetsAt = 0`, so `awaitParkReset`
 * hands back immediately and a serial run has no next cycle at all. In practice this class is
 * only reachable when a parallel sibling worker starts a cycle after the signal is set. Until
 * #458 lands, treat an absent `sdk-outage` count as "not measured", not "did not happen".
 */
export type ParkClass = "rate-limit" | "paused" | "sdk-outage" | "review-escalation" | "review-blocked" | "review-binding" | "effects-failed" | "unclassified";

export interface CycleLogEntry {
	ts: string;
	cycle: number;
	item: string | null;
	quick: boolean;
	steps: StepLog[];
	total_cost: number;
	/** True when any step's cost was a provider-side estimate — so the cycle's `total_cost` is
	 *  not pure billed USD. Kept honest across jsonl, `/stats`, and notifications. */
	costEstimated?: boolean;
	verdict: string | null;
	completed: boolean;
	error: string | null;
	parked?: boolean;
	parkReason?: string | null;
	/** Closed classification of `parkReason` (see `classifyParkReason`). Absent on records
	 *  written before park classification existed — stats render those as `unrecorded`
	 *  rather than silently folding them into a real class. */
	parkClass?: ParkClass;
	shipwrecked?: boolean;
	bookkeepingWarnings?: string[];
	/** True when this line is a day-budget spend receipt (local-review charge), NOT a pipeline
	 *  cycle. Read by `sumDaySpendFromLog` for the durable day-budget seed (#398); filtered out at
	 *  the top of `stats.reduce()` so it never inflates `/stats` cycle/cost tallies. */
	budgetCharge?: boolean;
	/** Additive cycle provenance. Optional only for legacy log compatibility. */
	provenance?: CycleProvenance;
}

// ── Flow events ───────────────────────────────────────────────────────

export type PelaggioEventType =
	| "pelaggio.cycle-completed"
	| "pelaggio.became-ready"
	| "pelaggio.claimed"
	| "pelaggio.plan-published"
	| "pelaggio.plan-rejected"
	| "pelaggio.shakedown-fail"
	| "pelaggio.suspended"
	| "pelaggio.resumed"
	| "pelaggio.in-review"
	| "pelaggio.blocked-discovered"
	| "pelaggio.claim-released"
	| "pelaggio.shipped"
	| "pelaggio.effect-failed"
	| "pelaggio.state-observed"
	| "pelaggio.state-corrected"
	// Process-level continuous-mode lifecycle (issue #83) — not item-flow suspensions.
	| "pelaggio.watch-idle"
	| "pelaggio.watch-wake"
	| "pelaggio.budget-idle"
	| "pelaggio.budget-wake";

export interface FlowEventEnvelope {
	v: 1;
	type: PelaggioEventType;
	eventId: string;
	streamId: string;
	seq: number;
	ts: string;
	itemId: string | null;
	claimId: string | null;
	readinessEpisodeId: string | null;
	executionId: string;
	causationId: string | null;
	attempt?: number;
}

export type CycleCompletedEvent = FlowEventEnvelope & CycleLogEntry & { type: "pelaggio.cycle-completed"; legacy?: false };
export type LegacyCycleCompletedEvent = FlowEventEnvelope & CycleLogEntry & { type: "pelaggio.cycle-completed"; legacy: true };
export type CoreFlowEvent = FlowEventEnvelope & { type: Exclude<PelaggioEventType, "pelaggio.cycle-completed">; [key: string]: unknown };
export type FlowEvent = CycleCompletedEvent | LegacyCycleCompletedEvent | CoreFlowEvent;

export type EventLogDiagnosticKind = "malformed" | "truncatedTail" | "unknownType" | "duplicateEventId" | "duplicateSequence" | "regressingSequence" | "sequenceGap";

export interface EventLogDiagnostic {
	kind: EventLogDiagnosticKind;
	source: string;
	line?: number;
	message: string;
	observedType?: string;
}

export interface EventLogDiagnostics {
	counts: Record<EventLogDiagnosticKind, number>;
	details: EventLogDiagnostic[];
}

export interface ReadEventLogResult {
	events: FlowEvent[];
	diagnostics: EventLogDiagnostics;
}

type FlowEventCorrelations = Partial<Pick<FlowEventEnvelope, "itemId" | "claimId" | "readinessEpisodeId" | "causationId" | "attempt">>;
export type FlowEventInput = FlowEventCorrelations &
	(({ type: "pelaggio.cycle-completed"; ts?: string } & Omit<CycleLogEntry, "ts">) | ({ type: Exclude<PelaggioEventType, "pelaggio.cycle-completed">; ts?: string } & Record<string, unknown>));

export interface EventWriter {
	readonly streamId: string;
	readonly executionId: string;
	append(input: FlowEventInput): FlowEvent;
}

export interface FlowEventProjection {
	totalEvents: number;
	deduplicatedEvents: number;
	byType: Record<PelaggioEventType, number>;
	diagnostics: EventLogDiagnostics;
}

// ── Cycle / pipeline ───────────────────────────────────────────────────

export type CycleDisposition = "continue" | "quarantine-and-continue" | "halt-campaign";

export interface CycleResult {
	itemId: string | null;
	completed: boolean;
	cost: number;
	/** True when `cost` includes provider-side estimates (mirrors `CycleLogEntry.costEstimated`),
	 *  so live cost prints can flag the total with `~`. */
	costEstimated?: boolean;
	verdict?: string;
	error?: string;
	disposition?: CycleDisposition;
	/** Display-only legible one-liner for a failure: the machine `error` plus the failing step's
	 *  subtype + bounded output tail. `error` stays the classification string (RECOVERABLE_ERRORS,
	 *  "parked", "aborted"); `detail` is what the console prints so a failure explains itself (#268). */
	detail?: string;
	awaitingMerge?: boolean;
	prUrl?: string;
	/** Set when the cycle routed through `/shipwreck` recovery (whether or not it recovered).
	 *  `runPipeline`'s `finish()` spreads its local `shipwrecked` flag onto the result so the
	 *  orchestrator can classify a `shipwrecked` notification. Mirrors `CycleLogEntry.shipwrecked`. */
	shipwrecked?: boolean;
	/** Non-blocking roadmap mutations left after a successful feature push. */
	bookkeepingWarnings?: string[];
}

/**
 * Cycle `error` strings that are recoverable / informational — a worker keeps pulling
 * subsequent cycles instead of halting, and (per `notify.ts`) they never page a human.
 * Single-sourced here so the orchestrator's `RECOVERABLE` set and the notification
 * classifier can't drift apart.
 *
 * `parked` belongs to the set but is classified first in `classifyEvent`. The fatal pick
 * errors (`pick:unknown-id`, `pick:blocked`) are intentionally absent: a typo'd `--item`
 * or a user-requested blocked item should halt loudly and page.
 */
export const RECOVERABLE_ERRORS = ["plan needs rethink", "parked", "transient sdk error", "pick:queue-empty", "pick:worktree-exists", "pick:already-claimed", "pick:already-done", "pick:stale-quarantined", "pick:unknown"] as const;

// ── Step providers ─────────────────────────────────────────────────────

/** The backend that runs a step's model. Started as only `"claude"` (the SDK runner);
 *  #80 opened the union for a second provider and #137 adds `"opencode"` (75+ model
 *  backends behind one headless CLI). The runtime names array lives in `config.ts`,
 *  mirroring `ShipTargetName` / `SHIP_TARGET_NAMES`. */
export type ProviderName = "claude" | "codex" | "grok" | "opencode";

// ── Provider capability descriptors (ADR-0020 / #337) ──────────────────
// Data-only facts about what a driver does natively. Axes are orthogonal
// predicates — never ranked by strength. No provider imports or runtime
// registry live here (types.ts stays type-only).

/** OS-isolation mechanisms. Membership-based; never compared by "strength". */
export type IsolationMechanism = "workspace-write" | "landlock";

/**
 * How a provider meters cost.
 * - `usd-billed`: provider-reported billed USD (Claude SDK `total_cost_usd`)
 * - `usd-estimated`: token-price estimate (Codex `estimateCodexCost`)
 * - `pool-quota`: subscription pool ticks (Grok `costUsdTicks`); the token-price
 *   fallback path is declared degraded, not native-equivalent
 */
export type CostMeter = { kind: "usd-billed" } | { kind: "usd-estimated" } | { kind: "pool-quota"; estimateFallback: "degraded" };

/** How the provider delivers model output to the harness. */
export type OutputTransport = "stream" | "final" | "stream-plus-final";

/**
 * Static, complete capability row for a registered provider. Every axis is a
 * closed fact; an unmet hard requirement yields a typed ineligible result rather
 * than silent degradation or polyfill.
 */
export interface ProviderCapabilities {
	/** Per-call tool-policy denial (Claude `PreToolUse` hooks). Distinct from OS isolation. */
	semanticDeny: boolean;
	/** Independent native isolation mechanisms present on this provider. */
	isolation: readonly IsolationMechanism[];
	costMeter: CostMeter;
	/** Provider already parses cache counters into `TokenUsage.cacheRead` / `cacheCreation`. */
	cacheReporting: boolean;
	outputTransport: OutputTransport;
	/** Session/resume id path — unevidenced (false) for every current provider. */
	sessionResume: boolean;
}

/** Axis names that can appear on a degraded realization. */
export type CapabilityAxis = keyof ProviderCapabilities;

type CapabilityRequirement<Axis extends CapabilityAxis> = Axis extends "costMeter" ? CostMeter["kind"] : ProviderCapabilities[Axis];

/** Per-axis predicate used by hard filters and soft native preferences. */
export type CapabilityPredicate = {
	readonly [Axis in CapabilityAxis]?: CapabilityRequirement<Axis>;
};

/** How a candidate satisfied the requested soft preferences. */
export type CapabilityRealizationMode = "native" | "degraded";

export interface CapabilityRealization {
	provider: ProviderName;
	mode: CapabilityRealizationMode;
	/** Soft axes the candidate did not satisfy natively (empty when `mode` is native). */
	degradedAxes: readonly CapabilityAxis[];
}

/** Ordered candidate input for the pure capability resolver. */
export interface CapabilityCandidate<T = unknown> {
	provider: ProviderName;
	/** Opaque seat/settings payload preserved through ranking. */
	payload: T;
}

export type CapabilityRouteResult<T = unknown> = { ok: true; candidates: CapabilityCandidate<T>[]; realizations: CapabilityRealization[] } | { ok: false; reason: string };

/** Closed outcome vocabulary shared by the authoring review loop and `review.Verdict` effects. */
export type ReviewOutcome = "converged-clean" | "converged-with-notes" | "ceiling" | "dissent" | "hard-block" | "budget";

// ── Ship targets ───────────────────────────────────────────────────────

export type ShipTargetName = "direct-push" | "pull-request" | "auto-merge-pr";

export interface ShipContext {
	itemId: string;
	worktree: string;
}

export interface ShipResult {
	completed: boolean;
	awaitingMerge?: boolean;
	prUrl?: string;
	error?: string;
}

export interface ShipTarget {
	readonly name: ShipTargetName;
	buildPrompt(ctx: ShipContext): string;
	interpretResult(step: StepResult): ShipResult;
}

export interface CycleStatus {
	itemId: string;
	status: "done" | "warning" | "running" | "failed" | "skipped" | "parked" | "quarantined";
	cost: number;
	step?: string;
	turns?: number;
	lastActivity?: string;
}

export interface PipelineOpts {
	itemId?: string;
	worktree?: string;
	startFrom?: Step;
	cycle: number;
	verbose: boolean;
	shipTarget: ShipTarget;
	dryRun: boolean;
	pickMutex?: Mutex;
	/**
	 * Run-scoped registry of currently-active peer worktrees under `--parallel`. Each
	 * cycle adds its resolved worktree path on entry and removes it on finish, so a
	 * sibling's legitimate self-write is never audited as another cycle's confinement
	 * violation — without serializing any step. Absent for serial runs and direct
	 * `runPipeline()` callers (they have no peers to exempt). `mainRepo` is never a member
	 * and stays hard-gated by the snapshot.
	 */
	activeWorktrees?: Set<string>;
	/**
	 * #369: immutable cross-process session evaluator context (run-start inventory +
	 * boot-relative starttime watermark). When absent, `runPipeline` captures it once
	 * at entry so direct callers and tests still get inventory-based peer exemption.
	 * The orchestrator may pre-capture once per process and thread the same object
	 * into every worker. Typed object — not a boolean flag.
	 */
	sessionEvaluator?: import("./confinement/sessions.js").SessionEvaluatorContext;
	workerStatus?: CycleStatus;
	logPath?: string;
	/** Required for creating step renderers — injected by orchestrate() */
	liveStatus: import("./tui.js").LiveStatus;
	/** SIGINT-driven cancellation. When aborted, the in-flight SDK query tears down and the cycle surfaces `error: "aborted"`. */
	signal?: AbortSignal;
	/** CI/single-shot mode: use REPO as worktree, skip sibling-path creation. */
	noWorktree?: boolean;
	/**
	 * Unattended-execution evidence for the `review.authoring.enabled=local` gate, computed
	 * once per run by the orchestrator via `detectUnattendedSignals` (CI/single-shot,
	 * daemon-spawned, multi-cycle, headless). Direct `runPipeline()` callers that omit it
	 * fall back to the single-shot signal derived from `noWorktree` — ambient env/TTY are
	 * deliberately not probed inside the pipeline so tests stay hermetic and injectable.
	 */
	unattendedSignals?: readonly string[];
	/**
	 * Unattended signals suppressed by the per-invocation operator attestation
	 * (`PELAGGIO_OPERATOR_ATTENDED=1`; only the headless/TTY signal is attestable).
	 * Threaded alongside `unattendedSignals` so the resolution site logs each
	 * suppression and `finish()` persists it into cycle provenance
	 * (`CycleProvenance.unattendedSignalSuppressions`) on every exit path — an
	 * attested run stays reconstructible from the JSONL log after the fact.
	 */
	unattendedSignalSuppressions?: readonly string[];
	/** Independently gated, fail-soft per-decision delivery. */
	notifyDecision?: (input: { itemId: string | null; decision: Decision; step: Step; source: string; logPath: string; escalation?: ReviewEscalation & { id: string } }) => Promise<void>;
}

// ── Shared mutable state ───────────────────────────────────────────────

export interface ParkSignal {
	parked: boolean;
	resetsAt: number;
	limitType: string;
	triggerWorker: string;
}

// ── CLI flags ──────────────────────────────────────────────────────────

export interface Flags {
	cycles: string;
	parallel: string;
	item?: string;
	resume?: string;
	/** Resume-only acknowledgement of a reviewed escalation evidence fingerprint. */
	"acknowledge-escalation"?: string;
	/** Resume-only: override the auto-detected restart step. Validated against STEPS in runOrchestrator. */
	from?: string;
	/** Resume-only: path to a file of PR-review findings injected into the implement step as
	 *  revision input (issue #60). Requires --resume. */
	"review-findings"?: string;
	verbose: boolean;
	trace: boolean;
	budget: string;
	/** Optional so an unset flag (`undefined`) is distinguishable from an explicit value,
	 *  letting `park.max-wait` config take effect. Precedence: CLI flag > config > "6h". */
	"max-wait"?: string;
	target?: string;
	/** Pin the model/provider profile for the whole run (issue #247), overriding the automatic
	 *  quick-mode downgrade. Validated against CONFIG.modelProfiles in runOrchestrator. */
	profile?: string;
	"dry-run": boolean;
	"no-worktree": boolean;
	/**
	 * Continuous auto-pick mode (issue #82). When true (or when `--preset` is set), the
	 * orchestrator loops past a fixed `--cycles` default: drain exits on empty queue;
	 * watch free-probes and waits. Auto-pick only (no `--item` / `--resume`).
	 */
	continuous?: boolean;
	/** Continuous preset: `drain` (stop on empty) or `watch` (sleep + free probe on empty). */
	preset?: string;
	/** Per-calendar-day USD spend hard cap for continuous mode (issue #82). */
	"day-budget"?: string;
	/** Watch-mode free-probe sleep interval (e.g. `5m`, `1h`). Default `5m`. */
	"probe-interval"?: string;
}

// ── Observer: step events ──────────────────────────────────────────────

export type StepEvent =
	| { type: "step_header"; name: string; model: string; budget: number; maxTurns: number; prompt?: string }
	| { type: "init"; model: string; toolCount: number }
	| { type: "turn" }
	| { type: "compact" }
	| { type: "rate_limit"; limitType: string; resetsAt: number }
	| { type: "tool_use"; name: string; brief: string; mutating: boolean }
	| { type: "tool_error"; name: string; brief: string; error: string }
	| { type: "text"; content: string }
	| { type: "edit_loop"; file: string; count: number }
	| { type: "sdk_warning"; message: string }
	| { type: "sdk_error"; message: string }
	| { type: "blocked"; reason: string }
	| { type: "stalled_ask"; tail: string }
	| { type: "decision"; decision: Decision }
	| { type: "done"; ok: boolean; subtype: string; cost: number; turns: number; elapsed: number };

export type StepEmit = (event: StepEvent) => void;

// ── Mutex ──────────────────────────────────────────────────────────────

export interface Mutex {
	acquire(): Promise<void>;
	release(): void;
}
