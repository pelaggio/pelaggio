import type { Step } from "./config.js";
export type { Step };

// ── Step results ───────────────────────────────────────────────────────

export interface StepResult {
	ok: boolean;
	subtype: string;
	text: string;
	/** All assistant text + tool inputs accumulated — richer than `text` for ID parsing */
	fullText: string;
	cost: number;
	turns: number;
}

export interface StepLog {
	name: string;
	model: string;
	cost: number;
	turns: number;
	ok: boolean;
}

// ── Cycle / pipeline ───────────────────────────────────────────────────

export interface CycleResult {
	itemId: string | null;
	completed: boolean;
	cost: number;
	verdict?: string;
	error?: string;
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
	pr: boolean;
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
	pr: boolean;
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
