import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cancelRun, continueRun, getRun, startRun } from "../local-autopilot/engine.js";
import { parseProblem, parseRunSnapshot } from "../local-autopilot/parse.js";
import { presentJson } from "../local-autopilot/present.js";
import { configProblem, conflictProblem, makeProblem, protocolProblem } from "../local-autopilot/transport.js";

test("all runtime problem helpers produce bounded conformant diagnostics", () => {
	for (const message of ["", "normal", "😀".repeat(2001), "a".repeat(10000)]) {
		for (const code of ["ChooseExport", "valid-code", "!?!", "a".repeat(100)]) {
			for (const problem of [protocolProblem(code, message), configProblem(code, message), conflictProblem(code, message), makeProblem({ type: "decision", code, message, retryable: true })]) {
				assert.ok(parseProblem(problem).ok, JSON.stringify(problem));
			}
		}
	}
	assert.equal(makeProblem({ type: "decision", code: "ChooseExport", message: "Choose", retryable: true }).code, "choose-export");
});

test("JSON problem presentation refuses invalid output and keeps long CLI errors conformant", () => {
	const invalid = { schemaVersion: 1 as const, type: "protocol" as const, code: "INVALID", message: "x".repeat(3000), retryable: false };
	assert.ok(parseProblem(JSON.parse(presentJson(invalid))).ok);
	const cli = new URL("../../../bin/pelaggio.js", import.meta.url);
	const result = spawnSync(process.execPath, [cli.pathname, "show", "run", `--${"x".repeat(4000)}`, "--json"], { encoding: "utf8" });
	assert.equal(result.status, 2);
	assert.ok(parseProblem(JSON.parse(result.stdout)).ok);
});

test("runtime producers route through the shared Problem constructor", () => {
	const root = new URL("../local-autopilot/", import.meta.url);
	for (const file of readdirSync(root)) {
		if (!file.endsWith(".ts") || file === "transport.ts" || file === "parse.ts") continue;
		const source = readFileSync(new URL(file, root), "utf8");
		assert.doesNotMatch(source, /:\s*Problem\s*=\s*\{/, `${file} constructs a Problem outside makeProblem`);
		assert.doesNotMatch(source, /schemaVersion:\s*1,\s*type:\s*"(?:config|protocol|decision|verification|harness|conflict)"/, `${file} constructs a Problem outside makeProblem`);
	}
});

test("accepted mixed-case fake decision remains showable, resumable, and cancellable", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pelaggio-problem-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "init"], { cwd });
		mkdirSync(join(cwd, ".pelaggio"));
		writeFileSync(
			join(cwd, ".pelaggio", "pelaggio.yml"),
			'harness:\n  adapter: fake\n  fake:\n    script:\n      - { action: decision, code: ChooseExport, message: Choose }\n      - { action: complete }\nexecution:\n  mode: host\nautopilot:\n  verification:\n    command: "true"\n',
		);
		for (const action of [continueRun, cancelRun]) {
			const result = await startRun(cwd, { task: { text: "Choose export" }, nonInteractive: true });
			assert.ok(result.ok, JSON.stringify(result));
			if (!result.ok) continue;
			assert.equal(result.value.pauseReason?.problem?.code, "choose-export");
			assert.ok(parseRunSnapshot(result.value).ok);
			assert.ok(getRun(cwd, result.value.runId).ok);
			const next = await action(cwd, result.value.runId);
			assert.ok(next.ok, JSON.stringify(next));
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
