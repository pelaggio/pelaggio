/**
 * Polls a supervised run's flow-event segment and projects live `RunActivity`.
 * Isolated from LogBroker — stdout remains an operator log only (issue #83).
 */

import { eventStreamPath, type ReadEventStreamSlice, tailEventStream } from "pelaggio";
import type { RunActivity } from "./types.js";

const LIFECYCLE_TYPES = new Set(["pelaggio.watch-idle", "pelaggio.watch-wake", "pelaggio.budget-idle", "pelaggio.budget-wake", "pelaggio.suspended", "pelaggio.resumed"]);

export interface FlowEventTailerDeps {
	runId: string;
	cwd: string;
	executionId: string;
	onActivity: (activity: RunActivity) => void;
	/** Poll interval in ms (default 1000). Injectable for tests. */
	intervalMs?: number;
	/** Clock for tests. */
	now?: () => number;
	/** Injectable slice reader — defaults to the package's fs offset reads. */
	readSlice?: ReadEventStreamSlice;
}

export interface FlowEventTailer {
	start(): void;
	stop(): void;
	/** Process one poll tick (tests). */
	tick(): void;
}

function _isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function projectRunActivity(event: Record<string, unknown>): RunActivity | null {
	const type = event.type;
	if (type === "pelaggio.watch-idle") {
		const probeAt = event.probeAt;
		if (typeof probeAt !== "string") return null;
		return { kind: "watch-idle", probeAt };
	}
	if (type === "pelaggio.watch-wake" || type === "pelaggio.budget-wake" || type === "pelaggio.resumed") {
		return { kind: "active" };
	}
	if (type === "pelaggio.budget-idle") {
		const resumeAt = event.resumeAt;
		const budget = event.budget;
		const spent = event.spent;
		if (typeof resumeAt !== "string" || typeof budget !== "number" || typeof spent !== "number") return null;
		return { kind: "budget-idle", resumeAt, budget, spent };
	}
	if (type === "pelaggio.suspended") {
		const resumeAt = typeof event.resumeAt === "string" ? event.resumeAt : undefined;
		const reason = typeof event.reason === "string" ? event.reason : undefined;
		return { kind: "parked", ...(resumeAt ? { resumeAt } : {}), ...(reason ? { reason } : {}) };
	}
	return null;
}

export function createFlowEventTailer(deps: FlowEventTailerDeps): FlowEventTailer {
	const path = eventStreamPath(deps.cwd, deps.runId);
	const intervalMs = deps.intervalMs ?? 1000;
	const tail = tailEventStream(path, { readSlice: deps.readSlice });
	let timer: ReturnType<typeof setInterval> | null = null;
	let lastActivityKey = "";

	const emit = (activity: RunActivity): void => {
		const key = JSON.stringify(activity);
		if (key === lastActivityKey) return;
		lastActivityKey = key;
		deps.onActivity(activity);
	};

	const tick = (): void => {
		for (const event of tail.next()) {
			if (!LIFECYCLE_TYPES.has(event.type)) continue;
			if (event.executionId !== deps.executionId) continue;
			const activity = projectRunActivity(event as unknown as Record<string, unknown>);
			if (activity) emit(activity);
		}
	};

	return {
		start() {
			if (timer) return;
			tick();
			timer = setInterval(tick, intervalMs);
			// Unref so the timer alone cannot keep a test process alive.
			if (typeof timer === "object" && timer !== null && "unref" in timer) {
				(timer as NodeJS.Timeout).unref();
			}
		},
		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},
		tick,
	};
}
