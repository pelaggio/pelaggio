import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canRetryWithinBudget, classifyCycleDisposition, classifyOutcome, parseVerdict } from "../cycle-outcome.js";

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
		assert.equal(classifyCycleDisposition({ completed: true }, recoverable), "continue");
		assert.equal(classifyCycleDisposition({ completed: false, error: "transient sdk error" }, recoverable), "continue");
	});

	it("lets aborted override a stale disposition", () => {
		assert.equal(classifyCycleDisposition({ completed: false, error: "aborted", disposition: "quarantine-and-continue" }, recoverable), "halt-campaign");
	});

	it("passes through explicit dispositions", () => {
		assert.equal(classifyCycleDisposition({ completed: false, disposition: "quarantine-and-continue" }, recoverable), "quarantine-and-continue");
		assert.equal(classifyCycleDisposition({ completed: false, disposition: "halt-campaign" }, recoverable), "halt-campaign");
	});

	it("halts unknown non-recoverable failures", () => {
		assert.equal(classifyCycleDisposition({ completed: false, error: "unknown failure" }, recoverable), "halt-campaign");
	});
});
