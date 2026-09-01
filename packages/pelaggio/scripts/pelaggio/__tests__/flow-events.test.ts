import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { createEventWriter, decodeFlowEventLine, eventStreamPath, foldEvents, MAX_FLOW_EVENT_BYTES, PELAGGIO_EVENT_TYPES, projectEvents, readEventLog, tailEventStream } from "../flow-events.js";
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
	it("accepts every complete cycle outcome branch", () => {
		const root = tempRoot();
		let index = 0;
		const writer = createEventWriter({ root, idFactory: () => IDS[index++]!, now: () => new Date("2026-07-13T12:00:00.000Z") });
		const base = { type: "pelaggio.cycle-completed" as const, cycle: 1, item: "672", quick: false, steps: [], total_cost: 1, verdict: null };
		const inputs = [
			{ ...base, outcome: "completed" },
			{ ...base, outcome: "parked", parkClass: "rate-limit", parkReason: "quota" },
			{ ...base, outcome: "blocked", blockedKind: "capability", reason: "missing token" },
			{ ...base, outcome: "failed", failureClass: "provider", error: "sdk failure" },
		] satisfies FlowEventInput[];
		const events = inputs.map((input) => writer.append(input));
		assert.deepEqual(
			events.map((event) => ("outcome" in event ? event.outcome : undefined)),
			["completed", "parked", "blocked", "failed"],
		);

		// @ts-expect-error failed cycle event inputs require their branch diagnostics
		const incompleteFailed: FlowEventInput = { ...base, outcome: "failed" };
		void incompleteFailed;
	});

	it("rejects incomplete or overlapping cycle outcome branches without persisting them", () => {
		const root = tempRoot();
		let index = 0;
		const writer = createEventWriter({ root, idFactory: () => IDS[index++]! });
		const base = { type: "pelaggio.cycle-completed" as const, cycle: 1, item: "672", quick: false, steps: [], total_cost: 1, verdict: null };
		const invalid = [
			{ ...base, outcome: "completed", failureClass: "provider", error: "boom" },
			{ ...base, outcome: "parked", parkClass: "rate-limit" },
			{ ...base, outcome: "parked", parkClass: "rate-limit", parkReason: null, blockedKind: "capability", reason: "overlap" },
			{ ...base, outcome: "blocked", blockedKind: "capability" },
			{ ...base, outcome: "blocked", blockedKind: "capability", reason: "blocked", failureClass: "provider", error: "overlap" },
			{ ...base, outcome: "failed", error: "missing class" },
			{ ...base, outcome: "failed", failureClass: "provider", error: "boom", parkClass: "rate-limit", parkReason: null },
			{ ...base, outcome: "failed", failureClass: "provider", error: "boom", completed: false },
		];
		for (const input of invalid) assert.throws(() => writer.append(input as unknown as FlowEventInput), /Invalid flow event/);

		const event = writer.append({ ...base, outcome: "failed", failureClass: "provider", error: "valid" });
		assert.equal(event.seq, 1);
		const persisted = readFileSync(join(root, ".dev", "flow-events", `${writer.streamId}.jsonl`), "utf8");
		assert.equal(persisted, `${JSON.stringify(event)}\n`);
	});

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

	it("pins streamId and executionId when supplied as ULID-shaped options", () => {
		const root = tempRoot();
		let index = 10;
		const writer = createEventWriter({
			root,
			streamId: IDS[0],
			executionId: IDS[1],
			idFactory: () => IDS[index++],
			now: () => new Date("2026-07-13T12:00:00.000Z"),
		});
		assert.equal(writer.streamId, IDS[0]);
		assert.equal(writer.executionId, IDS[1]);
		const event = writer.append({ type: "pelaggio.watch-idle", probeAt: "2026-07-13T12:05:00.000Z" });
		assert.equal(event.streamId, IDS[0]);
		assert.equal(event.executionId, IDS[1]);
		assert.equal(event.type, "pelaggio.watch-idle");
		assert.ok(existsSync(join(root, ".dev", "flow-events", `${IDS[0]}.jsonl`)));
	});

	it("rejects non-ULID streamId / executionId options", () => {
		const root = tempRoot();
		assert.throws(() => createEventWriter({ root, streamId: "not-a-ulid" }), /ULID/);
		assert.throws(() => createEventWriter({ root, executionId: "also-bad" }), /ULID/);
	});

	it("round-trips process-level continuous lifecycle types", () => {
		const root = tempRoot();
		let index = 0;
		const writer = createEventWriter({ root, idFactory: () => IDS[index++], now: () => new Date("2026-07-13T12:00:00.000Z") });
		const types = ["pelaggio.watch-idle", "pelaggio.watch-wake", "pelaggio.budget-idle", "pelaggio.budget-wake", "pelaggio.suspended", "pelaggio.resumed"] as const;
		for (const type of types) {
			const payload =
				type === "pelaggio.watch-idle"
					? { type, probeAt: "2026-07-13T12:05:00.000Z" }
					: type === "pelaggio.budget-idle"
						? { type, resumeAt: "2026-07-14T00:00:00.000Z", budget: 10, spent: 10 }
						: type === "pelaggio.suspended"
							? { type, reason: "rate-limit", resumeAt: "2026-07-13T18:00:00.000Z" }
							: { type };
			const event = writer.append(payload as FlowEventInput);
			assert.equal(event.type, type);
		}
		const read = readEventLog({ root, cycleLogPath: null });
		assert.deepEqual(
			read.events.map((e) => e.type),
			[...types],
		);
	});

	it("round-trips process-level run lifecycle types", () => {
		const root = tempRoot();
		let index = 0;
		const writer = createEventWriter({ root, idFactory: () => IDS[index++], now: () => new Date("2026-07-13T12:00:00.000Z") });
		const start = writer.append({ type: "pelaggio.run-started", heartbeatMs: 15_000, mode: "drain", resumed: true, itemId: "40" });
		const beat = writer.append({ type: "pelaggio.run-heartbeat" });
		const finish = writer.append({ type: "pelaggio.run-finished", outcome: "parked", exitCode: 75 });
		assert.equal(start.type, "pelaggio.run-started");
		if (start.type === "pelaggio.run-started") {
			assert.equal(start.heartbeatMs, 15_000);
			assert.equal(start.mode, "drain");
			assert.equal(start.resumed, true);
		}
		assert.equal(start.itemId, "40");
		assert.equal(beat.type, "pelaggio.run-heartbeat");
		assert.equal(finish.type, "pelaggio.run-finished");
		if (finish.type === "pelaggio.run-finished") {
			assert.equal(finish.outcome, "parked");
			assert.equal(finish.exitCode, 75);
		}
		const read = readEventLog({ root, cycleLogPath: null });
		assert.deepEqual(
			read.events.map((e) => e.type),
			["pelaggio.run-started", "pelaggio.run-heartbeat", "pelaggio.run-finished"],
		);
	});

	it("rejects invalid run-lifecycle payloads as malformed", () => {
		const root = tempRoot();
		let index = 0;
		const writer = createEventWriter({ root, idFactory: () => IDS[index++] });
		assert.throws(() => writer.append({ type: "pelaggio.run-started", heartbeatMs: 999 }), /Invalid flow event/);
		assert.throws(() => writer.append({ type: "pelaggio.run-started", heartbeatMs: 300_001 }), /Invalid flow event/);
		assert.throws(() => writer.append({ type: "pelaggio.run-started", heartbeatMs: 15_000.5 } as FlowEventInput), /Invalid flow event/);
		assert.throws(() => writer.append({ type: "pelaggio.run-started", heartbeatMs: 15_000, mode: "forever" } as unknown as FlowEventInput), /Invalid flow event/);
		assert.throws(() => writer.append({ type: "pelaggio.run-started", heartbeatMs: 15_000, resumed: false } as unknown as FlowEventInput), /Invalid flow event/);
		assert.throws(() => writer.append({ type: "pelaggio.run-finished", outcome: "abandoned", exitCode: 1 } as unknown as FlowEventInput), /Invalid flow event/);
		assert.throws(() => writer.append({ type: "pelaggio.run-finished", outcome: "failed", exitCode: 1.5 } as FlowEventInput), /Invalid flow event/);
		const recovered = writer.append({ type: "pelaggio.run-heartbeat" });
		assert.equal(recovered.seq, 1);
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

	it("skips day-budget spend receipts rather than promoting them to phantom cycles (#398)", () => {
		const root = tempRoot();
		const cycleLogPath = join(root, ".dev", "pelaggio-log.jsonl");
		mkdirSync(dirname(cycleLogPath), { recursive: true });
		const realCycle = { ts: "2026-08-05T00:00:00.000Z", cycle: 1, item: "42", quick: false, steps: [], total_cost: 1.5, verdict: null, completed: true, error: null };
		// Exactly the shape `appendDayBudgetCharge` writes: it satisfies every isCycleFields()
		// clause, so an unfiltered reader counts each spend receipt as a completed cycle.
		const receipt = { ts: "2026-08-05T00:05:00.000Z", cycle: 0, item: null, quick: false, steps: [], total_cost: 0.25, verdict: null, completed: true, error: null, budgetCharge: true };
		writeFileSync(cycleLogPath, `${JSON.stringify(realCycle)}\n${JSON.stringify(receipt)}\n`);
		const { events, diagnostics } = readEventLog({ root });
		assert.equal(events.length, 1, "the spend receipt must not decode as a cycle event");
		assert.equal("cycle" in events[0] && events[0].cycle, 1);
		assert.deepEqual(diagnostics.details, [], "a well-formed receipt is skipped, not reported malformed");
		assert.equal(diagnostics.counts.malformed, 0);
	});

	it("a skipped spend receipt between two cycles does not fabricate a sequence gap (#398)", () => {
		const root = tempRoot();
		const cycleLogPath = join(root, ".dev", "pelaggio-log.jsonl");
		mkdirSync(dirname(cycleLogPath), { recursive: true });
		// Legacy sequence numbers used to be the physical line number, so a receipt sitting *between*
		// two cycles left a hole (seq 1 → 3) and the reader reported a gap that never happened. The
		// existing receipt test puts the receipt last, where no hole can form.
		const first = { ts: "2026-08-05T00:00:00.000Z", cycle: 1, item: "42", quick: false, steps: [], total_cost: 1.5, verdict: null, completed: true, error: null };
		const receipt = { ts: "2026-08-05T00:05:00.000Z", cycle: 0, item: null, quick: false, steps: [], total_cost: 0.25, verdict: null, completed: true, error: null, budgetCharge: true };
		const second = { ts: "2026-08-05T00:10:00.000Z", cycle: 2, item: "43", quick: false, steps: [], total_cost: 2, verdict: null, completed: true, error: null };
		writeFileSync(cycleLogPath, `${JSON.stringify(first)}\n${JSON.stringify(receipt)}\n${JSON.stringify(second)}\n`);
		const { events, diagnostics } = readEventLog({ root });
		assert.equal(events.length, 2, "both real cycles decode; the receipt does not");
		assert.deepEqual(
			events.map((e) => e.seq),
			[1, 2],
			"sequence numbers count promoted events, not physical lines",
		);
		assert.equal(diagnostics.counts.sequenceGap, 0, "skipping a receipt must be diagnostically invisible");
		assert.deepEqual(diagnostics.details, []);
	});

	it("promotes current union cycle records and retains unknown class members", () => {
		const root = tempRoot();
		const cycleLogPath = join(root, ".dev", "pelaggio-log.jsonl");
		mkdirSync(dirname(cycleLogPath), { recursive: true });
		const current = { ts: "2026-08-05T00:00:00.000Z", cycle: 1, item: "42", quick: false, steps: [], total_cost: 1.5, verdict: null, outcome: "failed", failureClass: "future-class", error: "boom" };
		const blocked = { ts: "2026-08-05T00:01:00.000Z", cycle: 2, item: "43", quick: false, steps: [], total_cost: 0.2, verdict: null, outcome: "blocked", blockedKind: "capability", reason: "no key" };
		writeFileSync(cycleLogPath, `${JSON.stringify(current)}\n${JSON.stringify(blocked)}\n`);
		const { events, diagnostics } = readEventLog({ root });
		assert.equal(events.length, 2);
		assert.equal(diagnostics.counts.malformed, 0);
		assert.equal("failureClass" in events[0]! && events[0]!.failureClass, "future-class");
		assert.equal("blockedKind" in events[1]! && events[1]!.blockedKind, "capability");
	});

	it("preserves additive provenance on normalized legacy cycle records", () => {
		const root = tempRoot();
		const cycleLogPath = join(root, ".dev", "pelaggio-log.jsonl");
		mkdirSync(dirname(cycleLogPath), { recursive: true });
		const provenance = {
			runId: "cycle-7",
			durationMs: 42,
			drivers: [{ provider: "codex", model: "gpt-5" }],
			git: { branch: "feat/327", worktree: "pelaggio-327", mainShaAtStart: "a".repeat(40), headSha: "b".repeat(40) },
			versions: { pelaggio: "0.1.0", node: "v22.0.0", drivers: { codex: "codex 1.0" } },
		};
		writeFileSync(cycleLogPath, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", cycle: 7, item: "327", quick: false, steps: [], total_cost: 0, verdict: null, completed: true, error: null, provenance })}\n`);
		const event = readEventLog({ root }).events[0];
		assert.deepEqual("provenance" in event ? event.provenance : undefined, provenance);
	});

	it("accepts every closed core type", () => {
		const root = tempRoot();
		const path = join(root, ".dev", "flow-events", "all.jsonl");
		mkdirSync(dirname(path), { recursive: true });
		const records = PELAGGIO_EVENT_TYPES.map((type, index) => {
			const value = envelope(type, { eventId: IDS[index], seq: index + 1 });
			if (type === "pelaggio.cycle-completed") Object.assign(value, { cycle: 1, item: "170", quick: false, steps: [], total_cost: 0, verdict: null, completed: true, error: null });
			if (type === "pelaggio.run-started") Object.assign(value, { heartbeatMs: 15_000, mode: "watch" });
			if (type === "pelaggio.run-finished") Object.assign(value, { outcome: "completed", exitCode: 0 });
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

describe("decodeFlowEventLine", () => {
	it("fails closed on blank, unparsable and non-v1 lines and decodes a conforming one", () => {
		assert.equal(decodeFlowEventLine(""), undefined);
		assert.equal(decodeFlowEventLine("not json"), undefined);
		assert.equal(decodeFlowEventLine('{"v":2,"type":"pelaggio.run-started"}'), undefined);
		const line = JSON.stringify({
			v: 1,
			type: "pelaggio.watch-idle",
			eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
			streamId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
			seq: 0,
			ts: "2026-08-30T00:00:00.000Z",
			itemId: null,
			claimId: null,
			readinessEpisodeId: null,
			executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
			causationId: null,
		});
		assert.equal(decodeFlowEventLine(line)?.type, "pelaggio.watch-idle");
		assert.equal(eventStreamPath("/r", "01ARZ3NDEKTSV4RRFFQ69G5FAW"), "/r/.dev/flow-events/01ARZ3NDEKTSV4RRFFQ69G5FAW.jsonl");
	});
});

describe("tailEventStream", () => {
	it("decodes complete lines incrementally, holds a truncated line, and advances its offset", () => {
		const base = {
			v: 1,
			eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
			streamId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
			seq: 0,
			ts: "2026-08-30T00:00:00.000Z",
			itemId: null,
			claimId: null,
			readinessEpisodeId: null,
			executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
			causationId: null,
		};
		const a = `${JSON.stringify({ ...base, type: "pelaggio.watch-idle" })}\n`;
		const b = `${JSON.stringify({ ...base, eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAY", seq: 1, type: "pelaggio.watch-wake" })}\n`;
		const chunks = [a + b.slice(0, 10), b.slice(10), "garbage\n"];
		let served = 0;
		const readSlice = (_path: string, offset: number) => {
			assert.equal(
				offset,
				chunks.slice(0, served).reduce((n, c) => n + Buffer.byteLength(c, "utf8"), 0),
			);
			const data = chunks[served] ?? "";
			if (served < chunks.length) served += 1;
			return { data, eof: served >= chunks.length };
		};
		const tail = tailEventStream("/nowhere/stream.jsonl", { readSlice });
		assert.deepEqual(
			tail.next().map((e) => e.type),
			["pelaggio.watch-idle"],
		);
		assert.deepEqual(
			tail.next().map((e) => e.type),
			["pelaggio.watch-wake"],
		);
		assert.deepEqual(tail.next(), []);
		assert.deepEqual(tail.next(), []);
		assert.equal(
			tail.offset,
			chunks.reduce((n, c) => n + Buffer.byteLength(c, "utf8"), 0),
		);
	});
});
