import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SHIP_TARGET, loadConfig } from "../config.js";
import { remotePushWarning, runPipeline } from "../pipeline.js";
import type { ShipBookkeepingCtx, ShipBookkeepingResult } from "../ship/index.js";
import { getShipTarget, isAutonomousRemotePush, isShipTargetName, SHIP_TARGET_NAMES } from "../ship/index.js";
import { stripAnsi } from "../tui.js";
import type { Flags, PipelineOpts, ShipTargetName, StepResult } from "../types.js";
import { allCommitMessages, createMockRunStep, makeLiveStatus, makeParkSignal, makeTempGitRepo, makeTempRepoWithParent } from "./mocks.js";

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
		return { recovered: false, markedDone: true, archived: true, pushed: true, cleanedUp: true, ok: true, ...over };
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

	it("buildPrompt mentions direct-push mode", () => {
		const prompt = a.buildPrompt({ itemId: "TOOL-99", worktree: "/tmp/wt" });
		assert.match(prompt, /direct-push/);
		assert.match(prompt, /merge/i);
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
		const bk = makeBkSpy({ ok: false, pushed: false, cleanedUp: false, error: "push failed after pull + retry — merge is on local main" });
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
		assert.ok(!calls.map((c) => c.step).includes("shipwreck"), "a push failure is surfaced, not routed to shipwreck");
	});

	it("direct-push: merged but agent hard-failed (error) → shipwreck re-verifies → deterministic tail runs", async () => {
		const { repo, worktree, mergeIntoMain } = setupShipRepo();
		const parkSignal = makeParkSignal();
		const bk = makeBkSpy();
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
				ship: { ok: true, text: `SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Ship TOOL-99","prBody":"Body"}\nEND_SHIP_DECISION` },
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
				ship: { ok: true, text: `SHIP_DECISION\n{"target":"auto-merge-pr","headBranch":"feat/tool-99","prTitle":"Ship TOOL-99","prBody":"Body"}\nEND_SHIP_DECISION` },
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
