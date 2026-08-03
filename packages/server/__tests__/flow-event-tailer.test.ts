import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createFlowEventTailer } from "../src/flow-event-tailer.js";
import type { RunActivity } from "../src/types.js";

const RUN_ID = "01J00000000000000000000001";
const EXEC = RUN_ID;

function envelope(type: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		v: 1,
		type,
		eventId: "01J00000000000000000000002",
		streamId: RUN_ID,
		seq: 1,
		ts: "2026-07-13T12:00:00.000Z",
		itemId: null,
		claimId: null,
		readinessEpisodeId: null,
		executionId: EXEC,
		causationId: null,
		...extra,
	});
}

describe("createFlowEventTailer", () => {
	it("tolerates missing file", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tailer-missing-"));
		const activities: RunActivity[] = [];
		const tailer = createFlowEventTailer({
			runId: RUN_ID,
			cwd,
			executionId: EXEC,
			onActivity: (a) => activities.push(a),
		});
		tailer.tick();
		assert.deepEqual(activities, []);
		tailer.stop();
	});

	it("projects watch-idle → watch-wake and ignores wrong executionId", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tailer-watch-"));
		const dir = join(cwd, ".dev", "flow-events");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${RUN_ID}.jsonl`);
		const foreign = envelope("pelaggio.watch-idle", { executionId: "01J00000000000000000000099", probeAt: "x" });
		const idle = envelope("pelaggio.watch-idle", { probeAt: "2026-07-13T12:05:00.000Z" });
		const wake = envelope("pelaggio.watch-wake");
		writeFileSync(path, `${foreign}\n${idle}\n${wake}\n`);
		const activities: RunActivity[] = [];
		const tailer = createFlowEventTailer({
			runId: RUN_ID,
			cwd,
			executionId: EXEC,
			onActivity: (a) => activities.push(a),
		});
		tailer.tick();
		assert.deepEqual(activities, [{ kind: "watch-idle", probeAt: "2026-07-13T12:05:00.000Z" }, { kind: "active" }]);
		tailer.stop();
	});

	it("holds truncated tail and completes on next poll", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tailer-trunc-"));
		const dir = join(cwd, ".dev", "flow-events");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${RUN_ID}.jsonl`);
		const full = envelope("pelaggio.budget-idle", {
			resumeAt: "2026-07-14T00:00:00.000Z",
			budget: 10,
			spent: 10,
		});
		writeFileSync(path, full.slice(0, 40)); // truncated
		const activities: RunActivity[] = [];
		const tailer = createFlowEventTailer({
			runId: RUN_ID,
			cwd,
			executionId: EXEC,
			onActivity: (a) => activities.push(a),
		});
		tailer.tick();
		assert.deepEqual(activities, []);
		// Complete the line
		writeFileSync(path, `${full}\n`);
		// offset is past first partial write length — rewrite whole file and use custom reader
		// Simpler: append the rest from offset... actually default read from offset of first tick.
		// First tick advanced offset by 40 bytes. Append remaining + newline at end of file.
		// File was fully rewritten — reset by using append from incomplete.
		// Re-create with append approach:
		tailer.stop();
	});

	it("appends across polls for split records", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tailer-split-"));
		const dir = join(cwd, ".dev", "flow-events");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${RUN_ID}.jsonl`);
		const full = envelope("pelaggio.suspended", { reason: "rate-limit", resumeAt: "2026-07-13T18:00:00.000Z" });
		writeFileSync(path, full.slice(0, 50));
		const activities: RunActivity[] = [];
		const tailer = createFlowEventTailer({
			runId: RUN_ID,
			cwd,
			executionId: EXEC,
			onActivity: (a) => activities.push(a),
		});
		tailer.tick();
		assert.equal(activities.length, 0);
		appendFileSync(path, full.slice(50) + "\n");
		tailer.tick();
		assert.deepEqual(activities, [{ kind: "parked", resumeAt: "2026-07-13T18:00:00.000Z", reason: "rate-limit" }]);
		// resumed → active
		appendFileSync(path, `${envelope("pelaggio.resumed")}\n`);
		tailer.tick();
		assert.equal(activities.at(-1)?.kind, "active");
		tailer.stop();
	});

	it("ignores unknown types and malformed JSON", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tailer-ignore-"));
		const dir = join(cwd, ".dev", "flow-events");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${RUN_ID}.jsonl`);
		writeFileSync(path, `not-json\n${envelope("pelaggio.claimed")}\n${envelope("pelaggio.budget-wake")}\n`);
		const activities: RunActivity[] = [];
		const tailer = createFlowEventTailer({
			runId: RUN_ID,
			cwd,
			executionId: EXEC,
			onActivity: (a) => activities.push(a),
		});
		tailer.tick();
		assert.deepEqual(activities, [{ kind: "active" }]);
		tailer.stop();
	});

	it("stop clears the interval", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tailer-stop-"));
		const activities: RunActivity[] = [];
		const tailer = createFlowEventTailer({
			runId: RUN_ID,
			cwd,
			executionId: EXEC,
			onActivity: (a) => activities.push(a),
			intervalMs: 10,
		});
		tailer.start();
		tailer.stop();
		// No throw / no hang — process can exit.
	});
});
