import { assertSnapshotInvariants } from "./lifecycle.js";
import { configProblem, isArtifactKind, isEventType, isNonNegativeInt, isNonNegativeNumber, isObject, isOpaqueId, isProblemCode, isSha256, isUtcTimestamp, protocolProblem, rejectUnknownKeys, requireCamelCaseKeys } from "./transport.js";
import {
	type Artifact,
	CONTRACT_SCHEMA_VERSION,
	DISPOSITIONS,
	type Digest,
	type Disposition,
	EXECUTION_MODES,
	type ExecutionAssurance,
	type FakeStep,
	HARNESS_ADAPTERS,
	type LocalConfig,
	type Metrics,
	type MetricsUsage,
	PAUSE_CODES,
	type ParseResult,
	type PauseCode,
	type PauseReason,
	PROBLEM_TYPES,
	type Problem,
	type ProblemType,
	RUN_STATES,
	type RunEvent,
	type RunSnapshot,
	type RunState,
	type StartRunRequest,
	type TaskInput,
	WORK_CONTRACT_SOURCE_KINDS,
	type WorkContract,
	type WorktreeRef,
} from "./types.js";

const WORK_CONTRACT_KEYS = new Set(["schemaVersion", "workContractId", "title", "body", "source", "digest", "createdAt"]);
const SOURCE_KEYS = new Set(["kind", "uri"]);
const DIGEST_KEYS = new Set(["algorithm", "value"]);
const START_KEYS = new Set(["schemaVersion", "requestId", "task", "nonInteractive"]);
const TASK_TEXT_KEYS = new Set(["text"]);
const TASK_FILE_KEYS = new Set(["file"]);
const TASK_STDIN_KEYS = new Set(["stdin"]);
const PROBLEM_KEYS = new Set(["schemaVersion", "type", "code", "message", "retryable", "runId"]);
const PAUSE_KEYS = new Set(["code", "message", "problem"]);
const ARTIFACT_KEYS = new Set(["kind", "uri", "mediaType", "digest"]);
const METRICS_KEYS = new Set(["schemaVersion", "durationMs", "harnessCalls", "verificationPasses", "repairAttempts", "usage"]);
const USAGE_KEYS = new Set(["inputTokens", "outputTokens", "costUsd"]);
const WORKTREE_KEYS = new Set(["path", "branch"]);
const SNAPSHOT_KEYS = new Set(["schemaVersion", "runId", "requestId", "state", "pauseReason", "disposition", "workContract", "createdAt", "updatedAt", "durationMs", "worktree", "execution", "artifacts", "problems", "metrics"]);
const EVENT_KEYS = new Set(["schemaVersion", "eventId", "runId", "seq", "type", "at", "payload"]);
const CONFIG_KEYS = new Set(["project", "harness", "autopilot", "execution", "effects"]);
const HARNESS_KEYS = new Set(["adapter", "fake", "grok"]);
const FAKE_KEYS = new Set(["script"]);
const GROK_KEYS = new Set(["bin", "model"]);
const AUTOPILOT_KEYS = new Set(["maxRepairs", "verification"]);
const VERIFICATION_KEYS = new Set(["command"]);
const EFFECTS_KEYS = new Set(["allow"]);
const EXECUTION_KEYS = new Set(["mode"]);
const ASSURANCE_KEYS = new Set(["mode", "contained", "effectsEnforced"]);
const PROJECT_KEYS = new Set<string>([]);

function fail(problem: Problem): ParseResult<never> {
	return { ok: false, problem };
}

function requireSchemaVersion(value: Record<string, unknown>, label: string): ParseResult<1> {
	if (value.schemaVersion !== CONTRACT_SCHEMA_VERSION) return fail(protocolProblem("schema-version", `${label}.schemaVersion must be ${CONTRACT_SCHEMA_VERSION}`));
	return { ok: true, value: 1 };
}

function parseString(value: unknown, label: string, min: number, max: number): ParseResult<string> {
	if (typeof value !== "string") return fail(protocolProblem("type", `${label} must be a string`));
	// JSON Schema minLength/maxLength count Unicode code points, not UTF-16 units.
	let length = 0;
	for (const _codePoint of value) {
		if (++length > max) break;
	}
	if (length < min || length > max) return fail(protocolProblem("length", `${label} length must be ${min}..${max}`));
	return { ok: true, value };
}

export function parseDigest(value: unknown, label = "digest"): ParseResult<Digest> {
	if (!isObject(value)) return fail(protocolProblem("type", `${label} must be an object`));
	const camel = requireCamelCaseKeys(value, label);
	if (!camel.ok) return camel;
	const unknown = rejectUnknownKeys(value, DIGEST_KEYS, label);
	if (!unknown.ok) return unknown;
	if (value.algorithm !== "sha256") return fail(protocolProblem("digest-algorithm", `${label}.algorithm must be sha256`));
	if (!isSha256(value.value)) return fail(protocolProblem("digest-value", `${label}.value must be a lowercase sha256 hex digest`));
	return { ok: true, value: { algorithm: "sha256", value: value.value } };
}

export function parseWorkContract(value: unknown): ParseResult<WorkContract> {
	if (!isObject(value)) return fail(protocolProblem("type", "workContract must be an object"));
	const camel = requireCamelCaseKeys(value, "workContract");
	if (!camel.ok) return camel;
	const unknown = rejectUnknownKeys(value, WORK_CONTRACT_KEYS, "workContract");
	if (!unknown.ok) return unknown;
	const version = requireSchemaVersion(value, "workContract");
	if (!version.ok) return version;
	if (!isOpaqueId(value.workContractId)) return fail(protocolProblem("opaque-id", "workContract.workContractId is not an opaque id"));
	const title = parseString(value.title, "workContract.title", 1, 200);
	if (!title.ok) return title;
	if (typeof value.body !== "string") return fail(protocolProblem("type", "workContract.body must be a string"));
	if (!isObject(value.source)) return fail(protocolProblem("type", "workContract.source must be an object"));
	const sourceCamel = requireCamelCaseKeys(value.source, "workContract.source");
	if (!sourceCamel.ok) return sourceCamel;
	const sourceUnknown = rejectUnknownKeys(value.source, SOURCE_KEYS, "workContract.source");
	if (!sourceUnknown.ok) return sourceUnknown;
	if (typeof value.source.kind !== "string" || !(WORK_CONTRACT_SOURCE_KINDS as readonly string[]).includes(value.source.kind)) {
		return fail(protocolProblem("source-kind", "workContract.source.kind must be text|file|stdin"));
	}
	let uri: string | undefined;
	if (value.source.uri !== undefined) {
		const parsedUri = parseString(value.source.uri, "workContract.source.uri", 1, 4096);
		if (!parsedUri.ok) return parsedUri;
		uri = parsedUri.value;
	}
	const digest = parseDigest(value.digest, "workContract.digest");
	if (!digest.ok) return digest;
	if (!isUtcTimestamp(value.createdAt)) return fail(protocolProblem("timestamp", "workContract.createdAt must be a UTC timestamp"));
	return {
		ok: true,
		value: {
			schemaVersion: 1,
			workContractId: value.workContractId,
			title: title.value,
			body: value.body,
			source: { kind: value.source.kind as WorkContract["source"]["kind"], ...(uri ? { uri } : {}) },
			digest: digest.value,
			createdAt: value.createdAt,
		},
	};
}

function parseTaskInput(value: unknown): ParseResult<TaskInput> {
	if (!isObject(value)) return fail(protocolProblem("type", "task must be an object"));
	const camel = requireCamelCaseKeys(value, "task");
	if (!camel.ok) return camel;
	const keys = Object.keys(value);
	if (keys.length !== 1) return fail(protocolProblem("task", "task must contain exactly one of text, file, or stdin"));
	if ("text" in value) {
		const unknown = rejectUnknownKeys(value, TASK_TEXT_KEYS, "task");
		if (!unknown.ok) return unknown;
		const text = parseString(value.text, "task.text", 1, Number.MAX_SAFE_INTEGER);
		if (!text.ok) return text;
		return { ok: true, value: { text: text.value } };
	}
	if ("file" in value) {
		const unknown = rejectUnknownKeys(value, TASK_FILE_KEYS, "task");
		if (!unknown.ok) return unknown;
		const file = parseString(value.file, "task.file", 1, 4096);
		if (!file.ok) return file;
		return { ok: true, value: { file: file.value } };
	}
	if ("stdin" in value) {
		const unknown = rejectUnknownKeys(value, TASK_STDIN_KEYS, "task");
		if (!unknown.ok) return unknown;
		if (value.stdin !== true) return fail(protocolProblem("task", "task.stdin must be true"));
		return { ok: true, value: { stdin: true } };
	}
	return fail(protocolProblem("task", "task must contain exactly one of text, file, or stdin"));
}

export function parseStartRunRequest(value: unknown): ParseResult<StartRunRequest> {
	if (!isObject(value)) return fail(protocolProblem("type", "startRunRequest must be an object"));
	const camel = requireCamelCaseKeys(value, "startRunRequest");
	if (!camel.ok) return camel;
	const unknown = rejectUnknownKeys(value, START_KEYS, "startRunRequest");
	if (!unknown.ok) return unknown;
	const version = requireSchemaVersion(value, "startRunRequest");
	if (!version.ok) return version;
	const task = parseTaskInput(value.task);
	if (!task.ok) return task;
	if (typeof value.nonInteractive !== "boolean") return fail(protocolProblem("type", "startRunRequest.nonInteractive must be a boolean"));
	let requestId: string | undefined;
	if (value.requestId !== undefined) {
		if (!isOpaqueId(value.requestId)) return fail(protocolProblem("opaque-id", "startRunRequest.requestId is not an opaque id"));
		requestId = value.requestId;
	}
	return { ok: true, value: { schemaVersion: 1, task: task.value, nonInteractive: value.nonInteractive, ...(requestId ? { requestId } : {}) } };
}

export function parseProblem(value: unknown, label = "problem", extraOk = true): ParseResult<Problem> {
	if (!isObject(value)) return fail(protocolProblem("type", `${label} must be an object`));
	const camel = requireCamelCaseKeys(value, label);
	if (!camel.ok) return camel;
	if (!extraOk) {
		const unknown = rejectUnknownKeys(value, PROBLEM_KEYS, label);
		if (!unknown.ok) return unknown;
	} else {
		for (const key of Object.keys(value)) {
			if (!PROBLEM_KEYS.has(key) && !/^[a-z][a-zA-Z0-9]*$/.test(key)) {
				return fail(protocolProblem("field-name", `${label} field "${key}" must be camelCase`));
			}
		}
	}
	const version = requireSchemaVersion(value, label);
	if (!version.ok) return version;
	if (typeof value.type !== "string" || !(PROBLEM_TYPES as readonly string[]).includes(value.type)) {
		return fail(protocolProblem("problem-type", `${label}.type is not a known problem type`));
	}
	if (!isProblemCode(value.code)) return fail(protocolProblem("problem-code", `${label}.code is invalid`));
	const message = parseString(value.message, `${label}.message`, 1, 2000);
	if (!message.ok) return message;
	if (typeof value.retryable !== "boolean") return fail(protocolProblem("type", `${label}.retryable must be a boolean`));
	let runId: string | undefined;
	if (value.runId !== undefined) {
		if (!isOpaqueId(value.runId)) return fail(protocolProblem("opaque-id", `${label}.runId is not an opaque id`));
		runId = value.runId;
	}
	return {
		ok: true,
		value: { schemaVersion: 1, type: value.type as ProblemType, code: value.code, message: message.value, retryable: value.retryable, ...(runId ? { runId } : {}) },
	};
}

export function parsePauseReason(value: unknown): ParseResult<PauseReason> {
	if (!isObject(value)) return fail(protocolProblem("type", "pauseReason must be an object"));
	const camel = requireCamelCaseKeys(value, "pauseReason");
	if (!camel.ok) return camel;
	for (const key of Object.keys(value)) {
		if (!PAUSE_KEYS.has(key) && !/^[a-z][a-zA-Z0-9]*$/.test(key)) {
			return fail(protocolProblem("field-name", `pauseReason field "${key}" must be camelCase`));
		}
	}
	if (typeof value.code !== "string" || !(PAUSE_CODES as readonly string[]).includes(value.code)) {
		return fail(protocolProblem("pause-code", "pauseReason.code is not a known pause code"));
	}
	const message = parseString(value.message, "pauseReason.message", 1, 2000);
	if (!message.ok) return message;
	let problem: Problem | undefined;
	if (value.problem !== undefined) {
		const parsed = parseProblem(value.problem, "pauseReason.problem");
		if (!parsed.ok) return parsed;
		problem = parsed.value;
	}
	return { ok: true, value: { code: value.code as PauseCode, message: message.value, ...(problem ? { problem } : {}) } };
}

export function parseArtifact(value: unknown): ParseResult<Artifact> {
	if (!isObject(value)) return fail(protocolProblem("type", "artifact must be an object"));
	const camel = requireCamelCaseKeys(value, "artifact");
	if (!camel.ok) return camel;
	for (const key of Object.keys(value)) {
		if (!ARTIFACT_KEYS.has(key) && !/^[a-z][a-zA-Z0-9]*$/.test(key)) {
			return fail(protocolProblem("field-name", `artifact field "${key}" must be camelCase`));
		}
	}
	if (!isArtifactKind(value.kind)) return fail(protocolProblem("artifact-kind", "artifact.kind is invalid"));
	const uri = parseString(value.uri, "artifact.uri", 1, 4096);
	if (!uri.ok) return uri;
	const mediaType = parseString(value.mediaType, "artifact.mediaType", 1, 128);
	if (!mediaType.ok) return mediaType;
	const digest = parseDigest(value.digest, "artifact.digest");
	if (!digest.ok) return digest;
	return { ok: true, value: { kind: value.kind, uri: uri.value, mediaType: mediaType.value, digest: digest.value } };
}

function parseUsage(value: unknown): ParseResult<MetricsUsage> {
	if (!isObject(value)) return fail(protocolProblem("type", "metrics.usage must be an object"));
	const camel = requireCamelCaseKeys(value, "metrics.usage");
	if (!camel.ok) return camel;
	const unknown = rejectUnknownKeys(value, USAGE_KEYS, "metrics.usage");
	if (!unknown.ok) return unknown;
	const usage: MetricsUsage = {};
	if (value.inputTokens !== undefined) {
		if (!isNonNegativeInt(value.inputTokens)) return fail(protocolProblem("usage", "metrics.usage.inputTokens must be a non-negative integer"));
		usage.inputTokens = value.inputTokens;
	}
	if (value.outputTokens !== undefined) {
		if (!isNonNegativeInt(value.outputTokens)) return fail(protocolProblem("usage", "metrics.usage.outputTokens must be a non-negative integer"));
		usage.outputTokens = value.outputTokens;
	}
	if (value.costUsd !== undefined) {
		if (!isNonNegativeNumber(value.costUsd)) return fail(protocolProblem("usage", "metrics.usage.costUsd must be a non-negative number"));
		usage.costUsd = value.costUsd;
	}
	if (Object.keys(usage).length === 0) return fail(protocolProblem("usage", "metrics.usage must contain at least one reported figure"));
	return { ok: true, value: usage };
}

export function parseMetrics(value: unknown): ParseResult<Metrics> {
	if (!isObject(value)) return fail(protocolProblem("type", "metrics must be an object"));
	const camel = requireCamelCaseKeys(value, "metrics");
	if (!camel.ok) return camel;
	const unknown = rejectUnknownKeys(value, METRICS_KEYS, "metrics");
	if (!unknown.ok) return unknown;
	const version = requireSchemaVersion(value, "metrics");
	if (!version.ok) return version;
	if (!isNonNegativeInt(value.durationMs)) return fail(protocolProblem("duration", "metrics.durationMs must be a non-negative integer"));
	const metrics: Metrics = { schemaVersion: 1, durationMs: value.durationMs };
	if (value.harnessCalls !== undefined) {
		if (!isNonNegativeInt(value.harnessCalls)) return fail(protocolProblem("metrics", "metrics.harnessCalls must be a non-negative integer"));
		metrics.harnessCalls = value.harnessCalls;
	}
	if (value.verificationPasses !== undefined) {
		if (!isNonNegativeInt(value.verificationPasses)) return fail(protocolProblem("metrics", "metrics.verificationPasses must be a non-negative integer"));
		metrics.verificationPasses = value.verificationPasses;
	}
	if (value.repairAttempts !== undefined) {
		if (!isNonNegativeInt(value.repairAttempts)) return fail(protocolProblem("metrics", "metrics.repairAttempts must be a non-negative integer"));
		metrics.repairAttempts = value.repairAttempts;
	}
	if (value.usage !== undefined) {
		const usage = parseUsage(value.usage);
		if (!usage.ok) return usage;
		metrics.usage = usage.value;
	}
	return { ok: true, value: metrics };
}

function parseWorktree(value: unknown): ParseResult<WorktreeRef> {
	if (!isObject(value)) return fail(protocolProblem("type", "worktree must be an object"));
	const camel = requireCamelCaseKeys(value, "worktree");
	if (!camel.ok) return camel;
	for (const key of Object.keys(value)) {
		if (!WORKTREE_KEYS.has(key) && !/^[a-z][a-zA-Z0-9]*$/.test(key)) {
			return fail(protocolProblem("field-name", `worktree field "${key}" must be camelCase`));
		}
	}
	const branch = parseString(value.branch, "worktree.branch", 1, 255);
	if (!branch.ok) return branch;
	let path: string | undefined;
	if (value.path !== undefined) {
		const parsed = parseString(value.path, "worktree.path", 1, Number.MAX_SAFE_INTEGER);
		if (!parsed.ok) return parsed;
		path = parsed.value;
	}
	return { ok: true, value: { branch: branch.value, ...(path ? { path } : {}) } };
}

function parseExecutionAssurance(value: unknown): ParseResult<ExecutionAssurance> {
	if (!isObject(value)) return fail(protocolProblem("type", "execution must be an object"));
	const unknown = rejectUnknownKeys(value, ASSURANCE_KEYS, "execution");
	if (!unknown.ok) return unknown;
	if (typeof value.mode !== "string" || !(EXECUTION_MODES as readonly string[]).includes(value.mode)) {
		return fail(protocolProblem("execution-mode", "execution.mode must be host|contained"));
	}
	if (typeof value.contained !== "boolean" || typeof value.effectsEnforced !== "boolean") {
		return fail(protocolProblem("execution-assurance", "execution.contained and execution.effectsEnforced must be booleans"));
	}
	const expected = value.mode === "contained";
	if (value.contained !== expected || value.effectsEnforced !== expected) {
		return fail(protocolProblem("execution-assurance", `execution assurance is inconsistent with ${value.mode} mode`));
	}
	return { ok: true, value: { mode: value.mode as ExecutionAssurance["mode"], contained: expected, effectsEnforced: expected } };
}

export function parseRunSnapshot(value: unknown): ParseResult<RunSnapshot> {
	if (!isObject(value)) return fail(protocolProblem("type", "runSnapshot must be an object"));
	const camel = requireCamelCaseKeys(value, "runSnapshot");
	if (!camel.ok) return camel;
	for (const key of Object.keys(value)) {
		if (!SNAPSHOT_KEYS.has(key) && !/^[a-z][a-zA-Z0-9]*$/.test(key)) {
			return fail(protocolProblem("field-name", `runSnapshot field "${key}" must be camelCase`));
		}
	}
	const version = requireSchemaVersion(value, "runSnapshot");
	if (!version.ok) return version;
	if (!isOpaqueId(value.runId)) return fail(protocolProblem("opaque-id", "runSnapshot.runId is not an opaque id"));
	if (typeof value.state !== "string" || !(RUN_STATES as readonly string[]).includes(value.state)) {
		return fail(protocolProblem("state", "runSnapshot.state is not a known run state"));
	}
	const workContract = parseWorkContract(value.workContract);
	if (!workContract.ok) return workContract;
	if (!isUtcTimestamp(value.createdAt)) return fail(protocolProblem("timestamp", "runSnapshot.createdAt must be a UTC timestamp"));
	if (!isUtcTimestamp(value.updatedAt)) return fail(protocolProblem("timestamp", "runSnapshot.updatedAt must be a UTC timestamp"));
	if (!Array.isArray(value.artifacts)) return fail(protocolProblem("type", "runSnapshot.artifacts must be an array"));
	const artifacts: Artifact[] = [];
	for (const item of value.artifacts) {
		const parsed = parseArtifact(item);
		if (!parsed.ok) return parsed;
		artifacts.push(parsed.value);
	}
	if (!Array.isArray(value.problems)) return fail(protocolProblem("type", "runSnapshot.problems must be an array"));
	const problems: Problem[] = [];
	for (const item of value.problems) {
		const parsed = parseProblem(item);
		if (!parsed.ok) return parsed;
		problems.push(parsed.value);
	}
	const snapshot: RunSnapshot = {
		schemaVersion: 1,
		runId: value.runId,
		state: value.state as RunState,
		workContract: workContract.value,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		execution: { mode: "host", contained: false, effectsEnforced: false },
		artifacts,
		problems,
	};
	const execution = parseExecutionAssurance(value.execution);
	if (!execution.ok) return execution;
	snapshot.execution = execution.value;
	if (value.requestId !== undefined) {
		if (!isOpaqueId(value.requestId)) return fail(protocolProblem("opaque-id", "runSnapshot.requestId is not an opaque id"));
		snapshot.requestId = value.requestId;
	}
	if (value.pauseReason !== undefined) {
		const pauseReason = parsePauseReason(value.pauseReason);
		if (!pauseReason.ok) return pauseReason;
		snapshot.pauseReason = pauseReason.value;
	}
	if (value.disposition !== undefined) {
		if (typeof value.disposition !== "string" || !(DISPOSITIONS as readonly string[]).includes(value.disposition)) {
			return fail(protocolProblem("disposition", "runSnapshot.disposition is not a known disposition"));
		}
		snapshot.disposition = value.disposition as Disposition;
	}
	if (value.durationMs !== undefined) {
		if (!isNonNegativeInt(value.durationMs)) return fail(protocolProblem("duration", "runSnapshot.durationMs must be a non-negative integer"));
		snapshot.durationMs = value.durationMs;
	}
	if (value.worktree !== undefined) {
		const worktree = parseWorktree(value.worktree);
		if (!worktree.ok) return worktree;
		snapshot.worktree = worktree.value;
	}
	if (value.metrics !== undefined) {
		const metrics = parseMetrics(value.metrics);
		if (!metrics.ok) return metrics;
		snapshot.metrics = metrics.value;
	}
	return assertSnapshotInvariants(snapshot);
}

export function parseRunEvent(value: unknown): ParseResult<RunEvent> {
	if (!isObject(value)) return fail(protocolProblem("type", "event must be an object"));
	const camel = requireCamelCaseKeys(value, "event");
	if (!camel.ok) return camel;
	for (const key of Object.keys(value)) {
		if (!EVENT_KEYS.has(key) && !/^[a-z][a-zA-Z0-9]*$/.test(key)) {
			return fail(protocolProblem("field-name", `event field "${key}" must be camelCase`));
		}
	}
	const version = requireSchemaVersion(value, "event");
	if (!version.ok) return version;
	if (!isOpaqueId(value.eventId)) return fail(protocolProblem("opaque-id", "event.eventId is not an opaque id"));
	if (!isOpaqueId(value.runId)) return fail(protocolProblem("opaque-id", "event.runId is not an opaque id"));
	if (!isNonNegativeInt(value.seq)) return fail(protocolProblem("seq", "event.seq must be a non-negative integer"));
	if (!isEventType(value.type)) return fail(protocolProblem("event-type", "event.type must be a pelaggio.local-autopilot.* name"));
	if (!isUtcTimestamp(value.at)) return fail(protocolProblem("timestamp", "event.at must be a UTC timestamp"));
	let payload: Record<string, unknown> | undefined;
	if (value.payload !== undefined) {
		if (!isObject(value.payload)) return fail(protocolProblem("type", "event.payload must be an object"));
		payload = value.payload;
	}
	return {
		ok: true,
		value: {
			schemaVersion: 1,
			eventId: value.eventId,
			runId: value.runId,
			seq: value.seq,
			type: value.type,
			at: value.at,
			...(payload ? { payload } : {}),
		},
	};
}

function parseFakeStep(value: unknown, index: number): ParseResult<FakeStep> {
	const label = `harness.fake.script[${index}]`;
	if (!isObject(value)) return fail(configProblem("fake-step", `${label} must be an object`));
	const camel = requireCamelCaseKeys(value, label);
	if (!camel.ok) return camel;
	if (value.action === "write") {
		const unknown = rejectUnknownKeys(value, new Set(["action", "path", "content"]), label);
		if (!unknown.ok) return unknown;
		const path = parseString(value.path, `${label}.path`, 1, 512);
		if (!path.ok) return path;
		if (typeof value.content !== "string") return fail(configProblem("fake-step", `${label}.content must be a string`));
		return { ok: true, value: { action: "write", path: path.value, content: value.content } };
	}
	if (value.action === "complete") {
		const unknown = rejectUnknownKeys(value, new Set(["action"]), label);
		if (!unknown.ok) return unknown;
		return { ok: true, value: { action: "complete" } };
	}
	if (value.action === "decision") {
		const unknown = rejectUnknownKeys(value, new Set(["action", "code", "message"]), label);
		if (!unknown.ok) return unknown;
		const code = parseString(value.code, `${label}.code`, 1, 64);
		if (!code.ok) return code;
		const message = parseString(value.message, `${label}.message`, 1, 2000);
		if (!message.ok) return message;
		return { ok: true, value: { action: "decision", code: code.value, message: message.value } };
	}
	if (value.action === "verify-fail" || value.action === "crash") {
		const unknown = rejectUnknownKeys(value, new Set(["action", "message"]), label);
		if (!unknown.ok) return unknown;
		const message = parseString(value.message, `${label}.message`, 1, 2000);
		if (!message.ok) return message;
		return { ok: true, value: { action: value.action, message: message.value } };
	}
	return fail(configProblem("fake-step", `${label}.action is not a known fake step`));
}

export function parseLocalConfig(value: unknown): ParseResult<LocalConfig> {
	if (!isObject(value)) return fail(configProblem("type", "local config must be an object"));
	const unknown = rejectUnknownKeys(value, CONFIG_KEYS, "local config");
	if (!unknown.ok) return { ok: false, problem: configProblem(unknown.problem.code, unknown.problem.message) };
	if (!isObject(value.harness)) return fail(configProblem("harness", "local config.harness is required"));
	const harnessUnknown = rejectUnknownKeys(value.harness, HARNESS_KEYS, "harness");
	if (!harnessUnknown.ok) return { ok: false, problem: configProblem(harnessUnknown.problem.code, harnessUnknown.problem.message) };
	if (typeof value.harness.adapter !== "string" || !(HARNESS_ADAPTERS as readonly string[]).includes(value.harness.adapter)) {
		return fail(configProblem("adapter", "harness.adapter must be fake|grok"));
	}
	const config: LocalConfig = { harness: { adapter: value.harness.adapter as LocalConfig["harness"]["adapter"] } };
	if (value.harness.fake !== undefined) {
		if (!isObject(value.harness.fake)) return fail(configProblem("fake", "harness.fake must be an object"));
		const fakeUnknown = rejectUnknownKeys(value.harness.fake, FAKE_KEYS, "harness.fake");
		if (!fakeUnknown.ok) return { ok: false, problem: configProblem(fakeUnknown.problem.code, fakeUnknown.problem.message) };
		if (!Array.isArray(value.harness.fake.script)) return fail(configProblem("fake-script", "harness.fake.script must be an array"));
		const script: FakeStep[] = [];
		for (const [i, step] of value.harness.fake.script.entries()) {
			const parsed = parseFakeStep(step, i);
			if (!parsed.ok) return parsed;
			script.push(parsed.value);
		}
		config.harness.fake = { script };
	}
	if (value.harness.grok !== undefined) {
		if (!isObject(value.harness.grok)) return fail(configProblem("grok", "harness.grok must be an object"));
		const grokUnknown = rejectUnknownKeys(value.harness.grok, GROK_KEYS, "harness.grok");
		if (!grokUnknown.ok) return { ok: false, problem: configProblem(grokUnknown.problem.code, grokUnknown.problem.message) };
		const grok: { bin?: string; model?: string } = {};
		if (value.harness.grok.bin !== undefined) {
			const bin = parseString(value.harness.grok.bin, "harness.grok.bin", 1, Number.MAX_SAFE_INTEGER);
			if (!bin.ok) return bin;
			grok.bin = bin.value;
		}
		if (value.harness.grok.model !== undefined) {
			const model = parseString(value.harness.grok.model, "harness.grok.model", 1, Number.MAX_SAFE_INTEGER);
			if (!model.ok) return model;
			grok.model = model.value;
		}
		config.harness.grok = grok;
	}
	if (value.project !== undefined) {
		if (!isObject(value.project)) return fail(configProblem("project", "project must be an object"));
		const projectUnknown = rejectUnknownKeys(value.project, PROJECT_KEYS, "project");
		if (!projectUnknown.ok) return { ok: false, problem: configProblem(projectUnknown.problem.code, projectUnknown.problem.message) };
		config.project = {};
	}
	if (value.autopilot !== undefined) {
		if (!isObject(value.autopilot)) return fail(configProblem("autopilot", "autopilot must be an object"));
		const autoUnknown = rejectUnknownKeys(value.autopilot, AUTOPILOT_KEYS, "autopilot");
		if (!autoUnknown.ok) return { ok: false, problem: configProblem(autoUnknown.problem.code, autoUnknown.problem.message) };
		const autopilot: NonNullable<LocalConfig["autopilot"]> = {};
		if (value.autopilot.maxRepairs !== undefined) {
			if (!isNonNegativeInt(value.autopilot.maxRepairs) || value.autopilot.maxRepairs > 8) {
				return fail(configProblem("max-repairs", "autopilot.maxRepairs must be an integer 0..8"));
			}
			autopilot.maxRepairs = value.autopilot.maxRepairs;
		}
		if (value.autopilot.verification !== undefined) {
			if (!isObject(value.autopilot.verification)) return fail(configProblem("verification", "autopilot.verification must be an object"));
			const vUnknown = rejectUnknownKeys(value.autopilot.verification, VERIFICATION_KEYS, "autopilot.verification");
			if (!vUnknown.ok) return { ok: false, problem: configProblem(vUnknown.problem.code, vUnknown.problem.message) };
			if (value.autopilot.verification.command !== undefined) {
				const command = parseString(value.autopilot.verification.command, "autopilot.verification.command", 1, 1024);
				if (!command.ok) return command;
				autopilot.verification = { command: command.value };
			} else autopilot.verification = {};
		}
		config.autopilot = autopilot;
	}
	if (value.execution !== undefined) {
		if (!isObject(value.execution)) return fail(configProblem("execution", "execution must be an object"));
		const executionUnknown = rejectUnknownKeys(value.execution, EXECUTION_KEYS, "execution");
		if (!executionUnknown.ok) return { ok: false, problem: configProblem(executionUnknown.problem.code, executionUnknown.problem.message) };
		if (value.execution.mode !== undefined && (typeof value.execution.mode !== "string" || !(EXECUTION_MODES as readonly string[]).includes(value.execution.mode))) {
			return fail(configProblem("execution-mode", "execution.mode must be host|contained"));
		}
		config.execution = value.execution.mode === undefined ? {} : { mode: value.execution.mode as NonNullable<LocalConfig["execution"]>["mode"] };
	}
	if (value.effects !== undefined) {
		if (!isObject(value.effects)) return fail(configProblem("effects", "effects must be an object"));
		const effectsUnknown = rejectUnknownKeys(value.effects, EFFECTS_KEYS, "effects");
		if (!effectsUnknown.ok) return { ok: false, problem: configProblem(effectsUnknown.problem.code, effectsUnknown.problem.message) };
		if (value.effects.allow !== undefined) {
			if (!Array.isArray(value.effects.allow) || value.effects.allow.length !== 0) {
				return fail(configProblem("effects-denied", "effects.allow must be empty in v0; external effects are denied by default"));
			}
			config.effects = { allow: [] };
		} else config.effects = {};
	}
	return { ok: true, value: config };
}
