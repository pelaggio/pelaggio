import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { WORKTREE_PREFIX } from "../config.js";
import { runOrchestrator, runPipeline } from "../pipeline.js";
import { isQuickScope } from "../roadmap/scope.js";
import type { ShipBookkeepingResult } from "../ship/index.js";
import { getShipTarget } from "../ship/index.js";
import type { Flags, ParkSignal, PipelineOpts } from "../types.js";
import { allCommitMessages, createMockRunPipeline, createMockRunStep, makeGitDirWithoutMain, makeLiveStatus, makeMockRoadmap, makeParkSignal, makeTempGitRepo, makeTempRepoWithParent } from "./mocks.js";

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

function makeConfinementRepos(): { parent: string; mainRepo: string; worktree: string; listWorktrees: () => string[] } {
	const { parent, repo } = makeTempRepoWithParent();
	const worktree = join(parent, `${WORKTREE_PREFIX}tool-99`);
	execSync(`git worktree add -q -b feat/tool-99 "${worktree}"`, { cwd: repo });
	return { parent, mainRepo: repo, worktree, listWorktrees: () => [repo, worktree] };
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
					text: "ship-merged: TOOL-99",
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

describe("runPipeline — review findings revision prompt", () => {
	it("treats review findings as the primary implement task", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const findingsPath = join(worktree, "findings.md");
		writeFileSync(findingsPath, "- blocker: fix src/failing.ts before merge\n");
		const { runStep, calls } = createMockRunStep(
			{
				implement: { ok: false, subtype: "blocked", text: "blocked: stop after prompt capture" },
			},
			parkSignal,
		);

		const result = await runPipeline(
			{ ...baseOpts(worktree), startFrom: "implement" },
			parkSignal,
			{ ...baseFlags, "review-findings": findingsPath },
			{ runStep, mainRepo: worktree, listWorktrees: () => [], appendLog: () => {}, roadmap: makeMockRoadmap() },
		);

		assert.equal(result.completed, false);
		const implementPrompt = calls.find((c) => c.step === "implement")?.prompt ?? "";
		assert.match(implementPrompt, /Revision pass/);
		assert.match(implementPrompt, /primary task/);
		assert.match(implementPrompt, /fix src\/failing\.ts/);
		assert.match(implementPrompt, /Plan context/);
		assert.match(implementPrompt, /historical context/);
		assert.match(implementPrompt, /revise the already-implemented branch/);
		assert.ok(implementPrompt.includes(worktree), `expected implement prompt to mention worktree path ${worktree}; got: ${implementPrompt.slice(0, 400)}`);
		assert.ok(implementPrompt.includes("project-relative") && implementPrompt.includes("use that absolute form"), `expected implement prompt to carry worktree path rules; got: ${implementPrompt.slice(0, 400)}`);
	});

	it("keeps revision-first framing on an implement retry", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const findingsPath = join(worktree, "findings.md");
		writeFileSync(findingsPath, "- blocker: retry must still fix review findings\n");
		const { runStep, calls } = createMockRunStep(
			{
				implement: [
					{ ok: false, subtype: "error_max_turns", writes: { "attempt-1.txt": "x" } },
					{ ok: false, subtype: "blocked", text: "blocked on retry" },
				],
			},
			parkSignal,
		);

		const result = await runPipeline(
			{ ...baseOpts(worktree), startFrom: "implement" },
			parkSignal,
			{ ...baseFlags, "review-findings": findingsPath },
			{ runStep, mainRepo: worktree, listWorktrees: () => [], appendLog: () => {}, roadmap: makeMockRoadmap() },
		);

		assert.equal(result.completed, false);
		const implementCalls = calls.filter((c) => c.step === "implement");
		assert.equal(implementCalls.length, 2);
		const continuePrompt = implementCalls[1]?.prompt ?? "";
		assert.match(continuePrompt, /Continue the revision/);
		assert.match(continuePrompt, /Revision pass/);
		assert.match(continuePrompt, /retry must still fix review findings/);
		assert.match(continuePrompt, /historical context/);
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
			mainRepo: worktree,
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
					text: "ship-merged: TOOL-99",
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
					text: "ship-merged: TOOL-99",
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
					text: "ship-merged: TOOL-99",
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
					text: "ship-merged: TOOL-99",
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
			mainRepo: worktree,
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
			mainRepo: worktree,
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
			mainRepo: worktree,
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
			mainRepo: worktree,
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
			mainRepo: worktree,
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
		const noMainRepo = makeGitDirWithoutMain();
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
			mainRepo: noMainRepo,
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

describe("runPipeline — worktree confinement audit", () => {
	it("fails when an implement step dirties the main repo through shell indirection", async () => {
		const { mainRepo, worktree, listWorktrees } = makeConfinementRepos();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				implement: {
					ok: true,
					sideEffect: () => {
						const out = join(mainRepo, "pwned.txt");
						execSync(`OUT=${JSON.stringify(out)}; printf x > "$OUT"`);
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees,
			appendLog: (e) => {
				logs.push(e);
			},
			roadmap: makeMockRoadmap(),
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "implement failed: confinement violation");
		assert.deepEqual(
			calls.map((c) => c.step),
			["implement"],
		);
		const steps = logs[0].steps as Array<{ name: string; subtype?: string; ok: boolean }>;
		const last = steps.at(-1);
		assert.equal(last?.name, "implement");
		assert.equal(last?.ok, false);
		assert.equal(last?.subtype, "error_confinement");
	});

	it("reports confinement instead of parked when a rate-limit step also dirties main", async () => {
		const { mainRepo, worktree, listWorktrees } = makeConfinementRepos();
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep(
			{
				implement: {
					ok: false,
					subtype: "error_rate_limit",
					park: { parked: true, limitType: "5h", resetsAt: Date.now() + 3_600_000 },
					sideEffect: () => {
						const out = join(mainRepo, "park-pwned.txt");
						execSync(`OUT=${JSON.stringify(out)}; printf x > "$OUT"`);
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees,
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "implement failed: confinement violation");
		assert.equal(parkSignal.parked, true);
	});

	it("allows executing a main-repo script reached through a worktree node_modules symlink", async () => {
		const { parent, repo: mainRepo } = makeTempRepoWithParent();
		const toolDir = join(mainRepo, "tools");
		mkdirSync(toolDir, { recursive: true });
		writeFileSync(join(toolDir, "shared-tool.sh"), "printf shared-tool-read\n");
		execSync("git add tools/shared-tool.sh && git commit -q -m 'add shared tool'", { cwd: mainRepo });
		const worktree = join(parent, `${WORKTREE_PREFIX}tool-99`);
		execSync(`git worktree add -q -b feat/tool-99 "${worktree}"`, { cwd: mainRepo });
		symlinkSync(toolDir, join(worktree, "node_modules"), "dir");
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep } = createMockRunStep(
			{
				implement: {
					ok: true,
					writes: { "impl.txt": "x" },
					sideEffect: (cwd) => {
						execSync("sh node_modules/shared-tool.sh", { cwd });
					},
				},
				"shakedown-code": { ok: true },
				ship: { ok: true, text: "https://github.com/cdhorne/claude-autopilot/pull/99" },
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees: () => [mainRepo, worktree],
			appendLog: (e) => {
				logs.push(e);
			},
			roadmap: makeMockRoadmap(),
		});

		assert.equal(result.completed, true);
		assert.equal(result.error, undefined);
		assert.equal(logs.length, 1);
		const status = execSync("git status --porcelain=v1 --untracked-files=all", { cwd: mainRepo, encoding: "utf-8" }).trim();
		assert.equal(status, "");
	});

	it("allows legitimate in-worktree writes while the audit is active", async () => {
		const { mainRepo, worktree, listWorktrees } = makeConfinementRepos();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				implement: { ok: true, writes: { "src/feature.ts": "export const ok = true;\n" } },
				"shakedown-code": { ok: true },
				ship: { ok: true, text: "https://github.com/cdhorne/claude-autopilot/pull/99" },
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees,
			appendLog: (e) => {
				logs.push(e);
			},
			roadmap: makeMockRoadmap(),
		});

		assert.equal(result.completed, true);
		assert.equal(result.error, undefined);
		assert.deepEqual(
			calls.map((c) => c.step),
			["implement", "shakedown-code", "ship"],
		);
		const steps = logs[0].steps as Array<{ subtype?: string }>;
		assert.ok(steps.every((s) => s.subtype !== "error_confinement"));
	});

	it("fails when an implement step dirties a sibling worktree", async () => {
		const { parent, mainRepo, worktree } = makeConfinementRepos();
		const sibling = join(parent, `${WORKTREE_PREFIX}sibling`);
		execSync(`git worktree add -q -b feat/sibling "${sibling}"`, { cwd: mainRepo });
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep(
			{
				implement: {
					ok: true,
					sideEffect: () => {
						writeFileSync(join(sibling, "foreign.txt"), "x");
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees: () => [mainRepo, worktree, sibling],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "implement failed: confinement violation");
	});

	it("does not fail on pre-existing forbidden-root dirtiness when the snapshot is unchanged", async () => {
		const { mainRepo, worktree, listWorktrees } = makeConfinementRepos();
		writeFileSync(join(mainRepo, "already-dirty.txt"), "pre-existing\n");
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep(
			{
				implement: { ok: true, writes: { "src/feature.ts": "export const ok = true;\n" } },
				"shakedown-code": { ok: true },
				ship: { ok: true, text: "https://github.com/cdhorne/claude-autopilot/pull/99" },
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees,
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});

		assert.equal(result.completed, true);
		assert.equal(result.error, undefined);
	});

	it("routes ship-step confinement terminal instead of invoking shipwreck or target interpretation", async () => {
		const { parent, mainRepo, worktree } = makeConfinementRepos();
		const sibling = join(parent, `${WORKTREE_PREFIX}ship-sibling`);
		execSync(`git worktree add -q -b feat/ship-sibling "${sibling}"`, { cwd: mainRepo });
		let interpreted = false;
		const shipTarget = {
			...getShipTarget("direct-push"),
			interpretResult() {
				interpreted = true;
				return { completed: true };
			},
		};
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: {
					ok: false,
					sideEffect: () => {
						writeFileSync(join(sibling, "ship-foreign.txt"), "x");
					},
				},
				shipwreck: { ok: true },
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees: () => [mainRepo, worktree, sibling],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
			runShipBookkeeping: noopBookkeeping,
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "ship failed: confinement violation");
		assert.equal(interpreted, false);
		assert.ok(!calls.map((c) => c.step).includes("shipwreck"));
	});
});

describe("runPipeline — RoadmapSource injection", () => {
	it("runs plan even when getItemPlan would return a stale upstream-materialized plan", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const localPlan = join(worktree, ".dev", "plans", "TOOL-99.md");
		const stalePlan = join(worktree, ".dev", "stale-plan.md");
		mkdirSync(join(worktree, ".dev"), { recursive: true });
		writeFileSync(stalePlan, "# stale\n");
		const roadmap = makeMockRoadmap({
			async getItemPlan() {
				return stalePlan;
			},
			resolvePlanPath: () => localPlan,
		});
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true, writes: { ".dev/plans/TOOL-99.md": "# fresh\n" } },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: {
					ok: true,
					text: "ship-merged: TOOL-99",
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
		assert.ok(
			calls.some((c) => c.step === "plan"),
			`expected plan step to run; got ${calls.map((c) => c.step).join(",")}`,
		);
	});

	it("skips plan when the current worktree already has the resolved local plan", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const localPlan = join(worktree, ".dev", "plans", "TOOL-99.md");
		mkdirSync(join(worktree, ".dev", "plans"), { recursive: true });
		writeFileSync(localPlan, "# existing local plan\n");
		const roadmap = makeMockRoadmap({
			async getItemPlan() {
				return null;
			},
			resolvePlanPath: () => localPlan,
		});
		const { runStep, calls } = createMockRunStep(
			{
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: {
					ok: true,
					text: "ship-merged: TOOL-99",
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
		assert.deepEqual(
			calls.map((c) => c.step),
			["shakedown-plan", "implement", "shakedown-code", "ship"],
		);
	});

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
					text: "ship-merged: TOOL-99",
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

	it("harness commits + publishes the plan after the plan step, exactly once (#98)", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const publishCalls: Array<{ body: string; id: string }> = [];
		const planFile = `${worktree}/docs/plans/plan.md`;
		let planned = false; // getItemPlan returns null until the harness publishes (mirrors reality)
		const roadmap = makeMockRoadmap({
			async getItemPlan() {
				return planned ? planFile : null;
			},
			resolvePlanPath: () => planFile,
			async publishPlan(body, ctx) {
				publishCalls.push({ body, id: ctx.id });
				planned = true;
			},
		});
		const { runStep } = createMockRunStep(
			{
				plan: { ok: true, writes: { "docs/plans/plan.md": "# Plan\nplan body" } },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: {
					ok: true,
					text: "ship-merged: TOOL-99",
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
		assert.equal(publishCalls.length, 1, "harness publishes the plan exactly once (not the model)");
		assert.ok(publishCalls[0].body.includes("# Plan"), `expected the written plan body; got ${JSON.stringify(publishCalls[0])}`);
	});

	it("does NOT publish when the plan step parks (#98 dispatch gate)", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const publishCalls: Array<{ body: string; id: string }> = [];
		const roadmap = makeMockRoadmap({
			async getItemPlan() {
				return null;
			},
			resolvePlanPath: () => `${worktree}/docs/plans/plan.md`,
			async publishPlan(body, ctx) {
				publishCalls.push({ body, id: ctx.id });
			},
		});
		const { runStep } = createMockRunStep(
			{
				plan: {
					ok: false,
					subtype: "error_rate_limit",
					writes: { "docs/plans/plan.md": "# Plan\npartial" },
					park: { parked: true, limitType: "5h", resetsAt: Date.now() + 3_600_000 },
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

		assert.equal(result.error, "parked");
		assert.equal(publishCalls.length, 0, "a parked plan step must not publish (dispatch fires only on success)");
	});

	it("injects the roadmap item body into the plan prompt (#103)", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const planFile = `${worktree}/docs/plans/plan.md`;
		let planned = false;
		const roadmap = makeMockRoadmap({
			async getItemPlan() {
				return planned ? planFile : null;
			},
			async getItem() {
				return { id: "TOOL-99", title: "Add the widget", deps: "—", sourceRef: "o/r#99", status: "open", body: "## Requirements\nthe real spec goes here" };
			},
			resolvePlanPath: () => planFile,
			async publishPlan() {
				planned = true;
			},
		});
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true, writes: { "docs/plans/plan.md": "# Plan\nx" } },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: {
					ok: true,
					text: "ship-merged: TOOL-99",
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
		const planPrompt = calls.find((c) => c.step === "plan")?.prompt ?? "";
		assert.match(planPrompt, /## Roadmap item context/);
		assert.match(planPrompt, /the real spec goes here/, "the injected issue body must reach the plan prompt");
		assert.match(planPrompt, /do NOT run `roadmap get`/);
	});

	it("harness creates deferred items from shakedown-code markers (#115)", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const created: Array<{ title: string; scope?: string; deferred?: boolean }> = [];
		const planFile = `${worktree}/docs/plans/plan.md`;
		let planned = false;
		const roadmap = makeMockRoadmap({
			async getItemPlan() {
				return planned ? planFile : null;
			},
			async getItem() {
				return { id: "TOOL-99", title: "t", deps: "—", sourceRef: "o/r#99", status: "open", body: "spec" };
			},
			resolvePlanPath: () => planFile,
			async publishPlan() {
				planned = true;
			},
			async createItem(opts) {
				created.push(opts);
				return { id: `NEW-${created.length}`, title: opts.title, deps: "", sourceRef: "mock" };
			},
		});
		const { runStep } = createMockRunStep(
			{
				plan: { ok: true, writes: { "docs/plans/plan.md": "# Plan\nx" } },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true, text: 'Review complete.\ndeferred-item: {"title": "Add retries", "scope": "S"}\ndeferred-item: {"title": "Doc the flag"}' },
				ship: {
					ok: true,
					text: "ship-merged: TOOL-99",
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
		assert.equal(created.length, 2, "harness creates both deferred items from the markers");
		assert.equal(created[0].title, "Add retries");
		assert.equal(created[0].scope, "S");
		assert.ok(
			created.every((c) => c.deferred === true),
			"deferred items are flagged deferred:true",
		);
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
			mainRepo: worktree,
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
					text: "ship-merged: TOOL-99",
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

	it("standard item scope overrides bug/fix wording in the pick summary", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const worktreePath = join(parent, `${WORKTREE_PREFIX}121`);
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const planPath = join(worktreePath, ".dev", "plans", "121.md");
		const roadmap = makeMockRoadmap({
			async parseItemId(text) {
				return text.includes("121") ? "121" : null;
			},
			async getItem(id) {
				if (id !== "121") return null;
				return {
					id: "121",
					title: "Preserve standard scope classification",
					deps: "—",
					sourceRef: "cdhorne/claude-autopilot#121",
					status: "in-progress",
					body: "Scope: M\n\nFixes a bug in quick-mode classification.",
				};
			},
			resolvePlanPath: () => planPath,
			isQuickScope,
		});
		const { runStep, calls } = createMockRunStep(
			{
				pick: {
					ok: true,
					text: "claimed issue 121\npick-item: 121\npick-result: claimed\nsummary: fixes a bug in quick-mode classification",
					sideEffect: (cwd) => {
						execSync(`git worktree add -q -b feat/issue-121 "${worktreePath}"`, { cwd });
					},
				},
				plan: { ok: true, writes: { ".dev/plans/121.md": "# Plan\n" } },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: {
					ok: true,
					text: "ship-merged: 121",
					sideEffect: () => {
						execSync("git merge -q --no-ff feat/issue-121", { cwd: repo });
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

		assert.equal(result.completed, true);
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick", "plan", "shakedown-plan", "implement", "shakedown-code", "ship"],
		);
		assert.equal(logs.length, 1);
		assert.equal(logs[0].quick, false);
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
					text: "ship-merged: COMP-11C-II",
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
					// Marker names the resolved itemId (COMP-11C-II), NOT the branch (feat/comp-11c-ii-fixes).
					text: "ship-merged: COMP-11C-II",
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
					text: "ship-merged: TOOL-99",
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

describe("runOrchestrator — resume review findings routing", () => {
	it("defaults resume with review findings to implement when --from is absent", async () => {
		const { runPipeline: mockRun, calls } = createMockRunPipeline({ default: { completed: true, cost: 0 } });
		const worktree = "/tmp/autopilot-resume-review-findings";

		const result = await runOrchestrator(
			{ ...baseFlags, resume: "108", "review-findings": "findings.md" },
			{
				runPipeline: mockRun,
				resolveWorktree: () => worktree,
				detectResumeStep: () => "ship",
			},
		);

		assert.equal(result.exitCode, 0);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.startFrom, "implement");
		assert.equal(calls[0].flags["review-findings"], "findings.md");
	});

	it("honors explicit --from even when review findings are present", async () => {
		const { runPipeline: mockRun, calls } = createMockRunPipeline({ default: { completed: true, cost: 0 } });
		const worktree = "/tmp/autopilot-resume-review-findings";

		const result = await runOrchestrator(
			{ ...baseFlags, resume: "108", from: "shakedown-code", "review-findings": "findings.md" },
			{
				runPipeline: mockRun,
				resolveWorktree: () => worktree,
				detectResumeStep: () => "ship",
			},
		);

		assert.equal(result.exitCode, 0);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.startFrom, "shakedown-code");
		assert.equal(calls[0].flags["review-findings"], "findings.md");
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
