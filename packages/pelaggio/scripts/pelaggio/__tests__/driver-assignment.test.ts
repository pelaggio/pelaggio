import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDriverAssignmentState, recordArtifactAuthor, selectAuthor, selectReviewers } from "../driver-assignment.js";

const candidates = [{ provider: "claude" as const }, { provider: "codex" as const }, { provider: "grok" as const }];

describe("driver assignment", () => {
	it("rotates authors deterministically by cycle and ordinal", () => {
		const state = createDriverAssignmentState(1);
		assert.deepEqual(
			selectAuthor(state, candidates, () => true),
			{ ok: true, drivers: [{ provider: "codex" }] },
		);
		assert.deepEqual(
			selectAuthor(state, candidates, () => true),
			{ ok: true, drivers: [{ provider: "grok" }] },
		);
	});

	it("skips unavailable authors and fails explicitly when none are ready", () => {
		assert.deepEqual(
			selectAuthor(createDriverAssignmentState(0), candidates, (driver) => driver.provider === "grok"),
			{ ok: true, drivers: [{ provider: "grok" }] },
		);
		assert.equal(selectAuthor(createDriverAssignmentState(0), candidates, () => false).ok, false);
	});

	it("selects distinct non-author review seats and fails closed on cardinality", () => {
		const state = createDriverAssignmentState(0);
		assert.deepEqual(
			selectReviewers(state, candidates, { provider: "claude" }, 2, () => true),
			{ ok: true, drivers: [{ provider: "codex" }, { provider: "grok" }] },
		);
		assert.equal(selectReviewers(state, candidates, { provider: "claude" }, 3, () => true).ok, false);
	});

	it("tracks plan and implementation authors independently", () => {
		const state = createDriverAssignmentState(0);
		recordArtifactAuthor(state, "plan", { provider: "claude" });
		recordArtifactAuthor(state, "implementation", { provider: "codex" });
		assert.deepEqual(state.authors, { plan: { provider: "claude" }, implementation: { provider: "codex" } });
	});
});
