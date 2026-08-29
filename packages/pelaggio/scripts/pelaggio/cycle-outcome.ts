/** Cycle verdict policy (L2): review verdicts, outcome classification, retry budget, disposition. */

import { looksLikeRefusal, type StepSubtype } from "./outcome-classify.js";
import type { CycleDisposition, CycleResult, StepResult } from "./types.js";

const CLOSED_SUBTYPES: ReadonlySet<string> = new Set(["success", "error_rate_limit", "error_max_turns", "error_refusal", "error_confinement", "blocked", "edit_loop"]);

export function classifyOutcome(result: Pick<StepResult, "subtype">): StepSubtype {
	return CLOSED_SUBTYPES.has(result.subtype) ? (result.subtype as StepSubtype) : "error";
}

export function classifyCycleDisposition(result: Pick<CycleResult, "completed" | "error" | "disposition">, recoverable: ReadonlySet<string>): CycleDisposition {
	if (result.completed) return "continue";
	if (result.error === "aborted") return "halt-campaign";
	if (result.disposition) return result.disposition;
	if (recoverable.has(result.error ?? "")) return "continue";
	return "halt-campaign";
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
	if (match) return match[1].toUpperCase() as "APPROVE" | "REVISE" | "RETHINK";
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
