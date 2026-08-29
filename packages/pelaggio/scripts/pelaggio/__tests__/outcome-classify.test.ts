import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyParkReason, classifyStepError, isRefusal, isTransientSdkError, looksLikeRefusal, looksLikeStalledAsk, parseBlockedReason, parseResetTime, parseWaitFlag, resolveParkReset } from "../outcome-classify.js";

describe("parseWaitFlag", () => {
	it("parses hours", () => {
		assert.equal(parseWaitFlag("6h"), 21_600_000);
	});

	it("parses minutes", () => {
		assert.equal(parseWaitFlag("90m"), 5_400_000);
	});

	it("parses combined hours and minutes", () => {
		assert.equal(parseWaitFlag("1h30m"), 5_400_000);
	});

	it("treats bare number as minutes", () => {
		assert.equal(parseWaitFlag("360"), 21_600_000);
	});

	it("falls back to 6h on garbage input", () => {
		assert.equal(parseWaitFlag("garbage"), 21_600_000);
	});

	it("parses hours-only without minutes", () => {
		assert.equal(parseWaitFlag("2h"), 7_200_000);
	});

	it("parses minutes-only without hours", () => {
		assert.equal(parseWaitFlag("5m"), 300_000);
	});

	it('returns 0ms for "0h"', () => {
		assert.equal(parseWaitFlag("0h"), 0);
	});

	it('returns 0ms for "0m"', () => {
		assert.equal(parseWaitFlag("0m"), 0);
	});

	it("falls back to 6h for empty string", () => {
		assert.equal(parseWaitFlag(""), 21_600_000);
	});
});

describe("resolveParkReset", () => {
	const NOW = 1_700_000_000_000;
	const HOUR = 3_600_000;
	const resetText = "resets 4:30pm (America/Edmonton)"; // parseResetTime → a concrete future ts

	it("trusts a concrete reset already on the event", () => {
		const r = resolveParkReset(NOW + 5 * HOUR, true, "5h", resetText, NOW, HOUR);
		assert.deepEqual(r, { resetsAt: NOW + 5 * HOUR, limitType: "5h" });
	});

	it("a reset parsed from text wins over the estimate (regression: don't clobber a real reset)", () => {
		const r = resolveParkReset(0, true, "5h", resetText, NOW, HOUR);
		assert.equal(r.resetsAt, parseResetTime(resetText));
		assert.equal(r.limitType, "5h"); // not marked (estimated) — it's a real reset
	});

	it("estimates + marks (estimated) for a rate-limit park with no reset anywhere (Codex 429)", () => {
		const r = resolveParkReset(0, true, "unknown", "no reset here", NOW, HOUR);
		assert.deepEqual(r, { resetsAt: NOW + HOUR, limitType: "unknown (estimated)" });
	});

	it("a manual pause (not a rate-limit park) with no reset keeps 0 → hands back", () => {
		const r = resolveParkReset(0, false, "paused", "no reset here", NOW, HOUR);
		assert.deepEqual(r, { resetsAt: 0, limitType: "paused" });
	});

	it("negative reported reset falls through to the estimate", () => {
		const r = resolveParkReset(-1, true, "weekly", "no reset here", NOW, HOUR);
		assert.deepEqual(r, { resetsAt: NOW + HOUR, limitType: "weekly (estimated)" });
	});
});

describe("parseResetTime", () => {
	it("returns 0 for invalid input", () => {
		assert.equal(parseResetTime("no match here"), 0);
	});

	it("returns 0 for empty string", () => {
		assert.equal(parseResetTime(""), 0);
	});

	it("parses valid reset time to a future timestamp", () => {
		// Build a time string that's always in the future (next hour)
		const now = new Date();
		const futureHour = (now.getUTCHours() + 2) % 12 || 12;
		const period = (now.getUTCHours() + 2) % 24 >= 12 ? "pm" : "am";
		const msg = `resets ${futureHour}${period} (UTC)`;
		const result = parseResetTime(msg);
		assert.ok(result > 0, `expected positive timestamp, got ${result}`);
		assert.ok(result > Date.now() - 86_400_000, "timestamp should be reasonable");
	});

	it("parses time with minutes", () => {
		const msg = "resets 4:30pm (America/Edmonton)";
		const result = parseResetTime(msg);
		// Should return a valid timestamp (either today or tomorrow)
		assert.ok(result > 0, `expected positive timestamp, got ${result}`);
	});
});

describe("classifyParkReason", () => {
	it("lets a structured limitType win over any reason text", () => {
		assert.equal(classifyParkReason(null, "paused"), "paused");
		assert.equal(classifyParkReason(null, "sdk-outage"), "sdk-outage");
		assert.equal(classifyParkReason("adversarial review dissent", "5h"), "rate-limit");
	});

	it("classifies the review-loop park reasons the pipeline actually emits", () => {
		assert.equal(classifyParkReason("adversarial review could not bind current HEAD", ""), "review-binding");
		assert.equal(classifyParkReason("adversarial review could not bind final reviewed HEAD", ""), "review-binding");
		assert.equal(classifyParkReason("adversarial review escalation active", ""), "review-escalation");
		assert.equal(classifyParkReason("adversarial review escalation write-failed", ""), "review-escalation");
		assert.equal(classifyParkReason("adversarial review safety blocker", ""), "review-blocked");
		assert.equal(classifyParkReason("adversarial review hard-block", ""), "review-blocked");
		assert.equal(classifyParkReason("adversarial review dissent", ""), "review-blocked");
		assert.equal(classifyParkReason("adversarial review budget", ""), "review-blocked");
		assert.equal(classifyParkReason("adversarial review produced no loop result", ""), "review-blocked");
	});

	it("treats an effects failure after escalation as effects-failed, not escalation", () => {
		assert.equal(classifyParkReason("shakedown-code effects failed after escalation: gh pr edit exploded", ""), "effects-failed");
	});

	it("returns unclassified for an absent or unrecognized reason", () => {
		assert.equal(classifyParkReason(null, null), "unclassified");
		assert.equal(classifyParkReason("", ""), "unclassified");
		assert.equal(classifyParkReason("something nobody has seen before", ""), "unclassified");
	});
});

describe("classifyStepError", () => {
	it("classifies rate-limit messages", () => {
		assert.equal(classifyStepError("rate limit exceeded", false), "error_rate_limit");
		assert.equal(classifyStepError("usage limit reached", false), "error_rate_limit");
		assert.equal(classifyStepError("quota exhausted", false), "error_rate_limit");
	});

	it("lets the authoritative parked flag win over an unrelated message", () => {
		assert.equal(classifyStepError("some unrelated failure", true), "error_rate_limit");
	});

	it("does NOT classify a safety 'rejected' as a rate limit (dropped-word regression guard)", () => {
		assert.equal(classifyStepError("request rejected by safety filter", false), "error_sdk");
	});

	it("classifies budget, abort, and max-turns", () => {
		assert.equal(classifyStepError("budget exceeded", false), "error_budget");
		assert.equal(classifyStepError("aborted", false), "error_abort");
		assert.equal(classifyStepError("max turns reached", false), "error_max_turns");
	});

	it("falls through to error_sdk for a generic message", () => {
		assert.equal(classifyStepError("something else broke", false), "error_sdk");
	});
});

describe("isTransientSdkError", () => {
	it("matches transient provider and transport failures", () => {
		for (const text of [
			"Anthropic API error: 500 Internal server error",
			"model overloaded, please try again",
			"temporarily unavailable",
			"service unavailable",
			"read ECONNRESET",
			"request ETIMEDOUT",
			"connect ECONNREFUSED",
			"socket hang up",
			"fetch failed",
			"upstream returned 502",
			"status code 503",
			"gateway timeout 504",
		]) {
			assert.equal(isTransientSdkError({ subtype: "error_sdk", text }), true, text);
		}
	});

	it("does not match fatal provider/config/user failures", () => {
		for (const text of ["invalid api key", "authentication failed", "unauthorized", "forbidden", "permission denied", "bad request", "status 400", "status 404", "unprocessable entity 422"]) {
			assert.equal(isTransientSdkError({ subtype: "error_sdk", text }), false, text);
		}
	});

	it("lets fatal exclusions win over transient-looking text", () => {
		assert.equal(isTransientSdkError({ subtype: "error_sdk", text: "401 unauthorized; upstream also mentioned 500 Internal server error" }), false);
	});

	it("ignores non-sdk subtypes", () => {
		assert.equal(isTransientSdkError({ subtype: "error_max_turns", text: "500 Internal server error" }), false);
		assert.equal(isTransientSdkError({ subtype: "error_rate_limit", text: "service unavailable" }), false);
	});

	it("does not match arbitrary digit runs containing 500", () => {
		assert.equal(isTransientSdkError({ subtype: "error_sdk", text: "changed 500 files successfully before crashing" }), false);
		assert.equal(isTransientSdkError({ subtype: "error_sdk", text: "estimated $500 cost" }), false);
	});
});

describe("looksLikeRefusal", () => {
	it("matches each refusal opener variant", () => {
		assert.equal(looksLikeRefusal("I can't help with that."), true);
		assert.equal(looksLikeRefusal("I cannot assist with this request."), true);
		assert.equal(looksLikeRefusal("I'm not able to continue here."), true);
		assert.equal(looksLikeRefusal("I am unable to comply."), true);
		assert.equal(looksLikeRefusal("I won't be able to help with this."), true);
		assert.equal(looksLikeRefusal("I must decline this task."), true);
		assert.equal(looksLikeRefusal("I'm sorry, but I can't do that."), true);
	});

	it("does not match a decline discussed mid-paragraph (anchoring guard)", () => {
		assert.equal(looksLikeRefusal("The reviewer notes the code can't be simplified further."), false);
	});

	it("does not match a long legitimate review", () => {
		const review = `The plan is well-structured. It correctly addresses the rubric's Correct dimension by ${"padding ".repeat(40)}and the verdict is sound.`;
		assert.equal(looksLikeRefusal(review), false);
	});

	it("returns false for empty input", () => {
		assert.equal(looksLikeRefusal(""), false);
	});
});

describe("isRefusal", () => {
	it("is true for the structured refusal stop_reason regardless of text", () => {
		assert.equal(isRefusal("refusal", ""), true);
		assert.equal(isRefusal("refusal", "Here is a normal-looking review."), true);
	});

	it("trusts a populated non-refusal stop_reason over refusal-shaped text", () => {
		assert.equal(isRefusal("end_turn", "I can't help with that."), false);
	});

	it("falls back to the text heuristic when stop_reason is absent", () => {
		assert.equal(isRefusal(null, "I can't help with that. This request touches security tooling."), true);
		assert.equal(isRefusal(undefined, "I must decline this review."), true);
	});

	it("does not treat a mid-paragraph decline as a refusal when stop_reason is absent", () => {
		assert.equal(isRefusal(null, "The reviewer notes the code can't be simplified further."), false);
	});
});

describe("parseBlockedReason", () => {
	it("parses a trailing BLOCKED: line into its reason", () => {
		assert.equal(parseBlockedReason("Investigated the issue.\nBLOCKED: missing API key"), "missing API key");
	});

	it("tolerates bold markers (matching parseVerdict)", () => {
		assert.equal(parseBlockedReason("**BLOCKED:** missing X"), "missing X");
	});

	it("parses even when trailing blank lines follow the sentinel", () => {
		assert.equal(parseBlockedReason("BLOCKED: schema field absent\n\n  \n"), "schema field absent");
	});

	it("returns a placeholder reason for an empty BLOCKED: sentinel", () => {
		assert.equal(parseBlockedReason("BLOCKED:"), "(no reason given)");
	});

	it("returns null for a normal final paragraph", () => {
		assert.equal(parseBlockedReason("Implemented the feature and ran the tests. All green."), null);
	});

	it("does not fire on a mid-text mention followed by a normal finish (false-positive guard)", () => {
		const text = "I considered whether this is BLOCKED: no, I found a workaround.\nImplemented successfully.";
		assert.equal(parseBlockedReason(text), null);
	});

	it("is case-sensitive — lowercase blocked prose does not match", () => {
		assert.equal(parseBlockedReason("the task is blocked: on a missing dependency"), null);
	});

	it("returns null for empty input", () => {
		assert.equal(parseBlockedReason(""), null);
	});
});

describe("looksLikeStalledAsk", () => {
	it("flags a trailing question", () => {
		assert.equal(looksLikeStalledAsk("Here is what I did.\nShall I proceed?"), true);
	});

	it("flags an offer-to-continue without a question mark", () => {
		assert.equal(looksLikeStalledAsk("Want me to continue with the next file"), true);
	});

	it("returns false for a plain completion statement", () => {
		assert.equal(looksLikeStalledAsk("Implemented the feature and ran the tests. All green."), false);
	});

	it("returns false for empty input", () => {
		assert.equal(looksLikeStalledAsk(""), false);
	});

	it("returns false on a plain completion even though a BLOCKED line is the caller's precedence concern", () => {
		assert.equal(looksLikeStalledAsk("Done. Everything is committed."), false);
	});
});
