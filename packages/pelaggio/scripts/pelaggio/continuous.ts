/**
 * Continuous-mode helpers (issue #82): drain/watch presets, free queue probe,
 * and per-day budget accounting for long-running auto-pick sessions.
 *
 * Pure / side-effect-free where possible so the orchestrator and tests share one
 * definition of the stop conditions.
 */

import type { FlowPolicy } from "./flow-policy.js";
import type { RoadmapSource } from "./roadmap/index.js";
import { buildFlowSnapshot } from "./roadmap-cli.js";
import type { Flags } from "./types.js";

export const CONTINUOUS_PRESETS = ["drain", "watch"] as const;
export type ContinuousPreset = (typeof CONTINUOUS_PRESETS)[number];

export function isContinuousPreset(value: string): value is ContinuousPreset {
	return (CONTINUOUS_PRESETS as readonly string[]).includes(value);
}

export interface ContinuousConfig {
	/** Always true when this object is returned from `resolveContinuousConfig`. */
	enabled: true;
	preset: ContinuousPreset;
	/** Hard stop when calendar-day spend reaches this USD amount. Undefined = no day cap. */
	dayBudget?: number;
	/** Watch-mode sleep between free probes (ms). Ignored for drain. */
	probeIntervalMs: number;
}

export type ContinuousResolveError = { ok: false; message: string } | { ok: true; config: ContinuousConfig | null };

function parsePositiveDuration(value: string): number | null {
	const duration = value.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
	if (duration && (duration[1] || duration[2])) {
		const hours = Number.parseInt(duration[1] ?? "0", 10);
		const minutes = Number.parseInt(duration[2] ?? "0", 10);
		const milliseconds = (hours * 60 + minutes) * 60_000;
		return milliseconds > 0 ? milliseconds : null;
	}
	if (!/^\d+$/.test(value)) return null;
	const milliseconds = Number.parseInt(value, 10) * 60_000;
	return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

/**
 * Resolve continuous-mode CLI flags. Returns `config: null` when continuous is
 * off. Returns an error envelope for invalid combinations so the orchestrator
 * can exit 2 without throwing.
 */
export function resolveContinuousConfig(flags: Flags): ContinuousResolveError {
	const continuousFlag = flags.continuous === true;
	const presetRaw = flags.preset;
	const enabled = continuousFlag || presetRaw !== undefined;
	if (!enabled) return { ok: true, config: null };

	if (presetRaw !== undefined && !isContinuousPreset(presetRaw)) {
		return {
			ok: false,
			message: `invalid --preset ${JSON.stringify(presetRaw)}; valid: ${CONTINUOUS_PRESETS.join(", ")}`,
		};
	}
	const preset: ContinuousPreset = presetRaw ?? "drain";

	if (flags.item) {
		return { ok: false, message: "--continuous / --preset requires auto-pick mode (omit --item)" };
	}
	if (flags.resume) {
		return { ok: false, message: "--continuous / --preset cannot combine with --resume" };
	}

	let dayBudget: number | undefined;
	if (flags["day-budget"] !== undefined) {
		const n = Number(flags["day-budget"]);
		if (!Number.isFinite(n) || n <= 0) {
			return { ok: false, message: `--day-budget must be a positive number (got ${JSON.stringify(flags["day-budget"])})` };
		}
		dayBudget = n;
	}

	const probeIntervalMs = parsePositiveDuration(flags["probe-interval"] ?? "5m");
	if (probeIntervalMs === null) {
		return { ok: false, message: `--probe-interval must be a positive duration (got ${JSON.stringify(flags["probe-interval"])})` };
	}

	return {
		ok: true,
		config: {
			enabled: true,
			preset,
			...(dayBudget !== undefined ? { dayBudget } : {}),
			probeIntervalMs,
		},
	};
}

/**
 * Cycle cap for continuous mode. `--cycles` defaults to `"1"`; when continuous is
 * on that default means "no fixed cap" (stop on empty/day-budget/park only). An
 * explicit `--cycles N` with N>1 remains a safety ceiling.
 */
export function continuousCycleCap(flags: Flags, continuous: ContinuousConfig | null): number {
	const requested = Number.parseInt(flags.cycles, 10);
	const parallel = Number.parseInt(flags.parallel, 10);
	const items =
		flags.item
			?.split(",")
			.map((s) => s.trim())
			.filter(Boolean) ?? [];
	if (!continuous) {
		return Math.max(Number.isFinite(requested) ? requested : 1, Number.isFinite(parallel) ? parallel : 1, items.length);
	}
	// Continuous: treat default cycles=1 as unlimited; explicit N>1 is a max.
	if (!Number.isFinite(requested) || requested <= 1) return Number.MAX_SAFE_INTEGER;
	return requested;
}

/** Local calendar day key (YYYY-MM-DD) for per-day budget accounting. */
export function dayKey(nowMs: number = Date.now()): string {
	const d = new Date(nowMs);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/**
 * Track spend against a per-day budget. Returns whether the day budget is now
 * exhausted after adding `cost`. Resets the accumulator when the calendar day
 * rolls over.
 */
export class DayBudgetTracker {
	private day = dayKey();
	private spent = 0;

	constructor(
		private readonly dayBudget: number | undefined,
		private readonly now: () => number = Date.now,
	) {}

	/** Current day spend (after any rollover). */
	get daySpent(): number {
		this.roll();
		return this.spent;
	}

	add(cost: number): void {
		this.roll();
		if (Number.isFinite(cost) && cost > 0) this.spent += cost;
	}

	/** True when a day budget is configured and current day spend is at/over it. */
	exceeded(): boolean {
		if (this.dayBudget === undefined) return false;
		this.roll();
		return this.spent >= this.dayBudget;
	}

	private roll(): void {
		const key = dayKey(this.now());
		if (key !== this.day) {
			this.day = key;
			this.spent = 0;
		}
	}
}

export interface QueueProbeResult {
	empty: boolean;
	readyCount: number;
}

/**
 * Free queue probe: list open items + evaluate FlowPolicy without spawning a
 * pick agent. Empty means drain should exit and watch should sleep.
 */
export async function freeQueueProbe(roadmap: RoadmapSource, flowPolicy: FlowPolicy, topic?: string): Promise<QueueProbeResult> {
	const items = await roadmap.listItems({ includeDone: true });
	// Match the pick agent's #201 over-scope gate so the probe's readiness count
	// agrees with what a pick would actually claim.
	const { CONFIG } = await import("./config.js");
	const evaluation = flowPolicy.evaluate(buildFlowSnapshot(items, { topic, maxScope: CONFIG.pick.maxScope }));
	const readyCount = evaluation.candidates.length;
	return { empty: readyCount === 0, readyCount };
}
