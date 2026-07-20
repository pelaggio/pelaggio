import type { AuthoringReviewConfig, ReviewSlot } from "../config.js";
import type { ParkSignal, ProviderName, StepResult } from "../types.js";
import { type AuthoringReviewFinding, type JudgeReport, type JudgeRuling, parseAuthoringReviewFindings, parseJudgeReport, type ReviewFindingClass, reviewFindingFingerprint } from "./findings.js";

export type ReviewOutcome = "converged-clean" | "converged-with-notes" | "ceiling" | "dissent" | "hard-block" | "budget";
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
export interface ReviewPassRecord {
	pass: number;
	reviewers: Array<{ identity: DriverIdentity; ok: boolean; cost: number; turns: number; diagnostic?: string }>;
	judge: { identity: DriverIdentity; valid: boolean; cost: number; turns: number; diagnostic?: string };
	carriedBefore: string[];
	carriedAfter: string[];
}
export interface ReviewLoopResult {
	outcome: ReviewOutcome;
	diversity: DiversityStatus;
	passes: ReviewPassRecord[];
	survivors: ReviewCandidate[];
	notes: ReviewCandidate[];
	cost: number;
	dissent?: { finding: ReviewCandidate; ruling: "judgment-dissent"; attemptedResolution: string; notificationTarget: string };
}
export interface SeatRequest {
	role: "reviewer" | "judge" | "author";
	slot: ReviewSlot;
	pass: number;
	prompt: string;
	parkSignal: ParkSignal;
}
export type RunSeatFn = (request: SeatRequest) => Promise<StepResult>;
export interface ReviewLoopOptions {
	policy: AuthoringReviewConfig;
	author: { provider: ProviderName; model?: string };
	parkSignal: ParkSignal;
	runSeat: RunSeatFn;
	prompts: { review(pass: number): string; judge(candidates: readonly ReviewCandidate[], pass: number): string; revise(survivors: readonly ReviewCandidate[]): string };
	notificationTarget?: string;
}

const SAFETY_CLASSES: readonly ReviewFindingClass[] = ["security", "data-loss", "correctness-regression"];
const classRank = (value: ReviewFindingClass): number => (SAFETY_CLASSES.includes(value) ? 1 : 0);
const blockingRank = (finding: AuthoringReviewFinding): number => (finding.severity === "must-fix" ? 2 : 0) + classRank(finding.class);
const identity = (role: DriverIdentity["role"], slot: ReviewSlot, pass: number): DriverIdentity => ({
	role,
	seatId: slot.id,
	provider: slot.provider,
	...(slot.provider === "codex" ? (slot.codexModel ? { model: slot.codexModel } : {}) : slot.model ? { model: slot.model } : {}),
	sessionId: `${role}-${slot.id}-p${pass}`,
});
const childSignal = (): ParkSignal => ({ parked: false, resetsAt: 0, limitType: "", triggerWorker: "" });

export function deduplicateCandidates(findings: readonly { finding: AuthoringReviewFinding; source: string }[]): ReviewCandidate[] {
	const byFingerprint = new Map<string, ReviewCandidate>();
	for (const item of findings) {
		const fingerprint = reviewFindingFingerprint(item.finding);
		const current = byFingerprint.get(fingerprint);
		if (!current) byFingerprint.set(fingerprint, { candidateId: "", fingerprint, finding: item.finding, sources: [item.source] });
		else {
			current.sources.push(item.source);
			// Keep the most-blocking finding: must-fix severity dominates class rank, so a same-fingerprint
			// note/nice can never downgrade (and drop) a carried must-fix blocker.
			if (blockingRank(item.finding) > blockingRank(current.finding)) current.finding = item.finding;
		}
	}
	return [...byFingerprint.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)).map((candidate, index) => ({ ...candidate, candidateId: `C${index + 1}` }));
}

export function classifyReviewOutcome(survivors: readonly ReviewCandidate[], notes: readonly ReviewCandidate[], rulings: ReadonlyMap<string, JudgeRuling>, judgeValid: boolean, pass: number): ReviewOutcome {
	if (!judgeValid || survivors.some((candidate) => SAFETY_CLASSES.includes(candidate.finding.class) || rulings.get(candidate.candidateId) === "unfixable-blocker")) return "hard-block";
	if (survivors.some((candidate) => rulings.get(candidate.candidateId) === "judgment-dissent")) return "dissent";
	if (survivors.length > 0) return "hard-block";
	if (notes.length === 0) return "converged-clean";
	return pass >= 2 ? "ceiling" : "converged-with-notes";
}

export async function runReviewLoop(options: ReviewLoopOptions): Promise<ReviewLoopResult> {
	const { policy } = options;
	const configuredReviewers = policy.reviewers.filter((slot) => {
		const collidesWithAuthor = slot.provider === options.author.provider;
		const collidesWithJudge = slot.provider === policy.judge.provider;
		if (!collidesWithAuthor && !collidesWithJudge) return true;
		return !policy.reviewers.some((alternative) => alternative.id !== slot.id && alternative.provider !== options.author.provider && alternative.provider !== policy.judge.provider);
	});
	let cost = 0;
	let carried: ReviewCandidate[] = [];
	let notes: ReviewCandidate[] = [];
	const passes: ReviewPassRecord[] = [];
	const distinctProviders = new Set([options.author.provider, policy.judge.provider, ...configuredReviewers.map((slot) => slot.provider)]);
	const diversity: DiversityStatus = distinctProviders.size >= 3 ? { state: "met" } : { state: "softened", explanation: "configured seats do not provide three distinct providers" };
	for (let pass = 1; pass <= policy.maxPasses; pass++) {
		const phaseReservation = configuredReviewers.length * 5 + 5;
		if (cost + phaseReservation > policy.budgetCap) return { outcome: "budget", diversity, passes, survivors: carried, notes, cost };
		const children = configuredReviewers.map(() => childSignal());
		const settled = await Promise.allSettled(configuredReviewers.map((slot, index) => options.runSeat({ role: "reviewer", slot, pass, prompt: options.prompts.review(pass), parkSignal: children[index] })));
		for (const child of children) if (child.parked) Object.assign(options.parkSignal, child);
		const reviewerRecords: ReviewPassRecord["reviewers"] = [];
		const discovered: Array<{ finding: AuthoringReviewFinding; source: string }> = carried.map((candidate) => ({ finding: candidate.finding, source: "carried" }));
		settled.forEach((result, index) => {
			const slot = configuredReviewers[index];
			if (result.status === "rejected") {
				reviewerRecords.push({ identity: identity("reviewer", slot, pass), ok: false, cost: 0, turns: 0, diagnostic: String(result.reason) });
				return;
			}
			cost += result.value.cost;
			try {
				const report = parseAuthoringReviewFindings(result.value.fullText ?? result.value.text);
				for (const finding of report.findings) discovered.push({ finding, source: slot.id });
				reviewerRecords.push({ identity: identity("reviewer", slot, pass), ok: result.value.ok, cost: result.value.cost, turns: result.value.turns });
			} catch (error) {
				reviewerRecords.push({ identity: identity("reviewer", slot, pass), ok: false, cost: result.value.cost, turns: result.value.turns, diagnostic: error instanceof Error ? error.message : String(error) });
			}
		});
		if (!reviewerRecords.some((record) => record.ok)) return { outcome: options.parkSignal.parked ? "budget" : "hard-block", diversity, passes, survivors: carried, notes, cost };
		const candidates = deduplicateCandidates(discovered);
		const judgeSignal = childSignal();
		let judgeResult: StepResult;
		try {
			judgeResult = await options.runSeat({ role: "judge", slot: policy.judge, pass, prompt: options.prompts.judge(candidates, pass), parkSignal: judgeSignal });
		} catch {
			return { outcome: "hard-block", diversity, passes, survivors: candidates, notes, cost };
		}
		if (judgeSignal.parked) Object.assign(options.parkSignal, judgeSignal);
		cost += judgeResult.cost;
		let report: JudgeReport | undefined;
		let diagnostic: string | undefined;
		try {
			report = parseJudgeReport(judgeResult.fullText ?? judgeResult.text);
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
					return !candidate || decision.class !== candidate.finding.class;
				})
			)
				throw new Error("Judge decisions are incomplete, duplicated, reclassified, or contain unknown candidates");
		} catch (error) {
			// Completeness/parse failure must invalidate the whole pass (fail-closed):
			// `report` may already hold the parsed-but-incomplete value, so clear it or
			// `Boolean(report)` would read a malformed Judge report as valid and ship it.
			report = undefined;
			diagnostic = error instanceof Error ? error.message : String(error);
		}
		const rulings = new Map<string, JudgeRuling>();
		const next = report
			? candidates.filter((candidate) => {
					const decision = report?.decisions.find((item) => item.candidateId === candidate.candidateId);
					if (!decision) return true;
					if (decision.ruling) rulings.set(candidate.candidateId, decision.ruling);
					// #272: a single Judge must not be able to refute away a safety-class must-fix. It only
					// leaves `carried` via a fix reviewers stop rediscovering, or an explicit unfixable-blocker
					// ruling (still hard-blocks) — never a bare "refuted" decision.
					if (candidate.finding.severity === "must-fix" && SAFETY_CLASSES.includes(candidate.finding.class)) return true;
					return decision.decision === "survives";
				})
			: candidates;
		notes = candidates.filter((candidate) => candidate.finding.severity !== "must-fix");
		carried = next.filter((candidate) => candidate.finding.severity === "must-fix");
		passes.push({
			pass,
			reviewers: reviewerRecords,
			judge: { identity: identity("judge", policy.judge, pass), valid: Boolean(report), cost: judgeResult.cost, turns: judgeResult.turns, ...(diagnostic ? { diagnostic } : {}) },
			carriedBefore: discovered.filter((item) => item.source === "carried").map((item) => reviewFindingFingerprint(item.finding)),
			carriedAfter: carried.map((item) => item.fingerprint),
		});
		const outcome = classifyReviewOutcome(carried, notes, rulings, Boolean(report), pass);
		if (outcome !== "hard-block" || pass === policy.maxPasses || !report) {
			const dissentCandidate = carried.find((candidate) => rulings.get(candidate.candidateId) === "judgment-dissent");
			return {
				outcome,
				diversity,
				passes,
				survivors: carried,
				notes,
				cost,
				...(dissentCandidate ? { dissent: { finding: dissentCandidate, ruling: "judgment-dissent", attemptedResolution: "one author revision pass", notificationTarget: options.notificationTarget ?? "PR reviewers" } } : {}),
			};
		}
		const revisionSignal = childSignal();
		const revision = await options.runSeat({
			role: "author",
			slot: { id: "author", provider: options.author.provider, ...(options.author.provider === "codex" ? { codexModel: options.author.model } : { model: options.author.model }) } as ReviewSlot,
			pass,
			prompt: options.prompts.revise(carried),
			parkSignal: revisionSignal,
		});
		if (revisionSignal.parked) Object.assign(options.parkSignal, revisionSignal);
		cost += revision.cost;
		if (!revision.ok || cost > policy.budgetCap) return { outcome: options.parkSignal.parked || cost > policy.budgetCap ? "budget" : "hard-block", diversity, passes, survivors: carried, notes, cost };
	}
	return { outcome: "hard-block", diversity, passes, survivors: carried, notes, cost };
}
