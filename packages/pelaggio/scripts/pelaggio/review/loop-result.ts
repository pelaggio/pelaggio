/**
 * Persisted shape of one authoring-review loop (L1): the seat, pass, candidate and result types that
 * `review/loop.ts` (L2) produces and `review/record.ts` (L1) writes. Type-only, so the record writer
 * never depends on loop policy — the last `L1 -> L2` edge the module-architecture plan carried.
 */
import type { ProviderName, ReviewOutcome, StepResult, TokenUsage } from "../types.js";
import type { UsageMeasurement } from "../usage-measurement.js";
import type { AuthoringReviewFinding, ReviewFindingsParseErrorCode } from "./findings.js";
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
	| { completion: "returned"; attempt: number; ok: boolean; subtype: string; cost: number; turns: number; tokens?: TokenUsage; usageMeasurement?: UsageMeasurement; output: SeatOutputObservation }
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
	reviewers: Array<{ identity: DriverIdentity; ok: boolean; cost: number; turns: number; tokens?: TokenUsage; verdict?: DriverReviewVerdict; diagnostic?: string; attempts?: SeatAttemptRecord[] }>;
	judge: { identity: DriverIdentity; valid: boolean; cost: number; turns: number; tokens?: TokenUsage; diagnostic?: string; attempts?: SeatAttemptRecord[]; skipped?: JudgeSkipReason };
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
