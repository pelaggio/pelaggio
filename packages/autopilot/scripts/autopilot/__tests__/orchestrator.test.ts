import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runOrchestrator } from "../pipeline.js";
import { StatusBar } from "../tui.js";
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

describe("runOrchestrator — resume --from override", () => {
	it("override wins and short-circuits detectResumeStep", async (t) => {
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: { "TOOL-99": { completed: true, cost: 1 } },
		});
		let detectCalled = 0;
		const detectResumeStep = () => {
			detectCalled++;
			return "ship" as const;
		};
		const { exitCode } = await runOrchestrator({ ...baseFlags, resume: "tool-99", from: "implement" }, { runPipeline, detectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 0);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.startFrom, "implement");
		assert.equal(detectCalled, 0, "detectResumeStep must not run when --from overrides");
	});

	it("invalid --from exits 2 without invoking runPipeline", async (t) => {
		t.mock.method(console, "error", () => {});
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: true } });
		const { exitCode } = await runOrchestrator({ ...baseFlags, resume: "X", from: "bogus" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 2);
		assert.equal(calls.length, 0);
	});

	it("--from pick exits 2 without invoking runPipeline (pick never executes in resume mode)", async (t) => {
		t.mock.method(console, "error", () => {});
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: true } });
		const { exitCode } = await runOrchestrator({ ...baseFlags, resume: "X", from: "pick" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 2);
		assert.equal(calls.length, 0);
	});

	it("--from without --resume exits 2 without invoking runPipeline", async (t) => {
		t.mock.method(console, "error", () => {});
		t.mock.method(console, "log", () => {});
		const { runPipeline, calls } = createMockRunPipeline({ default: { completed: true } });
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "X-1", from: "implement" }, { runPipeline });
		assert.equal(exitCode, 2);
		assert.equal(calls.length, 0);
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
		const logs: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => {
			logs.push(args.join(" "));
		});
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
		assert.ok(
			logs.some((l) => l.includes("Resume:") && l.includes("pnpm autopilot --resume X-1")),
			`expected the --resume hint in logs; got:\n${logs.join("\n")}`,
		);
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
		const logs: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => {
			logs.push(args.join(" "));
		});
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
		assert.ok(
			logs.some((l) => l.includes("Resume:") && l.includes("pnpm autopilot --resume X-1")),
			`expected the --resume hint in logs; got:\n${logs.join("\n")}`,
		);
	});
});

describe("runOrchestrator — auto-resume config", () => {
	it("off-switch: park.auto-resume=false reports parked items and exits 1 without resuming", async (t) => {
		const logs: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const baseNow = 1_700_000_000_000;
		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"X-1": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
			},
		});
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "X-1" }, { runPipeline, park: { autoResume: false }, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 1);
		assert.equal(calls.length, 1, `expected no resume when auto-resume disabled; got ${calls.length} calls`);
		assert.ok(
			logs.some((l) => l.includes("auto-resume disabled")),
			`expected off-switch wording in logs; got:\n${logs.join("\n")}`,
		);
		assert.ok(
			logs.some((l) => l.includes("Resume:") && l.includes("pnpm autopilot --resume X-1")),
			`expected the --resume hint (not --item, which pick's worktree-exists guard refuses) in logs; got:\n${logs.join("\n")}`,
		);
	});

	it("off-switch: multiple parked items each get their own --resume line (#56)", async (t) => {
		const logs: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const baseNow = 1_700_000_000_000;
		const { runPipeline } = createMockRunPipeline({
			byItem: {
				"X-1": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
				"X-2": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
			},
		});
		// parallel: "2" so both cycles are pulled by their own worker before either observes
		// parkSignal.parked — with the default parallel: "1" the single worker's `if
		// (parkSignal.parked) break;` (pipeline.ts) would stop after X-1 and X-2 would never run.
		const { exitCode } = await runOrchestrator({ ...baseFlags, item: "X-1,X-2", parallel: "2" }, { runPipeline, park: { autoResume: false }, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 1);
		const resumeLine = logs.find((l) => l.includes("Resume:"));
		assert.ok(resumeLine, `expected a Resume: line in logs; got:\n${logs.join("\n")}`);
		assert.ok(resumeLine.includes("pnpm autopilot --resume X-1") && resumeLine.includes("pnpm autopilot --resume X-2"), `expected one --resume command per parked item; got:\n${resumeLine}`);
		assert.ok(!resumeLine.includes("--item"), `--item is refused by pick's worktree-exists guard on an already-claimed id; got:\n${resumeLine}`);
	});

	it("multi-window: park→park→success resumes across two windows (3 runPipeline calls)", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"X-1": [
					{ completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
					{ completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
					{ completed: true, cost: 0.5 },
				],
			},
			// Trap: mocked Date.now() advances with tick(), so a static resetsAt would already
			// be in the past by round 2 (gate would read waitMs<=0 → exit parked). Re-anchor each
			// still-parked round's reset to now+60s so every reset is genuinely in the future.
			onCall: (_opts, ps) => {
				if (ps.parked) ps.resetsAt = Date.now() + 60_000;
			},
		});

		const promise = runOrchestrator({ ...baseFlags, item: "X-1" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		// Round 1: let it reach the wait, tick past resumeAt (reset + ≤30s jitter), drain.
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		t.mock.timers.tick(60_000 + 30_000);
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		// Round 2: same again — this time the resume succeeds.
		t.mock.timers.tick(60_000 + 30_000);
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		const { results } = await promise;

		assert.equal(calls.length, 3, `expected 3 runPipeline calls (initial park + 2 resume rounds); got ${calls.length}`);
		assert.equal(results.at(-1)?.completed, true, "final resume should complete");
	});

	it("config park.max-wait caps the wait when --max-wait flag is unset (exits parked)", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"X-1": { completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 3 * 3600_000, limitType: "5h" } },
			},
		});
		// Flags without --max-wait; inject config cap 1h. A 3h reset exceeds it → exit parked.
		const flagsNoMaxWait: Flags = { cycles: "1", parallel: "1", verbose: false, trace: false, budget: "10", "dry-run": false };
		const { exitCode } = await runOrchestrator({ ...flagsNoMaxWait, item: "X-1" }, { runPipeline, park: { maxWait: "1h" }, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		assert.equal(exitCode, 1);
		assert.equal(calls.length, 1, `expected no resume (config max-wait exceeded); got ${calls.length}`);
	});

	it("--max-wait CLI flag overrides config park.max-wait (resume proceeds)", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const { runPipeline, calls } = createMockRunPipeline({
			byItem: {
				"X-1": [
					{ completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 3 * 3600_000, limitType: "5h" } },
					{ completed: true, cost: 0.5 },
				],
			},
		});
		// Config cap 1h would block a 3h reset, but CLI --max-wait 5h overrides it → resume.
		const promise = runOrchestrator({ ...baseFlags, item: "X-1", "max-wait": "5h" }, { runPipeline, park: { maxWait: "1h" }, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree });
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		t.mock.timers.tick(3 * 3600_000 + 30_000);
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		const { results } = await promise;

		assert.equal(calls.length, 2, `expected resume to proceed (CLI cap 5h > 3h wait); got ${calls.length}`);
		assert.equal(results.at(-1)?.completed, true);
	});

	it("multi-window then exceeds max-wait: tears down the status bar before exiting (no leaked scroll region)", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		// setup/teardown are no-ops in plain (non-TTY) mode, so the leak is invisible to
		// a real bar under test — spy the calls directly to assert they stay balanced.
		const bar = new StatusBar({ plain: true });
		const events: string[] = [];
		t.mock.method(bar, "setup", () => events.push("setup"));
		t.mock.method(bar, "teardown", () => events.push("teardown"));

		const { runPipeline } = createMockRunPipeline({
			byItem: {
				// Round 1 resumes within max-wait, then re-parks with a reset 3h out that
				// exceeds the 1h cap → the round-2 gate must break, not early-return.
				"X-1": [
					{ completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
					{ completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 3 * 3600_000, limitType: "5h" } },
				],
			},
		});

		const promise = runOrchestrator({ ...baseFlags, item: "X-1", verbose: true, "max-wait": "1h" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree }, bar);
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		t.mock.timers.tick(60_000 + 30_000);
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		const { exitCode } = await promise;

		assert.equal(exitCode, 1);
		const setups = events.filter((e) => e === "setup").length;
		const teardowns = events.filter((e) => e === "teardown").length;
		assert.equal(setups, teardowns, `setup/teardown must stay balanced; got ${JSON.stringify(events)}`);
		assert.equal(events.at(-1), "teardown", `the run must end on a teardown, not a leaked setup; got ${JSON.stringify(events)}`);
	});
});

describe("runOrchestrator — notifications", () => {
	type Sent = { url: string; format: string; payload: { event: string; itemId: string | null; completed: boolean; shipwrecked: boolean } };
	function spySend() {
		const sent: Sent[] = [];
		const sendNotification = async (url: string, format: "json" | "ntfy", payload: Sent["payload"]) => {
			sent.push({ url, format, payload });
			return true;
		};
		return { sent, sendNotification };
	}

	it("sends one classified notification per terminal cycle", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: true, cost: 0.1 },
				"A-2": { completed: false, cost: 0.1, error: "plan failed" },
			},
		});
		await runOrchestrator({ ...baseFlags, item: "A-1,A-2" }, { runPipeline, notifyConfig: { url: "https://hook.example" }, sendNotification });
		assert.equal(sent.length, 2);
		assert.equal(sent[0].url, "https://hook.example");
		assert.equal(sent[0].payload.event, "shipped");
		assert.equal(sent[0].payload.itemId, "A-1");
		assert.equal(sent[1].payload.event, "failed");
		assert.equal(sent[1].payload.itemId, "A-2");
	});

	it("classifies a PR-opened cycle from awaitingMerge", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline } = createMockRunPipeline({
			byItem: { "A-1": { completed: true, cost: 0.1, awaitingMerge: true, prUrl: "https://github.com/x/y/pull/5" } },
		});
		await runOrchestrator({ ...baseFlags, item: "A-1" }, { runPipeline, notifyConfig: { url: "https://hook.example" }, sendNotification });
		assert.equal(sent.length, 1);
		assert.equal(sent[0].payload.event, "pr-opened");
	});

	it("does not call the transport when notify.url is unset (the default)", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline } = createMockRunPipeline({ byItem: { "A-1": { completed: true, cost: 0.1 } } });
		await runOrchestrator({ ...baseFlags, item: "A-1" }, { runPipeline, sendNotification });
		assert.equal(sent.length, 0);
	});

	it("does not notify in --dry-run even with a url configured", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline } = createMockRunPipeline({ byItem: { "A-1": { completed: true, cost: 0.1 } } });
		await runOrchestrator({ ...baseFlags, item: "A-1", "dry-run": true }, { runPipeline, notifyConfig: { url: "https://hook.example" }, sendNotification });
		assert.equal(sent.length, 0);
	});

	it("skips non-actionable outcomes (e.g. pick:queue-empty)", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: false, cost: 0, error: "pick:queue-empty" },
				"A-2": { completed: true, cost: 0.1 },
			},
		});
		await runOrchestrator({ ...baseFlags, item: "A-1,A-2" }, { runPipeline, notifyConfig: { url: "https://hook.example" }, sendNotification });
		// A-1 skipped (recoverable), A-2 shipped.
		assert.equal(sent.length, 1);
		assert.equal(sent[0].payload.event, "shipped");
		assert.equal(sent[0].payload.itemId, "A-2");
	});

	it("emits on the --resume path", async (t) => {
		t.mock.method(console, "log", () => {});
		const { sent, sendNotification } = spySend();
		const { runPipeline } = createMockRunPipeline({ byItem: { "TOOL-99": { completed: true, cost: 1 } } });
		await runOrchestrator({ ...baseFlags, resume: "tool-99" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree, notifyConfig: { url: "https://hook.example" }, sendNotification });
		assert.equal(sent.length, 1);
		assert.equal(sent[0].payload.event, "shipped");
		assert.equal(sent[0].payload.itemId, "TOOL-99");
	});

	it("emits for both the initial park and the resumed cycle", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(console, "log", () => {});
		const baseNow = 1_700_000_000_000;
		t.mock.timers.setTime(baseNow);

		const { sent, sendNotification } = spySend();
		const { runPipeline } = createMockRunPipeline({
			byItem: {
				"X-1": [
					{ completed: false, cost: 0.1, error: "parked", park: { parked: true, resetsAt: baseNow + 60_000, limitType: "5h" } },
					{ completed: true, cost: 0.5 },
				],
			},
		});

		const promise = runOrchestrator({ ...baseFlags, item: "X-1" }, { runPipeline, detectResumeStep: fakeDetectResumeStep, resolveWorktree: fakeResolveWorktree, notifyConfig: { url: "https://hook.example" }, sendNotification });
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		t.mock.timers.tick(60_000 + 30_000);
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		await promise;

		assert.equal(sent.length, 2);
		assert.equal(sent[0].payload.event, "parked");
		assert.equal(sent[1].payload.event, "shipped");
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
