import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveExecutionAssurance } from "../local-autopilot/execution-policy.js";
import type { LocalConfig } from "../local-autopilot/types.js";

const config: LocalConfig = { harness: { adapter: "fake" }, execution: { mode: "host" } };
const policy = ".pelaggio/pelaggio.yml";
function fixture(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pelaggio-policy-"));
	execFileSync("git", ["init", "-q"], { cwd });
	mkdirSync(join(cwd, ".pelaggio"));
	writeFileSync(join(cwd, policy), "execution:\n  mode: host\nharness:\n  adapter: fake\n");
	return cwd;
}

test("untracked operator policy allows host execution, including an unborn repository", () => {
	const cwd = fixture();
	try {
		assert.equal(resolveExecutionAssurance(cwd, config, false).ok, true);
		assert.equal(resolveExecutionAssurance(cwd, { harness: { adapter: "fake" } }, false).ok, false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("indexed and committed policy require an explicit flag, including staged deletion/recreation", () => {
	const cwd = fixture();
	const git = (...args: string[]): void => {
		execFileSync("git", args, { cwd });
	};
	try {
		git("add", policy);
		assert.equal(resolveExecutionAssurance(cwd, config, false).ok, false);
		assert.equal(resolveExecutionAssurance(cwd, config, true).ok, true);
		git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "policy");
		assert.equal(resolveExecutionAssurance(cwd, config, false).ok, false);
		git("rm", "--cached", policy);
		assert.equal(resolveExecutionAssurance(cwd, config, false).ok, false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("symlink files and policy directories cannot confer consent", () => {
	for (const directory of [false, true]) {
		const cwd = fixture();
		try {
			const text = readFileSync(join(cwd, policy));
			rmSync(join(cwd, ".pelaggio"), { recursive: true });
			mkdirSync(join(cwd, "elsewhere"));
			writeFileSync(join(cwd, "elsewhere", "pelaggio.yml"), text);
			if (directory) symlinkSync("elsewhere", join(cwd, ".pelaggio"));
			else {
				mkdirSync(join(cwd, ".pelaggio"));
				symlinkSync("../elsewhere/pelaggio.yml", join(cwd, policy));
			}
			assert.equal(resolveExecutionAssurance(cwd, config, false).ok, false);
			assert.equal(resolveExecutionAssurance(cwd, config, true).ok, true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});

test("Git provenance errors fail closed", () => {
	const cwd = fixture();
	try {
		rmSync(join(cwd, ".git"), { recursive: true });
		assert.equal(resolveExecutionAssurance(cwd, config, false).ok, false);
		assert.equal(resolveExecutionAssurance(cwd, config, true).ok, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("doctor checks a repository-configured executable without invoking it", () => {
	const cwd = fixture();
	try {
		const bin = join(cwd, "harness");
		const marker = join(cwd, "executed");
		writeFileSync(bin, `#!/bin/sh\ntouch '${marker}'\n`);
		chmodSync(bin, 0o755);
		writeFileSync(join(cwd, policy), `execution:\n  mode: host\nharness:\n  adapter: codex\n  codex:\n    bin: ${bin}\nautopilot:\n  verification:\n    command: "true"\n`);
		execFileSync("git", ["add", policy], { cwd });
		const cli = fileURLToPath(new URL("../../../bin/pelaggio.js", import.meta.url));
		const result = spawnSync(process.execPath, [cli, "doctor", "--json"], { cwd, encoding: "utf8" });
		assert.equal(result.status, 1, result.stderr);
		const report = JSON.parse(result.stdout);
		assert.equal(report.checks.find((check: { name: string }) => check.name === "execution").ok, false);
		assert.equal(report.checks.find((check: { name: string }) => check.name === "harness").ok, true);
		assert.throws(() => readFileSync(marker), { code: "ENOENT" });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("resume exposes and forwards fresh CLI host consent", () => {
	const source = readFileSync(new URL("../local-autopilot-cli.ts", import.meta.url), "utf8");
	const resume = source.slice(source.indexOf("async function resumeCommand("), source.indexOf("async function showCommand("));
	assert.match(source, /Usage: pelaggio resume <runId> \[--json\] \[--allow-host-execution\]/);
	assert.match(resume, /"allow-host-execution": \{ type: "boolean", default: false \}/);
	assert.match(resume, /continueRun\(process\.cwd\(\), runId, \{ signal: controller\.signal, allowHostExecution: !!parsed\.values\["allow-host-execution"\] \}\)/);
});

test("repository gitlink ancestors confer ownership but unrelated tracked siblings do not", () => {
	const cwd = fixture();
	const git = (...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
	try {
		writeFileSync(join(cwd, ".pelaggio", "other"), "tracked sibling");
		git("add", ".pelaggio/other");
		git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "sibling");
		assert.equal(resolveExecutionAssurance(cwd, config, false).ok, true);
		const head = git("rev-parse", "HEAD").trim();
		git("rm", "--cached", ".pelaggio/other");
		git("update-index", "--add", "--cacheinfo", `160000,${head},.pelaggio`);
		assert.equal(resolveExecutionAssurance(cwd, config, false).ok, false);
		assert.equal(resolveExecutionAssurance(cwd, config, true).ok, true);
		git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "gitlink");
		git("update-index", "--force-remove", ".pelaggio");
		assert.equal(resolveExecutionAssurance(cwd, config, false).ok, false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
