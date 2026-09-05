import { parseArtifact, parsePauseReason, parseWorkContract } from "./parse.js";
import { protocolProblem } from "./transport.js";
import type { Artifact, Disposition, ExecutionAssurance, PauseReason, Problem, RunEvent, RunSnapshot, RunState, WorkContract, WorktreeRef } from "./types.js";

export interface FoldedRun {
	snapshot: RunSnapshot;
	nextFakeIndex: number;
	acknowledgedSeq: number;
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
			if (typeof p.nextIndex === "number") nextFakeIndex = p.nextIndex;
		} else if (event.type === "pelaggio.local-autopilot.harness-finished") {
			harnessCalls += 1;
		} else if (event.type === "pelaggio.local-autopilot.verification-finished") {
			if (p.ok === true) verificationPasses += 1;
			if (p.artifact !== undefined) {
				const parsed = parseArtifact(p.artifact);
				if (!parsed.ok) throw new Error(parsed.problem.message);
				artifacts.push(parsed.value);
			}
		} else if (event.type === "pelaggio.local-autopilot.repair-attempted") {
			repairAttempts += 1;
		} else if (event.type === "pelaggio.local-autopilot.run-resumed") {
			if (state !== "paused") throw new Error(`cannot resume a ${state} run`);
			state = "running";
			pauseReason = undefined;
		} else if (event.type === "pelaggio.local-autopilot.run-paused") {
			if (state !== "running") throw new Error(`cannot pause a ${state} run`);
			state = "paused";
			const parsed = parsePauseReason(p.pauseReason);
			if (!parsed.ok) throw new Error(parsed.problem.message);
			pauseReason = parsed.value;
			if (parsed.value.problem) problems.push(parsed.value.problem);
		} else if (event.type === "pelaggio.local-autopilot.run-completed") {
			state = "completed";
			pauseReason = undefined;
			if (p.disposition === "ready_for_review" || p.disposition === "cancelled" || p.disposition === "failed" || p.disposition === "blocked" || p.disposition === "budget_exhausted") {
				disposition = p.disposition;
			} else {
				throw new Error("completed event missing disposition");
			}
		} else if (event.type === "pelaggio.local-autopilot.problem") {
			if (p.problem && typeof p.problem === "object") problems.push(p.problem as Problem);
		}
		if (typeof p.durationMs === "number") durationMs = p.durationMs;
		if (p.worktree) worktree = asWorktree(p.worktree) ?? worktree;
		if (typeof p.requestId === "string") requestId = p.requestId;
	}

	const last = events[events.length - 1];
	if (!last) throw new Error("journal is empty");
	const snapshot: RunSnapshot = {
		schemaVersion: 1,
		runId: started.runId,
		state,
		workContract,
		createdAt: started.at,
		updatedAt: last.at,
		execution,
		artifacts,
		problems,
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
		},
	};
	return { snapshot, nextFakeIndex, acknowledgedSeq: last.seq };
}

export function emptyJournalProblem(): ReturnType<typeof protocolProblem> {
	return protocolProblem("unknown-run", "run journal not found");
}
