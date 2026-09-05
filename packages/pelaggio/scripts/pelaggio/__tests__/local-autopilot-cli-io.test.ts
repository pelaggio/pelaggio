import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = new URL("../../../bin/pelaggio.js", import.meta.url).pathname;

function fixture(config: string): string {
	const cwd = mkdtempSync(join(tmpdir(), "pelaggio-cli-io-"));
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "init"], { cwd });
	mkdirSync(join(cwd, ".pelaggio"));
	writeFileSync(join(cwd, ".pelaggio", "pelaggio.yml"), config);
	return cwd;
}

test("actual CLI keeps SIGINT handling through a backpressured large JSON drain", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
	const cwd = fixture('harness:\n  adapter: fake\n  fake:\n    script:\n      - { action: complete }\nexecution:\n  mode: host\nautopilot:\n  verification:\n    command: "true"\n');
	try {
		const body = "context-block\n".repeat(200_000);
		writeFileSync(join(cwd, "task.md"), body);
		const child = spawn(process.execPath, [cli, "run", "--file", "task.md", "--json"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		for (let i = 0; i < 300; i++) {
			const runs = join(cwd, ".pelaggio", "runs");
			const runId = existsSync(runs) ? readdirSync(runs).find((entry) => !["by-request", "request-locks"].includes(entry)) : undefined;
			if (runId && existsSync(join(runs, runId, "events.jsonl")) && readFileSync(join(runs, runId, "events.jsonl"), "utf8").includes("run-completed")) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(child.exitCode, null, "large output should still be backpressured");
		process.kill(-child.pid!, "SIGINT");
		let stdout = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
		assert.equal(code, 0, stderr);
		const snapshot = JSON.parse(stdout);
		assert.equal(snapshot.workContract.body, body);
		assert.equal(stdout.endsWith("\n"), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("foreground duplicate SIGINT waits for checkpoint and lease release", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pelaggio-cli-signal-"));
	const harness = join(cwd, "harness");
	const ready = join(cwd, "provider-ready");
	writeFileSync(harness, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(ready)},"ready");process.on("SIGINT",()=>{});setInterval(()=>{},1000);\n`);
	chmodSync(harness, 0o755);
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "init"], { cwd });
	mkdirSync(join(cwd, ".pelaggio"));
	writeFileSync(join(cwd, ".pelaggio", "pelaggio.yml"), `harness:\n  adapter: codex\n  codex:\n    bin: ${harness}\nexecution:\n  mode: host\nautopilot:\n  verification:\n    command: "true"\n`);
	const child = spawn(process.execPath, [cli, "run", "--text", "Wait", "--json"], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
	child.stdin.end();
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	try {
		for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(existsSync(ready), stderr);
		process.kill(-child.pid!, "SIGINT");
		const code = await new Promise<number | null>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("CLI did not finish interruption")), 5000);
			child.once("exit", (value) => {
				clearTimeout(timer);
				resolve(value);
			});
		});
		assert.equal(code, 130, stderr);
		const snapshot = JSON.parse(stdout);
		assert.equal(snapshot.state, "paused");
		assert.equal(snapshot.pauseReason.code, "interrupted");
		const runDir = join(cwd, ".pelaggio", "runs", readdirSync(join(cwd, ".pelaggio", "runs")).find((entry) => !["by-request", "request-locks"].includes(entry))!);
		assert.equal(existsSync(join(runDir, "lease")), false);
		assert.match(readFileSync(join(runDir, "events.jsonl"), "utf8"), /checkpointed/);
	} finally {
		if (child.exitCode === null) process.kill(-child.pid!, "SIGKILL");
		rmSync(cwd, { recursive: true, force: true });
	}
});
