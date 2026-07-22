import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { WORKTREE_PREFIX } from "../config.js";
import { EffectsManifestError } from "../effects.js";
import { FifoPolicy } from "../flow-policy.js";
import { type RunStepFn, runOrchestrator, runPipeline } from "../pipeline.js";
import { shipBodyFile } from "../ship/decision.js";
import type { ShipBookkeepingResult } from "../ship/index.js";
import { getShipTarget } from "../ship/index.js";
import type { Flags, ParkSignal, PipelineOpts } from "../types.js";
import {
	allCommitMessages,
	createMockRunPipeline,
	createMockRunStep,
	makeGitDirWithoutMain,
	makeLiveStatus,
	makeMockRoadmap,
	makeParkSignal,
	makeTempGitRepo,
	makeTempRepoWithParent,
	setupHermeticPipelineEnv,
	teardownHermeticPipelineEnv,
} from "./mocks.js";

/** PR-mode ship fixture using the fixed body-file transport (inline prBody removed in #303). */
function prShipDecision(body = "Body"): { ok: true; writes: Record<string, string>; text: string } {
	const file = shipBodyFile("TOOL-99");
	return {
		ok: true,
		writes: { [file]: body },
		text: `SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Ship","prBodyFile":"${file}"}\nEND_SHIP_DECISION`,
	};
}

// Mute console output (the pipeline's high-volume log() floods node:test IPC on CI),
// stub provider availability, and pin the authoring loop off so these flow tests stay
// hermetic against the runner's binaries and the repo's `.pelaggio.yml` (#304). See
// setupHermeticPipelineEnv in mocks.ts. The one test that asserts on log content
// re-mocks console.log locally, which still captures its own calls.
before(setupHermeticPipelineEnv);
after(teardownHermeticPipelineEnv);

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
	warnings: [],
	ok: true,
});

describe("runPipeline — pick divergence gate (#332)", () => {
	it("fails closed with pick:diverted when /pick claims a different item than the --item pin, before any plan/implement", async () => {
		const mainRepo = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				// Pinned --item 286, but /pick's authoritative marker claims 337 (the live divert),
				// with free text narrating the requested 286 — the exact ambiguity the marker resolves.
				pick: { ok: true, text: "Requested issue 286.\nClaiming the next ready item.\npick-item: 337\npick-result: claimed" },
				plan: { ok: true },
				implement: { ok: true, writes: { "impl.txt": "x" } },
			},
			parkSignal,
		);
		const result = await runPipeline({ itemId: "286", cycle: 1, verbose: false, shipTarget: getShipTarget("pull-request"), dryRun: false, liveStatus: makeLiveStatus() }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees: () => [mainRepo],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});
		assert.equal(result.completed, false);
		assert.equal(result.error, "pick:diverted");
		assert.equal(calls.filter((c) => c.step === "plan").length, 0, "must not plan the diverted item");
		assert.equal(calls.filter((c) => c.step === "implement").length, 0, "must not implement the diverted item");
	});

	it("fails closed (pick:unparsed-marker) when a pinned pick claims but emits no authoritative marker — free text can't mask a divert", async () => {
		// The pick reports `claimed` and narrates the requested id, but emits NO valid `pick-item:`
		// marker. A pinned pick must resolve from the marker only — falling back to free-text
		// parseItemId here is exactly how a divert could hide behind "Requested issue 286".
		const mainRepo = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep({ pick: { ok: true, text: "Requested issue 286.\nClaimed a ready item.\npick-result: claimed" }, plan: { ok: true } }, parkSignal);
		const result = await runPipeline({ itemId: "286", cycle: 1, verbose: false, shipTarget: getShipTarget("pull-request"), dryRun: false, liveStatus: makeLiveStatus() }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees: () => [mainRepo],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});
		assert.equal(result.completed, false);
		assert.equal(result.error, "pick:unparsed-marker");
		assert.equal(calls.filter((c) => c.step === "plan").length, 0, "must not proceed without an authoritative marker");
	});

	it("does NOT fire the gate when the pick claims exactly the pinned item (no false divergence)", async () => {
		// The pick marker matches the pin, so the gate must not short-circuit with pick:diverted.
		// (We assert only that the gate did not fire — the downstream claim/worktree creation is a
		// real /pick side effect out of scope for this unit; covered by the happy-path tests.)
		const mainRepo = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep({ pick: { ok: true, text: "pick-item: 286\npick-result: claimed" }, plan: { ok: true } }, parkSignal);
		const result = await runPipeline({ itemId: "286", cycle: 1, verbose: false, shipTarget: getShipTarget("pull-request"), dryRun: false, liveStatus: makeLiveStatus() }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees: () => [mainRepo],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});
		assert.notEqual(result.error, "pick:diverted", "a matching pin must not trip the divergence gate");
	});
});

describe("runPipeline — plan-time decomposition (#294 follow-up)", () => {
	it("creates deferred-items the plan emits, before implement", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const created: Array<{ title: string; deps: string }> = [];
		const { runStep } = createMockRunStep(
			{
				plan: {
					ok: true,
					text: 'Scoped to slice A.\ndeferred-item: {"title": "slice B: second capability", "scope": "M", "deps": ["TOOL-99"]}\ndeferred-item: {"title": "slice C: cleanup"}',
				},
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
		const roadmap = makeMockRoadmap({
			async createItem(o) {
				created.push({ title: o.title, deps: (o.deps ?? []).join(", ") });
				return { id: `MOCK-${created.length}`, title: o.title, deps: (o.deps ?? []).join(", "), sourceRef: "mock" };
			},
		});
		await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: () => {},
			roadmap,
			runShipBookkeeping: noopBookkeeping,
		});
		assert.deepEqual(
			created.map((c) => c.title),
			["slice B: second capability", "slice C: cleanup"],
			"plan-emitted deferred slices become follow-up items",
		);
		// The parent-dep (JSON array form) must survive to the created item — decomposition's whole point
		// is that follow-up slices are blocked on the parent, not immediately pickable. (#353 review)
		assert.equal(created[0].deps, "TOOL-99", "deps array is preserved (not silently dropped)");
	});
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
			msgs.some((m) => m === "wip: pelaggio implementation checkpoint"),
			`expected implementation checkpoint commit; got:\n${msgs.join("\n")}`,
		);
		assert.ok(
			msgs.some((m) => m === "wip: pelaggio implementation continued"),
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

describe("runPipeline — transient SDK retry", () => {
	it("retries a transient SDK error and completes after success", async (t) => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const consoleLog = t.mock.method(console, "log", () => {});
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": [
					{ ok: false, subtype: "error_sdk", text: "Anthropic API error: 500 Internal server error" },
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
			sleep: async () => {},
		});

		assert.equal(result.completed, true);
		assert.equal(result.verdict, "APPROVE");
		assert.equal(calls.filter((c) => c.step === "shakedown-plan").length, 2);
		assert.equal(
			consoleLog.mock.calls.some((c) => String(c.arguments[0]).includes("transient SDK error in shakedown-plan")),
			true,
		);
	});

	it("returns a recoverable cycle error after transient SDK retries are exhausted", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": [
					{ ok: false, subtype: "error_sdk", text: "service unavailable 503" },
					{ ok: false, subtype: "error_sdk", text: "service unavailable 503" },
					{ ok: false, subtype: "error_sdk", text: "service unavailable 503" },
				],
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: () => {},
			sleep: async () => {},
		});

		assert.equal(calls.filter((c) => c.step === "shakedown-plan").length, 3);
		assert.equal(result.completed, false);
		assert.equal(result.error, "transient sdk error");
		assert.equal(parkSignal.parked, false);
	});

	it("does not retry fatal SDK errors", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: false, subtype: "error_sdk", text: "401 invalid api key" },
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: () => {},
			sleep: async () => {},
		});

		assert.equal(calls.filter((c) => c.step === "shakedown-plan").length, 1);
		assert.equal(result.completed, false);
		assert.equal(result.error, "shakedown-plan failed");
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
			allowDirtyMain: false,
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

	it("fails on attributed main-checkout edits when explicitly configured", async () => {
		const { mainRepo, worktree, listWorktrees } = makeConfinementRepos();
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep(
			{
				implement: { ok: true, writes: { "impl.txt": "x" }, attributedSideEffect: () => writeFileSync(join(mainRepo, "escaped.txt"), "x") },
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees,
			allowDirtyMain: true,
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
			dispatchStepEffects: async () => ({ appendText: "https://github.com/cdhorne/pelaggio/pull/99" }),
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "implement failed: confinement violation");
	});

	it("tolerates unchanged operator dirtiness outside mutating-tool windows", async () => {
		const { mainRepo, worktree, listWorktrees } = makeConfinementRepos();
		writeFileSync(join(mainRepo, "operator.txt"), "existing");
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep({ implement: { ok: false, subtype: "error_refusal", sideEffect: () => writeFileSync(join(mainRepo, "operator.txt"), "existing") } }, parkSignal);
		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees,
			allowDirtyMain: true,
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});
		assert.equal(result.error, "implement refused (model declined the task)");
	});

	it("still fails on sibling writes when main auditing is disabled", async () => {
		const { parent, mainRepo, worktree } = makeConfinementRepos();
		const sibling = join(parent, `${WORKTREE_PREFIX}sibling-opt-out`);
		execSync(`git worktree add -q -b feat/sibling-opt-out "${sibling}"`, { cwd: mainRepo });
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep({ implement: { ok: true, sideEffect: () => writeFileSync(join(sibling, "foreign.txt"), "x") } }, parkSignal);
		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees: () => [mainRepo, worktree, sibling],
			allowDirtyMain: true,
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});
		assert.equal(result.error, "implement failed: confinement violation");
	});

	it("fails closed when sibling worktrees cannot be enumerated under the opt-out", async () => {
		const { mainRepo, worktree } = makeConfinementRepos();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep({ implement: { ok: true } }, parkSignal);
		const logs: Array<Record<string, unknown>> = [];
		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees: () => {
				throw new Error("inventory unavailable");
			},
			allowDirtyMain: true,
			appendLog: (entry) => logs.push(entry),
			roadmap: makeMockRoadmap(),
		});
		assert.deepEqual(
			calls.map((call) => call.step),
			["implement"],
		);
		assert.equal(result.error, "implement failed: confinement violation");
		const steps = logs[0].steps as Array<{ subtype?: string; text?: string }>;
		assert.equal(steps.at(-1)?.subtype, "error_confinement");
	});

	it("warns once per pipeline run with the refined dirty-main posture", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const messages: string[] = [];
		mock.method(console, "log", (message: string) => messages.push(message));
		try {
			await runPipeline({ ...baseOpts(worktree), dryRun: true }, parkSignal, { ...baseFlags, "dry-run": true }, { mainRepo: worktree, listWorktrees: () => [], allowDirtyMain: true, roadmap: makeMockRoadmap() });
		} finally {
			mock.restoreAll();
			mock.method(console, "log", () => {});
			mock.method(console, "error", () => {});
		}
		const warnings = messages.filter((message) => message.includes("allow-dirty-main"));
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /mutating-tool deltas/);
		assert.match(warnings[0], /simultaneous/);
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
					attributedSideEffect: () => {
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
			allowDirtyMain: true,
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
				ship: prShipDecision(),
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
			dispatchStepEffects: async () => ({ appendText: "https://github.com/cdhorne/pelaggio/pull/99" }),
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
				ship: prShipDecision(),
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
			dispatchStepEffects: async () => ({ appendText: "https://github.com/cdhorne/pelaggio/pull/99" }),
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

	it("overlapping audited steps writing only their own worktree do not false-positive, and genuinely run in parallel", async () => {
		// Two sibling worktrees sharing one active-worktree registry; each pipeline writes
		// only in its own cwd. Their runStep windows are forced to overlap. The registry
		// exempts each peer's active worktree from the other's snapshot, so neither
		// false-positives — and nothing serializes them (maxActive reaches 2).
		const { parent, repo } = makeTempRepoWithParent();
		const wtA = join(parent, `${WORKTREE_PREFIX}tool-a`);
		const wtB = join(parent, `${WORKTREE_PREFIX}tool-b`);
		execSync(`git worktree add -q -b feat/tool-a "${wtA}"`, { cwd: repo });
		execSync(`git worktree add -q -b feat/tool-b "${wtB}"`, { cwd: repo });
		const listWorktrees = () => [repo, wtA, wtB];
		const activeWorktrees = new Set<string>();

		let active = 0;
		let maxActive = 0;
		let entered = 0;
		const bothEntered = Promise.withResolvers<void>();

		const runStep: RunStepFn = async (_name, _prompt, opts, emit) => {
			active++;
			maxActive = Math.max(maxActive, active);
			// Own-worktree write only — legitimate; a peer must not audit it.
			writeFileSync(join(opts.cwd, `own-${opts.itemId ?? "x"}.txt`), "ok\n");
			// Rendezvous: don't leave the audit window until BOTH steps are inside it, so the
			// windows provably overlap. Without real parallelism this would deadlock.
			if (++entered === 2) bothEntered.resolve();
			await bothEntered.promise;
			active--;
			emit({ type: "done", ok: false, subtype: "error_refusal", cost: 0.01, turns: 1, elapsed: 0 });
			return { ok: false, subtype: "error_refusal", text: "stop after implement", fullText: "stop after implement", cost: 0.01, turns: 1 };
		};

		const deps = {
			runStep,
			mainRepo: repo,
			listWorktrees,
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		};
		const pA = runPipeline({ ...baseOpts(wtA), itemId: "TOOL-A", startFrom: "implement", shipTarget: getShipTarget("pull-request"), activeWorktrees }, makeParkSignal(), baseFlags, deps);
		const pB = runPipeline({ ...baseOpts(wtB), itemId: "TOOL-B", startFrom: "implement", shipTarget: getShipTarget("pull-request"), activeWorktrees }, makeParkSignal(), baseFlags, deps);

		const [rA, rB] = await Promise.all([pA, pB]);
		assert.equal(maxActive, 2, "audited provider windows must overlap — no serialization");
		assert.notEqual(rA.error, "implement failed: confinement violation");
		assert.notEqual(rB.error, "implement failed: confinement violation");
		// Both should surface the intentional refusal, not a race false-positive.
		assert.match(rA.error ?? "", /refused/);
		assert.match(rB.error ?? "", /refused/);
		// Registry drains on finish.
		assert.equal(activeWorktrees.size, 0, "worktrees deregister on finish");
	});

	it("a write to mainRepo during a step still fails closed even under an active registry", async () => {
		// main is never a registry member, so it stays hard-gated by the snapshot.
		const { mainRepo, worktree } = makeConfinementRepos();
		const activeWorktrees = new Set<string>();
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep(
			{
				implement: {
					ok: true,
					sideEffect: () => {
						writeFileSync(join(mainRepo, "leaked-into-main.txt"), "x");
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request"), activeWorktrees }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees: () => [mainRepo, worktree],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "implement failed: confinement violation");
	});

	it("a write to an INACTIVE sibling worktree (not in the registry) still fails closed", async () => {
		// A sibling that exists on disk but is NOT registered as active is still audited —
		// a stale/abandoned tree must not become silently writable.
		const { parent, mainRepo, worktree } = makeConfinementRepos();
		const inactive = join(parent, `${WORKTREE_PREFIX}inactive`);
		execSync(`git worktree add -q -b feat/inactive "${inactive}"`, { cwd: mainRepo });
		const activeWorktrees = new Set<string>(); // inactive sibling deliberately absent
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep(
			{
				implement: {
					ok: true,
					sideEffect: () => {
						writeFileSync(join(inactive, "foreign.txt"), "x");
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request"), activeWorktrees }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees: () => [mainRepo, worktree, inactive],
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
				ship: prShipDecision(),
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees,
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
			dispatchStepEffects: async () => ({ appendText: "https://github.com/cdhorne/pelaggio/pull/99" }),
		});

		assert.equal(result.completed, true);
		assert.equal(result.error, undefined);
	});

	it("reports pre-snapshot audit failure as error_confinement with phase diagnostics", async () => {
		const { mainRepo, worktree, listWorktrees } = makeConfinementRepos();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const providerTail = "VERDICT: APPROVE — review looks fine end-of-output";
		const { runStep, calls } = createMockRunStep(
			{
				implement: {
					ok: true,
					text: providerTail,
					outputTail: providerTail.slice(-40),
					writes: { "impl.txt": "x" },
				},
			},
			parkSignal,
		);
		const gitDiag = "failed to snapshot forbidden root /tmp/main: fatal: Unable to create '.git/index.lock': File exists";

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees,
			appendLog: (e) => {
				logs.push(e);
			},
			roadmap: makeMockRoadmap(),
			allowDirtyMain: false,
			snapshotForbiddenRoots: () => {
				throw new Error(gitDiag);
			},
			dispatchStepEffects: async () => {
				throw new Error("effects must not dispatch on confinement");
			},
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "implement failed: confinement violation");
		assert.deepEqual(
			calls.map((c) => c.step),
			["implement"],
			"provider still runs when pre-snapshot fails (intentional YAGNI)",
		);
		const step = (logs[0].steps as Array<{ name: string; ok: boolean; subtype?: string; outputTail?: string; errorDetail?: string }>).at(-1);
		assert.equal(step?.ok, false);
		assert.equal(step?.subtype, "error_confinement");
		assert.match(step?.errorDetail ?? "", /before implement/);
		assert.match(step?.errorDetail ?? "", /index\.lock/);
		assert.match(step?.outputTail ?? "", /before implement/);
		assert.ok(!(step?.outputTail ?? "").includes("VERDICT"), "must not retain provider success tail");
		assert.ok(!(step?.errorDetail ?? "").includes("VERDICT"));
		assert.ok(!result.detail?.includes("VERDICT"));
	});

	it("reports post-snapshot audit failure as error_confinement with after-phase diagnostics", async () => {
		const { mainRepo, worktree, listWorktrees } = makeConfinementRepos();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const providerTail = "implementation complete — all checks green at the end";
		const { runStep } = createMockRunStep(
			{
				implement: { ok: true, text: providerTail, outputTail: providerTail.slice(-40), writes: { "impl.txt": "x" } },
			},
			parkSignal,
		);
		let calls = 0;
		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees,
			appendLog: (e) => {
				logs.push(e);
			},
			roadmap: makeMockRoadmap(),
			allowDirtyMain: false,
			snapshotForbiddenRoots: (roots) => {
				calls++;
				if (calls === 1) {
					// Pre-step: healthy empty snapshots
					return new Map(roots.map((root) => [root, ""] as const));
				}
				throw new Error("failed to snapshot forbidden root /tmp/main: index.lock: File exists");
			},
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "implement failed: confinement violation");
		const step = (logs[0].steps as Array<{ subtype?: string; outputTail?: string; errorDetail?: string }>).at(-1);
		assert.equal(step?.subtype, "error_confinement");
		assert.match(step?.errorDetail ?? "", /after implement/);
		assert.match(step?.errorDetail ?? "", /index\.lock/);
		assert.match(step?.outputTail ?? "", /after implement/);
		assert.ok(!(step?.outputTail ?? "").includes("checks green"));
	});

	it("logs sorted changed roots (not audit-failed wording) with confinement diagnostics", async () => {
		const { mainRepo, worktree, listWorktrees } = makeConfinementRepos();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const providerTail = "provider success tail that must not leak into confinement diagnosis";
		const { runStep } = createMockRunStep(
			{
				implement: {
					ok: true,
					text: providerTail,
					outputTail: providerTail.slice(-50),
					sideEffect: () => {
						writeFileSync(join(mainRepo, "pwned-delta.txt"), "x");
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
			allowDirtyMain: false,
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "implement failed: confinement violation");
		const step = (logs[0].steps as Array<{ subtype?: string; outputTail?: string; errorDetail?: string }>).at(-1);
		assert.equal(step?.subtype, "error_confinement");
		assert.match(step?.errorDetail ?? "", /forbidden root changed during implement:/);
		assert.match(step?.errorDetail ?? "", new RegExp(mainRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.ok(!(step?.errorDetail ?? "").includes("confinement audit failed"));
		assert.match(step?.outputTail ?? "", /forbidden root changed/);
		assert.ok(!(step?.outputTail ?? "").includes("must not leak"));
	});

	it("fails when a pick step dirties a sibling worktree", async () => {
		const { parent, repo: mainRepo } = makeTempRepoWithParent();
		const sibling = join(parent, `${WORKTREE_PREFIX}sibling`);
		execSync(`git worktree add -q -b feat/sibling "${sibling}"`, { cwd: mainRepo });
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				pick: {
					ok: true,
					text: "claimed TOOL-99\npick-item: TOOL-99\npick-result: claimed",
					sideEffect: () => {
						writeFileSync(join(sibling, "foreign.txt"), "x");
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline({ cycle: 1, verbose: false, shipTarget: getShipTarget("direct-push"), dryRun: false, liveStatus: makeLiveStatus() }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees: () => [mainRepo, sibling],
			allowDirtyMain: true,
			appendLog: (e) => {
				logs.push(e);
			},
			roadmap: makeMockRoadmap(),
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "pick failed");
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick"],
		);
		const steps = logs[0].steps as Array<{ name: string; subtype?: string; ok: boolean }>;
		const last = steps.at(-1);
		assert.equal(last?.name, "pick");
		assert.equal(last?.ok, false);
		assert.equal(last?.subtype, "error_confinement");
	});

	it("fails when a shipwreck step dirties a sibling worktree", async () => {
		const { parent, mainRepo, worktree } = makeConfinementRepos();
		const sibling = join(parent, `${WORKTREE_PREFIX}shipwreck-sibling`);
		execSync(`git worktree add -q -b feat/shipwreck-sibling "${sibling}"`, { cwd: mainRepo });
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: { ok: false },
				shipwreck: {
					ok: true,
					sideEffect: () => {
						writeFileSync(join(sibling, "shipwreck-foreign.txt"), "x");
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("direct-push") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees: () => [mainRepo, worktree, sibling],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});

		assert.equal(result.completed, false);
		assert.deepEqual(
			calls.map((c) => c.step),
			["implement", "shakedown-code", "ship", "shipwreck"],
		);
	});

	it("does not flag shipwreck finishing a pre-existing squash/commit in the item's own worktree", async () => {
		const { mainRepo, worktree } = makeConfinementRepos();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				// Simulate the "mid-squash" state /shipwreck exists to recover (SKILL.md
				// 3c): ship's own squash left staged changes pending commit in the item's
				// own worktree before it failed. (Staging this before implement's own
				// checkpoint would sweep it up as an implement commit instead.)
				ship: {
					ok: false,
					sideEffect: () => {
						writeFileSync(join(worktree, "squash-pending.txt"), "x");
						execSync("git add squash-pending.txt", { cwd: worktree });
					},
				},
				shipwreck: {
					ok: true,
					sideEffect: () => {
						execSync('git commit -qm "finish squash"', { cwd: worktree });
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("direct-push") }, parkSignal, baseFlags, {
			runStep,
			mainRepo,
			listWorktrees: () => [mainRepo, worktree],
			appendLog: (e) => {
				logs.push(e);
			},
			roadmap: makeMockRoadmap(),
		});

		assert.deepEqual(
			calls.map((c) => c.step),
			["implement", "shakedown-code", "ship", "shipwreck"],
		);
		const steps = logs[0].steps as Array<{ name: string; subtype?: string }>;
		const wreckStep = steps.find((s) => s.name === "shipwreck");
		assert.notEqual(wreckStep?.subtype, "error_confinement", `shipwreck's own-worktree squash/commit must not trip confinement; got subtype=${wreckStep?.subtype}`);
		assert.notEqual(result.error, "shipwreck failed: confinement violation");
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

	it("fails closed when plan effect dispatch fails", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const roadmap = makeMockRoadmap({
			resolvePlanPath: () => `${worktree}/docs/plans/plan.md`,
		});
		const { runStep } = createMockRunStep(
			{
				plan: { ok: true, writes: { "docs/plans/plan.md": "# Plan\nx" } },
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			roadmap,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
			dispatchStepEffects: async () => {
				throw new EffectsManifestError("provenance_mismatch", "test mismatch");
			},
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "plan failed");
		const steps = logs[0].steps as Array<{
			name: string;
			ok: boolean;
			subtype?: string;
			outputTail?: string;
			effectsError?: { code: string; message: string };
		}>;
		assert.deepEqual(
			steps.map((s) => s.name),
			["plan"],
		);
		assert.equal(steps[0].ok, false);
		assert.equal(steps[0].subtype, "error_effects_manifest");
		assert.deepEqual(steps[0].effectsError, { code: "provenance_mismatch", message: "test mismatch" });
		assert.match(steps[0].outputTail ?? "", /provenance_mismatch/);
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
			msgs.some((m) => m === "wip: pelaggio rate-limit park"),
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
			msgs.some((m) => m === "wip: pelaggio implementation checkpoint"),
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
					sourceRef: "cdhorne/pelaggio#121",
					status: "in-progress",
					body: "Scope: M\n\nFixes a bug in quick-mode classification.",
				};
			},
			resolvePlanPath: () => planPath,
		});
		const fifoPolicy = new FifoPolicy();
		let quickScopeCalls = 0;
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
			flowPolicy: {
				evaluate: (snapshot) => fifoPolicy.evaluate(snapshot),
				isQuickScope: (input) => {
					quickScopeCalls++;
					return fifoPolicy.isQuickScope(input);
				},
			},
			mainRepo: repo,
			resolveWorktree: (id) => join(parent, `${WORKTREE_PREFIX}${id.toLowerCase()}`),
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
			runShipBookkeeping: noopBookkeeping,
		});
		assert.equal(quickScopeCalls, 1);

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

		const times = [1000, 1042];
		const git = { branch: null, worktree: null, mainShaAtStart: "a".repeat(40), headSha: null };
		const result = await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			resolveWorktree: (id) => join(parent, `${WORKTREE_PREFIX}${id.toLowerCase()}`),
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
			now: () => times.shift() ?? 1042,
			readGitBinding: () => git,
			readRuntimeVersions: () => ({ versions: { pelaggio: "0.1.0", node: "v22", drivers: { claude: "sdk 1" } }, unavailable: [] }),
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "pick failed");
		assert.equal(result.itemId, null);
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick"],
		);
		assert.equal(logs[0].completed, false);
		const provenance = logs[0].provenance as Record<string, unknown>;
		assert.equal(provenance.runId, "cycle-1");
		assert.equal(provenance.durationMs, 42);
		assert.deepEqual(provenance.git, git);
		assert.deepEqual(provenance.versions, { pelaggio: "0.1.0", node: "v22", drivers: { claude: "sdk 1" } });
		assert.equal((provenance.drivers as Array<{ provider: string }>)[0].provider, "claude");
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
		execSync(`git worktree add -q -b feat/comp-11-a "${aPath}"`, { cwd: repo });
		execSync(`git worktree add -q -b feat/comp-11-b "${bPath}"`, { cwd: repo });

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
			// fallbackPath doesn't exist until pick's sideEffect creates it (mid-step), so an
			// existence check — rather than a call-count guess — naturally reflects "before" (not
			// yet created, e.g. the pre-step confinement audit and worktreesBefore capture) vs
			// "after" (the post-pick fallback lookup) regardless of how many times the confinement
			// audit calls listWorktrees() around the step.
			listWorktrees: () => (existsSync(fallbackPath) ? [repo, fallbackPath] : []),
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

	it("worktree-prefix fallback — ignores the main repo when its path contains the prefix but its basename does not", async () => {
		// Faithful reproduction of the rename regression: WORKTREE_PREFIX sits in a PARENT path
		// component of the main repo, whose own basename ("repo") does not start with it. The old
		// `p.includes(WORKTREE_PREFIX)` substring test selected the main repo as the "new" worktree,
		// so the implement write never landed on feat/tool-99 and the phantom-ship guard fired.
		// Basename-prefix matching skips it and correctly picks the real sibling worktree.
		const base = mkdtempSync(join(tmpdir(), "wt-prefix-"));
		const parent = join(base, `${WORKTREE_PREFIX}grp`); // prefix lives in a path component, not the basename
		const repo = join(parent, "repo");
		mkdirSync(repo, { recursive: true });
		execSync("git init -q -b main", { cwd: repo });
		execSync("git config user.name t", { cwd: repo });
		execSync("git config user.email t@t", { cwd: repo });
		execSync("git config commit.gpgsign false", { cwd: repo });
		execSync("git commit --allow-empty -q -m init", { cwd: repo });
		const resolvedPath = join(parent, "nonexistent-tool-99");
		const fallbackPath = join(parent, `${WORKTREE_PREFIX}renamed`);
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				pick: {
					ok: true,
					text: "claimed TOOL-99\npick-item: TOOL-99\npick-result: claimed",
					sideEffect: (cwd) => {
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
			// Main repo listed first: its path contains the prefix, so only basename-prefix matching
			// skips it in favour of fallbackPath. Under the old substring rule the main repo wins.
			listWorktrees: () => (existsSync(fallbackPath) ? [repo, fallbackPath] : []),
			appendLog: () => {},
			runShipBookkeeping: noopBookkeeping,
		});

		assert.equal(result.completed, true, `expected main-repo path to be ignored and pipeline to complete; got error=${result.error}`);
		assert.equal(result.itemId, "TOOL-99");
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick", "plan", "shakedown-plan", "implement", "shakedown-code", "ship"],
		);
	});

	it("main checkout guard (#216) — a detached mainRepo is reattached to main before pick claims", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const sha = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf-8" }).trim();
		execSync(`git checkout -q ${sha}`, { cwd: repo }); // detach HEAD, simulating issue #216
		assert.equal(execSync("git branch --show-current", { cwd: repo, encoding: "utf-8" }).trim(), "");
		const worktreePath = join(parent, `${WORKTREE_PREFIX}tool-99`);
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				pick: {
					ok: true,
					text: "claimed TOOL-99\npick-item: TOOL-99\npick-result: claimed",
					sideEffect: (cwd) => {
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
			appendLog: () => {},
			runShipBookkeeping: noopBookkeeping,
		});

		assert.equal(execSync("git branch --show-current", { cwd: repo, encoding: "utf-8" }).trim(), "main", "guard should reattach mainRepo to main before pick runs");
		assert.equal(result.completed, true, `expected the guard to self-heal and the cycle to proceed; got error=${result.error}`);
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick", "plan", "shakedown-plan", "implement", "shakedown-code", "ship"],
		);
	});

	it("main checkout guard (#216) — aborts before claiming when mainRepo has no main branch to reattach to", async () => {
		const noMainRepo = makeGitDirWithoutMain();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep({ pick: { ok: true, text: "claimed TOOL-99\npick-item: TOOL-99\npick-result: claimed" } }, parkSignal);

		const result = await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			mainRepo: noMainRepo,
			listWorktrees: () => [],
			appendLog: () => {},
		});

		assert.equal(result.completed, false);
		assert.equal(result.error, "main checkout is not on main and could not be reattached");
		assert.equal(result.itemId, null);
		assert.deepEqual(
			calls.map((c) => c.step),
			[],
			"pick must not run against an unreattachable main checkout",
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
		const worktree = "/tmp/pelaggio-resume-review-findings";

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
		const worktree = "/tmp/pelaggio-resume-review-findings";

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
