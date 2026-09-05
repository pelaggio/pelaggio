import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGrokAdapter } from "../local-autopilot/grok-adapter.js";
import type { HarnessContext } from "../local-autopilot/harness.js";

const contract = {
	schemaVersion: 1 as const,
	workContractId: "work-1",
	title: "Add hello",
	body: "Create the hello export.",
	source: { kind: "text" as const },
	digest: { algorithm: "sha256" as const, value: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
	createdAt: "2026-09-04T12:00:00.000Z",
};

describe("local autopilot Grok adapter", () => {
	it("invokes the harness again with verification context for a repair", async () => {
		const prompts: string[] = [];
		const signals: Array<AbortSignal | undefined> = [];
		const adapter = createGrokAdapter(async (_bin, args, _cwd, signal) => {
			prompts.push(args.at(-1) ?? "");
			signals.push(signal);
			return { ok: true, output: "" };
		});
		const signal = new AbortController().signal;
		const base: HarnessContext = {
			cwd: "/repo",
			worktree: "/repo/.pelaggio/worktrees/run",
			workContract: contract,
			config: { harness: { adapter: "grok", grok: { bin: "/bin/grok" } }, execution: { mode: "host" }, autopilot: { verification: { command: "test" } } },
			nonInteractive: true,
			signal,
			cursor: 0,
		};
		const first = await adapter.next(base);
		const second = await adapter.next({ ...base, cursor: first.cursor, verificationFailure: "tests failed" });
		assert.equal(first.cursor, 1);
		assert.equal(second.cursor, 2);
		assert.equal(prompts.length, 2);
		assert.doesNotMatch(prompts[0] ?? "", /tests failed/);
		assert.match(prompts[1] ?? "", /tests failed/);
		assert.deepEqual(signals, [signal, signal]);
	});
});
