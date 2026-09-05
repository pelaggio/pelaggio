import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanSkillsOut, copySkillsIn } from "../../pack-prepare.js";

const PELAGGIO_PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const REPO = resolve(PELAGGIO_PKG, "../..");
const BIN = resolve(PELAGGIO_PKG, "bin/pelaggio.js");
const temps: string[] = [];
after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function consumer(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pelaggio-pack-"));
	temps.push(cwd);
	execFileSync("git", ["init", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "test"], { cwd });
	writeFileSync(join(cwd, "README.md"), "consumer\n");
	writeFileSync(join(cwd, "ticket.md"), "Add a hello export\n");
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["commit", "-m", "init"], { cwd });
	mkdirSync(join(cwd, ".pelaggio"));
	writeFileSync(
		join(cwd, ".pelaggio", "pelaggio.yml"),
		`harness:\n  adapter: fake\n  fake:\n    script:\n      - { action: write, path: src/hello.ts, content: "export const hello = 1;" }\n      - { action: complete }\nexecution:\n  mode: host\nautopilot:\n  verification:\n    command: git diff --check HEAD\n`,
	);
	return cwd;
}

function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...env, NO_COLOR: "1" } });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("local autopilot packed CLI", () => {
	it("JSON mode emits one schema-valid stdout payload with no ANSI", () => {
		const cwd = consumer();
		const result = runCli(cwd, ["run", "--file", "ticket.md", "--non-interactive", "--json"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.includes("\u001b["), false);
		const lines = result.stdout.split("\n").filter(Boolean);
		assert.equal(lines.length, 1);
		const snapshot = JSON.parse(result.stdout);
		assert.equal(snapshot.disposition, "ready_for_review");
		assert.equal(snapshot.state, "completed");
		assert.equal(snapshot.execution.mode, "host");
		assert.equal(snapshot.execution.effectsEnforced, false);
		assert.equal(
			snapshot.artifacts.some((artifact: { kind: string }) => artifact.kind === "verification"),
			true,
		);
		assert.ok(existsSync(join(snapshot.worktree.path, "src/hello.ts")));
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "consumer\n");
	});

	it("doctor and show work against the same runId", () => {
		const cwd = consumer();
		const started = runCli(cwd, ["run", "--file", "ticket.md", "--json"]);
		assert.equal(started.status, 0, started.stderr);
		const snapshot = JSON.parse(started.stdout);
		const shown = runCli(cwd, ["show", snapshot.runId, "--json"]);
		assert.equal(shown.status, 0, shown.stderr);
		assert.equal(JSON.parse(shown.stdout).runId, snapshot.runId);
		const doctor = runCli(cwd, ["doctor", "--json"]);
		assert.equal(doctor.status, 0, doctor.stderr);
		assert.equal(JSON.parse(doctor.stdout).ok, true);
	});

	it("ships command help, strict arity, and the cancel route", () => {
		const cwd = consumer();
		const help = runCli(cwd, ["run", "--file", "ticket.md", "--help"]);
		assert.equal(help.status, 0, help.stderr);
		assert.match(help.stdout, /--allow-host-execution/);

		const extra = runCli(cwd, ["show", "one", "two", "--json"]);
		assert.equal(extra.status, 2);
		assert.equal(JSON.parse(extra.stdout).code, "run-id");

		writeFileSync(
			join(cwd, ".pelaggio", "pelaggio.yml"),
			`harness:\n  adapter: fake\n  fake:\n    script:\n      - { action: decision, code: choose, message: "Choose." }\nexecution:\n  mode: host\nautopilot:\n  verification:\n    command: git diff --check HEAD\n`,
		);
		const started = runCli(cwd, ["run", "--file", "ticket.md", "--json"]);
		assert.equal(started.status, 0, started.stderr);
		const runId = JSON.parse(started.stdout).runId as string;
		const cancelled = runCli(cwd, ["cancel", runId, "--json"]);
		assert.equal(cancelled.status, 0, cancelled.stderr);
		assert.equal(JSON.parse(cancelled.stdout).disposition, "cancelled");
	});

	it("packed tarball contains the contract schema and the local-autopilot runtime", () => {
		copySkillsIn(PELAGGIO_PKG, REPO);
		try {
			const packed = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: PELAGGIO_PKG, encoding: "utf8" });
			const jsonStart = packed.indexOf("[");
			const files = (JSON.parse(packed.slice(jsonStart)) as Array<{ files: Array<{ path: string }> }>)[0].files.map((file) => file.path);
			assert.ok(files.includes("scripts/pelaggio/local-autopilot/schemas/v0.schema.json"));
			assert.ok(files.includes("scripts/pelaggio/local-autopilot/engine.ts"));
			assert.ok(files.includes("scripts/pelaggio/local-autopilot-cli.ts"));
			assert.ok(files.includes("bin/pelaggio.js"));
			assert.ok(!files.some((path) => path.includes("local-autopilot-engine.test.ts")));
		} finally {
			cleanSkillsOut(PELAGGIO_PKG);
		}
	});

	it("runs the installed bin from the packed tarball", () => {
		const cwd = consumer();
		const packDir = mkdtempSync(join(tmpdir(), "pelaggio-tarball-"));
		temps.push(packDir);
		copySkillsIn(PELAGGIO_PKG, REPO);
		try {
			const packed = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], {
				cwd: PELAGGIO_PKG,
				encoding: "utf8",
			});
			const [{ filename }] = JSON.parse(packed.slice(packed.indexOf("["))) as Array<{ filename: string }>;
			execFileSync("npm", ["install", "--ignore-scripts", "--no-package-lock", "--no-save", join(packDir, filename)], { cwd, stdio: "pipe" });
			const installedBin = join(cwd, "node_modules", ".bin", "pelaggio");
			const result = spawnSync(installedBin, ["doctor", "--json"], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
			assert.equal(result.status, 0, result.stderr);
			assert.equal(JSON.parse(result.stdout).ok, true);
		} finally {
			cleanSkillsOut(PELAGGIO_PKG);
		}
	});
});
