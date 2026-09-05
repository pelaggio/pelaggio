import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ulid } from "ulid";
import { tryWithFileLock, withFileLock } from "../file-lock.js";
import { codexAdapter } from "./codex-adapter.js";
import { loadLocalConfig } from "./config-load.js";
import { resolveExecutionAssurance } from "./execution-policy.js";
import { fakeAdapter } from "./fake-adapter.js";
import { type ExecutionPhase, foldRunEvents } from "./fold.js";
import { grokAdapter } from "./grok-adapter.js";
import type { HarnessAdapter } from "./harness.js";
import { appendRunEvent, readRunEvents } from "./journal.js";
import { applyTransition } from "./lifecycle.js";
import { parseRunIdRequest, parseRunSnapshot, parseStartRunRequest } from "./parse.js";
import { requestIndexPath, requestLockPath, runDir } from "./paths.js";
import { runLocalProcess } from "./process.js";
import { containedPath, createRunWorktree } from "./run-worktree.js";
import { configProblem, conflictProblem, protocolProblem } from "./transport.js";
import type { Artifact, ExecutionAssurance, LocalConfig, ParseResult, PauseReason, Problem, RunEvent, RunSnapshot, WorkContract } from "./types.js";
import { buildWorkContract, digestOf } from "./work-contract.js";

export interface EngineDeps {
	allowHostExecution?: boolean;
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

async function withRunLease(cwd: string, runId: string, fn: () => Promise<ParseResult<RunSnapshot>> | ParseResult<RunSnapshot>): Promise<ParseResult<RunSnapshot>> {
	const lease = join(runDir(cwd, runId), "lease");
	const locked = await tryWithFileLock(lease, fn, { label: "local-autopilot run lease", staleMs: 30 * 60_000, reclaimStale: false });
	if (locked.ran) return locked.value;
	return {
		ok: false,
		problem: conflictProblem(
			"run-active",
			`run ${runId} is locked; its journal and worktree are preserved. Interrupt the active run before retrying. After a crash, verify its provider processes have stopped, remove ${lease}, then resume ${runId}.`,
		),
	};
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

async function runVerification(worktree: string, command: string, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
	const result = await runLocalProcess(command, [], worktree, signal, { shell: true });
	return { ok: result.ok, message: result.ok ? "verification passed" : result.output.slice(0, 2000) || "verification failed" };
}

function verificationArtifact(state: DriveState, ok: boolean, message: string): Artifact {
	const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: state.worktree, encoding: "utf8" }).trim();
	const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: state.worktree, encoding: "utf8" }).length > 0;
	const content = JSON.stringify({ schemaVersion: 1, runId: state.runId, ok, message, command: state.config.autopilot?.verification?.command, revision, dirty, at: nowIso(state.deps) });
	const digest = digestOf(content);
	const directory = join(runDir(state.cwd, state.runId), "artifacts");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `${digest.value}.json`);
	try {
		writeFileSync(path, content, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(path, "utf8") !== content) throw error;
	}
	return { kind: "verification", uri: pathToFileURL(path).href, mediaType: "application/json", digest };
}

interface DriveState {
	phase: ExecutionPhase;
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
	try {
		return await driveSteps(state);
	} catch (error) {
		return {
			ok: false,
			problem: { ...protocolProblem("run-execution", `${error instanceof Error ? error.message : String(error)}; preserved run ${state.runId} in ${state.worktree}; fix the cause and resume ${state.runId}`), runId: state.runId },
		};
	}
}

async function driveSteps(state: DriveState): Promise<ParseResult<RunSnapshot>> {
	const adapter = adaptersFor(state.deps)[state.config.harness.adapter];
	const maxRepairs = state.config.autopilot?.maxRepairs ?? 1;
	const verifyCommand = state.config.autopilot?.verification?.command as string;
	while (!state.deps.signal?.aborted) {
		if (state.phase.kind === "verification") {
			const verification = state.phase.forcedFailure === undefined ? await runVerification(state.worktree, verifyCommand, state.deps.signal) : { ok: false, message: state.phase.forcedFailure };
			if (state.deps.signal?.aborted) break;
			const artifact = verificationArtifact(state, verification.ok, verification.message);
			emit(state, "pelaggio.local-autopilot.verification-finished", { ...verification, artifact });
			state.phase = { kind: "verification-result", ...verification };
		}
		if (state.phase.kind === "verification-result") {
			const verification = state.phase;
			if (verification.ok) {
				emit(state, "pelaggio.local-autopilot.run-completed", { disposition: "ready_for_review", durationMs: Date.now() - state.startedAt });
				return snapshotOf(state.cwd, state.runId);
			}
			if (state.repairs < maxRepairs) {
				state.repairs += 1;
				state.verificationFailure = verification.message;
				emit(state, "pelaggio.local-autopilot.repair-attempted", { attempt: state.repairs, message: verification.message });
				state.phase = { kind: "harness" };
				continue;
			}
			const problem: Problem = { schemaVersion: 1, type: "verification", code: "verification-budget", message: verification.message, retryable: true, runId: state.runId };
			const pauseReason: PauseReason = { code: "verification_budget", message: verification.message, problem };
			emit(state, "pelaggio.local-autopilot.run-paused", { pauseReason, durationMs: Date.now() - state.startedAt });
			return snapshotOf(state.cwd, state.runId);
		}
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
		if (action.kind === "write") {
			const target = containedPath(state.worktree, action.path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, action.content);
			commitWorktree(state.worktree, `pelaggio: ${action.path}`);
			emit(state, "pelaggio.local-autopilot.fake-progress", { nextIndex: cursor });
			continue;
		}
		emit(state, "pelaggio.local-autopilot.fake-progress", { nextIndex: cursor });
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
			state.phase = { kind: "verification", ...(action.kind === "verify-fail" ? { forcedFailure: action.message } : {}) };
			emit(state, "pelaggio.local-autopilot.harness-finished", { ...(action.kind === "verify-fail" ? { forcedFailure: action.message } : {}) });
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
	const execution = resolveExecutionAssurance(cwd, config.value, input.allowHostExecution ?? false);
	if (!execution.ok) return execution;
	if (!config.value.autopilot?.verification?.command) {
		return { ok: false, problem: configProblem("missing-verification", "autopilot.verification.command is required before a run can become ready_for_review") };
	}
	if (config.value.harness.adapter === "fake" && !config.value.harness.fake?.script?.length) {
		return { ok: false, problem: configProblem("fake-script", "harness.fake.script is required for the fake adapter") };
	}
	const workContract = buildWorkContract(request.value.task, { now: nowIso(deps), readStdin: deps.readStdin });
	const runId = ulid();
	return withRunLease(cwd, runId, async () => {
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
					phase: { kind: "harness" },
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
		const prepared = request.value.requestId ? await withFileLock(requestLockPath(cwd, digestOf(request.value.requestId).value), prepare, { label: "local-autopilot request claim", staleMs: 30_000, acquireTimeoutMs: 5_000 }) : prepare();
		if (prepared.kind === "existing") return prepared.result;
		return drive(prepared.state);
	});
}

export async function continueRun(cwd: string, runId: string, deps: EngineDeps = {}): Promise<ParseResult<RunSnapshot>> {
	const request = parseRunIdRequest({ schemaVersion: 1, runId });
	if (!request.ok) return request;
	runId = request.value.runId;
	return withRunLease(cwd, runId, async () => {
		const current = snapshotOf(cwd, runId);
		if (!current.ok || current.value.state === "completed") return current;
		const config = loadLocalConfig(cwd);
		if (!config.ok) return config;
		const execution = resolveExecutionAssurance(cwd, config.value, deps.allowHostExecution ?? false);
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
			phase: current.value.pauseReason?.code === "verification_budget" ? { kind: "harness" } : folded.phase,
			verificationFailure: folded.verificationFailure,
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
	});
}

export async function cancelRun(cwd: string, runId: string, deps: EngineDeps = {}): Promise<ParseResult<RunSnapshot>> {
	const request = parseRunIdRequest({ schemaVersion: 1, runId });
	if (!request.ok) return request;
	runId = request.value.runId;
	return withRunLease(cwd, runId, () => {
		const current = snapshotOf(cwd, runId);
		if (!current.ok || current.value.state === "completed") return current;
		const events = readRunEvents(cwd, runId);
		const seq = events[events.length - 1]?.seq ?? 0;
		appendRunEvent(cwd, newEvent(runId, seq + 1, "pelaggio.local-autopilot.run-completed", nowIso(deps), { disposition: "cancelled" }));
		return snapshotOf(cwd, runId);
	});
}
