import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "ulid";
import { withFileLock } from "../file-lock.js";
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
import type { LocalConfig, ParseResult, PauseReason, Problem, RunEvent, RunSnapshot, WorkContract } from "./types.js";
import { buildWorkContract } from "./work-contract.js";

export interface EngineDeps {
	now?: () => string;
	adapters?: Record<LocalConfig["harness"]["adapter"], HarnessAdapter>;
	readStdin?: () => string;
	signal?: AbortSignal;
}

const defaultAdapters = { fake: fakeAdapter, grok: grokAdapter };

function nowIso(deps: EngineDeps): string {
	return deps.now?.() ?? new Date().toISOString();
}

function newEvent(runId: string, seq: number, type: string, at: string, payload?: Record<string, unknown>): RunEvent {
	return { schemaVersion: 1, eventId: ulid(), runId, seq, type, at, ...(payload ? { payload } : {}) };
}

function snapshotOf(cwd: string, runId: string): ParseResult<RunSnapshot> {
	const events = readRunEvents(cwd, runId);
	if (events.length === 0) return { ok: false, problem: protocolProblem("unknown-run", `run ${runId} not found`) };
	const folded = foldRunEvents(events);
	return parseRunSnapshot(folded.snapshot);
}

function adaptersFor(deps: EngineDeps): Record<LocalConfig["harness"]["adapter"], HarnessAdapter> {
	return deps.adapters ?? defaultAdapters;
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

function runVerification(worktree: string, command: string | undefined): { ok: boolean; message: string } {
	if (!command) return { ok: true, message: "no verification command configured" };
	try {
		execSync(command, { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, message: "verification passed" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, message: message.slice(0, 2000) };
	}
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
	deps: EngineDeps;
}

function emit(state: DriveState, type: string, payload?: Record<string, unknown>): void {
	state.seq += 1;
	appendRunEvent(state.cwd, newEvent(state.runId, state.seq, type, nowIso(state.deps), payload));
}

async function drive(state: DriveState): Promise<ParseResult<RunSnapshot>> {
	const adapter = adaptersFor(state.deps)[state.config.harness.adapter];
	const maxRepairs = state.config.autopilot?.maxRepairs ?? 1;
	const verifyCommand = state.config.autopilot?.verification?.command;
	while (!state.deps.signal?.aborted) {
		const { action, cursor } = await adapter.next({
			cwd: state.cwd,
			worktree: state.worktree,
			workContract: state.workContract,
			config: state.config,
			cursor: state.cursor,
		});
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
			emit(state, "pelaggio.local-autopilot.verification-finished", { ok: verification.ok });
			if (verification.ok) {
				emit(state, "pelaggio.local-autopilot.run-completed", { disposition: "ready_for_review", durationMs: Date.now() - state.startedAt });
				return snapshotOf(state.cwd, state.runId);
			}
			if (state.repairs < maxRepairs) {
				state.repairs += 1;
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

export async function startRun(cwd: string, input: { task: { text: string } | { file: string } | { stdin: true }; requestId?: string; nonInteractive: boolean }, deps: EngineDeps = {}): Promise<ParseResult<RunSnapshot>> {
	const request = parseStartRunRequest({ schemaVersion: 1, ...input });
	if (!request.ok) return request;
	const config = loadLocalConfig(cwd);
	if (!config.ok) return config;
	if (config.value.harness.adapter === "fake" && !config.value.harness.fake?.script?.length) {
		return { ok: false, problem: configProblem("fake-script", "harness.fake.script is required for the fake adapter") };
	}
	const workContract = buildWorkContract(request.value.task, { now: nowIso(deps), readStdin: deps.readStdin });
	if (request.value.requestId) {
		try {
			const existing = JSON.parse(readFileSync(requestIndexPath(cwd, request.value.requestId), "utf8")) as { runId: string; digest: string };
			if (existing.digest === workContract.digest.value) return getRun(cwd, existing.runId);
			return { ok: false, problem: conflictProblem("request-conflict", `requestId ${request.value.requestId} already names a different work contract`) };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}
	const runId = ulid();
	mkdirSync(runDir(cwd, runId), { recursive: true });
	if (request.value.requestId) {
		mkdirSync(dirname(requestIndexPath(cwd, request.value.requestId)), { recursive: true });
		writeFileSync(requestIndexPath(cwd, request.value.requestId), JSON.stringify({ runId, digest: workContract.digest.value }));
	}
	const worktree = createRunWorktree(cwd, runId);
	appendRunEvent(
		cwd,
		newEvent(runId, 0, "pelaggio.local-autopilot.run-started", nowIso(deps), {
			requestId: request.value.requestId,
			workContract,
			worktree,
		}),
	);
	const state: DriveState = {
		cwd,
		runId,
		seq: 0,
		cursor: 0,
		repairs: 0,
		startedAt: Date.now(),
		worktree: worktree.path,
		workContract,
		config: config.value,
		deps,
	};
	return withFileLock(join(runDir(cwd, runId), "lease"), () => drive(state), { label: "local-autopilot run lease", staleMs: 30 * 60_000, acquireTimeoutMs: 5_000 });
}

export async function continueRun(cwd: string, runId: string, deps: EngineDeps = {}): Promise<ParseResult<RunSnapshot>> {
	const request = parseRunIdRequest({ schemaVersion: 1, runId });
	if (!request.ok) return request;
	runId = request.value.runId;
	const current = snapshotOf(cwd, runId);
	if (!current.ok) return current;
	if (current.value.state === "completed") return current;
	const config = loadLocalConfig(cwd);
	if (!config.ok) return config;
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
	const state: DriveState = {
		cwd,
		runId,
		seq,
		cursor: folded.nextFakeIndex,
		repairs: current.value.metrics?.repairAttempts ?? 0,
		startedAt: Date.now(),
		worktree,
		workContract: current.value.workContract,
		config: config.value,
		deps,
	};
	return withFileLock(join(runDir(cwd, runId), "lease"), () => drive(state), { label: "local-autopilot run lease", staleMs: 30 * 60_000, acquireTimeoutMs: 5_000 });
}

export async function cancelRun(cwd: string, runId: string, deps: EngineDeps = {}): Promise<ParseResult<RunSnapshot>> {
	const request = parseRunIdRequest({ schemaVersion: 1, runId });
	if (!request.ok) return request;
	runId = request.value.runId;
	const current = snapshotOf(cwd, runId);
	if (!current.ok) return current;
	if (current.value.state === "completed") return current;
	const events = readRunEvents(cwd, runId);
	const seq = events[events.length - 1]?.seq ?? 0;
	appendRunEvent(cwd, newEvent(runId, seq + 1, "pelaggio.local-autopilot.run-completed", nowIso(deps), { disposition: "cancelled" }));
	return snapshotOf(cwd, runId);
}
