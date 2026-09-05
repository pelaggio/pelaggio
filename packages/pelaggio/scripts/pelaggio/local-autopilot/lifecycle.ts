import { protocolProblem } from "./transport.js";
import type { Disposition, LifecycleEvent, ParseResult, RunSnapshot, RunState } from "./types.js";

const TRANSITIONS: Readonly<Record<RunState, Readonly<Partial<Record<LifecycleEvent, RunState>>>>> = {
	queued: { start: "running", cancel: "completed" },
	running: { pause: "paused", complete: "completed", cancel: "completed" },
	paused: { continue: "running", cancel: "completed" },
	completed: {},
};

const TERMINAL_DISPOSITION_FOR: Readonly<Partial<Record<LifecycleEvent, Disposition>>> = {
	cancel: "cancelled",
};

export function canTransition(from: RunState, event: LifecycleEvent): boolean {
	return TRANSITIONS[from][event] !== undefined;
}

export function nextState(from: RunState, event: LifecycleEvent): ParseResult<RunState> {
	const to = TRANSITIONS[from][event];
	if (!to) return { ok: false, problem: protocolProblem("illegal-transition", `cannot ${event} a ${from} run`) };
	return { ok: true, value: to };
}

export function isBlockingProblem(snapshot: Pick<RunSnapshot, "problems">): boolean {
	return snapshot.problems.some((problem) => problem.type === "decision" || problem.type === "verification" || problem.type === "harness" || problem.type === "config");
}

export function assertSnapshotInvariants(snapshot: RunSnapshot): ParseResult<RunSnapshot> {
	if (snapshot.state === "paused") {
		if (!snapshot.pauseReason) return { ok: false, problem: protocolProblem("pause-reason", "paused snapshots require pauseReason") };
		if (snapshot.disposition) return { ok: false, problem: protocolProblem("disposition", "paused snapshots must not carry a disposition") };
	} else if (snapshot.pauseReason) {
		return { ok: false, problem: protocolProblem("pause-reason", "pauseReason is only valid when state is paused") };
	}

	if (snapshot.state === "completed") {
		if (!snapshot.disposition) return { ok: false, problem: protocolProblem("disposition", "completed snapshots require a disposition") };
		if (snapshot.disposition === "ready_for_review" && isBlockingProblem(snapshot)) {
			return { ok: false, problem: protocolProblem("readiness", "ready_for_review is invalid while a blocking finding is open") };
		}
		if (snapshot.disposition === "ready_for_review" && !snapshot.artifacts.some((artifact) => artifact.kind === "verification")) {
			return { ok: false, problem: protocolProblem("readiness", "ready_for_review requires a verification artifact") };
		}
	} else if (snapshot.disposition) {
		return { ok: false, problem: protocolProblem("disposition", "disposition is only valid when state is completed") };
	}

	return { ok: true, value: snapshot };
}

export function applyTransition(
	snapshot: RunSnapshot,
	event: LifecycleEvent,
	update: { updatedAt: string; pauseReason?: RunSnapshot["pauseReason"]; disposition?: Disposition; problems?: RunSnapshot["problems"] },
): ParseResult<RunSnapshot> {
	const next = nextState(snapshot.state, event);
	if (!next.ok) return next;
	// Forced terminals (cancel → cancelled) win over an optional override.
	const disposition = next.value === "completed" ? (TERMINAL_DISPOSITION_FOR[event] ?? update.disposition) : undefined;
	const pauseReason = next.value === "paused" ? update.pauseReason : undefined;
	if (next.value === "paused" && !pauseReason) {
		return { ok: false, problem: protocolProblem("pause-reason", "pausing requires a pauseReason") };
	}
	if (next.value === "completed" && !disposition) {
		return { ok: false, problem: protocolProblem("disposition", "completing requires a disposition") };
	}
	const candidate: RunSnapshot = {
		...snapshot,
		state: next.value,
		updatedAt: update.updatedAt,
		problems: update.problems ?? snapshot.problems,
		...(pauseReason ? { pauseReason } : { pauseReason: undefined }),
		...(disposition ? { disposition } : { disposition: undefined }),
	};
	if (!pauseReason) delete candidate.pauseReason;
	if (!disposition) delete candidate.disposition;
	return assertSnapshotInvariants(candidate);
}
