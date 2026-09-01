/**
 * On-demand projection of CLI/agent-launched pelaggio processes for GET /runs.
 * Not supervisor state: missing files, malformed lines, and racy reads skip that
 * repo rather than failing the list.
 */

import { decodeCycleOutcome, type FlowEvent, type LegacyCycleCompletedEvent, type RunFinishedEvent, type RunStartedEvent, readEventLog } from "pelaggio";
import { projectRunActivity } from "./flow-event-tailer.js";
import type { Registry } from "./registry.js";
import type { ContinuousMode, PersistedRun, RunActivity, RunStatus, RunSummary } from "./types.js";

const LIFECYCLE_AND_ACTIVITY = new Set([
	"pelaggio.run-started",
	"pelaggio.run-heartbeat",
	"pelaggio.run-finished",
	"pelaggio.watch-idle",
	"pelaggio.watch-wake",
	"pelaggio.budget-idle",
	"pelaggio.budget-wake",
	"pelaggio.suspended",
	"pelaggio.resumed",
]);

const WATCH_EVIDENCE = new Set(["pelaggio.watch-idle", "pelaggio.watch-wake", "pelaggio.budget-idle", "pelaggio.budget-wake"]);

/** Fallback when a lifecycle group has heartbeats but no `run-started`. Matches `RUN_HEARTBEAT_MS`. */
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_STALE_INTERVALS = 3;
const LEGACY_LIVE_WINDOW_MS = 15 * 60 * 1000;

export function listExternalRuns(opts: { registry: Registry; supervised: readonly PersistedRun[]; now?: () => number; repo?: string; staleHeartbeatIntervals?: number }): RunSummary[] {
	const now = opts.now ?? Date.now;
	const staleHeartbeatIntervals = opts.staleHeartbeatIntervals ?? DEFAULT_STALE_INTERVALS;
	const entries = opts.repo !== undefined ? opts.registry.entries().filter((entry) => entry.slug === opts.repo) : opts.registry.entries();
	const summaries: RunSummary[] = [];
	for (const entry of entries) {
		let events: FlowEvent[];
		try {
			events = readEventLog({ root: entry.path }).events;
		} catch {
			continue;
		}
		summaries.push(...projectRepo(entry.slug, events, opts.supervised, now(), staleHeartbeatIntervals));
	}
	return summaries;
}

function projectRepo(slug: string, events: readonly FlowEvent[], supervised: readonly PersistedRun[], nowMs: number, staleHeartbeatIntervals: number): RunSummary[] {
	const supervisedForRepo = supervised.filter((run) => run.repo === slug);
	const supervisedIds = new Set(supervisedForRepo.map((run) => run.id));
	const groups = new Map<string, FlowEvent[]>();
	const cycles: LegacyCycleCompletedEvent[] = [];
	for (const event of events) {
		if (isLegacyCycle(event)) {
			cycles.push(event);
			continue;
		}
		if (LIFECYCLE_AND_ACTIVITY.has(event.type)) {
			const list = groups.get(event.executionId) ?? [];
			list.push(event);
			groups.set(event.executionId, list);
		}
	}

	const intervals: Array<{ start: string; end: string; item: string }> = [];
	const rows: RunSummary[] = [];
	for (const [executionId, groupEvents] of groups) {
		const projected = projectLifecycleGroup(slug, executionId, groupEvents, nowMs, staleHeartbeatIntervals);
		if (!projected) continue;
		if (projected.coverCycles && projected.item !== undefined) {
			intervals.push({ start: projected.startedAt, end: projected.endedAt ?? projected.lastEventTs, item: projected.item });
		}
		if (supervisedIds.has(executionId) || !projected.row) continue;
		rows.push(projected.row);
	}

	const nowIso = new Date(nowMs).toISOString();
	for (const cycle of cycles) {
		if (shouldSuppressCycle(cycle, intervals, supervisedForRepo, nowIso)) continue;
		rows.push(projectCycle(slug, cycle));
	}
	return rows;
}

function projectLifecycleGroup(
	slug: string,
	executionId: string,
	groupEvents: readonly FlowEvent[],
	nowMs: number,
	staleHeartbeatIntervals: number,
): { startedAt: string; lastEventTs: string; endedAt?: string; item?: string; coverCycles: boolean; row?: RunSummary } | null {
	const first = groupEvents[0];
	const last = groupEvents[groupEvents.length - 1];
	if (!first || !last) return null;
	const startEvent = groupEvents.find(isRunStarted);
	const finishEvent = groupEvents.find(isRunFinished);
	const hasHeartbeat = groupEvents.some((event) => event.type === "pelaggio.run-heartbeat");
	const lastEventTs = last.ts;
	const startedAt = startEvent?.ts ?? first.ts;
	const itemId = startEvent?.itemId ?? first.itemId;
	const item = typeof itemId === "string" ? itemId : undefined;
	const mode = startEvent?.mode;
	const activity = foldActivity(groupEvents);
	const extras: Pick<RunSummary, "item" | "mode" | "activity"> = {
		...(item !== undefined ? { item } : {}),
		...(mode ? { mode } : {}),
		...(activity ? { activity } : {}),
	};
	const hasLifecycleIdentity = startEvent !== undefined || finishEvent !== undefined || hasHeartbeat;

	if (!hasLifecycleIdentity) {
		const lastMs = Date.parse(lastEventTs);
		if (!Number.isFinite(lastMs) || nowMs - lastMs > LEGACY_LIVE_WINDOW_MS) {
			return { startedAt, lastEventTs, coverCycles: false };
		}
		const watchEvidence = groupEvents.some((event) => WATCH_EVIDENCE.has(event.type));
		return {
			startedAt,
			lastEventTs,
			coverCycles: false,
			row: {
				id: `external:${slug}:${executionId}`,
				repo: slug,
				source: "external",
				status: "running",
				startedAt,
				...extras,
				...(watchEvidence ? { mode: "watch" as ContinuousMode } : {}),
			},
		};
	}

	if (finishEvent) {
		return {
			startedAt,
			lastEventTs,
			endedAt: finishEvent.ts,
			...(item !== undefined ? { item } : {}),
			coverCycles: true,
			row: {
				id: `external:${slug}:${executionId}`,
				repo: slug,
				source: "external",
				status: finishEvent.outcome,
				startedAt,
				endedAt: finishEvent.ts,
				...extras,
			},
		};
	}

	const heartbeatMs = startEvent?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
	const lastMs = Date.parse(lastEventTs);
	const fresh = Number.isFinite(lastMs) && nowMs - lastMs <= staleHeartbeatIntervals * heartbeatMs;
	if (fresh) {
		return {
			startedAt,
			lastEventTs,
			...(item !== undefined ? { item } : {}),
			coverCycles: true,
			row: {
				id: `external:${slug}:${executionId}`,
				repo: slug,
				source: "external",
				status: "running",
				startedAt,
				...extras,
			},
		};
	}
	return {
		startedAt,
		lastEventTs,
		endedAt: lastEventTs,
		...(item !== undefined ? { item } : {}),
		coverCycles: true,
		row: {
			id: `external:${slug}:${executionId}`,
			repo: slug,
			source: "external",
			status: "abandoned",
			startedAt,
			endedAt: lastEventTs,
			...extras,
		},
	};
}

function projectCycle(slug: string, event: LegacyCycleCompletedEvent): RunSummary {
	const endedAt = event.ts;
	const duration = event.provenance?.durationMs;
	const endedMs = Date.parse(endedAt);
	const startedAt = typeof duration === "number" && Number.isFinite(duration) && duration > 0 && Number.isFinite(endedMs) ? new Date(endedMs - duration).toISOString() : endedAt;
	const decoded = decodeCycleOutcome(event);
	const status: RunStatus = decoded?.outcome === "parked" ? "parked" : decoded?.outcome === "completed" ? "completed" : "failed";
	const lastName = Array.isArray(event.steps) && event.steps.length > 0 ? event.steps.at(-1)?.name : undefined;
	const lastCost = typeof event.total_cost === "number" && Number.isFinite(event.total_cost) ? event.total_cost : undefined;
	return {
		id: `external:${slug}:cycle:${event.eventId}`,
		repo: slug,
		source: "external",
		status,
		startedAt,
		endedAt,
		...(typeof event.item === "string" ? { item: event.item } : {}),
		...(typeof lastName === "string" ? { lastStep: lastName } : {}),
		...(lastCost !== undefined ? { lastCost } : {}),
	};
}

function shouldSuppressCycle(cycle: LegacyCycleCompletedEvent, intervals: readonly { start: string; end: string; item: string }[], supervised: readonly PersistedRun[], nowIso: string): boolean {
	const ts = cycle.ts;
	for (const interval of intervals) {
		if (typeof cycle.item === "string" && campaignIncludesItem(interval.item, cycle.item) && ts >= interval.start && ts <= interval.end) return true;
	}
	if (typeof cycle.item !== "string") return false;
	for (const run of supervised) {
		if (run.item === undefined || !campaignIncludesItem(run.item, cycle.item)) continue;
		const end = run.endedAt ?? nowIso;
		if (ts >= run.startedAt && ts <= end) return true;
	}
	return false;
}

function campaignIncludesItem(campaign: string, item: string): boolean {
	return campaign.split(",").some((candidate) => candidate.trim() === item);
}

function foldActivity(events: readonly FlowEvent[]): RunActivity | undefined {
	let activity: RunActivity | undefined;
	for (const event of events) {
		const projected = projectRunActivity(event as unknown as Record<string, unknown>);
		if (projected) activity = projected;
	}
	return activity;
}

function isLegacyCycle(event: FlowEvent): event is LegacyCycleCompletedEvent {
	return event.type === "pelaggio.cycle-completed" && event.legacy === true;
}

function isRunStarted(event: FlowEvent): event is RunStartedEvent {
	return event.type === "pelaggio.run-started";
}

function isRunFinished(event: FlowEvent): event is RunFinishedEvent {
	return event.type === "pelaggio.run-finished";
}
