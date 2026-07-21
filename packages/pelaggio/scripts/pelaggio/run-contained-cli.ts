#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";
import { type ContainedRunOptions, type ContainedRunResult, type ContainedSelfTestResult, runContained, runContainedSelfTest } from "./contained-execution.js";

export interface ParsedRunContainedArgs extends ContainedRunOptions {}

export function parseRunContainedArgs(argv: readonly string[], cwd = process.cwd()): ParsedRunContainedArgs {
	let worktree = cwd;
	let debug = false;
	let selfTest = false;
	let separator = -1;
	let egressProvider: string | undefined;
	let egressModel: string | undefined;
	let egressAuth: "key" | "transparent" | undefined;
	let keyEnv: string | undefined;
	let conformanceProvider: string | undefined;
	const take = (name: string, index: number): string => {
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
		return value;
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") {
			separator = index;
			break;
		}
		if (arg === "--debug") debug = true;
		else if (arg === "--self-test") selfTest = true;
		else if (arg === "--egress" || arg === "--egress-model" || arg === "--egress-auth" || arg === "--key-env" || arg === "--egress-conformance") {
			const value = take(arg, index);
			if (arg === "--egress") {
				if (egressProvider) throw new Error("duplicate --egress");
				egressProvider = value;
			} else if (arg === "--egress-model") {
				if (egressModel) throw new Error("duplicate --egress-model");
				egressModel = value;
			} else if (arg === "--egress-auth") {
				if (egressAuth) throw new Error("duplicate --egress-auth");
				if (value !== "key" && value !== "transparent") throw new Error("--egress-auth must be key or transparent");
				egressAuth = value;
			} else if (arg === "--key-env") {
				if (keyEnv) throw new Error("duplicate --key-env");
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("--key-env must be an environment variable name");
				keyEnv = value;
			} else {
				if (conformanceProvider) throw new Error("duplicate --egress-conformance");
				conformanceProvider = value;
			}
			index += 1;
		} else if (arg === "--worktree") {
			const value = argv[++index];
			if (!value) throw new Error("--worktree requires a path");
			worktree = value;
		} else throw new Error(`unknown option: ${arg}`);
	}
	if (conformanceProvider) {
		selfTest = true;
		if (egressProvider && egressProvider !== conformanceProvider) throw new Error("egress provider conflicts with conformance provider");
		egressProvider = conformanceProvider;
	}
	const selected = [egressProvider, egressModel, egressAuth].filter(Boolean).length;
	if (selected !== 0 && selected !== 3) throw new Error("--egress, --egress-model, and --egress-auth must be selected together");
	if (egressAuth === "key" && !keyEnv) throw new Error("key auth requires --key-env");
	if (egressAuth === "transparent" && keyEnv) throw new Error("--key-env is forbidden for transparent auth");
	if (egressAuth === "transparent" && !conformanceProvider) throw new Error("transparent auth is supported only by egress conformance");
	if (keyEnv && process.env[keyEnv] === undefined) throw new Error(`key environment variable is not set: ${keyEnv}`);
	const egress =
		egressProvider && egressModel && egressAuth
			? { provider: egressProvider, model: egressModel, auth: egressAuth === "key" ? ({ kind: "key", env: keyEnv as string, header: "authorization", scheme: "Bearer" } as const) : ({ kind: "transparent" } as const) }
			: undefined;
	if (selfTest) {
		if (separator !== -1) throw new Error("--self-test cannot be combined with a command");
		return { worktree, debug, mode: { kind: "self-test" }, ...(egress ? { egress } : {}) };
	}
	if (separator === -1) throw new Error("command mode requires -- separator");
	const command = argv.slice(separator + 1);
	if (!command[0]) throw new Error("missing command after --");
	return { worktree, debug, mode: { kind: "command", argv: command as [string, ...string[]] }, ...(egress ? { egress } : {}) };
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
			const result = await (deps.selfTest ?? runContainedSelfTest)({ worktree: options.worktree, debug: options.debug, ...(options.egress ? { egress: options.egress } : {}) });
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
