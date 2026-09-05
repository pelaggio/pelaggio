import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createCodexAdapter } from "../local-autopilot/codex-adapter.js";
import { createGrokAdapter } from "../local-autopilot/grok-adapter.js";
import { buildWorkContract } from "../local-autopilot/work-contract.js";

for (const adapter of [createCodexAdapter(), createGrokAdapter()]) {
	it(`${adapter.name} closes unused stdin so the real subprocess can finish`, { timeout: 10_000 }, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pelaggio-adapter-stdin-"));
		const bin = join(cwd, "harness");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 3000);
		try {
			writeFileSync(bin, `#!${process.execPath}\nrequire("node:fs").readFileSync(0);\n`);
			chmodSync(bin, 0o755);
			const result = await adapter.next({
				cwd,
				worktree: cwd,
				workContract: buildWorkContract({ text: "Task" }),
				config: { harness: { adapter: adapter.name, [adapter.name]: { bin } }, execution: { mode: "host" } },
				nonInteractive: true,
				cursor: 0,
				signal: controller.signal,
			});
			assert.equal(controller.signal.aborted, false, "harness waited for stdin until interrupted");
			assert.deepEqual(result.action, { kind: "complete" });
		} finally {
			clearTimeout(timer);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
}
