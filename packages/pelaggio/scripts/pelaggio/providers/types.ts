import type { MainCheckoutDeltaObserver } from "../confinement/roots.js";
import type { EventWriter, ParkSignal, ProviderCapabilities, ProviderName, ProviderObservation, Step, StepEmit, StepResult } from "../types.js";

export interface ForeignRootDenial {
	mainRepo: string;
	/** Known Git worktree roots (main + siblings); foreign roots are denied. */
	registeredWorktrees: readonly string[];
	/** Explicit own item worktree (e.g. shipwreck from main cwd). */
	ownWorktree?: string;
}

export interface RunStepOpts {
	cwd: string;
	profile: string;
	trace: boolean;
	itemId?: string;
	parkSignal: ParkSignal;
	/** Harness-owned workspace access intent. Codex review checkouts prepared as data stay read-only
	 * even when they are Git worktrees; authoring-review seats omit this and remain writable. */
	workspaceAccess?: "read-only";
	/** Per-call override for the step's `maxTurns`. Used by `implement` to size the
	 * budget from the plan's file count (see `computeImplementTurns` in helpers.ts).
	 * When undefined, falls back to the profile-resolved turn limit. */
	maxTurnsOverride?: number;
	/** Cancellation signal — sourced from SIGINT and/or a mid-step confinement trip
	 * (#388; the pipeline always threads its own per-step `AbortController` here, composed
	 * with any external SIGINT signal). Threaded through to the SDK's `query()` call so an
	 * in-flight fetch stream tears down when the controller aborts. */
	signal?: AbortSignal;
	/** Brackets mutating provider tools for dirty-main delta attribution. */
	mainCheckoutObserver?: MainCheckoutDeltaObserver;
	/** Select a provider/model for this invocation without changing profile configuration. */
	executionOverride?: { provider: ProviderName; model?: string; codexModel?: string };
	/**
	 * #369: register the outer Bubblewrap PID once spawned so the session record
	 * can bind Linux /proc evidence to the worktree-resident wrapper. Invoked from
	 * the unconditional `spawnClaudeCodeProcess` seat adapter; pid is captured from
	 * ChildProcess (SpawnedProcess does not declare pid). Observation only — it
	 * does not decide whether the seat wrap exists.
	 */
	onChildSpawn?: (info: { pid: number; cwd: string }) => void;
	/**
	 * #369: deny Write/Edit into main and every registered foreign worktree root.
	 * When present, hooks install even for main-cwd steps (shipwreck) so foreign-root
	 * + `.dev/sessions/` denial actually run.
	 */
	foreignRootDenial?: ForeignRootDenial;
	/** Optional typed provider-observation callback. Absent callers (direct CLIs, hermetic tests) no-op. */
	onProviderObservation?: (observation: ProviderObservation) => void;
	/** Shared durable writer used by the dispatcher observation funnel. */
	eventWriter?: EventWriter;
	/** Attempt correlation for durable provider observations. */
	providerObservationAttempt?: number;
	/** Compact diagnostic sink for fail-soft observation drops. */
	providerObservationLog?: (message: string) => void;
}

/** Canonical signature of a step runner. Single-sourced here (all four types are in
 *  scope) and re-exported from `pipeline.ts`, so `mocks.ts`'s `RunStepFn` import and
 *  the `deps.runStep` DI seam resolve to one definition. */
export type RunStepFn = (name: Step, prompt: string, opts: RunStepOpts, emit: StepEmit) => Promise<StepResult>;

/** A step-execution backend. Every registered provider declares a complete static
 *  capability descriptor beside `runStep` (ADR-0020 / #337). The exported `runStep`
 *  dispatches by the per-step resolved `provider` and gains no adaptation registry. */
export interface StepProvider {
	name: ProviderName;
	/** Data-only native capability row. Orthogonal predicates; never ranked by strength. */
	capabilities: ProviderCapabilities;
	runStep: RunStepFn;
}
