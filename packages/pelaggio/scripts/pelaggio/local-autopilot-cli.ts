import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadLocalConfig } from "./local-autopilot/config-load.js";
import { cancelRun, continueRun, getRun, startRun } from "./local-autopilot/engine.js";
import { configPath } from "./local-autopilot/paths.js";
import { exitCodeFor, exitCodeForProblem, presentHuman, presentJson, presentProblemHuman } from "./local-autopilot/present.js";
import { protocolProblem } from "./local-autopilot/transport.js";
import type { ParseResult, Problem, RunSnapshot, TaskInput } from "./local-autopilot/types.js";

const OPTIONS = {
	file: { type: "string" },
	text: { type: "string" },
	stdin: { type: "boolean", default: false },
	json: { type: "boolean", default: false },
	"non-interactive": { type: "boolean", default: false },
	"request-id": { type: "string" },
	"allow-host-execution": { type: "boolean", default: false },
} as const;

const HELP: Record<string, string> = {
	run: "Usage: pelaggio run (--file <path> | --text <task> | --stdin) [--non-interactive] [--json] [--request-id <id>] [--allow-host-execution]\nExample: pelaggio run --file ticket.md --allow-host-execution\n",
	resume: "Usage: pelaggio resume <runId> [--json]\n",
	show: "Usage: pelaggio show <runId> [--json]\n",
	cancel: "Usage: pelaggio cancel <runId> [--json]\n",
	doctor: "Usage: pelaggio doctor [--json]\n",
};

function writeResult(json: boolean, result: ParseResult<RunSnapshot>): number {
	if (!result.ok) {
		if (json) process.stdout.write(presentJson(result.problem));
		else process.stderr.write(presentProblemHuman(result.problem));
		return exitCodeForProblem(result.problem);
	}
	if (json) process.stdout.write(presentJson(result.value));
	else process.stdout.write(presentHuman(result.value));
	return exitCodeFor(result.value);
}

function writeProblem(json: boolean, problem: Problem): number {
	if (json) process.stdout.write(presentJson(problem));
	else process.stderr.write(presentProblemHuman(problem));
	return exitCodeForProblem(problem);
}

function taskFromValues(values: { file?: string; text?: string; stdin: boolean }): ParseResult<TaskInput> {
	const present = [values.file !== undefined, values.text !== undefined, values.stdin].filter(Boolean).length;
	if (present !== 1) return { ok: false, problem: protocolProblem("task", "exactly one of --file, --text, or --stdin is required") };
	if (values.file !== undefined) return { ok: true, value: { file: values.file } };
	if (values.text !== undefined) return { ok: true, value: { text: values.text } };
	return { ok: true, value: { stdin: true } };
}

async function runCommand(argv: string[]): Promise<number> {
	const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
	const values = parsed.values;
	const json = !!values.json;
	const task = taskFromValues({ file: values.file, text: values.text, stdin: !!values.stdin });
	if (!task.ok) return writeProblem(json, task.problem);
	const controller = new AbortController();
	const onInterrupt = (): void => controller.abort();
	process.once("SIGINT", onInterrupt);
	try {
		const result = await startRun(process.cwd(), { task: task.value, nonInteractive: !!values["non-interactive"], requestId: values["request-id"], allowHostExecution: !!values["allow-host-execution"] }, { signal: controller.signal });
		return writeResult(json, result);
	} finally {
		process.removeListener("SIGINT", onInterrupt);
	}
}

async function resumeCommand(argv: string[]): Promise<number> {
	const parsed = parseArgs({ args: argv, options: { json: { type: "boolean", default: false } }, allowPositionals: true });
	const runId = parsed.positionals[0];
	const json = !!parsed.values.json;
	if (!runId || parsed.positionals.length !== 1) return writeProblem(json, protocolProblem("run-id", "resume requires exactly one runId"));
	const controller = new AbortController();
	const onInterrupt = (): void => controller.abort();
	process.once("SIGINT", onInterrupt);
	try {
		return writeResult(json, await continueRun(process.cwd(), runId, { signal: controller.signal }));
	} finally {
		process.removeListener("SIGINT", onInterrupt);
	}
}

async function showCommand(argv: string[]): Promise<number> {
	const parsed = parseArgs({ args: argv, options: { json: { type: "boolean", default: false } }, allowPositionals: true });
	const runId = parsed.positionals[0];
	const json = !!parsed.values.json;
	if (!runId || parsed.positionals.length !== 1) return writeProblem(json, protocolProblem("run-id", "show requires exactly one runId"));
	return writeResult(json, getRun(process.cwd(), runId));
}

function doctorCommand(argv: string[]): number {
	const parsed = parseArgs({ args: argv, options: { json: { type: "boolean", default: false } }, allowPositionals: false });
	const json = !!parsed.values.json;
	const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
	try {
		execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8" });
		checks.push({ name: "git", ok: true, detail: "repository" });
	} catch {
		checks.push({ name: "git", ok: false, detail: "not a git repository" });
	}
	checks.push({ name: "node", ok: true, detail: process.version });
	const config = loadLocalConfig(process.cwd());
	if (!config.ok) checks.push({ name: "config", ok: false, detail: config.problem.message });
	else {
		checks.push({ name: "config", ok: true, detail: configPath(process.cwd()) });
		const host = config.value.execution?.mode === "host";
		checks.push({ name: "execution", ok: host, detail: host ? "host (explicitly allowed; effects are not enforced)" : "contained execution is not available in this preview" });
		const verification = config.value.autopilot?.verification?.command;
		checks.push({ name: "verification", ok: !!verification, detail: verification ?? "autopilot.verification.command is required" });
		if (config.value.harness.adapter === "grok") {
			const bin = config.value.harness.grok?.bin ?? join(homedir(), ".grok", "bin", "grok");
			checks.push({ name: "harness", ok: existsSync(bin), detail: bin });
		} else if (config.value.harness.adapter === "codex") {
			const bin = config.value.harness.codex?.bin ?? "codex";
			try {
				execFileSync(bin, ["--version"], { encoding: "utf8", stdio: "ignore" });
				checks.push({ name: "harness", ok: true, detail: bin });
			} catch {
				checks.push({ name: "harness", ok: false, detail: `${bin} is not executable` });
			}
		} else checks.push({ name: "harness", ok: true, detail: "fake" });
	}
	const ok = checks.every((check) => check.ok);
	const body = { schemaVersion: 1, ok, checks };
	if (json) process.stdout.write(`${JSON.stringify(body)}\n`);
	else {
		for (const check of checks) process.stdout.write(`${check.ok ? "ok" : "fail"} ${check.name}: ${check.detail}\n`);
	}
	return ok ? 0 : 1;
}

async function dispatch(argv: string[]): Promise<number> {
	const command = argv[0] ?? "run";
	const rest = argv.slice(1);
	if (rest.includes("--help") || rest.includes("-h")) {
		process.stdout.write(HELP[command] ?? "Unknown local-autopilot command.\n");
		return HELP[command] ? 0 : 2;
	}
	if (command === "run") return runCommand(rest);
	if (command === "resume") return resumeCommand(rest);
	if (command === "show") return showCommand(rest);
	if (command === "doctor") return doctorCommand(rest);
	if (command === "cancel") {
		const parsed = parseArgs({ args: rest, options: { json: { type: "boolean", default: false } }, allowPositionals: true });
		const runId = parsed.positionals[0];
		const json = !!parsed.values.json;
		if (!runId || parsed.positionals.length !== 1) return writeProblem(json, protocolProblem("run-id", "cancel requires exactly one runId"));
		return writeResult(json, await cancelRun(process.cwd(), runId));
	}
	return writeProblem(false, protocolProblem("command", `unknown local-autopilot command ${command}`));
}

export async function main(argv: string[]): Promise<number> {
	try {
		return await dispatch(argv);
	} catch (error) {
		return writeProblem(argv.includes("--json"), protocolProblem("arguments", error instanceof Error ? error.message : String(error)));
	}
}

const isMain = process.argv[1] && (process.argv[1].endsWith("local-autopilot-cli.ts") || process.argv[1].endsWith("local-autopilot-cli.js"));
if (isMain) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
			process.exit(1);
		},
	);
}
