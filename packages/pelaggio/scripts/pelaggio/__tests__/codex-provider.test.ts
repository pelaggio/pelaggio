import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildCodexExecArgs, buildCodexStepResult, CODEX_READ_ONLY_APPEND, CODEX_SANDBOX_APPEND, codexEffort, codexProvider, codexTimeoutMs, codexUsesReadOnlySandbox, selectCodexModel } from "../codex-provider.js";
import { CONFIG } from "../config.js";
import { EDIT_LOOP_THRESHOLD } from "../step-runner-shared.js";
import type { StepEvent } from "../types.js";

function fixtureEvents(name: string): Record<string, unknown>[] {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("CODEX_SANDBOX_APPEND (#109)", () => {
	it("tells the model not to run stateful git or network CLIs (harness owns them)", () => {
		assert.match(CODEX_SANDBOX_APPEND, /do NOT run stateful git/i);
		for (const g of ["git add", "commit", "push"]) assert.ok(CODEX_SANDBOX_APPEND.includes(g), `mentions ${g}`);
		assert.match(CODEX_SANDBOX_APPEND, /harness commits your work/i);
		assert.match(CODEX_SANDBOX_APPEND, /gh |roadmap/i); // network CLIs also off-limits
		assert.match(CODEX_SANDBOX_APPEND, /read-only git.*is fine/i); // reads still allowed
	});
});

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
		assert.equal(countOccurrences(out.result.fullText, "done\n"), 0);
		assert.equal(out.result.assistantText.includes(command), false);
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
		assert.match(out.result.assistantText, /pick-item: 80/);
	});

	it("does not duplicate outputLastMessage when it matches the streamed final agent message", () => {
		const out = buildCodexStepResult("pick", [{ type: "turn.started" }, { type: "item.completed", item: { type: "agent_message", text: "pick-item: 80" } }, { type: "turn.completed" }], {
			exitCode: 0,
			outputLastMessage: "pick-item: 80",
		});

		assert.equal(out.result.text, "pick-item: 80");
		assert.equal(countOccurrences(out.result.fullText, "pick-item: 80"), 1);
		assert.equal(countOccurrences(out.result.assistantText, "pick-item: 80"), 1);
	});

	it("projects a started+completed command once by item.id and still projects a missing-id event", () => {
		const events = [
			{ type: "turn.started" },
			{ type: "item.started", item: { id: "item_2", type: "command_execution", command: "echo paired", description: "run paired" } },
			{ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "echo paired", description: "run paired", aggregated_output: "PAIRED_OUTPUT\n" } },
			{ type: "item.completed", item: { type: "command_execution", command: "echo orphan" } },
			{ type: "item.completed", item: { type: "agent_message", text: "OK" } },
			{ type: "turn.completed" },
		];
		const out = buildCodexStepResult("implement", events, { exitCode: 0 });
		assert.equal(countOccurrences(out.result.fullText, "echo paired"), 1);
		assert.equal(countOccurrences(out.result.fullText, "run paired"), 1);
		assert.equal(countOccurrences(out.result.fullText, "echo orphan"), 1);
		assert.equal(out.result.fullText.includes("PAIRED_OUTPUT"), false);
	});

	it("does not consume an item.id before a later event supplies its command", () => {
		const out = buildCodexStepResult(
			"implement",
			[
				{ type: "turn.started" },
				{ type: "item.started", item: { id: "item_late", type: "command_execution", status: "in_progress" } },
				{ type: "item.completed", item: { id: "item_late", type: "command_execution", command: "echo late", aggregated_output: "LATE_OUTPUT\n" } },
				{ type: "item.completed", item: { type: "agent_message", text: "OK" } },
				{ type: "turn.completed" },
			],
			{ exitCode: 0 },
		);
		assert.equal(countOccurrences(out.result.fullText, "echo late"), 1);
		assert.equal(out.result.fullText.includes("LATE_OUTPUT"), false);
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

describe("codexEffort (#431)", () => {
	it("preserves low + medium and collapses high|xhigh|max to high", () => {
		assert.equal(codexEffort("low"), "low");
		assert.equal(codexEffort("medium"), "medium");
		assert.equal(codexEffort("high"), "high");
		assert.equal(codexEffort("xhigh"), "high");
		assert.equal(codexEffort("max"), "high");
	});
});

describe("buildCodexExecArgs (#431)", () => {
	it("emits `-c model_reasoning_effort=<mapped>` exactly once, just before the stdin `-`, with a model", () => {
		const args = buildCodexExecArgs({ cwd: "/wt", outputPath: "/tmp/out.txt", model: "gpt-5-codex", effort: "high" });
		// Model flag preserved.
		assert.deepEqual(args.slice(0, 8), ["exec", "--json", "-C", "/wt", "-s", "workspace-write", "-o", "/tmp/out.txt"]);
		const mIdx = args.indexOf("-m");
		assert.equal(args[mIdx + 1], "gpt-5-codex");
		// Effort override present exactly once, as a separate argv element (no shell quoting).
		assert.equal(args.filter((a) => a === "-c").length, 1);
		assert.equal(args.filter((a) => a === "model_reasoning_effort=high").length, 1);
		const cIdx = args.indexOf("-c");
		assert.equal(args[cIdx + 1], "model_reasoning_effort=high");
		// stdin sentinel stays last, immediately after the config pair.
		assert.equal(args[args.length - 1], "-");
		assert.equal(cIdx + 2, args.length - 1);
	});

	it("omits `-m` when no model is pinned but still forwards the mapped effort", () => {
		const args = buildCodexExecArgs({ cwd: "/wt", outputPath: "/tmp/out.txt", effort: "medium" });
		assert.equal(args.includes("-m"), false);
		assert.equal(args.filter((a) => a === "-c").length, 1);
		assert.equal(args[args.indexOf("-c") + 1], "model_reasoning_effort=medium");
		assert.equal(args[args.length - 1], "-");
	});

	it("emits a read-only sandbox arg when asked", () => {
		const args = buildCodexExecArgs({ cwd: "/main", outputPath: "/tmp/out.txt", effort: "high", sandbox: "read-only" });
		assert.deepEqual(args.slice(0, 8), ["exec", "--json", "-C", "/main", "-s", "read-only", "-o", "/tmp/out.txt"]);
		assert.match(CODEX_READ_ONLY_APPEND, /READ-ONLY/);
		assert.match(CODEX_READ_ONLY_APPEND, /Do NOT attempt to write files/);
	});
});

describe("codexUsesReadOnlySandbox (#495/#631 store-trust)", () => {
	it("read-only ONLY for a review-class step at the trusted main checkout", () => {
		// Cold PR-gate review/verify run at cwd=REPO (isWorktree=false): read-only, so
		// workspace-write cannot root the sandbox at the checkout that hosts .dev/pr-review-*.
		assert.equal(codexUsesReadOnlySandbox("pr-review", false), true);
		assert.equal(codexUsesReadOnlySandbox("pr-verify", false), true);
	});

	it("keeps workspace-write for authoring-loop reviewer/judge seats (same step names, isolated worktree cwd)", () => {
		// The authoring loop runs pr-review/pr-verify seats in isolated .dev/authoring-review-seats
		// worktrees (isWorktree=true) whose skill mandates `pnpm check` / `pnpm -r test` — those must
		// keep workspace-write. Read-only there would break the mandated checks AND contradict the
		// read-only append. The cwd, not the step name, is the trust signal.
		assert.equal(codexUsesReadOnlySandbox("pr-review", true), false);
		assert.equal(codexUsesReadOnlySandbox("pr-verify", true), false);
	});

	it("honors harness access intent for data-only PR-head worktrees", () => {
		assert.equal(codexUsesReadOnlySandbox("pr-review", true, "read-only"), true);
		assert.equal(codexUsesReadOnlySandbox("pr-verify", true, "read-only"), true);
	});

	it("never read-only for a non-review step, at either cwd", () => {
		for (const worktree of [true, false]) {
			assert.equal(codexUsesReadOnlySandbox("implement", worktree), false);
			assert.equal(codexUsesReadOnlySandbox("plan", worktree), false);
			assert.equal(codexUsesReadOnlySandbox("implement", worktree, "read-only"), false);
		}
	});

	it("starts a read-only review seat without installing for a drifted checkout", async () => {
		const root = mkdtempSync(join(tmpdir(), "pelaggio-codex-read-only-"));
		const checkout = join(root, "pr-head");
		const bin = join(root, "bin");
		const installSentinel = join(root, "install-ran");
		const fakePnpm = join(bin, "pnpm");
		const fakeCodex = join(bin, "codex");
		mkdirSync(checkout);
		mkdirSync(bin);
		writeFileSync(join(checkout, "pnpm-lock.yaml"), "attacker-controlled-lockfile-drift\n");
		writeFileSync(fakePnpm, `#!/bin/sh\ntouch "${installSentinel}"\n`);
		writeFileSync(
			fakeCodex,
			`#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
	if [ "$1" = "-o" ]; then
		shift
		output="$1"
	fi
	shift
done
cat >/dev/null
printf '%s\\n' '{"type":"turn.started"}' '{"type":"item.completed","item":{"type":"agent_message","text":"review completed"}}' '{"type":"turn.completed"}'
printf '%s' 'review completed' > "$output"
`,
		);
		chmodSync(fakePnpm, 0o700);
		chmodSync(fakeCodex, 0o700);

		const previousBin = CONFIG.providerBins.codex;
		const previousPath = process.env.PATH;
		CONFIG.providerBins.codex = fakeCodex;
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		const events: StepEvent[] = [];
		try {
			const result = await codexProvider.runStep(
				"pr-review",
				"Review this checkout.",
				{ cwd: checkout, profile: "standard", trace: false, parkSignal: { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" }, workspaceAccess: "read-only" },
				(event) => events.push(event),
			);

			assert.equal(result.ok, true, JSON.stringify(result));
			assert.equal(result.text, "review completed");
			assert.equal(existsSync(installSentinel), false, "read-only review must not invoke dependency provisioning");
			assert.ok(events.some((event) => event.type === "done" && event.ok));
		} finally {
			if (previousBin === undefined) delete CONFIG.providerBins.codex;
			else CONFIG.providerBins.codex = previousBin;
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
