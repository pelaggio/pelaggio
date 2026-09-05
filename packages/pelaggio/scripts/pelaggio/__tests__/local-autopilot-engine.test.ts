import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cancelRun, continueRun, getRun, startRun } from "../local-autopilot/engine.js";
import type { HarnessContext } from "../local-autopilot/harness.js";
import { eventsPath } from "../local-autopilot/paths.js";
import { presentHuman, presentJson } from "../local-autopilot/present.js";
import { looksLikeAnsi } from "../local-autopilot/transport.js";

const temps: string[] = [];
after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function consumer(script: string, maxRepairs = 1): { cwd: string; ticket: string } {
	const cwd = mkdtempSync(join(tmpdir(), "pelaggio-la-"));
	temps.push(cwd);
	execFileSync("git", ["init", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "test"], { cwd });
	writeFileSync(join(cwd, "README.md"), "consumer\n");
	execFileSync("git", ["add", "README.md"], { cwd });
	execFileSync("git", ["commit", "-m", "init"], { cwd });
	mkdirSync(join(cwd, ".pelaggio"));
	writeFileSync(join(cwd, ".pelaggio", "pelaggio.yml"), `harness:\n  adapter: fake\n  fake:\n    script:\n${script}execution:\n  mode: host\nautopilot:\n  maxRepairs: ${maxRepairs}\n  verification:\n    command: git diff --check HEAD\n`);
	writeFileSync(join(cwd, "ticket.md"), "Add a hello export\n\nCreate src/hello.ts that exports hello = 1.\n");
	return { cwd, ticket: join(cwd, "ticket.md") };
}

const SUCCESS_SCRIPT = `      - { action: write, path: src/hello.ts, content: "export const hello = 1;" }\n      - { action: complete }\n`;

describe("local autopilot engine", () => {
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

	it("refuses cancellation while the run lease is active instead of racing completion", async () => {
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
		const cancelled = await cancelRun(cwd, index.runId);
		assert.equal(cancelled.ok, false);
		if (!cancelled.ok) assert.equal(cancelled.problem.code, "run-active");
		controller.abort();
		await pending;
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
