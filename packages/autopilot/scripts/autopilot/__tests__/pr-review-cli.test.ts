import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { main, runPrReviewGate, setPrReviewDepsForTests } from "../pr-review-cli.js";
import type { RunStepFn } from "../step-runner.js";
import type { ParkSignal, StepEmit, StepResult } from "../types.js";

interface RunCall {
	prompt: string;
	cwd: string;
	parkSignal: ParkSignal;
}

function result(overrides: Partial<StepResult> = {}): StepResult {
	return {
		ok: true,
		subtype: "success",
		text: "No confirmed blockers.\n\nVerdict: PASS",
		fullText: "No confirmed blockers.\n\nVerdict: PASS",
		cost: 1,
		turns: 2,
		...overrides,
	};
}

async function runCli(opts: { files?: string; diff?: string; results?: StepResult[]; diffError?: Error } = {}): Promise<{ code: number; calls: RunCall[]; comments: string[]; stdout: string; stderr: string }> {
	const calls: RunCall[] = [];
	const comments: string[] = [];
	const queued = [...(opts.results ?? [result()])];
	const execFileSync = ((cmd: string, args: readonly string[]) => {
		if (opts.diffError) throw opts.diffError;
		assert.equal(cmd, "git");
		if (args.join(" ") === "diff --name-only origin/main...HEAD") return opts.files ?? "docs/readme.md\n";
		if (args.join(" ") === "diff origin/main...HEAD") return opts.diff ?? "+Clarify docs.\n";
		throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
	}) as typeof import("node:child_process").execFileSync;
	const runStep: RunStepFn = async (_name, prompt, stepOpts, _emit: StepEmit) => {
		calls.push({ prompt, cwd: stepOpts.cwd, parkSignal: stepOpts.parkSignal });
		const next = queued.shift();
		assert.ok(next, "unexpected extra runStep call");
		return next;
	};
	const restoreDeps = setPrReviewDepsForTests({
		execFileSync,
		runStep,
		upsertComment: (_pr, body) => comments.push(body),
	});
	const originalStdout = process.stdout.write;
	const originalStderr = process.stderr.write;
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await main(["--pr", "123"]);
		return { code, calls, comments, stdout, stderr };
	} finally {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
		restoreDeps();
	}
}

describe("pr-review CLI aggregation", () => {
	it("runs only the standard pass for non-security diffs", async () => {
		const out = await runCli();

		assert.equal(out.code, 0);
		assert.equal(out.calls.length, 1);
		assert.match(out.calls[0].prompt, /Arguments: --pr 123$/);
		assert.doesNotMatch(out.calls[0].prompt, /Arguments: .*--red-team/);
		assert.match(out.comments[0], /Adversarial red-team pass: not triggered/);
		assert.match(out.comments[0], /gate=pass ok=true subtype=success cost=1\.00 turns=2/);
	});

	it("runs a red-team pass for security-sensitive diffs with classifier reasons", async () => {
		const out = await runCli({
			files: "packages/server/src/config.ts\n",
			diff: '+return host.startsWith("127.");\n',
			results: [result({ cost: 1, turns: 2 }), result({ cost: 3, turns: 4 })],
		});

		assert.equal(out.code, 0);
		assert.equal(out.calls.length, 2);
		assert.match(out.calls[0].prompt, /Arguments: --pr 123$/);
		assert.doesNotMatch(out.calls[0].prompt, /Arguments: .*--red-team/);
		assert.match(out.calls[1].prompt, /Arguments: .*--red-team/);
		assert.match(out.calls[1].prompt, /--security-reasons "path:packages\/server\/src\/config\.ts, keyword:127\., keyword:host"/);
		assert.match(out.comments[0], /## Standard Review/);
		assert.match(out.comments[0], /## Adversarial Red-Team Review/);
		assert.match(out.comments[0], /Triggered: path:packages\/server\/src\/config\.ts/);
		assert.match(out.comments[0], /gate=pass ok=true subtype=success cost=4\.00 turns=6/);
	});

	it("blocks overall when red-team blocks after a standard pass", async () => {
		const out = await runCli({
			files: "packages/server/src/config.ts\n",
			diff: "+CONTROL_PLANE_TOKEN\n",
			results: [result(), result({ text: "packages/server/src/config.ts:12 bypasses auth.\n\nVerdict: BLOCK", cost: 2, turns: 5 })],
		});

		assert.equal(out.code, 1);
		assert.match(out.comments[0], /Automated review: BLOCK/);
		assert.match(out.comments[0], /packages\/server\/src\/config\.ts:12 bypasses auth/);
		assert.match(out.comments[0], /gate=block ok=true subtype=red-team:success cost=3\.00 turns=7/);
	});

	it("still runs red-team when the standard pass blocks", async () => {
		const out = await runCli({
			files: "packages/server/src/config.ts\n",
			diff: "+CONTROL_PLANE_TOKEN\n",
			results: [result({ text: "Bug.\n\nVerdict: BLOCK" }), result()],
		});

		assert.equal(out.code, 1);
		assert.equal(out.calls.length, 2);
		assert.match(out.comments[0], /## Standard Review/);
		assert.match(out.comments[0], /## Adversarial Red-Team Review/);
	});

	it("blocks when a triggered red-team run returns ok false despite PASS text", async () => {
		const out = await runCli({
			files: "packages/server/src/config.ts\n",
			diff: "+CONTROL_PLANE_TOKEN\n",
			results: [result(), result({ ok: false, subtype: "error_max_turns", text: "No blockers.\n\nVerdict: PASS" })],
		});

		assert.equal(out.code, 1);
		assert.match(out.comments[0], /Run did not complete cleanly \(`error_max_turns`\)/);
		assert.match(out.comments[0], /gate=block ok=false subtype=red-team:error_max_turns/);
	});

	it("fails closed without model calls when diff inspection fails", async () => {
		const out = await runCli({ diffError: new Error("fatal: bad revision") });

		assert.equal(out.code, 1);
		assert.equal(out.calls.length, 0);
		assert.match(out.comments[0], /Could not inspect the PR diff/);
		assert.match(out.comments[0], /gate=block ok=false subtype=standard:error_diff cost=0\.00 turns=0/);
	});

	it("uses a fresh park signal for each pass", async () => {
		const out = await runCli({
			files: "packages/server/src/config.ts\n",
			diff: "+CONTROL_PLANE_TOKEN\n",
			results: [result(), result()],
		});

		assert.equal(out.calls.length, 2);
		assert.notEqual(out.calls[0].parkSignal, out.calls[1].parkSignal);
		assert.deepEqual(out.calls[0].parkSignal, { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" });
		assert.deepEqual(out.calls[1].parkSignal, { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" });
	});

	it("library runner accepts trusted cwd with custom diff refs and does not post unless asked", async () => {
		const calls: RunCall[] = [];
		const gitCalls: { args: readonly string[]; cwd?: string }[] = [];
		const execFileSync = ((cmd: string, args: readonly string[], opts?: { cwd?: string }) => {
			assert.equal(cmd, "git");
			gitCalls.push({ args, cwd: opts?.cwd });
			if (args.join(" ") === "diff --name-only origin/main...refs/pull/123/head") return "packages/server/src/config.ts\n";
			if (args.join(" ") === "diff origin/main...refs/pull/123/head") return "+CONTROL_PLANE_TOKEN\n";
			throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
		}) as typeof import("node:child_process").execFileSync;
		const runStep: RunStepFn = async (_name, prompt, stepOpts) => {
			calls.push({ prompt, cwd: stepOpts.cwd, parkSignal: stepOpts.parkSignal });
			return result();
		};

		const review = await runPrReviewGate({
			pr: "123",
			cwd: "/trusted/main",
			diffCwd: "/tmp/pr-head",
			diffBaseRef: "origin/main",
			diffHeadRef: "refs/pull/123/head",
			runStep,
			execFileSync,
		});

		assert.equal(review.gate, "pass");
		assert.equal(review.cost, 2);
		assert.equal(review.turns, 4);
		assert.equal(calls.length, 2, "security-sensitive diff should trigger standard + red-team");
		assert.equal(calls[0].cwd, "/trusted/main");
		assert.match(calls[0].prompt, /Trusted local review context/);
		assert.match(calls[0].prompt, /supersedes the checkout-at-PR-head wording/);
		assert.match(calls[0].prompt, /git -C \/tmp\/pr-head diff --name-only origin\/main\.\.\.refs\/pull\/123\/head/);
		assert.deepEqual(
			gitCalls.map((c) => ({ args: c.args.join(" "), cwd: c.cwd })),
			[
				{ args: "diff --name-only origin/main...refs/pull/123/head", cwd: "/tmp/pr-head" },
				{ args: "diff origin/main...refs/pull/123/head", cwd: "/tmp/pr-head" },
			],
		);
	});
});
