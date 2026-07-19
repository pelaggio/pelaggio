import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGrokStepResult, grokEffort, grokServerRequestResponse, grokTimeoutMs, selectGrokModel } from "../grok-provider.js";

type JsonObject = Record<string, unknown>;

// Fixtures modeled on the real grok 0.2.103 ACP capture (docs/agent-context/acp-grok-protocol.md).
const msg = (text: string): JsonObject => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const thought = (text: string): JsonObject => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
const turnCompleted = (stop: string, usage: JsonObject): JsonObject => ({ sessionUpdate: "turn_completed", stop_reason: stop, usage });
const USAGE = { inputTokens: 25455, outputTokens: 81, cachedReadTokens: 3584, reasoningTokens: 73, modelCalls: 2, costUsdTicks: 74_412_000 };

describe("buildGrokStepResult — happy path", () => {
	const built = buildGrokStepResult("implement", [thought("thinking…"), msg("Done. "), msg("Wrote the file."), turnCompleted("end_turn", USAGE)], { stopReason: "end_turn" });

	it("is ok with the concatenated agent_message text (thoughts excluded)", () => {
		assert.equal(built.result.ok, true);
		assert.equal(built.result.subtype, "success");
		assert.equal(built.result.text, "Done. Wrote the file.");
		assert.equal(built.result.text.includes("thinking"), false);
	});

	it("derives turns from modelCalls and tokens/cost from usage", () => {
		assert.equal(built.result.turns, 2);
		assert.deepEqual(built.result.tokens, { input: 25455, output: 81 + 73, cacheCreation: 0, cacheRead: 3584 });
		// costUsdTicks are nano-USD: 74_412_000 / 1e9.
		assert.ok(Math.abs(built.result.cost - 0.074412) < 1e-9);
		assert.equal(built.result.costEstimated, true);
	});

	it("emits text events", () => {
		const texts = built.events.filter((e) => e.type === "text");
		assert.equal(texts.length, 2);
	});
});

describe("buildGrokStepResult — tools", () => {
	it("emits a tool_use for a tool_call and tracks file locations", () => {
		const built = buildGrokStepResult(
			"implement",
			[{ sessionUpdate: "tool_call", toolCallId: "c1", title: "create_file", rawInput: { file_path: "src/a.ts" }, locations: [{ path: "src/a.ts" }] }, msg("ok"), turnCompleted("end_turn", USAGE)],
			{ stopReason: "end_turn" },
		);
		const tool = built.events.find((e) => e.type === "tool_use");
		assert.ok(tool);
		assert.equal((tool as { name: string }).name, "Edit");
		assert.equal((tool as { mutating: boolean }).mutating, true);
	});

	it("emits a tool_error for a failed tool_call_update but keeps the step ok on end_turn", () => {
		const built = buildGrokStepResult(
			"implement",
			[{ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", title: "update_goal", content: [{ type: "content", content: { type: "text", text: "Goal is not Active" } }] }, msg("recovered"), turnCompleted("end_turn", USAGE)],
			{ stopReason: "end_turn" },
		);
		assert.ok(built.events.some((e) => e.type === "tool_error"));
		assert.equal(built.result.ok, true);
	});

	it("flags an edit loop when a file is repeatedly written", () => {
		const updates: JsonObject[] = [];
		for (let i = 0; i < 22; i++) updates.push({ sessionUpdate: "tool_call", title: "edit", locations: [{ path: "src/loop.ts" }] });
		updates.push(turnCompleted("end_turn", USAGE));
		const built = buildGrokStepResult("implement", updates, { stopReason: "end_turn" });
		assert.equal(built.result.ok, false);
		assert.equal(built.result.subtype, "edit_loop");
	});
});

describe("buildGrokStepResult — failure modes", () => {
	it("maps a timeout to error_max_turns", () => {
		const built = buildGrokStepResult("implement", [msg("partial")], { timedOut: true });
		assert.equal(built.result.ok, false);
		assert.equal(built.result.subtype, "error_max_turns");
	});

	it("maps a drive error (no stop reason) to a non-ok sdk error", () => {
		const built = buildGrokStepResult("implement", [], { driveError: new Error("connection closed") });
		assert.equal(built.result.ok, false);
		assert.ok(built.events.some((e) => e.type === "sdk_error"));
	});

	it("parks on a rate-limit drive error", () => {
		const built = buildGrokStepResult("implement", [], { driveError: new Error("HTTP 429 rate limit exceeded"), now: 1_000_000 });
		assert.equal(built.result.ok, false);
		assert.equal(built.result.subtype, "error_rate_limit");
		assert.ok(built.parkUpdate?.parked);
		assert.ok(built.events.some((e) => e.type === "rate_limit"));
	});

	it("does NOT park a clean end_turn step whose stderr happens to mention a limit (#136 review finding)", () => {
		const built = buildGrokStepResult("implement", [msg("all good"), turnCompleted("end_turn", USAGE)], { stopReason: "end_turn", stderr: "warning: approaching context limit; 429 seen earlier" });
		assert.equal(built.result.ok, true);
		assert.equal(built.result.subtype, "success");
		assert.equal(built.parkUpdate, undefined);
	});

	it("is not ok when the turn completes with a non-end_turn stop reason", () => {
		const built = buildGrokStepResult("implement", [msg("truncated"), turnCompleted("max_tokens", USAGE)], { stopReason: "max_tokens" });
		assert.equal(built.result.ok, false);
	});
});

describe("grok helpers", () => {
	it("selectGrokModel forwards a grok id, never a claude id", () => {
		assert.equal(selectGrokModel({ model: "grok-4.5", codexModel: undefined }), "grok-4.5");
		assert.equal(selectGrokModel({ model: "claude-opus-4-8", codexModel: undefined }), undefined);
		assert.equal(selectGrokModel({ model: undefined, codexModel: undefined }), undefined);
	});

	it("grokEffort collapses the fine scale onto low|medium|high", () => {
		assert.equal(grokEffort("low"), "low");
		assert.equal(grokEffort("medium"), "medium");
		assert.equal(grokEffort("high"), "high");
		assert.equal(grokEffort("xhigh"), "high");
		assert.equal(grokEffort("max"), "high");
	});

	it("grokTimeoutMs stays within 10–90 minutes", () => {
		assert.equal(grokTimeoutMs(1), 10 * 60_000);
		assert.equal(grokTimeoutMs(1000), 90 * 60_000);
		assert.equal(grokTimeoutMs(30), 30 * 60_000);
	});

	it("grokServerRequestResponse selects an allow option for a permission request", () => {
		const res = grokServerRequestResponse({
			id: 5,
			method: "session/request_permission",
			params: {
				options: [
					{ optionId: "reject", kind: "reject_once" },
					{ optionId: "allow", kind: "allow_once" },
				],
			},
		}) as { outcome: { optionId: string } };
		assert.equal(res.outcome.optionId, "allow");
	});

	it("grokServerRequestResponse prefers allow-always when offered", () => {
		const res = grokServerRequestResponse({
			id: 6,
			method: "session/request_permission",
			params: {
				options: [
					{ optionId: "once", kind: "allow_once" },
					{ optionId: "always", kind: "allow_always" },
				],
			},
		}) as { outcome: { optionId: string } };
		assert.equal(res.outcome.optionId, "always");
	});

	it("grokServerRequestResponse returns an empty result for non-permission requests", () => {
		assert.deepEqual(grokServerRequestResponse({ id: 7, method: "fs/read_text_file", params: {} }), {});
	});
});
