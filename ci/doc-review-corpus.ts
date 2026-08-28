/**
 * Scoped fixture export of the local document-review corpus in `.dev/doc-review-records/`.
 *
 * This exists because `.dev/` is gitignored — deliberately, so its churn cannot false-fire the
 * git-state confinement audit — which also means it is absent from every claim worktree. An item
 * that must diagnose seat behaviour FROM those records therefore cannot run in a cycle at all
 * (#677 blocked on exactly this). Sharing or symlinking `.dev/` into a worktree would fix the
 * symptom by spending the property that makes the audit trustworthy, so instead the harness
 * exports a scoped, fingerprinted COPY that is tracked in git and is therefore present wherever
 * the branch is.
 *
 * The general form of this — declared step inputs materialised by the harness — is #685. This is
 * the narrow stopgap that unblocks its first consumer.
 *
 * Scope: seat OUTCOMES only. Document paths, digests and byte lengths are dropped (they describe
 * what was reviewed, not how the seat behaved). Records carry no `assistantText` or `subtype`, so
 * there is no model text to leak — which is also precisely why this corpus cannot settle
 * decoration-vs-non-emission, and why #677 needs new instrumentation for that half.
 *
 * Regenerate:  npx tsx ci/doc-review-corpus.ts --write
 * Inspect:     npx tsx ci/doc-review-corpus.ts
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORDS_DIR = join(repo, ".dev", "doc-review-records");
const FIXTURE = join(repo, "ci", "doc-review-seat-corpus.json");

export type UnreadableSourceFacts = { chars: number; hasStartMarker: boolean; hasEndMarker: boolean };
export type ProjectedSeatOutput = { state: "readable"; payload: "empty" | "non-empty" } | { state: "unreadable"; code?: string; source?: UnreadableSourceFacts };
export type ProjectedSeatAttempt =
	| { completion: "returned"; attempt: number; ok: boolean; subtype: string; cost: number; turns: number; output: ProjectedSeatOutput }
	| { completion: "rejected"; attempt: number; reason: "seat-rejected"; cost: 0; turns: 0 };
export type JudgeSkipReason = "no-reviewer-completed" | "cross-model-split";

export interface SeatOutcome {
	runId: string;
	createdAt: string;
	pass: number;
	role: "reviewer" | "judge";
	seatId?: string;
	provider?: string;
	model?: string;
	/** reviewer `ok`, judge `valid` — the harness's own readability verdict for the seat. */
	readable: boolean;
	turns?: number;
	cost?: number;
	/** Harness-authored diagnostic. Classified by the consumer; never relabelled here. */
	diagnostic?: string;
	verdict?: string;
	subtype?: string;
	attempts?: ProjectedSeatAttempt[] | "legacy-unobserved";
	skipped?: JudgeSkipReason;
	source?: UnreadableSourceFacts;
}

export interface RunSummary {
	runId: string;
	diversityState: "met" | "softened" | "legacy-unobserved";
}

export interface SeatCorpus {
	fingerprint: string;
	recordCount: number;
	seatCount: number;
	generatedFrom: string;
	note: string;
	seats: SeatOutcome[];
	runs?: RunSummary[];
}

export interface Fraction {
	numerator: number;
	denominator: number;
}

export interface AttributionCount {
	role: "reviewer" | "judge";
	provider?: string;
	model?: string;
	count: number;
}

export interface SourceFactCount {
	source: UnreadableSourceFacts | "legacy-unobserved";
	count: number;
}

export interface SeatReadabilityMeasurement {
	fingerprint: string;
	recordCount: number;
	seatCount: number;
	judgeInvalid: Fraction;
	judgeBlockNotFound: Fraction;
	judgeSplitSkipped: Fraction;
	reviewerUnreadable: Fraction;
	reviewerBlockNotFound: Fraction;
	diversitySoftened: Fraction | { unavailable: true };
	blockNotFoundByModel: AttributionCount[];
	blockNotFoundByTurns: Array<{ turns: number | undefined; count: number }>;
	unreadableSourceFacts: SourceFactCount[];
	firstAttemptUnreadable: Fraction | { unavailable: true };
	finalAttemptUnreadable: Fraction | { unavailable: true };
}

interface RawSeat {
	identity?: { seatId?: string; provider?: string; model?: string };
	ok?: boolean;
	valid?: boolean;
	turns?: number;
	cost?: number;
	diagnostic?: string;
	verdict?: { verdict?: string };
	attempts?: unknown;
	skipped?: unknown;
	subtype?: unknown;
}

interface RawPass {
	pass?: number;
	reviewers?: RawSeat[];
	judge?: RawSeat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectAttempts(raw: RawSeat): ProjectedSeatAttempt[] | "legacy-unobserved" {
	if (!Array.isArray(raw.attempts)) return "legacy-unobserved";
	const projected: ProjectedSeatAttempt[] = [];
	for (const item of raw.attempts) {
		if (!isRecord(item)) continue;
		if (item.completion === "rejected") {
			projected.push({ completion: "rejected", attempt: typeof item.attempt === "number" ? item.attempt : 1, reason: "seat-rejected", cost: 0, turns: 0 });
			continue;
		}
		if (item.completion !== "returned" || !isRecord(item.output)) continue;
		const output = projectOutput(item.output);
		if (!output) continue;
		projected.push({
			completion: "returned",
			attempt: typeof item.attempt === "number" ? item.attempt : 1,
			ok: item.ok === true,
			subtype: typeof item.subtype === "string" ? item.subtype : "",
			cost: typeof item.cost === "number" ? item.cost : 0,
			turns: typeof item.turns === "number" ? item.turns : 0,
			output,
		});
	}
	return projected;
}

function projectOutput(raw: Record<string, unknown>): ProjectedSeatOutput | undefined {
	if (raw.state === "readable") {
		return { state: "readable", payload: raw.payload === "empty" ? "empty" : "non-empty" };
	}
	if (raw.state === "unreadable" && typeof raw.code === "string") {
		const source =
			isRecord(raw.source) && typeof raw.source.chars === "number" && typeof raw.source.hasStartMarker === "boolean" && typeof raw.source.hasEndMarker === "boolean"
				? { chars: raw.source.chars, hasStartMarker: raw.source.hasStartMarker, hasEndMarker: raw.source.hasEndMarker }
				: undefined;
		return { state: "unreadable", code: raw.code, ...(source ? { source } : {}) };
	}
	return undefined;
}

function lastReturned(attempts: ProjectedSeatAttempt[]): Extract<ProjectedSeatAttempt, { completion: "returned" }> | undefined {
	for (let i = attempts.length - 1; i >= 0; i--) {
		const item = attempts[i];
		if (item.completion === "returned") return item;
	}
	return undefined;
}

function lastUnreadableSource(attempts: ProjectedSeatAttempt[]): UnreadableSourceFacts | undefined {
	for (let i = attempts.length - 1; i >= 0; i--) {
		const item = attempts[i];
		if (item.completion === "returned" && item.output.state === "unreadable" && item.output.source) return item.output.source;
	}
	return undefined;
}

function projectSeat(role: "reviewer" | "judge", runId: string, createdAt: string, passNumber: number, raw: RawSeat): SeatOutcome {
	const attempts = projectAttempts(raw);
	const returned = Array.isArray(attempts) ? lastReturned(attempts) : undefined;
	const source = Array.isArray(attempts) ? lastUnreadableSource(attempts) : undefined;
	const skipped = raw.skipped === "no-reviewer-completed" || raw.skipped === "cross-model-split" ? raw.skipped : undefined;
	const subtype = typeof raw.subtype === "string" ? raw.subtype : returned?.subtype;
	return {
		runId,
		createdAt,
		pass: passNumber,
		role,
		seatId: raw.identity?.seatId,
		provider: raw.identity?.provider,
		model: raw.identity?.model,
		readable: role === "judge" ? raw.valid === true : raw.ok === true,
		turns: raw.turns,
		cost: raw.cost,
		diagnostic: raw.diagnostic,
		verdict: raw.verdict?.verdict,
		attempts,
		...(subtype ? { subtype } : {}),
		...(skipped ? { skipped } : {}),
		...(source ? { source } : {}),
	};
}

export function buildCorpus(dir = RECORDS_DIR): SeatCorpus {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort();
	const hash = createHash("sha256");
	const seats: SeatOutcome[] = [];
	for (const file of files) {
		const raw = readFileSync(join(dir, file));
		hash.update(raw);
		const record = JSON.parse(raw.toString("utf8"));
		const runId: string = record.runId ?? file.replace(/\.json$/, "");
		const createdAt: string = record.createdAt ?? "";
		const passes: RawPass[] = record.result?.passes ?? [];
		passes.forEach((pass, index) => {
			const passNumber: number = pass.pass ?? index + 1;
			for (const reviewer of pass.reviewers ?? []) {
				seats.push({
					runId,
					createdAt,
					pass: passNumber,
					role: "reviewer",
					seatId: reviewer.identity?.seatId,
					provider: reviewer.identity?.provider,
					model: reviewer.identity?.model,
					readable: reviewer.ok === true,
					turns: reviewer.turns,
					cost: reviewer.cost,
					diagnostic: reviewer.diagnostic,
					verdict: reviewer.verdict?.verdict,
				});
			}
			if (pass.judge) {
				seats.push({
					runId,
					createdAt,
					pass: passNumber,
					role: "judge",
					seatId: pass.judge.identity?.seatId,
					provider: pass.judge.identity?.provider,
					model: pass.judge.identity?.model,
					readable: pass.judge.valid === true,
					turns: pass.judge.turns,
					cost: pass.judge.cost,
					diagnostic: pass.judge.diagnostic,
				});
			}
		});
	}
	return {
		fingerprint: `${files.length}:${hash.digest("hex").slice(0, 12)}`,
		recordCount: files.length,
		seatCount: seats.length,
		generatedFrom: ".dev/doc-review-records/",
		note: "Seat outcomes only. Scoped export — see ci/doc-review-corpus.ts. Regenerate with --write.",
		seats,
	};
}

/** Rich projection for local measurement only; it is never passed to the tracked-fixture writer. */
export function buildLiveReadabilityCorpus(dir = RECORDS_DIR): SeatCorpus {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort();
	const hash = createHash("sha256");
	const seats: SeatOutcome[] = [];
	const runs: RunSummary[] = [];
	for (const file of files) {
		const raw = readFileSync(join(dir, file));
		hash.update(raw);
		const record = JSON.parse(raw.toString("utf8"));
		const runId: string = record.runId ?? file.replace(/\.json$/, "");
		const createdAt: string = record.createdAt ?? "";
		const diversity = record.result?.diversity?.state;
		runs.push({
			runId,
			diversityState: diversity === "met" || diversity === "softened" ? diversity : "legacy-unobserved",
		});
		const passes: RawPass[] = record.result?.passes ?? [];
		passes.forEach((pass, index) => {
			const passNumber: number = pass.pass ?? index + 1;
			for (const reviewer of pass.reviewers ?? []) {
				seats.push(projectSeat("reviewer", runId, createdAt, passNumber, reviewer));
			}
			if (pass.judge) {
				seats.push(projectSeat("judge", runId, createdAt, passNumber, pass.judge));
			}
		});
	}
	return {
		fingerprint: `${files.length}:${hash.digest("hex").slice(0, 12)}`,
		recordCount: files.length,
		seatCount: seats.length,
		generatedFrom: ".dev/doc-review-records/",
		note: "Seat outcomes only. Scoped export — see ci/doc-review-corpus.ts. Regenerate with --write.",
		seats,
		runs,
	};
}

export function loadTrackedCorpus(path = FIXTURE): SeatCorpus {
	return JSON.parse(readFileSync(path, "utf8")) as SeatCorpus;
}

function fraction(numerator: number, denominator: number): Fraction {
	return { numerator, denominator };
}

function isSkippedJudge(seat: SeatOutcome): boolean {
	if (seat.role !== "judge") return false;
	if (seat.skipped) return true;
	return typeof seat.diagnostic === "string" && seat.diagnostic.startsWith("skipped:");
}

function isSplitSkipped(seat: SeatOutcome): boolean {
	if (seat.role !== "judge") return false;
	if (seat.skipped === "cross-model-split") return true;
	if (seat.skipped) return false;
	return seat.diagnostic === "skipped: human adjudication required";
}

function lastAttemptWithCode(attempts: ProjectedSeatAttempt[], code: string): Extract<ProjectedSeatAttempt, { completion: "returned" }> | undefined {
	for (let i = attempts.length - 1; i >= 0; i--) {
		const attempt = attempts[i];
		if (attempt.completion === "returned" && attempt.output.state === "unreadable" && attempt.output.code === code) return attempt;
	}
	return undefined;
}

function isBlockNotFound(seat: SeatOutcome): boolean {
	if (Array.isArray(seat.attempts)) return lastAttemptWithCode(seat.attempts, "block-not-found") !== undefined;
	return /block not found/i.test(seat.diagnostic ?? "");
}

function isAttemptUnreadable(attempt: ProjectedSeatAttempt | undefined): boolean {
	if (!attempt) return true;
	if (attempt.completion === "rejected") return true;
	return attempt.output.state === "unreadable";
}

export function measureSeatReadability(corpus: SeatCorpus): SeatReadabilityMeasurement {
	const judges = corpus.seats.filter((seat) => seat.role === "judge");
	const reviewers = corpus.seats.filter((seat) => seat.role === "reviewer");
	const judgeInvalid = judges.filter((seat) => !seat.readable && !isSkippedJudge(seat));
	const judgeBlockNotFound = judges.filter(isBlockNotFound);
	const judgeSplitSkipped = judges.filter(isSplitSkipped);
	const reviewerUnreadable = reviewers.filter((seat) => !seat.readable);
	const reviewerBlockNotFound = reviewers.filter(isBlockNotFound);
	const blockNotFound = corpus.seats.filter(isBlockNotFound);

	const byModel = new Map<string, AttributionCount>();
	for (const seat of blockNotFound) {
		const key = `${seat.role}\0${seat.provider ?? ""}\0${seat.model ?? ""}`;
		const current = byModel.get(key) ?? { role: seat.role, provider: seat.provider, model: seat.model, count: 0 };
		current.count += 1;
		byModel.set(key, current);
	}

	const byTurns = new Map<string, { turns: number | undefined; count: number }>();
	for (const seat of blockNotFound) {
		const matchingAttempt = Array.isArray(seat.attempts) ? lastAttemptWithCode(seat.attempts, "block-not-found") : undefined;
		const turns = Array.isArray(seat.attempts) ? matchingAttempt?.turns : seat.turns;
		const key = turns === undefined ? "unset" : String(turns);
		const current = byTurns.get(key) ?? { turns, count: 0 };
		current.count += 1;
		byTurns.set(key, current);
	}

	const bySource = new Map<string, SourceFactCount>();
	for (const seat of blockNotFound) {
		const matchingAttempt = Array.isArray(seat.attempts) ? lastAttemptWithCode(seat.attempts, "block-not-found") : undefined;
		const source = Array.isArray(seat.attempts) ? (matchingAttempt?.output.state === "unreadable" ? matchingAttempt.output.source : undefined) : seat.source;
		const bucket: SourceFactCount = source ? { source, count: 0 } : { source: "legacy-unobserved", count: 0 };
		const key = source ? `${source.chars}:${source.hasStartMarker}:${source.hasEndMarker}` : "legacy-unobserved";
		const current = bySource.get(key) ?? bucket;
		current.count += 1;
		bySource.set(key, current);
	}

	const observedRuns = (corpus.runs ?? []).filter((run) => run.diversityState === "met" || run.diversityState === "softened");
	const diversitySoftened: SeatReadabilityMeasurement["diversitySoftened"] = observedRuns.length === 0 ? { unavailable: true } : fraction(observedRuns.filter((run) => run.diversityState === "softened").length, observedRuns.length);

	const withAttempts = corpus.seats.filter((seat) => Array.isArray(seat.attempts) && seat.attempts.length > 0);
	const paired: SeatReadabilityMeasurement["firstAttemptUnreadable"] =
		withAttempts.length === 0 ? { unavailable: true } : fraction(withAttempts.filter((seat) => isAttemptUnreadable((seat.attempts as ProjectedSeatAttempt[])[0])).length, withAttempts.length);
	const pairedFinal: SeatReadabilityMeasurement["finalAttemptUnreadable"] =
		withAttempts.length === 0
			? { unavailable: true }
			: fraction(
					withAttempts.filter((seat) => {
						const attempts = seat.attempts as ProjectedSeatAttempt[];
						return isAttemptUnreadable(attempts[attempts.length - 1]);
					}).length,
					withAttempts.length,
				);

	return {
		fingerprint: corpus.fingerprint,
		recordCount: corpus.recordCount,
		seatCount: corpus.seatCount,
		judgeInvalid: fraction(judgeInvalid.length, judges.length),
		judgeBlockNotFound: fraction(judgeBlockNotFound.length, judges.length),
		judgeSplitSkipped: fraction(judgeSplitSkipped.length, judges.length),
		reviewerUnreadable: fraction(reviewerUnreadable.length, reviewers.length),
		reviewerBlockNotFound: fraction(reviewerBlockNotFound.length, reviewers.length),
		diversitySoftened,
		blockNotFoundByModel: [...byModel.values()].sort((a, b) => b.count - a.count || `${a.role}${a.provider}${a.model}`.localeCompare(`${b.role}${b.provider}${b.model}`)),
		blockNotFoundByTurns: [...byTurns.values()].sort((a, b) => (a.turns ?? -1) - (b.turns ?? -1)),
		unreadableSourceFacts: [...bySource.values()].sort((a, b) => b.count - a.count),
		firstAttemptUnreadable: paired,
		finalAttemptUnreadable: pairedFinal,
	};
}

export function formatFraction(value: Fraction): string {
	const pct = value.denominator === 0 ? "n/a" : `${((100 * value.numerator) / value.denominator).toFixed(1)}%`;
	return `${value.numerator}/${value.denominator} (${pct})`;
}

export function formatSeatReadabilityReport(measurement: SeatReadabilityMeasurement): string {
	const diversity = "unavailable" in measurement.diversitySoftened ? "unavailable" : formatFraction(measurement.diversitySoftened);
	const first = "unavailable" in measurement.firstAttemptUnreadable ? "unavailable" : formatFraction(measurement.firstAttemptUnreadable);
	const final = "unavailable" in measurement.finalAttemptUnreadable ? "unavailable" : formatFraction(measurement.finalAttemptUnreadable);
	const attribution = measurement.blockNotFoundByModel.map((row) => `  ${row.role} ${row.provider ?? "?"}/${row.model ?? "?"}: ${row.count}`).join("\n");
	const turns = measurement.blockNotFoundByTurns.map((row) => `  turns=${row.turns ?? "unset"}: ${row.count}`).join("\n");
	const sources = measurement.unreadableSourceFacts
		.map((row) => (row.source === "legacy-unobserved" ? `  legacy-unobserved: ${row.count}` : `  chars=${row.source.chars} start=${row.source.hasStartMarker} end=${row.source.hasEndMarker}: ${row.count}`))
		.join("\n");
	return [
		`fingerprint=${measurement.fingerprint} records=${measurement.recordCount} seats=${measurement.seatCount}`,
		`judge invalid: ${formatFraction(measurement.judgeInvalid)}`,
		`judge block-not-found: ${formatFraction(measurement.judgeBlockNotFound)}`,
		`judge split-skipped: ${formatFraction(measurement.judgeSplitSkipped)}`,
		`reviewer unreadable: ${formatFraction(measurement.reviewerUnreadable)}`,
		`reviewer block-not-found: ${formatFraction(measurement.reviewerBlockNotFound)}`,
		`diversity softened: ${diversity}`,
		`first-attempt unreadable: ${first}`,
		`final-attempt unreadable: ${final}`,
		"block-not-found by provider/model:",
		attribution || "  (none)",
		"block-not-found by turns:",
		turns || "  (none)",
		"block-not-found source facts:",
		sources || "  (none)",
	].join("\n");
}

/** Entry-point only: importing this module must not read the filesystem or write the fixture. */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\u0000")) {
	const write = process.argv.includes("--write");
	const corpus = write ? buildCorpus() : existsSync(RECORDS_DIR) ? buildLiveReadabilityCorpus() : loadTrackedCorpus();
	if (write) {
		writeFileSync(FIXTURE, `${JSON.stringify(corpus, null, "\t")}\n`);
		console.log(`wrote ${FIXTURE}`);
	}
	const measurement = measureSeatReadability(corpus);
	const unreadable = corpus.seats.filter((s) => !s.readable);
	console.log(formatSeatReadabilityReport(measurement));
	console.log(`unreadable seats: ${unreadable.length} (${measurement.seatCount === 0 ? 0 : Math.round((100 * unreadable.length) / measurement.seatCount)}%)`);
}
