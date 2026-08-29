/** Parse provider/step results into typed shapes — errors, refusals, park signals (L1). Renders no verdict. */

import type { ParkClass, StepResult } from "./types.js";

// Anchored refusal openers: a decline announces itself in the first sentence.
// Matching only at the start of the trimmed final result keeps a review that
// merely *discusses* a decline mid-paragraph ("the code can't be simplified")
// from tripping the heuristic.
const REFUSAL_OPENERS: readonly RegExp[] = [
	/^i can(?:'|no)?t (?:help|assist|comply|continue|provide|do)\b/i,
	/^i cannot (?:help|assist|comply|continue|provide|do)\b/i,
	/^i(?:'m| am) (?:not able|unable) to\b/i,
	/^i won'?t (?:be able|help|assist)\b/i,
	/^i must decline\b/i,
	/^i(?:'m| am) sorry,? but i (?:can(?:'|no)?t|cannot|won'?t)\b/i,
];

/** Conservative, anchored text heuristic: does the output *open* with a refusal? */
export function looksLikeRefusal(text: string): boolean {
	const head = text.trim().slice(0, 200);
	return REFUSAL_OPENERS.some((re) => re.test(head));
}

/**
 * Structured-first refusal classifier. A streaming safety decline surfaces as
 * `subtype: "success"` with `stop_reason: "refusal"` — trust that signal first.
 * A populated non-refusal `stop_reason` means the turn completed normally, so
 * don't second-guess it. Only fall back to the text heuristic when the SDK
 * surfaced no `stop_reason` at all.
 */
export function isRefusal(stopReason: string | null | undefined, resultText: string): boolean {
	if (stopReason === "refusal") return true;
	if (stopReason != null) return false;
	return looksLikeRefusal(resultText);
}

/**
 * Categorize a thrown SDK step error into a `subtype`. The authoritative
 * `parked` flag (set by the structured `rate_limit_event` handler) wins first;
 * remaining branches key off the message text. Deliberately does NOT match a
 * bare "rejected" — that word also appears in safety refusals, which must be
 * terminal (`error_sdk`), not parked forever as a phantom rate limit.
 */
export function classifyStepError(errMsg: string, parked: boolean): string {
	if (parked || /rate.?limit|usage.?limit|quota/i.test(errMsg)) return "error_rate_limit";
	if (/budget/i.test(errMsg)) return "error_budget";
	if (/abort/i.test(errMsg)) return "error_abort";
	if (/max.*turns|turn.?limit|maximum.*turns/i.test(errMsg)) return "error_max_turns";
	return "error_sdk";
}

const FATAL_SDK_ERROR_RE = /\b(?:invalid api key|authentication|unauthorized|forbidden|permission|bad request|40[0-9]|422)\b/i;

const TRANSIENT_SDK_ERROR_RE = /\b(?:internal server error|overloaded|temporarily unavailable|service unavailable|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed)\b/i;

const TRANSIENT_SDK_STATUS_RE = /(?<!\$)\b(?:500|502|503|504)\b(?!\s*(?:files?|cost|usd|dollars?))/i;

export function isTransientSdkError(result: Pick<StepResult, "subtype" | "text">): boolean {
	if (result.subtype !== "error_sdk") return false;
	if (FATAL_SDK_ERROR_RE.test(result.text)) return false;
	return TRANSIENT_SDK_ERROR_RE.test(result.text) || TRANSIENT_SDK_STATUS_RE.test(result.text);
}

/**
 * Closed classification of a step outcome, used ONLY at pipeline decision points
 * (retry/park/ship branching). Distinct from the free-form `StepResult.subtype`
 * that flows into the jsonl log / TUI / notify telemetry — those keep the raw
 * value (e.g. `error_sdk`, `error_budget`, `error_abort`) so classifying here
 * never flattens telemetry. Every closed member is identity on the branched
 * subtype; everything else (SDK/budget/abort errors, `unknown`, arbitrary
 * strings) collapses to the catch-all `"error"`.
 */
export type StepSubtype = "success" | "error_rate_limit" | "error_max_turns" | "error_refusal" | "error_confinement" | "blocked" | "edit_loop" | "error";

/**
 * Closed classification of *why* a cycle parked, recorded next to the free-form
 * `parkReason` detail in the cycle log.
 *
 * Two families reach `parkExit()`: signal-driven parks carry a structured
 * `parkSignal.limitType` (rate limit, operator pause, SDK outage), while
 * review-loop parks pass an explicit reason string and leave `limitType` empty.
 * Only the former was ever persisted, so every review-gate park logged a null
 * reason — which made "parked because a reviewer found a real blocker" and
 * "parked because the provider fell over" indistinguishable in the stats.
 *
 * `limitType` wins when present: it is already structured. The reason string is
 * matched only as a fallback, most-specific first — "effects failed after
 * escalation" is an effects failure, not an escalation.
 */
export function classifyParkReason(reason: string | null | undefined, limitType: string | null | undefined): ParkClass {
	const limit = (limitType ?? "").trim();
	if (limit === "paused") return "paused";
	if (limit === "sdk-outage") return "sdk-outage";
	if (limit) return "rate-limit";
	const text = (reason ?? "").trim();
	if (!text) return "unclassified";
	if (/effects failed/i.test(text)) return "effects-failed";
	if (/could not bind/i.test(text)) return "review-binding";
	if (/escalation/i.test(text)) return "review-escalation";
	if (/safety blocker|hard-block|dissent|budget|no loop result/i.test(text)) return "review-blocked";
	return "unclassified";
}

/**
 * A step that cannot finish ends its final message with a trailing sentinel line
 * `BLOCKED: <reason>` (see `AUTONOMY_APPEND`). Parsed out-of-band because the SDK
 * reports a polite stall as `subtype: "success"`. Trailing-line semantics (last
 * non-blank line must match) so a mid-text mention — "is this BLOCKED: no, …" —
 * followed by a normal finish is NOT a false positive. Bold markers tolerated,
 * matching `parseVerdict`. `BLOCKED` stays uppercase/case-sensitive so prose
 * ("the task is blocked") never matches. Returns the reason, or null when not blocked.
 */
export function parseBlockedReason(text: string): string | null {
	const lines = text.split("\n");
	let i = lines.length - 1;
	while (i >= 0 && lines[i].trim() === "") i--;
	if (i < 0) return null;
	const m = lines[i].match(/^\s*\*{0,2}BLOCKED:\*{0,2}\s*(.*\S)?\s*$/);
	if (!m) return null;
	return m[1]?.trim() || "(no reason given)";
}

// Offer-to-continue phrasings that read as a stall even without a trailing `?`.
const STALLED_ASK_PHRASING = /\b(want me to|shall i|should i|let me know|would you like|do you want)\b/i;

/**
 * Observe-only soft heuristic: a final message that ends in a question or an
 * offer-to-continue without the `BLOCKED:` sentinel. Never fails a step —
 * legitimate final messages can contain questions — it only feeds the
 * `stalled_ask` telemetry, so false positives are acceptable.
 */
export function looksLikeStalledAsk(text: string): boolean {
	const lines = text.split("\n");
	let i = lines.length - 1;
	while (i >= 0 && lines[i].trim() === "") i--;
	if (i < 0) return false;
	const last = lines[i].trim();
	return last.endsWith("?") || STALLED_ASK_PHRASING.test(last);
}

// ── Git checkpointing ──────────────────────────────────────────────────

/** Parse "resets 4pm (America/Edmonton)" from an error message into a Unix-ms timestamp. */
export function parseResetTime(msg: string): number {
	const m = msg.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
	if (!m) return 0;

	let hours = parseInt(m[1], 10);
	const minutes = parseInt(m[2] ?? "0", 10);
	const period = m[3].toLowerCase();
	const tz = m[4];

	if (period === "pm" && hours !== 12) hours += 12;
	if (period === "am" && hours === 12) hours = 0;

	try {
		const now = new Date();
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(now);

		const y = parseInt(parts.find((p) => p.type === "year")!.value, 10);
		const mo = parseInt(parts.find((p) => p.type === "month")!.value, 10) - 1;
		const d = parseInt(parts.find((p) => p.type === "day")!.value, 10);

		// Compute tz offset via reference-point comparison
		const utcRef = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
		const tzRef = new Date(now.toLocaleString("en-US", { timeZone: tz }));
		const offsetMs = tzRef.getTime() - utcRef.getTime();

		const resetMs = Date.UTC(y, mo, d, hours, minutes) - offsetMs;
		return resetMs > Date.now() ? resetMs : resetMs + 86_400_000;
	} catch {
		return 0;
	}
}

// ── Wait-flag parsing & formatting ────────────────────────────────────

/** Parse "6h", "90m", "1h30m", "360" (bare number = minutes) → milliseconds. */
export function parseWaitFlag(value: string): number {
	const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
	if (match && (match[1] || match[2])) {
		const hours = parseInt(match[1] ?? "0", 10);
		const minutes = parseInt(match[2] ?? "0", 10);
		return (hours * 3600 + minutes * 60) * 1000;
	}
	const bare = parseInt(value, 10);
	if (!isNaN(bare)) return bare * 60_000; // bare number = minutes
	return 6 * 3600_000; // fallback
}

/**
 * Resolve a parked step's reset time by precedence (issue #68):
 *   1. a concrete reset already on the event (`reportedResetsAt > 0`) — trust it;
 *   2. a reset parsed from the final step text (`parseResetTime`) — the pre-existing recovery
 *      path for Claude limits that omit the reset in the event but state it in the message;
 *   3. for a rate-limit park with no reset anywhere (every Codex 429, some Claude events) — a
 *      conservative `now + estimateMs`, marked `(estimated)`, so auto-resume waits a window
 *      instead of hitting the "unknown reset → end run" path. Still bounded by the orchestrator's
 *      `--max-wait` guard; the suffix flows into the park banner, notify event, and jsonl.
 * A manual pause (`isRateLimitPark === false`, e.g. SIGUSR2) with no reset keeps `0`, so the
 * orchestrator hands back rather than auto-resuming.
 */
export function resolveParkReset(reportedResetsAt: number, isRateLimitPark: boolean, limitType: string, text: string, now: number, estimateMs: number): { resetsAt: number; limitType: string } {
	if (reportedResetsAt > 0) return { resetsAt: reportedResetsAt, limitType };
	const parsed = parseResetTime(text);
	if (parsed) return { resetsAt: parsed, limitType };
	if (isRateLimitPark) return { resetsAt: now + estimateMs, limitType: `${limitType} (estimated)` };
	return { resetsAt: 0, limitType };
}
