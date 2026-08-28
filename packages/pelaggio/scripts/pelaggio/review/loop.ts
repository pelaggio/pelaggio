import { createHash } from "node:crypto";
import type { AuthoringReviewConfig, ReviewSlot } from "../config.js";
import { makeSecretScrubber } from "../secret-hygiene.js";
import type { ParkSignal, ProviderName, ReviewOutcome, StepResult } from "../types.js";
import {
	type AuthoringReviewFinding,
	type ClassificationContextBase,
	type JudgeReport,
	type JudgeRuling,
	materializeAuthoringFinding,
	modelAuthoredText,
	parseAuthoringReviewFindings,
	parseFailureCode,
	parseFailureDiagnostic,
	parseJudgeReport,
	type ReviewFindingClass,
	type ReviewFindingsParseErrorCode,
	reviewBlockMarkers,
	reviewFindingFingerprint,
	reviewFindingsGate,
} from "./findings.js";
import { BASELINE_TAXONOMY, isSafetyClass, safetyClasses, type TaxonomyConfig } from "./taxonomy.js";

export type { ReviewOutcome };
/**
 * Safety-floor posture for the run. `enabled` (default) applies the ADR-0016 code-diff safety floor:
 * safety-class must-fixes are non-contractible, retained every pass, and a lone Judge can never refute
 * them. `disabled` records honestly that the code-diff path-signal taxonomy is the wrong floor for the
 * artifact under review (e.g. a bare design document): safety classes are no longer treated as an
 * un-refutable gate floor, so the Judge's ruling is authoritative. See #384.
 */
export type SafetyFloor = "enabled" | "disabled";
export type DiversityStatus = { state: "met" } | { state: "softened"; explanation: string };
export interface DriverIdentity {
	role: "author" | "reviewer" | "judge";
	seatId: string;
	provider: ProviderName;
	model?: string;
	sessionId: string;
}
export interface ReviewCandidate {
	candidateId: string;
	fingerprint: string;
	finding: AuthoringReviewFinding;
	sources: string[];
}
/** Structural facts from assistantText without retaining the text. */
export type UnreadableSource = { chars: number; hasStartMarker: boolean; hasEndMarker: boolean };
export type SeatOutputObservation = { state: "readable"; payload: "empty" | "non-empty" } | { state: "unreadable"; code: ReviewFindingsParseErrorCode; source: UnreadableSource };
export type SeatAttemptRecord =
	| { completion: "returned"; attempt: number; ok: boolean; subtype: string; cost: number; turns: number; output: SeatOutputObservation }
	| { completion: "rejected"; attempt: number; reason: "seat-rejected"; cost: 0; turns: 0 };
export type JudgeSkipReason = "no-reviewer-completed" | "cross-model-split";
export interface SeatAttemptObservation {
	role: "reviewer" | "judge";
	identity: DriverIdentity;
	pass: number;
	attempt: number;
	output: SeatOutputObservation;
	result: StepResult;
}
export interface ReviewPassRecord {
	pass: number;
	reviewers: Array<{ identity: DriverIdentity; ok: boolean; cost: number; turns: number; verdict?: DriverReviewVerdict; diagnostic?: string; attempts?: SeatAttemptRecord[] }>;
	judge: { identity: DriverIdentity; valid: boolean; cost: number; turns: number; diagnostic?: string; attempts?: SeatAttemptRecord[]; skipped?: JudgeSkipReason };
	carriedBefore: string[];
	carriedAfter: string[];
}
export type DriverReviewVerdict = { verdict: "pass" | "block"; rationale: string };
export interface ReviewDisagreement {
	pass: number;
	drivers: Array<{ identity: DriverIdentity; verdict: "pass" | "block"; rationale: string }>;
	hasSafetyBlocker: boolean;
	evidenceFingerprint: string;
}
export interface ReviewLoopResult {
	outcome: ReviewOutcome;
	diversity: DiversityStatus;
	passes: ReviewPassRecord[];
	survivors: ReviewCandidate[];
	notes: ReviewCandidate[];
	cost: number;
	/** Recorded posture of this run's safety floor (honest record, not a taxonomy swap). */
	safetyFloor: SafetyFloor;
	/** Optional human explanation when the floor is disabled (e.g. "document review: …"). */
	safetyFloorNote?: string;
	dissent?: { finding: ReviewCandidate; ruling: "judgment-dissent"; attemptedResolution: string; notificationTarget: string };
	disagreement?: ReviewDisagreement;
}
export interface SeatRequest {
	role: "reviewer" | "judge" | "author";
	slot: ReviewSlot;
	pass: number;
	prompt: string;
	parkSignal: ParkSignal;
}
export type RunSeatFn = (request: SeatRequest) => Promise<StepResult>;
export type ReviewAuthorIdentity = { provider: ProviderName; model?: string };
type ReviewLoopBase = {
	policy: AuthoringReviewConfig;
	parkSignal: ParkSignal;
	runSeat: RunSeatFn;
	notificationTarget?: string;
	/** Diff context for emission-time classification (plain data; no shell). */
	classificationContext: ClassificationContextBase;
	/** Resolved safety/judgment taxonomy (baseline ADR table unless the owner extended/contracted it). */
	taxonomy: TaxonomyConfig;
	/**
	 * When `"disabled"`, the safety class is ignored for gate/#272 retention and Judge-downgrade
	 * invalidation; recorded on the result. Default `"enabled"` preserves the pipeline's code-diff floor.
	 */
	safetyFloor?: SafetyFloor;
	/** Optional explanation stamped on the result when the floor is disabled. */
	safetyFloorNote?: string;
	/**
	 * Invoked after a seat returns and its parser result is known. Skipped Judges and
	 * promise rejections do not fire (no StepResult / no assistantText). Ordinary
	 * pipeline callers omit this; doc-review uses it for failed-seat capture.
	 */
	onSeatAttempt?: (observation: SeatAttemptObservation) => void;
};
/**
 * `mode: "revise"` (default) is the pipeline authoring loop: an artifact author is present and the
 * loop may run author revisions between passes. `mode: "no-revise"` makes the revision branch
 * unreachable by construction — the author is optional (excluded from reviewer seats only when
 * present) and no `revise` prompt exists, so a read-only caller cannot supply a mutating seat path.
 */
export type ReviewLoopOptions =
	| (ReviewLoopBase & {
			mode?: "revise";
			author: ReviewAuthorIdentity;
			prompts: { review(pass: number): string; judge(candidates: readonly ReviewCandidate[], pass: number): string; revise(survivors: readonly ReviewCandidate[]): string };
	  })
	| (ReviewLoopBase & {
			mode: "no-revise";
			/** Optional: when present, still excluded from reviewer seats (authoring reuse). Absent for doc-review. */
			author?: ReviewAuthorIdentity;
			prompts: { review(pass: number): string; judge(candidates: readonly ReviewCandidate[], pass: number): string };
	  });

// classRank: safety > judgment; among safety classes earlier taxonomy precedence entries rank higher.
const classRank = (value: ReviewFindingClass, taxonomy: TaxonomyConfig): number => {
	const order = safetyClasses(taxonomy);
	const idx = order.indexOf(value);
	return idx >= 0 ? order.length - idx : isSafetyClass(value, taxonomy) ? 1 : 0;
};
const blockingRank = (finding: AuthoringReviewFinding, taxonomy: TaxonomyConfig): number => (finding.severity === "must-fix" ? 2 * (safetyClasses(taxonomy).length + 1) : 0) + classRank(finding.class, taxonomy);
/**
 * Effective safety predicate for the gate. With the floor disabled, no class is treated as a safety
 * floor for retention / hard-block / downgrade-invalidation — the deterministic code-diff taxonomy is
 * the wrong floor for the artifact, so the Judge's ruling governs. Emission-time classification still
 * runs on the real taxonomy for the honest forensic `classification` on each finding.
 */
const isSafetyFloorClass = (value: ReviewFindingClass, taxonomy: TaxonomyConfig, safetyFloor: SafetyFloor): boolean => safetyFloor !== "disabled" && isSafetyClass(value, taxonomy);
const identity = (role: DriverIdentity["role"], slot: ReviewSlot, pass: number): DriverIdentity => ({
	role,
	seatId: slot.id,
	provider: slot.provider,
	...(slot.provider === "codex" ? (slot.codexModel ? { model: slot.codexModel } : {}) : slot.model ? { model: slot.model } : {}),
	sessionId: `${role}-${slot.id}-p${pass}`,
});
const childSignal = (): ParkSignal => ({ parked: false, resetsAt: 0, limitType: "", triggerWorker: "" });
const rejectedAttempt = (attempt = 1): Extract<SeatAttemptRecord, { completion: "rejected" }> => ({ completion: "rejected", attempt, reason: "seat-rejected", cost: 0, turns: 0 });

type ParsedSeatOutput = { readable: true; empty: boolean } | { readable: false; error: unknown };

/** Observe a returned seat: parse outcome is already known. Completeness is a later check. */
function observeSeatAttempt(options: {
	onSeatAttempt?: ReviewLoopBase["onSeatAttempt"];
	role: "reviewer" | "judge";
	identity: DriverIdentity;
	pass: number;
	result: StepResult;
	parsed: ParsedSeatOutput;
	attempt?: number;
}): Extract<SeatAttemptRecord, { completion: "returned" }> {
	const attempt = options.attempt ?? 1;
	const assistantText = modelAuthoredText(options.result);
	const output: SeatOutputObservation = options.parsed.readable
		? { state: "readable", payload: options.parsed.empty ? "empty" : "non-empty" }
		: {
				state: "unreadable",
				code: parseFailureCode(options.parsed.error),
				source: { chars: assistantText.length, ...reviewBlockMarkers(assistantText, options.role) },
			};
	options.onSeatAttempt?.({ role: options.role, identity: options.identity, pass: options.pass, attempt, output, result: options.result });
	return { completion: "returned", attempt, ok: options.result.ok, subtype: options.result.subtype, cost: options.result.cost, turns: options.result.turns, output };
}

export function classifyReviewDisagreement(
	pass: number,
	records: ReviewPassRecord["reviewers"],
	candidates: readonly ReviewCandidate[],
	taxonomy: TaxonomyConfig = BASELINE_TAXONOMY,
	safetyFloor: SafetyFloor = "enabled",
): ReviewDisagreement | undefined {
	const drivers = records
		.filter((record): record is typeof record & { verdict: DriverReviewVerdict } => record.ok && record.verdict !== undefined)
		.map((record) => ({ identity: record.identity, ...record.verdict }))
		.sort((a, b) => JSON.stringify(a.identity).localeCompare(JSON.stringify(b.identity)));
	if (drivers.length < 2 || !drivers.some((driver) => driver.verdict === "pass") || !drivers.some((driver) => driver.verdict === "block")) return undefined;
	const normalized = drivers.map((driver) => [driver.identity.role, driver.identity.seatId, driver.identity.provider, driver.identity.model ?? "", driver.verdict, driver.rationale.trim().replace(/\s+/g, " ")]);
	return {
		pass,
		drivers,
		hasSafetyBlocker: candidates.some((candidate) => candidate.finding.severity === "must-fix" && isSafetyFloorClass(candidate.finding.class, taxonomy, safetyFloor)),
		evidenceFingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
	};
}

export function deduplicateCandidates(findings: readonly { finding: AuthoringReviewFinding; source: string }[], taxonomy: TaxonomyConfig = BASELINE_TAXONOMY): ReviewCandidate[] {
	const byFingerprint = new Map<string, ReviewCandidate>();
	for (const item of findings) {
		const fingerprint = reviewFindingFingerprint(item.finding);
		const current = byFingerprint.get(fingerprint);
		if (!current) byFingerprint.set(fingerprint, { candidateId: "", fingerprint, finding: item.finding, sources: [item.source] });
		else {
			current.sources.push(item.source);
			// Keep the most-blocking finding: must-fix severity dominates class rank, so a same-fingerprint
			// note/nice can never downgrade (and drop) a carried must-fix blocker. Winner keeps its
			// classification reason intact.
			if (blockingRank(item.finding, taxonomy) > blockingRank(current.finding, taxonomy)) current.finding = item.finding;
		}
	}
	return [...byFingerprint.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)).map((candidate, index) => ({ ...candidate, candidateId: `C${index + 1}` }));
}

export function classifyReviewOutcome(
	survivors: readonly ReviewCandidate[],
	notes: readonly ReviewCandidate[],
	rulings: ReadonlyMap<string, JudgeRuling>,
	judgeValid: boolean,
	pass: number,
	taxonomy: TaxonomyConfig = BASELINE_TAXONOMY,
	safetyFloor: SafetyFloor = "enabled",
): ReviewOutcome {
	if (!judgeValid || survivors.some((candidate) => isSafetyFloorClass(candidate.finding.class, taxonomy, safetyFloor) || rulings.get(candidate.candidateId) === "unfixable-blocker")) return "hard-block";
	if (survivors.some((candidate) => rulings.get(candidate.candidateId) === "judgment-dissent")) return "dissent";
	if (survivors.length > 0) return "hard-block";
	if (notes.length === 0) return "converged-clean";
	return pass >= 2 ? "ceiling" : "converged-with-notes";
}

export async function runReviewLoop(options: ReviewLoopOptions): Promise<ReviewLoopResult> {
	const { policy, classificationContext, taxonomy } = options;
	const scrubDiagnostic = makeSecretScrubber();
	// no-revise: the author is optional and the revision branch is unreachable — force the effective
	// revision budget to 0 and drop the revise prompt so a mutating seat cannot be reached at all.
	const author = options.author;
	const revise = options.mode === "no-revise" ? undefined : options.prompts.revise;
	const effectiveMaxRevisions = options.mode === "no-revise" ? 0 : policy.maxRevisions;
	const safetyFloor: SafetyFloor = options.safetyFloor ?? "enabled";
	const safetyFloorNote = options.safetyFloorNote;
	// Stamp the run's safety-floor posture on every terminal result without repeating it at 8 return sites.
	const withFloor = (result: Omit<ReviewLoopResult, "safetyFloor" | "safetyFloorNote">): ReviewLoopResult => ({
		...result,
		safetyFloor,
		...(safetyFloorNote ? { safetyFloorNote } : {}),
	});
	// Author exclusion / inclusion applies ONLY when an author is present (doc-review omits it).
	const configuredReviewers = author ? policy.reviewers.filter((slot) => slot.provider !== author.provider) : policy.reviewers;
	let cost = 0;
	let carried: ReviewCandidate[] = [];
	let notes: ReviewCandidate[] = [];
	let revisionsUsed = 0;
	const passes: ReviewPassRecord[] = [];
	if (new Set(configuredReviewers.map((slot) => slot.provider)).size !== configuredReviewers.length) {
		return withFloor({ outcome: "hard-block", diversity: { state: "softened", explanation: "review seats must be distinct and must exclude the artifact author" }, passes, survivors: carried, notes, cost });
	}
	const distinctProviders = new Set([...(author ? [author.provider] : []), policy.judge.provider, ...configuredReviewers.map((slot) => slot.provider)]);
	let diversity: DiversityStatus = distinctProviders.size >= 3 ? { state: "met" } : { state: "softened", explanation: "configured seats do not provide three distinct providers" };
	for (let pass = 1; pass <= policy.maxPasses; pass++) {
		const phaseReservation = configuredReviewers.length * 5 + 5;
		if (cost + phaseReservation > policy.budgetCap) return withFloor({ outcome: "budget", diversity, passes, survivors: carried, notes, cost });
		const reviewerJobs = configuredReviewers.map((slot) => ({ slot, parkSignal: childSignal() }));
		const settled = await Promise.allSettled(reviewerJobs.map(({ slot, parkSignal }) => options.runSeat({ role: "reviewer", slot, pass, prompt: options.prompts.review(pass), parkSignal })));
		for (const job of reviewerJobs) if (job.parkSignal.parked) Object.assign(options.parkSignal, job.parkSignal);
		const reviewerRecords: ReviewPassRecord["reviewers"] = [];
		// Carried candidates already have harness-owned class + classification reason.
		const discovered: Array<{ finding: AuthoringReviewFinding; source: string }> = carried.map((candidate) => ({ finding: candidate.finding, source: "carried" }));
		settled.forEach((result, index) => {
			const job = reviewerJobs[index];
			if (!job) return;
			const slot = job.slot;
			const reviewerIdentity = identity("reviewer", slot, pass);
			if (result.status === "rejected") {
				reviewerRecords.push({ identity: reviewerIdentity, ok: false, cost: 0, turns: 0, diagnostic: scrubDiagnostic(String(result.reason)), attempts: [rejectedAttempt()] });
				return;
			}
			cost += result.value.cost;
			let report: ReturnType<typeof parseAuthoringReviewFindings>;
			try {
				// Model-authored final message only — never the transcript (see modelAuthoredText).
				report = parseAuthoringReviewFindings(modelAuthoredText(result.value));
			} catch (error) {
				const attempts = [
					observeSeatAttempt({
						onSeatAttempt: options.onSeatAttempt,
						role: "reviewer",
						identity: reviewerIdentity,
						pass,
						result: result.value,
						parsed: { readable: false, error },
					}),
				];
				reviewerRecords.push({
					identity: reviewerIdentity,
					ok: false,
					cost: result.value.cost,
					turns: result.value.turns,
					diagnostic: parseFailureDiagnostic("reviewer"),
					attempts,
				});
				return;
			}
			const attempts = [
				observeSeatAttempt({
					onSeatAttempt: options.onSeatAttempt,
					role: "reviewer",
					identity: reviewerIdentity,
					pass,
					result: result.value,
					parsed: { readable: true, empty: report.findings.length === 0 },
				}),
			];
			// Ingest parseable findings even from a non-ok seat (max-turns/errored): a security
			// must-fix a seat did emit must still block and feed hasSafetyBlocker. Only the
			// pass/block VERDICT is ok-gated below, since an incomplete seat has no trustworthy
			// overall verdict for disagreement.
			//
			// A seat whose model-authored text carries no parseable block is now dropped rather
			// than scavenged from the transcript. That is not a fail-open: the seat's required
			// (driver × label) cell stays uncompleted and the all-pass gate cannot reach
			// consensus-pass with an uncompleted cell.
			// Classify at the emission boundary before dedup/ingestion (#293).
			for (const raw of report.findings) {
				discovered.push({ finding: materializeAuthoringFinding(raw, classificationContext, taxonomy), source: slot.id });
			}
			reviewerRecords.push({
				identity: reviewerIdentity,
				ok: result.value.ok,
				cost: result.value.cost,
				turns: result.value.turns,
				attempts,
				// A parseable but non-ok seat (max-turns / provider-reported failure) has no trustworthy
				// verdict — record WHY (subtype + turns) so it isn't a reasonless `ok:false` (#268 legibility).
				...(result.value.ok ? { verdict: { verdict: reviewFindingsGate(report), rationale: report.summary } } : { diagnostic: `seat did not complete: ${result.value.subtype} (${result.value.turns} turns)` }),
			});
		});
		const incompleteSeats = reviewerRecords.filter((record) => !record.ok).map((record) => record.identity.seatId);
		if (incompleteSeats.length > 0) {
			const explanation = `reviewer seats did not complete: ${incompleteSeats.join(", ")}`;
			if (diversity.state === "met") diversity = { state: "softened", explanation };
			else if (!diversity.explanation.includes(explanation)) diversity = { state: "softened", explanation: `${diversity.explanation}; ${explanation}` };
		}
		if (!reviewerRecords.some((record) => record.ok)) {
			// No reviewer seat completed. Persist the pass so each seat's `diagnostic` (WHY it failed —
			// parse error, provider crash, max-turns) survives in the review record, instead of returning
			// `passes:[]` with no reason (the #268/#269 diagnosis black hole). Judge is skipped; carried
			// must-fixes pass through unchanged.
			passes.push({
				pass,
				reviewers: reviewerRecords,
				judge: { identity: identity("judge", policy.judge, pass), valid: false, cost: 0, turns: 0, diagnostic: "skipped: no reviewer seat completed", attempts: [], skipped: "no-reviewer-completed" },
				carriedBefore: discovered.filter((item) => item.source === "carried").map((item) => reviewFindingFingerprint(item.finding)),
				carriedAfter: carried.filter((candidate) => candidate.finding.severity === "must-fix").map((candidate) => candidate.fingerprint),
			});
			return withFloor({ outcome: options.parkSignal.parked ? "budget" : "hard-block", diversity, passes, survivors: carried, notes, cost });
		}
		const candidates = deduplicateCandidates(discovered, taxonomy);
		const disagreement = classifyReviewDisagreement(pass, reviewerRecords, candidates, taxonomy, safetyFloor);
		if (disagreement) {
			passes.push({
				pass,
				reviewers: reviewerRecords,
				judge: { identity: identity("judge", policy.judge, pass), valid: false, cost: 0, turns: 0, diagnostic: "skipped: human adjudication required", attempts: [], skipped: "cross-model-split" },
				carriedBefore: discovered.filter((item) => item.source === "carried").map((item) => reviewFindingFingerprint(item.finding)),
				carriedAfter: candidates.filter((candidate) => candidate.finding.severity === "must-fix").map((candidate) => candidate.fingerprint),
			});
			return withFloor({
				outcome: disagreement.hasSafetyBlocker ? "hard-block" : "dissent",
				diversity,
				passes,
				survivors: candidates.filter((candidate) => candidate.finding.severity === "must-fix"),
				notes: candidates.filter((candidate) => candidate.finding.severity !== "must-fix"),
				cost,
				disagreement,
			});
		}
		const judgeSignal = childSignal();
		const judgeIdentity = identity("judge", policy.judge, pass);
		const carriedBefore = discovered.filter((item) => item.source === "carried").map((item) => reviewFindingFingerprint(item.finding));
		let judgeResult: StepResult;
		try {
			judgeResult = await options.runSeat({ role: "judge", slot: policy.judge, pass, prompt: options.prompts.judge(candidates, pass), parkSignal: judgeSignal });
		} catch (reason) {
			passes.push({
				pass,
				reviewers: reviewerRecords,
				judge: { identity: judgeIdentity, valid: false, cost: 0, turns: 0, diagnostic: scrubDiagnostic(String(reason)), attempts: [rejectedAttempt()] },
				carriedBefore,
				carriedAfter: candidates.filter((candidate) => candidate.finding.severity === "must-fix").map((candidate) => candidate.fingerprint),
			});
			return withFloor({ outcome: "hard-block", diversity, passes, survivors: candidates, notes, cost });
		}
		if (judgeSignal.parked) Object.assign(options.parkSignal, judgeSignal);
		cost += judgeResult.cost;
		let report: JudgeReport | undefined;
		let diagnostic: string | undefined;
		let judgeAttempts: SeatAttemptRecord[];
		try {
			// Same rule as the reviewer seats: the Judge's ruling is model-authored text only. Parsing
			// the transcript here would leave the identical tool-output injection class on the Judge.
			report = parseJudgeReport(modelAuthoredText(judgeResult));
			judgeAttempts = [
				observeSeatAttempt({
					onSeatAttempt: options.onSeatAttempt,
					role: "judge",
					identity: judgeIdentity,
					pass,
					result: judgeResult,
					parsed: { readable: true, empty: report.decisions.length === 0 },
				}),
			];
		} catch (error) {
			report = undefined;
			diagnostic = parseFailureDiagnostic("judge");
			judgeAttempts = [
				observeSeatAttempt({
					onSeatAttempt: options.onSeatAttempt,
					role: "judge",
					identity: judgeIdentity,
					pass,
					result: judgeResult,
					parsed: { readable: false, error },
				}),
			];
		}
		if (report) {
			try {
				// Fail-closed completeness: exactly one decision per candidate, no duplicates, no unknowns.
				// The distinct-count check alone accepts a duplicate that still covers every id (e.g.
				// [{C1,refuted},{C1,survives}] for two candidates); the survivor filter's `.find` would then
				// silently take the first (refuted) decision and drop a real blocker — the duplicate fail-open
				// that reconcileReviewVerification already rejects.
				if (
					report.decisions.length !== candidates.length ||
					new Set(report.decisions.map((d) => d.candidateId)).size !== candidates.length ||
					report.decisions.some((decision) => {
						const candidate = candidates.find((item) => item.candidateId === decision.candidateId);
						if (!candidate) return true;
						// #280: `class` is optional and inherits the candidate's class when omitted — a redundant
						// echo the Judge shouldn't have to restate. #272: but the Judge must not DOWNGRADE a
						// harness safety-class candidate to a non-safety class (a reclassify-to-ship evasion);
						// restating the same class or elevating a non-safety candidate stays allowed.
						return decision.class !== undefined && isSafetyFloorClass(candidate.finding.class, taxonomy, safetyFloor) && !isSafetyClass(decision.class, taxonomy);
					})
				)
					throw new Error("Judge decisions are incomplete, duplicated, downgrade a safety class, or contain unknown candidates");
			} catch (error) {
				// Completeness failure must invalidate the whole pass (fail-closed):
				// `report` already holds the parsed-but-incomplete value, so clear it or
				// `Boolean(report)` would read a malformed Judge report as valid and ship it.
				// Observation stays readable — completeness is not a parse code.
				report = undefined;
				diagnostic = error instanceof Error ? error.message : String(error);
			}
		}
		const rulings = new Map<string, JudgeRuling>();
		const next = report
			? candidates.filter((candidate) => {
					const decision = report?.decisions.find((item) => item.candidateId === candidate.candidateId);
					if (!decision) return true;
					if (decision.ruling) rulings.set(candidate.candidateId, decision.ruling);
					// #272: a single Judge must not be able to refute away a safety-class must-fix. Once raised
					// it is retained every pass (carried is re-seeded above, so reviewer omission can't drop it
					// either) and the run parks for a human — a lone Judge's `refuted`/reclassify decision never
					// clears it; the loop does not self-clear a safety must-fix.
					if (candidate.finding.severity === "must-fix" && isSafetyFloorClass(candidate.finding.class, taxonomy, safetyFloor)) return true;
					return decision.decision === "survives";
				})
			: candidates;
		notes = candidates.filter((candidate) => candidate.finding.severity !== "must-fix");
		carried = next.filter((candidate) => candidate.finding.severity === "must-fix");
		passes.push({
			pass,
			reviewers: reviewerRecords,
			judge: { identity: judgeIdentity, valid: Boolean(report), cost: judgeResult.cost, turns: judgeResult.turns, attempts: judgeAttempts, ...(diagnostic ? { diagnostic } : {}) },
			carriedBefore,
			carriedAfter: carried.map((item) => item.fingerprint),
		});
		const outcome = classifyReviewOutcome(carried, notes, rulings, Boolean(report), pass, taxonomy, safetyFloor);
		// Escalate-early: revise->re-review only when the carried set can actually converge — i.e. EVERY
		// surviving must-fix is fixable-by-the-loop. A survivor is unclearable when it is safety-class
		// (retained every pass by #272, a lone Judge can never clear it) or the Judge ruled it
		// `unfixable-blocker`. If ANY survivor is unclearable, the set can never converge no matter how many
		// fixable ones the author clears — so a mixed fixable+unclearable set must NOT keep iterating; raise
		// to a human now instead of burning revision passes. Also stop once the configured `maxRevisions`
		// budget is spent (0 → no author revision at all). (Cross-model disagreement already returns above.)
		const hasUnclearableSurvivor = carried.some((candidate) => isSafetyFloorClass(candidate.finding.class, taxonomy, safetyFloor) || rulings.get(candidate.candidateId) === "unfixable-blocker");
		// `!author || !revise` short-circuits every no-revise run (effectiveMaxRevisions is 0 there anyway),
		// and narrows both to non-undefined for the author-seat construction below (revise mode only).
		if (outcome !== "hard-block" || pass === policy.maxPasses || !report || hasUnclearableSurvivor || revisionsUsed >= effectiveMaxRevisions || !author || !revise) {
			const dissentCandidate = carried.find((candidate) => rulings.get(candidate.candidateId) === "judgment-dissent");
			return withFloor({
				outcome,
				diversity,
				passes,
				survivors: carried,
				notes,
				cost,
				...(dissentCandidate ? { dissent: { finding: dissentCandidate, ruling: "judgment-dissent", attemptedResolution: "one author revision pass", notificationTarget: options.notificationTarget ?? "PR reviewers" } } : {}),
			});
		}
		const revisionSignal = childSignal();
		const revision = await options.runSeat({
			role: "author",
			slot: { id: "author", provider: author.provider, ...(author.provider === "codex" ? { codexModel: author.model } : { model: author.model }) } as ReviewSlot,
			pass,
			prompt: revise(carried),
			parkSignal: revisionSignal,
		});
		if (revisionSignal.parked) Object.assign(options.parkSignal, revisionSignal);
		cost += revision.cost;
		if (!revision.ok || cost > policy.budgetCap) return withFloor({ outcome: options.parkSignal.parked || cost > policy.budgetCap ? "budget" : "hard-block", diversity, passes, survivors: carried, notes, cost });
		revisionsUsed++;
	}
	return withFloor({ outcome: "hard-block", diversity, passes, survivors: carried, notes, cost });
}
