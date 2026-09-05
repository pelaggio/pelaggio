import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCodexAdapter } from "../local-autopilot/codex-adapter.js";
import type { HarnessContext } from "../local-autopilot/harness.js";

describe("local autopilot Codex adapter", () => {
	it("uses approval-review auto mode, workspace sandboxing, and repair context", async () => {
		const calls: Array<{ bin: string; args: string[]; signal?: AbortSignal }> = [];
		const adapter = createCodexAdapter(async (bin, args, _cwd, signal) => {
			calls.push({ bin, args, signal });
			return { ok: true, output: "" };
		});
		const signal = new AbortController().signal;
		const context: HarnessContext = {
			cwd: "/repo",
			worktree: "/repo/.pelaggio/worktrees/run",
			workContract: {
				schemaVersion: 1,
				workContractId: "work-1",
				title: "Add hello",
				body: "Create the hello export.",
				source: { kind: "text" },
				digest: { algorithm: "sha256", value: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
				createdAt: "2026-09-04T12:00:00.000Z",
			},
			config: { harness: { adapter: "codex", codex: { bin: "/opt/codex", model: "gpt-codex" } }, execution: { mode: "host" }, autopilot: { verification: { command: "test" } } },
			nonInteractive: true,
			signal,
			verificationFailure: "tests failed",
			cursor: 0,
		};
		const result = await adapter.next(context);
		assert.equal(result.cursor, 1);
		assert.equal(calls[0]?.bin, "/opt/codex");
		assert.deepEqual(calls[0]?.args.slice(0, 8), ["exec", "--approve-for-me", "--sandbox", "workspace-write", "--cd", context.worktree, "--model", "gpt-codex"]);
		assert.match(calls[0]?.args.at(-1) ?? "", /tests failed/);
		assert.equal(calls[0]?.signal, signal);
		assert.equal(calls[0]?.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
	});
});
