import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AcpConnection } from "../acp-client.js";
import { CONFIG, GROK_DEFAULT_MODEL, REPO, type StepSettings } from "../config.js";
import { ContainedFailure, type ContainedLifecycleOptions, type withContainedInvocation } from "../contained-execution.js";
import { buildGrokStepResult, createGrokRunStep, grokEffort, grokServerRequestResponse, grokTimeoutMs, selectGrokModel } from "../grok-provider.js";
import type { StepEvent } from "../types.js";

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

	it("projects rawInput.command and description into fullText, not file bodies or tool output", () => {
		const built = buildGrokStepResult(
			"implement",
			[
				{
					sessionUpdate: "tool_call",
					toolCallId: "c1",
					title: "bash",
					rawInput: { command: "echo done", description: "print done", content: "FILE_BODY", file_path: "src/a.ts" },
				},
				{ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: "TOOL_OUTPUT\n", content: [{ type: "content", content: { type: "text", text: "TOOL_OUTPUT\n" } }] },
				msg("ok"),
				turnCompleted("end_turn", USAGE),
			],
			{ stopReason: "end_turn" },
		);
		assert.match(built.result.fullText, /echo done/);
		assert.match(built.result.fullText, /print done/);
		assert.equal(built.result.fullText.includes("FILE_BODY"), false);
		assert.equal(built.result.fullText.includes("TOOL_OUTPUT"), false);
		assert.equal(built.result.assistantText.includes("echo done"), false);
	});

	it("derives decisions from assistant text, not rawInput.command", () => {
		const built = buildGrokStepResult(
			"implement",
			[
				{
					sessionUpdate: "tool_call",
					title: "bash",
					rawInput: { command: "DECISION: cmd-fork | chose: cmd | alternatives: other" },
				},
				msg("DECISION: asst-fork | chose: asst | alternatives: other"),
				turnCompleted("end_turn", USAGE),
			],
			{ stopReason: "end_turn" },
		);
		assert.equal(built.result.decisions?.length, 1);
		assert.equal(built.result.decisions?.[0]?.decision.fork, "asst-fork");
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
	it("selectGrokModel reads only grokModel; never a claude id or a foreign slot", () => {
		assert.equal(selectGrokModel({ grokModel: "grok-4.5" }), "grok-4.5");
		// Defensive: a claude id in grok's own slot is rejected.
		assert.equal(selectGrokModel({ grokModel: "claude-opus-4-8" }), undefined);
		assert.equal(selectGrokModel({ grokModel: undefined }), undefined);
		// Foreign slots are ignored — grok only ever reads `grokModel` (#431).
		const foreignOnly = { grokModel: undefined, model: "claude-opus-4-8", codexModel: "gpt-5-codex", openCodeModel: "openrouter/qwen" } satisfies Partial<StepSettings>;
		assert.equal(selectGrokModel(foreignOnly), undefined);
	});

	it("grokEffort collapses the fine scale onto low|medium|high", () => {
		assert.equal(grokEffort("low"), "low");
		assert.equal(grokEffort("medium"), "medium");
		assert.equal(grokEffort("high"), "high");
		assert.equal(grokEffort("xhigh"), "high");
		assert.equal(grokEffort("max"), "high");
	});

	it("grokTimeoutMs stays within the contained 10–30 minute range", () => {
		assert.equal(grokTimeoutMs(1), 10 * 60_000);
		assert.equal(grokTimeoutMs(1000), 30 * 60_000);
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

describe("Grok provider confinement setup", () => {
	it("uses the reviewed default and requests brokered mounted-driver containment", async () => {
		let captured: ContainedLifecycleOptions | undefined;
		let capturedTimeoutMs: number | undefined;
		const contained: typeof withContainedInvocation = async (options, driver) => {
			captured = options;
			const driven = await driver({ executable: "/usr/bin/systemd-run", argv: ["--pipe", "grok"], env: {}, cwd: REPO, unit: "test.scope", kill: { executable: "/usr/bin/systemctl", argv: ["kill", "test.scope"] } }, async () => undefined);
			return { ...driven, writeSet: [] };
		};
		const spawnAcp = (options: Parameters<typeof import("../acp-client.js").spawnAcpAgent>[0]): ReturnType<typeof import("../acp-client.js").spawnAcpAgent> => {
			capturedTimeoutMs = options.timeoutMs;
			const conn = new AcpConnection({
				send: (line) => {
					const request = JSON.parse(line) as { id: number; method: string };
					queueMicrotask(() => {
						if (request.method === "session/prompt") conn.receive(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: msg("contained") } })}\n`);
						const result = request.method === "session/new" ? { sessionId: "s1" } : request.method === "session/prompt" ? { stopReason: "end_turn", _meta: { usage: USAGE } } : {};
						conn.receive(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
					});
				},
			});
			return { conn, done: Promise.resolve({ code: 0, signal: null, stderr: "", timedOut: false }), kill: () => undefined };
		};
		const runStep = createGrokRunStep({ contained, spawnAcp, detectSandbox: async () => true, resolveExecutable: async () => "/opt/grok" });
		const events: StepEvent[] = [];
		const result = await runStep("implement", "test", { cwd: REPO, profile: "standard", trace: false, parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" } }, (event) => events.push(event));
		assert.equal(result.ok, true);
		assert.equal(captured?.egress?.provider, "grok");
		assert.equal(captured?.egress?.model, GROK_DEFAULT_MODEL);
		assert.deepEqual(captured?.egress?.auth, { kind: "transparent" });
		assert.equal(capturedTimeoutMs, (captured?.timeoutSeconds ?? 0) * 1000 - 10_000);
		assert.equal(captured?.command.kind, "brokered-mounted-driver");
		if (captured?.command.kind !== "brokered-mounted-driver") return;
		assert.equal(captured.command.source, "/opt/grok");
		assert.notEqual(captured.command.args.indexOf("-m"), -1);
		assert.equal(captured.command.args[captured.command.args.indexOf("-m") + 1], GROK_DEFAULT_MODEL);
		assert.deepEqual(captured.command.args.slice(-3), ["--cli-chat-proxy-base-url", "http://127.0.0.1:43179/v1", "stdio"]);
		assert.deepEqual(
			captured.privateHome?.map((entry) => [entry.kind, entry.destination]),
			[
				["copy", ".grok/auth.json"],
				["literal", ".grok/sandbox.toml"],
			],
		);
	});

	it("refuses Grok before auth staging when authoring requires direct keys", async () => {
		const saved = CONFIG.review.authoring.enabled;
		let resolved = false;
		CONFIG.review.authoring.enabled = "keys";
		try {
			const runStep = createGrokRunStep({
				detectSandbox: async () => true,
				resolveExecutable: async () => {
					resolved = true;
					return "/opt/grok";
				},
			});
			const result = await runStep("implement", "test", { cwd: REPO, profile: "standard", trace: false, parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" } }, () => undefined);
			assert.equal(result.subtype, "error_confinement");
			assert.match(result.text, /key authentication is unavailable/);
			assert.equal(resolved, false);
		} finally {
			CONFIG.review.authoring.enabled = saved;
		}
	});

	it("rejects an unsupported model before resolving or spawning the driver", async () => {
		let resolved = false;
		const runStep = createGrokRunStep({
			detectSandbox: async () => true,
			resolveExecutable: async () => {
				resolved = true;
				return "/opt/grok";
			},
		});
		const result = await runStep(
			"implement",
			"test",
			{ cwd: REPO, profile: "standard", trace: false, executionOverride: { provider: "grok", model: "grok-unreviewed" }, parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" } },
			() => undefined,
		);
		assert.equal(result.subtype, "error_confinement");
		assert.equal(resolved, false);
	});

	it("keeps broker budget and rate-limit failures distinct", async () => {
		for (const [reason, subtype] of [
			["budget", "error_budget"],
			["rate_limit", "error_rate_limit"],
		] as const) {
			const contained: typeof withContainedInvocation = async () => {
				throw new ContainedFailure(`broker ${reason}`, reason);
			};
			const parkSignal = { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };
			const runStep = createGrokRunStep({ contained, detectSandbox: async () => true, resolveExecutable: async () => "/opt/grok" });
			const result = await runStep("implement", "test", { cwd: REPO, profile: "standard", trace: false, parkSignal }, () => undefined);
			assert.equal(result.subtype, subtype);
			assert.equal(parkSignal.parked, reason === "rate_limit");
		}
	});
});
