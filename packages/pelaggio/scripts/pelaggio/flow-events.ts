import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ulid } from "ulid";
import { LOG_PATH, REPO } from "./config.js";
import type { CycleLogEntry, EventLogDiagnostic, EventLogDiagnosticKind, EventLogDiagnostics, EventWriter, FlowEvent, FlowEventInput, FlowEventProjection, PelaggioEventType, ReadEventLogResult } from "./types.js";

export const PELAGGIO_EVENT_TYPES = [
	"pelaggio.cycle-completed",
	"pelaggio.became-ready",
	"pelaggio.claimed",
	"pelaggio.plan-published",
	"pelaggio.plan-rejected",
	"pelaggio.shakedown-fail",
	"pelaggio.suspended",
	"pelaggio.resumed",
	"pelaggio.in-review",
	"pelaggio.blocked-discovered",
	"pelaggio.claim-released",
	"pelaggio.shipped",
	"pelaggio.effect-failed",
	"pelaggio.state-observed",
	"pelaggio.state-corrected",
	"pelaggio.watch-idle",
	"pelaggio.watch-wake",
	"pelaggio.budget-idle",
	"pelaggio.budget-wake",
] as const satisfies readonly PelaggioEventType[];

const EVENT_TYPE_COVERAGE: Record<PelaggioEventType, true> = Object.fromEntries(PELAGGIO_EVENT_TYPES.map((type) => [type, true])) as Record<PelaggioEventType, true>;
export const PELAGGIO_EVENT_TYPE_SET: ReadonlySet<PelaggioEventType> = new Set(Object.keys(EVENT_TYPE_COVERAGE) as PelaggioEventType[]);
export const MAX_FLOW_EVENT_BYTES = 64 * 1024;
export const MAX_EVENT_DIAGNOSTIC_DETAILS = 100;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUlid(value: unknown): value is string {
	return typeof value === "string" && ULID_PATTERN.test(value);
}

function isNullableUlid(value: unknown): value is string | null {
	return value === null || isUlid(value);
}

function isCanonicalInstant(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const date = new Date(value);
	return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function isCycleFields(value: UnknownRecord): value is UnknownRecord & CycleLogEntry {
	return (
		typeof value.cycle === "number" &&
		Number.isSafeInteger(value.cycle) &&
		(value.item === null || typeof value.item === "string") &&
		typeof value.quick === "boolean" &&
		Array.isArray(value.steps) &&
		typeof value.total_cost === "number" &&
		(value.verdict === null || typeof value.verdict === "string") &&
		typeof value.completed === "boolean" &&
		(value.error === null || typeof value.error === "string")
	);
}

function decodeV1(value: unknown): FlowEvent | undefined {
	if (!isRecord(value) || value.v !== 1 || typeof value.type !== "string" || !PELAGGIO_EVENT_TYPE_SET.has(value.type as PelaggioEventType)) return undefined;
	if (
		!isUlid(value.eventId) ||
		!isUlid(value.streamId) ||
		!Number.isSafeInteger(value.seq) ||
		(value.seq as number) < 0 ||
		!isCanonicalInstant(value.ts) ||
		!(value.itemId === null || typeof value.itemId === "string") ||
		!isNullableUlid(value.claimId) ||
		!isNullableUlid(value.readinessEpisodeId) ||
		!isUlid(value.executionId) ||
		!isNullableUlid(value.causationId) ||
		(value.attempt !== undefined && (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1))
	)
		return undefined;
	if (value.type === "pelaggio.cycle-completed" && !isCycleFields(value)) return undefined;
	return value as FlowEvent;
}

export interface CreateEventWriterOptions {
	root?: string;
	executionId?: string;
	/** Pin the segment filename (`.dev/flow-events/<streamId>.jsonl`). Must be ULID-shaped. */
	streamId?: string;
	now?: () => Date;
	idFactory?: () => string;
}

export function createEventWriter(options: CreateEventWriterOptions = {}): EventWriter {
	const root = options.root ?? REPO;
	const idFactory = options.idFactory ?? ulid;
	const now = options.now ?? (() => new Date());
	const streamId = options.streamId ?? idFactory();
	const executionId = options.executionId ?? idFactory();
	if (!isUlid(streamId) || !isUlid(executionId)) throw new Error("Flow writer IDs must be ULID-shaped");
	const segmentPath = join(root, ".dev", "flow-events", `${streamId}.jsonl`);
	let seq = 0;
	return {
		streamId,
		executionId,
		append(input: FlowEventInput): FlowEvent {
			const { type, ts, ...payload } = input;
			const candidate: unknown = {
				...payload,
				v: 1,
				type,
				eventId: idFactory(),
				streamId,
				seq: seq + 1,
				ts: ts ?? now().toISOString(),
				itemId: input.itemId ?? null,
				claimId: input.claimId ?? null,
				readinessEpisodeId: input.readinessEpisodeId ?? null,
				executionId,
				causationId: input.causationId ?? null,
			};
			const event = decodeV1(candidate);
			if (!event) throw new Error("Invalid flow event");
			const record = `${JSON.stringify(event)}\n`;
			if (Buffer.byteLength(record, "utf8") > MAX_FLOW_EVENT_BYTES) throw new Error(`Flow event exceeds ${MAX_FLOW_EVENT_BYTES} byte limit`);
			mkdirSync(join(root, ".dev", "flow-events"), { recursive: true });
			appendFileSync(segmentPath, record, "utf8");
			seq = event.seq;
			return event;
		},
	};
}

function emptyDiagnostics(): EventLogDiagnostics {
	return {
		counts: { malformed: 0, truncatedTail: 0, unknownType: 0, duplicateEventId: 0, duplicateSequence: 0, regressingSequence: 0, sequenceGap: 0 },
		details: [],
	};
}

function diagnose(diagnostics: EventLogDiagnostics, detail: EventLogDiagnostic): void {
	diagnostics.counts[detail.kind]++;
	if (diagnostics.details.length < MAX_EVENT_DIAGNOSTIC_DETAILS) diagnostics.details.push(detail);
}

function digestId(domain: string, value: string): string {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	const bytes = createHash("sha256").update(domain).update("\0").update(value).digest();
	let bits = 0;
	let buffer = 0;
	let output = "";
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5 && output.length < 26) {
			bits -= 5;
			output += alphabet[(buffer >>> bits) & 31];
		}
		if (output.length === 26) break;
	}
	return output;
}

function legacyEvent(record: UnknownRecord & CycleLogEntry, source: string, line: number, bytes: string): FlowEvent | undefined {
	const key = `${source}\0${line}\0${bytes}`;
	return decodeV1({
		...record,
		v: 1,
		type: "pelaggio.cycle-completed",
		eventId: digestId("pelaggio-legacy-event", key),
		streamId: digestId("pelaggio-legacy-stream", source),
		seq: line,
		itemId: record.item,
		claimId: null,
		readinessEpisodeId: null,
		executionId: digestId("pelaggio-legacy-execution", source),
		causationId: null,
		legacy: true,
	});
}

function readFileEvents(path: string, diagnostics: EventLogDiagnostics): FlowEvent[] {
	const source = resolve(path);
	const contents = readFileSync(source, "utf8");
	const lines = contents.split("\n");
	const terminated = contents.endsWith("\n");
	const events: FlowEvent[] = [];
	for (let index = 0; index < lines.length; index++) {
		const bytes = lines[index];
		if (bytes.trim() === "") continue;
		const line = index + 1;
		let value: unknown;
		try {
			value = JSON.parse(bytes);
		} catch {
			const kind: EventLogDiagnosticKind = !terminated && index === lines.length - 1 ? "truncatedTail" : "malformed";
			diagnose(diagnostics, { kind, source, line, message: kind === "truncatedTail" ? "Malformed unterminated tail record" : "Invalid JSON" });
			continue;
		}
		if (isRecord(value) && value.type === undefined && isCycleFields(value) && isCanonicalInstant(value.ts)) {
			const event = legacyEvent(value, source, line, bytes);
			if (event) events.push(event);
			else diagnose(diagnostics, { kind: "malformed", source, line, message: "Invalid legacy cycle record" });
			continue;
		}
		if (isRecord(value) && typeof value.type === "string" && !PELAGGIO_EVENT_TYPE_SET.has(value.type as PelaggioEventType)) {
			diagnose(diagnostics, { kind: "unknownType", source, line, observedType: value.type, message: `Unknown event type: ${value.type}` });
			continue;
		}
		const event = decodeV1(value);
		if (event) events.push(event);
		else diagnose(diagnostics, { kind: "malformed", source, line, message: "Invalid event envelope or payload" });
	}
	return events;
}

export interface ReadEventLogOptions {
	root?: string;
	eventsDir?: string;
	cycleLogPath?: string | null;
}

export function readEventLog(options: ReadEventLogOptions = {}): ReadEventLogResult {
	const root = options.root ?? REPO;
	const eventsDir = options.eventsDir ?? join(root, ".dev", "flow-events");
	const cycleLogPath = options.cycleLogPath === undefined ? (root === REPO ? LOG_PATH : join(root, ".dev", "pelaggio-log.jsonl")) : options.cycleLogPath;
	const diagnostics = emptyDiagnostics();
	const events: FlowEvent[] = [];
	if (existsSync(eventsDir)) {
		for (const name of readdirSync(eventsDir)
			.filter((name) => name.endsWith(".jsonl"))
			.sort()) {
			const path = join(eventsDir, name);
			if (statSync(path).isFile()) events.push(...readFileEvents(path, diagnostics));
		}
	}
	if (cycleLogPath) {
		const path = isAbsolute(cycleLogPath) ? cycleLogPath : join(root, cycleLogPath);
		if (existsSync(path) && statSync(path).isFile()) events.push(...readFileEvents(path, diagnostics));
	}

	const byStream = new Map<string, FlowEvent[]>();
	for (const event of events) {
		const stream = byStream.get(event.streamId) ?? [];
		stream.push(event);
		byStream.set(event.streamId, stream);
	}
	for (const stream of byStream.values()) {
		let previous: number | undefined;
		for (const event of stream) {
			if (previous !== undefined) {
				if (event.seq === previous) diagnose(diagnostics, { kind: "duplicateSequence", source: event.streamId, message: `Duplicate sequence ${event.seq}` });
				else if (event.seq < previous) diagnose(diagnostics, { kind: "regressingSequence", source: event.streamId, message: `Regressing sequence ${event.seq}` });
				else if (event.seq > previous + 1) diagnose(diagnostics, { kind: "sequenceGap", source: event.streamId, message: `Sequence gap ${previous}..${event.seq}` });
			}
			previous = event.seq;
		}
	}

	events.sort((a, b) => a.ts.localeCompare(b.ts) || a.streamId.localeCompare(b.streamId) || a.seq - b.seq || a.eventId.localeCompare(b.eventId));
	const seen = new Set<string>();
	const deduplicated = events.filter((event) => {
		if (!seen.has(event.eventId)) {
			seen.add(event.eventId);
			return true;
		}
		diagnose(diagnostics, { kind: "duplicateEventId", source: event.streamId, message: `Duplicate eventId ${event.eventId}` });
		return false;
	});
	return { events: deduplicated, diagnostics };
}

export function foldEvents<T>(events: readonly FlowEvent[], reducer: (state: T, event: FlowEvent) => T, initial: T): T {
	return events.reduce(reducer, initial);
}

export function projectEvents(result: ReadEventLogResult): FlowEventProjection {
	const byType = Object.fromEntries(PELAGGIO_EVENT_TYPES.map((type) => [type, 0])) as Record<PelaggioEventType, number>;
	const counted = foldEvents(
		result.events,
		(count, event) => {
			count[event.type]++;
			return count;
		},
		byType,
	);
	const deduplicatedEvents = result.events.length;
	return { totalEvents: deduplicatedEvents + result.diagnostics.counts.duplicateEventId, deduplicatedEvents, byType: counted, diagnostics: result.diagnostics };
}
