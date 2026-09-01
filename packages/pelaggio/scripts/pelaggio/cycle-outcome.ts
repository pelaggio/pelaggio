/** Cycle verdict policy (L2): review verdicts, outcome classification, retry budget, disposition. */

import { BLOCKED_KIND_SET, CYCLE_OUTCOME_SET, FAILURE_CLASS_SET, PARK_CLASS_SET } from "./cycle-errors.js";
import { looksLikeRefusal, type StepSubtype } from "./outcome-classify.js";

export { BLOCKED_KIND_COVERAGE, BLOCKED_KINDS, CYCLE_OUTCOME_COVERAGE, CYCLE_OUTCOME_SET, CYCLE_OUTCOMES, FAILURE_CLASS_COVERAGE, FAILURE_CLASSES, NAMED_BLOCKED_KIND_COVERAGE, NAMED_BLOCKED_KINDS } from "./cycle-errors.js";

import type { BlockedKind, ClassificationProvenance, CycleDisposition, CycleResult, CycleResultBase, DecodedCycleOutcome, FailureClass, ParkClass, StepResult } from "./types.js";

const CLOSED_SUBTYPES: ReadonlySet<string> = new Set(["success", "error_rate_limit", "error_max_turns", "error_refusal", "error_confinement", "blocked", "edit_loop"]);

export function classifyOutcome(result: Pick<StepResult, "subtype">): StepSubtype {
	return CLOSED_SUBTYPES.has(result.subtype) ? (result.subtype as StepSubtype) : "error";
}

export function classifyCycleDisposition(result: CycleResult, recoverable: ReadonlySet<string>): CycleDisposition {
	switch (result.outcome) {
		case "completed":
		case "parked":
			return "continue";
		case "blocked":
			return result.disposition ?? "halt-campaign";
		case "failed":
			if (result.error === "aborted") return "halt-campaign";
			if (result.disposition) return result.disposition;
			return recoverable.has(result.error) ? "continue" : "halt-campaign";
	}
}

function failureClassFromSubtype(subtype: string | undefined): FailureClass | null {
	switch (subtype) {
		case "error_sdk":
			return "provider";
		case "error_budget":
			return "budget";
		case "error_max_turns":
			return "turn-limit";
		case "error_refusal":
			return "refusal";
		case "error_confinement":
			return "confinement";
		case "error_effects_manifest":
			return "effects";
		case "error_abort":
			return "aborted";
		default:
			return null;
	}
}

function failureClassFromError(error: string): FailureClass {
	if (error === "aborted") return "aborted";
	if (error === "transient sdk error") return "provider";
	if (error.endsWith(" failed: confinement violation") || error === "ship failed: confinement violation") return "confinement";
	if (error.endsWith(" failed (insufficient budget to retry after max turns)")) return "budget";
	if (error.endsWith(" failed (max retries)")) return "turn-limit";
	if (/ refused \(model declined /.test(error)) return "refusal";
	if (error.startsWith("shakedown-code effects failed")) return "effects";
	if (error.startsWith("pick:") || error === "no item ID parsed" || /worktree (?:missing|ambiguous)/.test(error) || /assignment failed/.test(error) || /author attribution is unavailable/.test(error) || error === "revise lease unavailable")
		return "selection";
	if (
		error.startsWith("typecheck:ratchet failed") ||
		error.startsWith("PR freshness") ||
		/could not bind|could not snapshot|HEAD moved during pre-flight/.test(error) ||
		error.startsWith("nothing to ship") ||
		/review findings/.test(error) ||
		error.startsWith("empty --review-findings") ||
		error.startsWith("conflict repair incomplete") ||
		error === "plan needs rethink" ||
		/execution context (?:failed|unexpectedly disabled)/.test(error)
	)
		return "verification";
	if (error.startsWith("ship failed") || /ship bookkeeping failed|cannot capture pre-ship git state|post-merge verification|main did not advance|recovery also failed/.test(error)) return "delivery";
	return "unclassified";
}

export function classifyFailure(input: { error: string; subtype?: string }): FailureClass {
	return failureClassFromSubtype(input.subtype) ?? failureClassFromError(input.error);
}

export function cycleResultBase(result: CycleResult): CycleResultBase {
	return {
		itemId: result.itemId,
		cost: result.cost,
		...(result.costEstimated !== undefined ? { costEstimated: result.costEstimated } : {}),
		...(result.verdict !== undefined ? { verdict: result.verdict } : {}),
		...(result.disposition !== undefined ? { disposition: result.disposition } : {}),
		...(result.detail !== undefined ? { detail: result.detail } : {}),
		...(result.awaitingMerge !== undefined ? { awaitingMerge: result.awaitingMerge } : {}),
		...(result.prUrl !== undefined ? { prUrl: result.prUrl } : {}),
		...(result.shipwrecked !== undefined ? { shipwrecked: result.shipwrecked } : {}),
		...(result.bookkeepingWarnings !== undefined ? { bookkeepingWarnings: result.bookkeepingWarnings } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storedClassMember<T extends string>(value: unknown, allowlist: ReadonlySet<string>): { member: T | "unrecorded" | "unknown"; provenance: ClassificationProvenance } {
	if (value === undefined || value === null || value === "") return { member: "unrecorded", provenance: "unrecorded" };
	if (typeof value !== "string") return { member: "unknown", provenance: "unknown" };
	return allowlist.has(value) ? { member: value as T, provenance: "recorded" } : { member: "unknown", provenance: "unknown" };
}

function storedParkClass(value: unknown): { parkClass: ParkClass | "unrecorded" | "unknown"; parkClassProvenance: ClassificationProvenance } {
	const cls = storedClassMember<ParkClass>(value, PARK_CLASS_SET);
	return { parkClass: cls.member, parkClassProvenance: cls.provenance };
}

export function decodeCycleOutcome(record: unknown): DecodedCycleOutcome | null {
	if (!isRecord(record)) return null;
	if (typeof record.outcome === "string" && CYCLE_OUTCOME_SET.has(record.outcome)) {
		switch (record.outcome) {
			case "completed":
				return { outcome: "completed" };
			case "parked": {
				const park = storedParkClass(record.parkClass);
				return { outcome: "parked", parkClass: park.parkClass, parkReason: typeof record.parkReason === "string" ? record.parkReason : null, parkClassProvenance: park.parkClassProvenance };
			}
			case "blocked": {
				const kind = storedClassMember<BlockedKind>(record.blockedKind, BLOCKED_KIND_SET);
				return { outcome: "blocked", blockedKind: kind.member, reason: typeof record.reason === "string" ? record.reason : "", blockedKindProvenance: kind.provenance };
			}
			case "failed": {
				const cls = storedClassMember<FailureClass>(record.failureClass, FAILURE_CLASS_SET);
				return { outcome: "failed", failureClass: cls.member, error: typeof record.error === "string" ? record.error : "", failureClassProvenance: cls.provenance };
			}
		}
	}
	if (record.outcome !== undefined || typeof record.completed !== "boolean") return null;
	if (record.completed) return { outcome: "completed" };
	if (record.parked === true || record.error === "parked") {
		const park = storedParkClass(record.parkClass);
		return { outcome: "parked", parkClass: park.parkClass, parkReason: typeof record.parkReason === "string" ? record.parkReason : null, parkClassProvenance: park.parkClassProvenance };
	}
	const error = typeof record.error === "string" ? record.error : null;
	if (error !== null && / blocked: /.test(error)) {
		const kind = storedClassMember<BlockedKind>(record.blockedKind, BLOCKED_KIND_SET);
		return { outcome: "blocked", blockedKind: kind.member, reason: error, blockedKindProvenance: kind.provenance };
	}
	const cls = storedClassMember<FailureClass>(record.failureClass, FAILURE_CLASS_SET);
	return { outcome: "failed", failureClass: cls.member, error: error ?? "", failureClassProvenance: cls.provenance };
}

// ── Retry budget decision ──────────────────────────────────────────────

/**
 * Whether a step that ended in `error_max_turns` may be re-entered once more with a
 * fresh turn budget (issue #33). The attempt-count bound is owned by the caller's loop;
 * this owns only the dollar gate: a retry is funded up to the step's configured budget
 * again, so skip it when too little remains. A non-finite `maxBudget` (unset / unparseable
 * `--budget`) disables the gate — the caller's attempt cap still bounds the retry.
 */
export function canRetryWithinBudget(args: { spent: number; maxBudget: number; stepBudget: number }): boolean {
	if (!Number.isFinite(args.maxBudget)) return true;
	return args.maxBudget - args.spent >= args.stepBudget;
}

// ── Verdict parsing ────────────────────────────────────────────────────

// Vocabulary a genuine rubric review uses. Presence of any term (in a
// substantial, non-refusal body) is what distinguishes a real review that
// merely omitted the verdict keyword from an empty/refused/truncated one.
const REVIEW_SIGNAL = /\b(?:rubric|verdict|fix[- ]?now|near[- ]?term|deferred|well-(?:typed|tested|factored)|idiomatic|idioms|concise|correctness|blocker)\b/i;

function reviewEngaged(text: string): boolean {
	const t = text.trim();
	if (t.length < 120) return false; // a real review is substantial
	if (looksLikeRefusal(t)) return false; // a decline is not engagement
	return REVIEW_SIGNAL.test(t);
}

export function parseVerdict(text: string): "APPROVE" | "REVISE" | "RETHINK" {
	const match = text.match(/verdict[:\s*]+\*{0,2}(APPROVE|REVISE|RETHINK)\b/i);
	if (match?.[1]) return match[1].toUpperCase() as "APPROVE" | "REVISE" | "RETHINK";
	if (/\bRETHINK\b/i.test(text)) return "RETHINK";
	if (/\bREVISE\b/i.test(text)) return "REVISE";
	// No verdict keyword. Fail closed: an empty/refused/truncated shakedown must
	// not read as an implicit APPROVE and ship on a phantom sign-off. Return
	// RETHINK — the only verdict that HALTS the cycle (REVISE still proceeds to
	// implement+ship) — unless the output shows the review actually engaged with
	// the rubric, which preserves the historical APPROVE fail-safe for a genuine
	// review that merely omitted the keyword.
	return reviewEngaged(text) ? "APPROVE" : "RETHINK";
}
