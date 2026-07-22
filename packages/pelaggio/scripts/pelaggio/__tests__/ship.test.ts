import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_SHIP_TARGET, loadConfig } from "../config.js";
import { type Effect, EffectsManifestError } from "../effects.js";
import { expandSkill } from "../helpers.js";
import { remotePushWarning, runPipeline } from "../pipeline.js";
import { shipBodyFile } from "../ship/decision.js";
import type { ShipBookkeepingCtx, ShipBookkeepingResult } from "../ship/index.js";
import { getShipTarget, isAutonomousRemotePush, isShipTargetName, SHIP_TARGET_NAMES } from "../ship/index.js";
import { stripAnsi } from "../tui.js";
import type { Flags, PipelineOpts, ShipTargetName, StepResult } from "../types.js";
import { allCommitMessages, createMockRunStep, makeLiveStatus, makeParkSignal, makeTempGitRepo, makeTempRepoWithParent, setupHermeticPipelineEnv, teardownHermeticPipelineEnv } from "./mocks.js";

/** PR-mode ship fixture: body via fixed file path (inline prBody is no longer accepted). */
function prShipDecision(
	target: "pull-request" | "auto-merge-pr",
	itemId = "TOOL-99",
	body = "Body",
): {
	ok: true;
	writes: Record<string, string>;
	text: string;
	cost?: number;
} {
	const file = shipBodyFile(itemId);
	return {
		ok: true,
		writes: { [file]: body },
		text: `SHIP_DECISION\n{"target":"${target}","headBranch":"feat/tool-99","prTitle":"Ship ${itemId}","prBodyFile":"${file}"}\nEND_SHIP_DECISION`,
	};
}

// ship.test.ts drives the real runPipeline through shakedown → ship, so it needs the
// same hermetic env as pipeline.test.ts (provider availability + authoring off) or the
// reviewer-not-author selection fails closed on a claude-only CI host (#304).
before(setupHermeticPipelineEnv);
after(teardownHermeticPipelineEnv);

// A real mainRepo + sibling worktree on `feat/tool-99`, mirroring production layout.
// Direct-push integration tests MUST inject this as `mainRepo` — the pipeline's
// pre-ship recover guard commits to mainRepo, and defaulting to the real REPO
// would mutate the working tree.
function setupShipRepo(): { repo: string; worktree: string; mergeIntoMain: () => void } {
	const { parent, repo } = makeTempRepoWithParent();
	const worktree = join(parent, "wt-tool-99");
	execSync(`git worktree add -q -b feat/tool-99 ${JSON.stringify(worktree)} main`, { cwd: repo });
	// Feature branch gets a commit (the mock implement writes impl.txt); merging it
	// advances main, which is what `verifyShipLanded` keys on.
	const mergeIntoMain = (): void => {
		execSync("git merge feat/tool-99 --no-edit -q", { cwd: repo });
	};
	return { repo, worktree, mergeIntoMain };
}

function makeBkSpy(over: Partial<ShipBookkeepingResult> = {}): { fn: NonNullable<Parameters<typeof runPipeline>[3]["runShipBookkeeping"]>; calls: ShipBookkeepingCtx[] } {
	const calls: ShipBookkeepingCtx[] = [];
	const fn = async (ctx: ShipBookkeepingCtx): Promise<ShipBookkeepingResult> => {
		calls.push(ctx);
		return { recovered: false, markedDone: true, archived: true, pushed: true, cleanedUp: true, warnings: [], ok: true, ...over };
	};
	return { fn, calls };
}

const PR_URL = "https://github.com/acme/widget/pull/42";

function makeStepResult(over: Partial<StepResult> = {}): StepResult {
	return { ok: true, subtype: "success", text: "", fullText: "", cost: 0, turns: 0, ...over };
}

const baseFlags: Flags = {
	cycles: "1",
	parallel: "1",
	verbose: false,
	trace: false,
	budget: "10",
	"max-wait": "6h",
	"dry-run": false,
};

function baseOpts(worktree: string, name: ShipTargetName): PipelineOpts {
	return {
		itemId: "TOOL-99",
		worktree,
		cycle: 1,
		verbose: false,
		shipTarget: getShipTarget(name),
		dryRun: false,
		liveStatus: makeLiveStatus(),
	};
}

// ── Factory ───────────────────────────────────────────────────────────

describe("getShipTarget — factory", () => {
	it("returns adapter whose name matches for each valid name", () => {
		for (const name of SHIP_TARGET_NAMES) {
			assert.equal(getShipTarget(name).name, name);
		}
	});

	it("isShipTargetName narrows correctly", () => {
		assert.equal(isShipTargetName("direct-push"), true);
		assert.equal(isShipTargetName("pull-request"), true);
		assert.equal(isShipTargetName("auto-merge-pr"), true);
		assert.equal(isShipTargetName("rocket"), false);
		assert.equal(isShipTargetName(undefined), false);
	});

	it("throws with the list of valid names on unknown target", () => {
		assert.throws(
			() => getShipTarget("bogus" as ShipTargetName),
			(err: Error) => {
				assert.match(err.message, /direct-push/);
				assert.match(err.message, /pull-request/);
				assert.match(err.message, /auto-merge-pr/);
				return true;
			},
		);
	});
});

// ── Adapter units ─────────────────────────────────────────────────────

describe("direct-push adapter", () => {
	const a = getShipTarget("direct-push");
	const shipSkill = readFileSync(join(import.meta.dirname, "../../../../../.claude/skills/ship/SKILL.md"), "utf-8");

	it("buildPrompt mentions direct-push mode", () => {
		const prompt = a.buildPrompt({ itemId: "TOOL-99", worktree: "/tmp/wt" });
		assert.match(prompt, /direct-push/);
		assert.match(prompt, /merge/i);
	});

	it("reattaches the main checkout before pulling from a sibling worktree", () => {
		assert.match(shipSkill, /cd "\{MAIN_REPO\}"\ngit checkout main\ngit pull --no-rebase origin main/);
	});

	it("interpretResult: success", () => {
		const r = a.interpretResult(makeStepResult({ ok: true }));
		assert.equal(r.completed, true);
		assert.equal(r.awaitingMerge, undefined);
		assert.equal(r.prUrl, undefined);
		assert.equal(r.error, undefined);
	});

	it("interpretResult: failure", () => {
		const r = a.interpretResult(makeStepResult({ ok: false }));
		assert.equal(r.completed, false);
		assert.equal(r.error, "ship failed");
	});
});

describe("pull-request adapter", () => {
	const a = getShipTarget("pull-request");

	it("buildPrompt requires a decision block and no harness-owned git/gh effects", () => {
		const prompt = a.buildPrompt({ itemId: "TOOL-99", worktree: "/tmp/wt" });
		assert.match(prompt, /SHIP_DECISION/);
		assert.match(prompt, /pull-request/);
		assert.match(prompt, /NOT merge/);
		assert.match(prompt, /prBodyFile/);
		assert.match(prompt, /\.dev\/ship\/pr-body-TOOL-99\.md/);
		assert.doesNotMatch(prompt, /"prBody"/);
		assert.doesNotMatch(prompt, /gh pr create/);
		assert.doesNotMatch(prompt, /git push/);
	});

	it("interpretResult extracts PR URL from text", () => {
		const r = a.interpretResult(makeStepResult({ ok: true, text: `Opened ${PR_URL}` }));
		assert.equal(r.completed, true);
		assert.equal(r.awaitingMerge, true);
		assert.equal(r.prUrl, PR_URL);
	});

	it("interpretResult extracts PR URL from fullText when text is empty", () => {
		const r = a.interpretResult(makeStepResult({ ok: true, text: "done", fullText: `created PR: ${PR_URL}` }));
		assert.equal(r.prUrl, PR_URL);
	});

	it("interpretResult: success with no URL still reports awaitingMerge", () => {
		const r = a.interpretResult(makeStepResult({ ok: true, text: "done" }));
		assert.equal(r.completed, true);
		assert.equal(r.awaitingMerge, true);
		assert.equal(r.prUrl, undefined);
	});

	it("interpretResult: failure", () => {
		const r = a.interpretResult(makeStepResult({ ok: false }));
		assert.equal(r.completed, false);
		assert.equal(r.awaitingMerge, undefined);
		assert.equal(r.error, "ship failed");
	});
});

describe("auto-merge-pr adapter", () => {
	const a = getShipTarget("auto-merge-pr");

	it("buildPrompt requires a decision block and no harness-owned git/gh effects", () => {
		const prompt = a.buildPrompt({ itemId: "TOOL-99", worktree: "/tmp/wt" });
		assert.match(prompt, /SHIP_DECISION/);
		assert.match(prompt, /auto-merge-pr/);
		assert.match(prompt, /prBodyFile/);
		assert.match(prompt, /\.dev\/ship\/pr-body-TOOL-99\.md/);
		assert.doesNotMatch(prompt, /"prBody"/);
		assert.doesNotMatch(prompt, /gh pr create/);
		assert.doesNotMatch(prompt, /git push/);
		assert.doesNotMatch(prompt, /gh pr merge --auto/);
	});

	it("interpretResult extracts PR URL and marks awaitingMerge", () => {
		const r = a.interpretResult(makeStepResult({ ok: true, text: `auto-merge enabled on ${PR_URL}` }));
		assert.equal(r.completed, true);
		assert.equal(r.awaitingMerge, true);
		assert.equal(r.prUrl, PR_URL);
	});
});

// ── Pipeline integration ─────────────────────────────────────────────

describe("runPipeline — ship target dispatch", () => {
	it("direct-push: merge landed → deterministic tail runs, no awaitingMerge, no shipwreck", async () => {
		const { repo, worktree, mergeIntoMain } = setupShipRepo();
		const parkSignal = makeParkSignal();
		const bk = makeBkSpy();
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: { ok: true, text: "ship-merged: TOOL-99", sideEffect: () => mergeIntoMain() },
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "direct-push"), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: bk.fn,
		});
		assert.equal(result.completed, true);
		assert.equal(result.awaitingMerge, undefined);
		assert.equal(result.prUrl, undefined);
		// Tail invoked once with the resolved ctx.
		assert.equal(bk.calls.length, 1);
		assert.deepEqual(bk.calls[0], { mainRepo: repo, worktree, branch: "feat/tool-99", itemId: "TOOL-99" });
		const stepsRun = calls.map((c) => c.step);
		assert.ok(!stepsRun.includes("shipwreck"), `shipwreck should not run; got ${stepsRun.join(",")}`);
		const shipCall = calls.find((c) => c.step === "ship");
		assert.ok(shipCall);
		assert.match(shipCall.prompt, /direct-push/);
	});

	it("direct-push: merged but turn-exhausted (error_max_turns) → shipwreck re-verifies → deterministic tail runs", async () => {
		const { repo, worktree, mergeIntoMain } = setupShipRepo();
		const parkSignal = makeParkSignal();
		const bk = makeBkSpy();
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				// Merge landed (step 4) but the agent ran out of turns before completing
				// post-merge verification (step 5). Shipwreck re-verifies the merge with
				// its own budget; on a verified recovery the pipeline runs the same
				// deterministic tail the happy path runs (issue #30).
				ship: { ok: false, subtype: "error_max_turns", text: "out of turns", sideEffect: () => mergeIntoMain() },
				shipwreck: { ok: true, text: "ship-merged: TOOL-99" },
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "direct-push"), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: bk.fn,
		});
		assert.ok(calls.map((c) => c.step).includes("shipwreck"), "shipwreck must assess the unverified merge");
		// Shipwreck re-verified the merge → pipeline runs the tail once with resolved ctx.
		assert.equal(bk.calls.length, 1);
		assert.deepEqual(bk.calls[0], { mainRepo: repo, worktree, branch: "feat/tool-99", itemId: "TOOL-99" });
		assert.equal(result.completed, true);
	});

	it("direct-push: merge verified but bookkeeping fails (ok:false) → completed:false with error, no shipwreck (finding #3)", async () => {
		const { repo, worktree, mergeIntoMain } = setupShipRepo();
		const parkSignal = makeParkSignal();
		// Tail ran but the push failed — local main holds the merge, origin did not.
		const warning = "mark-done failed (EACCES); rerun mark-done";
		const bk = makeBkSpy({ ok: false, pushed: false, cleanedUp: false, warnings: [warning], error: "push failed after pull + retry — merge is on local main" });
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: { ok: true, text: "ship-merged: TOOL-99", sideEffect: () => mergeIntoMain() },
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "direct-push"), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: bk.fn,
		});
		assert.equal(bk.calls.length, 1);
		assert.equal(result.completed, false, "a failed push must not report the cycle as shipped");
		assert.match(result.error ?? "", /push failed/);
		assert.deepEqual(result.bookkeepingWarnings, [warning]);
		assert.ok(!calls.map((c) => c.step).includes("shipwreck"), "a push failure is surfaced, not routed to shipwreck");
	});

	it("direct-push: verified merge with bookkeeping warnings → completed:true with warnings", async () => {
		const { repo, worktree, mergeIntoMain } = setupShipRepo();
		const parkSignal = makeParkSignal();
		const warning = "mark-done failed (EACCES); rerun mark-done";
		const bk = makeBkSpy({ markedDone: false, warnings: [warning] });
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: { ok: true, text: "ship-merged: TOOL-99", sideEffect: () => mergeIntoMain() },
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "direct-push"), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: bk.fn,
		});

		assert.equal(result.completed, true);
		assert.deepEqual(result.bookkeepingWarnings, [warning]);
		assert.ok(!calls.map((c) => c.step).includes("shipwreck"));
	});

	it("direct-push: merged but agent hard-failed (error) → shipwreck re-verifies → deterministic tail runs", async () => {
		const { repo, worktree, mergeIntoMain } = setupShipRepo();
		const parkSignal = makeParkSignal();
		const warning = "archive-plan failed (EACCES); rerun archive-plan";
		const bk = makeBkSpy({ archived: false, warnings: [warning] });
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				// Merge landed but the agent flagged a genuine post-merge regression.
				// Shipwreck assesses + re-verifies the merge; on success the tail runs.
				ship: { ok: false, subtype: "error", text: "post-merge tests broke", sideEffect: () => mergeIntoMain() },
				shipwreck: { ok: true, text: "ship-merged: TOOL-99" },
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "direct-push"), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: bk.fn,
		});
		const stepsRun = calls.map((c) => c.step);
		assert.ok(stepsRun.includes("shipwreck"), `shipwreck should run; got ${stepsRun.join(",")}`);
		assert.equal(bk.calls.length, 1);
		assert.deepEqual(bk.calls[0], { mainRepo: repo, worktree, branch: "feat/tool-99", itemId: "TOOL-99" });
		assert.equal(result.completed, true);
		assert.deepEqual(result.bookkeepingWarnings, [warning]);
	});

	it("direct-push: ghost-ship → shipwreck lands + verifies the merge → deterministic tail runs", async () => {
		const { repo, worktree, mergeIntoMain } = setupShipRepo();
		const parkSignal = makeParkSignal();
		const bk = makeBkSpy();
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				// Ship claims success but never advanced main (ghost-ship). Shipwreck
				// lands the merge; the pipeline re-verifies it and runs the same tail.
				ship: { ok: true, text: "ship-merged: TOOL-99" },
				shipwreck: { ok: true, text: "ship-merged: TOOL-99", sideEffect: () => mergeIntoMain() },
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "direct-push"), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: bk.fn,
		});
		const shipwreckCall = calls.find((c) => c.step === "shipwreck");
		assert.ok(shipwreckCall, "shipwreck should run on a ghost-ship");
		// Pipeline hands shipwreck the same direct-push signal /ship gets.
		assert.match(shipwreckCall.prompt, /pelaggio/);
		assert.match(shipwreckCall.prompt, /--target=direct-push/);
		assert.equal(bk.calls.length, 1);
		assert.deepEqual(bk.calls[0], { mainRepo: repo, worktree, branch: "feat/tool-99", itemId: "TOOL-99" });
		assert.equal(result.completed, true);
	});

	it("direct-push: pre-ship dirty MAIN_REPO is recovered as a commit, not discarded (acceptance #4)", async () => {
		const { repo, worktree, mergeIntoMain } = setupShipRepo();
		const parkSignal = makeParkSignal();
		const bk = makeBkSpy();
		// A prior cycle left an uncommitted doc change in MAIN_REPO.
		writeFileSync(join(repo, "deferred.md"), "deferred create-item that must survive");
		const { runStep } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: { ok: true, text: "ship-merged: TOOL-99", sideEffect: () => mergeIntoMain() },
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "direct-push"), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: bk.fn,
		});
		assert.equal(result.completed, true);
		// The stray file survived — content preserved and committed (never discarded).
		assert.ok(existsSync(join(repo, "deferred.md")));
		assert.equal(readFileSync(join(repo, "deferred.md"), "utf-8"), "deferred create-item that must survive");
		assert.ok(
			allCommitMessages(repo).some((m) => /recover uncommitted bookkeeping \(TOOL-99\)/.test(m)),
			`expected a recover commit; got:\n${allCommitMessages(repo).join("\n")}`,
		);
	});

	it("direct-push: merge landed + ship ok but NO ship-merged marker → happy-path gate closed, routed to shipwreck, not silently shipped (issue #37)", async () => {
		const { repo, worktree, mergeIntoMain } = setupShipRepo();
		const parkSignal = makeParkSignal();
		const bk = makeBkSpy();
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				// Ship reports success and advances main, but never emits `ship-merged: <id>`
				// — so it did NOT prove it reached the hand-off gate (ran post-merge
				// verification). canTail must be false despite `merged && ship.ok`.
				ship: { ok: true, text: "merged and cleaned up", sideEffect: () => mergeIntoMain() },
				// Shipwreck also omits the marker → recovery gate closed too → not shipped.
				shipwreck: { ok: true },
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "direct-push"), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: bk.fn,
		});
		const stepsRun = calls.map((c) => c.step);
		assert.ok(stepsRun.includes("shipwreck"), `marker-less merge must route to shipwreck; got ${stepsRun.join(",")}`);
		assert.equal(bk.calls.length, 0, "the deterministic tail must not run without the ship-merged marker");
		assert.equal(result.completed, false, "a marker-less merge must not be silently reported as shipped");
	});

	it("direct-push: recovery ok + merge landed but NO ship-merged marker → recovery gate closed, completed:false, tail gated off (issue #37)", async () => {
		const { repo, worktree, mergeIntoMain } = setupShipRepo();
		const parkSignal = makeParkSignal();
		const bk = makeBkSpy();
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				// Merge landed (step 4) but the agent ran out of turns → routes to shipwreck.
				ship: { ok: false, subtype: "error_max_turns", text: "out of turns", sideEffect: () => mergeIntoMain() },
				// Shipwreck ends its session successfully and main IS advanced, but it never
				// emitted `ship-merged: <id>` — the exact #37 hole: session-ok recovery that
				// advanced main yet never proved it reached the gate. recoveredMerge false.
				shipwreck: { ok: true },
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "direct-push"), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: bk.fn,
		});
		assert.ok(calls.map((c) => c.step).includes("shipwreck"), "shipwreck must assess the unverified merge");
		assert.equal(bk.calls.length, 0, "the deterministic tail must not run without the recovery ship-merged marker");
		assert.equal(result.completed, false, "a marker-less recovery must not be reported as shipped");
	});

	it("pull-request: decision effect appends PR URL, result marks awaitingMerge + prUrl", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: prShipDecision("pull-request"),
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "pull-request"), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: () => {},
			dispatchStepEffects: async () => ({ appendText: PR_URL }),
		});
		assert.equal(result.completed, true);
		assert.equal(result.awaitingMerge, true);
		assert.equal(result.prUrl, PR_URL);
		const shipCall = calls.find((c) => c.step === "ship");
		assert.ok(shipCall);
		assert.match(shipCall.prompt, /SHIP_DECISION/);
		assert.match(shipCall.prompt, /pull-request/);
		// Successful PR ship cleans up the scratch body file.
		assert.equal(existsSync(join(worktree, shipBodyFile("TOOL-99"))), false);
	});

	it("auto-merge-pr: decision effect appends PR URL", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: prShipDecision("auto-merge-pr"),
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "auto-merge-pr"), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: () => {},
			dispatchStepEffects: async () => ({ appendText: PR_URL }),
		});
		assert.equal(result.completed, true);
		assert.equal(result.awaitingMerge, true);
		assert.equal(result.prUrl, PR_URL);
		const shipCall = calls.find((c) => c.step === "ship");
		assert.ok(shipCall);
		assert.match(shipCall.prompt, /SHIP_DECISION/);
		assert.match(shipCall.prompt, /auto-merge-pr/);
	});

	it("pull-request: rich markdown body is byte-identical in the written effects manifest", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const richBody = 'Title with "quotes"\n\n```ts\nconst x = 1;\n```\n\nand `backticks`.';
		const capturedShip: Effect[] = [];
		const { runStep } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: prShipDecision("pull-request", "TOOL-99", richBody),
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "pull-request"), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: () => {},
			writeEffectsManifest: (ctx, effects) => {
				if (ctx.step === "ship") capturedShip.push(...effects);
			},
			dispatchStepEffects: async (ctx) => (ctx.step === "ship" ? { appendText: PR_URL } : {}),
		});
		assert.equal(result.completed, true);
		assert.equal(capturedShip.length, 1);
		const effect = capturedShip[0];
		assert.equal(effect.kind, "ship.ShipDecision");
		if (effect.kind === "ship.ShipDecision") assert.equal(effect.prBody, richBody);
	});

	it("pull-request: invalid decision retries once; attempt 2 succeeds and cleans up", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		const shipDispatchCalls: number[] = [];
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				// Attempt 1: missing body file / no prBodyFile → resolve-phase invalid_manifest.
				// Attempt 2: valid file transport.
				ship: [
					{ ok: true, text: "SHIP_DECISION\nnot-json\nEND_SHIP_DECISION", cost: 0.02 },
					{ ...prShipDecision("pull-request"), cost: 0.03 },
				],
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "pull-request"), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
			dispatchStepEffects: async (ctx) => {
				if (ctx.step === "ship") shipDispatchCalls.push(1);
				return ctx.step === "ship" ? { appendText: PR_URL } : {};
			},
		});
		assert.equal(result.completed, true);
		assert.equal(result.prUrl, PR_URL);
		const shipCalls = calls.filter((c) => c.step === "ship");
		assert.equal(shipCalls.length, 2);
		assert.match(shipCalls[1].prompt, /Previous ship decision failed/);
		assert.match(shipCalls[1].prompt, /prBodyFile/);
		assert.equal(shipDispatchCalls.length, 1, "dispatch only after valid decision");
		assert.equal(existsSync(join(worktree, shipBodyFile("TOOL-99"))), false, "cleanup after success");
		const steps = logs[0].steps as Array<{ name: string; attempt?: number; ok: boolean; effectsError?: { code: string } }>;
		const shipSteps = steps.filter((s) => s.name === "ship");
		assert.equal(shipSteps.length, 2);
		assert.equal(shipSteps[0].ok, false);
		assert.equal(shipSteps[0].effectsError?.code, "invalid_manifest");
		assert.equal(shipSteps[1].ok, true);
		assert.equal(shipSteps[1].attempt, 2);
		// Costs accumulate across attempts (0.01 defaults + 0.02 + 0.03 for ship).
		assert.ok((result.cost as number) >= 0.05);
	});

	it("pull-request: both attempts invalid → terminal, scratch retained, no dispatch", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const logs: Array<Record<string, unknown>> = [];
		let shipDispatchCount = 0;
		let shipWriteCount = 0;
		const bodyPath = join(worktree, shipBodyFile("TOOL-99"));
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				// Both attempts: bad JSON → resolve-phase invalid_manifest. Attempt 1 still
				// writes a scratch body so we can assert retention on terminal failure.
				ship: [
					{
						ok: true,
						writes: { [shipBodyFile("TOOL-99")]: "retained-for-diagnosis" },
						text: "SHIP_DECISION\nnot-json\nEND_SHIP_DECISION",
					},
					{ ok: true, text: "SHIP_DECISION\nstill-bad\nEND_SHIP_DECISION" },
				],
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "pull-request"), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: (e) => {
				logs.push(e);
			},
			writeEffectsManifest: (ctx) => {
				if (ctx.step === "ship") shipWriteCount += 1;
			},
			dispatchStepEffects: async (ctx) => {
				if (ctx.step === "ship") shipDispatchCount += 1;
				return {};
			},
		});
		assert.equal(result.completed, false);
		assert.equal(calls.filter((c) => c.step === "ship").length, 2);
		assert.equal(shipWriteCount, 0);
		assert.equal(shipDispatchCount, 0);
		assert.equal(existsSync(bodyPath), true, "scratch retained after terminal failure");
		assert.equal(readFileSync(bodyPath, "utf-8"), "retained-for-diagnosis");
		const steps = logs[0].steps as Array<{ name: string; ok: boolean; effectsError?: { code: string; message: string } }>;
		const shipSteps = steps.filter((s) => s.name === "ship");
		assert.equal(shipSteps.length, 2);
		assert.equal(shipSteps[1].ok, false);
		assert.equal(shipSteps[1].effectsError?.code, "invalid_manifest");
		assert.ok(shipSteps[1].effectsError?.message);
	});

	it("pull-request: a stale body file from a prior run is cleared before attempt 1 — never opens a PR with stale content (#303 review)", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const bodyPath = join(worktree, shipBodyFile("TOOL-99"));
		// Simulate a resume after a prior FAILED ship run: a stale body file persists in the worktree.
		mkdirSync(dirname(bodyPath), { recursive: true });
		writeFileSync(bodyPath, "STALE BODY from a prior failed run — must not be shipped");
		let shipDispatchCount = 0;
		// The model emits a VALID decision that references prBodyFile but does NOT (re)write the body
		// file this run — it would rely on the stale file. Pre-attempt cleanup removes the stale file,
		// so both attempts fail closed (file missing) rather than dispatching the stale content.
		const decisionNoWrite = { ok: true, text: `SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Ship TOOL-99","prBodyFile":"${shipBodyFile("TOOL-99")}"}\nEND_SHIP_DECISION` };
		const { runStep } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: [decisionNoWrite, decisionNoWrite],
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "pull-request"), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: () => {},
			dispatchStepEffects: async (ctx) => {
				if (ctx.step === "ship") shipDispatchCount += 1;
				return {};
			},
		});
		assert.equal(result.completed, false, "must not complete a ship that would reuse a stale body");
		assert.equal(shipDispatchCount, 0, "no PR dispatched from a stale body file");
		assert.equal(existsSync(bodyPath), false, "stale body file was cleared before attempt 1 and never rewritten");
	});

	it("pull-request: fails closed if a stale body file cannot be cleared before attempt 1 — no ship attempt, no dispatch (#303 review)", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const bodyPath = join(worktree, shipBodyFile("TOOL-99"));
		mkdirSync(dirname(bodyPath), { recursive: true });
		// A symlink at the body path persists through cleanupShipBodyFile (which no-ops on symlinks),
		// simulating a stale body that cannot be removed (e.g. unlink EPERM). The fail-closed gate must
		// refuse the ship BEFORE attempt 1 rather than let the stale body be read and dispatched.
		const target = join(worktree, "real-body.md");
		writeFileSync(target, "stale content reachable via symlink");
		symlinkSync(target, bodyPath);
		let shipDispatchCount = 0;
		const decision = { ok: true, text: `SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Ship TOOL-99","prBodyFile":"${shipBodyFile("TOOL-99")}"}\nEND_SHIP_DECISION` };
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: [decision, decision],
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "pull-request"), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: () => {},
			dispatchStepEffects: async (ctx) => {
				if (ctx.step === "ship") shipDispatchCount += 1;
				return {};
			},
		});
		assert.equal(result.completed, false, "must refuse to ship when the stale body cannot be cleared");
		assert.equal(calls.filter((c) => c.step === "ship").length, 0, "ship step must not run — fail closed before attempt 1");
		assert.equal(shipDispatchCount, 0, "no dispatch");
	});

	it("pull-request: provenance_mismatch and dispatch failures are not retried", async () => {
		for (const fail of [
			() => {
				throw new EffectsManifestError("provenance_mismatch", "sha mismatch");
			},
			async () => {
				throw new EffectsManifestError("effect_failed", "gh push failed");
			},
		] as const) {
			const worktree = makeTempGitRepo();
			const parkSignal = makeParkSignal();
			const { runStep, calls } = createMockRunStep(
				{
					plan: { ok: true },
					"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
					implement: { ok: true, writes: { "impl.txt": "x" } },
					"shakedown-code": { ok: true },
					ship: prShipDecision("pull-request"),
				},
				parkSignal,
			);
			const result = await runPipeline(baseOpts(worktree, "pull-request"), parkSignal, baseFlags, {
				runStep,
				listWorktrees: () => [],
				appendLog: () => {},
				// Only fail ship dispatch — plan/shakedown still need a no-op success path.
				dispatchStepEffects: async (ctx) => {
					if (ctx.step === "ship") return fail();
					return {};
				},
			});
			assert.equal(result.completed, false);
			assert.equal(calls.filter((c) => c.step === "ship").length, 1, "single attempt only");
			// Scratch retained on terminal failure.
			assert.equal(existsSync(join(worktree, shipBodyFile("TOOL-99"))), true);
		}
	});

	it("skill body and both buildPrompts require prBodyFile and forbid advertising inline prBody", () => {
		const skill = expandSkill("ship", "pelaggio --target=pull-request");
		assert.match(skill, /prBodyFile/);
		assert.match(skill, /\.dev\/ship\/pr-body-\{ID\}\.md/);
		assert.doesNotMatch(skill, /"prBody":\s*"\{body\}"/);
		for (const name of ["pull-request", "auto-merge-pr"] as const) {
			const prompt = getShipTarget(name).buildPrompt({ itemId: "TOOL-99", worktree: "/tmp/wt" });
			assert.match(prompt, /prBodyFile/);
			// Must not instruct the worker to emit an inline prBody field (file transport only).
			assert.doesNotMatch(prompt, /"prBody"/);
		}
	});
});

describe("runPipeline — shipwreck skipped for PR modes", () => {
	it("pull-request: ship fails, shipwreck NOT invoked", async () => {
		const worktree = makeTempGitRepo();
		const parkSignal = makeParkSignal();
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				ship: { ok: false, subtype: "error", text: "push failed" },
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "pull-request"), parkSignal, baseFlags, {
			runStep,
			listWorktrees: () => [],
			appendLog: () => {},
		});
		assert.equal(result.completed, false);
		assert.equal(result.error, "ship failed");
		const stepsRun = calls.map((c) => c.step);
		assert.ok(!stepsRun.includes("shipwreck"), `shipwreck should not run; got ${stepsRun.join(",")}`);
	});

	it("direct-push: ship fails and shipwreck cannot land the merge → tail gated off, not shipped", async () => {
		const { repo, worktree } = setupShipRepo();
		const parkSignal = makeParkSignal();
		const bk = makeBkSpy();
		const { runStep, calls } = createMockRunStep(
			{
				plan: { ok: true },
				"shakedown-plan": { ok: true, text: "VERDICT: APPROVE" },
				implement: { ok: true, writes: { "impl.txt": "x" } },
				"shakedown-code": { ok: true },
				// No sideEffect anywhere — main never advances, so even a shipwreck that
				// reports ok did not land the merge. verifyShipLanded fails closed →
				// recoveredMerge=false → tail gated off, cycle reported not-shipped.
				ship: { ok: false, subtype: "error", text: "merge failed" },
				shipwreck: { ok: true },
			},
			parkSignal,
		);
		const result = await runPipeline(baseOpts(worktree, "direct-push"), parkSignal, baseFlags, {
			runStep,
			mainRepo: repo,
			listWorktrees: () => [],
			appendLog: () => {},
			runShipBookkeeping: bk.fn,
		});
		const stepsRun = calls.map((c) => c.step);
		assert.ok(stepsRun.includes("shipwreck"), `shipwreck should run; got ${stepsRun.join(",")}`);
		assert.equal(bk.calls.length, 0);
		assert.equal(result.completed, false, "a claimed recovery that didn't advance main is not shipped");
	});
});

// ── Config validation ────────────────────────────────────────────────

describe("loadConfig — ship.target validation", () => {
	function writeYml(contents: string): string {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-config-test-"));
		const path = join(dir, ".pelaggio.yml");
		writeFileSync(path, contents);
		return path;
	}

	it("defaults to pull-request when ship block absent", () => {
		const path = writeYml("");
		// Assert against the exported constant too, so test and default can't silently diverge.
		assert.equal(DEFAULT_SHIP_TARGET, "pull-request");
		assert.equal(loadConfig({ configPath: path }).shipTarget, DEFAULT_SHIP_TARGET);
	});

	it("accepts each valid target name", () => {
		for (const name of SHIP_TARGET_NAMES) {
			const path = writeYml(`ship:\n  target: ${name}\n`);
			assert.equal(loadConfig({ configPath: path }).shipTarget, name);
		}
	});

	it("throws on invalid ship.target with list of valid names", () => {
		const path = writeYml("ship:\n  target: rocket\n");
		assert.throws(
			() => loadConfig({ configPath: path }),
			(err: Error) => {
				assert.match(err.message, /ship\.target/);
				assert.match(err.message, /direct-push/);
				assert.match(err.message, /pull-request/);
				assert.match(err.message, /auto-merge-pr/);
				return true;
			},
		);
	});

	it("throws when ship is not a map", () => {
		const path = writeYml("ship: nope\n");
		assert.throws(() => loadConfig({ configPath: path }), /ship.*map/);
	});
});

// ── Autonomous-remote-push classifier ────────────────────────────────

describe("isAutonomousRemotePush", () => {
	it("is true for the autonomous-push opt-in targets", () => {
		assert.equal(isAutonomousRemotePush("direct-push"), true);
		assert.equal(isAutonomousRemotePush("auto-merge-pr"), true);
	});

	it("is false for the review-gated default", () => {
		assert.equal(isAutonomousRemotePush("pull-request"), false);
		assert.equal(isAutonomousRemotePush(DEFAULT_SHIP_TARGET), false);
	});
});

// ── Startup banner builder ───────────────────────────────────────────

describe("remotePushWarning", () => {
	it("returns null for the safe default (no banner)", () => {
		assert.equal(remotePushWarning("pull-request"), null);
	});

	it("fires for direct-push, naming the target and the remediation hint", () => {
		const banner = remotePushWarning("direct-push");
		assert.ok(banner, "expected a non-null banner");
		const text = stripAnsi(banner);
		assert.match(text, /direct-push/);
		assert.match(text, /pull-request/);
	});

	it("fires for auto-merge-pr, naming the target and the remediation hint", () => {
		const banner = remotePushWarning("auto-merge-pr");
		assert.ok(banner, "expected a non-null banner");
		const text = stripAnsi(banner);
		assert.match(text, /auto-merge-pr/);
		assert.match(text, /pull-request/);
	});
});
