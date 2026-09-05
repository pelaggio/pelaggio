import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { cancelRun, continueRun, getRun, startRun } from "../local-autopilot/engine.js";
import { fakeAdapter } from "../local-autopilot/fake-adapter.js";
import { grokAdapter } from "../local-autopilot/grok-adapter.js";
import type { HarnessContext } from "../local-autopilot/harness.js";
import { readRunEvents } from "../local-autopilot/journal.js";
import { eventsPath, requestLockPath } from "../local-autopilot/paths.js";
import { presentHuman, presentJson } from "../local-autopilot/present.js";
import { looksLikeAnsi } from "../local-autopilot/transport.js";
import { digestOf } from "../local-autopilot/work-contract.js";
import { measurePrompt, measureUsage } from "../usage-measurement.js";

const temps: string[] = [];
after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function consumer(script: string, maxRepairs = 1, harnessExtra = ""): { cwd: string; ticket: string } {
	const cwd = mkdtempSync(join(tmpdir(), "pelaggio-la-"));
	temps.push(cwd);
	execFileSync("git", ["init", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "test"], { cwd });
	writeFileSync(join(cwd, "README.md"), "consumer\n");
	execFileSync("git", ["add", "README.md"], { cwd });
	execFileSync("git", ["commit", "-m", "init"], { cwd });
	mkdirSync(join(cwd, ".pelaggio"));
	writeFileSync(
		join(cwd, ".pelaggio", "pelaggio.yml"),
		`harness:\n  adapter: fake\n  fake:\n    script:\n${script}${harnessExtra}execution:\n  mode: host\nautopilot:\n  maxRepairs: ${maxRepairs}\n  verification:\n    command: git diff --check HEAD\n`,
	);
	writeFileSync(join(cwd, "ticket.md"), "Add a hello export\n\nCreate src/hello.ts that exports hello = 1.\n");
	return { cwd, ticket: join(cwd, "ticket.md") };
}

const SUCCESS_SCRIPT = `      - { action: write, path: src/hello.ts, content: "export const hello = 1;" }\n      - { action: complete }\n`;

it("request preparation never steals an expired claim and a later retry succeeds", { timeout: 15_000 }, async () => {
	const { cwd } = consumer(SUCCESS_SCRIPT);
	const requestId = "slow-checkout";
	const lock = requestLockPath(cwd, digestOf(requestId).value);
	mkdirSync(join(cwd, ".pelaggio", "runs", "request-locks"), { recursive: true });
	const owner = `${Date.now() - 60_000}:checkout-still-running`;
	writeFileSync(lock, owner);
	await assert.rejects(startRun(cwd, { task: { text: "Task" }, requestId, nonInteractive: true }), /state preserved/);
	assert.equal(readFileSync(lock, "utf8"), owner);
	assert.equal(existsSync(join(cwd, ".pelaggio", "runs", "by-request", requestId)), false);
	assert.equal(existsSync(join(cwd, ".pelaggio", "worktrees")), false);
	rmSync(lock);
	const result = await startRun(cwd, { task: { text: "Task" }, requestId, nonInteractive: true });
	assert.ok(result.ok);
	if (result.ok) assert.equal(result.value.disposition, "ready_for_review");
});

describe("local autopilot engine", () => {
	it("projects adapter usage without changing lifecycle or exporting task content", async () => {
		const { cwd } = consumer(`      - { action: complete }\n`);
		const adapters = {
			grok: grokAdapter,
			fake: {
				name: "fake" as const,
				async next(ctx: Parameters<typeof fakeAdapter.next>[0]) {
					return {
						...(await fakeAdapter.next(ctx)),
						usageMeasurement: measurePrompt(ctx.workContract.body, "adapter-assembled", measureUsage("claude", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 60, cache_creation_input_tokens: 30 })),
					};
				},
			},
		};
		const result = await startRun(cwd, { task: { text: "private task body" }, nonInteractive: true }, { adapters });
		assert.ok(result.ok);
		if (!result.ok) return;
		assert.equal(result.value.disposition, "ready_for_review");
		assert.deepEqual(result.value.metrics?.usage, { inputTokens: 100, outputTokens: 5 });
		assert.ok(!JSON.stringify(result.value.metrics).includes("private task"));
		const reread = getRun(cwd, result.value.runId);
		assert.ok(reread.ok);
		if (reread.ok) assert.deepEqual(reread.value.metrics, result.value.metrics);
	});

	it("ignores malformed journal diagnostics during show and resume", async () => {
		const { cwd } = consumer(SUCCESS_SCRIPT);
		const controller = new AbortController();
		const adapters = {
			grok: grokAdapter,
			fake: {
				...fakeAdapter,
				async next(ctx: Parameters<typeof fakeAdapter.next>[0]) {
					const result = await fakeAdapter.next(ctx);
					if (ctx.cursor > 0) controller.abort();
					return result;
				},
			},
		};
		const paused = await startRun(cwd, { task: { text: "hello" }, nonInteractive: true }, { adapters, signal: controller.signal });
		assert.ok(paused.ok);
		if (!paused.ok) return;
		const events = readRunEvents(cwd, paused.value.runId);
		assert.ok(events.some((event) => event.type.endsWith(".fake-progress")));
		for (const basis of [{ toString: null }, ["codex-cli-v1"]]) {
			const malformed = events.map((event) => (event.type.endsWith(".fake-progress") ? { ...event, payload: { ...event.payload, usageMeasurement: { schemaVersion: 1, basis, inputTokens: 123 } } } : event));
			writeFileSync(eventsPath(cwd, paused.value.runId), malformed.map((event) => JSON.stringify(event)).join("\n") + "\n");
			const shown = getRun(cwd, paused.value.runId);
			assert.ok(shown.ok);
			if (shown.ok) {
				assert.equal(shown.value.state, "paused");
				assert.equal(shown.value.metrics?.usage, undefined);
			}
		}
		const resumed = await continueRun(cwd, paused.value.runId);
		assert.ok(resumed.ok, JSON.stringify(resumed));
		if (resumed.ok) assert.equal(resumed.value.disposition, "ready_for_review");
	});

	it("does not attribute fake calls to an unused Grok model", async () => {
		const { cwd } = consumer(`      - { action: complete }\n`, 1, "  grok:\n    model: unused-model\n");
		const result = await startRun(cwd, { task: { text: "hello" }, nonInteractive: true });
		assert.ok(result.ok);
		if (!result.ok) return;
		const ack = readRunEvents(cwd, result.value.runId).find((event) => event.type.endsWith(".fake-progress"));
		assert.equal(ack?.payload?.provider, "fake");
		assert.equal(ack?.payload?.model, "unrecorded");
	});

	it("resume rejects a substituted worktree before changing the journal and can retry after restoration", async () => {
		const { cwd } = consumer(`      - { action: decision, code: choose, message: Choose }\n      - { action: complete }\n`);
		const result = await startRun(cwd, { task: { text: "Task" }, nonInteractive: true });
		assert.ok(result.ok);
		if (!result.ok || !result.value.worktree?.path) return;
		const runId = result.value.runId;
		const worktree = result.value.worktree.path;
		const before = readFileSync(eventsPath(cwd, runId), "utf8");
		renameSync(worktree, `${worktree}-preserved`);
		symlinkSync(`${worktree}-preserved`, worktree, "dir");
		const refused = await continueRun(cwd, runId);
		assert.equal(refused.ok, false);
		if (!refused.ok) assert.match(refused.problem.message, /symlink/);
		assert.equal(readFileSync(eventsPath(cwd, runId), "utf8"), before);
		rmSync(worktree);
		renameSync(`${worktree}-preserved`, worktree);
		const resumed = await continueRun(cwd, runId);
		assert.ok(resumed.ok);
		if (resumed.ok) assert.equal(resumed.value.disposition, "ready_for_review");
	});

	it("successful run produces ready_for_review, a local branch/worktree, and success", async () => {
		const { cwd, ticket } = consumer(SUCCESS_SCRIPT);
		const result = await startRun(cwd, { task: { file: ticket }, nonInteractive: true });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.state, "completed");
		assert.equal(result.value.disposition, "ready_for_review");
		assert.ok(result.value.worktree?.branch.startsWith("pelaggio/"));
		assert.ok(result.value.worktree?.path);
		assert.equal(readFileSync(join(result.value.worktree.path, "src/hello.ts"), "utf8"), "export const hello = 1;");
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "consumer\n");
	});

	it("rejects symlink writes without acknowledging them, then resumes the same action", async () => {
		const { cwd } = consumer(`      - { action: write, path: escape/victim, content: "new" }\n      - { action: complete }\n`);
		const outside = mkdtempSync(join(tmpdir(), "pelaggio-outside-"));
		temps.push(outside);
		writeFileSync(join(outside, "victim"), "original");
		symlinkSync(outside, join(cwd, "escape"), "dir");
		execFileSync("git", ["add", "escape"], { cwd });
		execFileSync("git", ["commit", "-m", "tracked symlink"], { cwd });
		const failed = await startRun(cwd, { task: { text: "Write victim" }, nonInteractive: true });
		assert.equal(failed.ok, false);
		if (failed.ok) return;
		assert.match(failed.problem.message, /symlink/);
		assert.equal(readFileSync(join(outside, "victim"), "utf8"), "original");
		assert.ok(failed.problem.runId);
		const shown = getRun(cwd, failed.problem.runId);
		assert.ok(shown.ok);
		assert.ok(shown.value.worktree?.path);
		const worktree = shown.value.worktree.path;
		rmSync(join(worktree, "escape"));
		const resumed = await continueRun(cwd, failed.problem.runId);
		assert.ok(resumed.ok);
		assert.equal(resumed.value.disposition, "ready_for_review");
		assert.equal(readFileSync(join(worktree, "escape", "victim"), "utf8"), "new");
	});

	it("persists independently retrievable verification attempts with matching digests", async () => {
		const { cwd } = consumer(`      - { action: verify-fail, message: "tests red" }\n${SUCCESS_SCRIPT}`);
		const result = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true });
		assert.ok(result.ok);
		const artifacts = result.value.artifacts.filter((artifact) => artifact.kind === "verification");
		assert.equal(artifacts.length, 2);
		assert.notEqual(artifacts[0]?.uri, artifacts[1]?.uri);
		for (const [index, artifact] of artifacts.entries()) {
			const content = readFileSync(fileURLToPath(artifact.uri), "utf8");
			assert.deepEqual(digestOf(content), artifact.digest);
			const evidence = JSON.parse(content) as { ok: boolean; command: string; revision: string };
			assert.equal(evidence.ok, index === 1);
			assert.equal(evidence.command, "git diff --check HEAD");
			assert.match(evidence.revision, /^[a-f0-9]{40}$/);
		}
	});

	it("invalid config fails before repository mutation", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pelaggio-la-"));
		temps.push(cwd);
		execFileSync("git", ["init", "-b", "main"], { cwd });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
		execFileSync("git", ["config", "user.name", "test"], { cwd });
		writeFileSync(join(cwd, "README.md"), "consumer\n");
		execFileSync("git", ["add", "README.md"], { cwd });
		execFileSync("git", ["commit", "-m", "init"], { cwd });
		mkdirSync(join(cwd, ".pelaggio"));
		writeFileSync(join(cwd, ".pelaggio", "pelaggio.yml"), "harness:\n  adapter: fake\n  surprise: true\n");
		const before = execFileSync("git", ["worktree", "list"], { cwd, encoding: "utf8" });
		const result = await startRun(cwd, { task: { text: "hello" }, nonInteractive: true });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.problem.type, "config");
		assert.equal(execFileSync("git", ["worktree", "list"], { cwd, encoding: "utf8" }), before);
	});

	it("a required decision produces a resumable typed pause", async () => {
		const { cwd } = consumer(`      - { action: decision, code: choose-export, message: "Choose the public export name." }\n`);
		const result = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.state, "paused");
		assert.equal(result.value.pauseReason?.code, "decision_required");
		const shown = getRun(cwd, result.value.runId);
		assert.equal(shown.ok, true);
		if (!shown.ok) return;
		assert.equal(shown.value.runId, result.value.runId);
	});

	it("decision pause then resume yields a valid ready_for_review snapshot", async () => {
		const { cwd } = consumer(`      - { action: decision, code: choose-export, message: "Choose the public export name." }\n${SUCCESS_SCRIPT}`);
		const paused = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true });
		assert.equal(paused.ok, true);
		if (!paused.ok) return;
		assert.equal(paused.value.state, "paused");
		assert.equal(paused.value.pauseReason?.code, "decision_required");
		assert.equal(
			paused.value.problems.some((problem) => problem.type === "decision"),
			true,
		);
		const resumed = await continueRun(cwd, paused.value.runId);
		assert.equal(resumed.ok, true);
		if (!resumed.ok) return;
		assert.equal(resumed.value.disposition, "ready_for_review");
		assert.equal(
			resumed.value.problems.some((problem) => problem.type === "decision"),
			false,
		);
		const shown = getRun(cwd, resumed.value.runId);
		assert.equal(shown.ok, true);
		if (!shown.ok) return;
		assert.equal(shown.value.disposition, "ready_for_review");
		assert.equal(shown.value.state, "completed");
	});

	it("verification-budget pause then passing resume yields a valid ready_for_review snapshot", async () => {
		const { cwd } = consumer(`      - { action: verify-fail, message: "tests red" }\n${SUCCESS_SCRIPT}`, 0);
		const paused = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true });
		assert.equal(paused.ok, true);
		if (!paused.ok) return;
		assert.equal(paused.value.state, "paused");
		assert.equal(paused.value.pauseReason?.code, "verification_budget");
		assert.equal(
			paused.value.problems.some((problem) => problem.type === "verification"),
			true,
		);
		const resumed = await continueRun(cwd, paused.value.runId);
		assert.equal(resumed.ok, true);
		if (!resumed.ok) return;
		assert.equal(resumed.value.disposition, "ready_for_review");
		assert.equal(
			resumed.value.problems.some((problem) => problem.type === "verification"),
			false,
		);
		const shown = getRun(cwd, resumed.value.runId);
		assert.equal(shown.ok, true);
		if (!shown.ok) return;
		assert.equal(shown.value.disposition, "ready_for_review");
		assert.equal(
			shown.value.artifacts.some((artifact) => artifact.kind === "verification"),
			true,
		);
	});

	it("repeated decision pauses drop only the live pause problem and keep separately emitted ones", async () => {
		const { cwd } = consumer(`      - { action: decision, code: choose-export, message: "Choose the public export name." }\n      - { action: decision, code: choose-style, message: "Choose a style." }\n${SUCCESS_SCRIPT}`);
		const first = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true });
		assert.equal(first.ok, true);
		if (!first.ok) return;
		assert.equal(first.value.pauseReason?.code, "decision_required");
		const lastSeq = JSON.parse(readFileSync(eventsPath(cwd, first.value.runId), "utf8").trim().split("\n").at(-1) ?? "{}") as { seq?: number };
		appendFileSync(
			eventsPath(cwd, first.value.runId),
			`${JSON.stringify({
				schemaVersion: 1,
				eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
				runId: first.value.runId,
				seq: (lastSeq.seq ?? 0) + 1,
				type: "pelaggio.local-autopilot.problem",
				at: "2026-09-04T12:00:06.000Z",
				payload: {
					problem: {
						schemaVersion: 1,
						type: "protocol",
						code: "note",
						message: "operator note",
						retryable: false,
						runId: first.value.runId,
					},
				},
			})}\n`,
		);
		const noted = getRun(cwd, first.value.runId);
		assert.equal(noted.ok, true);
		if (!noted.ok) return;
		assert.equal(
			noted.value.problems.some((problem) => problem.type === "decision"),
			true,
		);
		assert.equal(
			noted.value.problems.some((problem) => problem.code === "note"),
			true,
		);
		const second = await continueRun(cwd, first.value.runId);
		assert.equal(second.ok, true);
		if (!second.ok) return;
		assert.equal(second.value.state, "paused");
		assert.equal(second.value.pauseReason?.code, "decision_required");
		assert.equal(
			second.value.problems.some((problem) => problem.code === "choose-style"),
			true,
		);
		assert.equal(
			second.value.problems.some((problem) => problem.code === "choose-export"),
			false,
		);
		assert.equal(
			second.value.problems.some((problem) => problem.code === "note"),
			true,
		);
		const completed = await continueRun(cwd, second.value.runId);
		assert.equal(completed.ok, true);
		if (!completed.ok) return;
		assert.equal(completed.value.disposition, "ready_for_review");
		assert.equal(
			completed.value.problems.some((problem) => problem.type === "decision"),
			false,
		);
		assert.equal(
			completed.value.problems.some((problem) => problem.code === "note"),
			true,
		);
		const shown = getRun(cwd, completed.value.runId);
		assert.equal(shown.ok, true);
		if (!shown.ok) return;
		assert.equal(shown.value.disposition, "ready_for_review");
		assert.equal(
			shown.value.problems.some((problem) => problem.code === "note"),
			true,
		);
	});

	it("failed verification repairs within the bound or pauses for budget exhaustion", async () => {
		const { cwd } = consumer(`      - { action: verify-fail, message: "tests red" }\n      - { action: write, path: src/hello.ts, content: "export const hello = 1;" }\n      - { action: complete }\n`, 1);
		const result = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.disposition, "ready_for_review");
		assert.equal(result.value.execution.mode, "host");
		assert.equal(result.value.execution.effectsEnforced, false);
		assert.equal(
			result.value.artifacts.some((artifact) => artifact.kind === "verification"),
			true,
		);
		assert.equal(result.value.metrics?.repairAttempts, 1);
	});

	it("requires explicit host consent and configured verification before mutation", async () => {
		const { cwd } = consumer(SUCCESS_SCRIPT);
		writeFileSync(join(cwd, ".pelaggio", "pelaggio.yml"), "harness:\n  adapter: fake\n  fake:\n    script:\n      - { action: complete }\nautopilot:\n  verification:\n    command: git diff --check HEAD\n");
		const before = execFileSync("git", ["worktree", "list"], { cwd, encoding: "utf8" });
		const contained = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true });
		assert.equal(contained.ok, false);
		if (contained.ok) return;
		assert.equal(contained.problem.code, "contained-unavailable");
		assert.equal(execFileSync("git", ["worktree", "list"], { cwd, encoding: "utf8" }), before);

		writeFileSync(join(cwd, ".pelaggio", "pelaggio.yml"), "harness:\n  adapter: fake\n  fake:\n    script:\n      - { action: complete }\nexecution:\n  mode: host\n");
		const unverified = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true });
		assert.equal(unverified.ok, false);
		if (unverified.ok) return;
		assert.equal(unverified.problem.code, "missing-verification");
		assert.equal(execFileSync("git", ["worktree", "list"], { cwd, encoding: "utf8" }), before);
	});

	it("harness failure preserves inspectable state", async () => {
		const { cwd } = consumer(`      - { action: crash, message: "boom" }\n`);
		const result = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.disposition, "failed");
		const shown = getRun(cwd, result.value.runId);
		assert.equal(shown.ok, true);
		if (!shown.ok) return;
		assert.equal(shown.value.runId, result.value.runId);
		assert.equal(shown.value.worktree?.branch.startsWith("pelaggio/"), true);
	});

	it("interrupt checkpoints and resume keeps the same runId", async () => {
		const { cwd } = consumer(`      - { action: write, path: src/hello.ts, content: "export const hello = 1;" }\n      - { action: complete }\n`);
		const controller = new AbortController();
		controller.abort();
		const paused = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true }, { signal: controller.signal });
		assert.equal(paused.ok, true);
		if (!paused.ok) return;
		assert.equal(paused.value.state, "paused");
		assert.equal(paused.value.pauseReason?.code, "interrupted");
		const resumed = await continueRun(cwd, paused.value.runId);
		assert.equal(resumed.ok, true);
		if (!resumed.ok) return;
		assert.equal(resumed.value.runId, paused.value.runId);
		assert.equal(resumed.value.disposition, "ready_for_review");
	});

	it("an in-flight interrupt pauses after the adapter acknowledges cancellation", async () => {
		const { cwd } = consumer(SUCCESS_SCRIPT);
		const controller = new AbortController();
		let observedNonInteractive = false;
		const adapter = {
			name: "fake" as const,
			async next(ctx: HarnessContext) {
				observedNonInteractive = ctx.nonInteractive;
				await new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true }));
				return { action: { kind: "complete" as const }, cursor: 1 };
			},
		};
		const pending = startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true }, { signal: controller.signal, adapters: { fake: adapter, grok: adapter as never } });
		setTimeout(() => controller.abort(), 10);
		const paused = await pending;
		assert.equal(paused.ok, true);
		if (!paused.ok) return;
		assert.equal(observedNonInteractive, true);
		assert.equal(paused.value.state, "paused");
		assert.equal(paused.value.pauseReason?.code, "interrupted");
	});

	it("refuses cancellation and resume even after the live run lease deadline", async (t) => {
		const { cwd } = consumer(SUCCESS_SCRIPT);
		const controller = new AbortController();
		let entered!: () => void;
		const active = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const adapter = {
			name: "fake" as const,
			async next(ctx: HarnessContext) {
				entered();
				await new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true }));
				return { action: { kind: "complete" as const }, cursor: 1 };
			},
		};
		const pending = startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true, requestId: "active-run" }, { signal: controller.signal, adapters: { fake: adapter, grok: adapter as never } });
		await active;
		const index = JSON.parse(readFileSync(join(cwd, ".pelaggio", "runs", "by-request", "active-run"), "utf8")) as { runId: string };
		const later = Date.now() + 31 * 60_000;
		t.mock.method(Date, "now", () => later);
		try {
			const cancelled = await cancelRun(cwd, index.runId);
			assert.equal(cancelled.ok, false);
			if (!cancelled.ok) assert.equal(cancelled.problem.code, "run-active");
			const resumed = await continueRun(cwd, index.runId);
			assert.equal(resumed.ok, false);
			if (!resumed.ok) assert.equal(resumed.problem.code, "run-active");
		} finally {
			t.mock.restoreAll();
			controller.abort();
			await pending;
		}
	});

	it("turns a truncated journal tail into an inspectable protocol problem", async () => {
		const { cwd } = consumer(SUCCESS_SCRIPT);
		const result = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		appendFileSync(eventsPath(cwd, result.value.runId), '{"schemaVersion":');
		const shown = getRun(cwd, result.value.runId);
		assert.equal(shown.ok, false);
		if (!shown.ok) assert.equal(shown.problem.code, "journal-invalid");
	});

	it("duplicate requestId returns the existing run; conflicting content is a typed conflict", async () => {
		const { cwd } = consumer(SUCCESS_SCRIPT);
		const first = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true, requestId: "req-1" });
		assert.equal(first.ok, true);
		if (!first.ok) return;
		const dup = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true, requestId: "req-1" });
		assert.equal(dup.ok, true);
		if (!dup.ok) return;
		assert.equal(dup.value.runId, first.value.runId);
		const conflict = await startRun(cwd, { task: { text: "Something else" }, nonInteractive: true, requestId: "req-1" });
		assert.equal(conflict.ok, false);
		if (conflict.ok) return;
		assert.equal(conflict.problem.type, "conflict");
	});

	it("concurrent duplicate requestIds atomically converge on one run", async () => {
		const { cwd } = consumer(SUCCESS_SCRIPT);
		const before = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
		const [first, second] = await Promise.all([startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true, requestId: "same-request" }), startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true, requestId: "same-request" })]);
		assert.equal(first.ok, true);
		assert.equal(second.ok, true);
		if (!first.ok || !second.ok) return;
		assert.equal(first.value.runId, second.value.runId);
		const after = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
		assert.equal(after.split("\nworktree ").length, before.split("\nworktree ").length + 1);
	});

	it("rejects path-shaped request and run IDs before filesystem access", async () => {
		const { cwd } = consumer(SUCCESS_SCRIPT);
		const escaped = join(cwd, "escaped.json");
		const start = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true, requestId: "../../../escaped.json" });
		assert.equal(start.ok, false);
		assert.equal(existsSync(escaped), false);
		const shown = getRun(cwd, "../../../escaped.json");
		assert.equal(shown.ok, false);
	});

	it("JSON and human transports return semantically equivalent snapshots", async () => {
		const { cwd } = consumer(SUCCESS_SCRIPT);
		const result = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		const json = presentJson(result.value);
		assert.equal(looksLikeAnsi(json), false);
		assert.equal(json.split("\n").filter(Boolean).length, 1);
		const parsed = JSON.parse(json);
		assert.equal(parsed.runId, result.value.runId);
		assert.equal(parsed.disposition, "ready_for_review");
		const human = presentHuman(result.value);
		assert.match(human, new RegExp(result.value.runId));
		assert.match(human, /ready_for_review/);
	});

	it("cancel completes the same run as cancelled", async () => {
		const { cwd } = consumer(`      - { action: decision, code: choose-export, message: "Choose." }\n`);
		const paused = await startRun(cwd, { task: { text: "Add hello" }, nonInteractive: true });
		assert.equal(paused.ok, true);
		if (!paused.ok) return;
		const cancelled = await cancelRun(cwd, paused.value.runId);
		assert.equal(cancelled.ok, true);
		if (!cancelled.ok) return;
		assert.equal(cancelled.value.runId, paused.value.runId);
		assert.equal(cancelled.value.disposition, "cancelled");
	});

	it("share-safe metrics omit task content", async () => {
		const { cwd } = consumer(SUCCESS_SCRIPT);
		const result = await startRun(cwd, { task: { text: "SECRET-TICKET-TEXT" }, nonInteractive: true });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		const metrics = JSON.stringify(result.value.metrics);
		assert.equal(metrics.includes("SECRET-TICKET-TEXT"), false);
		assert.equal(metrics.includes(cwd), false);
	});
});

it("keeps request mapping IDs disjoint from request lock names", async () => {
	const { cwd } = consumer(`      - { action: complete }\n`);
	const requestId = "request-two";
	const collisionId = `lock-${digestOf(requestId).value}`;
	const first = await startRun(cwd, { task: { text: "one" }, requestId: collisionId, nonInteractive: true });
	assert.ok(first.ok);
	const second = await startRun(cwd, { task: { text: "two" }, requestId, nonInteractive: true });
	assert.ok(second.ok);
	const again = await startRun(cwd, { task: { text: "one" }, requestId: collisionId, nonInteractive: true });
	assert.ok(again.ok);
	if (first.ok && again.ok) assert.equal(again.value.runId, first.value.runId);
});

it("holds the run lease before publishing its first journal record", async () => {
	const { cwd } = consumer(`      - { action: complete }\n`);
	let observed = false;
	const result = await startRun(
		cwd,
		{ task: { text: "task" }, requestId: "publication", nonInteractive: true },
		{
			now: () => {
				const root = join(cwd, ".pelaggio", "runs");
				if (existsSync(root)) {
					for (const entry of readdirSync(root)) {
						if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(entry)) continue;
						if (existsSync(join(root, entry, "events.jsonl"))) continue;
						assert.ok(existsSync(join(root, entry, "lease")));
						observed = true;
					}
				}
				return new Date().toISOString();
			},
		},
	);
	assert.ok(result.ok);
	assert.ok(observed);
});

for (const boundary of ["harness-finished", "verification-finished"]) {
	it(`resumes after ${boundary} without replaying acknowledged work`, async () => {
		const { cwd } = consumer(`      - { action: complete }\n`, 0);
		const initial = await startRun(cwd, { task: { text: "task" }, nonInteractive: true });
		assert.ok(initial.ok);
		if (!initial.ok) return;
		const path = eventsPath(cwd, initial.value.runId);
		const events = readRunEvents(cwd, initial.value.runId);
		const index = events.findIndex((event) => event.type.endsWith(`.${boundary}`));
		assert.ok(index >= 0);
		writeFileSync(
			path,
			`${events
				.slice(0, index + 1)
				.map((event) => JSON.stringify(event))
				.join("\n")}\n`,
		);
		if (boundary === "verification-finished") {
			const config = join(cwd, ".pelaggio", "pelaggio.yml");
			writeFileSync(config, readFileSync(config, "utf8").replace("git diff --check HEAD", "exit 1"));
		}
		const resumed = await continueRun(cwd, initial.value.runId, {
			adapters: {
				fake: {
					name: "fake",
					async next() {
						throw new Error("acknowledged harness replayed");
					},
				},
			},
		});
		assert.ok(resumed.ok, JSON.stringify(resumed));
		if (resumed.ok) {
			if (boundary === "verification-finished") {
				assert.equal(resumed.value.state, "paused");
				assert.equal(resumed.value.pauseReason?.code, "verification_budget");
			} else assert.equal(resumed.value.disposition, "ready_for_review");
			assert.equal(resumed.value.metrics?.harnessCalls, 1);
			assert.equal(resumed.value.metrics?.verificationPasses, 1);
		}
	});
}

for (const boundary of ["verification-finished", "repair-attempted"]) {
	it(`restores repair failure context and count after ${boundary}`, async () => {
		const { cwd } = consumer(`      - { action: verify-fail, message: "specific failure" }\n      - { action: complete }\n`);
		const initial = await startRun(cwd, { task: { text: "task" }, nonInteractive: true });
		assert.ok(initial.ok);
		if (!initial.ok) return;
		const events = readRunEvents(cwd, initial.value.runId);
		const index = events.findIndex((event) => event.type.endsWith(`.${boundary}`));
		assert.ok(index >= 0);
		writeFileSync(
			eventsPath(cwd, initial.value.runId),
			`${events
				.slice(0, index + 1)
				.map((event) => JSON.stringify(event))
				.join("\n")}\n`,
		);
		let calls = 0;
		const resumed = await continueRun(cwd, initial.value.runId, {
			adapters: {
				fake: {
					name: "fake",
					async next(ctx) {
						calls++;
						assert.equal(ctx.verificationFailure, "specific failure");
						return { action: { kind: "complete" }, cursor: ctx.cursor + 1 };
					},
				},
			},
		});
		assert.ok(resumed.ok, JSON.stringify(resumed));
		assert.equal(calls, 1);
		if (resumed.ok) assert.equal(resumed.value.metrics?.repairAttempts, 1);
	});
}

it("interrupts async verification and resumes it without replaying the provider", { timeout: 10_000 }, async () => {
	const { cwd } = consumer(`      - { action: complete }\n`);
	const configPath = join(cwd, ".pelaggio", "pelaggio.yml");
	const originalConfig = readFileSync(configPath, "utf8");
	const marker = join(cwd, "verification-started");
	const script = join(cwd, "verification.cjs");
	writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); setInterval(() => {}, 1000);`);
	const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
	writeFileSync(configPath, originalConfig.replace("git diff --check HEAD", JSON.stringify(command)));
	const controller = new AbortController();
	const pending = startRun(cwd, { task: { text: "task" }, nonInteractive: true }, { signal: controller.signal });
	try {
		for (let i = 0; i < 100 && !existsSync(marker); i++) await delay(20);
		assert.ok(existsSync(marker), "verification child started");
		controller.abort();
		const paused = await pending;
		assert.ok(paused.ok, JSON.stringify(paused));
		if (!paused.ok) return;
		assert.equal(paused.value.state, "paused");
		assert.equal(paused.value.pauseReason?.code, "interrupted");
		assert.equal(paused.value.metrics?.verificationPasses, 0);
		writeFileSync(configPath, originalConfig);
		const resumed = await continueRun(cwd, paused.value.runId, {
			adapters: {
				fake: {
					name: "fake",
					async next() {
						throw new Error("provider replayed after verification interrupt");
					},
				},
			},
		});
		assert.ok(resumed.ok, JSON.stringify(resumed));
		if (resumed.ok) {
			assert.equal(resumed.value.disposition, "ready_for_review");
			assert.equal(resumed.value.metrics?.harnessCalls, 1);
			assert.equal(resumed.value.metrics?.verificationPasses, 1);
		}
	} finally {
		controller.abort();
		await pending;
	}
});

it("reauthorizes current policy on resume instead of inheriting earlier host consent", async () => {
	const { cwd } = consumer(`      - { action: decision, code: choose, message: "Choose" }\n      - { action: complete }\n`);
	const paused = await startRun(cwd, { task: { text: "task" }, nonInteractive: true });
	assert.ok(paused.ok);
	if (!paused.ok) return;
	execFileSync("git", ["add", ".pelaggio/pelaggio.yml"], { cwd });
	const before = readFileSync(eventsPath(cwd, paused.value.runId), "utf8");
	const refused = await continueRun(cwd, paused.value.runId);
	assert.equal(refused.ok, false);
	if (!refused.ok) assert.equal(refused.problem.code, "host-consent-required");
	assert.equal(readFileSync(eventsPath(cwd, paused.value.runId), "utf8"), before);
	const resumed = await continueRun(cwd, paused.value.runId, { allowHostExecution: true });
	assert.ok(resumed.ok, JSON.stringify(resumed));
	if (resumed.ok) assert.equal(resumed.value.disposition, "ready_for_review");
});

for (const action of [
	{ action: "decision", code: "choose", message: "Choose explicitly" },
	{ action: "crash", message: "provider crashed" },
	{ action: "verify-fail", message: "forced verification failure" },
	{ action: "complete" },
] as const) {
	it(`recovers the acknowledged ${action.action} outcome without replaying the provider`, async () => {
		const { cwd } = consumer(`      - ${JSON.stringify(action)}\n      - { action: complete }\n`, 0);
		const initial = await startRun(cwd, { task: { text: "task" }, nonInteractive: true });
		assert.ok(initial.ok, JSON.stringify(initial));
		if (!initial.ok) return;
		const events = readRunEvents(cwd, initial.value.runId);
		const index = events.findIndex((event) => event.type.endsWith(".fake-progress"));
		assert.ok(index >= 0);
		assert.equal((events[index]?.payload?.action as { kind?: string })?.kind, action.action);
		writeFileSync(
			eventsPath(cwd, initial.value.runId),
			`${events
				.slice(0, index + 1)
				.map((event) => JSON.stringify(event))
				.join("\n")}\n`,
		);
		const resumed = await continueRun(cwd, initial.value.runId, {
			adapters: {
				fake: {
					name: "fake",
					async next() {
						throw new Error("acknowledged provider call replayed");
					},
				},
			},
		});
		assert.ok(resumed.ok, JSON.stringify(resumed));
		if (!resumed.ok) return;
		if (action.action === "decision") {
			assert.equal(resumed.value.pauseReason?.code, "decision_required");
			assert.equal(resumed.value.pauseReason?.message, action.message);
			const resolved = await continueRun(cwd, initial.value.runId);
			assert.ok(resolved.ok, JSON.stringify(resolved));
			if (resolved.ok) assert.equal(resolved.value.disposition, "ready_for_review");
		} else if (action.action === "crash") {
			assert.equal(resumed.value.disposition, "failed");
			assert.equal(resumed.value.problems[0]?.message, action.message);
		} else if (action.action === "verify-fail") {
			assert.equal(resumed.value.pauseReason?.code, "verification_budget");
			assert.equal(resumed.value.pauseReason?.message, action.message);
		} else assert.equal(resumed.value.disposition, "ready_for_review");
	});
}

it("re-verifies changed worktree contents after recovering a successful verification", async () => {
	const { cwd } = consumer(`      - { action: complete }\n`, 0);
	const policy = join(cwd, ".pelaggio", "pelaggio.yml");
	writeFileSync(policy, readFileSync(policy, "utf8").replace("git diff --check HEAD", "git diff --quiet HEAD"));
	const initial = await startRun(cwd, { task: { text: "task" }, nonInteractive: true });
	assert.ok(initial.ok);
	if (!initial.ok) return;
	const events = readRunEvents(cwd, initial.value.runId);
	const index = events.findIndex((event) => event.type.endsWith(".verification-finished"));
	assert.ok(index >= 0);
	writeFileSync(
		eventsPath(cwd, initial.value.runId),
		`${events
			.slice(0, index + 1)
			.map((event) => JSON.stringify(event))
			.join("\n")}\n`,
	);
	assert.ok(initial.value.worktree?.path);
	writeFileSync(join(initial.value.worktree.path, "README.md"), "changed since verification");
	const resumed = await continueRun(cwd, initial.value.runId, {
		adapters: {
			fake: {
				name: "fake",
				async next() {
					throw new Error("provider replayed");
				},
			},
		},
	});
	assert.ok(resumed.ok, JSON.stringify(resumed));
	if (resumed.ok) {
		assert.equal(resumed.value.state, "paused");
		assert.equal(resumed.value.pauseReason?.code, "verification_budget");
	}
});
