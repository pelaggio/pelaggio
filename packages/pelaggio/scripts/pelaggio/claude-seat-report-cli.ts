#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";
import { type ClaudeSeatPreflightOptions, preflightClaudeSeat, renderClaudeSeatDiagnosticReport } from "./claude-seat.js";
import { CONFIG } from "./config.js";

export interface ClaudeSeatReportCliDependencies {
	preflight?: typeof preflightClaudeSeat;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	cwd?: string;
	preview?: boolean;
}

export async function runClaudeSeatReportCli(argv: readonly string[] = [], deps: ClaudeSeatReportCliDependencies = {}): Promise<number> {
	const stdout = deps.stdout ?? ((text) => process.stdout.write(text));
	const stderr = deps.stderr ?? ((text) => process.stderr.write(text));
	try {
		if (argv.some((arg) => arg === "--help" || arg === "-h")) {
			stdout("Usage: pelaggio claude-seat-report\nPrint a scrubbed local Claude-seat conformance report. No repository paths, credentials, or prompt content. Not uploaded.\n");
			return 0;
		}
		if (argv.length > 0) throw new Error(`unknown option: ${argv[0]}`);
		const options: ClaudeSeatPreflightOptions = {
			cwd: deps.cwd ?? process.cwd(),
			step: "pr-review",
			macosSeatbeltPreview: deps.preview ?? CONFIG.claudeMacosSeatbeltPreview,
		};
		const result = await (deps.preflight ?? preflightClaudeSeat)(options);
		if (result.report) stdout(renderClaudeSeatDiagnosticReport(result.report));
		if (!result.ok) {
			stderr(`claude-seat-report: ${result.message}\n`);
			return 1;
		}
		return 0;
	} catch (error) {
		stderr(`claude-seat-report: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	process.exitCode = await runClaudeSeatReportCli(process.argv.slice(2));
}
