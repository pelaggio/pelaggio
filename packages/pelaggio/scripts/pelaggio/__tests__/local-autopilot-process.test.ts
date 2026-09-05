import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createCodexAdapter } from "../local-autopilot/codex-adapter.js";
import { createGrokAdapter } from "../local-autopilot/grok-adapter.js";
import { runLocalProcess } from "../local-autopilot/process.js";
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

it("interrupt stops descendants with independent stdio before returning", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pelaggio-process-group-"));
	const marker = join(cwd, "writes");
	const controller = new AbortController();
	const grandchild = `const fs=require("node:fs");setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},"x"),10);`;
	const parent = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"ignore"});setInterval(()=>{},1000);`;
	const pending = runLocalProcess(process.execPath, ["-e", parent], cwd, controller.signal);
	try {
		for (let i = 0; i < 100 && !existsSync(marker); i++) await delay(20);
		assert.ok(existsSync(marker), "grandchild started writing");
		controller.abort();
		const result = await pending;
		assert.equal(result.ok, false);
		const stopped = readFileSync(marker, "utf8");
		await delay(100);
		assert.equal(readFileSync(marker, "utf8"), stopped, "no child writes after ownership returns");
	} finally {
		controller.abort();
		await pending;
		rmSync(cwd, { recursive: true, force: true });
	}
});

it("interrupt escalates when the direct child ignores SIGINT", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pelaggio-process-stubborn-"));
	const marker = join(cwd, "ready");
	const controller = new AbortController();
	const program = `process.on("SIGINT",()=>{});require("node:fs").writeFileSync(${JSON.stringify(marker)},"ready");setInterval(()=>{},1000);`;
	const pending = runLocalProcess(process.execPath, ["-e", program], cwd, controller.signal);
	try {
		for (let i = 0; i < 100 && !existsSync(marker); i++) await delay(20);
		assert.ok(existsSync(marker));
		controller.abort();
		assert.equal((await pending).ok, false);
	} finally {
		controller.abort();
		await pending;
		rmSync(cwd, { recursive: true, force: true });
	}
});
