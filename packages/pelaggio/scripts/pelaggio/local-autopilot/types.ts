/** Local Autopilot Contract v0 types. Schemas in `./schemas/v0.schema.json` are normative. */

export const CONTRACT_SCHEMA_VERSION = 1;
export const CONTRACT_SCHEMA_ID = "https://pelaggio/local-autopilot/v0/contract";

export const RUN_STATES = ["queued", "running", "paused", "completed"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const PAUSE_CODES = ["decision_required", "verification_budget", "interrupted", "harness_unavailable"] as const;
export type PauseCode = (typeof PAUSE_CODES)[number];

export const DISPOSITIONS = ["ready_for_review", "cancelled", "failed", "blocked", "budget_exhausted"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const PROBLEM_TYPES = ["config", "protocol", "decision", "verification", "harness", "conflict"] as const;
export type ProblemType = (typeof PROBLEM_TYPES)[number];

export const PROTOCOL_PROBLEM_TYPES: ReadonlySet<ProblemType> = new Set(["config", "protocol", "conflict"]);

export const WORK_CONTRACT_SOURCE_KINDS = ["text", "file", "stdin"] as const;
export type WorkContractSourceKind = (typeof WORK_CONTRACT_SOURCE_KINDS)[number];

export const HARNESS_ADAPTERS = ["fake", "grok"] as const;
export type HarnessAdapterName = (typeof HARNESS_ADAPTERS)[number];

export type OpaqueId = string;
export type UtcTimestamp = string;

export interface Digest {
	algorithm: "sha256";
	value: string;
}

export interface WorkContractSource {
	kind: WorkContractSourceKind;
	uri?: string;
}

export interface WorkContract {
	schemaVersion: 1;
	workContractId: OpaqueId;
	title: string;
	body: string;
	source: WorkContractSource;
	digest: Digest;
	createdAt: UtcTimestamp;
}

export type TaskInput = { text: string } | { file: string } | { stdin: true };

export interface StartRunRequest {
	schemaVersion: 1;
	requestId?: OpaqueId;
	task: TaskInput;
	nonInteractive: boolean;
}

export interface Problem {
	schemaVersion: 1;
	type: ProblemType;
	code: string;
	message: string;
	retryable: boolean;
	runId?: OpaqueId;
}

export interface PauseReason {
	code: PauseCode;
	message: string;
	problem?: Problem;
}

export interface Artifact {
	kind: string;
	uri: string;
	mediaType: string;
	digest: Digest;
}

export interface MetricsUsage {
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
}

export interface Metrics {
	schemaVersion: 1;
	durationMs: number;
	harnessCalls?: number;
	verificationPasses?: number;
	repairAttempts?: number;
	usage?: MetricsUsage;
}

export interface WorktreeRef {
	path?: string;
	branch: string;
}

export interface RunSnapshot {
	schemaVersion: 1;
	runId: OpaqueId;
	requestId?: OpaqueId;
	state: RunState;
	pauseReason?: PauseReason;
	disposition?: Disposition;
	workContract: WorkContract;
	createdAt: UtcTimestamp;
	updatedAt: UtcTimestamp;
	durationMs?: number;
	worktree?: WorktreeRef;
	artifacts: Artifact[];
	problems: Problem[];
	metrics?: Metrics;
}

export interface RunEvent {
	schemaVersion: 1;
	eventId: OpaqueId;
	runId: OpaqueId;
	seq: number;
	type: string;
	at: UtcTimestamp;
	payload?: Record<string, unknown>;
}

export type FakeStep = { action: "write"; path: string; content: string } | { action: "complete" } | { action: "decision"; code: string; message: string } | { action: "verify-fail"; message: string } | { action: "crash"; message: string };

export interface LocalConfig {
	project?: Record<string, never>;
	harness: {
		adapter: HarnessAdapterName;
		fake?: { script: FakeStep[] };
		grok?: { bin?: string; model?: string };
	};
	autopilot?: {
		maxRepairs?: number;
		verification?: { command?: string };
	};
	effects?: { allow?: [] };
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; problem: Problem };

export type LifecycleEvent = "start" | "pause" | "complete" | "continue" | "cancel";
