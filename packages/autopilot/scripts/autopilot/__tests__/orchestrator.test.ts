import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runOrchestrator } from "../pipeline.js";
import type { Flags } from "../types.js";
import { createMockRunPipeline } from "./mocks.js";

// runOrchestrator derives no-worktree (single-shot) mode from ambient env —
// CI=true or CLAUDE_AUTOPILOT_SINGLE_SHOT=1 (see pipeline.ts). These tests
// exercise the default worktree orchestration, so neutralize those vars for the
// duration of the file. Without this the suite fails under any CI runner, since
// GitHub Actions always sets CI=true, which flips the orchestrator onto the
// single-shot path and short-circuits before runPipeline is called.
const savedEnv: Record<string, string | undefined> = {};
before(() => {
	for (const key of ["CI", "CLAUDE_AUTOPILOT_SINGLE_SHOT"]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});
after(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const baseFlags: Flags = {
	cycles: "1",
	parallel: "1",
	verbose: false,
	trace: false,
	budget: "10",
	"max-wait": "6h",
	"dry-run": false,
};

const fakeResolveWorktree = (id: string): string => `/fake/wt-${id.toLowerCase()}`;
const fakeDetectResumeStep = () => "implement" as const;

describe("runOrchestrator — resume mode", () => {
	it("success: runPipeline called with startFrom and exitCode 0", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: { "TOOL-99": { completed: true, cost: 1 } },
		});
		const { exitCode, results } = await runOrchestrator({ ...baseFlags, resume: "tool-99" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.itemId, "TOOL-99");
		assert.equal(calls[0].opts.startFrom, "implement");
		assert.equal(calls[0].opts.worktree, "/fake/wt-tool-99");
		assert.equal(results.length, 1);
		assert.equal(results[0].completed, true);
	});

	it("failure: exitCode 1 when runPipeline returns completed false", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline } = createMockRunPipeline({
			byItem: { "TOOL-99": { completed: false, cost: 0, error: "plan failed" } },
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, resume: "tool-99" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 1);
	});
});

describe("runOrchestrator — invalid target", () => {
	it("exits 2 without invoking runPipeline", async (t) => {
		t.mock.method(console, "error", () => {});
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: true } });
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1", target: "bogus" }, { runPipeline });
		assert.equal(exitCode, 2);
		assert.equal(calls.length, 0);
	});
});

describe("runOrchestrator — cycle auto-sizing", () => {
	it("runs one cycle per --item entry when --cycles < items.length", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: true, cost: 0.1 },
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2,A-3", cycles: "1" }, { runPipeline });
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 3);
		assert.deepEqual(
			calls.map((c) => c.opts.itemId),
			["A-1", "A-2", "A-3"],
		);
	});
});

describe("runOrchestrator — parallel workers share mutex", () => {
	it("every runPipeline call receives the same pickMutex reference", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: true, cost: 0.1 },
		});
		await runOrchestrator({ ...baseFlags, item: "A-1,A-2,A-3", parallel: "2" }, { runPipeline });
		assert.equal(calls.length, 3);
		const mutex = calls[0].opts.pickMutex;
		assert.ok(mutex, "pickMutex should be defined when parallel > 1");
		for (const c of calls) assert.strictEqual(c.opts.pickMutex, mutex);
	});
});

describe("runOrchestrator — worker continuation", () => {
	it("recoverable error ('pick:queue-empty') keeps worker pulling subsequent cycles", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: false, cost: 0, error: "pick:queue-empty" },
				"A-2": { completed: true, cost: 0.1 },
				"A-3": { completed: true, cost: 0.1 },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2,A-3" }, { runPipeline });
		assert.equal(calls.length, 3);
		assert.equal(exitCode, 1); // overall still non-zero because A-1 didn't complete
	});

	it("fatal error stops the worker and skips remaining items", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: false, cost: 0, error: "plan failed" },
				"A-2": { completed: true, cost: 0.1 },
				"A-3": { completed: true, cost: 0.1 },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2,A-3" }, { runPipeline });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.itemId, "A-1");
		assert.equal(exitCode, 1);
	});
});

describe("runOrchestrator — park-and-resume", () => {
	it("success: resumes after wait, uses detectResumeStep startFrom, exitCode 0", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"X-1": [
					{ completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
					{ completed: true, cost: 0.5 },
				],
			},
		});

		let detectCalled = 0;
		const detectResumeStep = (id: string, _wt: string) => {
			detectCalled++;
			assert.equal(id, "X-1");
			return "ship" as const;
		};

		const promise = runOrchestrator({ ...baseFlags, item: "X-1" }, { runPipeline, detectResumeStep, resolveWorktree: fakeResolveWorktree });
		// Let the orchestrator run to its setTimeout wait, then tick past it and drain microtasks.
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		t.mock.timers.tick(60_000 + 30_000);
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		const { results } = await promise;

		// Two runPipeline calls: the parked one and the resume one.
		assert.equal(calls.length, 2);
		assert.equal(calls[1].opts.startFrom, "ship");
		assert.equal(calls[1].opts.itemId, "X-1");
		assert.ok(detectCalled >= 1, "detectResumeStep should be called for resume");
		// Results array holds both the parked cycle and the successful resume.
		assert.equal(results.length, 2);
		assert.equal(results[0].error, "parked");
		assert.equal(results[1].completed, true);
	});

	it("exceeds --max-wait: exitCode 1, runPipeline not re-invoked", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"X-1": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 3 * 3600_000, limitType: "5h" } },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "X-1", "max-wait": "1h" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 1);
		assert.equal(calls.length, 1);
	});

	it("weekly limit: uses 'Weekly rate limit' wording when exceeding max-wait", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const logs: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => {
			logs.push(args.join(" "));
		});

		const { runPipeline } = createMockRunPipeline({
			byItem: {
				"X-1": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 2 * 3600_000, limitType: "weekly" } },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "X-1", "max-wait": "1h" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 1);
		assert.ok(
			logs.some((l) => l.includes("Weekly rate limit")),
			`expected "Weekly rate limit" in logs; got:\n${logs.join("\n")}`,
		);
	});

	it("unknown reset time (resetsAt=0): exitCode 1, runPipeline not re-invoked", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"X-1": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: 0, limitType: "5h" } },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "X-1" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 1);
		assert.equal(calls.length, 1);
	});
});

describe("runOrchestrator — budget warning", () => {
	it("warns once threshold exceeded but keeps running all cycles", async (t) => {
		const logs: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const { runPipeline, calls } = createMockRunPipeline({
			default: { completed: true, cost: 1 },
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "A-1,A-2", budget: "0.01" }, { runPipeline });
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 2);
		assert.ok(
			logs.some((l) => l.includes("exceeds --budget threshold")),
			`expected budget warning in logs; got:\n${logs.join("\n")}`,
		);
	});
});
