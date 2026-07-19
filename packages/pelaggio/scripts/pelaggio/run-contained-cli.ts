#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";
import { type ContainedRunOptions, type ContainedRunResult, type ContainedSelfTestResult, runContained, runContainedSelfTest } from "./contained-execution.js";

export interface ParsedRunContainedArgs extends ContainedRunOptions {}

export function parseRunContainedArgs(argv: readonly string[], cwd = process.cwd()): ParsedRunContainedArgs {
	let worktree = cwd;
	let debug = false;
	let selfTest = false;
	let separator = -1;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") {
			separator = index;
			break;
		}
		if (arg === "--debug") debug = true;
		else if (arg === "--self-test") selfTest = true;
		else if (arg === "--worktree") {
			const value = argv[++index];
			if (!value) throw new Error("--worktree requires a path");
			worktree = value;
		} else throw new Error(`unknown option: ${arg}`);
	}
	if (selfTest) {
		if (separator !== -1) throw new Error("--self-test cannot be combined with a command");
		return { worktree, debug, mode: { kind: "self-test" } };
	}
	if (separator === -1) throw new Error("command mode requires -- separator");
	const command = argv.slice(separator + 1);
	if (!command[0]) throw new Error("missing command after --");
	return { worktree, debug, mode: { kind: "command", argv: command as [string, ...string[]] } };
}

export interface RunContainedCliDependencies {
	run?: (options: ContainedRunOptions) => Promise<ContainedRunResult>;
	selfTest?: (options: Omit<ContainedRunOptions, "mode">) => Promise<ContainedSelfTestResult>;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

export async function runContainedCli(argv: readonly string[], deps: RunContainedCliDependencies = {}): Promise<number> {
	const stdout = deps.stdout ?? ((text) => process.stdout.write(text));
	const stderr = deps.stderr ?? ((text) => process.stderr.write(text));
	try {
		const options = parseRunContainedArgs(argv);
		if (options.mode.kind === "self-test") {
			const result = await (deps.selfTest ?? runContainedSelfTest)({ worktree: options.worktree, debug: options.debug });
			stdout(`${JSON.stringify(result)}\n`);
			return result.passed ? 0 : 1;
		}
		const result = await (deps.run ?? runContained)(options);
		stdout(`${JSON.stringify(result)}\n`);
		return result.status;
	} catch (error) {
		stderr(`run-contained: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	process.exitCode = await runContainedCli(process.argv.slice(2));
}
