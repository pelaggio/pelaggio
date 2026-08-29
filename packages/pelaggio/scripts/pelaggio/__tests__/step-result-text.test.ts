import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emitDecisionsFromText } from "../decisions.js";
import { buildCodexStepResult } from "../providers/codex.js";
import { buildGrokStepResult } from "../providers/grok.js";
import { buildOpenCodeStepResult } from "../providers/opencode.js";
import { createStepTextProjection, projectClaudeAssistantBlocks, REGISTERED_PROVIDERS } from "../step-runner.js";
import type { EmittedDecision, ProviderName } from "../types.js";

const ASST_A = "ASST_418_ALPHA";
const ASST_B = "ASST_418_BETA";
const COMMAND = "CMD_418_SENTINEL";
const DESCRIPTION = "DESC_418_SENTINEL";
const OUTPUT = "OUT_418_SENTINEL";
const BODY = "BODY_418_SENTINEL";
const ASST_DECISION = "DECISION: asst-418 | chose: asst-choice | alternatives: asst-alt";
const CMD_DECISION = "DECISION: cmd-418 | chose: cmd-choice | alternatives: cmd-alt";
const OUT_DECISION = "DECISION: out-418 | chose: out-choice | alternatives: out-alt";

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function commandInput(): Record<string, unknown> {
	return {
		command: `${COMMAND}\n${CMD_DECISION}`,
		description: DESCRIPTION,
		new_string: BODY,
		content: BODY,
		output: `${OUTPUT}\n${OUT_DECISION}`,
	};
}

interface Projected {
	assistantText: string;
	fullText: string;
	decisions: EmittedDecision[];
}

const CASES = {
	claude: {
		run(): Projected {
			const projection = createStepTextProjection({ assistantSeparator: "\n" });
			projectClaudeAssistantBlocks(
				[
					{ type: "text", text: `${ASST_A}\n${ASST_DECISION}` },
					{ type: "text", text: ASST_B },
					{ type: "thinking", text: `${OUTPUT}\n${OUT_DECISION}` },
					{ type: "tool_use", input: { ...commandInput(), output: `${OUTPUT}\n${OUT_DECISION}` } },
				],
				projection,
			);
			const { assistantText, fullText } = projection.read();
			return { assistantText, fullText, decisions: emitDecisionsFromText(assistantText) };
		},
	},
	codex: {
		run(): Projected {
			const input = commandInput();
			const out = buildCodexStepResult(
				"implement",
				[
					{ type: "turn.started" },
					{ type: "item.completed", item: { type: "agent_message", text: `${ASST_A}\n${ASST_DECISION}` } },
					{
						type: "item.started",
						item: { id: "item_2", type: "command_execution", ...input, aggregated_output: "" },
					},
					{
						type: "item.completed",
						item: {
							id: "item_2",
							type: "command_execution",
							...input,
							aggregated_output: `${OUTPUT}\n${OUT_DECISION}`,
							stdout: OUTPUT,
							stderr: OUTPUT,
						},
					},
					{ type: "item.completed", item: { type: "agent_message", text: ASST_B } },
					{ type: "turn.completed" },
				],
				{ exitCode: 0 },
			);
			return { assistantText: out.result.assistantText, fullText: out.result.fullText, decisions: out.result.decisions ?? [] };
		},
	},
	grok: {
		run(): Projected {
			const out = buildGrokStepResult(
				"implement",
				[
					{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${ASST_A}\n${ASST_DECISION}` } },
					{ sessionUpdate: "tool_call", title: "bash", rawInput: commandInput() },
					{
						sessionUpdate: "tool_call_update",
						status: "completed",
						rawOutput: `${OUTPUT}\n${OUT_DECISION}`,
						content: [{ type: "content", content: { type: "text", text: `${OUTPUT}\n${OUT_DECISION}` } }],
					},
					{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ASST_B } },
					{ sessionUpdate: "turn_completed", stop_reason: "end_turn", usage: { modelCalls: 1 } },
				],
				{ stopReason: "end_turn" },
			);
			return { assistantText: out.result.assistantText, fullText: out.result.fullText, decisions: out.result.decisions ?? [] };
		},
	},
	opencode: {
		run(): Projected {
			const out = buildOpenCodeStepResult(
				"implement",
				[
					{ type: "session", model: "test" },
					{ type: "step-start" },
					{ type: "text", text: `${ASST_A}\n${ASST_DECISION}` },
					{
						type: "tool",
						tool: "bash",
						state: { status: "completed", input: commandInput(), output: `${OUTPUT}\n${OUT_DECISION}` },
					},
					{ type: "text", text: ASST_B },
					{ type: "finish", reason: "stop" },
				],
				{ exitCode: 0 },
			);
			return { assistantText: out.result.assistantText, fullText: out.result.fullText, decisions: out.result.decisions ?? [] };
		},
	},
} satisfies Record<ProviderName, { run: () => Projected }>;

describe("StepResult text contract (#418)", () => {
	it("is exhaustive over REGISTERED_PROVIDERS", () => {
		assert.deepEqual([...REGISTERED_PROVIDERS].slice().sort(), Object.keys(CASES).slice().sort());
	});

	for (const name of REGISTERED_PROVIDERS) {
		it(`${name} projects assistant + command + description and excludes output/file-body`, () => {
			const { assistantText, fullText, decisions } = CASES[name].run();

			assert.ok(assistantText.includes(ASST_A), `${name} assistantText missing first chunk`);
			assert.ok(assistantText.includes(ASST_B), `${name} assistantText missing second chunk`);
			assert.ok(assistantText.indexOf(ASST_A) < assistantText.indexOf(ASST_B), `${name} assistant chunks out of order`);
			assert.equal(assistantText.includes(COMMAND), false, `${name} assistantText leaked command`);
			assert.equal(assistantText.includes(DESCRIPTION), false, `${name} assistantText leaked description`);
			assert.equal(assistantText.includes(OUTPUT), false, `${name} assistantText leaked output`);
			assert.equal(assistantText.includes(BODY), false, `${name} assistantText leaked file body`);

			assert.equal(countOccurrences(fullText, ASST_A), 1, `${name} fullText assistant A`);
			assert.equal(countOccurrences(fullText, ASST_B), 1, `${name} fullText assistant B`);
			assert.equal(countOccurrences(fullText, COMMAND), 1, `${name} fullText command`);
			assert.equal(countOccurrences(fullText, DESCRIPTION), 1, `${name} fullText description`);
			assert.equal(fullText.includes(OUTPUT), false, `${name} fullText leaked output`);
			assert.equal(fullText.includes(BODY), false, `${name} fullText leaked file body`);

			assert.deepEqual(
				decisions.map((d) => d.decision.fork),
				["asst-418"],
				`${name} decisions must come only from assistant text`,
			);
			assert.equal(assistantText.includes(ASST_DECISION), true);
			assert.equal(fullText.includes(CMD_DECISION), true);
			assert.equal(
				decisions.some((d) => d.decision.fork === "cmd-418" || d.decision.fork === "out-418"),
				false,
			);
		});
	}

	it("skips description when it equals the command and prefers the first non-empty command alias", () => {
		const projection = createStepTextProjection({ assistantSeparator: "\n" });
		assert.equal(projection.appendToolInput({ command: "echo same", description: "echo same" }), true);
		assert.equal(projection.appendToolInput({ command: "keep-command", cmd: "keep-cmd" }), true);
		assert.equal(projection.appendToolInput({ command: "", cmd: "fallback-cmd" }), true);
		assert.equal(projection.appendToolInput({ cmd: "only-cmd" }), true);
		assert.equal(projection.appendToolInput({ output: "ignored" }), false);
		const { fullText, assistantText } = projection.read();
		assert.equal(countOccurrences(fullText, "echo same"), 1);
		assert.equal(fullText.includes("keep-command"), true);
		assert.equal(fullText.includes("keep-cmd"), false);
		assert.equal(fullText.includes("fallback-cmd"), true);
		assert.equal(fullText.includes("only-cmd"), true);
		assert.equal(assistantText, "");
	});

	it("ignores inherited and non-enumerable allowlisted fields", () => {
		const inherited = Object.create({ command: "inherited-command" }) as Record<string, unknown>;
		Object.defineProperty(inherited, "description", { value: "hidden-description", enumerable: false });
		const projection = createStepTextProjection({ assistantSeparator: "\n" });
		assert.equal(projection.appendToolInput(inherited), false);
		assert.deepEqual(projection.read(), { assistantText: "", fullText: "" });
	});
});
