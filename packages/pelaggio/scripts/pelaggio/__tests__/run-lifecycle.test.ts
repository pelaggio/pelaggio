import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readEventLog } from "../flow-events.js";
import { RUN_HEARTBEAT_MS, startRunLifecycle } from "../run-lifecycle.js";
import type { Flags } from "../types.js";

const EXECUTION_ID = "01J00000000000000000000001";

const baseFlags: Flags = {
	cycles: "1",
	parallel: "1",
	verbose: false,
	trace: false,
	budget: "10",
	"dry-run": false,
	"no-worktree": false,
};

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "pelaggio-run-lifecycle-"));
}

function blockMainThread(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, ms);
}

describe("startRunLifecycle", () => {
	it("does not create lifecycle artifacts in dry-run", () => {
		const root = tempRoot();
		const lifecycle = startRunLifecycle({
			root,
			executionId: EXECUTION_ID,
			flags: { ...baseFlags, "dry-run": true },
		});
		lifecycle.finish({ outcome: "completed", exitCode: 0 });
		lifecycle.stop();

		assert.equal(existsSync(join(root, ".dev", "flow-events")), false);
	});

	it("keeps heartbeats fresh while the main thread is synchronously blocked", () => {
		const root = tempRoot();
		const lifecycle = startRunLifecycle({
			root,
			executionId: EXECUTION_ID,
			flags: { ...baseFlags, item: "40" },
			heartbeatMs: 1_000,
		});

		blockMainThread(1_200);
		const unblockedAt = Date.now();
		lifecycle.finish({ outcome: "completed", exitCode: 0 });
		lifecycle.finish({ outcome: "failed", exitCode: 1 });
		lifecycle.stop();

		const read = readEventLog({ root, cycleLogPath: null });
		const starts = read.events.filter((event) => event.type === "pelaggio.run-started");
		const heartbeats = read.events.filter((event) => event.type === "pelaggio.run-heartbeat");
		const finishes = read.events.filter((event) => event.type === "pelaggio.run-finished");
		assert.equal(starts.length, 1);
		assert.ok(heartbeats.length >= 1);
		assert.equal(finishes.length, 1);
		assert.ok(unblockedAt - Date.parse(heartbeats.at(-1)?.ts ?? "") < 1_500, "worker heartbeat must remain fresh");
		assert.deepEqual(
			read.events.map((event) => event.seq),
			read.events.map((_, index) => index + 1),
		);
		assert.ok(read.events.every((event) => event.streamId === starts[0]?.streamId && event.executionId === EXECUTION_ID));
		const start = starts[0];
		if (start?.type === "pelaggio.run-started") {
			assert.equal(start.heartbeatMs, 1_000);
			assert.equal(start.itemId, "40");
			assert.equal(start.mode, undefined);
			assert.equal(start.resumed, undefined);
		}
		const finish = finishes[0];
		if (finish?.type === "pelaggio.run-finished") {
			assert.equal(finish.outcome, "completed");
			assert.equal(finish.exitCode, 0);
		}
	});

	it("advertises watch mode and resumed identity from flags", () => {
		const root = tempRoot();
		const lifecycle = startRunLifecycle({
			root,
			executionId: EXECUTION_ID,
			flags: { ...baseFlags, resume: "40", preset: "watch" },
			heartbeatMs: RUN_HEARTBEAT_MS,
		});
		lifecycle.finish({ outcome: "parked", exitCode: 75 });
		lifecycle.stop();
		const start = readEventLog({ root, cycleLogPath: null }).events[0];
		assert.equal(start?.type, "pelaggio.run-started");
		if (start?.type === "pelaggio.run-started") {
			assert.equal(start.itemId, "40");
			assert.equal(start.mode, "watch");
			assert.equal(start.resumed, true);
		}
	});

	it("calls onError once when the lifecycle segment cannot be created", () => {
		const root = join(tempRoot(), "not-a-directory");
		writeFileSync(root, "occupied");
		const errors: unknown[] = [];
		const lifecycle = startRunLifecycle({
			root,
			executionId: EXECUTION_ID,
			flags: baseFlags,
			onError: (error) => errors.push(error),
		});
		lifecycle.finish({ outcome: "completed", exitCode: 0 });
		lifecycle.stop();
		assert.equal(errors.length, 1);
		assert.match(String(errors[0]), /failed to start/);
	});

	it("reports a mid-run heartbeat failure without delaying finish", async () => {
		const root = tempRoot();
		const errors: unknown[] = [];
		const lifecycle = startRunLifecycle({
			root,
			executionId: EXECUTION_ID,
			flags: baseFlags,
			heartbeatMs: 1_000,
			onError: (error) => errors.push(error),
		});
		const eventsDir = join(root, ".dev", "flow-events");
		const segment = readdirSync(eventsDir)[0];
		assert.ok(segment);
		chmodSync(join(eventsDir, segment), 0o400);
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal(errors.length, 1);

		const finishStartedAt = Date.now();
		lifecycle.finish({ outcome: "failed", exitCode: 1 });
		assert.ok(Date.now() - finishStartedAt < 500, "known-dead worker must not consume the acknowledgement timeout");
	});
});
