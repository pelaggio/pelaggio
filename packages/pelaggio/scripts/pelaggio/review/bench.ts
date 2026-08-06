/**
 * Tier A authoring-review benchmark: deterministic, zero-LLM replay harness (#291).
 *
 * Replays committed reviewer/Judge assistant outputs through the REAL `runReviewLoop` in its typed
 * `mode: "no-revise"` branch, then scores the resulting gate decisions against human-authored goldens
 * and an aggregate recall/safety-FN baseline. Every seat response is a recording selected by
 * `(role, seatId, pass)`; costs are fixed at zero and no provider/SDK/credential module is reachable
 * from this file's import graph — the no-live-call guarantee is structural, not conventional.
 *
 * The scorer is the gate: exact per-fixture goldens are the controller-contract guard, and the
 * committed baseline is the efficacy regression threshold (recall may not fall, safety FN may not rise).
 * A baseline refresh is deliberately not available from replay.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
// Type-only: erased at runtime, so the config module (and its credential surface) never enters the
// import graph. The whole point of importing loop/findings/taxonomy but never config/step-runner/SDK.
import type { AuthoringReviewConfig, ReviewSlot } from "../config.js";
import type { ParkSignal } from "../types.js";
import { type ReviewFindingClass, reviewFindingFingerprint } from "./findings.js";
import { type ReviewCandidate, type ReviewLoopResult, type ReviewOutcome, type RunSeatFn, runReviewLoop } from "./loop.js";
import { BASELINE_TAXONOMY, isSafetyClass } from "./taxonomy.js";

export { reviewFindingFingerprint };

// ── Domain types ───────────────────────────────────────────────────────────

export type BenchRole = "reviewer" | "judge";
/** Benchmark gate disposition: mapped from the loop's terminal survivor set (not the loop's own outcome). */
export type BenchGate = "pass" | "block" | "park";
export type BenchDiversity = "met" | "softened";

/** One recorded seat response, addressed by the identity tuple the replay seat resolves. */
export interface SeatRecording {
	role: BenchRole;
	seatId: string;
	pass: number;
	/** The model-authored final message (parsed via `modelAuthoredText`); never a tool transcript. */
	assistantText: string;
}

/** Minimal policy the fixture pins; the harness fills the invariant `AuthoringReviewConfig` fields. */
export interface BenchPolicy {
	reviewers: ReviewSlot[];
	judge: ReviewSlot;
	maxPasses: number;
	budgetCap: number;
}

/** Human-authored ground-truth blocker: a fingerprint plus the class used only for safety membership. */
export interface BenchGroundTruthBlocker {
	fingerprint: string;
	class: ReviewFindingClass;
}

/** Recorded inputs + human truth for one case. Kept separate from the golden so editing a transcript drifts. */
export interface BenchFixture {
	schemaVersion: 1;
	id: string;
	description: string;
	policy: BenchPolicy;
	classificationContext: { changedFiles: string[] };
	recordings: SeatRecording[];
	groundTruthBlockers: BenchGroundTruthBlocker[];
}

/** Expected terminal controller behavior for one case (reviewed independently of the transcripts). */
export interface BenchGolden {
	schemaVersion: 1;
	outcome: ReviewOutcome;
	gate: BenchGate;
	/** Sorted terminal must-fix survivor fingerprints. */
	survivorFingerprints: string[];
	diversity: BenchDiversity;
}

export interface BenchManifest {
	schemaVersion: 1;
	fixtures: string[];
}

/** Reviewed aggregate regression threshold + diagnostic confusion counts. */
export interface BenchBaseline {
	schemaVersion: 1;
	recall: number;
	safetyFn: number;
	tp: number;
	fp: number;
	fn: number;
	precision: number;
}

export interface BenchCorpus {
	manifest: BenchManifest;
	fixtures: Array<{ id: string; fixture: BenchFixture; golden: BenchGolden }>;
	baseline: BenchBaseline;
}

export interface BenchConfusion {
	tp: number;
	fp: number;
	fn: number;
}

export interface BenchFixtureResult {
	id: string;
	outcome: ReviewOutcome;
	gate: BenchGate;
	survivorFingerprints: string[];
	diversity: BenchDiversity;
	predictedBlockers: string[];
	groundTruthBlockers: string[];
	confusion: BenchConfusion;
	safetyFn: number;
	goldenMatch: boolean;
	goldenDiffs: string[];
}

export interface BenchAggregate {
	tp: number;
	fp: number;
	fn: number;
	precision: number;
	recall: number;
	safetyFn: number;
}

export interface BenchReplayResult {
	fixtures: BenchFixtureResult[];
	aggregate: BenchAggregate;
	baseline: BenchBaseline;
	regressions: string[];
	ok: boolean;
}

export class BenchCorpusError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BenchCorpusError";
	}
}

/** Default corpus location, resolved relative to this module — independent of the caller's cwd. */
export const CORPUS_URL = new URL("../__tests__/fixtures/review-bench/", import.meta.url);

// Constant seat prompts: replay selects a recording from the `SeatRequest` identity tuple, never from
// prompt contents. They exist only because `runReviewLoop` requires prompt builders.
const REPLAY_REVIEW_PROMPT = "review-bench replay: review seat (prompt is not consulted)";
const REPLAY_JUDGE_PROMPT = "review-bench replay: judge seat (prompt is not consulted)";

// ── Replay seat ──────────────────────────────────────────────────────────

/**
 * Build a replay `RunSeatFn` that resolves each request to its `(role, seatId, pass)` recording and
 * returns a deterministic zero-cost `StepResult`. Missing, duplicate, or unused recordings are invalid
 * fixture data — never a synthesized answer. `author` requests are unreachable in `no-revise`.
 *
 * `runReviewLoop` swallows a thrown seat error (reviewers via `Promise.allSettled`, the judge seat in a
 * try/catch that returns `hard-block`). So a missing/double-requested recording would be MASKED as a
 * plausible outcome instead of surfaced. The seat therefore records each anomaly in a side channel AND
 * throws (so it never fabricates a success); `assertConsistent()` — called after the loop returns —
 * re-raises any missing/duplicate/unused recording as invalid fixture data.
 */
export function createReplaySeat(fixture: BenchFixture): { seat: RunSeatFn; assertConsistent: () => void } {
	const recordings = new Map<string, { recording: SeatRecording; consumed: boolean }>();
	for (const recording of fixture.recordings) {
		const key = recordingKey(recording.role, recording.seatId, recording.pass);
		if (recordings.has(key)) throw new BenchCorpusError(`fixture ${fixture.id} has a duplicate recording for ${key}`);
		recordings.set(key, { recording, consumed: false });
	}
	const anomalies: string[] = [];
	const seat: RunSeatFn = async (request) => {
		if (request.role === "author") {
			const message = `reached an author seat, which is unreachable in no-revise replay`;
			anomalies.push(message);
			throw new BenchCorpusError(`fixture ${fixture.id} ${message}`);
		}
		const key = recordingKey(request.role, request.slot.id, request.pass);
		const entry = recordings.get(key);
		if (!entry) {
			const message = `is missing a recording for ${key}`;
			anomalies.push(message);
			throw new BenchCorpusError(`fixture ${fixture.id} ${message}`);
		}
		if (entry.consumed) {
			const message = `requested recording ${key} more than once`;
			anomalies.push(message);
			throw new BenchCorpusError(`fixture ${fixture.id} ${message}`);
		}
		entry.consumed = true;
		const text = entry.recording.assistantText;
		return { ok: true, subtype: "success", text, fullText: text, assistantText: text, cost: 0, turns: 0 };
	};
	const assertConsistent = (): void => {
		const unused = [...recordings.entries()].filter(([, value]) => !value.consumed).map(([key]) => key);
		const problems = [...anomalies, ...(unused.length > 0 ? [`has unused recording(s): ${unused.join(", ")}`] : [])];
		if (problems.length > 0) throw new BenchCorpusError(`fixture ${fixture.id} ${problems.join("; ")}`);
	};
	return { seat, assertConsistent };
}

function recordingKey(role: BenchRole, seatId: string, pass: number): string {
	return `${role}/${seatId}/p${pass}`;
}

/** Assemble the full `AuthoringReviewConfig` from the fixture's pinned policy fields. */
function buildPolicy(policy: BenchPolicy): AuthoringReviewConfig {
	return {
		enabled: true,
		reviewers: policy.reviewers,
		judge: policy.judge,
		blockingBar: "must-fix",
		maxPasses: policy.maxPasses,
		// no-revise forces this to 0 inside the loop anyway; pin it so the config is honest.
		maxRevisions: 0,
		budgetCap: policy.budgetCap,
		providerDiversity: "prefer",
	};
}

function emptyParkSignal(): ParkSignal {
	return { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };
}

// ── Scoring ────────────────────────────────────────────────────────────────

/** Benchmark gate disposition from the terminal survivor set: safety must-fix → park, other → block. */
export function gateDisposition(survivors: readonly ReviewCandidate[]): BenchGate {
	const mustFix = survivors.filter((candidate) => candidate.finding.severity === "must-fix");
	if (mustFix.length === 0) return "pass";
	if (mustFix.some((candidate) => isSafetyClass(candidate.finding.class, BASELINE_TAXONOMY))) return "park";
	return "block";
}

function byFingerprint(a: string, b: string): number {
	return a.localeCompare(b);
}

function diffGolden(golden: BenchGolden, actual: { outcome: ReviewOutcome; gate: BenchGate; survivorFingerprints: string[]; diversity: BenchDiversity }): string[] {
	const diffs: string[] = [];
	if (actual.outcome !== golden.outcome) diffs.push(`outcome ${JSON.stringify(actual.outcome)} != golden ${JSON.stringify(golden.outcome)}`);
	if (actual.gate !== golden.gate) diffs.push(`gate ${JSON.stringify(actual.gate)} != golden ${JSON.stringify(golden.gate)}`);
	if (actual.diversity !== golden.diversity) diffs.push(`diversity ${JSON.stringify(actual.diversity)} != golden ${JSON.stringify(golden.diversity)}`);
	if (JSON.stringify(actual.survivorFingerprints) !== JSON.stringify(golden.survivorFingerprints)) {
		diffs.push(`survivors ${JSON.stringify(actual.survivorFingerprints)} != golden ${JSON.stringify(golden.survivorFingerprints)}`);
	}
	return diffs;
}

/**
 * Replay one fixture through `runReviewLoop`, then score its terminal gate decision against the golden
 * and the fixture's ground truth. Throws `BenchCorpusError` on any recording irregularity.
 */
export async function replayFixture(entry: { fixture: BenchFixture; golden: BenchGolden }): Promise<BenchFixtureResult> {
	const { fixture, golden } = entry;
	const { seat, assertConsistent } = createReplaySeat(fixture);
	const loop: ReviewLoopResult = await runReviewLoop({
		policy: buildPolicy(fixture.policy),
		mode: "no-revise",
		parkSignal: emptyParkSignal(),
		classificationContext: { changedFiles: fixture.classificationContext.changedFiles },
		taxonomy: BASELINE_TAXONOMY,
		runSeat: seat,
		prompts: { review: () => REPLAY_REVIEW_PROMPT, judge: () => REPLAY_JUDGE_PROMPT },
	});
	// Surface any missing/duplicate/unused recording the loop may have swallowed as a plausible outcome.
	assertConsistent();

	const survivorFingerprints = loop.survivors.map((candidate) => candidate.fingerprint).sort(byFingerprint);
	const gate = gateDisposition(loop.survivors);
	const diversity = loop.diversity.state;
	const predicted = new Set(survivorFingerprints);
	const truth = fixture.groundTruthBlockers.map((blocker) => blocker.fingerprint);
	const truthSet = new Set(truth);
	const tp = survivorFingerprints.filter((fingerprint) => truthSet.has(fingerprint)).length;
	const fp = survivorFingerprints.filter((fingerprint) => !truthSet.has(fingerprint)).length;
	const fn = truth.filter((fingerprint) => !predicted.has(fingerprint)).length;
	const safetyFn = fixture.groundTruthBlockers.filter((blocker) => isSafetyClass(blocker.class, BASELINE_TAXONOMY) && !predicted.has(blocker.fingerprint)).length;
	const goldenDiffs = diffGolden(golden, { outcome: loop.outcome, gate, survivorFingerprints, diversity });
	return {
		id: fixture.id,
		outcome: loop.outcome,
		gate,
		survivorFingerprints,
		diversity,
		predictedBlockers: survivorFingerprints,
		groundTruthBlockers: [...truth].sort(byFingerprint),
		confusion: { tp, fp, fn },
		safetyFn,
		goldenMatch: goldenDiffs.length === 0,
		goldenDiffs,
	};
}

/** Aggregate confusion across fixtures. Empty denominators score a conventional `1` (all-clean stable). */
export function aggregateResults(results: readonly BenchFixtureResult[]): BenchAggregate {
	const tp = sum(results, (r) => r.confusion.tp);
	const fp = sum(results, (r) => r.confusion.fp);
	const fn = sum(results, (r) => r.confusion.fn);
	const safetyFn = sum(results, (r) => r.safetyFn);
	const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
	const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
	return { tp, fp, fn, precision, recall, safetyFn };
}

/** Regression check: every golden must match, recall may not fall below baseline, safety FN may not rise. */
export function compareToBaseline(aggregate: BenchAggregate, results: readonly BenchFixtureResult[], baseline: BenchBaseline): { ok: boolean; regressions: string[] } {
	const regressions: string[] = [];
	for (const result of results) {
		if (!result.goldenMatch) regressions.push(`golden mismatch [${result.id}]: ${result.goldenDiffs.join("; ")}`);
	}
	if (aggregate.recall < baseline.recall) regressions.push(`blocker recall regressed: ${aggregate.recall} < baseline ${baseline.recall}`);
	if (aggregate.safetyFn > baseline.safetyFn) regressions.push(`safety false-negatives increased: ${aggregate.safetyFn} > baseline ${baseline.safetyFn}`);
	return { ok: regressions.length === 0, regressions };
}

/** Replay the whole corpus sequentially (deterministic ordering) and compare against the baseline. */
export async function runReplay(corpus: BenchCorpus): Promise<BenchReplayResult> {
	const fixtures: BenchFixtureResult[] = [];
	for (const entry of corpus.fixtures) fixtures.push(await replayFixture(entry));
	const aggregate = aggregateResults(fixtures);
	const { ok, regressions } = compareToBaseline(aggregate, fixtures, corpus.baseline);
	return { fixtures, aggregate, baseline: corpus.baseline, regressions, ok };
}

function sum(results: readonly BenchFixtureResult[], pick: (r: BenchFixtureResult) => number): number {
	return results.reduce((total, result) => total + pick(result), 0);
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** Deterministic, human-readable replay report. Same input → byte-identical output. */
export function renderReplayReport(result: BenchReplayResult): string {
	const lines: string[] = [];
	lines.push("review-bench --replay (Tier A, deterministic)");
	lines.push("");
	for (const fixture of result.fixtures) {
		const status = fixture.goldenMatch ? "ok  " : "FAIL";
		lines.push(`  [${status}] ${fixture.id}: outcome=${fixture.outcome} gate=${fixture.gate} diversity=${fixture.diversity} tp=${fixture.confusion.tp} fp=${fixture.confusion.fp} fn=${fixture.confusion.fn} safetyFN=${fixture.safetyFn}`);
		for (const diff of fixture.goldenDiffs) lines.push(`         golden: ${diff}`);
	}
	const a = result.aggregate;
	lines.push("");
	lines.push(`  aggregate: tp=${a.tp} fp=${a.fp} fn=${a.fn} precision=${fmt(a.precision)} recall=${fmt(a.recall)} safetyFN=${a.safetyFn}`);
	lines.push(`  baseline:  recall>=${fmt(result.baseline.recall)} safetyFN<=${result.baseline.safetyFn}`);
	if (result.regressions.length > 0) {
		lines.push("");
		lines.push("  REGRESSIONS:");
		for (const regression of result.regressions) lines.push(`    - ${regression}`);
	}
	lines.push("");
	lines.push(result.ok ? "review-bench: PASS" : "review-bench: FAIL");
	return lines.join("\n");
}

function fmt(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

// ── Loading + validation (JSON is a runtime boundary, not type safety) ───────

/** Load and strictly validate the committed corpus. Injectable `corpusDir` for unit tests. */
export function loadBenchCorpus(corpusDir?: string | URL): BenchCorpus {
	const base = toBaseUrl(corpusDir ?? CORPUS_URL);
	const manifest = validateManifest(readJson(new URL("manifest.json", base), "manifest.json"));
	const seen = new Set<string>();
	const fixtures = manifest.fixtures.map((dir) => {
		if (seen.has(dir)) throw new BenchCorpusError(`manifest lists duplicate fixture id: ${dir}`);
		seen.add(dir);
		const fixturePath = `${dir}/fixture.json`;
		const goldenPath = `${dir}/golden.json`;
		const fixture = validateFixture(readJson(new URL(fixturePath, base), fixturePath), fixturePath);
		if (fixture.id !== dir) throw new BenchCorpusError(`${fixturePath}: fixture id ${JSON.stringify(fixture.id)} does not match manifest entry ${JSON.stringify(dir)}`);
		const golden = validateGolden(readJson(new URL(goldenPath, base), goldenPath), goldenPath);
		return { id: dir, fixture, golden };
	});
	const baseline = validateBaseline(readJson(new URL("review-bench.baseline.json", base), "review-bench.baseline.json"));
	return { manifest, fixtures, baseline };
}

function toBaseUrl(dir: string | URL): URL {
	if (dir instanceof URL) return dir;
	return pathToFileURL(dir.endsWith("/") ? dir : `${dir}/`);
}

function readJson(url: URL, label: string): unknown {
	let raw: string;
	try {
		raw = readFileSync(url, "utf8");
	} catch (error) {
		throw new BenchCorpusError(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new BenchCorpusError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new BenchCorpusError(`${label} must be a JSON object`);
	return value;
}

function asNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new BenchCorpusError(`${label} must be a non-empty string`);
	return value;
}

function asPositiveInt(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new BenchCorpusError(`${label} must be a positive integer`);
	return value;
}

function asFiniteNonNegative(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new BenchCorpusError(`${label} must be a finite non-negative number`);
	return value;
}

function asArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new BenchCorpusError(`${label} must be an array`);
	return value;
}

function validateManifest(value: unknown): BenchManifest {
	const record = asRecord(value, "manifest.json");
	if (record.schemaVersion !== 1) throw new BenchCorpusError("manifest.json has an unsupported schemaVersion (expected 1)");
	const fixtures = asArray(record.fixtures, "manifest.json fixtures").map((entry, index) => asNonEmptyString(entry, `manifest.json fixtures[${index}]`));
	if (fixtures.length === 0) throw new BenchCorpusError("manifest.json fixtures must be non-empty");
	return { schemaVersion: 1, fixtures };
}

const REVIEW_SLOT_PROVIDERS = new Set(["claude", "grok", "opencode", "codex"]);

function validateSlot(value: unknown, label: string): ReviewSlot {
	const record = asRecord(value, label);
	const id = asNonEmptyString(record.id, `${label}.id`);
	const provider = record.provider;
	if (typeof provider !== "string" || !REVIEW_SLOT_PROVIDERS.has(provider)) throw new BenchCorpusError(`${label}.provider must be one of claude|grok|opencode|codex`);
	if (provider === "codex") {
		if (record.codexModel !== undefined && typeof record.codexModel !== "string") throw new BenchCorpusError(`${label}.codexModel must be a string`);
		return record.codexModel !== undefined ? { id, provider, codexModel: record.codexModel } : { id, provider };
	}
	if (record.model !== undefined && typeof record.model !== "string") throw new BenchCorpusError(`${label}.model must be a string`);
	return record.model !== undefined ? { id, provider: provider as "claude" | "grok" | "opencode", model: record.model } : { id, provider: provider as "claude" | "grok" | "opencode" };
}

function validatePolicy(value: unknown, label: string): BenchPolicy {
	const record = asRecord(value, label);
	const reviewers = asArray(record.reviewers, `${label}.reviewers`);
	if (reviewers.length === 0) throw new BenchCorpusError(`${label}.reviewers must be non-empty`);
	return {
		reviewers: reviewers.map((slot, index) => validateSlot(slot, `${label}.reviewers[${index}]`)),
		judge: validateSlot(record.judge, `${label}.judge`),
		maxPasses: asPositiveInt(record.maxPasses, `${label}.maxPasses`),
		budgetCap: asFiniteNonNegative(record.budgetCap, `${label}.budgetCap`),
	};
}

function validateRecording(value: unknown, label: string): SeatRecording {
	const record = asRecord(value, label);
	if (record.role !== "reviewer" && record.role !== "judge") throw new BenchCorpusError(`${label}.role must be reviewer|judge`);
	return {
		role: record.role,
		seatId: asNonEmptyString(record.seatId, `${label}.seatId`),
		pass: asPositiveInt(record.pass, `${label}.pass`),
		assistantText: asNonEmptyString(record.assistantText, `${label}.assistantText`),
	};
}

function validateFixture(value: unknown, path: string): BenchFixture {
	const record = asRecord(value, path);
	if (record.schemaVersion !== 1) throw new BenchCorpusError(`${path} has an unsupported schemaVersion (expected 1)`);
	const id = asNonEmptyString(record.id, `${path}.id`);
	const description = asNonEmptyString(record.description, `${path}.description`);
	const policy = validatePolicy(record.policy, `${path}.policy`);
	const classificationContext = asRecord(record.classificationContext, `${path}.classificationContext`);
	const changedFiles = asArray(classificationContext.changedFiles, `${path}.classificationContext.changedFiles`).map((file, index) => asNonEmptyString(file, `${path}.classificationContext.changedFiles[${index}]`));

	const recordings = asArray(record.recordings, `${path}.recordings`).map((entry, index) => validateRecording(entry, `${path}.recordings[${index}]`));
	if (recordings.length === 0) throw new BenchCorpusError(`${path}.recordings must be non-empty`);
	const seatIds = new Set([...policy.reviewers.map((slot) => slot.id), policy.judge.id]);
	const seenKeys = new Set<string>();
	for (const [index, recording] of recordings.entries()) {
		const key = recordingKey(recording.role, recording.seatId, recording.pass);
		if (seenKeys.has(key)) throw new BenchCorpusError(`${path}.recordings[${index}] duplicates recording key ${key}`);
		seenKeys.add(key);
		if (recording.role === "judge" && recording.seatId !== policy.judge.id) throw new BenchCorpusError(`${path}.recordings[${index}] judge seatId ${JSON.stringify(recording.seatId)} does not match policy.judge.id`);
		if (recording.role === "reviewer" && !seatIds.has(recording.seatId)) throw new BenchCorpusError(`${path}.recordings[${index}] reviewer seatId ${JSON.stringify(recording.seatId)} is not a configured reviewer`);
	}

	const groundTruthBlockers = asArray(record.groundTruthBlockers, `${path}.groundTruthBlockers`).map((entry, index) => validateGroundTruth(entry, `${path}.groundTruthBlockers[${index}]`));
	const seenFingerprints = new Set<string>();
	for (const [index, blocker] of groundTruthBlockers.entries()) {
		if (seenFingerprints.has(blocker.fingerprint)) throw new BenchCorpusError(`${path}.groundTruthBlockers[${index}] duplicates fingerprint ${blocker.fingerprint}`);
		seenFingerprints.add(blocker.fingerprint);
	}
	return { schemaVersion: 1, id, description, policy, classificationContext: { changedFiles }, recordings, groundTruthBlockers };
}

function validateGroundTruth(value: unknown, label: string): BenchGroundTruthBlocker {
	const record = asRecord(value, label);
	return {
		fingerprint: asNonEmptyString(record.fingerprint, `${label}.fingerprint`),
		class: asNonEmptyString(record.class, `${label}.class`),
	};
}

const GATES = new Set<BenchGate>(["pass", "block", "park"]);
const DIVERSITIES = new Set<BenchDiversity>(["met", "softened"]);
const OUTCOMES = new Set<ReviewOutcome>(["converged-clean", "converged-with-notes", "ceiling", "dissent", "hard-block", "budget"]);

function validateGolden(value: unknown, path: string): BenchGolden {
	const record = asRecord(value, path);
	if (record.schemaVersion !== 1) throw new BenchCorpusError(`${path} has an unsupported schemaVersion (expected 1)`);
	if (typeof record.outcome !== "string" || !OUTCOMES.has(record.outcome as ReviewOutcome)) throw new BenchCorpusError(`${path}.outcome is not a valid ReviewOutcome`);
	if (typeof record.gate !== "string" || !GATES.has(record.gate as BenchGate)) throw new BenchCorpusError(`${path}.gate must be pass|block|park`);
	if (typeof record.diversity !== "string" || !DIVERSITIES.has(record.diversity as BenchDiversity)) throw new BenchCorpusError(`${path}.diversity must be met|softened`);
	const survivorFingerprints = asArray(record.survivorFingerprints, `${path}.survivorFingerprints`).map((fp, index) => asNonEmptyString(fp, `${path}.survivorFingerprints[${index}]`));
	// Golden/truth internal consistency: fingerprints unique + sorted, gate agrees with the survivor set.
	const seen = new Set<string>();
	for (const [index, fp] of survivorFingerprints.entries()) {
		if (seen.has(fp)) throw new BenchCorpusError(`${path}.survivorFingerprints[${index}] is a duplicate`);
		seen.add(fp);
	}
	if (JSON.stringify(survivorFingerprints) !== JSON.stringify([...survivorFingerprints].sort(byFingerprint))) throw new BenchCorpusError(`${path}.survivorFingerprints must be sorted`);
	const gate = record.gate as BenchGate;
	if (gate === "pass" && survivorFingerprints.length !== 0) throw new BenchCorpusError(`${path}: gate "pass" is inconsistent with a non-empty survivor set`);
	if (gate !== "pass" && survivorFingerprints.length === 0) throw new BenchCorpusError(`${path}: gate ${JSON.stringify(gate)} is inconsistent with an empty survivor set`);
	return { schemaVersion: 1, outcome: record.outcome as ReviewOutcome, gate, survivorFingerprints, diversity: record.diversity as BenchDiversity };
}

function validateBaseline(value: unknown): BenchBaseline {
	const record = asRecord(value, "review-bench.baseline.json");
	if (record.schemaVersion !== 1) throw new BenchCorpusError("review-bench.baseline.json has an unsupported schemaVersion (expected 1)");
	return {
		schemaVersion: 1,
		recall: asFiniteNonNegative(record.recall, "review-bench.baseline.json.recall"),
		safetyFn: asFiniteNonNegative(record.safetyFn, "review-bench.baseline.json.safetyFn"),
		tp: asFiniteNonNegative(record.tp, "review-bench.baseline.json.tp"),
		fp: asFiniteNonNegative(record.fp, "review-bench.baseline.json.fp"),
		fn: asFiniteNonNegative(record.fn, "review-bench.baseline.json.fn"),
		precision: asFiniteNonNegative(record.precision, "review-bench.baseline.json.precision"),
	};
}
