import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseCli } from "../cli.js";
import type { RunEvent } from "../local-autopilot/types.js";
import { localMetricsUsage, localUsageReport } from "../local-autopilot/usage.js";
import { buildCodexStepResult } from "../providers/codex.js";
import { measurePrompt, measureUsage, readUsageMeasurement } from "../usage-measurement.js";
import { buildUsageReport, cycleUsageRows, renderUsageReport, type UsageRow } from "../usage-report.js";

const claude = () => measureUsage("claude", { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 600, cache_creation_input_tokens: 300 });
const row = (id: string, measurement = claude()): UsageRow => ({ id, run: "run-1", attempt: "1", provider: "claude", model: "test", step: "implement", measurement });
const event = (id: string, type: string, payload?: Record<string, unknown>): RunEvent => ({
	schemaVersion: 1,
	eventId: id,
	runId: "run-1",
	seq: Number(id),
	at: "2026-09-05T00:00:00.000Z",
	type: `pelaggio.local-autopilot.${type}`,
	payload,
});

describe("diagnostic token accounting", () => {
	it("includes Claude cache writes in total input and the cache-read denominator", () => {
		const report = buildUsageReport([row("1")]);
		assert.equal(report.totals.inputTokens.value, 1000);
		assert.equal(report.totals.cacheReadFraction.value, 0.6);
		assert.equal(report.totals.outputTokens.value, 20);
	});
	it("reads the captured Codex fixture without adding cached or reasoning subsets", () => {
		const events = readFileSync(new URL("./fixtures/codex-events-success.jsonl", import.meta.url), "utf8")
			.trim()
			.split("\n")
			.map((s) => JSON.parse(s));
		const result = buildCodexStepResult("implement", events, { exitCode: 0 }).result;
		assert.equal(result.usageMeasurement?.inputTokens, 12947);
		assert.equal(result.usageMeasurement?.cacheReadTokens, 9600);
		assert.equal(result.usageMeasurement?.outputTokens, 5);
		const measured = measureUsage("codex", { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 12 });
		assert.equal(measured.outputTokens, 20);
		assert.equal(measured.reasoningTokens, 12);
		assert.equal(measured.cacheWriteTokens, undefined);
		// Legacy operational accounting is deliberately not changed by this diagnostic.
		assert.equal(result.tokens?.input, 12947);
	});
	it("does not guess whether multiple terminal events are cumulative or incremental", () => {
		const finish = { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } };
		const result = buildCodexStepResult("implement", [finish, finish], { exitCode: 0 }).result;
		assert.equal(result.usageMeasurement?.inputTokens, undefined);
		assert.equal(result.usageMeasurement?.basis, "unverified");
	});
	it("preserves missingness, actual zero, and numeric-only raw evidence", () => {
		assert.equal(measureUsage("claude", { input_tokens: 10, output_tokens: 0 }).inputTokens, undefined);
		assert.equal(measureUsage("claude", { output_tokens: 0 }).outputTokens, 0);
		const measured = measureUsage("grok", { inputTokens: 55, reasoningTokens: 10, secret: "do-not-record", outputTokens: "30" });
		assert.deepEqual(measured, { schemaVersion: 1, basis: "unverified", rawCounters: { input: 55, reasoning: 10 } });
		const report = buildUsageReport([row("1", measured)]);
		assert.equal(report.totals.inputTokens.value, null);
		assert.equal(report.totals.inputTokens.observed, 0);
	});
	it("rejects invalid/overflow counters and incompatible breakdowns without throwing", () => {
		for (const value of [-1, NaN, Infinity, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) assert.equal(measureUsage("codex", { input_tokens: value }).inputTokens, undefined);
		assert.equal(measureUsage("claude", { input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 }).inputTokens, undefined);
		assert.equal(measureUsage("codex", { input_tokens: 1, cached_input_tokens: 2 }).cacheReadTokens, undefined);
		assert.equal(readUsageMeasurement({ schemaVersion: 99 }), undefined);
		assert.equal(readUsageMeasurement({ schemaVersion: 1, basis: "unverified", inputTokens: 100 })?.inputTokens, undefined);
	});
	it("rejects malformed JSON basis values without coercion", () => {
		for (const basis of [{ toString: null }, ["codex-cli-v1"], null, 1]) {
			assert.equal(readUsageMeasurement(JSON.parse(JSON.stringify({ schemaVersion: 1, basis, inputTokens: 10 }))), undefined);
		}
	});
	it("separates byte boundaries and preserves unknown historical boundaries", () => {
		const dispatcher = measurePrompt("task", "dispatcher-input");
		const assembled = measurePrompt("task\nextra harness instructions", "adapter-assembled");
		const report = buildUsageReport([row("1", dispatcher), row("2", assembled), row("3", { schemaVersion: 1, basis: "unverified", promptBytes: 4 })]);
		assert.deepEqual(
			report.byPromptBoundary.map((g) => [g.boundary, g.promptBytes.value]),
			[
				["dispatcher-input", 4],
				["adapter-assembled", 31],
				["unrecorded", 4],
			],
		);
		assert.match(renderUsageReport(report), /Prompt bytes \/ dispatcher-input: 4/);
		assert.match(renderUsageReport(report), /Compare growth within a boundary/);
		assert.equal(readUsageMeasurement({ ...dispatcher, promptBoundary: ["dispatcher-input"] })?.promptBoundary, undefined);
	});
	it("counts UTF-8 bytes without retaining text or claiming to tokenize it", () => {
		const m = measurePrompt("a😀é", "dispatcher-input");
		assert.equal(m.promptBytes, 7);
		assert.equal(m.inputTokens, undefined);
		assert.ok(m.observationId);
		assert.ok(!JSON.stringify(m).includes("😀"));
	});
});

describe("shared usage projection", () => {
	it("reports coverage per field and calculates cache fraction on paired observations", () => {
		const report = buildUsageReport([row("1"), row("2", measureUsage("codex", { input_tokens: 9000 })), { ...row("3"), measurement: undefined }]);
		assert.deepEqual(report.totals.inputTokens, { value: 10000, observed: 2, total: 3 });
		assert.deepEqual(report.totals.cacheReadFraction, { value: 0.6, observed: 1, total: 3 });
		assert.match(renderUsageReport(report), /2\/3 observations/);
	});
	it("deduplicates replay, excludes conflicting observations, and never adds parent totals", () => {
		assert.equal(buildUsageReport([row("1"), row("1")]).totals.inputTokens.value, 1000);
		const conflict = buildUsageReport([row("1"), row("1", measureUsage("codex", { input_tokens: 10 }))]);
		assert.equal(conflict.conflictingObservations, 1);
		assert.equal(conflict.totals.inputTokens.value, null);
		const cycles = [{ ts: "now", cycle: 1, total_cost: 100, tokens: { input: 999999 }, steps: [{ name: "implement", usageMeasurement: claude() }] }];
		assert.equal(buildUsageReport(cycleUsageRows([...cycles, ...cycles])).totals.inputTokens.value, 1000);
	});
	it("keeps old logs visible as unavailable rather than silently reinterpreting legacy counters", () => {
		const report = buildUsageReport(cycleUsageRows([{ steps: [{ name: "implement", tokens: { input: 100, output: 10, cacheRead: 50, cacheCreation: 0 } }] }]));
		assert.equal(report.observations, 1);
		assert.equal(report.totals.inputTokens.value, null);
	});
	it("keeps consumer usage optional, handles resumes/replay, and preserves frozen field names", () => {
		const events = [event("1", "fake-progress", { usageMeasurement: claude() }), event("2", "run-resumed"), event("3", "fake-progress", { usageMeasurement: claude() })];
		assert.deepEqual(localMetricsUsage(events), { inputTokens: 2000, outputTokens: 40 });
		const report = localUsageReport([...events, ...events]);
		assert.equal(report.totals.inputTokens.value, 2000);
		assert.deepEqual(
			report.attempts.map((r) => r.attempt),
			["1", "2"],
		);
		assert.equal(localMetricsUsage([...events, event("4", "fake-progress")]), undefined);
		assert.equal(localMetricsUsage([event("1", "fake-progress", { usageMeasurement: { schemaVersion: 99, inputTokens: 9999 } })]), undefined);
	});
	it("makes usage reports opt-in on the existing stats command", () => {
		assert.deepEqual(parseCli(["stats", "--usage", "--json"]), { kind: "stats", usage: true, json: true });
		assert.equal(parseCli(["--usage"]).kind, "error");
		assert.deepEqual(parseCli(["stats"]), { kind: "stats", json: false });
	});
});
