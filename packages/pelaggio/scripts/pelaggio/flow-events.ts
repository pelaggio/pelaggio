import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ulid } from "ulid";
import { LOG_PATH, logPathFor, REPO } from "./config.js";
import { CYCLE_OUTCOME_SET } from "./cycle-errors.js";
import { ensureDevRoot, registerPath } from "./registers.js";
import { makeSecretScrubber } from "./secret-hygiene.js";
import { ALL_STEPS } from "./step-names.js";
import type {
	EventLogDiagnostic,
	EventLogDiagnosticKind,
	EventLogDiagnostics,
	EventWriter,
	FlowEvent,
	FlowEventInput,
	FlowEventProjection,
	PelaggioEventType,
	ProviderName,
	ProviderObservation,
	QuotaChannel,
	QuotaWindowObservation,
	RawCycleLogRecord,
	ReadEventLogResult,
	Step,
} from "./types.js";

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
	"pelaggio.run-started",
	"pelaggio.run-heartbeat",
	"pelaggio.run-finished",
	"pelaggio.provider-usage",
	"pelaggio.provider-limit",
] as const satisfies readonly PelaggioEventType[];

const EVENT_TYPE_COVERAGE: Record<PelaggioEventType, true> = Object.fromEntries(PELAGGIO_EVENT_TYPES.map((type) => [type, true])) as Record<PelaggioEventType, true>;
export const PELAGGIO_EVENT_TYPE_SET: ReadonlySet<PelaggioEventType> = new Set(Object.keys(EVENT_TYPE_COVERAGE) as PelaggioEventType[]);
export const MAX_FLOW_EVENT_BYTES = 64 * 1024;
export const MAX_EVENT_DIAGNOSTIC_DETAILS = 100;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const POOL_ID_PATTERN = /^[kae]:[0-9a-f]{12}$/;

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

function hasNoParkIdentity(value: UnknownRecord): boolean {
	return value.parkProvider === undefined && value.parkWindow === undefined;
}

function hasRateLimitParkIdentity(value: UnknownRecord): boolean {
	return isProviderName(value.parkProvider) && (value.parkWindow === null || typeof value.parkWindow === "string");
}

function isCurrentCycleOutcome(value: UnknownRecord): boolean {
	// Reject BOTH legacy markers (`completed`, `parked`): a record carrying a current
	// `outcome` plus either legacy discriminant is overlapping, not current (fail closed).
	if (value.completed !== undefined || value.parked !== undefined) return false;
	switch (value.outcome) {
		case "completed":
			return hasNoParkIdentity(value) && value.parkClass === undefined && value.parkReason === undefined && value.blockedKind === undefined && value.reason === undefined && value.failureClass === undefined && value.error === undefined;
		case "parked":
			return (
				typeof value.parkClass === "string" &&
				(value.parkReason === null || typeof value.parkReason === "string") &&
				// Rate-limit park identity is all-or-nothing: rows written before #581 (and text-classified
				// parks with no structured rateLimit signal) carry none; partial or malformed identity fails closed.
				(value.parkClass === "rate-limit" ? hasRateLimitParkIdentity(value) || hasNoParkIdentity(value) : hasNoParkIdentity(value)) &&
				value.blockedKind === undefined &&
				value.reason === undefined &&
				value.failureClass === undefined &&
				value.error === undefined
			);
		case "blocked":
			return (
				hasNoParkIdentity(value) && typeof value.blockedKind === "string" && typeof value.reason === "string" && value.parkClass === undefined && value.parkReason === undefined && value.failureClass === undefined && value.error === undefined
			);
		case "failed":
			return (
				hasNoParkIdentity(value) && typeof value.failureClass === "string" && typeof value.error === "string" && value.parkClass === undefined && value.parkReason === undefined && value.blockedKind === undefined && value.reason === undefined
			);
		default:
			return false;
	}
}

function isCycleFields(value: UnknownRecord): value is UnknownRecord & RawCycleLogRecord {
	const envelope =
		typeof value.cycle === "number" &&
		Number.isSafeInteger(value.cycle) &&
		(value.item === null || typeof value.item === "string") &&
		typeof value.quick === "boolean" &&
		Array.isArray(value.steps) &&
		typeof value.total_cost === "number" &&
		(value.verdict === null || typeof value.verdict === "string");
	if (!envelope) return false;
	return (
		(typeof value.outcome === "string" && CYCLE_OUTCOME_SET.has(value.outcome) && isCurrentCycleOutcome(value)) ||
		(value.outcome === undefined && typeof value.completed === "boolean" && (value.error === null || typeof value.error === "string"))
	);
}

/** Validate one parsed `v: 1` envelope (fail closed). Exported so consumers never re-implement the check. */
export function decodeFlowEvent(value: unknown): FlowEvent | undefined {
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
	if (value.type === "pelaggio.run-started" && !isRunStartedPayload(value)) return undefined;
	if (value.type === "pelaggio.run-finished" && !isRunFinishedPayload(value)) return undefined;
	if (value.type === "pelaggio.provider-usage" && !isProviderUsagePayload(value)) return undefined;
	if (value.type === "pelaggio.provider-limit" && !isProviderLimitPayload(value)) return undefined;
	return value as FlowEvent;
}

/** Decode one JSONL line: unparsable or non-conforming lines yield `undefined`, never throw. */
export function decodeFlowEventLine(line: string): FlowEvent | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	return decodeFlowEvent(parsed);
}

export type EventStreamSlice = { data: string; eof: boolean };
export type ReadEventStreamSlice = (path: string, offset: number) => EventStreamSlice;

/** Default slice reader: the bytes appended since `offset`, `eof` when nothing new (or no file yet). */
export function readEventStreamSlice(path: string, offset: number): EventStreamSlice {
	if (!existsSync(path)) return { data: "", eof: true };
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		if (offset >= size) return { data: "", eof: true };
		const length = size - offset;
		const buffer = Buffer.alloc(length);
		const read = readSync(fd, buffer, 0, length, offset);
		return { data: buffer.subarray(0, read).toString("utf8"), eof: offset + read >= size };
	} finally {
		closeSync(fd);
	}
}

export interface EventStreamTail {
	/** Decode every complete line appended since the last call (fail closed per line). */
	next(): FlowEvent[];
	/** Bytes consumed so far — resume a tail later with `fromOffset`. */
	readonly offset: number;
}

/**
 * Incremental reader over one segment file (`eventStreamPath`): keeps the byte offset and holds a
 * truncated final line until its newline arrives, so a consumer polling a live writer never sees
 * a half record. This is the package-level tail the control plane consumes (plan step 8).
 */
export function tailEventStream(path: string, options: { fromOffset?: number; readSlice?: ReadEventStreamSlice } = {}): EventStreamTail {
	const readSlice = options.readSlice ?? readEventStreamSlice;
	let offset = options.fromOffset ?? 0;
	let pending = "";
	return {
		get offset() {
			return offset;
		},
		next() {
			const { data } = readSlice(path, offset);
			if (!data) return [];
			offset += Buffer.byteLength(data, "utf8");
			pending += data;
			const events: FlowEvent[] = [];
			let idx = pending.indexOf("\n");
			while (idx !== -1) {
				const line = pending.slice(0, idx);
				pending = pending.slice(idx + 1);
				const event = decodeFlowEventLine(line);
				if (event) events.push(event);
				idx = pending.indexOf("\n");
			}
			return events;
		},
	};
}

/** `<root>/.dev/flow-events` */
export function flowEventsDir(root: string): string {
	return registerPath(root, "flow-events");
}

/** Segment file for one writer stream — the contract the server tailer and the writer share. */
export function eventStreamPath(root: string, streamId: string): string {
	return registerPath(root, "flow-events", `${streamId}.jsonl`);
}

const RUN_MODES = new Set(["drain", "watch"]);
const RUN_OUTCOMES = new Set(["completed", "failed", "parked"]);
const MIN_HEARTBEAT_MS = 1_000;
const MAX_HEARTBEAT_MS = 300_000;

function isRunStartedPayload(value: UnknownRecord): boolean {
	if (typeof value.heartbeatMs !== "number" || !Number.isInteger(value.heartbeatMs) || value.heartbeatMs < MIN_HEARTBEAT_MS || value.heartbeatMs > MAX_HEARTBEAT_MS) {
		return false;
	}
	if (value.mode !== undefined && (typeof value.mode !== "string" || !RUN_MODES.has(value.mode))) return false;
	if (value.resumed !== undefined && value.resumed !== true) return false;
	return true;
}

function isRunFinishedPayload(value: UnknownRecord): boolean {
	return typeof value.outcome === "string" && RUN_OUTCOMES.has(value.outcome) && Number.isSafeInteger(value.exitCode);
}

const PROVIDER_NAMES = new Set<ProviderName>(["claude", "codex", "grok", "opencode"]);
const QUOTA_CHANNELS = new Set<QuotaChannel>(["reported", "probed", "estimated"]);
const MAX_WINDOW_NAME_LENGTH = 64;
const QUOTA_WINDOW_KEYS = new Set(["name", "channel", "observedAt", "usedFraction", "resetsAt"]);
const MAX_NATIVE_DEPTH = 4;
const MAX_NATIVE_KEYS = 32;
const MAX_NATIVE_STRING_BYTES = 1024;

function isProviderName(value: unknown): value is ProviderName {
	return typeof value === "string" && PROVIDER_NAMES.has(value as ProviderName);
}

function isQuotaChannel(value: unknown): value is QuotaChannel {
	return typeof value === "string" && QUOTA_CHANNELS.has(value as QuotaChannel);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFinite(value: unknown): value is number {
	return isFiniteNumber(value) && value >= 0;
}

function isUsedFraction(value: unknown): value is number {
	return isNonNegativeFinite(value) && value <= 1;
}

function isWindowName(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_WINDOW_NAME_LENGTH;
}

function isBoundedString(value: unknown): value is string {
	return typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_NATIVE_STRING_BYTES;
}

function isBoundedNative(value: unknown, depth: number): boolean {
	if (typeof value === "string") return isBoundedString(value);
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "boolean" || value === null) return true;
	if (depth >= MAX_NATIVE_DEPTH) return false;
	if (Array.isArray(value)) {
		if (value.length > MAX_NATIVE_KEYS) return false;
		return value.every((entry) => isBoundedNative(entry, depth + 1));
	}
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	if (keys.length > MAX_NATIVE_KEYS) return false;
	return keys.every((key) => isBoundedString(key) && isBoundedNative(value[key], depth + 1));
}

function isQuotaWindowObservation(value: unknown): value is QuotaWindowObservation {
	if (!isRecord(value) || !isWindowName(value.name) || !isQuotaChannel(value.channel) || !isNonNegativeFinite(value.observedAt)) return false;
	if (Object.keys(value).some((key) => !QUOTA_WINDOW_KEYS.has(key))) return false;
	if (value.usedFraction !== undefined && !isUsedFraction(value.usedFraction)) return false;
	if (value.resetsAt !== undefined && !isFiniteNumber(value.resetsAt)) return false;
	return true;
}

function isPoolId(value: unknown): value is string {
	return typeof value === "string" && POOL_ID_PATTERN.test(value);
}

function isProviderEventExtras(value: UnknownRecord): boolean {
	if (value.step !== undefined && (typeof value.step !== "string" || !(ALL_STEPS as readonly string[]).includes(value.step))) return false;
	// Fail closed on provenance: "epoch" is the only defined channel, present iff the poolId is epoch-derived.
	if (value.poolIdChannel !== undefined && value.poolIdChannel !== "epoch") return false;
	if ((typeof value.poolId === "string" && value.poolId.startsWith("e:")) !== (value.poolIdChannel === "epoch")) return false;
	if (value.model !== undefined && (typeof value.model !== "string" || value.model.length === 0)) return false;
	if (value.truncated !== undefined && value.truncated !== "event-oversize") return false;
	if (value.native !== undefined && !isBoundedNative(value.native, 0)) return false;
	return true;
}

function isProviderUsagePayload(value: UnknownRecord): boolean {
	if (!isProviderName(value.provider) || !isPoolId(value.poolId) || !Array.isArray(value.windows) || !value.windows.every(isQuotaWindowObservation)) return false;
	if (value["gen_ai.usage.input_tokens"] !== undefined && !isNonNegativeFinite(value["gen_ai.usage.input_tokens"])) return false;
	if (value["gen_ai.usage.output_tokens"] !== undefined && !isNonNegativeFinite(value["gen_ai.usage.output_tokens"])) return false;
	return isProviderEventExtras(value);
}

function isProviderLimitPayload(value: UnknownRecord): boolean {
	if (!isProviderName(value.provider) || !isPoolId(value.poolId) || value.fault !== "rate-limit") return false;
	if (!(value.window === null || isWindowName(value.window))) return false;
	if (value.resetsAt !== undefined && !isFiniteNumber(value.resetsAt)) return false;
	if (value.parked !== undefined && value.parked !== true) return false;
	return isProviderEventExtras(value);
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const bytes = Buffer.from(text, "utf8").subarray(0, maxBytes);
	let sequenceStart = bytes.length - 1;
	while (sequenceStart > 0 && (bytes[sequenceStart] & 0xc0) === 0x80) sequenceStart--;
	const first = bytes[sequenceStart] ?? 0;
	const sequenceLength = first <= 0x7f ? 1 : first <= 0xdf ? 2 : first <= 0xef ? 3 : 4;
	return bytes.length - sequenceStart < sequenceLength ? bytes.subarray(0, sequenceStart).toString("utf8") : bytes.toString("utf8");
}

function boundNativeValue(value: unknown, scrub: (text: string) => string, depth: number): unknown {
	if (typeof value === "string") return truncateUtf8(scrub(value), MAX_NATIVE_STRING_BYTES);
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "boolean" || value === null) return value;
	if (depth >= MAX_NATIVE_DEPTH) return undefined;
	if (Array.isArray(value)) {
		const bounded: unknown[] = [];
		for (const entry of value.slice(0, MAX_NATIVE_KEYS)) {
			const next = boundNativeValue(entry, scrub, depth + 1);
			if (next !== undefined) bounded.push(next);
		}
		return bounded;
	}
	if (!isRecord(value)) return undefined;
	const bounded: Record<string, unknown> = {};
	let count = 0;
	for (const [key, entry] of Object.entries(value)) {
		if (count >= MAX_NATIVE_KEYS) break;
		const boundedKey = truncateUtf8(scrub(key), MAX_NATIVE_STRING_BYTES);
		if (!boundedKey) continue;
		const next = boundNativeValue(entry, scrub, depth + 1);
		if (next === undefined) continue;
		bounded[boundedKey] = next;
		count++;
	}
	return bounded;
}

function boundNative(native: Record<string, unknown> | undefined, scrub: (text: string) => string): Record<string, unknown> | undefined {
	if (!native) return undefined;
	const bounded = boundNativeValue(native, scrub, 0);
	return isRecord(bounded) ? bounded : undefined;
}

function isOversizeError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("exceeds") && err.message.includes("byte limit");
}

export interface AppendProviderObservationInput {
	observation: ProviderObservation;
	itemId?: string | null;
	attempt?: number;
	step?: Step;
	model?: string;
}

/**
 * Fail-soft funnel for durable provider observations. Scrubs and bounds native detail, then
 * appends. Oversize retries once without `native`. Other failures log-and-drop and never throw.
 */
export function appendProviderObservation(writer: EventWriter, input: AppendProviderObservationInput, log: (msg: string) => void): FlowEvent | undefined {
	const scrub = makeSecretScrubber();
	const { observation, itemId, attempt, step, model } = input;
	const native = boundNative(observation.native, scrub);
	const correlation = {
		...(itemId !== undefined ? { itemId } : {}),
		...(attempt !== undefined ? { attempt } : {}),
		...(step ? { step } : {}),
		...(model ? { model } : {}),
	};
	const complete: FlowEventInput =
		observation.kind === "usage"
			? {
					type: "pelaggio.provider-usage",
					provider: observation.provider,
					poolId: observation.poolId,
					...(observation.poolIdChannel ? { poolIdChannel: observation.poolIdChannel } : {}),
					windows: observation.windows,
					...("gen_ai.usage.input_tokens" in observation ? { "gen_ai.usage.input_tokens": observation["gen_ai.usage.input_tokens"] } : {}),
					...("gen_ai.usage.output_tokens" in observation ? { "gen_ai.usage.output_tokens": observation["gen_ai.usage.output_tokens"] } : {}),
					...(native ? { native } : {}),
					...correlation,
				}
			: {
					type: "pelaggio.provider-limit",
					provider: observation.provider,
					poolId: observation.poolId,
					...(observation.poolIdChannel ? { poolIdChannel: observation.poolIdChannel } : {}),
					fault: observation.fault,
					window: observation.window,
					...(observation.resetsAt !== undefined ? { resetsAt: observation.resetsAt } : {}),
					...(observation.parked ? { parked: true as const } : {}),
					...(native ? { native } : {}),
					...correlation,
				};
	try {
		return writer.append(complete);
	} catch (err) {
		if (!isOversizeError(err) || !native) {
			const msg = err instanceof Error ? err.message : String(err);
			log(`⚠ provider observation dropped: ${msg}`);
			return undefined;
		}
	}
	const { native: _dropped, ...withoutNative } = complete;
	try {
		return writer.append({ ...withoutNative, truncated: "event-oversize" });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`⚠ provider observation dropped: ${msg}`);
		return undefined;
	}
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
	const segmentPath = eventStreamPath(root, streamId);
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
			const event = decodeFlowEvent(candidate);
			if (!event) throw new Error("Invalid flow event");
			const record = `${JSON.stringify(event)}\n`;
			if (Buffer.byteLength(record, "utf8") > MAX_FLOW_EVENT_BYTES) throw new Error(`Flow event exceeds ${MAX_FLOW_EVENT_BYTES} byte limit`);
			mkdirSync(flowEventsDir(root), { recursive: true });
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

function legacyEvent(record: UnknownRecord & RawCycleLogRecord, source: string, line: number, bytes: string, seq: number): FlowEvent | undefined {
	const key = `${source}\0${line}\0${bytes}`;
	return decodeFlowEvent({
		...record,
		v: 1,
		type: "pelaggio.cycle-completed",
		eventId: digestId("pelaggio-legacy-event", key),
		streamId: digestId("pelaggio-legacy-stream", source),
		// Counts promoted events, not physical lines: rows the reader skips (day-budget receipts,
		// blanks) would otherwise punch holes in the sequence and raise a false `sequenceGap`.
		// `eventId` still keys on `line`, so identity stays tied to physical position.
		seq,
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
	let legacySeq = 0;
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
		// Day-budget spend receipts (#398) are cycle-log rows, not cycles. They satisfy every clause
		// of isCycleFields() — cycle 0, item null, empty steps — so without this they promote to
		// phantom `pelaggio.cycle-completed` events and inflate authoritative historical cycle counts.
		// `stats.reduce()` filters them on the same marker; this is the reader-side mirror. Not a
		// diagnostic: the row is a well-formed receipt, simply not an event.
		if (isRecord(value) && value.type === undefined && value.budgetCharge === true) continue;
		if (isRecord(value) && value.type === undefined && isCycleFields(value) && isCanonicalInstant(value.ts)) {
			const event = legacyEvent(value, source, line, bytes, legacySeq + 1);
			if (event) {
				legacySeq += 1; // only a promoted event consumes a sequence number
				events.push(event);
			} else diagnose(diagnostics, { kind: "malformed", source, line, message: "Invalid legacy cycle record" });
			continue;
		}
		if (isRecord(value) && typeof value.type === "string" && !PELAGGIO_EVENT_TYPE_SET.has(value.type as PelaggioEventType)) {
			diagnose(diagnostics, { kind: "unknownType", source, line, observedType: value.type, message: `Unknown event type: ${value.type}` });
			continue;
		}
		const event = decodeFlowEvent(value);
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
	const eventsDir = options.eventsDir ?? flowEventsDir(root);
	const cycleLogPath = options.cycleLogPath === undefined ? logPathFor(root) : options.cycleLogPath;
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

export type LoggedDriverIdentity = { provider: "codex"; codexModel?: string } | { provider: "claude" | "grok" | "opencode"; model?: string };

/**
 * Find the latest successful realized author across all cycle entries for an item.
 *
 * The cycle log stores a realized provider plus a single generic `model` string. Codex is
 * reconstructed as `codexModel`; Claude, Grok, and OpenCode as the generic `model` (#431: a Grok or
 * OpenCode step now logs its own realized model, not the top-level Claude id, so the recovered
 * identity round-trips into a correct execution override). A logged `"default"` model means the
 * seat ran on the CLI default and is recovered as an absent model, matching the Codex behavior.
 */
export function findLoggedArtifactAuthor(itemId: string, step: "plan" | "implement", logPath = LOG_PATH): LoggedDriverIdentity | undefined {
	if (!existsSync(logPath)) return undefined;
	try {
		const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
		for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
			const entry: unknown = JSON.parse(lines[lineIndex]);
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			if (typeof record.item !== "string" || record.item.toUpperCase() !== itemId.toUpperCase() || !Array.isArray(record.steps)) continue;
			for (let index = record.steps.length - 1; index >= 0; index--) {
				const value: unknown = record.steps[index];
				if (!value || typeof value !== "object") continue;
				const logged = value as Record<string, unknown>;
				if (logged.name !== step || logged.ok !== true) continue;
				if (logged.provider === "codex") return typeof logged.model === "string" && logged.model !== "default" ? { provider: "codex", codexModel: logged.model } : { provider: "codex" };
				if (logged.provider === "claude" || logged.provider === "grok" || logged.provider === "opencode")
					return typeof logged.model === "string" && logged.model !== "default" ? { provider: logged.provider, model: logged.model } : { provider: logged.provider };
				return undefined;
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function appendLog(entry: Record<string, unknown>): void {
	ensureDevRoot(REPO);
	appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
}
