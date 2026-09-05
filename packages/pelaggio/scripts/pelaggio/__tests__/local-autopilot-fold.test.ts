import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { foldRunEvents } from "../local-autopilot/fold.js";
import { parseRunSnapshot } from "../local-autopilot/parse.js";
import { makeProblem } from "../local-autopilot/transport.js";
import type { RunEvent } from "../local-autopilot/types.js";

const parsedFixture = parseRunSnapshot(JSON.parse(readFileSync(new URL("./fixtures/local-autopilot/snapshot-ready-for-review.json", import.meta.url), "utf8")));
if (!parsedFixture.ok) throw new Error(parsedFixture.problem.message);
const fixture = parsedFixture.value;
const artifact = fixture.artifacts[0];
function events(...steps: Array<[string, Record<string, unknown>?]>): RunEvent[] {
	const sequence: Array<[string, Record<string, unknown>?]> = [["run-started", { workContract: fixture.workContract, execution: fixture.execution, worktree: fixture.worktree }], ...steps];
	return sequence.map(([type, payload], seq) => ({ schemaVersion: 1, eventId: `event-${seq}`, runId: fixture.runId, seq, at: fixture.createdAt, type: `pelaggio.local-autopilot.${type}`, payload }));
}
const passed: [string, Record<string, unknown>] = ["verification-finished", { ok: true, artifact }];
const failed: [string, Record<string, unknown>] = ["verification-finished", { ok: false, artifact, message: "failed" }];
const ready: [string, Record<string, unknown>] = ["run-completed", { disposition: "ready_for_review" }];
const interrupted: [string, Record<string, unknown>] = ["run-paused", { pauseReason: { code: "interrupted", message: "interrupted" } }];

test("readiness requires the current successful verification and its artifact", () => {
	assert.throws(() => foldRunEvents(events(["harness-finished"], failed, ready)), /successful current verification/);
	assert.throws(() => foldRunEvents(events(["harness-finished"], ["verification-finished", { ok: true }], ready)), /successful current verification/);
	assert.throws(() => foldRunEvents(events(["harness-finished"], passed, failed, ready)), /successful current verification/);
	assert.throws(() => foldRunEvents(events(["harness-finished"], failed, ["repair-attempted"], ready)), /successful current verification/);
	assert.throws(() => foldRunEvents(events(["harness-finished"], passed, ["problem", { problem: makeProblem({ type: "harness", code: "failed", message: "unresolved", retryable: false }) }], ready)), /unresolved blocking problems/);
});

test("paused runs cannot progress or clear blockers through completion; cancellation remains legal", () => {
	for (const event of [ready, ["run-completed", { disposition: "failed" }], ["fake-progress", { nextIndex: 1 }], ["harness-finished"], passed, ["repair-attempted"]] as Array<[string, Record<string, unknown>?]>) {
		assert.throws(() => foldRunEvents(events(["harness-finished"], passed, interrupted, event)), /paused|running/);
	}
	const cancelled = foldRunEvents(events(interrupted, ["run-completed", { disposition: "cancelled" }]));
	assert.equal(cancelled.snapshot.disposition, "cancelled");
	assert.equal(cancelled.snapshot.pauseReason, undefined);
});

test("phase-invalid journals fail before projecting a ready snapshot", () => {
	assert.throws(() => foldRunEvents(events(passed, ready)), /verification phase/);
	assert.throws(() => foldRunEvents(events(["repair-attempted"])), /failed verification/);
	assert.throws(() => foldRunEvents(events(["harness-finished"], passed, ["repair-attempted"])), /failed verification/);
	assert.throws(() => foldRunEvents(events(["harness-finished", { forcedFailure: "red" }], passed)), /forced verification failure/);
	assert.throws(() => foldRunEvents(events(["problem", { problem: { schemaVersion: 1, type: "harness", code: "INVALID", message: "bad", retryable: false } }])), /code is invalid/);
});

test("normal completion, repair, and interrupted verification recovery stay valid", () => {
	for (const journal of [
		events(["harness-finished"], passed, ready),
		events(["harness-finished"], passed, passed, ready),
		events(["harness-finished"], interrupted, ["run-resumed"], passed, ready),
		events(["harness-finished"], failed, ["repair-attempted"], ["fake-progress", { nextIndex: 1, action: { kind: "complete" } }], ["harness-finished"], passed, ready),
	]) {
		const result = foldRunEvents(journal);
		assert.equal(result.snapshot.disposition, "ready_for_review");
		assert.ok(parseRunSnapshot(result.snapshot).ok);
	}
});
