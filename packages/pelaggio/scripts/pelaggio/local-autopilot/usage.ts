import { readUsageMeasurement } from "../usage-measurement.js";
import { buildUsageReport, type UsageReport, type UsageRow } from "../usage-report.js";
import type { MetricsUsage, RunEvent } from "./types.js";

/** Diagnostics attach to existing call acknowledgements; they do not drive journal recovery. */
export function localUsageReport(events: readonly RunEvent[]): UsageReport {
	let attempt = 1;
	const resumed = new Set<string>();
	const rows: UsageRow[] = [];
	const attemptByEvent = new Map<string, string>();
	for (const event of events) {
		if (event.type === "pelaggio.local-autopilot.run-resumed" && !resumed.has(event.eventId)) {
			resumed.add(event.eventId);
			attempt++;
		}
		if (event.type !== "pelaggio.local-autopilot.fake-progress") continue;
		const payload = event.payload ?? {};
		const eventAttempt = attemptByEvent.get(event.eventId) ?? String(attempt);
		attemptByEvent.set(event.eventId, eventAttempt);
		rows.push({
			id: event.eventId,
			run: event.runId,
			attempt: eventAttempt,
			provider: typeof payload.provider === "string" ? payload.provider : "unrecorded",
			model: typeof payload.model === "string" ? payload.model : "unrecorded",
			step: "harness",
			measurement: readUsageMeasurement(payload.usageMeasurement),
		});
	}
	return buildUsageReport(rows);
}

/** The frozen contract cannot express partial totals. Omit a field unless coverage is complete. */
export function localMetricsUsage(events: readonly RunEvent[]): MetricsUsage | undefined {
	const report = localUsageReport(events);
	const usage: MetricsUsage = {};
	for (const key of ["inputTokens", "outputTokens"] as const) {
		const metric = report.totals[key];
		if (metric.value !== null && metric.observed === metric.total) usage[key] = metric.value;
	}
	return Object.keys(usage).length ? usage : undefined;
}
