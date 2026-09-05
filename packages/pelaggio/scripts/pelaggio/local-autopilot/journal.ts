import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { parseRunEvent } from "./parse.js";
import { eventsPath } from "./paths.js";
import type { RunEvent } from "./types.js";

export function appendRunEvent(cwd: string, event: RunEvent): void {
	const path = eventsPath(cwd, event.runId);
	mkdirSync(dirname(path), { recursive: true });
	const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW);
	try {
		writeSync(fd, `${JSON.stringify(event)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function readRunEvents(cwd: string, runId: string): RunEvent[] {
	let raw: string;
	try {
		const fd = openSync(eventsPath(cwd, runId), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			raw = readFileSync(fd, "utf8");
		} finally {
			closeSync(fd);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const events: RunEvent[] = [];
	const eventIds = new Set<string>();
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error("journal contains a truncated or invalid JSON record");
		}
		const parsed = parseRunEvent(value);
		if (!parsed.ok) throw new Error(`journal: ${parsed.problem.message}`);
		if (parsed.value.runId !== runId) throw new Error(`journal runId mismatch at seq ${parsed.value.seq}`);
		if (parsed.value.seq !== events.length) throw new Error(`journal seq must be contiguous from 0; got ${parsed.value.seq} at index ${events.length}`);
		if (eventIds.has(parsed.value.eventId)) throw new Error(`journal repeats eventId ${parsed.value.eventId}`);
		eventIds.add(parsed.value.eventId);
		events.push(parsed.value);
	}
	if (events.length > 0 && events[0]?.type !== "pelaggio.local-autopilot.run-started") throw new Error("journal must begin with run-started");
	return events;
}
