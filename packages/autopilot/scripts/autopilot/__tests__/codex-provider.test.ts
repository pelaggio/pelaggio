import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildCodexStepResult, codexTimeoutMs, selectCodexModel } from "../codex-provider.js";
import { EDIT_LOOP_THRESHOLD } from "../step-runner-shared.js";

function fixtureEvents(name: string): Record<string, unknown>[] {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("buildCodexStepResult", () => {
	it("maps a successful real Codex JSONL fixture into StepResult fields", () => {
		const out = buildCodexStepResult("implement", fixtureEvents("codex-events-success.jsonl"), { exitCode: 0 });

		assert.equal(out.result.ok, true);
		assert.equal(out.result.subtype, "success");
		assert.equal(out.result.text, "hello");
		assert.equal(out.result.tokens?.input, 12947);
		assert.equal(out.result.tokens?.cacheRead, 9600);
		assert.equal(out.result.tokens?.output, 5);
		assert.equal(out.result.costEstimated, true);
		assert.ok(out.result.cost > 0);
		assert.equal(out.result.turns, 1);
		assert.ok(out.events.some((e) => e.type === "init"));
		assert.ok(out.events.some((e) => e.type === "text" && e.content === "hello"));
	});

	it("maps real Codex tool fixture events without duplicating command text", () => {
		const out = buildCodexStepResult("implement", fixtureEvents("codex-events-tools.jsonl"), { exitCode: 0 });
		const command = "/usr/bin/zsh -lc 'echo done'";

		assert.equal(out.result.ok, true);
		assert.equal(out.result.text, "OK");
		assert.deepEqual(out.result.toolCounts, { Edit: 1, Bash: 1 });
		assert.equal(countOccurrences(out.result.fullText, command), 1);
		assert.equal(countOccurrences(out.result.fullText, "done\n"), 1);
		assert.ok(out.events.some((e) => e.type === "tool_use" && e.name === "Edit"));
		assert.ok(out.events.some((e) => e.type === "tool_use" && e.name === "Bash"));
	});

	it("detects edit loops from repeated real-shaped file_change paths", () => {
		const path = "src/loop.ts";
		const events = Array.from({ length: EDIT_LOOP_THRESHOLD }, (_, i) => ({
			type: "item.started",
			item: { id: `item_${i}`, type: "file_change", changes: [{ path, kind: "modify" }], status: "in_progress" },
		}));
		const out = buildCodexStepResult("implement", [...events, { type: "item.completed", item: { type: "agent_message", text: "Done." } }, { type: "turn.completed" }], { exitCode: 0 });

		assert.equal(out.result.ok, false);
		assert.equal(out.result.subtype, "edit_loop");
		assert.match(out.result.text, new RegExp(`${path.replace(".", "\\.")} edited ${EDIT_LOOP_THRESHOLD} times`));
		assert.ok(out.events.some((e) => e.type === "edit_loop" && e.file === path && e.count === EDIT_LOOP_THRESHOLD));
	});

	it("parks rate limits reported by turn.failed", () => {
		const out = buildCodexStepResult("plan", [{ type: "turn.started" }, { type: "turn.failed", error: { message: "429 usage limit exceeded" } }], {
			exitCode: 1,
			now: 1_000,
			unknownResetWaitMs: 60_000,
		});

		assert.equal(out.result.ok, false);
		assert.equal(out.result.subtype, "error_rate_limit");
		assert.equal(out.parkUpdate?.parked, true);
		assert.equal(out.parkUpdate?.resetsAt, 61_000);
		assert.match(out.parkUpdate?.limitType ?? "", /\(estimated\)/);
		assert.ok(out.events.some((e) => e.type === "rate_limit" && e.resetsAt === 61_000));
	});

	it("parks rate limits reported only by non-zero exit stderr", () => {
		const out = buildCodexStepResult("implement", [{ type: "turn.started" }], {
			exitCode: 1,
			stderr: "Error: 429 rate limit exceeded",
			now: 2_000,
			unknownResetWaitMs: 30_000,
		});

		assert.equal(out.result.ok, false);
		assert.equal(out.result.subtype, "error_rate_limit");
		assert.equal(out.parkUpdate?.parked, true);
		assert.equal(out.parkUpdate?.resetsAt, 32_000);
		assert.match(out.parkUpdate?.limitType ?? "", /\(estimated\)/);
	});

	it("does not park plain non-rate-limit errors", () => {
		const out = buildCodexStepResult("implement", [{ type: "turn.started" }], {
			exitCode: 1,
			stderr: "Error: command failed",
			now: 2_000,
			unknownResetWaitMs: 30_000,
		});

		assert.equal(out.result.ok, false);
		assert.equal(out.result.subtype, "error_sdk");
		assert.equal(out.parkUpdate, undefined);
	});

	it("keeps timeout classification when edit-loop evidence is also present", () => {
		const path = "src/loop.ts";
		const events = Array.from({ length: EDIT_LOOP_THRESHOLD }, (_, i) => ({
			type: "item.started",
			item: { id: `item_${i}`, type: "file_change", changes: [{ path, kind: "modify" }], status: "in_progress" },
		}));
		const out = buildCodexStepResult("implement", events, { exitCode: null, signal: "SIGTERM", timedOut: true });

		assert.equal(out.result.ok, false);
		assert.equal(out.result.subtype, "error_max_turns");
		assert.match(out.result.text, /timed out/);
		assert.ok(out.events.some((e) => e.type === "edit_loop" && e.file === path));
	});

	it("maps a final BLOCKED sentinel to blocked", () => {
		const out = buildCodexStepResult("shakedown-code", [{ type: "turn.started" }, { type: "item.completed", item: { type: "agent_message", text: "I cannot finish.\n\nBLOCKED: missing credentials" } }, { type: "turn.completed" }], {
			exitCode: 0,
		});

		assert.equal(out.result.ok, false);
		assert.equal(out.result.subtype, "blocked");
		assert.equal(out.result.text, "missing credentials");
		assert.ok(out.events.some((e) => e.type === "blocked" && e.reason === "missing credentials"));
	});

	it("maps refusal-shaped final text to error_refusal", () => {
		const out = buildCodexStepResult("ship", [{ type: "turn.started" }, { type: "item.completed", item: { type: "agent_message", text: "I can't help with that request." } }, { type: "turn.completed" }], {
			exitCode: 0,
		});

		assert.equal(out.result.ok, false);
		assert.equal(out.result.subtype, "error_refusal");
		assert.ok(out.events.some((e) => e.type === "sdk_error" && /refused/.test(e.message)));
	});

	it("appends -o outputLastMessage to fullText and uses it as final text", () => {
		const out = buildCodexStepResult("pick", [{ type: "turn.started" }, { type: "item.completed", item: { type: "agent_message", text: "intermediate" } }, { type: "turn.completed" }], {
			exitCode: 0,
			outputLastMessage: "pick-item: 80",
		});

		assert.equal(out.result.ok, true);
		assert.equal(out.result.text, "pick-item: 80");
		assert.match(out.result.fullText, /intermediate/);
		assert.match(out.result.fullText, /pick-item: 80/);
	});
});

describe("selectCodexModel", () => {
	it("returns an explicitly configured codex model", () => {
		assert.equal(selectCodexModel({ model: undefined, codexModel: "gpt-5-codex" }), "gpt-5-codex");
	});

	it("lets the codex layer win over a claude model slot", () => {
		assert.equal(selectCodexModel({ model: "claude-opus-4-8", codexModel: "gpt-5-codex" }), "gpt-5-codex");
	});

	it("drops a claude model when no codex layer is configured", () => {
		assert.equal(selectCodexModel({ model: "claude-opus-4-8", codexModel: undefined }), undefined);
	});

	it("returns undefined when neither layer is configured", () => {
		assert.equal(selectCodexModel({ model: undefined, codexModel: undefined }), undefined);
	});

	it("preserves the legacy non-claude model fallback", () => {
		assert.equal(selectCodexModel({ model: "gpt-5-codex", codexModel: undefined }), "gpt-5-codex");
	});

	it("drops a claude model configured in the codex layer", () => {
		assert.equal(selectCodexModel({ model: "gpt-5-codex", codexModel: "claude-opus-4-8" }), undefined);
	});
});

describe("codexTimeoutMs", () => {
	it("uses a bounded one-minute-per-turn wall clock budget", () => {
		assert.equal(codexTimeoutMs(1), 10 * 60_000);
		assert.equal(codexTimeoutMs(30), 30 * 60_000);
		assert.equal(codexTimeoutMs(200), 90 * 60_000);
	});
});
