import type { Step } from "./config.js";

export type { Step };

// ── Step results ───────────────────────────────────────────────────────

export interface TokenUsage {
	input: number;
	output: number;
	cacheCreation: number;
	cacheRead: number;
}

export interface StepResult {
	ok: boolean;
	subtype: string;
	text: string;
	/** All assistant text + tool inputs accumulated — richer than `text` for ID parsing */
	fullText: string;
	cost: number;
	turns: number;
	tokens?: TokenUsage;
	toolCounts?: Record<string, number>;
	outputTail?: string;
	/** Observe-only stall heuristic: the final message ended in a question / offer-to-continue (no `BLOCKED:` sentinel). Never fails a step. */
	stalledAsk?: boolean;
}

export interface StepLog {
	name: string;
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
	toolCounts?: Record<string, number>;
	outputTail?: string;
	filesChanged?: string[];
	/** Observe-only stall heuristic — the step ended in a question / offer-to-continue. Telemetry only; never fails the step. */
	stalledAsk?: boolean;
}

// ── Log entries (read from .dev/autopilot-log.jsonl) ───────────────────

export interface CycleLogEntry {
	ts: string;
	cycle: number;
	item: string | null;
	quick: boolean;
	steps: StepLog[];
	total_cost: number;
	verdict: string | null;
	completed: boolean;
	error: string | null;
	parked?: boolean;
	parkReason?: string | null;
	shipwrecked?: boolean;
}

// ── Cycle / pipeline ───────────────────────────────────────────────────

export interface CycleResult {
	itemId: string | null;
	completed: boolean;
	cost: number;
	verdict?: string;
	error?: string;
	awaitingMerge?: boolean;
	prUrl?: string;
	/** Set when the cycle routed through `/shipwreck` recovery (whether or not it recovered).
	 *  `runPipeline`'s `finish()` spreads its local `shipwrecked` flag onto the result so the
	 *  orchestrator can classify a `shipwrecked` notification. Mirrors `CycleLogEntry.shipwrecked`. */
	shipwrecked?: boolean;
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
export const RECOVERABLE_ERRORS = ["plan needs rethink", "parked", "pick:queue-empty", "pick:worktree-exists", "pick:already-claimed", "pick:already-done", "pick:unknown"] as const;

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
	status: "done" | "running" | "failed" | "skipped" | "parked";
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
	workerStatus?: CycleStatus;
	logPath?: string;
	/** Required for creating step renderers — injected by orchestrate() */
	liveStatus: import("./tui.js").LiveStatus;
	/** SIGINT-driven cancellation. When aborted, the in-flight SDK query tears down and the cycle surfaces `error: "aborted"`. */
	signal?: AbortSignal;
	/** CI/single-shot mode: use REPO as worktree, skip sibling-path creation. */
	noWorktree?: boolean;
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
	/** Resume-only: override the auto-detected restart step. Validated against STEPS in runOrchestrator. */
	from?: string;
	verbose: boolean;
	trace: boolean;
	budget: string;
	/** Optional so an unset flag (`undefined`) is distinguishable from an explicit value,
	 *  letting `park.max-wait` config take effect. Precedence: CLI flag > config > "6h". */
	"max-wait"?: string;
	target?: string;
	"dry-run": boolean;
	"no-worktree": boolean;
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
	| { type: "sdk_error"; message: string }
	| { type: "blocked"; reason: string }
	| { type: "stalled_ask"; tail: string }
	| { type: "done"; ok: boolean; subtype: string; cost: number; turns: number; elapsed: number };

export type StepEmit = (event: StepEvent) => void;

// ── Mutex ──────────────────────────────────────────────────────────────

export interface Mutex {
	acquire(): Promise<void>;
	release(): void;
}
