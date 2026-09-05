import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "ulid";
import { tryWithFileLock, withFileLock } from "../file-lock.js";
import { codexAdapter } from "./codex-adapter.js";
import { loadLocalConfig } from "./config-load.js";
import { fakeAdapter } from "./fake-adapter.js";
import { foldRunEvents } from "./fold.js";
import { grokAdapter } from "./grok-adapter.js";
import type { HarnessAdapter } from "./harness.js";
import { appendRunEvent, readRunEvents } from "./journal.js";
import { applyTransition } from "./lifecycle.js";
import { parseRunIdRequest, parseRunSnapshot, parseStartRunRequest } from "./parse.js";
import { requestIndexPath, runDir } from "./paths.js";
import { containedPath, createRunWorktree } from "./run-worktree.js";
import { configProblem, conflictProblem, protocolProblem } from "./transport.js";
import type { Artifact, ExecutionAssurance, LocalConfig, ParseResult, PauseReason, Problem, RunEvent, RunSnapshot, WorkContract } from "./types.js";
import { buildWorkContract, digestOf } from "./work-contract.js";

export interface EngineDeps {
	now?: () => string;
	adapters?: Partial<Record<LocalConfig["harness"]["adapter"], HarnessAdapter>>;
	readStdin?: () => string;
	signal?: AbortSignal;
}

const defaultAdapters = { fake: fakeAdapter, grok: grokAdapter, codex: codexAdapter };

function nowIso(deps: EngineDeps): string {
	return deps.now?.() ?? new Date().toISOString();
}

function newEvent(runId: string, seq: number, type: string, at: string, payload?: Record<string, unknown>): RunEvent {
	return { schemaVersion: 1, eventId: ulid(), runId, seq, type, at, ...(payload ? { payload } : {}) };
}

function snapshotOf(cwd: string, runId: string): ParseResult<RunSnapshot> {
	try {
		const events = readRunEvents(cwd, runId);
		if (events.length === 0) return { ok: false, problem: protocolProblem("unknown-run", `run ${runId} not found`) };
		const folded = foldRunEvents(events);
		return parseRunSnapshot(folded.snapshot);
	} catch (error) {
		return { ok: false, problem: protocolProblem("journal-invalid", error instanceof Error ? error.message : String(error)) };
	}
}

function adaptersFor(deps: EngineDeps): Record<LocalConfig["harness"]["adapter"], HarnessAdapter> {
	return { ...defaultAdapters, ...deps.adapters };
}

export function getRun(cwd: string, runId: string): ParseResult<RunSnapshot> {
	const request = parseRunIdRequest({ schemaVersion: 1, runId });
	return request.ok ? snapshotOf(cwd, request.value.runId) : request;
}

function commitWorktree(worktree: string, message: string): void {
	execFileSync("git", ["add", "-A"], { cwd: worktree, encoding: "utf8" });
	const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" }).trim();
	if (!dirty) return;
	execFileSync("git", ["commit", "-m", message, "--no-verify"], { cwd: worktree, encoding: "utf8" });
}

function runVerification(worktree: string, command: string): { ok: boolean; message: string } {
	try {
		execSync(command, { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, message: "verification passed" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, message: message.slice(0, 2000) };
	}
}

function verificationArtifact(runId: string, ok: boolean, message: string): Artifact {
	return {
		kind: "verification",
		uri: `pelaggio:run/${runId}/verification`,
		mediaType: "application/json",
		digest: digestOf(JSON.stringify({ ok, message })),
	};
}

function executionAssurance(config: LocalConfig, allowHostExecution: boolean): ParseResult<ExecutionAssurance> {
	if (config.execution?.mode === "host" || allowHostExecution) {
		return { ok: true, value: { mode: "host", contained: false, effectsEnforced: false } };
	}
	return {
		ok: false,
		problem: configProblem("contained-unavailable", "contained harness execution is not available in this preview; pass --allow-host-execution or set execution.mode: host in uncommitted local policy"),
	};
}

interface DriveState {
	cwd: string;
	runId: string;
	seq: number;
	cursor: number;
	repairs: number;
	startedAt: number;
	worktree: string;
	workContract: WorkContract;
	config: LocalConfig;
	execution: ExecutionAssurance;
	deps: EngineDeps;
	nonInteractive: boolean;
	verificationFailure?: string;
}

function emit(state: DriveState, type: string, payload?: Record<string, unknown>): void {
	state.seq += 1;
	appendRunEvent(state.cwd, newEvent(state.runId, state.seq, type, nowIso(state.deps), payload));
}

async function drive(state: DriveState): Promise<ParseResult<RunSnapshot>> {
	const adapter = adaptersFor(state.deps)[state.config.harness.adapter];
	const maxRepairs = state.config.autopilot?.maxRepairs ?? 1;
	const verifyCommand = state.config.autopilot?.verification?.command as string;
	while (!state.deps.signal?.aborted) {
		const { action, cursor } = await adapter.next({
			cwd: state.cwd,
			worktree: state.worktree,
			workContract: state.workContract,
			config: state.config,
			nonInteractive: state.nonInteractive,
			signal: state.deps.signal,
			verificationFailure: state.verificationFailure,
			cursor: state.cursor,
		});
		if (state.deps.signal?.aborted) break;
		state.cursor = cursor;
		emit(state, "pelaggio.local-autopilot.fake-progress", { nextIndex: cursor });
		if (action.kind === "write") {
			const target = containedPath(state.worktree, action.path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, action.content);
			commitWorktree(state.worktree, `pelaggio: ${action.path}`);
			continue;
		}
		if (action.kind === "decision") {
			const problem: Problem = { schemaVersion: 1, type: "decision", code: action.code, message: action.message, retryable: true, runId: state.runId };
			const pauseReason: PauseReason = { code: "decision_required", message: action.message, problem };
			emit(state, "pelaggio.local-autopilot.run-paused", { pauseReason, durationMs: Date.now() - state.startedAt });
			return snapshotOf(state.cwd, state.runId);
		}
		if (action.kind === "crash") {
			const problem: Problem = { schemaVersion: 1, type: "harness", code: "harness-failed", message: action.message, retryable: false, runId: state.runId };
			emit(state, "pelaggio.local-autopilot.problem", { problem });
			emit(state, "pelaggio.local-autopilot.run-completed", { disposition: "failed", durationMs: Date.now() - state.startedAt });
			return snapshotOf(state.cwd, state.runId);
		}
		if (action.kind === "verify-fail" || action.kind === "complete") {
			emit(state, "pelaggio.local-autopilot.harness-finished", {});
			const verification = action.kind === "verify-fail" ? { ok: false, message: action.message } : runVerification(state.worktree, verifyCommand);
			const artifact = verificationArtifact(state.runId, verification.ok, verification.message);
			emit(state, "pelaggio.local-autopilot.verification-finished", { ok: verification.ok, artifact });
			if (verification.ok) {
				emit(state, "pelaggio.local-autopilot.run-completed", { disposition: "ready_for_review", durationMs: Date.now() - state.startedAt });
				return snapshotOf(state.cwd, state.runId);
			}
			if (state.repairs < maxRepairs) {
				state.repairs += 1;
				state.verificationFailure = verification.message;
				emit(state, "pelaggio.local-autopilot.repair-attempted", { attempt: state.repairs });
				continue;
			}
			const problem: Problem = { schemaVersion: 1, type: "verification", code: "verification-budget", message: verification.message, retryable: true, runId: state.runId };
			const pauseReason: PauseReason = { code: "verification_budget", message: verification.message, problem };
			emit(state, "pelaggio.local-autopilot.run-paused", { pauseReason, durationMs: Date.now() - state.startedAt });
			return snapshotOf(state.cwd, state.runId);
		}
	}
	const problem: Problem = { schemaVersion: 1, type: "protocol", code: "interrupted", message: "run interrupted", retryable: true, runId: state.runId };
	const pauseReason: PauseReason = { code: "interrupted", message: "run interrupted", problem };
	emit(state, "pelaggio.local-autopilot.checkpointed", {});
	emit(state, "pelaggio.local-autopilot.run-paused", { pauseReason, durationMs: Date.now() - state.startedAt });
	return snapshotOf(state.cwd, state.runId);
}

export async function startRun(
	cwd: string,
	input: { task: { text: string } | { file: string } | { stdin: true }; requestId?: string; nonInteractive: boolean; allowHostExecution?: boolean },
	deps: EngineDeps = {},
): Promise<ParseResult<RunSnapshot>> {
	const request = parseStartRunRequest({ schemaVersion: 1, task: input.task, requestId: input.requestId, nonInteractive: input.nonInteractive });
	if (!request.ok) return request;
	const config = loadLocalConfig(cwd);
	if (!config.ok) return config;
	const execution = executionAssurance(config.value, input.allowHostExecution ?? false);
	if (!execution.ok) return execution;
	if (!config.value.autopilot?.verification?.command) {
		return { ok: false, problem: configProblem("missing-verification", "autopilot.verification.command is required before a run can become ready_for_review") };
	}
	if (config.value.harness.adapter === "fake" && !config.value.harness.fake?.script?.length) {
		return { ok: false, problem: configProblem("fake-script", "harness.fake.script is required for the fake adapter") };
	}
	const workContract = buildWorkContract(request.value.task, { now: nowIso(deps), readStdin: deps.readStdin });
	type Prepared = { kind: "existing"; result: ParseResult<RunSnapshot> } | { kind: "new"; state: DriveState };
	const prepare = (): Prepared => {
		if (request.value.requestId) {
			try {
				const existing = JSON.parse(readFileSync(requestIndexPath(cwd, request.value.requestId), "utf8")) as { runId: string; digest: string };
				if (existing.digest === workContract.digest.value) return { kind: "existing", result: getRun(cwd, existing.runId) };
				return { kind: "existing", result: { ok: false, problem: conflictProblem("request-conflict", `requestId ${request.value.requestId} already names a different work contract`) } };
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
		}
		const runId = ulid();
		mkdirSync(runDir(cwd, runId), { recursive: true });
		const worktree = createRunWorktree(cwd, runId);
		appendRunEvent(
			cwd,
			newEvent(runId, 0, "pelaggio.local-autopilot.run-started", nowIso(deps), {
				requestId: request.value.requestId,
				workContract,
				worktree,
				execution: execution.value,
			}),
		);
		if (request.value.requestId) {
			mkdirSync(dirname(requestIndexPath(cwd, request.value.requestId)), { recursive: true });
			writeFileSync(requestIndexPath(cwd, request.value.requestId), JSON.stringify({ runId, digest: workContract.digest.value }), { flag: "wx" });
		}
		return {
			kind: "new",
			state: {
				cwd,
				runId,
				seq: 0,
				cursor: 0,
				repairs: 0,
				startedAt: Date.now(),
				worktree: worktree.path,
				workContract,
				config: config.value,
				execution: execution.value,
				deps,
				nonInteractive: request.value.nonInteractive,
			},
		};
	};
	const prepared = request.value.requestId
		? await withFileLock(requestIndexPath(cwd, `lock-${digestOf(request.value.requestId).value}`), prepare, { label: "local-autopilot request claim", staleMs: 30_000, acquireTimeoutMs: 5_000 })
		: prepare();
	if (prepared.kind === "existing") return prepared.result;
	const state = prepared.state;
	const runId = state.runId;
	return withFileLock(join(runDir(cwd, runId), "lease"), () => drive(state), { label: "local-autopilot run lease", staleMs: 30 * 60_000, acquireTimeoutMs: 5_000 });
}

export async function continueRun(cwd: string, runId: string, deps: EngineDeps = {}): Promise<ParseResult<RunSnapshot>> {
	const request = parseRunIdRequest({ schemaVersion: 1, runId });
	if (!request.ok) return request;
	runId = request.value.runId;
	return withFileLock(
		join(runDir(cwd, runId), "lease"),
		async () => {
			const current = snapshotOf(cwd, runId);
			if (!current.ok || current.value.state === "completed") return current;
			const config = loadLocalConfig(cwd);
			if (!config.ok) return config;
			const execution = executionAssurance(config.value, current.value.execution.mode === "host");
			if (!execution.ok) return execution;
			if (!config.value.autopilot?.verification?.command) return { ok: false, problem: configProblem("missing-verification", "autopilot.verification.command is required to resume") };
			const events = readRunEvents(cwd, runId);
			const folded = foldRunEvents(events);
			let seq = folded.acknowledgedSeq;
			if (current.value.state === "paused") {
				const resumed = applyTransition(current.value, "continue", { updatedAt: nowIso(deps) });
				if (!resumed.ok) return resumed;
				seq += 1;
				appendRunEvent(cwd, newEvent(runId, seq, "pelaggio.local-autopilot.run-resumed", nowIso(deps)));
			}
			const worktree = current.value.worktree?.path;
			if (!worktree) return { ok: false, problem: protocolProblem("worktree", "run has no worktree path to resume") };
			return drive({
				cwd,
				runId,
				seq,
				cursor: folded.nextFakeIndex,
				repairs: current.value.metrics?.repairAttempts ?? 0,
				startedAt: Date.now(),
				worktree,
				workContract: current.value.workContract,
				config: config.value,
				execution: execution.value,
				deps,
				nonInteractive: true,
			});
		},
		{ label: "local-autopilot run lease", staleMs: 30 * 60_000, acquireTimeoutMs: 5_000 },
	);
}

export async function cancelRun(cwd: string, runId: string, deps: EngineDeps = {}): Promise<ParseResult<RunSnapshot>> {
	const request = parseRunIdRequest({ schemaVersion: 1, runId });
	if (!request.ok) return request;
	runId = request.value.runId;
	const locked = await tryWithFileLock(
		join(runDir(cwd, runId), "lease"),
		() => {
			const current = snapshotOf(cwd, runId);
			if (!current.ok || current.value.state === "completed") return current;
			const events = readRunEvents(cwd, runId);
			const seq = events[events.length - 1]?.seq ?? 0;
			appendRunEvent(cwd, newEvent(runId, seq + 1, "pelaggio.local-autopilot.run-completed", nowIso(deps), { disposition: "cancelled" }));
			return snapshotOf(cwd, runId);
		},
		{ label: "local-autopilot run lease", staleMs: 30 * 60_000 },
	);
	if (!locked.ran) return { ok: false, problem: conflictProblem("run-active", `run ${runId} is active; interrupt it before cancelling`) };
	return locked.value;
}
