import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { describe, it } from "node:test";
import { runPipeline } from "../pipeline.js";
import { getShipTarget } from "../ship/index.js";
import type { Flags, PipelineOpts } from "../types.js";
import { allCommitMessages, createMockRunStep, makeLiveStatus, makeParkSignal, makeTempGitRepo } from "./mocks.js";

const baseFlags: Flags = {
	cycles: "1",
	parallel: "1",
	verbose: false,
	trace: false,
	budget: "10",
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

		const steps = logs[0].steps as Array<{ name: string; attempt?: number }>;
		const implEntries = steps.filter((s) => s.name === "implement");
		assert.ok(
			implEntries.some((s) => s.attempt === 2),
			`expected implement entry with attempt=2; got ${JSON.stringify(implEntries)}`,
		);
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
		const stepsRun = calls.map((c) => c.step);
		assert.ok(stepsRun.includes("shipwreck"), `expected shipwreck to run; got ${stepsRun.join(",")}`);
		assert.equal(logs.length, 1);
		assert.equal(logs[0].completed, false);
		assert.equal(logs[0].shipwrecked, true);
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
