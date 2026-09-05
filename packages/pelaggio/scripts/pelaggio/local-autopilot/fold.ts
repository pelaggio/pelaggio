import type { HarnessAction } from "./harness.js";
import { isBlockingProblem } from "./lifecycle.js";
import { parseArtifact, parsePauseReason, parseProblem, parseWorkContract } from "./parse.js";
import { protocolProblem } from "./transport.js";
import type { Artifact, Disposition, ExecutionAssurance, PauseReason, Problem, RunEvent, RunSnapshot, RunState, WorkContract, WorktreeRef } from "./types.js";
import { localMetricsUsage } from "./usage.js";

type AcknowledgedAction = Exclude<HarnessAction, { kind: "write" }>;

export type ExecutionPhase = { kind: "action"; action: AcknowledgedAction } | { kind: "harness" } | { kind: "verification"; forcedFailure?: string } | { kind: "verification-result"; ok: boolean; message: string; forcedFailure?: string };

export interface FoldedRun {
	phase: ExecutionPhase;
	verificationFailure?: string;
	snapshot: RunSnapshot;
	nextFakeIndex: number;
	acknowledgedSeq: number;
}

function acknowledgedAction(value: unknown): AcknowledgedAction {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid acknowledged harness action");
	const candidate = value as Record<string, unknown>;
	if (candidate.kind === "complete") return { kind: "complete" };
	if ((candidate.kind === "crash" || candidate.kind === "verify-fail") && typeof candidate.message === "string") return { kind: candidate.kind, message: candidate.message };
	if (candidate.kind === "decision" && typeof candidate.code === "string" && typeof candidate.message === "string") return { kind: "decision", code: candidate.code, message: candidate.message };
	throw new Error("invalid acknowledged harness action");
}

function asWorktree(value: unknown): WorktreeRef | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const branch = (value as { branch?: unknown }).branch;
	if (typeof branch !== "string" || branch.length === 0) return undefined;
	const path = (value as { path?: unknown }).path;
	return { branch, ...(typeof path === "string" ? { path } : {}) };
}

function asExecution(value: unknown): ExecutionAssurance {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("run-started missing execution assurance");
	const candidate = value as Partial<ExecutionAssurance>;
	if (candidate.mode === "host" && candidate.contained === false && candidate.effectsEnforced === false) return { mode: "host", contained: false, effectsEnforced: false };
	if (candidate.mode === "contained" && candidate.contained === true && candidate.effectsEnforced === true) return { mode: "contained", contained: true, effectsEnforced: true };
	throw new Error("run-started has inconsistent execution assurance");
}

export function foldRunEvents(events: readonly RunEvent[]): FoldedRun {
	if (events.length === 0) throw new Error("journal is empty");
	const started = events[0];
	if (!started) throw new Error("journal is empty");
	if (started.type !== "pelaggio.local-autopilot.run-started") throw new Error("journal must begin with run-started");
	const payload = started.payload ?? {};
	const contract = parseWorkContract(payload.workContract);
	if (!contract.ok) throw new Error(contract.problem.message);
	const workContract: WorkContract = contract.value;
	let phase: ExecutionPhase = { kind: "harness" };
	let verificationFailure: string | undefined;
	let currentVerificationArtifact = false;
	let state: RunState = "queued";
	let pauseReason: PauseReason | undefined;
	let disposition: Disposition | undefined;
	const problems: Problem[] = [];
	let worktree = asWorktree(payload.worktree);
	const execution = asExecution(payload.execution);
	const artifacts: Artifact[] = [];
	let nextFakeIndex = 0;
	let durationMs = 0;
	let harnessCalls = 0;
	let verificationPasses = 0;
	let repairAttempts = 0;
	let requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;

	for (const [index, event] of events.entries()) {
		if (state === "completed") throw new Error(`journal event ${event.type} follows terminal completion`);
		const p = event.payload ?? {};
		if (event.type === "pelaggio.local-autopilot.run-started") {
			if (index !== 0) throw new Error("journal repeats run-started");
			state = "running";
		} else if (event.type === "pelaggio.local-autopilot.fake-progress") {
			if (state !== "running" || phase.kind !== "harness") throw new Error("harness progress outside the running harness phase");
			currentVerificationArtifact = false;
			if (typeof p.nextIndex === "number") nextFakeIndex = p.nextIndex;
			if (p.action !== undefined) phase = { kind: "action", action: acknowledgedAction(p.action) };
		} else if (event.type === "pelaggio.local-autopilot.harness-finished") {
			if (state !== "running" || !(phase.kind === "harness" || (phase.kind === "action" && (phase.action.kind === "complete" || phase.action.kind === "verify-fail")))) throw new Error("harness-finished outside the running harness phase");
			currentVerificationArtifact = false;
			harnessCalls += 1;
			phase = { kind: "verification", ...(typeof p.forcedFailure === "string" ? { forcedFailure: p.forcedFailure } : {}) };
		} else if (event.type === "pelaggio.local-autopilot.verification-finished") {
			if (state !== "running" || (phase.kind !== "verification" && phase.kind !== "verification-result")) throw new Error("verification-finished outside the running verification phase");
			if (typeof p.ok !== "boolean") throw new Error("verification-finished missing result");
			if (p.ok && (phase.forcedFailure !== undefined || p.forcedFailure !== undefined)) throw new Error("forced verification failure cannot become success");
			currentVerificationArtifact = false;
			const message = typeof p.message === "string" ? p.message : p.ok ? "verification passed" : "verification failed";
			phase = { kind: "verification-result", ok: p.ok, message, ...(typeof p.forcedFailure === "string" ? { forcedFailure: p.forcedFailure } : {}) };
			if (!p.ok) verificationFailure = message;
			if (p.ok === true) verificationPasses += 1;
			if (p.artifact !== undefined) {
				const parsed = parseArtifact(p.artifact);
				if (!parsed.ok) throw new Error(parsed.problem.message);
				artifacts.push(parsed.value);
				currentVerificationArtifact = parsed.value.kind === "verification";
			}
		} else if (event.type === "pelaggio.local-autopilot.repair-attempted") {
			if (state !== "running" || phase.kind !== "verification-result" || phase.ok) throw new Error("repair-attempted without a running failed verification");
			currentVerificationArtifact = false;
			repairAttempts += 1;
			phase = { kind: "harness" };
			if (typeof p.message === "string") verificationFailure = p.message;
		} else if (event.type === "pelaggio.local-autopilot.run-resumed") {
			if (state !== "paused") throw new Error(`cannot resume a ${state} run`);
			if (pauseReason?.code === "verification_budget" || pauseReason?.code === "decision_required") {
				phase = { kind: "harness" };
				currentVerificationArtifact = false;
			}
			state = "running";
			pauseReason = undefined;
		} else if (event.type === "pelaggio.local-autopilot.run-paused") {
			if (state !== "running") throw new Error(`cannot pause a ${state} run`);
			state = "paused";
			const parsed = parsePauseReason(p.pauseReason);
			if (!parsed.ok) throw new Error(parsed.problem.message);
			pauseReason = parsed.value;
		} else if (event.type === "pelaggio.local-autopilot.run-completed") {
			if (state !== "running" && !(state === "paused" && p.disposition === "cancelled")) throw new Error(`cannot complete a ${state} run without resuming it`);
			if (p.disposition === "ready_for_review" && (phase.kind !== "verification-result" || !phase.ok || !currentVerificationArtifact || isBlockingProblem({ problems })))
				throw new Error("ready_for_review requires successful current verification evidence and no unresolved blocking problems");
			state = "completed";
			pauseReason = undefined;
			if (p.disposition === "ready_for_review" || p.disposition === "cancelled" || p.disposition === "failed" || p.disposition === "blocked" || p.disposition === "budget_exhausted") {
				disposition = p.disposition;
			} else {
				throw new Error("completed event missing disposition");
			}
		} else if (event.type === "pelaggio.local-autopilot.problem") {
			const parsed = parseProblem(p.problem);
			if (!parsed.ok) throw new Error(parsed.problem.message);
			problems.push(parsed.value);
		}
		if (typeof p.durationMs === "number") durationMs = p.durationMs;
		if (p.worktree) worktree = asWorktree(p.worktree) ?? worktree;
		if (typeof p.requestId === "string") requestId = p.requestId;
	}

	const last = events[events.length - 1];
	if (!last) throw new Error("journal is empty");
	// Pause-reason problems are live only while paused; separately emitted problem events persist.
	const liveProblems = pauseReason?.problem ? [...problems, pauseReason.problem] : problems;
	const usage = localMetricsUsage(events);
	const snapshot: RunSnapshot = {
		schemaVersion: 1,
		runId: started.runId,
		state,
		workContract,
		createdAt: started.at,
		updatedAt: last.at,
		execution,
		artifacts,
		problems: liveProblems,
		...(requestId ? { requestId } : {}),
		...(pauseReason ? { pauseReason } : {}),
		...(disposition ? { disposition } : {}),
		...(worktree ? { worktree } : {}),
		metrics: {
			schemaVersion: 1,
			durationMs,
			harnessCalls,
			verificationPasses,
			repairAttempts,
			...(usage ? { usage } : {}),
		},
	};
	return { snapshot, nextFakeIndex, acknowledgedSeq: last.seq, phase, verificationFailure };
}

export function emptyJournalProblem(): ReturnType<typeof protocolProblem> {
	return protocolProblem("unknown-run", "run journal not found");
}
