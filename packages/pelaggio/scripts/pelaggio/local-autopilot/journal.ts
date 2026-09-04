import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseRunEvent } from "./parse.js";
import { eventsPath } from "./paths.js";
import type { RunEvent } from "./types.js";

export function appendRunEvent(cwd: string, event: RunEvent): void {
	const path = eventsPath(cwd, event.runId);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(event)}\n`);
}

export function readRunEvents(cwd: string, runId: string): RunEvent[] {
	let raw: string;
	try {
		raw = readFileSync(eventsPath(cwd, runId), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const events: RunEvent[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		const parsed = parseRunEvent(JSON.parse(line));
		if (!parsed.ok) throw new Error(`journal: ${parsed.problem.message}`);
		events.push(parsed.value);
	}
	return events;
}
