/**
 * Landing-cost baseline over PR-gate records, with explicit optional durable authoring coverage.
 *
 * This is INSTRUMENTATION, not a check: it exits 0 regardless and prints a table. It exists so a
 * throughput claim about a process change (the assurance/assessment stack, `review.carry`, seat
 * parallelism) can be tested against a pre-change baseline instead of an impression.
 *
 * Every measurement comes from records the harness already persisted; family denominators stay separate. `cost` is the fleet's own
 * reported spend and is mostly notional against a subscription pool — read rolls and wall-clock as
 * the scarce resources, and cost as their proxy.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type PrReviewSecurityTelemetry, REVIEW_INTENSITY_PROFILES, validatePrReviewParticipation, validatePrReviewSecurityTelemetry } from "../packages/pelaggio/scripts/pelaggio/pr-review-gate-record.js";
import { REVIEW_FINDING_CLOSURES, type ReviewFindingClosure } from "../packages/pelaggio/scripts/pelaggio/review/findings.js";
import type { ReviewIntensityProfile } from "../packages/pelaggio/scripts/pelaggio/types.js";

export interface GateRecord {
	prNumber: number;
	itemId?: string;
	headSha: string;
	gate: string;
	ok?: boolean;
	subtype?: string;
	agreement?: string;
	breakerReason?: string;
	iterations?: number;
	survivorCount?: number;
	cost?: number;
	costEstimated?: boolean;
	turns?: number;
	reviewedAt?: string;
	schemaVersion?: number;
	producer?: string;
	recurrenceFindings?: readonly { closure?: string }[];
	elapsedMs?: unknown;
	securityReview?: unknown;
	participation?: unknown;
}

export function repoRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

type ObjectRecord = Record<string, unknown>;
export interface AuthoringRecord {
	schemaVersion: 1;
	runId: string;
	itemId: string;
	createdAt?: string;
	result: ObjectRecord;
}
export interface ReviewCorpus<T = GateRecord | AuthoringRecord> {
	family: "pr" | "authoring";
	until?: string;
	availability: "readable" | "missing" | "unreadable";
	records: T[];
	invalid: number;
	undated: number;
	excluded: number;
	inventory: Array<{ name: string; digest: string; state: string }>;
}
function object(value: unknown): ObjectRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ObjectRecord) : undefined;
}
function finiteNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function validDate(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function parseMetricRecord(value: unknown, family: "pr" | "authoring"): GateRecord | AuthoringRecord | undefined {
	const r = object(value);
	if (!r) return undefined;
	if (family === "authoring") {
		const result = object(r.result);
		if (r.schemaVersion !== 1 || typeof r.runId !== "string" || !r.runId || typeof r.itemId !== "string" || !r.itemId || r.document !== undefined || r.blockingBar !== "must-fix" || !result) return undefined;
		return { schemaVersion: 1, runId: r.runId, itemId: r.itemId, ...(validDate(r.createdAt) ? { createdAt: r.createdAt } : {}), result };
	}
	if (!Number.isInteger(r.prNumber) || (r.prNumber as number) <= 0 || typeof r.headSha !== "string" || !/^(?:[a-f0-9]{7,40}|[a-f0-9]{64})$/i.test(r.headSha) || (r.gate !== "pass" && r.gate !== "block")) return undefined;
	if (r.schemaVersion !== undefined && r.schemaVersion !== 1 && r.schemaVersion !== 2) return undefined;
	if (r.schemaVersion === 2 && r.producer !== "fleet" && r.producer !== "operator-adjudication") return undefined;
	// Normalize only consumed optional fields: damaged measurements are unknown, never observations.
	return {
		prNumber: r.prNumber as number,
		headSha: r.headSha,
		gate: r.gate,
		...(typeof r.ok === "boolean" ? { ok: r.ok } : {}),
		...(typeof r.itemId === "string" ? { itemId: r.itemId } : {}),
		...(typeof r.agreement === "string" ? { agreement: r.agreement } : {}),
		...(typeof r.breakerReason === "string" ? { breakerReason: r.breakerReason } : {}),
		...(finiteNonnegative(r.cost) ? { cost: r.cost } : {}),
		...(finiteNonnegative(r.survivorCount) && Number.isInteger(r.survivorCount) ? { survivorCount: r.survivorCount } : {}),
		...(validDate(r.reviewedAt) ? { reviewedAt: r.reviewedAt } : {}),
		...(typeof r.schemaVersion === "number" ? { schemaVersion: r.schemaVersion } : {}),
		...(typeof r.producer === "string" ? { producer: r.producer } : {}),
		...(Array.isArray(r.recurrenceFindings) ? { recurrenceFindings: r.recurrenceFindings } : {}),
		elapsedMs: r.elapsedMs,
		securityReview: r.securityReview,
		participation: r.participation,
	};
}
export function loadReviewCorpus(dir: string, family: "pr", until?: string): ReviewCorpus<GateRecord>;
export function loadReviewCorpus(dir: string, family: "authoring", until?: string): ReviewCorpus<AuthoringRecord>;
export function loadReviewCorpus(dir: string, family: "pr" | "authoring", until?: string): ReviewCorpus {
	const corpus: ReviewCorpus = { family, ...(until !== undefined ? { until } : {}), availability: "readable", records: [], invalid: 0, undated: 0, excluded: 0, inventory: [] };
	let names: string[];
	try {
		names = readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.sort();
	} catch (error) {
		corpus.availability = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
		return corpus;
	}
	for (const name of names) {
		let digest = "unreadable";
		try {
			const bytes = readFileSync(join(dir, name));
			digest = createHash("sha256").update(bytes).digest("hex");
			const record = parseMetricRecord(JSON.parse(bytes.toString("utf8")), family);
			if (!record) throw new Error("unusable metrics identity");
			const date = "prNumber" in record ? record.reviewedAt : record.createdAt;
			if (!date) corpus.undated++;
			if (until !== undefined && date && Date.parse(date) >= Date.parse(until)) {
				corpus.excluded++;
				continue;
			}
			const admitted = until === undefined || date !== undefined;
			corpus.inventory.push({ name, digest, state: admitted ? "admitted" : "undated" });
			if (admitted) corpus.records.push(record);
		} catch {
			corpus.invalid++;
			corpus.inventory.push({ name, digest, state: "invalid" });
		}
	}
	corpus.records.sort((a, b) => ("prNumber" in a ? (a.reviewedAt ?? "") : (a.createdAt ?? "")).localeCompare("prNumber" in b ? (b.reviewedAt ?? "") : (b.createdAt ?? "")));
	return corpus;
}
export function loadGateRecords(dir: string): GateRecord[] {
	return loadReviewCorpus(dir, "pr").records;
}
export interface MeasurementSummary {
	total: number;
	observed: number;
	unknown: number;
	min?: number;
	max?: number;
	mean?: number;
	sum?: number;
}
export function measurementSummary(values: readonly unknown[], integer = true): MeasurementSummary {
	const observed = values.filter((value): value is number => finiteNonnegative(value) && (!integer || Number.isInteger(value)));
	const summary: MeasurementSummary = { total: values.length, observed: observed.length, unknown: values.length - observed.length };
	if (observed.length === 0) return summary;
	const sum = observed.reduce((total, value) => total + value, 0);
	const min = observed.reduce((minimum, value) => Math.min(minimum, value), Infinity);
	const max = observed.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
	return { ...summary, min, max, mean: Number((sum / observed.length).toFixed(2)), sum };
}
export function summarizeAuthoring(records: readonly AuthoringRecord[]): {
	runs: MeasurementSummary;
	passes: MeasurementSummary;
	reviewers: MeasurementSummary;
	judges: MeasurementSummary;
	cost: MeasurementSummary;
	unavailableContainers: number;
} {
	const passes: unknown[] = [],
		reviewers: unknown[] = [],
		judges: unknown[] = [];
	let unavailableContainers = 0;
	for (const record of records) {
		if (!Array.isArray(record.result.passes)) {
			unavailableContainers++;
			continue;
		}
		for (const value of record.result.passes) {
			const pass = object(value);
			passes.push(pass?.elapsedMs);
			if (!pass) {
				unavailableContainers++;
				continue;
			}
			if (Array.isArray(pass.reviewers)) for (const reviewer of pass.reviewers) reviewers.push(object(reviewer)?.elapsedMs);
			else unavailableContainers++;
			const judge = object(pass.judge);
			if (judge) judges.push(judge.elapsedMs);
			else unavailableContainers++;
		}
	}
	return {
		runs: measurementSummary(records.map((r) => r.result.elapsedMs)),
		passes: measurementSummary(passes),
		reviewers: measurementSummary(reviewers),
		judges: measurementSummary(judges),
		cost: measurementSummary(
			records.map((r) => r.result.cost),
			false,
		),
		unavailableContainers,
	};
}
/** Content-bound family inventory; the old PR identity digest remains a separate protocol. */
export function widenedCorpusDigest(corpora: readonly ReviewCorpus[]): string {
	const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
	const inventory = corpora.map(({ family, until, availability, inventory }) => ({ family, until, availability, inventory: [...inventory].sort((a, b) => lexical(a.name, b.name)) })).sort((a, b) => lexical(a.family, b.family));
	return `${corpora.reduce((count, corpus) => count + corpus.records.length, 0)}:${createHash("sha256").update(JSON.stringify(inventory)).digest("hex").slice(0, 12)}`;
}
function formatMeasurement(label: string, value: MeasurementSummary, unit: string): string {
	return `  ${label.padEnd(25)} observed=${value.observed}/${value.total} unknown=${value.unknown} ${value.observed === 0 ? "unavailable" : `min=${value.min} max=${value.max} mean=${value.mean} ${unit}`}`;
}
function formatCorpus(corpus: ReviewCorpus): string {
	return `  ${corpus.family} input: ${corpus.availability}; invalid=${corpus.invalid}; undated=${corpus.undated}; excluded-by-cutoff=${corpus.excluded}`;
}

export interface PrRollup {
	prNumber: number;
	itemId?: string;
	rolls: number;
	distinctHeads: number;
	cost: number;
	costObserved: number;
	passes: number;
	blocks: number;
	finalGate: string;
	finalSurvivors: number;
	finalSurvivorsObserved: boolean;
	agreements: Record<string, number>;
}

/** One row per PR. `distinctHeads` separates a genuine re-push (a repair round) from a re-roll of
 *  the SAME sha (an infra/quota retry) — conflating them overstates the repair rate. */
export function rollupByPr(records: readonly GateRecord[]): PrRollup[] {
	const byPr = new Map<number, GateRecord[]>();
	for (const r of records) {
		const list = byPr.get(r.prNumber);
		if (list) list.push(r);
		else byPr.set(r.prNumber, [r]);
	}
	return [...byPr.entries()]
		.map(([prNumber, rs]) => {
			const last = rs[rs.length - 1];
			const agreements: Record<string, number> = {};
			for (const r of rs) {
				const key = r.agreement ?? "unknown";
				agreements[key] = (agreements[key] ?? 0) + 1;
			}
			return {
				prNumber,
				...(last.itemId ? { itemId: last.itemId } : {}),
				rolls: rs.length,
				distinctHeads: new Set(rs.map((r) => r.headSha)).size,
				cost: rs.reduce((sum, r) => sum + (r.cost ?? 0), 0),
				costObserved: rs.filter((r) => finiteNonnegative(r.cost)).length,
				passes: rs.filter((r) => r.gate === "pass").length,
				blocks: rs.filter((r) => r.gate === "block").length,
				finalGate: last.gate,
				finalSurvivors: last.survivorCount ?? 0,
				finalSurvivorsObserved: finiteNonnegative(last.survivorCount) && Number.isInteger(last.survivorCount),
				agreements,
			};
		})
		.sort((a, b) => b.cost - a.cost);
}

export interface ProfileCoverage {
	fleetRolls: number;
	instrumented: number;
	overlappingPrs: number;
	profiles: Array<{ profile: ReviewIntensityProfile; prs: number; rolls: number; repeatRolls: number; reachedPass: number; rollsPerPr: number }>;
}

function profileCoverage(records: readonly GateRecord[]): ProfileCoverage {
	const fleet = records.filter((record) => record.schemaVersion === 2 && record.producer === "fleet");
	const byProfile = new Map<ReviewIntensityProfile, GateRecord[]>(REVIEW_INTENSITY_PROFILES.map((profile) => [profile, []]));
	for (const record of fleet) {
		try {
			const selection = validatePrReviewParticipation(record.participation).selection;
			if (selection) byProfile.get(selection.profile)?.push(record);
		} catch {
			/* absent or invalid metadata is unknown, never a full-profile observation */
		}
	}
	const observedPrs = new Map<number, Set<ReviewIntensityProfile>>();
	const profiles = REVIEW_INTENSITY_PROFILES.map((profile) => {
		const rolls = byProfile.get(profile) ?? [];
		const prs = rollupByPr(rolls);
		for (const pr of prs) {
			const seen = observedPrs.get(pr.prNumber) ?? new Set<ReviewIntensityProfile>();
			seen.add(profile);
			observedPrs.set(pr.prNumber, seen);
		}
		return { profile, prs: prs.length, rolls: rolls.length, repeatRolls: rolls.length - prs.length, reachedPass: prs.filter((pr) => pr.passes > 0).length, rollsPerPr: prs.length === 0 ? 0 : Number((rolls.length / prs.length).toFixed(2)) };
	});
	return { fleetRolls: fleet.length, instrumented: profiles.reduce((sum, row) => sum + row.rolls, 0), overlappingPrs: [...observedPrs.values()].filter((profiles) => profiles.size > 1).length, profiles };
}

export interface Baseline {
	costCoverage: MeasurementSummary;
	survivorCoverage: MeasurementSummary;
	reviewIntensity: ProfileCoverage;
	prs: number;
	rolls: number;
	totalCost: number;
	costPerRoll: number;
	rollsPerPr: number;
	singleRollPrs: number;
	repeatRollPrs: number;
	reachedPass: number;
	costPerPassingPr: number;
	survivorsPerBlock: number;
	agreements: Record<string, number>;
	/** Blocks whose breaker was `invalid-pass` while the record was structurally complete (ok=true):
	 *  the #525/#593 mislabel — a genuine verdict SPLIT riding the invalid channel. */
	mislabelledSplits: number;
	/** Classified confirmed-survivor observations only. Absence is not a fifth mode. */
	closureModes: Record<ReviewFindingClosure, number>;
	/** Well-shaped `securityReview` objects only. Historical absence is not “not triggered”. */
	securityReview: {
		fleetRolls: number;
		instrumented: number;
		triggered: number;
		redTeamOnlyMustFixes: number;
	};
}

export function summarize(records: readonly GateRecord[]): Baseline {
	const rollups = rollupByPr(records);
	const blocks = records.filter((r) => r.gate === "block");
	const totalCost = records.reduce((sum, r) => sum + (r.cost ?? 0), 0);
	const reachedPass = rollups.filter((r) => r.passes > 0).length;
	const agreements: Record<string, number> = {};
	for (const r of records) {
		const key = r.agreement ?? "unknown";
		agreements[key] = (agreements[key] ?? 0) + 1;
	}
	const div = (n: number, d: number): number => (d === 0 ? 0 : Number((n / d).toFixed(2)));
	const closureModes = Object.fromEntries(REVIEW_FINDING_CLOSURES.map((mode) => [mode, 0])) as Record<ReviewFindingClosure, number>;
	let fleetRolls = 0;
	let instrumented = 0;
	let triggered = 0;
	let redTeamOnlyMustFixes = 0;
	for (const r of records) {
		if (r.schemaVersion !== 2 || r.producer !== "fleet") continue;
		fleetRolls++;
		const observations = r.recurrenceFindings;
		if (Array.isArray(observations)) {
			for (const observation of observations) {
				if (!observation || typeof observation !== "object") continue;
				const mode = observation.closure;
				if (typeof mode !== "string" || !(REVIEW_FINDING_CLOSURES as readonly string[]).includes(mode)) continue;
				closureModes[mode as ReviewFindingClosure] += 1;
			}
		}
		const securityReview = validatedSecurityReview(r.securityReview);
		if (!securityReview) continue;
		instrumented++;
		if (securityReview.triggered) triggered++;
		const standard = new Set(securityReview.standardMustFixDigests);
		const redTeamOnly = new Set<string>();
		for (const digest of securityReview.redTeamMustFixDigests) {
			if (standard.has(digest)) continue;
			redTeamOnly.add(digest);
		}
		redTeamOnlyMustFixes += redTeamOnly.size;
	}
	return {
		costCoverage: measurementSummary(
			records.map((record) => record.cost),
			false,
		),
		survivorCoverage: measurementSummary(blocks.map((record) => record.survivorCount)),
		reviewIntensity: profileCoverage(records),
		prs: rollups.length,
		rolls: records.length,
		totalCost: Number(totalCost.toFixed(2)),
		costPerRoll: div(totalCost, records.length),
		rollsPerPr: div(records.length, rollups.length),
		singleRollPrs: rollups.filter((r) => r.rolls === 1).length,
		repeatRollPrs: rollups.filter((r) => r.rolls > 1).length,
		reachedPass,
		costPerPassingPr: div(totalCost, reachedPass),
		survivorsPerBlock: div(
			blocks.reduce((sum, r) => sum + (r.survivorCount ?? 0), 0),
			blocks.length,
		),
		agreements,
		mislabelledSplits: records.filter((r) => r.ok && r.breakerReason === "invalid-pass" && r.agreement === "disagreement").length,
		closureModes,
		securityReview: { fleetRolls, instrumented, triggered, redTeamOnlyMustFixes },
	};
}

function validatedSecurityReview(value: unknown): PrReviewSecurityTelemetry | undefined {
	try {
		return validatePrReviewSecurityTelemetry(value);
	} catch {
		return undefined;
	}
}

/** Stable CLI table rows. Existing rows stay in order; the closure row is appended. */
export function formatBaselineRows(s: Baseline): string {
	const cost = s.costCoverage;
	const survivors = s.survivorCoverage;
	return [
		`  PRs gated                ${s.prs}`,
		`  rolls                    ${s.rolls}   (${s.rollsPerPr} per PR)`,
		`  single-roll / repeat     ${s.singleRollPrs} / ${s.repeatRollPrs}`,
		`  reached a pass           ${s.reachedPass} of ${s.prs}`,
		`  cost                     ${cost.observed === 0 ? "unavailable" : cost.unknown > 0 ? `$${cost.sum} observed (${cost.observed}/${cost.total} rolls; incomplete total)` : `$${s.totalCost}   ($${s.costPerRoll}/roll, $${s.costPerPassingPr}/passing PR)`}`,
		`  survivors per block      ${survivors.observed === 0 ? "unavailable" : survivors.unknown > 0 ? `${survivors.mean} observed mean (${survivors.observed}/${survivors.total} block rolls)` : s.survivorsPerBlock}`,
		`  agreement               ${Object.entries(s.agreements)
			.map(([k, v]) => ` ${k}=${v}`)
			.join("")}`,
		`  mislabelled splits       ${s.mislabelledSplits}  (ok=true + disagreement stamped invalid-pass)`,
		`  closure modes            patch=${s.closureModes.patch} construction=${s.closureModes.construction} authority=${s.closureModes.authority} policy=${s.closureModes.policy}   (classified confirmed-survivor observations)`,
		`  security-review coverage  ${s.securityReview.instrumented} / ${s.securityReview.fleetRolls} instrumented fleet rolls`,
		`  red-team trigger rate     ${s.securityReview.triggered} / ${s.securityReview.instrumented} (${s.securityReview.instrumented === 0 ? "0" : ((100 * s.securityReview.triggered) / s.securityReview.instrumented).toFixed(0)}%)`,
		`  red-team-only must-fixes  ${s.securityReview.redTeamOnlyMustFixes}   (verified surviving digest set-difference)`,
		`  profile coverage         ${s.reviewIntensity.instrumented} / ${s.reviewIntensity.fleetRolls} fleet rolls (historical/malformed selection unknown)`,
		...s.reviewIntensity.profiles.map((row) => `  profile ${row.profile.padEnd(16)} PRs=${row.prs} rolls=${row.rolls} repeats=${row.repeatRolls} rolls/PR=${row.rollsPerPr} reached-pass=${row.reachedPass}`),
		`  overlapping profile PRs  ${s.reviewIntensity.overlappingPrs} (each PR counts in every observed profile; cohorts are not exclusive)`,
		"  profile landings         unavailable (gate pass is not observed landing)",
		"  post-landing must-fixes   unavailable (not recorded by the gate corpus)",
	].join("\n");
}

/** Stable fingerprint of the exact corpus a number was computed from. A baseline that cannot name
 *  its inputs is not reproducible: this corpus grows while you work, and figures quoted from an
 *  earlier run silently stop matching a later one. */
export function corpusDigest(records: readonly GateRecord[]): string {
	const ids = records.map((r) => `${r.prNumber}-${r.headSha}`).sort();
	return `${ids.length}:${createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 12)}`;
}

function main(): void {
	const args = process.argv.slice(2);
	const option = (flag: string): string | undefined => {
		const index = args.indexOf(flag);
		return index < 0 ? undefined : args[index + 1];
	};
	const until = option("--until");
	const authoringDir = option("--authoring-dir");
	if ((args.includes("--until") && !validDate(until)) || (args.includes("--authoring-dir") && (!authoringDir || authoringDir.startsWith("--")))) {
		process.stdout.write("metrics unavailable: --until needs a valid date and --authoring-dir needs a directory\n");
		return;
	}
	const positional = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--until" && args[index - 1] !== "--authoring-dir");
	const dir = positional[0] ?? join(repoRoot(), ".dev", "pr-review-gate-records");
	const pr = loadReviewCorpus(dir, "pr", until);
	const records = pr.records;
	if (records.length === 0) process.stdout.write(`no gate records under ${dir}\n`);
	else {
		const s = summarize(records);
		const span = `${records[0].reviewedAt?.slice(0, 10) ?? "unknown"} → ${records[records.length - 1].reviewedAt?.slice(0, 10) ?? "unknown"}`;
		process.stdout.write(`\nFleet gate baseline  (${span})\n  corpus ${corpusDigest(records)}${until ? `  --until ${until}` : "  (live)"}\n${"─".repeat(72)}\n${formatBaselineRows(s)}\n`);
		process.stdout.write(`\n  per PR (by cost)\n  ${"─".repeat(68)}\n`);
		process.stdout.write(`  ${"PR".padEnd(6)}${"item".padEnd(7)}${"rolls".padEnd(7)}${"heads".padEnd(7)}${"cost".padEnd(10)}${"final".padEnd(8)}surv\n`);
		for (const r of rollupByPr(records)) {
			const cost = r.costObserved === 0 ? "unavailable" : r.costObserved < r.rolls ? `$${r.cost.toFixed(2)} observed (${r.costObserved}/${r.rolls})` : `$${r.cost.toFixed(2)}`;
			process.stdout.write(
				`  ${String(r.prNumber).padEnd(6)}${(r.itemId ?? "—").padEnd(7)}${String(r.rolls).padEnd(7)}${String(r.distinctHeads).padEnd(7)}${cost.padEnd(10)}${cost.length >= 10 ? " " : ""}${r.finalGate.padEnd(8)}${r.finalSurvivorsObserved ? r.finalSurvivors : "unavailable"}\n`,
			);
		}
	}
	process.stdout.write(
		`\n  PR rolls                  ${records.length}\n${formatCorpus(pr)}\n${formatMeasurement("PR gate elapsed", measurementSummary(records.map((r) => r.elapsedMs)), "ms")}\n${formatMeasurement(
			"PR recorded cost",
			measurementSummary(
				records.map((r) => r.cost),
				false,
			),
			"USD",
		)}\n`,
	);
	process.stdout.write("  PR cost/survivor rows disclose missing measurements; observed-only totals exclude unknown values.\n");
	if (authoringDir !== undefined) {
		const authoring = loadReviewCorpus(authoringDir, "authoring", until);
		const s = summarizeAuthoring(authoring.records);
		process.stdout.write(`\n  Widened corpus ${widenedCorpusDigest([pr, authoring])}\n  Authoring runs            ${authoring.records.length}\n${formatCorpus(authoring)}\n`);
		for (const [label, measurement] of [
			["Authoring loop elapsed", s.runs],
			["Authoring pass elapsed", s.passes],
			["Reviewer slot elapsed", s.reviewers],
			["Judge record elapsed", s.judges],
		] as const)
			process.stdout.write(`${formatMeasurement(label, measurement, "ms")}\n`);
		process.stdout.write(`${formatMeasurement("Authoring recorded cost", s.cost, "USD")}\n  Unavailable containers   ${s.unavailableContainers} (pass/seat denominators may be incomplete)\n`);
		process.stdout.write("  Loop timing includes revision; pass excludes revision; seat timing excludes admission wait. Missing seat timing does not establish launch. Concurrent seat times are not wall time.\n");
	}
	process.stdout.write("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
