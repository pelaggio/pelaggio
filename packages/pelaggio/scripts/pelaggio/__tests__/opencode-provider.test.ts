import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildOpenCodeStepResult, OPENCODE_CAPABILITIES, OPENCODE_SANDBOX_APPEND, opencodeTimeoutMs, selectOpenCodeModel } from "../opencode-provider.js";
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

describe("OPENCODE_SANDBOX_APPEND (#137)", () => {
	it("tells the model not to run stateful git or network CLIs (harness owns them)", () => {
		assert.match(OPENCODE_SANDBOX_APPEND, /do NOT run stateful git/i);
		for (const g of ["git add", "commit", "push"]) assert.ok(OPENCODE_SANDBOX_APPEND.includes(g), `mentions ${g}`);
		assert.match(OPENCODE_SANDBOX_APPEND, /harness commits your work/i);
		assert.match(OPENCODE_SANDBOX_APPEND, /gh |roadmap/i); // network CLIs also off-limits
		assert.match(OPENCODE_SANDBOX_APPEND, /read-only git.*is fine/i); // reads still allowed
	});
});

describe("OPENCODE_CAPABILITIES (honest ADR-0020 row)", () => {
	it("claims no OS isolation and estimated (never billed) cost", () => {
		assert.equal(OPENCODE_CAPABILITIES.semanticDeny, false);
		assert.deepEqual(OPENCODE_CAPABILITIES.isolation, []); // OPENCODE_PERMISSION is a policy env, not a jail
		assert.equal(OPENCODE_CAPABILITIES.costMeter.kind, "usd-estimated");
		assert.equal(OPENCODE_CAPABILITIES.sessionResume, false);
	});
});

describe("buildOpenCodeStepResult", () => {
	it("maps a successful JSON event fixture into StepResult fields", () => {
		const out = buildOpenCodeStepResult("implement", fixtureEvents("opencode-events-success.jsonl"), { exitCode: 0 });

		assert.equal(out.result.ok, true);
		assert.equal(out.result.subtype, "success");
		assert.equal(out.result.text, "hello");
		assert.equal(out.result.tokens?.input, 12000);
		assert.equal(out.result.tokens?.cacheRead, 9600);
		assert.equal(out.result.tokens?.output, 8);
		assert.equal(out.result.costEstimated, true);
		assert.equal(out.result.cost, 0.0021); // provider-reported cost preferred over token estimate
		assert.equal(out.result.turns, 1);
		assert.ok(out.events.some((e) => e.type === "init"));
		assert.ok(out.events.some((e) => e.type === "text" && e.content === "hello"));
	});

	it("maps tool events into toolCounts without duplicating command output", () => {
		const out = buildOpenCodeStepResult("implement", fixtureEvents("opencode-events-tools.jsonl"), { exitCode: 0 });

		assert.equal(out.result.ok, true);
		assert.equal(out.result.text, "OK");
		assert.deepEqual(out.result.toolCounts, { Edit: 1, Bash: 1 });
		assert.equal(countOccurrences(out.result.fullText, "done\n"), 1);
		assert.ok(out.events.some((e) => e.type === "tool_use" && e.name === "Edit"));
		assert.ok(out.events.some((e) => e.type === "tool_use" && e.name === "Bash"));
	});

	it("estimates cost from tokens when no cost field is reported", () => {
		const out = buildOpenCodeStepResult("implement", fixtureEvents("opencode-events-tools.jsonl"), { exitCode: 0 });
		assert.ok(out.result.cost > 0); // tools fixture step-finish has usage but no `cost`
		assert.equal(out.result.costEstimated, true);
	});

	it("detects edit loops from repeated file-edit tool events", () => {
		const path = "src/loop.ts";
		const events = Array.from({ length: EDIT_LOOP_THRESHOLD }, () => ({
			type: "tool",
			tool: "edit",
			state: { status: "completed", input: { filePath: path } },
		}));
		const out = buildOpenCodeStepResult("implement", [...events, { type: "text", text: "Done." }, { type: "finish", reason: "stop" }], { exitCode: 0 });

		assert.equal(out.result.ok, false);
		assert.equal(out.result.subtype, "edit_loop");
		assert.match(out.result.text, new RegExp(`${path.replace(".", "\\.")} edited ${EDIT_LOOP_THRESHOLD} times`));
		assert.ok(out.events.some((e) => e.type === "edit_loop" && e.file === path && e.count === EDIT_LOOP_THRESHOLD));
	});

	it("does not count edits toward the loop on exempt steps", () => {
		const path = "docs/plans/137.md";
		const events = Array.from({ length: EDIT_LOOP_THRESHOLD + 2 }, () => ({
			type: "tool",
			tool: "edit",
			state: { status: "completed", input: { filePath: path } },
		}));
		const out = buildOpenCodeStepResult("plan", [...events, { type: "text", text: "Planned." }, { type: "finish", reason: "stop" }], { exitCode: 0 });

		assert.equal(out.result.ok, true);
		assert.equal(out.result.subtype, "success");
		assert.equal(
			out.events.some((e) => e.type === "edit_loop"),
			false,
		);
	});

	it("parks rate limits reported by an error event", () => {
		const out = buildOpenCodeStepResult("plan", [{ type: "step-start" }, { type: "error", error: { message: "429 usage limit exceeded" } }], {
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
		const out = buildOpenCodeStepResult("implement", [{ type: "step-start" }], {
			exitCode: 1,
			stderr: "Error: 429 rate limit exceeded",
			now: 2_000,
			unknownResetWaitMs: 30_000,
		});

		assert.equal(out.result.ok, false);
		assert.equal(out.result.subtype, "error_rate_limit");
		assert.equal(out.parkUpdate?.parked, true);
		assert.equal(out.parkUpdate?.resetsAt, 32_000);
	});

	it("does not park plain non-rate-limit errors", () => {
		const out = buildOpenCodeStepResult("implement", [{ type: "step-start" }], {
			exitCode: 1,
			stderr: "Error: command failed",
			now: 2_000,
			unknownResetWaitMs: 30_000,
		});

		assert.equal(out.result.ok, false);
		assert.equal(out.result.subtype, "error_sdk");
		assert.equal(out.parkUpdate, undefined);
	});

	it("classifies a stream that never finishes as a non-ok sdk error", () => {
		const out = buildOpenCodeStepResult("implement", [{ type: "step-start" }, { type: "text", text: "partial" }], { exitCode: 0 });
		assert.equal(out.result.ok, false);
		assert.equal(out.result.subtype, "error_sdk");
		assert.ok(out.events.some((e) => e.type === "sdk_error"));
	});

	it("keeps timeout classification when edit-loop evidence is also present", () => {
		const path = "src/loop.ts";
		const events = Array.from({ length: EDIT_LOOP_THRESHOLD }, () => ({
			type: "tool",
			tool: "edit",
			state: { status: "completed", input: { filePath: path } },
		}));
		const out = buildOpenCodeStepResult("implement", events, { exitCode: null, signal: "SIGTERM", timedOut: true });

		assert.equal(out.result.ok, false);
		assert.equal(out.result.subtype, "error_max_turns");
		assert.match(out.result.text, /timed out/);
		assert.ok(out.events.some((e) => e.type === "edit_loop" && e.file === path));
	});

	it("maps a final BLOCKED sentinel to blocked", () => {
		const out = buildOpenCodeStepResult("shakedown-code", [{ type: "step-start" }, { type: "text", text: "I cannot finish.\n\nBLOCKED: missing credentials" }, { type: "finish", reason: "stop" }], { exitCode: 0 });

		assert.equal(out.result.ok, false);
		assert.equal(out.result.subtype, "blocked");
		assert.equal(out.result.text, "missing credentials");
		assert.ok(out.events.some((e) => e.type === "blocked" && e.reason === "missing credentials"));
	});

	it("maps refusal-shaped final text to error_refusal", () => {
		const out = buildOpenCodeStepResult("ship", [{ type: "step-start" }, { type: "text", text: "I can't help with that request." }, { type: "finish", reason: "stop" }], { exitCode: 0 });

		assert.equal(out.result.ok, false);
		assert.equal(out.result.subtype, "error_refusal");
		assert.ok(out.events.some((e) => e.type === "sdk_error" && /refused/.test(e.message)));
	});
});

describe("selectOpenCodeModel", () => {
	it("returns an explicitly configured model", () => {
		assert.equal(selectOpenCodeModel({ model: "anthropic/claude-sonnet-4-5", codexModel: undefined }), "anthropic/claude-sonnet-4-5");
	});

	it("lets the shared model slot win over the codex layer", () => {
		assert.equal(selectOpenCodeModel({ model: "openai/gpt-5", codexModel: "gpt-5-codex" }), "openai/gpt-5");
	});

	it("drops a bare claude SDK id (never forwarded to the opencode CLI)", () => {
		assert.equal(selectOpenCodeModel({ model: "claude-opus-4-8", codexModel: undefined }), undefined);
	});

	it("returns undefined when neither layer is configured", () => {
		assert.equal(selectOpenCodeModel({ model: undefined, codexModel: undefined }), undefined);
	});

	it("falls back to the codex layer when the shared slot is empty", () => {
		assert.equal(selectOpenCodeModel({ model: undefined, codexModel: "openrouter/some-model" }), "openrouter/some-model");
	});
});

describe("opencodeTimeoutMs", () => {
	it("uses a bounded one-minute-per-turn wall clock budget", () => {
		assert.equal(opencodeTimeoutMs(1), 10 * 60_000);
		assert.equal(opencodeTimeoutMs(30), 30 * 60_000);
		assert.equal(opencodeTimeoutMs(200), 90 * 60_000);
	});
});
