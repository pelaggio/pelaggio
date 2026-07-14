import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { createEventWriter, foldEvents, MAX_FLOW_EVENT_BYTES, PELAGGIO_EVENT_TYPES, projectEvents, readEventLog } from "../flow-events.js";
import { computeStats } from "../stats.js";
import type { FlowEventInput } from "../types.js";

const FIXTURES = join(dirname(new URL(import.meta.url).pathname), "fixtures", "flow-events");
const IDS = Array.from({ length: 30 }, (_, index) => `01J${String(index).padStart(23, "0")}`);

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "pelaggio-flow-events-"));
}

function copyFixture(root: string, fixture: string, target = fixture): string {
	const path = join(root, ".dev", "flow-events", target);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, readFileSync(join(FIXTURES, fixture)));
	return path;
}

function envelope(type: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		v: 1,
		type,
		eventId: IDS[0],
		streamId: IDS[1],
		seq: 1,
		ts: "2026-07-13T12:00:00.000Z",
		itemId: "170",
		claimId: null,
		readinessEpisodeId: null,
		executionId: IDS[2],
		causationId: null,
		...overrides,
	};
}

describe("flow event writer", () => {
	it("owns immutable identities and contiguous writer-local sequence", () => {
		const root = tempRoot();
		let index = 0;
		const writer = createEventWriter({ root, idFactory: () => IDS[index++], now: () => new Date("2026-07-13T12:00:00.000Z") });
		const first = writer.append({ type: "pelaggio.claimed", itemId: "170" });
		const second = writer.append({ type: "pelaggio.shipped", itemId: "170" });
		assert.equal(first.seq, 1);
		assert.equal(second.seq, 2);
		assert.equal(first.streamId, writer.streamId);
		assert.equal(first.executionId, writer.executionId);
		assert.equal(
			readFileSync(join(root, ".dev", "flow-events", `${writer.streamId}.jsonl`), "utf8")
				.split("\n")
				.filter(Boolean).length,
			2,
		);
	});

	it("gives separate writers separate segments beginning at one", () => {
		const root = tempRoot();
		let index = 0;
		const a = createEventWriter({ root, idFactory: () => IDS[index++] });
		const b = createEventWriter({ root, idFactory: () => IDS[index++] });
		assert.notEqual(a.streamId, b.streamId);
		assert.equal(a.append({ type: "pelaggio.claimed" }).seq, 1);
		assert.equal(b.append({ type: "pelaggio.claimed" }).seq, 1);
	});

	it("rejects invalid and oversized input without consuming sequence or mutating the segment", () => {
		const root = tempRoot();
		let index = 0;
		const writer = createEventWriter({ root, idFactory: () => IDS[index++] });
		assert.throws(() => writer.append({ type: "pelaggio.claimed", attempt: 0 }));
		assert.throws(() => writer.append({ type: "pelaggio.claimed", payload: "é".repeat(MAX_FLOW_EVENT_BYTES) } as FlowEventInput), /exceeds/);
		const event = writer.append({ type: "pelaggio.claimed" });
		assert.equal(event.seq, 1);
		const persisted = readFileSync(join(root, ".dev", "flow-events", `${writer.streamId}.jsonl`), "utf8");
		assert.equal(persisted, `${JSON.stringify(event)}\n`);
	});

	it("accepts a record exactly at the UTF-8 byte cap", () => {
		const root = tempRoot();
		let index = 0;
		const writer = createEventWriter({ root, idFactory: () => IDS[index++], now: () => new Date("2026-07-13T12:00:00.000Z") });
		const base = envelope("pelaggio.claimed", { eventId: IDS[2], streamId: IDS[0], executionId: IDS[1], payload: "", ts: "2026-07-13T12:00:00.000Z" });
		const baseBytes = Buffer.byteLength(`${JSON.stringify(base)}\n`);
		const event = writer.append({ type: "pelaggio.claimed", payload: "x".repeat(MAX_FLOW_EVENT_BYTES - baseBytes + 1) } as FlowEventInput);
		assert.equal(Buffer.byteLength(`${JSON.stringify(event)}\n`), MAX_FLOW_EVENT_BYTES);
	});

	it("ignores caller attempts to replace writer-owned fields", () => {
		const root = tempRoot();
		let index = 0;
		const writer = createEventWriter({ root, idFactory: () => IDS[index++] });
		const event = writer.append({ type: "pelaggio.claimed", eventId: IDS[20], streamId: IDS[20], seq: 99, executionId: IDS[20] } as unknown as FlowEventInput);
		assert.notEqual(event.eventId, IDS[20]);
		assert.equal(event.streamId, writer.streamId);
		assert.equal(event.seq, 1);
		assert.equal(event.executionId, writer.executionId);
	});
});

describe("dual-format reader", () => {
	it("normalizes legacy records deterministically and preserves cycle fields", () => {
		const root = tempRoot();
		const cycleLogPath = join(root, ".dev", "pelaggio-log.jsonl");
		mkdirSync(dirname(cycleLogPath), { recursive: true });
		writeFileSync(cycleLogPath, readFileSync(join(FIXTURES, "legacy-only.jsonl")));
		const first = readEventLog({ root });
		const second = readEventLog({ root });
		assert.deepEqual(first, second);
		assert.equal(first.events.length, 1);
		const event = first.events[0];
		assert.equal(event.type, "pelaggio.cycle-completed");
		assert.equal("legacy" in event && event.legacy, true);
		assert.equal("cycle" in event && event.cycle, 1);
		assert.match(event.eventId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
	});

	it("accepts every closed core type", () => {
		const root = tempRoot();
		const path = join(root, ".dev", "flow-events", "all.jsonl");
		mkdirSync(dirname(path), { recursive: true });
		const records = PELAGGIO_EVENT_TYPES.map((type, index) => {
			const value = envelope(type, { eventId: IDS[index], seq: index + 1 });
			if (type === "pelaggio.cycle-completed") Object.assign(value, { cycle: 1, item: "170", quick: false, steps: [], total_cost: 0, verdict: null, completed: true, error: null });
			return JSON.stringify(value);
		});
		writeFileSync(path, `${records.join("\n")}\n`);
		assert.deepEqual(
			readEventLog({ root, cycleLogPath: null }).events.map((event) => event.type),
			[...PELAGGIO_EVENT_TYPES],
		);
	});

	it("combines mixed sources in stable presentation order", () => {
		const root = tempRoot();
		copyFixture(root, "mixed.jsonl");
		const result = readEventLog({ root, cycleLogPath: null });
		assert.equal(result.events.length, 2);
		assert.deepEqual(
			result.events.map((event) => event.ts),
			["2026-07-13T12:00:00.000Z", "2026-07-13T12:00:01.000Z"],
		);
	});

	it("surfaces malformed, truncated-tail, and unknown-type losses", () => {
		const root = tempRoot();
		copyFixture(root, "malformed.jsonl", "a.jsonl");
		copyFixture(root, "unknown.jsonl", "b.jsonl");
		const tail = copyFixture(root, "truncated-tail.jsonl", "c.jsonl");
		writeFileSync(tail, readFileSync(tail, "utf8").trimEnd());
		const result = readEventLog({ root, cycleLogPath: null });
		assert.equal(result.events.length, 2);
		assert.equal(result.diagnostics.counts.malformed, 4);
		assert.equal(result.diagnostics.counts.truncatedTail, 1);
		assert.equal(result.diagnostics.counts.unknownType, 2);
	});

	it("diagnoses duplicate IDs and duplicate, regressing, and gapped stream sequence", () => {
		const root = tempRoot();
		const path = join(root, ".dev", "flow-events", "sequence.jsonl");
		mkdirSync(dirname(path), { recursive: true });
		const records = [envelope("pelaggio.claimed", { seq: 1 }), envelope("pelaggio.claimed", { eventId: IDS[3], seq: 1 }), envelope("pelaggio.shipped", { eventId: IDS[4], seq: 4 }), envelope("pelaggio.shipped", { eventId: IDS[0], seq: 2 })];
		writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		const result = readEventLog({ root, cycleLogPath: null });
		assert.equal(result.events.length, 3);
		assert.equal(result.diagnostics.counts.duplicateEventId, 1);
		assert.equal(result.diagnostics.counts.duplicateSequence, 1);
		assert.equal(result.diagnostics.counts.sequenceGap, 1);
		assert.equal(result.diagnostics.counts.regressingSequence, 1);
		const projection = projectEvents(result);
		assert.equal(projection.deduplicatedEvents, 3);
		assert.equal(projection.totalEvents, 4);
	});

	it("handles missing directories, ignores non-jsonl files, and preserves cycle log stats and bytes", () => {
		const root = tempRoot();
		assert.deepEqual(readEventLog({ root, cycleLogPath: null }).events, []);
		const cycle = join(root, ".dev", "pelaggio-log.jsonl");
		mkdirSync(dirname(cycle), { recursive: true });
		writeFileSync(cycle, readFileSync(join(FIXTURES, "legacy-only.jsonl")));
		writeFileSync(join(root, ".dev", "flow-events.txt"), "ignored");
		const before = readFileSync(cycle);
		const statsBefore = computeStats({ logPath: cycle });
		readEventLog({ root });
		assert.deepEqual(computeStats({ logPath: cycle }), statsBefore);
		assert.deepEqual(readFileSync(cycle), before);
	});
});

describe("fold and historical projection", () => {
	it("folds validated discrimination and projects accepted counts with diagnostics", () => {
		const root = tempRoot();
		copyFixture(root, "new-only.jsonl");
		const result = readEventLog({ root, cycleLogPath: null });
		const types = foldEvents(result.events, (all, event) => [...all, event.type], [] as string[]);
		assert.deepEqual(types, ["pelaggio.claimed"]);
		const projection = projectEvents(result);
		assert.equal(projection.totalEvents, 1);
		assert.equal(projection.deduplicatedEvents, 1);
		assert.equal(projection.byType["pelaggio.claimed"], 1);
		assert.equal("readiness" in projection, false);
	});
});
