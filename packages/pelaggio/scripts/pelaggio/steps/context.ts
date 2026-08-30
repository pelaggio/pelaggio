/**
 * The seam between one cycle (`pipeline.ts`) and its step modules (`steps/<step>.ts`; plan step 9).
 *
 * A step module receives a plain value `<Step>Input` the cycle builds at the call site — only the
 * bindings that step reads, snapshotted when it starts — and a `<Step>Deps` of the cycle helpers
 * it calls. Inputs are data only — strings, flags, records, the shared receipts array; anything
 * callable (the roadmap adapter, run options with callbacks, the effects seam) is a Dep. There is no shared state view: a step that needs one more binding widens its own
 * `Input` interface, and the cycle passes it explicitly. It returns a `StepOutcome`: `terminal`
 * carries a finished `CycleResult` the cycle must return immediately; `continue` carries whatever
 * the next step needs (the cycle owns the binding it lands in). Steps never assign cycle state —
 * the running cost total moves only through `addCost`, and the receipts array is pushed to,
 * never replaced.
 */
import type { createSessionController as createSessionControllerDefault } from "../confinement/sessions.js";
import type { DriverIdentity } from "../driver-assignment.js";
import type { Effect } from "../effects.js";
import type { FlowPolicy } from "../flow-policy.js";
import type { RoadmapSource } from "../roadmap/index.js";
import type { PrShipGateBinding } from "../ship/pr-effects.js";
import type { RunStepOpts } from "../step-runner.js";
import type { CycleResult, ParkSignal, ProviderName, Step, StepResult } from "../types.js";
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

/** The cycle's capabilities a step module may call; each step `Pick`s exactly the ones it uses. */
export interface CycleHelpers {
	readonly log: (msg: string) => void;
	/** The roadmap adapter — a capability (plan paths, item creation), never Input data. */
	readonly roadmap: RoadmapSource;
	/** Running cost total (read) and the only way a step adds to it. */
	readonly cost: () => number;
	readonly addCost: (delta: number) => void;
	readonly finish: (result: CycleResult) => CycleResult;
	readonly parkExit: (reason?: string) => CycleResult | null;
	readonly runStepWithRetry: (cfg: RunStepWithRetryConfig) => Promise<StepAttempt>;
	readonly step: (name: Step, prompt: string, cwd: string, options?: StepRunOptions) => Promise<StepResult>;
	readonly driverCandidates: (name: Step) => DriverIdentity[];
	/** Whether a driver may still be assigned this cycle (pool/quota policy). */
	readonly available: (candidate: DriverIdentity) => boolean;
	readonly itemRunId: () => string;
	/** Attempt run id for an explicit item — for the pick, which resolves the item before the cycle adopts it. */
	readonly itemRunIdFor: (itemId: string) => string;
	readonly observeGitForReceipt: (cwd: string) => { worktree: string | null; headSha: string | null; branch: string | null };
	/** Re-attribute an artifact author from the cycle log on a resume that skips its authoring step. */
	readonly reconstructAuthor: (artifact: "plan" | "implementation", step: "plan" | "implement") => void;
	/** Rename the cycle's log label once the item is known (pick). */
	readonly setLogLabel: (label: string) => void;
	readonly listWorktrees: () => string[];
	readonly resolveWorktree: (itemId: string) => string;
	readonly createSessionController: typeof createSessionControllerDefault;
	readonly isQuickScope: FlowPolicy["isQuickScope"];
}
