import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BLOCKED_KINDS, canRetryWithinBudget, classifyCycleDisposition, classifyFailure, classifyOutcome, decodeCycleOutcome, FAILURE_CLASSES, parseVerdict } from "../cycle-outcome.js";

describe("classifyFailure", () => {
	it("maps raw provider subtypes before harness error strings", () => {
		assert.equal(classifyFailure({ error: "implement failed", subtype: "error_sdk" }), "provider");
		assert.equal(classifyFailure({ error: "x", subtype: "error_budget" }), "budget");
		assert.equal(classifyFailure({ error: "x", subtype: "error_max_turns" }), "turn-limit");
		assert.equal(classifyFailure({ error: "x", subtype: "error_effects_manifest" }), "effects");
		assert.equal(classifyFailure({ error: "x", subtype: "error_abort" }), "aborted");
	});

	it("covers the explicit harness assignment table", () => {
		assert.equal(classifyFailure({ error: "pick:blocked" }), "selection");
		assert.equal(classifyFailure({ error: "transient sdk error" }), "provider");
		assert.equal(classifyFailure({ error: "plan needs rethink" }), "verification");
		assert.equal(classifyFailure({ error: "ship failed (recovery also failed)" }), "delivery");
		assert.equal(classifyFailure({ error: "implement failed" }), "unclassified");
	});
});

describe("decodeCycleOutcome", () => {
	it("decodes current outcomes and records class provenance", () => {
		assert.deepEqual(decodeCycleOutcome({ outcome: "failed", failureClass: "provider", error: "transient sdk error", completed: true }), {
			outcome: "failed",
			failureClass: "provider",
			error: "transient sdk error",
			failureClassProvenance: "recorded",
		});
		assert.deepEqual(decodeCycleOutcome({ outcome: "blocked", blockedKind: "future-kind", reason: "x" }), { outcome: "blocked", blockedKind: "unknown", reason: "x", blockedKindProvenance: "unknown" });
		assert.deepEqual(decodeCycleOutcome({ outcome: "parked", parkClass: "future-class", parkReason: "x" }), { outcome: "parked", parkClass: "unknown", parkReason: "x", parkClassProvenance: "unknown" });
	});

	it("decodes pre-union flags with completed/parked/blocked/failed precedence", () => {
		assert.deepEqual(decodeCycleOutcome({ completed: true, error: "ignored", parked: true }), { outcome: "completed" });
		assert.equal(decodeCycleOutcome({ completed: false, error: "parked" })?.outcome, "parked");
		assert.deepEqual(decodeCycleOutcome({ completed: false, error: "parked", parkClass: "constructor" }), { outcome: "parked", parkClass: "unknown", parkReason: null, parkClassProvenance: "unknown" });
		assert.equal(decodeCycleOutcome({ completed: false, error: "implement blocked: missing API key" })?.outcome, "blocked");
		assert.equal(decodeCycleOutcome({ completed: false, error: "pick:blocked" })?.outcome, "failed");
	});

	it("keeps the class allowlists exhaustive", () => {
		assert.deepEqual([...FAILURE_CLASSES].sort(), ["aborted", "budget", "confinement", "delivery", "effects", "provider", "refusal", "selection", "turn-limit", "unclassified", "verification"].sort());
		assert.deepEqual([...BLOCKED_KINDS].sort(), ["capability", "charter-defect", "environment", "prerequisite", "spec-defect", "unclassified"].sort());
	});
});

describe("canRetryWithinBudget", () => {
	it("allows the retry when remaining budget ≥ step budget", () => {
		assert.equal(canRetryWithinBudget({ spent: 10, maxBudget: 40, stepBudget: 25 }), true);
	});

	it("skips the retry when remaining budget < step budget", () => {
		assert.equal(canRetryWithinBudget({ spent: 20, maxBudget: 40, stepBudget: 25 }), false);
	});

	it("allows the retry at the exact boundary (remaining === step budget)", () => {
		assert.equal(canRetryWithinBudget({ spent: 15, maxBudget: 40, stepBudget: 25 }), true);
	});

	it("disables the gate for a non-finite maxBudget (unset / unparseable --budget)", () => {
		assert.equal(canRetryWithinBudget({ spent: 100, maxBudget: NaN, stepBudget: 25 }), true);
	});
});

describe("classifyOutcome", () => {
	it("maps each closed subtype to itself (identity on branched values)", () => {
		for (const s of ["success", "error_rate_limit", "error_max_turns", "error_refusal", "error_confinement", "blocked", "edit_loop"] as const) {
			assert.equal(classifyOutcome({ subtype: s }), s);
		}
	});

	it("collapses the free-form error subtypes to the catch-all 'error'", () => {
		assert.equal(classifyOutcome({ subtype: "error_sdk" }), "error");
		assert.equal(classifyOutcome({ subtype: "error_budget" }), "error");
		assert.equal(classifyOutcome({ subtype: "error_abort" }), "error");
	});

	it("collapses unknown / arbitrary subtype strings to 'error'", () => {
		assert.equal(classifyOutcome({ subtype: "unknown" }), "error");
		assert.equal(classifyOutcome({ subtype: "totally-made-up" }), "error");
		assert.equal(classifyOutcome({ subtype: "" }), "error");
	});
});

describe("parseVerdict", () => {
	it("parses an explicit Verdict: line", () => {
		assert.equal(parseVerdict("Verdict: APPROVE"), "APPROVE");
		assert.equal(parseVerdict("Verdict: REVISE"), "REVISE");
		assert.equal(parseVerdict("Verdict: RETHINK"), "RETHINK");
	});

	it("parses existing VERDICT: and bold shapes", () => {
		assert.equal(parseVerdict("VERDICT: APPROVE"), "APPROVE");
		assert.equal(parseVerdict("Verdict: **APPROVE**"), "APPROVE");
	});

	it("parses a bare keyword when no verdict line is present", () => {
		assert.equal(parseVerdict("This plan needs a RETHINK before proceeding."), "RETHINK");
		assert.equal(parseVerdict("Please REVISE the approach."), "REVISE");
	});

	it("returns APPROVE for an engaged review that omitted the keyword (fail-safe preserved)", () => {
		const review = `This review checks the plan against the rubric. The Correct dimension holds: ${"the approach is sound and ".repeat(8)}no blocker found.`;
		assert.equal(parseVerdict(review), "APPROVE");
	});

	it("fails closed to RETHINK for empty, refused, or non-review output", () => {
		assert.equal(parseVerdict(""), "RETHINK");
		assert.equal(parseVerdict("I can't help with that."), "RETHINK");
		assert.equal(parseVerdict("ok done"), "RETHINK");
	});
});

describe("classifyCycleDisposition", () => {
	const recoverable = new Set(["transient sdk error"]);

	it("continues completed and recoverable cycles", () => {
		assert.equal(classifyCycleDisposition({ itemId: "1", cost: 0, outcome: "completed" }, recoverable), "continue");
		assert.equal(classifyCycleDisposition({ itemId: "1", cost: 0, outcome: "failed", failureClass: "provider", error: "transient sdk error" }, recoverable), "continue");
	});

	it("lets aborted override a stale disposition", () => {
		assert.equal(classifyCycleDisposition({ itemId: "1", cost: 0, outcome: "failed", failureClass: "aborted", error: "aborted", disposition: "quarantine-and-continue" }, recoverable), "halt-campaign");
	});

	it("passes through explicit dispositions", () => {
		assert.equal(classifyCycleDisposition({ itemId: "1", cost: 0, outcome: "parked", parkClass: "unclassified", parkReason: "repair failed", disposition: "halt-campaign" }, recoverable), "halt-campaign");
		assert.equal(classifyCycleDisposition({ itemId: "1", cost: 0, outcome: "blocked", blockedKind: "unclassified", reason: "x", disposition: "quarantine-and-continue" }, recoverable), "quarantine-and-continue");
		assert.equal(classifyCycleDisposition({ itemId: "1", cost: 0, outcome: "blocked", blockedKind: "unclassified", reason: "x", disposition: "halt-campaign" }, recoverable), "halt-campaign");
	});

	it("halts unknown non-recoverable failures", () => {
		assert.equal(classifyCycleDisposition({ itemId: "1", cost: 0, outcome: "failed", failureClass: "unclassified", error: "unknown failure" }, recoverable), "halt-campaign");
	});
});
