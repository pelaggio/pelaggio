/**
 * Polls a supervised run's flow-event segment and projects live `RunActivity`.
 * Isolated from LogBroker — stdout remains an operator log only (issue #83).
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { decodeFlowEventLine, eventStreamPath } from "pelaggio";
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
	/** Injectable file reader — defaults to fs offset reads. */
	readSlice?: (path: string, offset: number) => { data: string; eof: boolean };
}

export interface FlowEventTailer {
	start(): void;
	stop(): void;
	/** Process one poll tick (tests). */
	tick(): void;
}

function defaultReadSlice(path: string, offset: number): { data: string; eof: boolean } {
	if (!existsSync(path)) return { data: "", eof: true };
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		if (offset >= size) return { data: "", eof: true };
		const length = size - offset;
		const buf = Buffer.alloc(length);
		const n = readSync(fd, buf, 0, length, offset);
		return { data: buf.subarray(0, n).toString("utf8"), eof: true };
	} finally {
		closeSync(fd);
	}
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
	const readSlice = deps.readSlice ?? defaultReadSlice;
	const intervalMs = deps.intervalMs ?? 1000;
	let offset = 0;
	let pending = "";
	let timer: ReturnType<typeof setInterval> | null = null;
	let lastActivityKey = "";

	const emit = (activity: RunActivity): void => {
		const key = JSON.stringify(activity);
		if (key === lastActivityKey) return;
		lastActivityKey = key;
		deps.onActivity(activity);
	};

	const ingestLine = (line: string): void => {
		const event = decodeFlowEventLine(line); // fail closed: unparsable / non-v1 lines are dropped
		if (!event) return;
		if (!LIFECYCLE_TYPES.has(event.type)) return;
		if (event.executionId !== deps.executionId) return;
		const activity = projectRunActivity(event as unknown as Record<string, unknown>);
		if (activity) emit(activity);
	};

	const tick = (): void => {
		const { data } = readSlice(path, offset);
		if (!data) return;
		offset += Buffer.byteLength(data, "utf8");
		pending += data;
		let idx = pending.indexOf("\n");
		while (idx !== -1) {
			const line = pending.slice(0, idx);
			pending = pending.slice(idx + 1);
			ingestLine(line);
			idx = pending.indexOf("\n");
		}
		// Hold truncated final line in `pending` until the next newline.
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
