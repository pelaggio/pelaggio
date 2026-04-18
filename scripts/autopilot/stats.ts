import { existsSync, readFileSync } from "node:fs";
import { LOG_PATH } from "./config.js";
import { A } from "./tui.js";
import type { CycleLogEntry, StepLog, TokenUsage } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────

interface DeliveredItem {
	id: string;
	date: string;
	cost: number;
	tokens: number;
	rethinks: number;
	parked: boolean;
}

export interface Stats {
	totalCycles: number;
	completedCycles: number;
	failedCycles: number;
	parkedCycles: number;
	shipwreckedCycles: number;
	totalCostUsd: number;
	totalTokens: TokenUsage;
	cacheHitRatio: number;
	avgRetriesByStep: Record<string, number>;
	rethinkRateByStep: Record<string, number>;
	avgShakedownIterations: number;
	costByStep: Record<string, number>;
	tokensByStep: Record<string, TokenUsage>;
	cacheHitRatioByStep: Record<string, number>;
	itemsDelivered: DeliveredItem[];
}

// ── Reducer ────────────────────────────────────────────────────────────

function emptyTokens(): TokenUsage {
	return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

function addTokens(a: TokenUsage, b: TokenUsage): void {
	a.input += b.input;
	a.output += b.output;
	a.cacheCreation += b.cacheCreation;
	a.cacheRead += b.cacheRead;
}

function cacheHitRatio(t: TokenUsage): number {
	const denom = t.input + t.cacheRead;
	return denom === 0 ? 0 : t.cacheRead / denom;
}

export function reduce(entries: CycleLogEntry[]): Stats {
	const totalTokens = emptyTokens();
	const costByStep: Record<string, number> = {};
	const tokensByStep: Record<string, TokenUsage> = {};
	const retriesPerStepSum: Record<string, number> = {};
	const retriesPerStepCount: Record<string, number> = {};
	const rethinkTotal: Record<string, number> = {};
	const rethinkMatch: Record<string, number> = {};
	let shakedownIterSum = 0;
	let shakedownIterCount = 0;
	let totalCost = 0;
	let completed = 0;
	let failed = 0;
	let parked = 0;
	let shipwrecked = 0;
	const itemsDelivered: DeliveredItem[] = [];

	for (const entry of entries) {
		totalCost += entry.total_cost ?? 0;
		if (entry.completed) completed++;
		else failed++;
		if (entry.parked) parked++;
		if (entry.shipwrecked) shipwrecked++;

		// Step aggregations: group by step name, find max attempt per (cycle, step)
		const maxAttemptByStep = new Map<string, number>();
		let cycleRethinks = 0;
		const cycleTokens = emptyTokens();
		for (const s of entry.steps ?? []) {
			costByStep[s.name] = (costByStep[s.name] ?? 0) + (s.cost ?? 0);
			if (s.tokens) {
				if (!tokensByStep[s.name]) tokensByStep[s.name] = emptyTokens();
				addTokens(tokensByStep[s.name], s.tokens);
				addTokens(totalTokens, s.tokens);
				addTokens(cycleTokens, s.tokens);
			}
			const attempt = s.attempt ?? 1;
			const prev = maxAttemptByStep.get(s.name) ?? 0;
			if (attempt > prev) maxAttemptByStep.set(s.name, attempt);

			if (s.name.startsWith("shakedown")) {
				// Count verdicts on shakedown-plan specifically
				if (s.name === "shakedown-plan" && s.verdict) {
					rethinkTotal[s.name] = (rethinkTotal[s.name] ?? 0) + 1;
					if (s.verdict === "RETHINK") {
						rethinkMatch[s.name] = (rethinkMatch[s.name] ?? 0) + 1;
						cycleRethinks++;
					}
				}
			}
		}

		// Record retries per step per cycle (attempt count, not retry count)
		for (const [name, maxAttempt] of maxAttemptByStep) {
			retriesPerStepSum[name] = (retriesPerStepSum[name] ?? 0) + (maxAttempt - 1);
			retriesPerStepCount[name] = (retriesPerStepCount[name] ?? 0) + 1;
			if (name.startsWith("shakedown")) {
				shakedownIterSum += maxAttempt;
				shakedownIterCount++;
			}
		}

		if (entry.completed && entry.item) {
			const tokSum = cycleTokens.input + cycleTokens.output + cycleTokens.cacheCreation;
			itemsDelivered.push({
				id: entry.item,
				date: (entry.ts ?? "").slice(0, 10),
				cost: entry.total_cost ?? 0,
				tokens: tokSum,
				rethinks: cycleRethinks,
				parked: !!entry.parked,
			});
		}
	}

	const avgRetriesByStep: Record<string, number> = {};
	for (const name of Object.keys(retriesPerStepCount)) {
		avgRetriesByStep[name] = retriesPerStepSum[name] / retriesPerStepCount[name];
	}

	const rethinkRateByStep: Record<string, number> = {};
	for (const name of Object.keys(rethinkTotal)) {
		rethinkRateByStep[name] = rethinkTotal[name] === 0 ? 0 : (rethinkMatch[name] ?? 0) / rethinkTotal[name];
	}

	const cacheHitRatioByStep: Record<string, number> = {};
	for (const name of Object.keys(tokensByStep)) {
		cacheHitRatioByStep[name] = cacheHitRatio(tokensByStep[name]);
	}

	return {
		totalCycles: entries.length,
		completedCycles: completed,
		failedCycles: failed,
		parkedCycles: parked,
		shipwreckedCycles: shipwrecked,
		totalCostUsd: totalCost,
		totalTokens,
		cacheHitRatio: cacheHitRatio(totalTokens),
		avgRetriesByStep,
		rethinkRateByStep,
		avgShakedownIterations: shakedownIterCount === 0 ? 0 : shakedownIterSum / shakedownIterCount,
		costByStep,
		tokensByStep,
		cacheHitRatioByStep,
		itemsDelivered,
	};
}

// ── Renderer ───────────────────────────────────────────────────────────

function fmtNum(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
	return String(n);
}

function fmtPct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function fmtUsd(n: number): string {
	return `$${n.toFixed(2)}`;
}

const STEP_ORDER = ["pick", "plan", "shakedown-plan", "implement", "shakedown-code", "ship", "shipwreck"];

function sortSteps(names: string[]): string[] {
	return [...names].sort((a, b) => {
		const ia = STEP_ORDER.indexOf(a);
		const ib = STEP_ORDER.indexOf(b);
		if (ia === -1 && ib === -1) return a.localeCompare(b);
		if (ia === -1) return 1;
		if (ib === -1) return -1;
		return ia - ib;
	});
}

export function renderDashboard(stats: Stats): string {
	const lines: string[] = [];

	const header = `${A.bold("autopilot stats")}`;
	const summary = `${stats.totalCycles} cycles  ${fmtUsd(stats.totalCostUsd)}`;
	lines.push(`${header}${" ".repeat(Math.max(1, 60 - "autopilot stats".length))}${A.dim(summary)}`);
	lines.push("");

	// Cost & tokens
	lines.push(A.bold("Cost & tokens"));
	lines.push(
		`  ${A.dim("Cycles")}       ${String(stats.totalCycles).padEnd(4)}  ${A.green(`completed ${stats.completedCycles}`)}  ${A.red(`failed ${stats.failedCycles}`)}  ${A.yellow(`parked ${stats.parkedCycles}`)}  shipwrecked ${stats.shipwreckedCycles}`,
	);
	lines.push(`  ${A.dim("Spend")}        ${fmtUsd(stats.totalCostUsd)}`);
	lines.push(`  ${A.dim("Tokens")}       in ${fmtNum(stats.totalTokens.input)}  out ${fmtNum(stats.totalTokens.output)}  cache-write ${fmtNum(stats.totalTokens.cacheCreation)}  cache-read ${fmtNum(stats.totalTokens.cacheRead)}`);
	lines.push(`  ${A.dim("Cache-hit")}    ${fmtPct(stats.cacheHitRatio)}`);
	lines.push("");

	// Per-step table
	const stepNames = sortSteps(Object.keys(stats.costByStep));
	if (stepNames.length > 0) {
		lines.push(`  ${A.dim("By step")}         ${"cost".padStart(8)}  ${"in".padStart(6)}  ${"out".padStart(5)}  ${"cache-rd".padStart(9)}  ${"hit%".padStart(5)}`);
		for (const name of stepNames) {
			const tok = stats.tokensByStep[name] ?? emptyTokens();
			const hit = stats.cacheHitRatioByStep[name] ?? 0;
			lines.push(`    ${name.padEnd(14)}  ${fmtUsd(stats.costByStep[name]).padStart(8)}  ${fmtNum(tok.input).padStart(6)}  ${fmtNum(tok.output).padStart(5)}  ${fmtNum(tok.cacheRead).padStart(9)}  ${fmtPct(hit).padStart(5)}`);
		}
		lines.push("");
	}

	// Quality
	lines.push(A.bold("Quality"));
	const retryNames = sortSteps(Object.keys(stats.avgRetriesByStep).filter((n) => stats.avgRetriesByStep[n] > 0));
	if (retryNames.length > 0) {
		lines.push(`  ${A.dim("Retry rate (turn-exhaustion)")}`);
		for (const n of retryNames) {
			lines.push(`    ${n.padEnd(16)} ${stats.avgRetriesByStep[n].toFixed(2)} per cycle`);
		}
	} else {
		lines.push(`  ${A.dim("Retry rate")}   0 retries across all steps`);
	}

	const rethinkNames = sortSteps(Object.keys(stats.rethinkRateByStep));
	if (rethinkNames.length > 0) {
		lines.push(`  ${A.dim("Rethink rate (plan review)")}`);
		for (const n of rethinkNames) {
			lines.push(`    ${n.padEnd(16)} ${fmtPct(stats.rethinkRateByStep[n])}`);
		}
	}

	if (stats.avgShakedownIterations > 0) {
		lines.push(`  ${A.dim("Avg shakedown iterations")}  ${stats.avgShakedownIterations.toFixed(2)}`);
	}
	lines.push("");

	// Recent items (last 10)
	const recent = stats.itemsDelivered.slice(-10).reverse();
	if (recent.length > 0) {
		lines.push(A.bold(`Recent items (last ${recent.length})`));
		for (const it of recent) {
			const mark = it.parked ? A.yellow("⏸") : A.green("✓");
			lines.push(`  ${it.date}  ${it.id.padEnd(10)} ${fmtUsd(it.cost).padStart(7)}  ${fmtNum(it.tokens).padStart(5)} tok  ${it.rethinks} rethinks  ${mark}`);
		}
	} else {
		lines.push(A.dim("No completed items yet."));
	}

	return lines.join("\n");
}

// ── Entry point ────────────────────────────────────────────────────────

export function runStatsCommand(): void {
	if (!existsSync(LOG_PATH)) {
		console.log(A.dim("No autopilot log found at") + " " + LOG_PATH);
		return;
	}
	const raw = readFileSync(LOG_PATH, "utf-8");
	const entries: CycleLogEntry[] = raw
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l) as CycleLogEntry;
			} catch {
				return null;
			}
		})
		.filter((e): e is CycleLogEntry => e !== null && Array.isArray((e as { steps?: StepLog[] }).steps));

	const stats = reduce(entries);
	console.log(renderDashboard(stats));
}
