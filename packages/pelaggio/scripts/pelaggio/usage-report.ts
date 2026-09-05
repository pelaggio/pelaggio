import { readUsageMeasurement, type UsageMeasurement } from "./usage-measurement.js";

export interface UsageRow {
	/** Identity of the persisted observation, not a hash of its contents. */
	id: string;
	run: string;
	attempt: string;
	provider: string;
	model: string;
	step: string;
	measurement?: UsageMeasurement;
}

interface Metric {
	value: number | null;
	observed: number;
	total: number;
}

const FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "promptBytes"] as const;

type UsageTotals = Record<(typeof FIELDS)[number], Metric> & { cacheReadFraction: Metric };

export interface UsageReport {
	schemaVersion: 1;
	kind: "pelaggio.usage-report";
	observations: number;
	duplicateObservations: number;
	conflictingObservations: number;
	unverifiedObservations: number;
	totals: UsageTotals;
	byPromptBoundary: Array<{ boundary: string; promptBytes: Metric }>;
	byProviderModelStep: Array<{ provider: string; model: string; step: string; totals: UsageTotals }>;
	attempts: UsageRow[];
	notes: string[];
}

function totals(rows: readonly UsageRow[]): UsageTotals {
	const metrics = Object.fromEntries(
		FIELDS.map((key) => {
			const values = rows.flatMap((row) => (row.measurement?.[key] === undefined ? [] : [row.measurement[key] as number]));
			const sum = values.reduce((a, b) => a + b, 0);
			return [key, { value: values.length && Number.isSafeInteger(sum) ? sum : null, observed: values.length, total: rows.length } satisfies Metric];
		}),
	) as Record<(typeof FIELDS)[number], Metric>;
	const paired = rows.filter((r) => r.measurement?.inputTokens !== undefined && r.measurement.cacheReadTokens !== undefined);
	const input = paired.reduce((n, r) => n + (r.measurement?.inputTokens ?? 0), 0);
	const read = paired.reduce((n, r) => n + (r.measurement?.cacheReadTokens ?? 0), 0);
	return { ...metrics, cacheReadFraction: { value: input > 0 && Number.isSafeInteger(input) && Number.isSafeInteger(read) ? read / input : null, observed: paired.length, total: rows.length } };
}

function label(value: string): string {
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 120);
}

/** Pure, on-demand projection. Never re-emits observations or feeds execution decisions. */
export function buildUsageReport(input: readonly UsageRow[]): UsageReport {
	const seen = new Map<string, string>();
	const rows: UsageRow[] = [];
	let duplicateObservations = 0;
	let conflictingObservations = 0;
	for (const row of input) {
		const clean = { ...row, measurement: readUsageMeasurement(row.measurement) };
		const key = JSON.stringify([row.run, row.id]);
		const signature = JSON.stringify(clean);
		const previous = seen.get(key);
		if (previous !== undefined) {
			if (previous === signature) duplicateObservations++;
			else {
				conflictingObservations++;
				const prior = rows.findIndex((r) => r.run === row.run && r.id === row.id);
				const priorRow = rows[prior];
				if (priorRow) rows[prior] = { ...priorRow, measurement: undefined };
			}
			continue;
		}
		seen.set(key, signature);
		rows.push(clean);
	}
	const boundaries = new Map<string, UsageRow[]>();
	for (const row of rows) {
		const boundary = row.measurement?.promptBoundary ?? "unrecorded";
		const group = boundaries.get(boundary) ?? [];
		group.push(row);
		boundaries.set(boundary, group);
	}
	const groups = new Map<string, UsageRow[]>();
	for (const row of rows) {
		const key = JSON.stringify([row.provider, row.model, row.step]);
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}
	return {
		schemaVersion: 1 as const,
		kind: "pelaggio.usage-report" as const,
		observations: rows.length,
		duplicateObservations,
		conflictingObservations,
		unverifiedObservations: rows.filter((r) => !r.measurement || r.measurement.basis === "unverified").length,
		totals: totals(rows),
		byPromptBoundary: [...boundaries].map(([boundary, group]) => ({ boundary, promptBytes: totals(group).promptBytes })),
		byProviderModelStep: [...groups.values()].flatMap((group) => {
			const first = group[0];
			return first ? [{ provider: label(first.provider), model: label(first.model), step: label(first.step), totals: totals(group) }] : [];
		}),
		attempts: rows.map((row) => ({ ...row, provider: label(row.provider), model: label(row.model), step: label(row.step) })),
		notes: [
			"Input totals include cache reads/writes; reasoning is a subset of output. Breakdowns are not additive.",
			"Prompt bytes count text once per invocation: dispatcher-input excludes adapter appends; adapter-assembled includes them. Compare growth within a boundary; unrecorded boundaries are unknown. Bytes are not tokens.",
			"Unavailable and unverified counters are excluded. Coverage describes observations, not hidden model calls.",
			"Existing cost/budget accounting is unchanged; this report does not estimate bills or subscription quota.",
		],
	};
}

export function renderUsageReport(report: UsageReport): string {
	const show = (m: Metric) => `${m.value === null ? "unavailable" : m.value.toLocaleString("en-US")} (${m.observed}/${m.total} observations)`;
	const t = report.totals;
	return [
		`Usage report · ${report.observations} observations`,
		`Input processed: ${show(t.inputTokens)}`,
		`Cache reads: ${show(t.cacheReadTokens)}`,
		`Cache writes: ${show(t.cacheWriteTokens)}`,
		`Output: ${show(t.outputTokens)}`,
		`Cache read fraction: ${t.cacheReadFraction.value === null ? "unavailable" : `${(100 * t.cacheReadFraction.value).toFixed(1)}%`} (${t.cacheReadFraction.observed}/${t.cacheReadFraction.total} observations)`,
		`Harness prompt bytes (all boundaries): ${show(t.promptBytes)}`,
		...report.byPromptBoundary.map((g) => `Prompt bytes / ${g.boundary}: ${show(g.promptBytes)}`),
		`Unverified accounting: ${report.unverifiedObservations}; duplicate observations: ${report.duplicateObservations}; conflicts excluded: ${report.conflictingObservations}`,
		...report.byProviderModelStep.map((g) => `${g.provider} / ${g.model} / ${g.step}: input ${show(g.totals.inputTokens)}`),
		...report.notes,
	].join("\n");
}

function identityPart(value: unknown, fallback: string): string {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? String(value) : fallback;
}

/** Cycle entries only: parent cycle totals are never added to their step observations. */
export function cycleUsageRows(entries: readonly unknown[]): UsageRow[] {
	return entries.flatMap((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
		const e = entry as Record<string, unknown>;
		if (!Array.isArray(e.steps) || e.budgetCharge === true) return [];
		const cycleId = `${identityPart(e.ts, String(index))}:${identityPart(e.cycle, String(index))}`;
		const run = typeof e.runId === "string" ? e.runId : `cycle:${cycleId}`;
		return e.steps.flatMap((step, position) => {
			if (!step || typeof step !== "object" || Array.isArray(step)) return [];
			const s = step as Record<string, unknown>;
			return [
				{
					id: readUsageMeasurement(s.usageMeasurement)?.observationId ?? `${cycleId}:${position}`,
					run,
					attempt: identityPart(s.attempt, "1"),
					provider: typeof s.provider === "string" ? s.provider : "unrecorded",
					model: typeof s.model === "string" ? s.model : "unrecorded",
					step: typeof s.name === "string" ? s.name : "unrecorded",
					measurement: readUsageMeasurement(s.usageMeasurement),
				},
			];
		});
	});
}
