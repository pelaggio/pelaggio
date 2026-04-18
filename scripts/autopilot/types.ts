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
}

export interface StepLog {
	name: string;
	model: string;
	cost: number;
	turns: number;
	ok: boolean;
	tokens?: TokenUsage;
	/** 1-indexed attempt number; absent means 1. */
	attempt?: number;
	/** Verdict from shakedown-plan only. */
	verdict?: "APPROVE" | "REVISE" | "RETHINK";
	toolCounts?: Record<string, number>;
	outputTail?: string;
	filesChanged?: string[];
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
}

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
	verbose: boolean;
	trace: boolean;
	budget: string;
	"max-wait": string;
	target?: string;
	"dry-run": boolean;
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
	| { type: "done"; ok: boolean; subtype: string; cost: number; turns: number; elapsed: number };

export type StepEmit = (event: StepEvent) => void;

// ── Mutex ──────────────────────────────────────────────────────────────

export interface Mutex {
	acquire(): Promise<void>;
	release(): void;
}
