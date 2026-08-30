#!/usr/bin/env tsx
/**
 * Deterministic sweep of expired cross-process session records (#369).
 * Invoked by `/tidy` as `npx pelaggio sessions-sweep` — agents never parse/delete
 * records themselves.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./config.js";
import { sessionsDir, sweepExpiredSessions } from "./confinement/sessions.js";
import { registerRelativePath } from "./registers.js";

export function sessionsSweepMain(args = process.argv.slice(2), mainRepo = REPO): number {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`Usage: pelaggio sessions-sweep\n\nRemove content-expired session records under MAIN_REPO/${registerRelativePath("sessions")}/.\nRetains live, unreadable, and malformed records fail-closed.`);
		return 0;
	}
	const result = sweepExpiredSessions(mainRepo);
	const dir = sessionsDir(mainRepo);
	console.log(`sessions-sweep: ${dir}`);
	console.log(`  removed: ${result.removed.length}${result.removed.length ? ` (${result.removed.join(", ")})` : ""}`);
	console.log(`  retained: ${result.retained.length}`);
	for (const r of result.retained) {
		console.log(`    ${r.file}: ${r.reason}`);
	}
	return 0;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	try {
		process.exitCode = sessionsSweepMain();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
