import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { WORKTREE_PREFIX } from "../config.js";
import { runOrchestrator, runPipeline } from "../pipeline.js";
import type { ShipBookkeepingResult } from "../ship/index.js";
import { getShipTarget } from "../ship/index.js";
import type { Flags, ParkSignal, PipelineOpts } from "../types.js";
import { allCommitMessages, createMockRunPipeline, createMockRunStep, makeLiveStatus, makeMockRoadmap, makeNonGitDir, makeParkSignal, makeTempGitRepo, makeTempRepoWithParent } from "./mocks.js";

// The pipeline under test streams progress through console.log (see log() in
// pipeline.ts). Left unmuted, that high-volume output floods the node:test
// runner's parent<->subprocess stdout IPC and, on CI's constrained runners,
// deterministically triggers "Unable to deserialize cloned data due to invalid
// or unsupported version" as the parent mis-parses the buffer. Mute console
// output for the whole file; the one test that asserts on log content re-mocks
// console.log locally, which still captures its own calls.
before(() => {
	mock.method(console, "log", () => {});
	mock.method(console, "error", () => {});
});
after(() => {
	mock.restoreAll();
});

const baseFlags: Flags = {
	cycles: "1",
	parallel: "1",
	verbose: false,
	trace: false,
	budget: "40",
	"max-wait": "6h",
	"dry-run": false,
};

function baseOpts(worktree: string): PipelineOpts {
	return {
		itemId: "TOOL-99",
		worktree,
		cycle: 1,
		verbose: false,
		shipTarget: getShipTarget("direct-push"),
		dryRun: false,
		liveStatus: makeLiveStatus(),
	};
}

// Stub the direct-push bookkeeping tail: these pipeline tests assert on pick /
// implement / ship control flow, not on the tail (which is unit-tested in
// ship.test.ts + ship-bookkeeping.test.ts). Left un-stubbed, the real tail would
// remove the very worktree these tests inspect and mark-done against the real REPO.
const noopBookkeeping = async (): Promise<ShipBookkeepingResult> => ({
	recovered: false,
	markedDone: true,
	archived: true,
	pushed: true,
	cleanedUp: true,
	ok: true,
});

describe("runPipeline — happy path", () => {
	it("runs plan → shakedown-plan → implement → shakedown-code → ship with APPROVE verdict", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: {
					ok: true,
					sideEffect: (cwd) => {
						execSync("git checkout -q main", { cwd });
						execSync("git merge -q --no-ff feat/tool-99", { cwd });
						execSync("git checkout -q feat/tool-99", { cwd });
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
			runShipBookkeeping: noopBookkeeping,
		});

		assert.equal(result.completed, true);
		assert.equal(result.error, undefined);
		assert.equal(result.verdict, "APPROVE");
		assert.deepEqual(
			calls.map((c) => c.step),
			["plan", "shakedown-plan", "implement", "shakedown-code", "ship"],
		);
		assert.equal(logs.length, 1);
		const entry = logs[0];
		assert.equal(entry.completed, true);
		const steps = entry.steps as Array<{ name: string }>;
		assert.equal(steps.length, 5);
		assert.ok(Math.abs(result.cost - 0.05) < 1e-9, `expected cost ≈ 0.05, got ${result.cost}`);

		const implementPrompt = calls.find((c) => c.step === "implement")?.prompt ?? "";
		assert.ok(implementPrompt.includes(worktree), `expected implement prompt to mention worktree path ${worktree}; got: ${implementPrompt.slice(0, 400)}`);
		assert.ok(implementPrompt.includes("project-relative"), `expected implement prompt to include resolution rule ("project-relative"); got: ${implementPrompt.slice(0, 400)}`);
		assert.ok(implementPrompt.includes("use that absolute form"), `expected implement prompt to include "use that absolute form"; got: ${implementPrompt.slice(0, 400)}`);
	});
});

describe("runPipeline — RETHINK verdict", () => {
	it("aborts after shakedown-plan returns RETHINK, no implement", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: RETHINK" },
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "plan needs rethink");
		assert.equal(result.verdict, "RETHINK");
		assert.deepEqual(
			calls.map((c) => c.step),
			["plan", "shakedown-plan"],
		);
		assert.equal(logs.length, 1);
		assert.equal(logs[0].verdict, "RETHINK");
		assert.equal(parkSignal.parked, false);
	});
});

describe("runPipeline — implement turn-limit retry", () => {
	it("retries implement after error_max_turns and succeeds on attempt 2", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: [
					{ ok: false, subtype: "error_max_turns", writes: { "impl-a.txt": "attempt 1" } },
					{ ok: true, writes: { "impl-b.txt": "attempt 2" } },
				],
				"shakedown-code": { ok: true },
				ship: {
					ok: true,
					sideEffect: (cwd) => {
						execSync("git checkout -q main", { cwd });
						execSync("git merge -q --no-ff feat/tool-99", { cwd });
						execSync("git checkout -q feat/tool-99", { cwd });
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
			runShipBookkeeping: noopBookkeeping,
		});

		assert.equal(result.completed, true);
		const implementCalls = calls.filter((c) => c.step === "implement");
		assert.equal(implementCalls.length, 2);
		assert.deepEqual(
			implementCalls.map((c) => c.attempt),
			[1, 2],
		);

		const msgs = allCommitMessages(worktree);
		assert.ok(
			msgs.some((m) => m === "wip: autopilot implementation checkpoint"),
			`expected implementation checkpoint commit; got:\n${msgs.join("\n")}`,
		);
		assert.ok(
			msgs.some((m) => m === "wip: autopilot implementation continued"),
			`expected implementation continued commit; got:\n${msgs.join("\n")}`,
		);

		const steps = logs[0].steps as Array<{ name: string; attempt?: number; retriedMaxTurns?: boolean }>;
		const implEntries = steps.filter((s) => s.name === "implement");
		assert.ok(
			implEntries.some((s) => s.attempt === 2),
			`expected implement entry with attempt=2; got ${JSON.stringify(implEntries)}`,
		);
		const attempt2 = implEntries.find((s) => s.attempt === 2);
		assert.equal(attempt2?.retriedMaxTurns, true, `expected attempt-2 implement entry to mark retriedMaxTurns; got ${JSON.stringify(attempt2)}`);
		const attempt1 = implEntries.find((s) => s.attempt === undefined || s.attempt === 1);
		assert.ok(!attempt1?.retriedMaxTurns, `expected attempt-1 implement entry NOT to mark retriedMaxTurns; got ${JSON.stringify(attempt1)}`);

		const continuePrompt = implementCalls[1]?.prompt ?? "";
		assert.ok(continuePrompt.includes("project-relative") && continuePrompt.includes("use that absolute form"), `expected continuePrompt to carry worktree hint; got: ${continuePrompt.slice(0, 400)}`);
	});
});

describe("runPipeline — plan turn-limit retry", () => {
	it("retries plan after error_max_turns and succeeds on attempt 2, marking retriedMaxTurns", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: [{ ok: false, subtype: "error_max_turns" }, { ok: true }],
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: {
					ok: true,
					sideEffect: (cwd) => {
						execSync("git checkout -q main", { cwd });
						execSync("git merge -q --no-ff feat/tool-99", { cwd });
						execSync("git checkout -q feat/tool-99", { cwd });
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
			runShipBookkeeping: noopBookkeeping,
		});

		assert.equal(result.completed, true);
		const planCalls = calls.filter((c) => c.step === "plan");
		assert.equal(planCalls.length, 2, `expected two plan attempts; got ${planCalls.length}`);
		assert.deepEqual(
			planCalls.map((c) => c.attempt),
			[1, 2],
		);

		const steps = logs[0].steps as Array<{ name: string; attempt?: number; retriedMaxTurns?: boolean }>;
		const planEntries = steps.filter((s) => s.name === "plan");
		const attempt2 = planEntries.find((s) => s.attempt === 2);
		assert.equal(attempt2?.retriedMaxTurns, true, `expected attempt-2 plan entry to carry retriedMaxTurns; got ${JSON.stringify(planEntries)}`);
	});
});

describe("runPipeline — shakedown-plan turn-limit retry", () => {
	it("retries shakedown-plan after error_max_turns and succeeds on attempt 2, marking retriedMaxTurns", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": [
					{ ok: false, subtype: "error_max_turns" },
					{ ok: true, text: "VERDICT: APPROVE" },
				],
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: {
					ok: true,
					sideEffect: (cwd) => {
						execSync("git checkout -q main", { cwd });
						execSync("git merge -q --no-ff feat/tool-99", { cwd });
						execSync("git checkout -q feat/tool-99", { cwd });
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
			runShipBookkeeping: noopBookkeeping,
		});

		assert.equal(result.completed, true);
		assert.equal(result.verdict, "APPROVE");
		const sdpCalls = calls.filter((c) => c.step === "shakedown-plan");
		assert.equal(sdpCalls.length, 2, `expected two shakedown-plan attempts; got ${sdpCalls.length}`);
		assert.deepEqual(
			sdpCalls.map((c) => c.attempt),
			[1, 2],
		);
		const steps = logs[0].steps as Array<{ name: string; attempt?: number; retriedMaxTurns?: boolean }>;
		const attempt2 = steps.filter((s) => s.name === "shakedown-plan").find((s) => s.attempt === 2);
		assert.equal(attempt2?.retriedMaxTurns, true, `expected attempt-2 shakedown-plan entry to mark retriedMaxTurns; got ${JSON.stringify(attempt2)}`);
	});
});

describe("runPipeline — shakedown-code turn-limit retry", () => {
	it("retries shakedown-code after error_max_turns and succeeds on attempt 2, marking retriedMaxTurns", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": [{ ok: false, subtype: "error_max_turns" }, { ok: true }],
				ship: {
					ok: true,
					sideEffect: (cwd) => {
						execSync("git checkout -q main", { cwd });
						execSync("git merge -q --no-ff feat/tool-99", { cwd });
						execSync("git checkout -q feat/tool-99", { cwd });
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
			runShipBookkeeping: noopBookkeeping,
		});

		assert.equal(result.completed, true);
		const sdcCalls = calls.filter((c) => c.step === "shakedown-code");
		assert.equal(sdcCalls.length, 2, `expected two shakedown-code attempts; got ${sdcCalls.length}`);
		assert.deepEqual(
			sdcCalls.map((c) => c.attempt),
			[1, 2],
		);
		const steps = logs[0].steps as Array<{ name: string; attempt?: number; retriedMaxTurns?: boolean }>;
		const attempt2 = steps.filter((s) => s.name === "shakedown-code").find((s) => s.attempt === 2);
		assert.equal(attempt2?.retriedMaxTurns, true, `expected attempt-2 shakedown-code entry to mark retriedMaxTurns; got ${JSON.stringify(attempt2)}`);
		// The attempt-2 continue prompt is the bespoke "ran out of turns" text, not the code-review skill.
		assert.match(sdcCalls[1]?.prompt ?? "", /ran out of turns/);
	});
});

describe("runPipeline — budget guard skips turn-limit retry", () => {
	it("skips the plan retry when remaining budget is below the step budget", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		// plan step budget is $8; a --budget of $1 cannot fund a retry.
		const lowBudget: Flags = { ...baseFlags, budget: "1" };
		const { runStep, calls } = createMockRunStep(
			{
				plan: [{ ok: false, subtype: "error_max_turns" }, { ok: true }],
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, lowBudget, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.completed, false);
		assert.match(result.error ?? "", /insufficient budget to retry/);
		const planCalls = calls.filter((c) => c.step === "plan");
		assert.equal(planCalls.length, 1, `expected exactly one plan attempt (retry skipped); got ${planCalls.length}`);
		const stepsRun = calls.map((c) => c.step);
		assert.ok(!stepsRun.includes("implement"), `expected no implement; got ${stepsRun.join(",")}`);
		assert.equal(parkSignal.parked, false);
	});
});

describe("runPipeline — refusal terminates without retry or park", () => {
	it("shakedown-plan refusal → completed:false, error /refused/, no retry, no park", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: false, subtype: "error_refusal", text: "I can't help with that." },
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.completed, false);
		assert.match(result.error ?? "", /refused/);
		assert.deepEqual(
			calls.map((c) => c.step),
			["plan", "shakedown-plan"],
		);
		assert.equal(parkSignal.parked, false);
		assert.equal(logs.length, 1);
		assert.equal(logs[0].completed, false);
		assert.equal(logs[0].parked, false);
	});

	it("implement refusal → cycle terminal, error /refused/, no second implement attempt", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: false, subtype: "error_refusal", text: "I must decline this task." },
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.completed, false);
		assert.match(result.error ?? "", /refused/);
		const implementCalls = calls.filter((c) => c.step === "implement");
		assert.equal(implementCalls.length, 1, `expected no implement retry; got ${implementCalls.length} calls`);
		const stepsRun = calls.map((c) => c.step);
		assert.ok(!stepsRun.includes("shakedown-code"), `expected no shakedown-code; got ${stepsRun.join(",")}`);
		assert.ok(!stepsRun.includes("ship"), `expected no ship; got ${stepsRun.join(",")}`);
		assert.equal(parkSignal.parked, false);
	});
});

describe("runPipeline — blocked terminates without retry or park", () => {
	it("implement blocked → completed:false, reason surfaced, no attempt-2 retry, no park, subtype logged", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: false, subtype: "blocked", text: "the schema field does not exist" },
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "implement blocked: the schema field does not exist");
		const implementCalls = calls.filter((c) => c.step === "implement");
		assert.equal(implementCalls.length, 1, `expected no implement retry; got ${implementCalls.length} calls`);
		const stepsRun = calls.map((c) => c.step);
		assert.ok(!stepsRun.includes("shakedown-code"), `expected no shakedown-code; got ${stepsRun.join(",")}`);
		assert.ok(!stepsRun.includes("ship"), `expected no ship; got ${stepsRun.join(",")}`);
		assert.equal(parkSignal.parked, false);
		assert.equal(logs.length, 1);
		const steps = logs[0].steps as Array<{ name: string; subtype?: string }>;
		const implEntry = steps.find((s) => s.name === "implement");
		assert.equal(implEntry?.subtype, "blocked", `expected implement entry subtype "blocked"; got ${JSON.stringify(implEntry)}`);
	});

	it("shakedown-plan blocked → terminates before implement, reason in error", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: false, subtype: "blocked", text: "rubric file is missing" },
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "shakedown-plan blocked: rubric file is missing");
		assert.deepEqual(
			calls.map((c) => c.step),
			["plan", "shakedown-plan"],
		);
		assert.equal(parkSignal.parked, false);
	});
});

describe("runPipeline — no deliverable commits", () => {
	it("aborts before ship when branch has only docs commits", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "docs/plans/tool-99.md": "docs only" } },
				"shakedown-code": { ok: true },
				ship: { ok: true },
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.completed, false);
		assert.match(result.error ?? "", /nothing to ship/);
		const stepsRun = calls.map((c) => c.step);
		assert.ok(!stepsRun.includes("ship"), `ship should not have been called; got ${stepsRun.join(",")}`);
		assert.equal(logs.length, 1);
		assert.equal(logs[0].completed, false);
		assert.match((logs[0].error as string) ?? "", /nothing to ship/);
	});
});

describe("runPipeline — ghost-ship detection", () => {
	it("detects ship ok:true but main did not advance, triggers shipwreck, returns completed:false", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				// ship claims success but does NOT advance main
				ship: { ok: true },
				shipwreck: { ok: false },
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.completed, false);
		assert.match(result.error ?? "", /ship claimed success but main did not advance/);
		// The finish() spread surfaces the local shipwreck flag on the returned CycleResult so
		// the orchestrator can classify a `shipwrecked` notification.
		assert.equal(result.shipwrecked, true);
		const stepsRun = calls.map((c) => c.step);
		assert.ok(stepsRun.includes("shipwreck"), `expected shipwreck to run; got ${stepsRun.join(",")}`);
		assert.equal(logs.length, 1);
		assert.equal(logs[0].completed, false);
		assert.equal(logs[0].shipwrecked, true);
	});
});

describe("runPipeline — pre-ship state capture failure", () => {
	it("fails closed when captureShipState returns null: no blind completion, no bookkeeping tail", async () => {
		const worktree = makeTempGitRepo();
		const nonGitMainRepo = makeNonGitDir();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				// Even if ship were invoked and reported success, a failed pre-ship
				// capture must never reach this outcome blindly.
				ship: { ok: true },
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			mainRepo: nonGitMainRepo,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.completed, false);
		assert.match(result.error ?? "", /cannot capture pre-ship git state/);
		const stepsRun = calls.map((c) => c.step);
		assert.ok(!stepsRun.includes("ship"), `ship should not have been invoked; got ${stepsRun.join(",")}`);
		assert.equal(logs.length, 1);
		assert.equal(logs[0].completed, false);
	});
});

describe("runPipeline — RoadmapSource injection", () => {
	it("calls the injected roadmap.getItemPlan({ worktree }) and flows its result into implement prompt", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const getItemPlanCalls: Array<{ worktree?: string; id?: string }> = [];
		const roadmap = makeMockRoadmap({
			async getItemPlan(ref) {
				getItemPlanCalls.push(ref);
				return "/fake/plans/tool-99.md";
			},
		});
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: {
					ok: true,
					sideEffect: (cwd) => {
						execSync("git checkout -q main", { cwd });
						execSync("git merge -q --no-ff feat/tool-99", { cwd });
						execSync("git checkout -q feat/tool-99", { cwd });
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			roadmap,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: noopBookkeeping,
		});

		assert.equal(result.completed, true);
		assert.ok(getItemPlanCalls.length >= 1, "expected roadmap.getItemPlan to be called at least once");
		assert.ok(
			getItemPlanCalls.every((c) => c.worktree === worktree),
			`expected every getItemPlan call with { worktree }; got ${JSON.stringify(getItemPlanCalls)}`,
		);

		const implementPrompt = calls.find((c) => c.step === "implement")?.prompt ?? "";
		assert.ok(implementPrompt.includes("/fake/plans/tool-99.md"), `expected implement prompt to include mock plan path; got: ${implementPrompt.slice(0, 400)}`);
	});
});

describe("runPipeline — rate-limit park preserves state", () => {
	it("parks on shakedown-plan, checkpoints dirty work, stops before implement", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": {
					ok: false,
					subtype: "error_rate_limit",
					writes: { "wip.txt": "partial work" },
					park: { parked: true, limitType: "5h", resetsAt: Date.now() + 3_600_000 },
				},
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "parked");
		const stepsRun = calls.map((c) => c.step);
		assert.ok(!stepsRun.includes("implement"));
		assert.ok(!stepsRun.includes("shakedown-code"));
		assert.ok(!stepsRun.includes("ship"));

		const msgs = allCommitMessages(worktree);
		assert.ok(
			msgs.some((m) => m === "wip: autopilot rate-limit park"),
			`expected rate-limit park commit; got:\n${msgs.join("\n")}`,
		);

		assert.equal(logs[0].parked, true);
		assert.equal(logs[0].parkReason, "5h");
	});
});

describe("runPipeline — pick step", () => {
	function pickOpts(): PipelineOpts {
		return {
			cycle: 1,
			verbose: false,
			shipTarget: getShipTarget("direct-push"),
			dryRun: false,
			liveStatus: makeLiveStatus(),
		};
	}

	it("pick success — runs all six steps and lands the worktree under the injected parent", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const worktreePath = join(parent, `${WORKTREE_PREFIX}tool-99`);
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				pick: {
					ok: true,
					text: "claimed TOOL-99\npick-item: TOOL-99\npick-result: claimed",
					sideEffect: (cwd) => {
						// cwd is the injected mainRepo — using it here implicitly proves injection end-to-end.
						execSync(`git worktree add -q -b feat/tool-99 "${worktreePath}"`, { cwd });
					},
				},
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: {
					ok: true,
					sideEffect: () => {
						execSync("git merge -q --no-ff feat/tool-99", { cwd: repo });
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			resolveWorktree: (id) => join(parent, `${WORKTREE_PREFIX}${id.toLowerCase()}`),
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
			runShipBookkeeping: noopBookkeeping,
		});

		assert.equal(result.completed, true);
		assert.equal(result.itemId, "TOOL-99");
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick", "plan", "shakedown-plan", "implement", "shakedown-code", "ship"],
		);
		assert.ok(existsSync(worktreePath), `expected worktree at ${worktreePath}`);
		assert.equal(logs.length, 1);
		assert.equal(logs[0].completed, true);
		const msgs = allCommitMessages(worktreePath);
		assert.ok(
			msgs.some((m) => m === "wip: autopilot implementation checkpoint"),
			`expected implementation checkpoint commit; got:\n${msgs.join("\n")}`,
		);
	});

	it("pick failed — returns 'pick failed' with null itemId, no subsequent steps", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep({ pick: { ok: false, subtype: "error_max_turns" } }, parkSignal);

		const result = await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			resolveWorktree: (id) => join(parent, `${WORKTREE_PREFIX}${id.toLowerCase()}`),
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "pick failed");
		assert.equal(result.itemId, null);
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick"],
		);
		assert.equal(logs[0].completed, false);
	});

	it("queue empty — maps pick-result: queue-empty to error 'pick:queue-empty' (recoverable)", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep({ pick: { ok: true, text: "no unblocked items available\npick-result: queue-empty" } }, parkSignal);

		const result = await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			resolveWorktree: (id) => join(parent, `${WORKTREE_PREFIX}${id.toLowerCase()}`),
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "pick:queue-empty");
		assert.equal(result.itemId, null);
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick"],
		);
	});

	it("no item ID parsed — aborts when roadmap.parseItemId returns null for pick output", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const roadmap = makeMockRoadmap({ parseItemId: () => null });
		const { runStep, calls } = createMockRunStep({ pick: { ok: true, text: "claimed something\npick-result: claimed" } }, parkSignal);

		const result = await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			roadmap,
			mainRepo: repo,
			resolveWorktree: (id) => join(parent, `${WORKTREE_PREFIX}${id.toLowerCase()}`),
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "no item ID parsed");
		assert.equal(result.itemId, null);
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick"],
		);
	});

	it("worktree missing — pick succeeds, id parses, but worktree dir not created and listWorktrees empty", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep({ pick: { ok: true, text: "claimed TOOL-99\npick-item: TOOL-99\npick-result: claimed" } }, parkSignal);

		const result = await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			resolveWorktree: (id) => join(parent, `${WORKTREE_PREFIX}${id.toLowerCase()}`),
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.completed, false);
		assert.match(result.error ?? "", /TOOL-99/);
		assert.match(result.error ?? "", new RegExp(`${WORKTREE_PREFIX}tool-99`));
		assert.match(result.error ?? "", /git worktree list \(/);
		assert.equal(result.itemId, "TOOL-99");
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick"],
		);
	});

	it("honors pick-item marker over free-text parseItemId", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		// Mock roadmap.parseItemId returns "TOOL-9" from free text — the marker names "COMP-11C-II".
		const roadmap = makeMockRoadmap({
			async parseItemId() {
				return "TOOL-9";
			},
		});
		const worktreePath = join(parent, `${WORKTREE_PREFIX}comp-11c-ii`);
		const { runStep, calls } = createMockRunStep(
			{
				pick: {
					ok: true,
					text: "found TOOL-9 blocker, claimed COMP-11C-II successfully\npick-item: COMP-11C-II\npick-result: claimed",
					sideEffect: (cwd) => {
						execSync(`git worktree add -q -b feat/comp-11c-ii "${worktreePath}"`, { cwd });
					},
				},
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: {
					ok: true,
					sideEffect: () => {
						execSync("git merge -q --no-ff feat/comp-11c-ii", { cwd: repo });
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			roadmap,
			mainRepo: repo,
			resolveWorktree: (id) => join(parent, `${WORKTREE_PREFIX}${id.toLowerCase()}`),
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
			runShipBookkeeping: noopBookkeeping,
		});

		assert.equal(result.itemId, "COMP-11C-II");
		assert.equal(result.completed, true);
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick", "plan", "shakedown-plan", "implement", "shakedown-code", "ship"],
		);
	});

	it("worktree cross-reference adopts a nested sub-item worktree when _resolveWorktree misses", async (t) => {
		const { parent, repo } = makeTempRepoWithParent();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const nestedPath = join(parent, `${WORKTREE_PREFIX}comp-11c-ii-fixes`);
		const resolvedPath = join(parent, "nonexistent-comp-11c-ii");

		// Pre-create the nested worktree on a fresh branch so listWorktrees has something to adopt.
		execSync(`git worktree add -q -b feat/comp-11c-ii-fixes "${nestedPath}"`, { cwd: repo });

		const consoleLog = t.mock.method(console, "log", () => {});

		let listCalls = 0;
		const { runStep, calls } = createMockRunStep(
			{
				pick: { ok: true, text: "claimed COMP-11C-II\npick-item: COMP-11C-II\npick-result: claimed" },
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: {
					ok: true,
					sideEffect: () => {
						execSync("git merge -q --no-ff feat/comp-11c-ii-fixes", { cwd: repo });
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			resolveWorktree: () => resolvedPath,
			listWorktrees: () => {
				listCalls++;
				// First call captures worktreesBefore (nested already exists, so pretend it was there before);
				// cross-reference on miss should find nested path among listWorktrees() entries.
				return [repo, nestedPath];
			},
			appendLog: (e) => {
				logs.push(e);
			},
			runShipBookkeeping: noopBookkeeping,
		});

		assert.ok(listCalls >= 1);
		assert.equal(result.itemId, "COMP-11C-II");
		assert.equal(result.completed, true, `expected cross-ref adoption; got error=${result.error}`);
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick", "plan", "shakedown-plan", "implement", "shakedown-code", "ship"],
		);
		const adoptionLog = consoleLog.mock.calls.map((c) => String(c.arguments[0])).find((s) => /expected .* using .* for in-flight COMP-11C-II-FIXES/.test(s));
		assert.ok(adoptionLog, `expected adoption log naming COMP-11C-II-FIXES; got: ${consoleLog.mock.calls.map((c) => c.arguments[0]).join(" | ")}`);
	});

	it("worktree cross-reference aborts with 'ambiguous' when multiple nested siblings match", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const aPath = join(parent, `${WORKTREE_PREFIX}comp-11-a`);
		const bPath = join(parent, `${WORKTREE_PREFIX}comp-11-b`);

		const { runStep } = createMockRunStep({ pick: { ok: true, text: "claimed COMP-11\npick-item: COMP-11\npick-result: claimed" } }, parkSignal);

		const result = await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			resolveWorktree: () => join(parent, "nonexistent-comp-11"),
			listWorktrees: () => [repo, aPath, bPath],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.itemId, "COMP-11");
		assert.equal(result.completed, false);
		assert.match(result.error ?? "", /worktree ambiguous/);
	});

	it("worktree-prefix fallback — redirects to a new listWorktrees entry containing WORKTREE_PREFIX", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const resolvedPath = join(parent, "nonexistent-tool-99");
		const fallbackPath = join(parent, `${WORKTREE_PREFIX}renamed`);
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		let listCalls = 0;
		const { runStep, calls } = createMockRunStep(
			{
				pick: {
					ok: true,
					text: "claimed TOOL-99\npick-item: TOOL-99\npick-result: claimed",
					sideEffect: (cwd) => {
						// Creates a real worktree at a DIFFERENT path — the one resolveWorktree returns is never created.
						execSync(`git worktree add -q -b feat/tool-99 "${fallbackPath}"`, { cwd });
					},
				},
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: {
					ok: true,
					sideEffect: () => {
						execSync("git merge -q --no-ff feat/tool-99", { cwd: repo });
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			resolveWorktree: () => resolvedPath,
			listWorktrees: () => {
				listCalls++;
				// First call captures worktreesBefore (empty); second call surfaces the newly added path.
				return listCalls === 1 ? [] : [repo, fallbackPath];
			},
			appendLog: (e) => {
				logs.push(e);
			},
			runShipBookkeeping: noopBookkeeping,
		});

		assert.equal(result.completed, true, `expected prefix fallback to let pipeline complete; got error=${result.error}`);
		assert.equal(result.itemId, "TOOL-99");
		assert.ok(!existsSync(resolvedPath), "resolved path should never have been created");
		assert.ok(existsSync(fallbackPath), "fallback path should have been created by sideEffect");
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick", "plan", "shakedown-plan", "implement", "shakedown-code", "ship"],
		);
	});
});

describe("runPipeline — SIGINT cancellation", () => {
	it("step receiving an aborted signal returns error_abort and the cycle surfaces error: 'aborted'", async () => {
		const controller = new AbortController();
		const parkSignal = makeParkSignal();
		const worktree = makeTempGitRepo();

		const { runStep, calls } = createMockRunStep(
			{
				plan: { awaitAbort: true, ok: false, subtype: "error_abort", text: "aborted" },
			},
			parkSignal,
		);

		const abortAt = setTimeout(() => controller.abort(), 20);

		const t0 = Date.now();
		const result = await runPipeline({ ...baseOpts(worktree), signal: controller.signal }, parkSignal, baseFlags, { runStep, mainRepo: worktree, listWorktrees: () => [], appendLog: () => {}, roadmap: makeMockRoadmap() });
		const elapsed = Date.now() - t0;
		clearTimeout(abortAt);

		assert.equal(result.completed, false);
		assert.equal(result.error, "aborted");
		assert.ok(elapsed < 2000, `expected abort to return well under the 2s grace window; got ${elapsed}ms`);
		assert.equal(calls[0].step, "plan");
	});
});

describe("runOrchestrator — SIGUSR2 pause handler", () => {
	it("SIGUSR2 mid-cycle parks parkSignal and stops the worker before subsequent items", async () => {
		const seenAfter: ParkSignal[] = [];
		const { runPipeline: mockRun, calls } = createMockRunPipeline({
			byItem: {
				"A-1": { completed: true, cost: 0.1 },
				"A-2": { completed: true, cost: 0.1 },
			},
		});

		// Wrapper: send SIGUSR2 inside the cycle, then await one event-loop turn
		// so the signal handler runs before the worker re-checks parkSignal.
		const wrappedRun: typeof mockRun = async (opts, parkSignal, flags) => {
			const result = await mockRun(opts, parkSignal, flags);
			if (opts.itemId === "A-1") {
				process.kill(process.pid, "SIGUSR2");
				// Yield until the signal handler fires.
				for (let i = 0; i < 5 && !parkSignal.parked; i++) await new Promise(setImmediate);
			}
			seenAfter.push({ ...parkSignal });
			return result;
		};

		const flags: Flags = { ...baseFlags, item: "A-1,A-2" };
		const { results } = await runOrchestrator(flags, { runPipeline: wrappedRun });

		assert.equal(calls.length, 1, `expected only A-1 to run; got ${calls.length} calls`);
		assert.equal(calls[0].opts.itemId, "A-1");
		assert.equal(results.length, 1);
		// Handler must set the three fields the rate-limit handler sets.
		const snap = seenAfter[0];
		assert.equal(snap.parked, true);
		assert.equal(snap.limitType, "paused");
		assert.equal(snap.resetsAt, 0);
	});

	it("removes its SIGUSR2 listener on return so repeated invocations do not leak", async () => {
		const before = process.listenerCount("SIGUSR2");
		const { runPipeline } = createMockRunPipeline({ default: { completed: true, cost: 0 } });
		await runOrchestrator({ ...baseFlags, item: "A-1" }, { runPipeline });
		await runOrchestrator({ ...baseFlags, item: "A-1" }, { runPipeline });
		const after = process.listenerCount("SIGUSR2");
		assert.equal(after, before, `SIGUSR2 listener leak: before=${before} after=${after}`);
	});
});
