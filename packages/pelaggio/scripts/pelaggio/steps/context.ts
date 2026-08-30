/**
 * The seam between one cycle (`pipeline.ts`) and its step modules (`steps/<step>.ts`; plan step 9).
 *
 * A step module receives a live, read-only view of the cycle's closure state (`CycleContext` —
 * getters, so bindings that move during the cycle are always current) and the cycle's nested
 * helpers (`CycleHelpers`). It returns a `StepOutcome`: `terminal` carries a finished
 * `CycleResult` the cycle must return immediately; `continue` carries whatever the next step
 * needs. Steps never assign closure state — the two mutations that exist go through `addCost`
 * and the shared `executionReceipts` array.
 */
import type { appendReviewEscalation as appendReviewEscalationDefault, lookupReviewEscalation as lookupReviewEscalationDefault } from "../decisions.js";
import type { DriverAssignmentState, DriverIdentity } from "../driver-assignment.js";
import type { dispatchStepEffects as dispatchStepEffectsDefault, Effect, writeEffectsManifest as writeEffectsManifestDefault } from "../effects.js";
import type { RoadmapSource } from "../roadmap/index.js";
import type { PrShipGateBinding } from "../ship/pr-effects.js";
import type { RunStepOpts } from "../step-runner.js";
import type { CycleResult, ExecutionReceiptDescriptor, Flags, ParkSignal, PipelineOpts, ProviderName, Step, StepLog, StepResult } from "../types.js";

/**
 * Outcome of a step run through `runStepWithRetry`: either a success carrying the `StepResult`
 * for step-specific follow-up (verdict parse, etc.), or a terminal cycle result the caller should
 * `return` immediately (park / refusal / blocked / max-turns exhaustion / budget-gated retry skip).
 */
export type StepAttempt = { kind: "ok"; result: StepResult } | { kind: "terminal"; cycleResult: CycleResult };
export type StepEffects = Effect[] | ((result: StepResult) => Effect[]);

export interface StepRunOptions {
	attempt?: number;
	commitLabel?: string;
	effects?: StepEffects;
	maxTurnsOverride?: number;
	retriedMaxTurns?: boolean;
	ownWorktree?: string;
	executionOverride?: { provider: ProviderName; model?: string; codexModel?: string };
	parkSignalOverride?: ParkSignal;
	workspaceAccess?: RunStepOpts["workspaceAccess"];
	/** Deterministic gate run against the tree BEFORE the checkpoint's `git add -A` (#424
	 *  review): a failing gate skips the checkpoint entirely so unresolved conflict state
	 *  is never committed as resolved. Result classification is left untouched — the
	 *  caller re-checks the same tree state and fails with the gate's detail. */
	preCheckpointGate?: () => { ok: true } | { ok: false; detail: string };
	/** Gated-OID binding threaded into the effects dispatch for `ship.ShipDecision`
	 *  (ADR-0025 applied to the PR-ship path). Ship step only. */
	shipGate?: PrShipGateBinding;
}

export interface RunStepWithRetryConfig {
	name: Step;
	/** `resolveStepSettings(...).budget` for the dollar gate on a max-turns retry. */
	stepBudget: number;
	buildPrompt: (attempt: number, ctx: { lastLoopFile: string | null }) => string;
	logAttempt: (attempt: number) => void;
	/** Exact per-step refusal wording (task vs review noun) — preserved for tests. */
	refusedError: string;
	maxAttempts?: number;
	/** implement / shakedown-code only: checkpoint label per attempt. */
	commitLabel?: (attempt: number) => string;
	/** Success-dispatched effects; checkpoint effects also preserve work on non-confinement failures. */
	effects?: (attempt: number) => Effect[];
	/** implement only: dynamic turn budget (scaled by plan file count). */
	maxTurnsOverride?: number;
	/** implement only: retry (un-budget-gated) with a fresh-approach prompt on edit_loop. */
	retryOnEditLoop?: boolean;
	/** Turn-limit log noun; defaults to `name` (shakedown-code logs "shakedown"). */
	turnLimitNoun?: string;
	executionOverride?: DriverIdentity;
	/** Threaded to step(): deterministic pre-`git add -A` gate on the checkpoint (#424 review). */
	preCheckpointGate?: () => { ok: true } | { ok: false; detail: string };
}

export type StepOutcome<T extends object = Record<never, never>> = { kind: "terminal"; result: CycleResult } | ({ kind: "continue" } & T);

/** Live, read-only view of the cycle closure a step module may read. */
export interface CycleContext {
	readonly opts: PipelineOpts;
	readonly flags: Flags;
	readonly parkSignal: ParkSignal;
	readonly mainRepo: string;
	readonly roadmap: RoadmapSource;
	readonly assignment: DriverAssignmentState;
	readonly available: (candidate: DriverIdentity) => boolean;
	readonly steps: readonly StepLog[];
	/** Shared with the cycle; steps push receipts, never replace the array. */
	readonly executionReceipts: ExecutionReceiptDescriptor[];
	readonly deferredItemTitles: Set<string>;
	readonly cycleChallenge: Buffer;
	readonly now: () => number;
	readonly writeEffectsManifest: typeof writeEffectsManifestDefault;
	readonly dispatchStepEffects: typeof dispatchStepEffectsDefault;
	readonly appendReviewEscalation: typeof appendReviewEscalationDefault;
	readonly lookupReviewEscalation: typeof lookupReviewEscalationDefault;
	readonly onReviewFindingsConsumed?: (itemId: string) => void;
	/** Bound once `pick` has claimed an item; steps after pick may rely on both. */
	readonly itemId: string;
	readonly worktree: string;
	readonly profile: string;
	readonly verdict: "APPROVE" | "REVISE" | "RETHINK";
	readonly shakedownPlanText: string;
	readonly cost: () => number;
	readonly addCost: (delta: number) => void;
}

/** The cycle's nested helpers a step module may call. */
export interface CycleHelpers {
	readonly log: (msg: string) => void;
	readonly finish: (result: CycleResult) => CycleResult;
	readonly parkExit: (reason?: string) => CycleResult | null;
	readonly runStepWithRetry: (cfg: RunStepWithRetryConfig) => Promise<StepAttempt>;
	readonly step: (name: Step, prompt: string, cwd: string, options?: StepRunOptions) => Promise<StepResult>;
	readonly driverCandidates: (name: Step) => DriverIdentity[];
	readonly itemRunId: () => string;
	readonly observeGitForReceipt: (cwd: string) => { worktree: string | null; headSha: string | null; branch: string | null };
	/** Re-attribute an artifact author from the cycle log on a resume that skips its authoring step. */
	readonly reconstructAuthor: (artifact: "plan" | "implementation", step: "plan" | "implement") => void;
}
