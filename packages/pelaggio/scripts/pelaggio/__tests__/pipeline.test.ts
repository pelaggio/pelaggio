import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { REVIEW_CONFIG, WORKTREE_PREFIX } from "../config.js";
import { appendReviewEscalation, lookupReviewEscalation, type ReviewEscalationWriteInput, resolveDecision, reviewEscalationCommands, reviewEscalationId } from "../decisions.js";
import { dispatchStepEffects, EffectsManifestError, writeEffectsManifest } from "../effects.js";
import { createEventWriter, readEventLog } from "../flow-events.js";
import { FifoPolicy } from "../flow-policy.js";
import { runOrchestrator } from "../orchestrator.js";
import { archiveReviewFindingsAfterImplement, defaultTypecheckRatchet, type RunStepFn, runPipeline } from "../pipeline.js";
import type { PrReviewGateResult, RunPrReviewGateOptions } from "../pr-review-gate.js";
import { OPERATOR_ATTESTED_TTY_SUPPRESSION } from "../provider-routing.js";
import { type ReviewRecord, validateReviewRecord } from "../review/record.js";
import { verifyOrRepairAuthoringReviewHostDependencies } from "../review/seat-deps.js";
import { appliedReviewFindingsArchivePath, reviewFindingsDigest } from "../review-findings-archive.js";
import { shipBodyFile } from "../ship/decision.js";
import type { ShipBookkeepingResult } from "../ship/index.js";
import { getShipTarget } from "../ship/index.js";
import type { CycleResult, Flags, ParkSignal, PipelineOpts, ReviewEscalation } from "../types.js";
import {
	allCommitMessages,
	createMockRunPipeline,
	createMockRunStep,
	defaultPrPreflightStubs,
	makeGitDirWithoutMain,
	makeLiveStatus,
	makeMockRoadmap,
	makeParkSignal,
	makeTempGitRepo,
	makeTempRepoWithParent,
	setupHermeticPipelineEnv,
	teardownHermeticPipelineEnv,
} from "./mocks.js";

function failedError(r: CycleResult): string | undefined {
	return r.outcome === "failed" ? r.error : undefined;
}

function failedClass(r: CycleResult): string | undefined {
	return r.outcome === "failed" ? r.failureClass : undefined;
}

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
	"no-worktree": false,
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

describe("archiveReviewFindingsAfterImplement", () => {
	it("moves the canonical findings file to the applied-findings archive", () => {
		const repo = mkdtempSync(join(tmpdir(), "pelaggio-findings-test-"));
		const path = join(repo, ".dev", "review-findings-tool-99.md");
		mkdirSync(join(repo, ".dev"));
		writeFileSync(path, "findings\n");
		const flags: Flags = { ...baseFlags, "review-findings": path };
		const digest = reviewFindingsDigest(readFileSync(path));
		const appliedOnSha = "a".repeat(40);
		const archivePath = appliedReviewFindingsArchivePath(repo, "TOOL-99", digest, appliedOnSha);

		assert.deepEqual(archiveReviewFindingsAfterImplement(flags, repo, "TOOL-99", digest, appliedOnSha), { ok: true });
		assert.equal(existsSync(path), false);
		assert.equal(readFileSync(archivePath, "utf-8"), "findings\n");
		assert.equal(flags["review-findings"], undefined);
		rmSync(repo, { recursive: true, force: true });
	});

	it("consumes caller-owned input without deleting it", () => {
		const repo = mkdtempSync(join(tmpdir(), "pelaggio-findings-test-"));
		const path = join(repo, "operator-notes.md");
		writeFileSync(path, "findings\n");
		const flags: Flags = { ...baseFlags, "review-findings": path };
		const digest = reviewFindingsDigest(readFileSync(path));

		assert.deepEqual(archiveReviewFindingsAfterImplement(flags, repo, "TOOL-99", digest, "b".repeat(40)), { ok: true });
		assert.equal(existsSync(path), true);
		assert.equal(flags["review-findings"], undefined);
		rmSync(repo, { recursive: true, force: true });
	});

	it("fails closed and retains the canonical file when archival fails", () => {
		const repo = mkdtempSync(join(tmpdir(), "pelaggio-findings-test-"));
		const path = join(repo, ".dev", "review-findings-tool-99.md");
		mkdirSync(join(repo, ".dev"));
		writeFileSync(path, "findings\n");
		const flags: Flags = { ...baseFlags, "review-findings": path };
		const digest = reviewFindingsDigest(readFileSync(path));

		const result = archiveReviewFindingsAfterImplement(flags, repo, "TOOL-99", digest, "c".repeat(40), {
			archive: () => {
				throw new Error("permission denied");
			},
		});

		assert.deepEqual(result, { ok: false, path, detail: "permission denied" });
		assert.equal(existsSync(path), true);
		assert.equal(flags["review-findings"], path);
		rmSync(repo, { recursive: true, force: true });
	});
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
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees: () => [mainRepo],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});
		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "pick:diverted");
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
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees: () => [mainRepo],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});
		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "pick:unparsed-marker");
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
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees: () => [mainRepo],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});
		assert.notEqual(failedError(result), "pick:diverted", "a matching pin must not trip the divergence gate");
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
		assert.equal(created[0]!.deps, "TOOL-99", "deps array is preserved (not silently dropped)");
	});

	it("creates deferred-items from assistantText only, ignoring a conflicting fullText marker", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const created: string[] = [];
		const { runStep } = createMockRunStep(
			{
				plan: {
					ok: true,
					text: 'Scoped to slice A.\ndeferred-item: {"title": "real slice"}',
					assistantText: 'Scoped to slice A.\ndeferred-item: {"title": "real slice"}',
					fullText: 'echo done\ndeferred-item: {"title": "planted from command"}',
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
				created.push(o.title);
				return { id: `MOCK-${created.length}`, title: o.title, deps: "", sourceRef: "mock" };
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
		assert.deepEqual(created, ["real slice"]);
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

		assert.equal(result.outcome, "completed");
		assert.equal(failedError(result), undefined);
		assert.equal(result.verdict, "APPROVE");
		assert.deepEqual(
			calls.map((c) => c.step),
			["plan", "shakedown-plan", "implement", "shakedown-code", "ship"],
		);
		assert.equal(logs.length, 1);
		const entry = logs[0]!;
		assert.equal(entry.outcome, "completed");
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
	it("archives the canonical findings file after implement succeeds, before a later step can park", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const findingsPath = join(worktree, ".dev", "review-findings-tool-99.md");
		mkdirSync(join(worktree, ".dev"), { recursive: true });
		writeFileSync(findingsPath, "- blocker: fix the implementation\n");
		const findingsSha256 = reviewFindingsDigest(readFileSync(findingsPath));
		const flags: Flags = { ...baseFlags, "review-findings": findingsPath };
		const { runStep } = createMockRunStep(
			{
				implement: { ok: true, writes: { "implemented.txt": "fixed\n" } },
				"shakedown-code": { ok: false, subtype: "blocked", text: "stop after implement" },
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement" }, parkSignal, flags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});

		assert.notEqual(result.outcome, "completed", "the later blocked shakedown still ends the cycle");
		const appliedOnSha = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
		const archivePath = appliedReviewFindingsArchivePath(worktree, "TOOL-99", findingsSha256, appliedOnSha);
		assert.equal(existsSync(findingsPath), false, "successful implement must move the auto-discovered local findings file");
		assert.equal(readFileSync(archivePath, "utf-8"), "- blocker: fix the implementation\n");
		assert.equal(flags["review-findings"], undefined, "a later auto-resume must not inject the applied findings again");
	});

	it("consumes caller-owned findings once without deleting the caller's file", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const findingsPath = join(worktree, "operator-notes.md");
		writeFileSync(findingsPath, "- blocker: fix the implementation\n");
		const flags: Flags = { ...baseFlags, "review-findings": findingsPath };
		const { runStep } = createMockRunStep(
			{
				implement: { ok: true, writes: { "implemented.txt": "fixed\n" } },
				"shakedown-code": { ok: false, subtype: "blocked", text: "stop after implement" },
			},
			parkSignal,
		);

		await runPipeline({ ...baseOpts(worktree), startFrom: "implement" }, parkSignal, flags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});

		assert.equal(existsSync(findingsPath), true, "the harness must not delete an arbitrary operator-owned input path");
		assert.equal(flags["review-findings"], undefined, "the applied input is still one-shot for this run");
	});

	it("keeps canonical findings when the implementation checkpoint does not commit cleanly", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const findingsPath = join(worktree, ".dev", "review-findings-tool-99.md");
		mkdirSync(join(worktree, ".dev"), { recursive: true });
		writeFileSync(findingsPath, "- blocker: fix the implementation\n");
		const flags: Flags = { ...baseFlags, "review-findings": findingsPath };
		const { runStep } = createMockRunStep({ implement: { ok: true, writes: { "implemented.txt": "uncommitted\n" } } }, parkSignal);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement" }, parkSignal, flags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
			dispatchStepEffects: async () => ({}),
		});

		assert.notEqual(result.outcome, "completed");
		assert.match(failedError(result) ?? "", /checkpoint did not commit cleanly/);
		assert.equal(existsSync(findingsPath), true);
		assert.equal(flags["review-findings"], findingsPath);
	});

	it("fails closed when the review findings file cannot be read", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const findingsPath = join(worktree, "missing-findings.md");
		const { runStep, calls } = createMockRunStep({}, parkSignal);

		const result = await runPipeline(
			{ ...baseOpts(worktree), startFrom: "implement" },
			parkSignal,
			{ ...baseFlags, "review-findings": findingsPath },
			{ runStep, mainRepo: worktree, listWorktrees: () => [], appendLog: () => {}, roadmap: makeMockRoadmap() },
		);

		assert.notEqual(result.outcome, "completed");
		assert.match(failedError(result) ?? "", /could not read review findings/);
		assert.match(failedError(result) ?? "", /missing-findings\.md/);
		assert.equal(
			calls.some((call) => call.step === "implement"),
			false,
		);
	});

	it("fails closed on an explicitly empty --review-findings path", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep({}, parkSignal);

		const result = await runPipeline(
			{ ...baseOpts(worktree), startFrom: "implement" },
			parkSignal,
			{ ...baseFlags, "review-findings": "" },
			{ runStep, mainRepo: worktree, listWorktrees: () => [], appendLog: () => {}, roadmap: makeMockRoadmap() },
		);

		assert.notEqual(result.outcome, "completed");
		assert.match(failedError(result) ?? "", /empty --review-findings path/);
		assert.equal(
			calls.some((call) => call.step === "implement"),
			false,
		);
	});

	it("fails closed when the review findings file is whitespace-only (no preamble)", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const findingsPath = join(worktree, "empty-findings.md");
		writeFileSync(findingsPath, "   \n\t\n");
		const { runStep, calls } = createMockRunStep({}, parkSignal);

		const result = await runPipeline(
			{ ...baseOpts(worktree), startFrom: "implement" },
			parkSignal,
			{ ...baseFlags, "review-findings": findingsPath },
			{ runStep, mainRepo: worktree, listWorktrees: () => [], appendLog: () => {}, roadmap: makeMockRoadmap() },
		);

		assert.notEqual(result.outcome, "completed");
		assert.match(failedError(result) ?? "", /is empty — refusing a findings-driven resume/);
		assert.equal(
			calls.some((call) => call.step === "implement"),
			false,
			"the generic plan prompt must not run in place of the missing revision task",
		);
	});

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

		assert.notEqual(result.outcome, "completed");
		assert.equal(existsSync(findingsPath), true, "an unsuccessful implement must preserve findings for retry");
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

		assert.notEqual(result.outcome, "completed");
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

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "plan needs rethink");
		assert.equal(result.verdict, "RETHINK");
		assert.deepEqual(
			calls.map((c) => c.step),
			["plan", "shakedown-plan"],
		);
		assert.equal(logs.length, 1);
		assert.equal(logs[0]!.verdict, "RETHINK");
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

		assert.equal(result.outcome, "completed");
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

		const steps = logs[0]!.steps as Array<{ name: string; attempt?: number; retriedMaxTurns?: boolean }>;
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

describe("runPipeline — edit-loop exhaustion", () => {
	it("persists unclassified rather than mislabeling the retry ceiling as a turn limit", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: [
					{ ok: false, subtype: "edit_loop", text: "Edit loop detected: src/a.ts edited 22 times", writes: { "impl-a.txt": "attempt 1" } },
					{ ok: false, subtype: "edit_loop", text: "Edit loop detected: src/a.ts edited 22 times", writes: { "impl-b.txt": "attempt 2" } },
				],
			},
			parkSignal,
		);

		const result = await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: (entry) => logs.push(entry),
		});

		assert.equal(result.outcome, "failed");
		assert.equal(failedClass(result), "unclassified");
		assert.equal(failedError(result), "implement failed (max retries)");
		assert.equal(calls.filter((call) => call.step === "implement").length, 2);
		assert.equal(logs[0]?.failureClass, "unclassified");
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

		assert.equal(result.outcome, "completed");
		const planCalls = calls.filter((c) => c.step === "plan");
		assert.equal(planCalls.length, 2, `expected two plan attempts; got ${planCalls.length}`);
		assert.deepEqual(
			planCalls.map((c) => c.attempt),
			[1, 2],
		);

		const steps = logs[0]!.steps as Array<{ name: string; attempt?: number; retriedMaxTurns?: boolean }>;
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

		assert.equal(result.outcome, "completed");
		assert.equal(result.verdict, "APPROVE");
		const sdpCalls = calls.filter((c) => c.step === "shakedown-plan");
		assert.equal(sdpCalls.length, 2, `expected two shakedown-plan attempts; got ${sdpCalls.length}`);
		assert.deepEqual(
			sdpCalls.map((c) => c.attempt),
			[1, 2],
		);
		const steps = logs[0]!.steps as Array<{ name: string; attempt?: number; retriedMaxTurns?: boolean }>;
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

		assert.equal(result.outcome, "completed");
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
		assert.equal(result.outcome, "failed");
		assert.equal(failedClass(result), "provider");
		assert.equal(failedError(result), "transient sdk error");
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
		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "shakedown-plan failed");
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

		assert.equal(result.outcome, "completed");
		const sdcCalls = calls.filter((c) => c.step === "shakedown-code");
		assert.equal(sdcCalls.length, 2, `expected two shakedown-code attempts; got ${sdcCalls.length}`);
		assert.deepEqual(
			sdcCalls.map((c) => c.attempt),
			[1, 2],
		);
		const steps = logs[0]!.steps as Array<{ name: string; attempt?: number; retriedMaxTurns?: boolean }>;
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

		assert.notEqual(result.outcome, "completed");
		assert.match(failedError(result) ?? "", /insufficient budget to retry/);
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

		assert.equal(result.outcome, "failed");
		assert.equal(failedClass(result), "refusal");
		assert.match(failedError(result) ?? "", /refused/);
		assert.deepEqual(
			calls.map((c) => c.step),
			["plan", "shakedown-plan"],
		);
		assert.equal(parkSignal.parked, false);
		assert.equal(logs.length, 1);
		assert.equal(logs[0]!.outcome, "failed");
		assert.equal(logs[0]!.failureClass, "refusal");
		assert.match((logs[0]!.error as string) ?? "", /refused/);
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

		assert.equal(result.outcome, "failed");
		assert.equal(failedClass(result), "refusal");
		assert.match(failedError(result) ?? "", /refused/);
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
				implement: { ok: false, subtype: "blocked", text: "the schema field does not exist", writes: { "blocked-wip.txt": "work" } },
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

		assert.equal(result.outcome, "blocked");
		assert.equal(result.outcome === "blocked" ? result.reason : undefined, "the schema field does not exist");
		assert.equal(result.outcome === "blocked" ? result.blockedKind : undefined, "unclassified");
		assert.equal(result.disposition, "quarantine-and-continue");
		assert.equal(execSync("git status --porcelain", { cwd: worktree, encoding: "utf-8" }).trim(), "");
		// Work is preserved by EITHER path: implement's checkpoint effect commits WIP
		// first ("implementation checkpoint"), so quarantineCheckpoint correctly no-ops
		// on the then-clean tree; its own "andon quarantine" commit appears only when
		// the tree is still dirty at quarantine time.
		assert.match(execSync("git log -1 --format=%s", { cwd: worktree, encoding: "utf-8" }), /andon quarantine|implementation checkpoint/);
		const implementCalls = calls.filter((c) => c.step === "implement");
		assert.equal(implementCalls.length, 1, `expected no implement retry; got ${implementCalls.length} calls`);
		const stepsRun = calls.map((c) => c.step);
		assert.ok(!stepsRun.includes("shakedown-code"), `expected no shakedown-code; got ${stepsRun.join(",")}`);
		assert.ok(!stepsRun.includes("ship"), `expected no ship; got ${stepsRun.join(",")}`);
		assert.equal(parkSignal.parked, false);
		assert.equal(logs.length, 1);
		assert.equal(logs[0].outcome, "blocked");
		assert.equal(logs[0].blockedKind, "unclassified");
		assert.equal(logs[0].reason, "the schema field does not exist");
		assert.equal(logs[0].completed, undefined);
		assert.equal(logs[0].error, undefined);
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

		assert.equal(result.outcome, "blocked");
		assert.equal(result.outcome === "blocked" ? result.reason : undefined, "rubric file is missing");
		assert.equal(result.disposition, "quarantine-and-continue");
		assert.deepEqual(
			calls.map((c) => c.step),
			["plan", "shakedown-plan"],
		);
		assert.equal(parkSignal.parked, false);
		assert.equal(logs[0].outcome, "blocked");
		assert.equal(logs[0].reason, "rubric file is missing");
	});

	it("ship blocked → quarantines while preserving the review verdict", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "work" } },
				"shakedown-code": { ok: true, text: "VERDICT: APPROVE" },
				ship: { ok: false, subtype: "blocked", text: "merge queue unavailable" },
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

		assert.equal(result.outcome, "blocked");
		assert.equal(result.outcome === "blocked" ? result.reason : undefined, "merge queue unavailable");
		assert.equal(result.disposition, "quarantine-and-continue");
		assert.equal(result.verdict, "APPROVE");
		assert.equal(parkSignal.parked, false);
		assert.equal(logs[0].outcome, "blocked");
		assert.equal(logs[0].reason, "merge queue unavailable");
		assert.equal(logs[0].verdict, "APPROVE");
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

		assert.equal(result.outcome, "failed");
		assert.equal(failedClass(result), "verification");
		assert.match(failedError(result) ?? "", /nothing to ship/);
		const stepsRun = calls.map((c) => c.step);
		assert.ok(!stepsRun.includes("ship"), `ship should not have been called; got ${stepsRun.join(",")}`);
		assert.equal(logs.length, 1);
		assert.equal(logs[0].outcome, "failed");
		assert.equal(logs[0].failureClass, "verification");
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

		assert.notEqual(result.outcome, "completed");
		assert.match(failedError(result) ?? "", /ship claimed success but main did not advance/);
		// The finish() spread surfaces the local shipwreck flag on the returned CycleResult so
		// the orchestrator can classify a `shipwrecked` notification.
		assert.equal(result.shipwrecked, true);
		const stepsRun = calls.map((c) => c.step);
		assert.ok(stepsRun.includes("shipwreck"), `expected shipwreck to run; got ${stepsRun.join(",")}`);
		assert.equal(logs.length, 1);
		assert.notEqual(logs[0].outcome, "completed");
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

		assert.notEqual(result.outcome, "completed");
		assert.match(failedError(result) ?? "", /cannot capture pre-ship git state/);
		const stepsRun = calls.map((c) => c.step);
		assert.ok(!stepsRun.includes("ship"), `ship should not have been invoked; got ${stepsRun.join(",")}`);
		assert.equal(logs.length, 1);
		assert.notEqual(logs[0].outcome, "completed");
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
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees,
			appendLog: (e) => {
				logs.push(e);
			},
			roadmap: makeMockRoadmap(),
			allowDirtyMain: false,
		});

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "implement failed: confinement violation");
		assert.equal(result.disposition, undefined);
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
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees,
			allowDirtyMain: true,
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
			dispatchStepEffects: async () => ({ appendText: "https://github.com/cdhorne/pelaggio/pull/99" }),
		});

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "implement failed: confinement violation");
	});

	it("tolerates unchanged operator dirtiness outside mutating-tool windows", async () => {
		const { mainRepo, worktree, listWorktrees } = makeConfinementRepos();
		writeFileSync(join(mainRepo, "operator.txt"), "existing");
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep({ implement: { ok: false, subtype: "error_refusal", sideEffect: () => writeFileSync(join(mainRepo, "operator.txt"), "existing") } }, parkSignal);
		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees,
			allowDirtyMain: true,
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});
		assert.equal(failedError(result), "implement refused (model declined the task)");
	});

	it("still fails on sibling writes when main auditing is disabled", async () => {
		const { parent, mainRepo, worktree } = makeConfinementRepos();
		const sibling = join(parent, `${WORKTREE_PREFIX}sibling-opt-out`);
		execSync(`git worktree add -q -b feat/sibling-opt-out "${sibling}"`, { cwd: mainRepo });
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep({ implement: { ok: true, sideEffect: () => writeFileSync(join(sibling, "foreign.txt"), "x") } }, parkSignal);
		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees: () => [mainRepo, worktree, sibling],
			allowDirtyMain: true,
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});
		assert.equal(failedError(result), "implement failed: confinement violation");
	});

	it("fails closed when sibling worktrees cannot be enumerated under the opt-out", async () => {
		const { mainRepo, worktree } = makeConfinementRepos();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep({ implement: { ok: true } }, parkSignal);
		const logs: Array<Record<string, unknown>> = [];
		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
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
			[],
			"#388: a before-phase enumeration failure fails closed before any provider spend",
		);
		assert.equal(failedError(result), "implement failed: confinement violation");
		const steps = logs[0].steps as Array<{ subtype?: string; text?: string; cost?: number }>;
		assert.equal(steps.at(-1)?.subtype, "error_confinement");
		assert.equal(steps.at(-1)?.cost, 0);
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
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees,
			allowDirtyMain: true,
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "implement failed: confinement violation");
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
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees: () => [mainRepo, worktree],
			appendLog: (e) => {
				logs.push(e);
			},
			roadmap: makeMockRoadmap(),
			dispatchStepEffects: async () => ({ appendText: "https://github.com/cdhorne/pelaggio/pull/99" }),
		});

		assert.equal(result.outcome, "completed");
		assert.equal(failedError(result), undefined);
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
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees,
			appendLog: (e) => {
				logs.push(e);
			},
			roadmap: makeMockRoadmap(),
			dispatchStepEffects: async () => ({ appendText: "https://github.com/cdhorne/pelaggio/pull/99" }),
		});

		assert.equal(result.outcome, "completed");
		assert.equal(failedError(result), undefined);
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
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees: () => [mainRepo, worktree, sibling],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "implement failed: confinement violation");
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
			return { ok: false, subtype: "error_refusal", text: "stop after implement", fullText: "stop after implement", assistantText: "stop after implement", cost: 0.01, turns: 1 };
		};

		const deps = {
			runStep,
			...defaultPrPreflightStubs(),
			mainRepo: repo,
			listWorktrees,
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		};
		const pA = runPipeline({ ...baseOpts(wtA), itemId: "TOOL-A", startFrom: "implement", shipTarget: getShipTarget("pull-request"), activeWorktrees }, makeParkSignal(), baseFlags, deps);
		const pB = runPipeline({ ...baseOpts(wtB), itemId: "TOOL-B", startFrom: "implement", shipTarget: getShipTarget("pull-request"), activeWorktrees }, makeParkSignal(), baseFlags, deps);

		const [rA, rB] = await Promise.all([pA, pB]);
		assert.equal(maxActive, 2, "audited provider windows must overlap — no serialization");
		assert.notEqual(failedError(rA), "implement failed: confinement violation");
		assert.notEqual(failedError(rB), "implement failed: confinement violation");
		// Both should surface the intentional refusal, not a race false-positive.
		assert.match(failedError(rA) ?? "", /refused/);
		assert.match(failedError(rB) ?? "", /refused/);
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
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees: () => [mainRepo, worktree],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "implement failed: confinement violation");
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
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees: () => [mainRepo, worktree, inactive],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
		});

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "implement failed: confinement violation");
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
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees,
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
			dispatchStepEffects: async () => ({ appendText: "https://github.com/cdhorne/pelaggio/pull/99" }),
		});

		assert.equal(result.outcome, "completed");
		assert.equal(failedError(result), undefined);
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
			...defaultPrPreflightStubs(),
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

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "implement failed: confinement violation");
		assert.deepEqual(
			calls.map((c) => c.step),
			[],
			"#388: provider must not run when pre-snapshot fails — fail closed before any spend",
		);
		const step = (logs[0].steps as Array<{ name: string; ok: boolean; subtype?: string; outputTail?: string; errorDetail?: string; cost?: number; turns?: number }>).at(-1);
		assert.equal(step?.ok, false);
		assert.equal(step?.subtype, "error_confinement");
		assert.equal(step?.cost, 0);
		assert.equal(step?.turns, 0);
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
			...defaultPrPreflightStubs(),
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

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "implement failed: confinement violation");
		const step = (logs[0].steps as Array<{ subtype?: string; outputTail?: string; errorDetail?: string }>).at(-1);
		assert.equal(step?.subtype, "error_confinement");
		assert.match(step?.errorDetail ?? "", /after implement/);
		assert.match(step?.errorDetail ?? "", /index\.lock/);
		assert.match(step?.outputTail ?? "", /after implement/);
		assert.ok(!(step?.outputTail ?? "").includes("checks green"));
	});

	it("mid-step probe cancels the in-flight provider and classifies error_confinement well before the step's natural end (#388)", async () => {
		const { mainRepo, worktree, listWorktrees } = makeConfinementRepos();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		// awaitAbort means this mock never resolves on its own — only a real abort (SIGINT or,
		// here, the mid-step confinement prober) can unblock it, proving the prober actually
		// drove cancellation through the same signal/driver boundary rather than the step just
		// happening to end on its own.
		const { runStep, calls } = createMockRunStep({ implement: { awaitAbort: true, ok: false, subtype: "error_abort", text: "aborted" } }, parkSignal);
		const tamperAt = setTimeout(() => writeFileSync(join(mainRepo, "tampered.txt"), "x"), 20);
		const t0 = Date.now();
		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees,
			appendLog: (e) => {
				logs.push(e);
			},
			roadmap: makeMockRoadmap(),
			confinementProbeIntervalMs: 10,
		});
		const elapsed = Date.now() - t0;
		clearTimeout(tamperAt);

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "implement failed: confinement violation");
		assert.ok(elapsed < 2000, `expected the mid-step probe to trip well under 2s; got ${elapsed}ms`);
		assert.equal(calls[0]?.step, "implement");
		const step = (logs[0].steps as Array<{ subtype?: string; errorDetail?: string; cost?: number }>).at(-1);
		assert.equal(step?.subtype, "error_confinement");
		assert.match(step?.errorDetail ?? "", /forbidden root changed during implement/);
		assert.match(step?.errorDetail ?? "", /tampered\.txt/);
	});

	it("mid-step probe warns but does not abort on a live #369 session peer's write, and the step still completes", async () => {
		const { parent, mainRepo, worktree } = makeConfinementRepos();
		const peer = join(parent, `${WORKTREE_PREFIX}peer-midstep`);
		execSync(`git worktree add -q -b feat/peer-midstep "${peer}"`, { cwd: mainRepo });
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep(
			{
				// delayMs (not awaitAbort) so the step still resolves naturally if the prober
				// never trips — proving a live peer's mid-step write is excluded, not just slow.
				implement: { delayMs: 40, ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: prShipDecision(),
			},
			parkSignal,
		);
		const accepted = {
			identity: { sessionId: "midstep-peer", claimedItem: "peer-midstep", claimBranch: "feat/peer-midstep", worktreePath: peer },
			worktreePath: peer,
			leg: "binding" as const,
			pid: 1,
		};
		const peerWriteAt = setTimeout(() => writeFileSync(join(peer, "during.txt"), "x"), 10);
		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees: () => [mainRepo, worktree, peer],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
			dispatchStepEffects: async () => ({ appendText: "https://github.com/cdhorne/pelaggio/pull/99" }),
			confinementProbeIntervalMs: 10,
			// Not exempt at step start — the peer write lands mid-step, after the before-snapshot.
			resolveEligibleSessions: () => [],
			revalidateChangedRoot: (_ctx, root) => (root === peer || root.endsWith("peer-midstep") ? accepted : undefined),
		});
		clearTimeout(peerWriteAt);

		assert.equal(result.outcome, "completed");
		assert.equal(failedError(result), undefined);
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
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees,
			appendLog: (e) => {
				logs.push(e);
			},
			roadmap: makeMockRoadmap(),
			allowDirtyMain: false,
		});

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "implement failed: confinement violation");
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

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "pick failed");
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

		assert.notEqual(result.outcome, "completed");
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
		assert.notEqual(failedError(result), "shipwreck failed: confinement violation");
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

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "ship failed: confinement violation");
		assert.equal(interpreted, false);
		assert.ok(!calls.map((c) => c.step).includes("shipwreck"));
	});
});

describe("runPipeline — cross-process session records (#369)", () => {
	it("exempts a sibling proven by resolveEligibleSessions at step start without false-positive", async () => {
		const { parent, mainRepo, worktree } = makeConfinementRepos();
		const peer = join(parent, `${WORKTREE_PREFIX}peer`);
		execSync(`git worktree add -q -b feat/peer "${peer}"`, { cwd: mainRepo });
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep(
			{
				implement: {
					ok: true,
					// A real deliverable in the ITEM worktree: these tests are about peer-session
					// exemption, not the plan-only ship guard, and with `.dev/` correctly ignored
					// (as in production) a peer-only side effect leaves nothing to ship.
					writes: { "impl.txt": "x" },
					sideEffect: () => {
						writeFileSync(join(peer, "peer-only.txt"), "ok");
					},
				},
				"shakedown-code": { ok: true },
				ship: prShipDecision(),
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees: () => [mainRepo, worktree, peer],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
			dispatchStepEffects: async () => ({ appendText: "https://github.com/cdhorne/pelaggio/pull/99" }),
			resolveEligibleSessions: () => [
				{
					identity: { sessionId: "peer-sess", claimedItem: "peer", claimBranch: "feat/peer", worktreePath: peer },
					worktreePath: peer,
					leg: "fallback",
					pid: 0,
				},
			],
		});

		assert.equal(result.outcome, "completed", `expected success; error=${failedError(result)}`);
	});

	it("revalidates a changed sibling at diff time: still-eligible warns instead of parking", async () => {
		const { parent, mainRepo, worktree } = makeConfinementRepos();
		const peer = join(parent, `${WORKTREE_PREFIX}peer-rv`);
		execSync(`git worktree add -q -b feat/peer-rv "${peer}"`, { cwd: mainRepo });
		const parkSignal = makeParkSignal();
		const warnings: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
		try {
			const { runStep } = createMockRunStep(
				{
					implement: {
						ok: true,
						// See the sibling test: a real deliverable in the ITEM worktree, so the
						// plan-only ship guard does not mask what this test is actually asserting.
						writes: { "impl.txt": "x" },
						sideEffect: () => {
							writeFileSync(join(peer, "during.txt"), "x");
						},
					},
					"shakedown-code": { ok: true },
					ship: prShipDecision(),
				},
				parkSignal,
			);

			const accepted = {
				identity: { sessionId: "rv-peer", claimedItem: "peer-rv", claimBranch: "feat/peer-rv", worktreePath: peer },
				worktreePath: peer,
				leg: "binding" as const,
				pid: 1,
			};
			const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
				runStep,
				...defaultPrPreflightStubs(),
				mainRepo,
				listWorktrees: () => [mainRepo, worktree, peer],
				appendLog: () => {},
				roadmap: makeMockRoadmap(),
				dispatchStepEffects: async () => ({ appendText: "https://github.com/cdhorne/pelaggio/pull/99" }),
				// Not exempt at step start — peer dirty shows up in the diff — then revalidation saves it.
				resolveEligibleSessions: () => [],
				revalidateChangedRoot: (_ctx, root) => (root === peer || root.endsWith("peer-rv") ? accepted : undefined),
			});

			assert.equal(result.outcome, "completed", `expected revalidation suppress; error=${failedError(result)}`);
			assert.ok(
				warnings.some((w) => /excluded live session/.test(w)),
				`expected revalidation warning; got: ${warnings.join(" | ")}`,
			);
		} finally {
			console.log = origLog;
		}
	});

	it("parks when a changed sibling fails revalidation (identity/expired/missing)", async () => {
		const { parent, mainRepo, worktree } = makeConfinementRepos();
		const peer = join(parent, `${WORKTREE_PREFIX}peer-dead`);
		execSync(`git worktree add -q -b feat/peer-dead "${peer}"`, { cwd: mainRepo });
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep(
			{
				implement: {
					ok: true,
					sideEffect: () => {
						writeFileSync(join(peer, "foreign.txt"), "x");
					},
				},
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees: () => [mainRepo, worktree, peer],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
			resolveEligibleSessions: () => [],
			revalidateChangedRoot: () => undefined,
		});

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "implement failed: confinement violation");
	});

	it("registers and disposes a session controller around the cycle lifecycle", async () => {
		const { mainRepo, worktree } = makeConfinementRepos();
		const parkSignal = makeParkSignal();
		const events: string[] = [];
		let disposed = false;
		const { runStep } = createMockRunStep(
			{
				implement: { ok: false, text: "stop" },
			},
			parkSignal,
		);

		await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees: () => [mainRepo, worktree],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
			captureEvaluatorContext: (repo) => ({ inventory: { identities: [] }, mainRepo: repo }),
			createSessionController: (args) => {
				events.push(`create:${args.claimedItem}:${args.claimBranch}`);
				events.push(`session:${args.sessionId}`);
				return {
					sessionId: args.sessionId,
					identity: {
						sessionId: args.sessionId,
						claimedItem: args.claimedItem,
						claimBranch: args.claimBranch,
						worktreePath: args.worktreePath,
					},
					updateChild: (pid) => {
						events.push(`pid:${pid}`);
					},
					dispose: () => {
						disposed = true;
						events.push("dispose");
					},
				};
			},
		});

		// The record id is item + attempt scoped, never the cycle's unclaimed id (#738 review).
		assert.ok(
			events.some((e) => /^session:cycle-\d+-TOOL-99-a\d+$/.test(e)),
			`expected an item-scoped session id; got ${events.join(",")}`,
		);
		assert.ok(
			events.some((e) => e.startsWith("create:TOOL-99:feat/tool-99")),
			`expected create; got ${events.join(",")}`,
		);
		assert.equal(disposed, true);
		assert.ok(events.includes("dispose"));
	});

	it("includes excluded-session diagnostics in confinement park evidence", async () => {
		const { parent, mainRepo, worktree } = makeConfinementRepos();
		const peer = join(parent, `${WORKTREE_PREFIX}diag`);
		const inactive = join(parent, `${WORKTREE_PREFIX}inactive-diag`);
		execSync(`git worktree add -q -b feat/diag "${peer}"`, { cwd: mainRepo });
		execSync(`git worktree add -q -b feat/inactive-diag "${inactive}"`, { cwd: mainRepo });
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep } = createMockRunStep(
			{
				implement: {
					ok: true,
					sideEffect: () => {
						writeFileSync(join(inactive, "leaked.txt"), "x");
					},
				},
			},
			parkSignal,
		);

		await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees: () => [mainRepo, worktree, peer, inactive],
			appendLog: (e) => {
				logs.push(e);
			},
			roadmap: makeMockRoadmap(),
			resolveEligibleSessions: () => [
				{
					identity: { sessionId: "ex-1", claimedItem: "diag", claimBranch: "feat/diag", worktreePath: peer },
					worktreePath: peer,
					leg: "fallback",
					pid: 0,
				},
			],
			revalidateChangedRoot: () => undefined,
		});

		const steps = logs[0]?.steps as Array<{ subtype?: string; errorDetail?: string; outputTail?: string }>;
		const conf = steps?.find((s) => s.subtype === "error_confinement");
		assert.ok(conf, "expected confinement step");
		assert.match(String(conf.errorDetail ?? conf.outputTail ?? ""), /excluded sessions|ex-1|inactive-diag|leaked/);
	});

	it("threads foreignRootDenial into runStep for Claude hooks including ownWorktree", async () => {
		const { mainRepo, worktree } = makeConfinementRepos();
		const parkSignal = makeParkSignal();
		const seen: Array<{ foreign?: unknown; child?: unknown }> = [];
		const runStep: RunStepFn = async (_name, _prompt, opts, emit) => {
			seen.push({ foreign: opts.foreignRootDenial, child: typeof opts.onChildSpawn });
			emit({ type: "done", ok: false, subtype: "error_refusal", cost: 0.01, turns: 1, elapsed: 0 });
			return { ok: false, subtype: "error_refusal", text: "stop", fullText: "stop", assistantText: "stop", cost: 0.01, turns: 1 };
		};

		await runPipeline({ ...baseOpts(worktree), startFrom: "implement", shipTarget: getShipTarget("pull-request") }, parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			mainRepo,
			listWorktrees: () => [mainRepo, worktree],
			appendLog: () => {},
			roadmap: makeMockRoadmap(),
			createSessionController: (args) => ({
				sessionId: args.sessionId,
				identity: {
					sessionId: args.sessionId,
					claimedItem: args.claimedItem,
					claimBranch: args.claimBranch,
					worktreePath: args.worktreePath,
				},
				updateChild: () => {},
				dispose: () => {},
			}),
		});

		assert.ok(seen.length > 0);
		const first = seen[0]!;
		const fr = first.foreign as { mainRepo: string; ownWorktree?: string; registeredWorktrees: string[] };
		assert.equal(fr.mainRepo, mainRepo);
		assert.ok(fr.registeredWorktrees.includes(worktree) || fr.registeredWorktrees.includes(mainRepo));
		assert.equal(first.child, "function");
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

		assert.equal(result.outcome, "completed");
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

		assert.equal(result.outcome, "completed");
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

		assert.equal(result.outcome, "completed");
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

		assert.equal(result.outcome, "completed");
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

		assert.equal(result.outcome, "parked");
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

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "plan failed");
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

		assert.equal(result.outcome, "completed");
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

		assert.equal(result.outcome, "completed");
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
		const writer = createEventWriter({ root: worktree });
		const observedAt = 1_700_000_000_000;
		const poolId = "k:0123456789ab";
		const { runStep, calls } = createMockRunStep(
			{
				plan: {
					ok: true,
					observation: {
						kind: "usage",
						provider: "claude",
						poolId,
						windows: [{ name: "five_hour", channel: "reported", observedAt, usedFraction: 0.47, resetsAt: observedAt + 3_600_000 }],
					},
				},
				"shakedown-plan": {
					ok: false,
					subtype: "error_rate_limit",
					writes: { "wip.txt": "partial work" },
					park: { parked: true, limitType: "five_hour", resetsAt: Date.now() + 3_600_000, rateLimit: { provider: "claude", window: "five_hour" } },
					observation: { kind: "limit", provider: "claude", poolId, fault: "rate-limit", window: "five_hour", parked: true, resetsAt: observedAt + 3_600_000 },
				},
			},
			parkSignal,
		);

		const result = await runPipeline({ ...baseOpts(worktree), eventWriter: writer }, parkSignal, baseFlags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.notEqual(result.outcome, "completed");
		assert.equal(result.outcome, "parked");
		const stepsRun = calls.map((c) => c.step);
		assert.ok(!stepsRun.includes("implement"));
		assert.ok(!stepsRun.includes("shakedown-code"));
		assert.ok(!stepsRun.includes("ship"));

		const msgs = allCommitMessages(worktree);
		assert.ok(
			msgs.some((m) => m === "wip: pelaggio rate-limit park"),
			`expected rate-limit park commit; got:\n${msgs.join("\n")}`,
		);

		assert.equal(logs[0]?.outcome, "parked");
		assert.equal(logs[0]?.parkReason, "five_hour");
		// Signal-driven park: the structured limitType classifies it, and no review-loop
		// reason is present to override it.
		assert.equal(logs[0]?.parkClass, "rate-limit");
		assert.equal(logs[0]?.parkProvider, "claude");
		assert.equal(logs[0]?.parkWindow, "five_hour");

		const events = readEventLog({ root: worktree, cycleLogPath: null }).events;
		const usage = events.find((event) => event.type === "pelaggio.provider-usage");
		const limit = events.find((event) => event.type === "pelaggio.provider-limit");
		assert.ok(usage, "expected a correlated usage observation");
		assert.ok(limit, "expected a parked limit observation");
		assert.equal(usage.itemId, "TOOL-99");
		assert.equal("step" in usage ? usage.step : undefined, "plan");
		assert.ok(["claude", "codex", "grok", "opencode"].includes("provider" in usage ? String(usage.provider) : ""));
		assert.equal("windows" in usage && Array.isArray(usage.windows) ? usage.windows[0]?.usedFraction : undefined, 0.47);
		assert.equal("windows" in usage && Array.isArray(usage.windows) ? usage.windows[0]?.name : undefined, "five_hour");
		assert.equal("windows" in usage && Array.isArray(usage.windows) ? usage.windows[0]?.resetsAt : undefined, observedAt + 3_600_000);
		assert.equal("windows" in usage && Array.isArray(usage.windows) ? usage.windows[0]?.observedAt : undefined, observedAt);
		assert.equal("parked" in limit ? limit.parked : undefined, true);
		assert.equal("window" in limit ? limit.window : undefined, "five_hour");
	});

	it("distinguishes a weekly Claude window from the five-hour park while keeping coarse parkClass", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": {
					ok: false,
					subtype: "error_rate_limit",
					writes: { "wip.txt": "weekly" },
					park: { parked: true, limitType: "seven_day_opus", resetsAt: Date.now() + 3_600_000, rateLimit: { provider: "claude", window: "seven_day_opus" } },
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
		assert.equal(result.outcome, "parked");
		assert.equal(logs[0]?.parkClass, "rate-limit");
		assert.equal(logs[0]?.parkProvider, "claude");
		assert.equal(logs[0]?.parkWindow, "seven_day_opus");
	});

	it("persists a Codex-shaped park with a null window", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": {
					ok: false,
					subtype: "error_rate_limit",
					writes: { "wip.txt": "codex" },
					park: { parked: true, limitType: "unknown (estimated)", resetsAt: Date.now() + 3_600_000, rateLimit: { provider: "codex", window: null } },
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
		assert.equal(result.outcome, "parked");
		assert.equal(logs[0]?.parkClass, "rate-limit");
		assert.equal(logs[0]?.parkProvider, "codex");
		assert.equal(logs[0]?.parkWindow, null);
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

		const sessionIds: string[] = [];
		const result = await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			resolveWorktree: (id) => join(parent, `${WORKTREE_PREFIX}${id.toLowerCase()}`),
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
			runShipBookkeeping: noopBookkeeping,
			createSessionController: (args) => {
				sessionIds.push(args.sessionId);
				return { sessionId: args.sessionId, identity: { sessionId: args.sessionId, claimedItem: args.claimedItem, claimBranch: args.claimBranch, worktreePath: args.worktreePath }, updateChild: () => {}, dispose: () => {} };
			},
		});

		assert.equal(result.outcome, "completed");
		assert.equal(result.itemId, "TOOL-99");
		// Auto-pick resolves the item inside the pick step; the #369 session record must still be
		// item + attempt scoped (`cycle-N-TOOL-99-aN`), never the cycle's `cycle-N-unclaimed` id —
		// concurrent cycles at the same number would otherwise overwrite one another's record (#738 review).
		assert.deepEqual(
			sessionIds.map((id) => id.replace(/^cycle-\d+-/, "")),
			["TOOL-99-a1"],
			`session ids: ${sessionIds.join(",")}`,
		);
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick", "plan", "shakedown-plan", "implement", "shakedown-code", "ship"],
		);
		assert.ok(existsSync(worktreePath), `expected worktree at ${worktreePath}`);
		assert.equal(logs.length, 1);
		assert.equal(logs[0].outcome, "completed");
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

		assert.equal(result.outcome, "completed");
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

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "pick failed");
		assert.equal(result.itemId, null);
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick"],
		);
		assert.notEqual(logs[0].outcome, "completed");
		const provenance = logs[0].provenance as Record<string, unknown>;
		assert.equal(provenance.runId, "cycle-1");
		assert.equal(provenance.durationMs, 42);
		assert.deepEqual(provenance.git, git);
		assert.deepEqual(provenance.versions, { pelaggio: "0.1.0", node: "v22", drivers: { claude: "sdk 1" } });
		assert.equal((provenance.drivers as Array<{ provider: string }>)[0].provider, "claude");
	});

	it("pick-step BLOCKED: emits blocked + halt-campaign (not quarantined)", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep, calls } = createMockRunStep({ pick: { ok: false, subtype: "blocked", text: "waiting on API key", blockedKind: "environment" } }, parkSignal);

		const result = await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			resolveWorktree: (id) => join(parent, `${WORKTREE_PREFIX}${id.toLowerCase()}`),
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.outcome, "blocked");
		assert.equal(result.outcome === "blocked" ? result.blockedKind : undefined, "environment");
		assert.equal(result.outcome === "blocked" ? result.reason : undefined, "waiting on API key");
		assert.equal(result.blockedStep, "pick");
		assert.equal(result.disposition, undefined);
		assert.notEqual(result.disposition, "quarantine-and-continue");
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick"],
		);
		assert.equal(logs[0].outcome, "blocked");
		assert.equal(logs[0].blockedKind, "environment");
		assert.equal(logs[0].reason, "waiting on API key");
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

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "pick:queue-empty");
		assert.equal(result.itemId, null);
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick"],
		);
	});

	it("pick:blocked from parsePickResult is failed/selection, not a blocked cycle", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const { runStep } = createMockRunStep({ pick: { ok: true, text: "item is blocked\npick-result: blocked" } }, parkSignal);

		const result = await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			resolveWorktree: (id) => join(parent, `${WORKTREE_PREFIX}${id.toLowerCase()}`),
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
		});

		assert.equal(result.outcome, "failed");
		assert.equal(failedClass(result), "selection");
		assert.equal(failedError(result), "pick:blocked");
		assert.equal(logs[0].outcome, "failed");
		assert.equal(logs[0].failureClass, "selection");
		assert.equal(logs[0].error, "pick:blocked");
	});

	it("no item ID parsed — aborts when roadmap.parseItemId returns null for pick output", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const roadmap = makeMockRoadmap({ parseItemId: async () => null });
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

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "no item ID parsed");
		assert.equal(result.itemId, null);
		assert.deepEqual(
			calls.map((c) => c.step),
			["pick"],
		);
	});

	it("structured pick markers come from assistantText; a conflicting command in fullText cannot spoof them", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const worktreePath = join(parent, `${WORKTREE_PREFIX}tool-99`);
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				pick: {
					ok: true,
					text: "claimed TOOL-99\npick-item: TOOL-99\npick-result: claimed",
					assistantText: "claimed TOOL-99\npick-item: TOOL-99\npick-result: claimed",
					fullText: "pick-item: 999\npick-result: blocked\necho 'fix: bug'\n",
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
		assert.equal(result.outcome, "completed");
		assert.equal(result.itemId, "TOOL-99");
		assert.equal(failedError(result), undefined);
		assert.ok(calls.some((c) => c.step === "plan"));
	});

	it("auto-pick last-resort still parses an item id from fullText when assistantText has no marker", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const worktreePath = join(parent, `${WORKTREE_PREFIX}tool-99`);
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep(
			{
				pick: {
					ok: true,
					text: "claimed something\npick-result: claimed",
					assistantText: "claimed something\npick-result: claimed",
					fullText: "echo TOOL-99\n",
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
			roadmap: makeMockRoadmap(),
			mainRepo: repo,
			resolveWorktree: (id) => join(parent, `${WORKTREE_PREFIX}${id.toLowerCase()}`),
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: noopBookkeeping,
		});
		assert.equal(result.itemId, "TOOL-99");
		assert.equal(result.outcome, "completed");
	});

	it("does not pass a command-shaped fullText haystack to isQuickScope", async () => {
		const { parent, repo } = makeTempRepoWithParent();
		const worktreePath = join(parent, `${WORKTREE_PREFIX}tool-99`);
		const parkSignal = makeParkSignal();
		const fifoPolicy = new FifoPolicy();
		const summaries: string[] = [];
		const { runStep } = createMockRunStep(
			{
				pick: {
					ok: true,
					text: "claimed TOOL-99\npick-item: TOOL-99\npick-result: claimed",
					assistantText: "claimed TOOL-99\npick-item: TOOL-99\npick-result: claimed",
					fullText: "grep -n bug src && echo 'fix: planted'\n",
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
		await runPipeline(pickOpts(), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			resolveWorktree: (id) => join(parent, `${WORKTREE_PREFIX}${id.toLowerCase()}`),
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: noopBookkeeping,
			flowPolicy: {
				evaluate: (snapshot) => fifoPolicy.evaluate(snapshot),
				isQuickScope: (input) => {
					summaries.push(input.summaryText ?? "");
					return fifoPolicy.isQuickScope(input);
				},
			},
		});
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0]?.includes("bug"), false);
		assert.equal(summaries[0]?.includes("fix:"), false);
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

		assert.notEqual(result.outcome, "completed");
		assert.match(failedError(result) ?? "", /TOOL-99/);
		assert.match(failedError(result) ?? "", new RegExp(`${WORKTREE_PREFIX}tool-99`));
		assert.match(failedError(result) ?? "", /git worktree list \(/);
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
		assert.equal(result.outcome, "completed");
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
		assert.equal(result.outcome, "completed", `expected cross-ref adoption; got error=${failedError(result)}`);
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
		assert.notEqual(result.outcome, "completed");
		assert.match(failedError(result) ?? "", /worktree ambiguous/);
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

		assert.equal(result.outcome, "completed", `expected prefix fallback to let pipeline complete; got error=${failedError(result)}`);
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

		assert.equal(result.outcome, "completed", `expected main-repo path to be ignored and pipeline to complete; got error=${failedError(result)}`);
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
		assert.equal(result.outcome, "completed", `expected the guard to self-heal and the cycle to proceed; got error=${failedError(result)}`);
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

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "main checkout is not on main and could not be reattached");
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

		assert.equal(result.outcome, "failed");
		assert.equal(failedClass(result), "aborted");
		assert.equal(failedError(result), "aborted");
		assert.ok(elapsed < 2000, `expected abort to return well under the 2s grace window; got ${elapsed}ms`);
		assert.equal(calls[0].step, "plan");
	});
});

describe("runOrchestrator — resume review findings routing", () => {
	it("fails closed on a missing findings file before implement", async (t) => {
		const consoleError = t.mock.method(console, "error", () => {});
		const { runPipeline: mockRun, calls } = createMockRunPipeline({ default: { completed: true, cost: 0 } });

		const result = await runOrchestrator({ ...baseFlags, resume: "108", "review-findings": "missing.md" }, { runPipeline: mockRun, resolveWorktree: () => "/tmp/pelaggio-resume-review-findings" });

		assert.equal(result.exitCode, 1);
		assert.equal(calls.length, 0);
		assert.ok(consoleError.mock.calls.some((call) => String(call.arguments[0]).includes("findings file not found; refusing a findings-driven resume without findings")));
	});

	it("runs the revision when explicit findings are present, even past implement", async () => {
		const { runPipeline: mockRun, calls } = createMockRunPipeline({ default: { completed: true, cost: 0 } });
		const worktree = "/tmp/pelaggio-resume-review-findings";
		const repo = mkdtempSync(join(tmpdir(), "pelaggio-resume-findings-"));
		const findingsPath = join(repo, "findings.md");
		writeFileSync(findingsPath, "must fix\n");

		const result = await runOrchestrator(
			{ ...baseFlags, resume: "108", "review-findings": findingsPath },
			{
				runPipeline: mockRun,
				resolveWorktree: () => worktree,
				detectResumeStep: () => "ship",
			},
		);

		assert.equal(result.exitCode, 0);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.startFrom, "implement");
		assert.equal(calls[0].flags["review-findings"], findingsPath);
		rmSync(repo, { recursive: true, force: true });
	});

	it("rejects a non-implement --from when review findings are present (exit 2)", async (t) => {
		t.mock.method(console, "error", () => {});
		const { runPipeline: mockRun, calls } = createMockRunPipeline({ default: { completed: true, cost: 0 } });
		const worktree = "/tmp/pelaggio-resume-review-findings";
		const repo = mkdtempSync(join(tmpdir(), "pelaggio-resume-findings-"));
		const findingsPath = join(repo, "findings.md");
		writeFileSync(findingsPath, "must fix\n");

		const result = await runOrchestrator(
			{ ...baseFlags, resume: "108", from: "shakedown-code", "review-findings": findingsPath },
			{
				runPipeline: mockRun,
				resolveWorktree: () => worktree,
				detectResumeStep: () => "ship",
			},
		);

		// A later --from would skip the implement step that reads and validates the
		// findings — the combination fails closed before any pipeline spend.
		assert.equal(result.exitCode, 2);
		assert.equal(calls.length, 0);
		rmSync(repo, { recursive: true, force: true });
	});

	it("allows --from implement combined with explicit review findings", async () => {
		const { runPipeline: mockRun, calls } = createMockRunPipeline({ default: { completed: true, cost: 0 } });
		const worktree = "/tmp/pelaggio-resume-review-findings";
		const repo = mkdtempSync(join(tmpdir(), "pelaggio-resume-findings-"));
		const findingsPath = join(repo, "findings.md");
		writeFileSync(findingsPath, "must fix\n");

		const result = await runOrchestrator(
			{ ...baseFlags, resume: "108", from: "implement", "review-findings": findingsPath },
			{
				runPipeline: mockRun,
				resolveWorktree: () => worktree,
				detectResumeStep: () => "ship",
			},
		);

		assert.equal(result.exitCode, 0);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.startFrom, "implement");
		assert.equal(calls[0].flags["review-findings"], findingsPath);
		rmSync(repo, { recursive: true, force: true });
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
				parkSignal.rateLimit = { provider: "claude", window: "five_hour" };
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
		assert.equal(snap.rateLimit, undefined);
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

describe("runPipeline — authoring review capability seating + effects (#337)", () => {
	const cleanFindings = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "clean review", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
	const cleanJudge = `AUTHORING_REVIEW_JUDGE\n${JSON.stringify({ schemaVersion: 1, decisions: [] })}\nEND_AUTHORING_REVIEW_JUDGE`;

	it("emits aggregate review.Verdict at shakedown-code attempt 0 when authoring converges", async () => {
		const saved = {
			enabled: REVIEW_CONFIG.authoring.enabled,
			reviewers: REVIEW_CONFIG.authoring.reviewers.map((s) => ({ ...s })),
			judge: { ...REVIEW_CONFIG.authoring.judge },
		};
		// Two non-author reviewers so author (claude, default implement) is excluded cleanly.
		REVIEW_CONFIG.authoring.enabled = "local";
		REVIEW_CONFIG.authoring.reviewers = [
			{ id: "codex", provider: "codex" },
			{ id: "grok", provider: "grok" },
		];
		REVIEW_CONFIG.authoring.judge = { id: "judge", provider: "claude" };

		const worktree = makeTempGitRepo();
		// Seed a real commit so getHeadSha binds and seats can pin.
		writeFileSync(join(worktree, "seed.txt"), "seed");
		execSync("git add -A && git commit -q -m seed", { cwd: worktree });

		const parkSignal = makeParkSignal();
		const writer = createEventWriter({ root: worktree });
		const manifests: Array<{ attempt: number; step: string; effects: unknown[] }> = [];
		const dispatches: Array<{ attempt: number; step: string }> = [];
		const { runStep: mockRunStep, calls } = createMockRunStep(
			{
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"pr-review": { ok: true, text: cleanFindings, fullText: cleanFindings },
				"pr-verify": {
					ok: true,
					text: cleanJudge,
					fullText: cleanJudge,
					observation: { kind: "usage", provider: "claude", poolId: "k:0123456789ab", windows: [{ name: "five_hour", channel: "reported", observedAt: 1, usedFraction: 0.25, resetsAt: 2 }] },
				},
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
		const authoringWorkspaceAccess: Array<{ name: string; workspaceAccess?: "read-only" }> = [];
		const runStep: RunStepFn = async (name, prompt, opts, emit) => {
			if (name === "pr-review" || name === "pr-verify") authoringWorkspaceAccess.push({ name, workspaceAccess: opts.workspaceAccess });
			return mockRunStep(name, prompt, opts, emit);
		};

		try {
			const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", eventWriter: writer }, parkSignal, baseFlags, {
				runStep,
				mainRepo: worktree,
				listWorktrees: () => [worktree],
				appendLog: () => {},
				runShipBookkeeping: noopBookkeeping,
				writeEffectsManifest: (ctx, effects) => {
					manifests.push({ attempt: ctx.attempt, step: ctx.step, effects: [...effects] });
					writeEffectsManifest(ctx, effects);
				},
				dispatchStepEffects: async (ctx) => {
					dispatches.push({ attempt: ctx.attempt, step: ctx.step });
					return dispatchStepEffects(ctx);
				},
			});

			assert.equal(result.outcome, "completed", `expected completed cycle; error=${failedError(result)}`);
			// Reviewer seats run as pr-review; judge as pr-verify; no ordinary shakedown-code step() for review.
			assert.ok(
				calls.some((c) => c.step === "pr-review"),
				"expected pr-review seat calls",
			);
			assert.ok(
				calls.some((c) => c.step === "pr-verify"),
				"expected pr-verify judge call",
			);
			assert.ok(authoringWorkspaceAccess.length >= 2);
			for (const call of authoringWorkspaceAccess) assert.equal(call.workspaceAccess, undefined, `${call.name} authoring seat must remain writable`);
			const aggregate = manifests.find((m) => m.step === "shakedown-code" && m.attempt === 0);
			assert.ok(aggregate, `expected shakedown-code attempt 0 manifest; got ${JSON.stringify(manifests)}`);
			assert.equal(aggregate.effects[0] && (aggregate.effects[0] as { kind: string }).kind, "review.Verdict");
			assert.ok(dispatches.some((d) => d.step === "shakedown-code" && d.attempt === 0));
			const reviewUsage = readEventLog({ root: worktree, cycleLogPath: null }).events.find((event) => event.type === "pelaggio.provider-usage" && "step" in event && event.step === "pr-verify");
			assert.ok(reviewUsage, "the review-loop Judge seat must reach the shared provider-observation append funnel");
		} finally {
			REVIEW_CONFIG.authoring.enabled = saved.enabled;
			REVIEW_CONFIG.authoring.reviewers = saved.reviewers;
			REVIEW_CONFIG.authoring.judge = saved.judge;
		}
	});

	it("parks a teardown restoration failure even when the author revision rejects", async () => {
		const saved = {
			enabled: REVIEW_CONFIG.authoring.enabled,
			reviewers: REVIEW_CONFIG.authoring.reviewers.map((seat) => ({ ...seat })),
			judge: { ...REVIEW_CONFIG.authoring.judge },
		};
		REVIEW_CONFIG.authoring.enabled = "local";
		REVIEW_CONFIG.authoring.reviewers = [
			{ id: "claude", provider: "claude" },
			{ id: "grok", provider: "grok" },
		];
		REVIEW_CONFIG.authoring.judge = { id: "judge", provider: "claude" };

		const worktree = makeTempGitRepo();
		writeFileSync(join(worktree, "seed.txt"), "seed");
		execSync("git add -A && git commit -q -m seed", { cwd: worktree });
		const parkSignal = makeParkSignal();
		const findings = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "fixable defect", findings: [{ severity: "must-fix", message: "boom", ruleId: "pelaggio/judgment/style" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const judge = `AUTHORING_REVIEW_JUDGE\n${JSON.stringify({ schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "survives", rationale: "revise", ruling: "fixable-blocker" }] })}\nEND_AUTHORING_REVIEW_JUDGE`;
		const { runStep: mockRunStep, calls } = createMockRunStep(
			{
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"pr-review": { ok: true, text: findings, fullText: findings },
				"pr-verify": { ok: true, text: judge, fullText: judge },
			},
			parkSignal,
		);
		const runStep: RunStepFn = async (name, prompt, opts, emit) => {
			if (name === "shakedown-code") throw new Error("author seat rejected");
			return mockRunStep(name, prompt, opts, emit);
		};
		const logs: Array<Record<string, unknown>> = [];

		try {
			const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement" }, parkSignal, baseFlags, {
				runStep,
				mainRepo: worktree,
				listWorktrees: () => [worktree],
				appendLog: (entry) => logs.push(entry),
				runShipBookkeeping: noopBookkeeping,
				prepareAuthoringReviewSeat: (_main, key) => join(tmpdir(), `rejecting-seat-${key.seatId}-p${key.pass}`),
				cleanupAuthoringReviewSeatsForSha: async () => {
					throw new Error("repair lock unavailable");
				},
			});

			assert.equal(result.outcome, "parked");
			assert.equal(result.disposition, "halt-campaign");
			assert.ok(calls.some((call) => call.step === "pr-review"));
			assert.ok(calls.some((call) => call.step === "pr-verify"));
			assert.match(String(logs[0]?.parkReason), /repair lock unavailable/);
		} finally {
			REVIEW_CONFIG.authoring.enabled = saved.enabled;
			REVIEW_CONFIG.authoring.reviewers = saved.reviewers;
			REVIEW_CONFIG.authoring.judge = saved.judge;
		}
	});

	it("a rejecting review loop parks with checkpoint and halt-campaign even when cleanup succeeds", async () => {
		const saved = {
			enabled: REVIEW_CONFIG.authoring.enabled,
			reviewers: REVIEW_CONFIG.authoring.reviewers.map((seat) => ({ ...seat })),
			judge: { ...REVIEW_CONFIG.authoring.judge },
		};
		REVIEW_CONFIG.authoring.enabled = "local";
		REVIEW_CONFIG.authoring.reviewers = [
			{ id: "claude", provider: "claude" },
			{ id: "grok", provider: "grok" },
		];
		REVIEW_CONFIG.authoring.judge = { id: "judge", provider: "claude" };

		const worktree = makeTempGitRepo();
		writeFileSync(join(worktree, "seed.txt"), "seed");
		execSync("git add -A && git commit -q -m seed", { cwd: worktree });
		const parkSignal = makeParkSignal();
		const findings = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "fixable defect", findings: [{ severity: "must-fix", message: "boom", ruleId: "pelaggio/judgment/style" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const judge = `AUTHORING_REVIEW_JUDGE\n${JSON.stringify({ schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "survives", rationale: "revise", ruling: "fixable-blocker" }] })}\nEND_AUTHORING_REVIEW_JUDGE`;
		const { runStep: mockRunStep, calls } = createMockRunStep(
			{
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"pr-review": { ok: true, text: findings, fullText: findings },
				"pr-verify": { ok: true, text: judge, fullText: judge },
			},
			parkSignal,
		);
		const runStep: RunStepFn = async (name, prompt, opts, emit) => {
			if (name === "shakedown-code") {
				// The author seat dirties the claim tree, then its await rejects: the
				// escape must become a checkpointing park, never an unhandled rejection.
				writeFileSync(join(worktree, "author-in-flight.txt"), "unsaved author work");
				throw new Error("author seat rejected");
			}
			return mockRunStep(name, prompt, opts, emit);
		};
		const logs: Array<Record<string, unknown>> = [];

		try {
			const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement" }, parkSignal, baseFlags, {
				runStep,
				mainRepo: worktree,
				listWorktrees: () => [worktree],
				appendLog: (entry) => logs.push(entry),
				runShipBookkeeping: noopBookkeeping,
				prepareAuthoringReviewSeat: (_main, key) => join(tmpdir(), `rejecting-loop-seat-${key.seatId}-p${key.pass}`),
				cleanupAuthoringReviewSeatsForSha: async () => ({ status: "healthy", repaired: [] }),
			});

			assert.equal(result.outcome, "parked");
			assert.equal(result.disposition, "halt-campaign");
			assert.ok(calls.some((call) => call.step === "pr-review"));
			assert.match(String(logs[0]?.parkReason), /adversarial review loop failed: author seat rejected/);
			// The park checkpointed the author's in-flight work instead of dropping it.
			assert.equal(execSync("git status --porcelain", { cwd: worktree }).toString().trim(), "");
			assert.match(execSync("git log --format=%s", { cwd: worktree }).toString(), /wip: pelaggio/);
		} finally {
			REVIEW_CONFIG.authoring.enabled = saved.enabled;
			REVIEW_CONFIG.authoring.reviewers = saved.reviewers;
			REVIEW_CONFIG.authoring.judge = saved.judge;
		}
	});

	it("fails before seat setup when authoring seating is ineligible", async () => {
		const saved = {
			enabled: REVIEW_CONFIG.authoring.enabled,
			reviewers: REVIEW_CONFIG.authoring.reviewers.map((s) => ({ ...s })),
		};
		// cycle=1 + implement-only rotates implement author to codex (pool [claude,codex,grok]).
		// A sole codex reviewer is then excluded → seating fails before any seat step runs.
		REVIEW_CONFIG.authoring.enabled = "local";
		REVIEW_CONFIG.authoring.reviewers = [{ id: "only-codex", provider: "codex" }];

		const worktree = makeTempGitRepo();
		writeFileSync(join(worktree, "seed.txt"), "seed");
		execSync("git add -A && git commit -q -m seed", { cwd: worktree });
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"pr-review": { ok: true, text: cleanFindings, fullText: cleanFindings },
				"pr-verify": { ok: true, text: cleanJudge, fullText: cleanJudge },
			},
			parkSignal,
		);

		try {
			const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement" }, parkSignal, baseFlags, {
				runStep,
				mainRepo: worktree,
				listWorktrees: () => [worktree],
				appendLog: () => {},
				runShipBookkeeping: noopBookkeeping,
			});

			assert.notEqual(result.outcome, "completed");
			assert.match(failedError(result) ?? "", /shakedown-code assignment failed/);
			assert.ok(!calls.some((c) => c.step === "pr-review"), "must not invoke review seats when seating fails");
			assert.ok(!calls.some((c) => c.step === "pr-verify"), "must not invoke judge when seating fails");
		} finally {
			REVIEW_CONFIG.authoring.enabled = saved.enabled;
			REVIEW_CONFIG.authoring.reviewers = saved.reviewers;
		}
	});

	it("refuses local subscription mode in CI/single-shot execution before starting review seats", async () => {
		const saved = REVIEW_CONFIG.authoring.enabled;
		REVIEW_CONFIG.authoring.enabled = "local";
		const worktree = makeTempGitRepo();
		writeFileSync(join(worktree, "seed.txt"), "seed");
		execSync("git add -A && git commit -q -m seed", { cwd: worktree });
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep({ implement: { ok: true, writes: { "impl.txt": "x" } } }, parkSignal);

		try {
			const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", noWorktree: true }, parkSignal, baseFlags, {
				runStep,
				mainRepo: worktree,
				listWorktrees: () => [worktree],
				appendLog: () => {},
				runShipBookkeeping: noopBookkeeping,
			});

			assert.notEqual(result.outcome, "completed");
			assert.match(failedError(result) ?? "", /execution context failed.*enabled=local.*CI\/single-shot/);
			assert.ok(!calls.some((call) => call.step === "pr-review" || call.step === "pr-verify"));
		} finally {
			REVIEW_CONFIG.authoring.enabled = saved;
		}
	});

	it("refuses local mode on orchestrator-computed unattended signals (daemon/multi-cycle)", async () => {
		const saved = REVIEW_CONFIG.authoring.enabled;
		REVIEW_CONFIG.authoring.enabled = "local";
		const worktree = makeTempGitRepo();
		writeFileSync(join(worktree, "seed.txt"), "seed");
		execSync("git add -A && git commit -q -m seed", { cwd: worktree });
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep({ implement: { ok: true, writes: { "impl.txt": "x" } } }, parkSignal);

		try {
			// Worktree-backed run (noWorktree unset): the broadened gate must refuse on the
			// orchestrator-threaded signal set, not only on CI/single-shot.
			const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", unattendedSignals: ["daemon-spawned (PELAGGIO_SUPERVISED_RUN=1)", "multi-cycle campaign (--cycles/--parallel > 1)"] }, parkSignal, baseFlags, {
				runStep,
				mainRepo: worktree,
				listWorktrees: () => [worktree],
				appendLog: () => {},
				runShipBookkeeping: noopBookkeeping,
			});

			assert.notEqual(result.outcome, "completed");
			assert.match(failedError(result) ?? "", /execution context failed.*enabled=local.*daemon-spawned.*multi-cycle/);
			assert.ok(!calls.some((call) => call.step === "pr-review" || call.step === "pr-verify"));
		} finally {
			REVIEW_CONFIG.authoring.enabled = saved;
		}
	});

	it("attested piped single-cycle run allows local mode and logs the TTY-signal suppression (#276)", async () => {
		const saved = {
			enabled: REVIEW_CONFIG.authoring.enabled,
			reviewers: REVIEW_CONFIG.authoring.reviewers.map((s) => ({ ...s })),
			judge: { ...REVIEW_CONFIG.authoring.judge },
		};
		REVIEW_CONFIG.authoring.enabled = "local";
		REVIEW_CONFIG.authoring.reviewers = [
			{ id: "codex", provider: "codex" },
			{ id: "grok", provider: "grok" },
		];
		REVIEW_CONFIG.authoring.judge = { id: "judge", provider: "claude" };

		const worktree = makeTempGitRepo();
		writeFileSync(join(worktree, "seed.txt"), "seed");
		execSync("git add -A && git commit -q -m seed", { cwd: worktree });
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"pr-review": { ok: true, text: cleanFindings, fullText: cleanFindings },
				"pr-verify": { ok: true, text: cleanJudge, fullText: cleanJudge },
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

		const messages: string[] = [];
		mock.method(console, "log", (message: string) => messages.push(String(message)));
		try {
			// Orchestrator-computed evidence for an operator-attested piped run: the TTY signal
			// was suppressed by PELAGGIO_OPERATOR_ATTENDED=1 and no positive signal remains.
			const appended: Array<Record<string, unknown>> = [];
			const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement", unattendedSignals: [], unattendedSignalSuppressions: [OPERATOR_ATTESTED_TTY_SUPPRESSION] }, parkSignal, baseFlags, {
				runStep,
				mainRepo: worktree,
				listWorktrees: () => [worktree],
				appendLog: (entry) => appended.push(entry),
				runShipBookkeeping: noopBookkeeping,
			});

			assert.equal(result.outcome, "completed", `expected completed cycle; error=${failedError(result)}`);
			assert.ok(
				calls.some((c) => c.step === "pr-review"),
				"expected the review loop to run under the attested local gate",
			);
			const suppressionLines = messages.filter((message) => message.includes(OPERATOR_ATTESTED_TTY_SUPPRESSION));
			assert.equal(suppressionLines.length, 1, "the attestation suppression must be logged exactly once at resolution time");
			// The security contract: an attested headless run is reconstructible from the
			// APPENDED cycle record, not just console output (#276 must-fix).
			assert.equal(appended.length, 1, "expected exactly one appended cycle record");
			const provenance = appended[0]?.provenance as { unattendedSignalSuppressions?: string[] } | undefined;
			assert.deepEqual(provenance?.unattendedSignalSuppressions, [OPERATOR_ATTESTED_TTY_SUPPRESSION], "the attestation suppression must be persisted in the appended cycle provenance");
		} finally {
			mock.restoreAll();
			mock.method(console, "log", () => {});
			mock.method(console, "error", () => {});
			REVIEW_CONFIG.authoring.enabled = saved.enabled;
			REVIEW_CONFIG.authoring.reviewers = saved.reviewers;
			REVIEW_CONFIG.authoring.judge = saved.judge;
		}
	});

	it("attested run still refuses local mode when a non-TTY signal remains (attestation is not an override)", async () => {
		const saved = REVIEW_CONFIG.authoring.enabled;
		REVIEW_CONFIG.authoring.enabled = "local";
		const worktree = makeTempGitRepo();
		writeFileSync(join(worktree, "seed.txt"), "seed");
		execSync("git add -A && git commit -q -m seed", { cwd: worktree });
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep({ implement: { ok: true, writes: { "impl.txt": "x" } } }, parkSignal);

		try {
			const appended: Array<Record<string, unknown>> = [];
			const result = await runPipeline(
				{
					...baseOpts(worktree),
					startFrom: "implement",
					unattendedSignals: ["multi-cycle campaign (--cycles/--parallel > 1)"],
					unattendedSignalSuppressions: [OPERATOR_ATTESTED_TTY_SUPPRESSION],
				},
				parkSignal,
				baseFlags,
				{
					runStep,
					mainRepo: worktree,
					listWorktrees: () => [worktree],
					appendLog: (entry) => appended.push(entry),
					runShipBookkeeping: noopBookkeeping,
				},
			);

			assert.notEqual(result.outcome, "completed");
			assert.match(failedError(result) ?? "", /execution context failed.*enabled=local.*multi-cycle/);
			assert.match(failedError(result) ?? "", /suppressed by PELAGGIO_OPERATOR_ATTENDED attestation/);
			assert.ok(!calls.some((call) => call.step === "pr-review" || call.step === "pr-verify"));
			// Failure exit paths persist the suppression too — reconstruction must not
			// depend on the cycle succeeding (#276 must-fix).
			assert.equal(appended.length, 1, "expected exactly one appended cycle record");
			const provenance = appended[0]?.provenance as { unattendedSignalSuppressions?: string[] } | undefined;
			assert.deepEqual(provenance?.unattendedSignalSuppressions, [OPERATOR_ATTESTED_TTY_SUPPRESSION], "the suppression must be persisted on the failed cycle's appended record");
		} finally {
			REVIEW_CONFIG.authoring.enabled = saved;
		}
	});

	it("does not emit review effects when authoring review is disabled", async () => {
		// Hermetic setup already pins authoring off; assert the ordinary path never writes attempt 0.
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const manifests: Array<{ attempt: number; step: string }> = [];
		const { runStep } = createMockRunStep(
			{
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

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement" }, parkSignal, baseFlags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: noopBookkeeping,
			writeEffectsManifest: (ctx, effects) => {
				manifests.push({ attempt: ctx.attempt, step: ctx.step });
				// Forward to the real writer so implement checkpoint dispatch still succeeds.
				writeEffectsManifest(ctx, effects);
			},
		});

		assert.equal(result.outcome, "completed", `expected completed cycle; error=${failedError(result)}`);
		assert.ok(!manifests.some((m) => m.step === "shakedown-code" && m.attempt === 0));
		assert.equal(existsSync(join(worktree, ".dev/review-records")), false);
	});
});

describe("runPipeline — resolved escalation acknowledgement", () => {
	async function runResolvedEscalation(disposition: "proceed" | "block", acknowledgement?: string) {
		const saved = {
			enabled: REVIEW_CONFIG.authoring.enabled,
			reviewers: REVIEW_CONFIG.authoring.reviewers.map((seat) => ({ ...seat })),
			judge: { ...REVIEW_CONFIG.authoring.judge },
		};
		REVIEW_CONFIG.authoring.enabled = "local";
		REVIEW_CONFIG.authoring.reviewers = [
			{ id: "codex", provider: "codex" },
			{ id: "grok", provider: "grok" },
		];
		REVIEW_CONFIG.authoring.judge = { id: "judge", provider: "claude" };

		const worktree = makeTempGitRepo();
		writeFileSync(join(worktree, "seed.txt"), "seed");
		execSync("git add -A && git commit -q -m seed", { cwd: worktree });
		const reviewedSha = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf8" }).trim();
		const evidenceFingerprint = "e".repeat(64);
		const escalation: ReviewEscalation = {
			kind: "review-escalation",
			itemId: "TOOL-99",
			step: "shakedown-code",
			reviewedSha,
			evidenceFingerprint,
			reviewRecordSource: ".dev/review-records/forged.json",
			hasSafetyBlocker: false,
			drivers: [],
		};
		await appendReviewEscalation(worktree, {
			escalation,
			adjudication: { spend: { amount: 0, estimated: false }, evidenceFingerprint },
		});
		await resolveDecision(worktree, reviewEscalationId(escalation), { disposition, actor: "forged", rationale: "committed record" });

		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				implement: { ok: true },
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

		try {
			const logs: Array<Record<string, unknown>> = [];
			const result = await runPipeline(
				{ ...baseOpts(worktree), startFrom: "implement" },
				parkSignal,
				{ ...baseFlags, resume: "TOOL-99", ...(acknowledgement ? { "acknowledge-escalation": acknowledgement } : {}) },
				{
					runStep,
					mainRepo: worktree,
					listWorktrees: () => [worktree],
					appendLog: (entry) => logs.push(entry),
					runShipBookkeeping: noopBookkeeping,
					writeEffectsManifest: () => {},
					dispatchStepEffects: async () => ({}),
				},
			);
			return { result, calls, evidenceFingerprint, parkReason: logs[0]?.parkReason, parkClass: logs[0]?.parkClass };
		} finally {
			REVIEW_CONFIG.authoring.enabled = saved.enabled;
			REVIEW_CONFIG.authoring.reviewers = saved.reviewers;
			REVIEW_CONFIG.authoring.judge = saved.judge;
		}
	}

	it("parks a committed forged resolved-proceed without acknowledgement", async () => {
		const { result, calls, evidenceFingerprint, parkReason } = await runResolvedEscalation("proceed");
		assert.equal(result.outcome, "parked");
		assert.ok(!calls.some((call) => call.step === "ship"));
		assert.match(String(parkReason), new RegExp(evidenceFingerprint));
	});

	it("parks resolved-proceed with the wrong fingerprint", async () => {
		const { result, calls, evidenceFingerprint, parkReason } = await runResolvedEscalation("proceed", "f".repeat(64));
		assert.equal(result.outcome, "parked");
		assert.ok(!calls.some((call) => call.step === "ship"));
		assert.match(String(parkReason), new RegExp(evidenceFingerprint));
	});

	it("honors resolved-proceed with the matching fingerprint", async () => {
		const fingerprint = "e".repeat(64);
		const { result, calls } = await runResolvedEscalation("proceed", fingerprint);
		assert.equal(result.outcome, "completed", failedError(result));
		assert.ok(calls.some((call) => call.step === "ship"));
	});

	it("never honors resolved-block regardless of acknowledgement", async () => {
		const { result, calls } = await runResolvedEscalation("block", "e".repeat(64));
		assert.equal(result.outcome, "parked");
		assert.ok(!calls.some((call) => call.step === "ship"));
	});
});

describe("runPipeline — authoring review split packet (#580)", () => {
	const passFindings = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "looks good", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
	const judgmentBlock = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "behavior is wrong", findings: [{ severity: "must-fix", message: "boom", ruleId: "pelaggio/judgment/style" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
	const safetyBlock = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "security regression", findings: [{ severity: "must-fix", message: "unsafe", ruleId: "pelaggio/security/secret-leak" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;

	async function runSplit(blockFindings: string) {
		const saved = {
			enabled: REVIEW_CONFIG.authoring.enabled,
			reviewers: REVIEW_CONFIG.authoring.reviewers.map((seat) => ({ ...seat })),
			judge: { ...REVIEW_CONFIG.authoring.judge },
		};
		REVIEW_CONFIG.authoring.enabled = "local";
		// Cycle 1 + startFrom implement rotates the implementation author to codex; both
		// reviewer seats must survive author exclusion so a pass/block split can form.
		REVIEW_CONFIG.authoring.reviewers = [
			{ id: "claude", provider: "claude" },
			{ id: "grok", provider: "grok" },
		];
		REVIEW_CONFIG.authoring.judge = { id: "judge", provider: "claude" };

		const worktree = makeTempGitRepo();
		writeFileSync(join(worktree, "seed.txt"), "seed");
		execSync("git add -A && git commit -q -m seed", { cwd: worktree });
		const parkSignal = makeParkSignal();
		const { runStep } = createMockRunStep(
			{
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"pr-review": [
					{ ok: true, text: passFindings, fullText: passFindings },
					{ ok: true, text: blockFindings, fullText: blockFindings },
				],
			},
			parkSignal,
		);

		let captured: ReviewEscalationWriteInput | undefined;
		const logs: Array<Record<string, unknown>> = [];
		try {
			const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement" }, parkSignal, baseFlags, {
				runStep,
				mainRepo: worktree,
				listWorktrees: () => [worktree],
				appendLog: (entry) => logs.push(entry),
				runShipBookkeeping: noopBookkeeping,
				writeEffectsManifest: () => {},
				dispatchStepEffects: async () => ({}),
				appendReviewEscalation: async (repo, input) => {
					captured = input;
					return appendReviewEscalation(repo, input);
				},
			});
			return { result, captured, worktree, parkReason: logs[0]?.parkReason, parkClass: logs[0]?.parkClass };
		} finally {
			REVIEW_CONFIG.authoring.enabled = saved.enabled;
			REVIEW_CONFIG.authoring.reviewers = saved.reviewers;
			REVIEW_CONFIG.authoring.judge = saved.judge;
		}
	}

	it("records spend, omits a default, and parks with the shared resume command on a judgment-only split", async () => {
		const { result, captured, worktree, parkReason, parkClass } = await runSplit(judgmentBlock);
		assert.equal(result.outcome, "parked");
		assert.equal(parkClass, "review-escalation");
		assert.ok(captured, "expected appendReviewEscalation to run");
		assert.equal(captured.adjudication.spend.amount, result.cost);
		assert.equal(captured.adjudication.spend.estimated, false);
		assert.equal(captured.adjudication.recommendedDefault, undefined);
		assert.equal(captured.escalation.hasSafetyBlocker, false);
		const id = reviewEscalationId(captured.escalation);
		const resume = reviewEscalationCommands(id, captured.escalation).resume;
		assert.equal(String(parkReason).startsWith("adversarial review escalation"), true);
		assert.ok(String(parkReason).includes(resume));
		const packet = readFileSync(join(worktree, "docs/decision-log/TOOL-99.md"), "utf8");
		assert.equal(packet.split("\n").includes(resume), true);
		assert.match(packet, /Choices: proceed or block\. No recommended default on this record\./);
	});

	it("attaches the deterministic block recommendation on a safety-class split", async () => {
		const { result, captured, worktree, parkReason, parkClass } = await runSplit(safetyBlock);
		assert.equal(result.outcome, "parked");
		assert.equal(parkClass, "review-escalation");
		assert.ok(captured);
		assert.equal(captured.adjudication.spend.amount, result.cost);
		assert.equal(captured.escalation.hasSafetyBlocker, true);
		assert.deepEqual(captured.adjudication.recommendedDefault, {
			disposition: "block",
			source: "deterministic-policy",
			rationale: "A safety-class must-fix is on the record; the safety floor cannot be acknowledged through.",
		});
		const id = reviewEscalationId(captured.escalation);
		const resume = reviewEscalationCommands(id, captured.escalation).resume;
		assert.equal(String(parkReason).startsWith("adversarial review escalation"), true);
		assert.ok(String(parkReason).includes(resume));
		const packet = readFileSync(join(worktree, "docs/decision-log/TOOL-99.md"), "utf8");
		assert.equal(packet.split("\n").includes(resume), true);
		assert.match(packet, /Recommended default: `block` \(deterministic-policy\)/);
	});
});

describe("execution receipts (#188)", () => {
	it("threads challenge + realized provider/model into effects dispatch and records descriptors", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const dispatches: Array<{
			challenge: Uint8Array;
			provider: string;
			model: string;
			attempt: number;
			step: string;
		}> = [];
		const challengeSeen: Uint8Array[] = [];
		const roadmap = makeMockRoadmap({
			resolvePlanPath: () => `${worktree}/docs/plans/plan.md`,
			async publishPlan() {},
		});
		const { runStep } = createMockRunStep(
			{
				plan: { ok: true, writes: { "docs/plans/plan.md": "# Plan\nx" } },
			},
			parkSignal,
		);

		await runPipeline(baseOpts(worktree), parkSignal, baseFlags, {
			runStep,
			roadmap,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
			runShipBookkeeping: noopBookkeeping,
			dispatchStepEffects: async (ctx) => {
				dispatches.push({
					challenge: ctx.challenge,
					provider: ctx.provider,
					model: ctx.model,
					attempt: ctx.attempt,
					step: ctx.step,
				});
				challengeSeen.push(ctx.challenge);
				// Simulate a successful receipt descriptor without filesystem side effects.
				return {
					receipt: {
						path: `.dev/execution-receipts/${ctx.runId}/${ctx.step}-${ctx.attempt}.json`,
						sha256: "a".repeat(64),
					},
				};
			},
		});

		assert.ok(dispatches.length >= 1, "expected at least one effects dispatch");
		const planDispatch = dispatches.find((d) => d.step === "plan");
		assert.ok(planDispatch);
		assert.equal(planDispatch.challenge.byteLength, 32);
		// Realized provider is assignment-driven (may rotate across seats); require a known name.
		assert.ok(["claude", "codex", "grok"].includes(planDispatch.provider), `unexpected provider ${planDispatch.provider}`);
		assert.ok(typeof planDispatch.model === "string" && planDispatch.model.length > 0);
		// Same cycle challenge for every dispatch in the run.
		assert.ok(challengeSeen.every((c) => Buffer.from(c).equals(Buffer.from(challengeSeen[0]!))));

		const entry = logs.find((e) => Array.isArray(e.steps));
		assert.ok(entry);
		const provenance = entry!.provenance as {
			challengeDigest?: string;
			executionReceipts?: Array<{ path: string; sha256: string }>;
		};
		assert.ok(provenance?.challengeDigest);
		assert.match(provenance.challengeDigest!, /^[0-9a-f]{64}$/);
		assert.ok(Array.isArray(provenance.executionReceipts));
		assert.ok((provenance.executionReceipts?.length ?? 0) >= 1);

		const steps = entry!.steps as Array<{ name: string; executionReceipt?: { path: string; sha256: string } }>;
		const planStep = steps.find((s) => s.name === "plan");
		assert.ok(planStep?.executionReceipt);
		assert.equal(planStep!.executionReceipt!.sha256, "a".repeat(64));
	});

	it("surfaces receipt_failed as error_effects_manifest with phase dispatch", async () => {
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
				throw new EffectsManifestError("receipt_failed", "receipt write failed");
			},
		});

		assert.notEqual(result.outcome, "completed");
		assert.equal(failedError(result), "plan failed");
		const entry = logs[0];
		assert.ok(entry, "expected a cycle log entry");
		const steps = entry.steps as Array<{
			name: string;
			ok: boolean;
			subtype?: string;
			effectsError?: { code: string; message: string };
		}>;
		const planStep = steps[0];
		assert.ok(planStep, "expected a plan step log");
		assert.equal(planStep.ok, false);
		assert.equal(planStep.subtype, "error_effects_manifest");
		assert.deepEqual(planStep.effectsError, { code: "receipt_failed", message: "receipt write failed" });
	});

	it("uses distinct receipt paths for distinct attempts", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const attempts: number[] = [];
		const paths: string[] = [];
		const { runStep } = createMockRunStep(
			{
				// First implement attempt hits max turns; second succeeds — pipeline retries.
				implement: [
					{ ok: false, subtype: "error_max_turns", text: "out of turns" },
					{ ok: true, writes: { "impl.txt": "x" } },
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

		const result = await runPipeline({ ...baseOpts(worktree), startFrom: "implement" }, parkSignal, baseFlags, {
			runStep,
			mainRepo: worktree,
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: noopBookkeeping,
			dispatchStepEffects: async (ctx) => {
				if (ctx.step === "implement") {
					attempts.push(ctx.attempt);
					paths.push(`.dev/execution-receipts/${ctx.runId}/${ctx.step}-${ctx.attempt}.json`);
				}
				return {
					receipt: {
						path: `.dev/execution-receipts/${ctx.runId}/${ctx.step}-${ctx.attempt}.json`,
						sha256: "b".repeat(64),
					},
				};
			},
		});

		assert.equal(result.outcome, "completed", `expected completed; error=${failedError(result)}`);
		// At least the successful implement attempt dispatches; a failed max-turns attempt does not.
		assert.ok(attempts.includes(2) || attempts.includes(1));
		assert.ok(paths.every((p) => /implement-\d+\.json$/.test(p)));
		if (attempts.length >= 2) {
			assert.notEqual(paths[0], paths[1]);
		}
	});

	it("legacy cycle logs without challengeDigest / executionReceipts still parse", () => {
		// Additive optional fields: a log entry shaped like pre-#188 must remain a valid CycleLogEntry.
		const legacy = {
			ts: "2026-01-01T00:00:00.000Z",
			cycle: 1,
			item: "TOOL-1",
			quick: false,
			steps: [{ name: "plan", model: "m", cost: 0, turns: 1, ok: true }],
			total_cost: 0,
			verdict: null,
			completed: true,
			error: null,
			provenance: {
				runId: "cycle-1",
				durationMs: 10,
				drivers: [{ provider: "claude" as const, model: "m" }],
				git: { branch: "main", worktree: null, mainShaAtStart: null, headSha: null },
				versions: { pelaggio: "0.0.0", node: "v22", drivers: {} },
			},
		};
		assert.equal("challengeDigest" in legacy.provenance, false);
		assert.equal("executionReceipts" in legacy.provenance, false);
		assert.equal(legacy.provenance.runId, "cycle-1");
	});
});

function makeDeliverableRepo(): string {
	const dir = makeTempGitRepo();
	const dependencyNames = ["diff", "tsx", "ulid", "yaml"];
	const packageNodeModules = resolve(dir, "packages", "pelaggio", "node_modules");
	mkdirSync(packageNodeModules, { recursive: true });
	writeFileSync(resolve(dir, "packages", "pelaggio", "package.json"), JSON.stringify({ name: "pelaggio", dependencies: Object.fromEntries(dependencyNames.map((name) => [name, "^1.0.0"])) }));
	writeFileSync(
		resolve(dir, "pnpm-lock.yaml"),
		["lockfileVersion: '9.0'", "importers:", "  packages/pelaggio:", "    dependencies:", ...dependencyNames.flatMap((name) => [`      ${name}:`, "        specifier: ^1.0.0", "        version: 1.0.0"]), ""].join("\n"),
	);
	for (const name of dependencyNames) {
		const target = resolve(dir, "node_modules", ".pnpm", `${name}@1.0.0`, "node_modules", name);
		mkdirSync(target, { recursive: true });
		writeFileSync(resolve(target, "package.json"), JSON.stringify({ name }));
		symlinkSync(relative(packageNodeModules, target), resolve(packageNodeModules, name), "dir");
	}
	writeFileSync(join(dir, "impl.txt"), "x\n");
	execSync("git add impl.txt packages/pelaggio/package.json pnpm-lock.yaml && git commit -q -m impl", { cwd: dir });
	return dir;
}

function passGate(over: Partial<PrReviewGateResult> = {}): PrReviewGateResult {
	return {
		gate: "pass",
		body: "preflight pass",
		cost: 0,
		costEstimated: false,
		turns: 0,
		ok: true,
		subtype: "success",
		agreement: "consensus-pass",
		survivorCount: 0,
		...over,
	};
}

function survivorBlock(over: Partial<PrReviewGateResult> = {}): PrReviewGateResult {
	return {
		gate: "block",
		body: "must-fix: leaked token",
		cost: 0.4,
		costEstimated: false,
		turns: 2,
		ok: true,
		subtype: "success",
		agreement: "consensus-block",
		survivorCount: 1,
		...over,
	};
}

function shipFrom(worktree: string): PipelineOpts {
	return { ...baseOpts(worktree), startFrom: "ship", shipTarget: getShipTarget("pull-request") };
}

describe("runPipeline — PR pre-flight and freshness (#424)", () => {
	it("repairs MAIN after a skipped teardown before the ship-candidate ratchet", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		const order: string[] = [];
		const packageNodeModules = resolve(worktree, "packages", "pelaggio", "node_modules");
		const canonicalTargets = new Map<string, string>();
		for (const name of ["diff", "tsx", "ulid", "yaml"]) {
			const link = resolve(packageNodeModules, name);
			canonicalTargets.set(name, readlinkSync(link));
		}
		const yamlLink = resolve(packageNodeModules, "yaml");
		const crashedSeatTarget = resolve(worktree, ".dev", "authoring-review-seats", "crashed", "node_modules", ".pnpm", "yaml");
		mkdirSync(crashedSeatTarget, { recursive: true });
		rmSync(yamlLink);
		symlinkSync(crashedSeatTarget, yamlLink, "dir");

		const lockPaths: string[] = [];
		const { runStep } = createMockRunStep({ ship: prShipDecision() }, parkSignal);
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			mainRepo: worktree,
			verifyOrRepairAuthoringReviewHostDependencies: async (main) => {
				assert.equal(main, worktree);
				order.push("repair");
				return verifyOrRepairAuthoringReviewHostDependencies(main, async (path, fn) => {
					lockPaths.push(path);
					return fn();
				});
			},
			runTypecheckRatchet: async () => {
				order.push("ratchet");
				assert.equal(readlinkSync(yamlLink), canonicalTargets.get("yaml"), "read-side repair must finish before the ratchet");
				return { ok: true };
			},
			listWorktrees: () => [],
			appendLog: () => {},
			dispatchStepEffects: async () => ({ appendText: "https://example.test/pull/1" }),
		});
		assert.equal(result.outcome, "completed", `expected completed; error=${failedError(result)}`);
		assert.deepEqual(order.slice(0, 2), ["repair", "ratchet"]);
		assert.deepEqual(lockPaths, [resolve(worktree, ".dev", "node-modules-repair.lock")]);
	});

	it("parks before the ship-candidate ratchet when derived store content is missing", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<{ parkReason?: string | null }> = [];
		let ratchetCalls = 0;
		const { runStep, calls } = createMockRunStep({ ship: prShipDecision() }, parkSignal);
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			verifyOrRepairAuthoringReviewHostDependencies: async () => ({ status: "park", reason: "missing-store-content", detail: "yaml target absent", repaired: [] }),
			runTypecheckRatchet: async () => {
				ratchetCalls += 1;
				return { ok: true };
			},
			listWorktrees: () => [],
			appendLog: (entry) => logs.push(entry),
		});

		assert.equal(result.outcome, "parked");
		assert.equal(ratchetCalls, 0);
		assert.match(logs[0]?.parkReason ?? "", /missing-store-content/);
		assert.match(logs[0]?.parkReason ?? "", /resume: pnpm pelaggio --resume TOOL-99/);
		assert.equal(calls.filter((call) => call.step === "ship").length, 0);
	});

	it("up-to-date path runs one cold gate before ship with origin/main pin and no comment callback", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		const sha = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
		const seen: RunPrReviewGateOptions[] = [];
		const { runStep, calls } = createMockRunStep({ ship: prShipDecision() }, parkSignal);
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			runPrReviewGate: async (opts) => {
				seen.push(opts);
				return passGate({ cost: 1.25 });
			},
			listWorktrees: () => [],
			appendLog: () => {},
			dispatchStepEffects: async () => ({ appendText: "https://example.test/pull/1" }),
		});
		assert.equal(result.outcome, "completed");
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.skillArguments, "--preflight");
		assert.equal(seen[0]?.diffBaseRef, "origin/main");
		assert.equal(seen[0]?.diffHeadRef, sha);
		assert.equal(seen[0]?.reviewedSha, sha);
		assert.equal(seen[0]?.itemId, "TOOL-99");
		assert.equal(seen[0]?.pr, "preflight");
		assert.equal(seen[0]?.upsertComment, undefined);
		assert.ok(seen[0]?.policy);
		assert.ok((seen[0]?.reviewDrivers?.length ?? 0) >= 1);
		assert.ok(seen[0]?.verifySettings);
		assert.equal(calls.filter((c) => c.step === "ship").length, 1);
		assert.ok(Math.abs(result.cost - 1.26) < 1e-9, `expected ship 0.01 + review 1.25, got ${result.cost}`);
	});

	it("adds review.cost once while nested discovery/verify steps log separately", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const seats: string[] = [];
		const cleaned: string[] = [];
		const { runStep } = createMockRunStep({ ship: prShipDecision() }, parkSignal);
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			prepareAuthoringReviewSeat: (_main, key) => {
				seats.push(key.seatId);
				return join(tmpdir(), `preflight-seat-${key.seatId}`);
			},
			cleanupAuthoringReviewSeatsForSha: async (_main, sha) => {
				cleaned.push(sha);
				return { status: "healthy", repaired: [] };
			},
			runPrReviewGate: async (opts) => {
				assert.ok(opts.runStep);
				// #424 fix: the gate's diff source is the detached data-only checkout, never the live claim worktree.
				assert.equal(opts.diffCwd, join(tmpdir(), "preflight-seat-preflight-diff"));
				assert.notEqual(opts.diffCwd, worktree);
				await opts.runStep("pr-review", "d1", { cwd: opts.cwd ?? "", profile: "standard", trace: false, parkSignal: opts.parkSignal ?? parkSignal, executionOverride: { provider: "claude" } }, () => {});
				await opts.runStep("pr-review", "d2", { cwd: opts.cwd ?? "", profile: "standard", trace: false, parkSignal: opts.parkSignal ?? parkSignal, executionOverride: { provider: "codex" } }, () => {});
				await opts.runStep("pr-verify", "v", { cwd: opts.cwd ?? "", profile: "standard", trace: false, parkSignal: opts.parkSignal ?? parkSignal, executionOverride: { provider: "grok" } }, () => {});
				return passGate({ cost: 0.9 });
			},
			listWorktrees: () => [],
			appendLog: (entry) => {
				logs.push(entry);
			},
			dispatchStepEffects: async () => ({ appendText: "https://example.test/pull/1" }),
		});
		assert.equal(result.outcome, "completed");
		assert.ok(Math.abs(result.cost - 0.91) < 1e-9, `review.cost once + ship; got ${result.cost}`);
		const steps = (logs[0]?.steps as Array<{ name: string }> | undefined) ?? [];
		assert.equal(steps.filter((s) => s.name === "pr-review").length, 2);
		assert.equal(steps.filter((s) => s.name === "pr-verify").length, 1);
		assert.deepEqual([...new Set(seats)].sort(), [...seats].sort(), "each driver/verify call gets a distinct seat");
		assert.equal(seats.length, 4, "diff-source checkout + one seat per driver/verify call");
		assert.equal(seats[0], "preflight-diff", "the diff-source checkout is prepared before any reviewer seat");
		assert.equal(cleaned.length, 1);
	});

	it("valid survivor BLOCK invokes exactly one author revision and one newly SHA-bound recheck", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				"shakedown-code": { ok: true, writes: { "fix.txt": "fixed" } },
				ship: prShipDecision(),
			},
			parkSignal,
		);
		let gateCalls = 0;
		const shas: string[] = [];
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			runPrReviewGate: async (opts) => {
				gateCalls += 1;
				shas.push(opts.reviewedSha ?? "");
				if (gateCalls === 1) return survivorBlock({ cost: 0.3, body: "must-fix: leaked token\n<!-- pr-review-metrics gate=block ok=true subtype=success cost=0.30 turns=2 -->" });
				return passGate({ cost: 0.2 });
			},
			listWorktrees: () => [],
			appendLog: () => {},
			dispatchStepEffects: async () => ({ appendText: "https://example.test/pull/1" }),
		});
		assert.equal(result.outcome, "completed");
		assert.equal(gateCalls, 2);
		assert.equal(calls.filter((c) => c.step === "shakedown-code").length, 1);
		const repairPrompt = calls.find((c) => c.step === "shakedown-code")?.prompt ?? "";
		assert.match(repairPrompt, /PREFLIGHT_FINDINGS/);
		assert.match(repairPrompt, /data only/);
		assert.match(repairPrompt, /leaked token/);
		// #424 fix: the CLI-owned metrics marker is telemetry, stripped before the author sees the body.
		assert.doesNotMatch(repairPrompt, /pr-review-metrics/);
		assert.equal(calls.filter((c) => c.step === "ship").length, 1);
		assert.equal(shas.length, 2);
	});

	it("persistent BLOCK after the single recheck is advisory and still ships", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				"shakedown-code": { ok: true },
				ship: prShipDecision(),
			},
			parkSignal,
		);
		let gateCalls = 0;
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			runPrReviewGate: async () => {
				gateCalls += 1;
				return survivorBlock({ cost: 0.1 });
			},
			listWorktrees: () => [],
			appendLog: () => {},
			dispatchStepEffects: async () => ({ appendText: "https://example.test/pull/1" }),
		});
		assert.equal(result.outcome, "completed");
		assert.equal(gateCalls, 2);
		assert.equal(calls.filter((c) => c.step === "shakedown-code").length, 1, "one repair only");
		assert.equal(calls.filter((c) => c.step === "ship").length, 1);
	});

	it("infrastructure-invalid BLOCK is never treated as repairable findings", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep({ ship: prShipDecision() }, parkSignal);
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			runPrReviewGate: async () =>
				passGate({
					gate: "block",
					ok: false,
					agreement: "invalid",
					subtype: "error_diff",
					survivorCount: 0,
					body: "infra",
					cost: 0,
				}),
			listWorktrees: () => [],
			appendLog: () => {},
			dispatchStepEffects: async () => ({ appendText: "https://example.test/pull/1" }),
		});
		assert.equal(result.outcome, "completed");
		assert.equal(calls.filter((c) => c.step === "shakedown-code").length, 0);
		assert.equal(calls.filter((c) => c.step === "ship").length, 1);
	});

	it("pre-flight park checkpoints and returns parked before ship", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep({ ship: prShipDecision() }, parkSignal);
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			runPrReviewGate: async (opts) => {
				const signal = opts.parkSignal ?? parkSignal;
				signal.parked = true;
				signal.limitType = "rate_limit";
				signal.resetsAt = Date.now() + 60_000;
				return { gate: "park", body: "", cost: 0.2, costEstimated: false, turns: 0, ok: false, subtype: "error_rate_limit", park: { resetsAt: signal.resetsAt, limitType: "rate_limit" } };
			},
			listWorktrees: () => [],
			appendLog: () => {},
		});
		assert.notEqual(result.outcome, "completed");
		assert.equal(result.outcome, "parked");
		assert.equal(calls.filter((c) => c.step === "ship").length, 0);
	});

	it("seat prepare failure is diagnosed without reviewing the mutable artifact checkout and still cleans the SHA", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		const cleaned: string[] = [];
		let gateCalls = 0;
		const { runStep, calls } = createMockRunStep({ ship: prShipDecision() }, parkSignal);
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			prepareAuthoringReviewSeat: () => {
				throw new Error("seat boom");
			},
			cleanupAuthoringReviewSeatsForSha: async (_main, sha) => {
				cleaned.push(sha);
				return { status: "healthy", repaired: [] };
			},
			runPrReviewGate: async () => {
				gateCalls += 1;
				return passGate();
			},
			listWorktrees: () => [],
			appendLog: () => {},
			dispatchStepEffects: async () => ({ appendText: "https://example.test/pull/1" }),
		});
		// #424 fix: the diff-source checkout is prepared BEFORE the gate; its failure is an
		// advisory infra BLOCK that never falls back to reviewing the live claim worktree.
		assert.equal(result.outcome, "completed", "advisory: the required PR gate still reviews the PR");
		assert.equal(gateCalls, 0, "no gate run without a detached diff source");
		assert.equal(calls.filter((c) => c.step === "pr-review").length, 0, "must not run review against the artifact checkout");
		assert.equal(calls.filter((c) => c.step === "ship").length, 1);
		assert.equal(cleaned.length, 1);
	});

	it("pre-flight reviewer seats carry no claim-worktree write authorization (detached, read-only)", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		const seats: Array<{ name: string; workspaceAccess?: "read-only"; denial?: { ownWorktree?: string; registeredWorktrees: readonly string[] } }> = [];
		const { runStep } = createMockRunStep({ ship: prShipDecision() }, parkSignal);
		const wrapped: RunStepFn = async (name, prompt, opts, emit) => {
			if (name === "pr-review" || name === "pr-verify") seats.push({ name, workspaceAccess: opts.workspaceAccess, denial: opts.foreignRootDenial });
			return runStep(name, prompt, opts, emit);
		};
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep: wrapped,
			...defaultPrPreflightStubs(),
			runPrReviewGate: async (opts) => {
				for (const name of ["pr-review", "pr-verify"] as const) {
					await opts.runStep!(name, "inspect", { cwd: opts.cwd ?? "", profile: "standard", trace: false, parkSignal: opts.parkSignal ?? parkSignal, workspaceAccess: "read-only", executionOverride: { provider: "codex" } }, () => {});
				}
				return passGate();
			},
			listWorktrees: () => [worktree],
			appendLog: () => {},
			dispatchStepEffects: async () => ({ appendText: "https://example.test/pull/1" }),
		});
		assert.equal(result.outcome, "completed", `expected completed; error=${failedError(result)}`);
		assert.equal(seats.length, 2);
		for (const seat of seats) {
			assert.equal(seat.workspaceAccess, "read-only", `${seat.name} pre-flight seat must preserve harness access intent`);
			assert.ok(seat.denial, "seat steps still install foreign-root denial");
		}
		// #424 fix: the live claim worktree is a DENIED foreign root for reviewer seats, not an
		// ownWorktree write grant (only its registration keeps it in the denied set).
		assert.equal(seats[0]?.denial?.ownWorktree, undefined);
		assert.ok(seats[0]?.denial?.registeredWorktrees.includes(worktree));
	});

	it("a clean commit into the live claim worktree during pre-flight fails the cycle before ship", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep({ ship: prShipDecision() }, parkSignal);
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			runPrReviewGate: async () => {
				// Porcelain-invisible mutation: a clean commit leaves `git status` empty, so only
				// the pre/post HEAD compare can catch it.
				execSync("git commit -q --allow-empty -m sneaky-seat-commit", { cwd: worktree });
				return passGate();
			},
			listWorktrees: () => [],
			appendLog: () => {},
			dispatchStepEffects: async () => ({ appendText: "https://example.test/pull/1" }),
		});
		assert.notEqual(result.outcome, "completed");
		assert.match(failedError(result) ?? "", /HEAD moved during pre-flight/);
		assert.equal(calls.filter((c) => c.step === "ship").length, 0, "a mutated tree must never ship");
	});

	it("a cleanup restoration failure parks, preserves guidance, and halts the campaign", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<{ parkReason?: string | null }> = [];
		const { runStep, calls } = createMockRunStep({ ship: prShipDecision() }, parkSignal);
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			cleanupAuthoringReviewSeatsForSha: async () => {
				throw new Error("repair lock unavailable");
			},
			runPrReviewGate: async () => passGate(),
			listWorktrees: () => [],
			appendLog: (entry) => logs.push(entry),
			dispatchStepEffects: async () => ({ appendText: "https://example.test/pull/1" }),
		});
		assert.equal(result.outcome, "parked");
		assert.equal(result.disposition, "halt-campaign");
		assert.match(logs[0]?.parkReason ?? "", /preserved state: claim worktree/);
		assert.match(logs[0]?.parkReason ?? "", /resume: pnpm pelaggio --resume TOOL-99/);
		assert.equal(calls.filter((c) => c.step === "ship").length, 0);
	});

	it("the mutation guard outranks a cleanup restoration park and never checkpoints reviewer-authored state", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<{ parkReason?: string | null }> = [];
		const { runStep, calls } = createMockRunStep({ ship: prShipDecision() }, parkSignal);
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			cleanupAuthoringReviewSeatsForSha: async () => {
				throw new Error("repair lock unavailable");
			},
			runPrReviewGate: async () => {
				// A mutated claim tree AND a parking cleanup on the same exit: the
				// deterministic mutation guard must fire first, before the park path's
				// checkpoint can commit reviewer-authored state.
				execSync("git commit -q --allow-empty -m sneaky-seat-commit", { cwd: worktree });
				writeFileSync(join(worktree, "reviewer-dropping.txt"), "unauthorized");
				return passGate();
			},
			listWorktrees: () => [],
			appendLog: (entry) => logs.push(entry),
			dispatchStepEffects: async () => ({ appendText: "https://example.test/pull/1" }),
		});
		assert.equal(result.outcome, "failed");
		assert.match(failedError(result) ?? "", /HEAD moved during pre-flight/);
		assert.match(failedError(result) ?? "", /cleanup restoration also parked/);
		assert.equal(calls.filter((c) => c.step === "ship").length, 0, "a mutated tree must never ship");
		// No park checkpoint ran: the reviewer's commit is still HEAD and its dirty
		// write is still uncommitted, not folded into a checkpoint commit.
		assert.equal(execSync("git log -1 --format=%s", { cwd: worktree }).toString().trim(), "sneaky-seat-commit");
		assert.match(execSync("git status --porcelain", { cwd: worktree }).toString(), /reviewer-dropping\.txt/);
	});

	it("a type-breaking pre-flight author revision fails the deterministic backstop and never opens the PR", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		let typecheckCalls = 0;
		let gateCalls = 0;
		const { runStep, calls } = createMockRunStep({ "shakedown-code": { ok: true, writes: { "fix.txt": "broken types" } }, ship: prShipDecision() }, parkSignal);
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			runTypecheckRatchet: async () => {
				typecheckCalls += 1;
				// Call 1: the up-to-date freshness gate (pre-revision head) — green.
				// Call 2: the post-revision backstop — the revision broke the types.
				return typecheckCalls === 1 ? { ok: true } : { ok: false, detail: "TS2551" };
			},
			runPrReviewGate: async () => {
				gateCalls += 1;
				return survivorBlock();
			},
			listWorktrees: () => [],
			appendLog: () => {},
		});
		assert.notEqual(result.outcome, "completed");
		assert.match(failedError(result) ?? "", /typecheck:ratchet failed after pre-flight revision/);
		assert.match(failedError(result) ?? "", /TS2551/);
		assert.equal(typecheckCalls, 2);
		assert.equal(gateCalls, 1, "the recheck's review budget is never spent on a type-broken tree");
		assert.equal(calls.filter((c) => c.step === "shakedown-code").length, 1);
		assert.equal(calls.filter((c) => c.step === "ship").length, 0);
	});

	it("soft-skips when the target repo has no typecheck:ratchet script, keeps a present script as a hard gate (#424 review)", async () => {
		// Absent script → skip with detail (consumer repos don't ship ci/typecheck-ratchet.ts).
		const noScript = mkdtempSync(join(tmpdir(), "pelaggio-ratchet-"));
		writeFileSync(join(noScript, "package.json"), JSON.stringify({ name: "consumer", scripts: { test: "true" } }));
		const skippedAbsent = await defaultTypecheckRatchet(noScript);
		assert.equal(skippedAbsent.ok, true);
		assert.equal(skippedAbsent.skipped, true);
		assert.match(skippedAbsent.detail ?? "", /no typecheck:ratchet script/);

		// Missing or unparseable package.json → also a soft skip, with the reason in the detail.
		const noManifest = await defaultTypecheckRatchet(mkdtempSync(join(tmpdir(), "pelaggio-ratchet-")));
		assert.equal(noManifest.ok, true);
		assert.equal(noManifest.skipped, true);
		const badManifestDir = mkdtempSync(join(tmpdir(), "pelaggio-ratchet-"));
		writeFileSync(join(badManifestDir, "package.json"), "{nope");
		const badManifest = await defaultTypecheckRatchet(badManifestDir);
		assert.equal(badManifest.ok, true);
		assert.equal(badManifest.skipped, true);

		// Present script → its failure stays a hard gate (never `skipped`), detail captured.
		const gated = mkdtempSync(join(tmpdir(), "pelaggio-ratchet-"));
		writeFileSync(join(gated, "package.json"), JSON.stringify({ name: "x", scripts: { "typecheck:ratchet": "node -e \"console.error('TSFAIL');process.exit(3)\"" } }));
		const red = await defaultTypecheckRatchet(gated);
		assert.equal(red.ok, false);
		assert.equal(red.skipped, undefined);
		assert.match(red.detail ?? "", /TSFAIL/);

		writeFileSync(join(gated, "package.json"), JSON.stringify({ name: "x", scripts: { "typecheck:ratchet": 'node -e "process.exit(0)"' } }));
		const green = await defaultTypecheckRatchet(gated);
		assert.equal(green.ok, true);
		assert.equal(green.skipped, undefined);

		// #424 gate review: a GREEN ratchet with output beyond node's 1 MiB default maxBuffer
		// must not crash the gate — oversized output is bounded, not fatal.
		writeFileSync(join(gated, "package.json"), JSON.stringify({ name: "x", scripts: { "typecheck:ratchet": "node -e \"process.stdout.write('x'.repeat(2 * 1024 * 1024))\"" } }));
		const chatty = await defaultTypecheckRatchet(gated);
		assert.equal(chatty.ok, true, `oversized green output must pass; detail=${chatty.detail}`);

		// #424 gate review: pnpm missing from PATH is an environment gap → soft skip, like a
		// missing script — never a red gate.
		const emptyPath = mkdtempSync(join(tmpdir(), "pelaggio-ratchet-empty-path-"));
		const savedPath = process.env.PATH;
		process.env.PATH = emptyPath;
		try {
			const noPnpm = await defaultTypecheckRatchet(gated);
			assert.equal(noPnpm.ok, true);
			assert.equal(noPnpm.skipped, true);
			assert.match(noPnpm.detail ?? "", /pnpm not found/);
		} finally {
			process.env.PATH = savedPath;
		}
	});

	it("cleans prepared seats when the gate throws", async () => {
		const worktree = makeDeliverableRepo();
		const parkSignal = makeParkSignal();
		const cleaned: string[] = [];
		const { runStep, calls } = createMockRunStep({ ship: prShipDecision() }, parkSignal);
		const result = await runPipeline(shipFrom(worktree), parkSignal, baseFlags, {
			runStep,
			...defaultPrPreflightStubs(),
			cleanupAuthoringReviewSeatsForSha: async (_main, sha) => {
				cleaned.push(sha);
				return { status: "healthy", repaired: [] };
			},
			runPrReviewGate: async () => {
				throw new Error("gate exploded");
			},
			listWorktrees: () => [],
			appendLog: () => {},
			dispatchStepEffects: async () => ({ appendText: "https://example.test/pull/1" }),
		});
		assert.equal(result.outcome, "completed", "thrown pre-flight is advisory");
		assert.equal(calls.filter((c) => c.step === "ship").length, 1);
		assert.equal(cleaned.length, 1);
	});
});

describe("runPipeline — durable authoring record root (#788)", () => {
	it("preserves clean and split records and a committed decision source after deleting real claim worktrees", async () => {
		const saved = { enabled: REVIEW_CONFIG.authoring.enabled, reviewers: REVIEW_CONFIG.authoring.reviewers, judge: REVIEW_CONFIG.authoring.judge };
		REVIEW_CONFIG.authoring.enabled = "local";
		REVIEW_CONFIG.authoring.reviewers = [
			{ id: "claude", provider: "claude" },
			{ id: "grok", provider: "grok" },
		];
		REVIEW_CONFIG.authoring.judge = { id: "judge", provider: "claude" };
		const { parent, repo } = makeTempRepoWithParent();
		const retained: Array<{ path: string; bytes: string }> = [];
		const clean = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "Actual clean review", findings: [] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const blocker = `AUTHORING_REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 3, summary: "Judgment split", findings: [{ severity: "must-fix", message: "Style regression", ruleId: "pelaggio/judgment/style" }] })}\nEND_AUTHORING_REVIEW_FINDINGS`;
		const judge = `AUTHORING_REVIEW_JUDGE\n${JSON.stringify({ schemaVersion: 1, decisions: [] })}\nEND_AUTHORING_REVIEW_JUDGE`;
		try {
			for (const [itemId, split] of [
				["TOOL-99", false],
				["TOOL-98", true],
			] as const) {
				const worktree = join(parent, `${WORKTREE_PREFIX}${itemId.toLowerCase()}`);
				const branch = `feat/${itemId.toLowerCase()}`;
				execFileSync("git", ["worktree", "add", "-q", "-b", branch, worktree], { cwd: repo });
				const signal = makeParkSignal();
				const { runStep } = createMockRunStep(
					{
						implement: { ok: true, writes: { [`impl-${itemId}.txt`]: "implemented" } },
						"pr-review": split
							? [
									{ ok: true, text: clean, fullText: clean },
									{ ok: true, text: blocker, fullText: blocker },
								]
							: { ok: true, text: clean, fullText: clean },
						"pr-verify": { ok: true, text: judge, fullText: judge },
						ship: {
							ok: true,
							text: `ship-merged: ${itemId}`,
							sideEffect: () => {
								execFileSync("git", ["merge", "-q", "--no-ff", branch], { cwd: repo });
							},
						},
					},
					signal,
				);
				let captured: ReviewEscalationWriteInput | undefined;
				const result = await runPipeline({ ...baseOpts(worktree), itemId, startFrom: "implement" }, signal, baseFlags, {
					runStep,
					mainRepo: split ? worktree : repo,
					listWorktrees: () => [repo, worktree],
					appendLog: () => {},
					runShipBookkeeping: noopBookkeeping,
					writeEffectsManifest,
					dispatchStepEffects,
					appendReviewEscalation: async (root, input) => {
						captured = input;
						return appendReviewEscalation(root, input);
					},
				});
				assert.equal(result.outcome, split ? "parked" : "completed", failedError(result));
				const records = [repo, worktree]
					.flatMap((root) => {
						const dir = join(root, ".dev/review-records");
						return existsSync(dir) ? readdirSync(dir).map((file) => join(dir, file)) : [];
					})
					.map((path) => ({ path, bytes: readFileSync(path, "utf8") }))
					.filter(({ bytes }) => (JSON.parse(bytes) as ReviewRecord).itemId === itemId);
				assert.equal(records.length, 1);
				const [emitted] = records;
				assert.ok(emitted);
				const record = validateReviewRecord(JSON.parse(emitted.bytes) as ReviewRecord);
				const source = `.dev/review-records/${record.runId}.json`;
				if (split) {
					assert.ok(captured);
					const decisionPath = `docs/decision-log/${itemId}.md`;
					assert.ok(readFileSync(join(worktree, decisionPath), "utf8").includes(source));
					if (execFileSync("git", ["status", "--porcelain", decisionPath], { cwd: worktree, encoding: "utf8" }).trim()) {
						execFileSync("git", ["add", decisionPath], { cwd: worktree });
						execFileSync("git", ["commit", "-qm", "preserve decision"], { cwd: worktree });
					}
					execFileSync("git", ["merge", "--ff-only", branch], { cwd: repo });
				}
				execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: repo });
				assert.equal(existsSync(worktree), false);
				assert.equal(readFileSync(join(repo, source), "utf8"), emitted.bytes, "record must survive removal of its originating worktree");
				if (captured) {
					const lookup = lookupReviewEscalation(repo, itemId, captured.escalation.reviewedSha);
					assert.equal(lookup.state, "active");
					assert.ok(readFileSync(join(repo, `docs/decision-log/${itemId}.md`), "utf8").includes(source));
				}
				retained.push({ path: join(repo, source), bytes: emitted.bytes });
			}
			const [first, second] = retained;
			assert.ok(first && second);
			assert.notEqual(first.path, second.path);
			for (const record of retained) assert.equal(readFileSync(record.path, "utf8"), record.bytes);
		} finally {
			REVIEW_CONFIG.authoring.enabled = saved.enabled;
			REVIEW_CONFIG.authoring.reviewers = saved.reviewers;
			REVIEW_CONFIG.authoring.judge = saved.judge;
			rmSync(parent, { recursive: true, force: true });
		}
	});
});
