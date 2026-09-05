import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { logPathFor } from "../config.js";
import { codexAdapter, createCodexAdapter } from "../local-autopilot/codex-adapter.js";
import { createGrokAdapter, grokAdapter } from "../local-autopilot/grok-adapter.js";
import { parseWorkContract } from "../local-autopilot/parse.js";
import { createStepDispatcher } from "../step-runner.js";
import type { StepResult } from "../types.js";
import { measureUsage } from "../usage-measurement.js";

const dirs: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "pelaggio-usage-wiring-"));
	dirs.push(dir);
	return dir;
}
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const result: StepResult = { ok: true, subtype: "success", text: "done", fullText: "done", assistantText: "done", cost: 1, turns: 1, tokens: { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 } };

describe("usage measurement wiring", () => {
	it("dispatches to the selected provider and measures only dispatcher input", async () => {
		const prompt = "task 😀";
		let forwarded = "";
		const dispatch = createStepDispatcher((provider) => {
			assert.equal(provider, "codex");
			return async (_name, text) => {
				forwarded = text;
				return { ...result, usageMeasurement: measureUsage("codex", { input_tokens: 10, output_tokens: 2 }) };
			};
		});
		const measured = await dispatch(
			"implement",
			prompt,
			{ cwd: temp(), profile: "standard", trace: false, executionOverride: { provider: "codex" }, parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" }, onProviderObservation: () => {} },
			() => {},
		);
		assert.equal(forwarded, prompt);
		assert.equal(measured.usageMeasurement?.promptBoundary, "dispatcher-input");
		assert.equal(measured.usageMeasurement?.promptBytes, Buffer.byteLength(prompt));
		assert.equal(measured.usageMeasurement?.inputTokens, 10);
		assert.deepEqual(measured.tokens, result.tokens);
		assert.equal(measured.cost, result.cost);
	});

	it("keeps a provider result when optional diagnostic measurement throws", async () => {
		const returned = { ...result };
		Object.defineProperty(returned, "usageMeasurement", {
			get() {
				throw new Error("diagnostic failure");
			},
		});
		const dispatch = createStepDispatcher(() => async () => returned);
		const measured = await dispatch("implement", "task", { cwd: temp(), profile: "standard", trace: false, parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" }, onProviderObservation: () => {} }, () => {});
		assert.equal(measured, returned);
	});

	for (const adapter of [grokAdapter, codexAdapter]) {
		it(`measures the actual consumer ${adapter.name} prompt including harness instructions`, async () => {
			const cwd = temp();
			const capture = join(cwd, "invocation.json");
			const bin = join(cwd, "fake-grok");
			writeFileSync(
				bin,
				`#!/usr/bin/env node\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nconst prompt = args.at(-1) === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(args.at(-1), "utf8");\nfs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, prompt }));\n`,
			);
			chmodSync(bin, 0o755);
			const fixture = JSON.parse(readFileSync(new URL("./fixtures/local-autopilot/snapshot-ready-for-review.json", import.meta.url), "utf8"));
			const parsed = parseWorkContract(fixture.workContract);
			assert.ok(parsed.ok);
			if (!parsed.ok) return;
			const ctx = { cwd, worktree: cwd, cursor: 0, nonInteractive: true, workContract: parsed.value, config: { harness: { adapter: adapter.name, [adapter.name]: { bin, model: "test-model" } } } };
			for (const suffix of ["", " more context 😀"]) {
				const call = await adapter.next({ ...ctx, workContract: { ...ctx.workContract, body: ctx.workContract.body + suffix } });
				assert.equal(call.action.kind, "complete");
				const invocation: unknown = JSON.parse(readFileSync(capture, "utf8"));
				assert.ok(invocation && typeof invocation === "object");
				if (!invocation || typeof invocation !== "object") return;
				const { args, prompt } = invocation as { args?: unknown; prompt?: unknown };
				assert.ok(Array.isArray(args));
				if (!Array.isArray(args)) return;
				if (adapter.name === "codex") assert.equal(args.at(-1), "-");
				else assert.equal(args.at(-2), "--prompt-file");
				assert.equal(typeof prompt, "string");
				if (typeof prompt !== "string") return;
				assert.match(prompt, /Do not push/);
				assert.ok(prompt.includes(ctx.workContract.body + suffix));
				assert.equal(call.usageMeasurement?.promptBytes, Buffer.byteLength(prompt));
				assert.equal(call.usageMeasurement?.promptBoundary, "adapter-assembled");
				assert.equal(call.usageMeasurement?.inputTokens, undefined);
			}
		});
	}

	for (const makeAdapter of [createCodexAdapter, createGrokAdapter]) {
		it(`${makeAdapter.name} still invokes the harness when byte measurement fails`, async (t) => {
			let called = false;
			const adapter = makeAdapter(async () => {
				called = true;
				return { ok: true, output: "" };
			});
			const fixture = JSON.parse(readFileSync(new URL("./fixtures/local-autopilot/snapshot-ready-for-review.json", import.meta.url), "utf8"));
			const contract = parseWorkContract(fixture.workContract);
			assert.ok(contract.ok);
			t.mock.method(Buffer, "byteLength", () => {
				throw new Error("measurement unavailable");
			});
			const result = await adapter.next({ cwd: "/repo", worktree: "/repo", cursor: 0, nonInteractive: true, workContract: contract.value, config: { harness: { adapter: adapter.name } } });
			t.mock.restoreAll();
			assert.equal(called, true);
			assert.equal(result.action.kind, "complete");
			assert.equal(result.usageMeasurement, undefined);
		});
	}

	it("runs stats --usage against malformed and valid persisted cycle records", () => {
		const cwd = temp();
		const log = logPathFor(cwd);
		mkdirSync(dirname(log), { recursive: true });
		const records = [
			{ ts: { toString: null }, cycle: [1], steps: [{ name: "implement", attempt: { toString: null } }] },
			{ ts: "now", cycle: 2, steps: [{ name: "implement", usageMeasurement: measureUsage("codex", { input_tokens: 10, output_tokens: 2 }) }] },
		];
		writeFileSync(log, records.map((record) => JSON.stringify(record)).join("\n") + "\nnot-json\n");
		const bin = fileURLToPath(new URL("../../../bin/pelaggio.js", import.meta.url));
		const invoke = (args: string[]) => spawnSync(process.execPath, [bin, "stats", "--usage", ...args], { cwd, encoding: "utf8", env: { ...process.env, PELAGGIO_REPO: cwd, NO_COLOR: "1" } });
		const json = invoke(["--json"]);
		assert.equal(json.status, 0, json.stderr);
		const report = JSON.parse(json.stdout);
		assert.equal(report.observations, 2);
		assert.equal(report.malformedRecords, 1);
		assert.equal(report.totals.inputTokens.value, 10);
		assert.equal(report.totals.inputTokens.observed, 1);
		assert.equal(report.attempts[0].attempt, "1");
		const human = invoke([]);
		assert.equal(human.status, 0, human.stderr);
		assert.match(human.stdout, /Unreadable records: 1/);
		assert.equal(readFileSync(log, "utf8"), records.map((record) => JSON.stringify(record)).join("\n") + "\nnot-json\n");
	});
});
