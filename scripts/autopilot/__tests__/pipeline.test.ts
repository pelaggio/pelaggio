import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WORKTREE_PREFIX } from "../config.js";
import { runPipeline } from "../pipeline.js";
import { getShipTarget } from "../ship/index.js";
import type { Flags, PipelineOpts } from "../types.js";
import { allCommitMessages, createMockRunStep, makeLiveStatus, makeMockRoadmap, makeParkSignal, makeTempGitRepo, makeTempRepoWithParent } from "./mocks.js";

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

		const continuePrompt = implementCalls[1]?.prompt ?? "";
		assert.ok(continuePrompt.includes("project-relative") && continuePrompt.includes("use that absolute form"), `expected continuePrompt to carry worktree hint; got: ${continuePrompt.slice(0, 400)}`);
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
					text: "claimed TOOL-99",
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

	it("nothing to pick — aborts when pick text has no claim/worktree/successfully match", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep({ pick: { ok: true, text: "no items available" } }, parkSignal);

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
		assert.equal(result.error, "nothing to pick");
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
		const { runStep, calls } = createMockRunStep({ pick: { ok: true, text: "claimed something" } }, parkSignal);

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
		const { runStep, calls } = createMockRunStep({ pick: { ok: true, text: "claimed TOOL-99" } }, parkSignal);

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
		assert.equal(result.error, "worktree missing");
		assert.equal(result.itemId, "TOOL-99");
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick"],
		);
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
					text: "claimed TOOL-99",
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
