import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { startRunLifecycle } from "../../pelaggio/scripts/pelaggio/run-lifecycle.js";
import type { Flags } from "../../pelaggio/scripts/pelaggio/types.js";
import { listExternalRuns } from "../src/external-runs.js";
import { Registry } from "../src/registry.js";
import type { PersistedRun, RunSummary } from "../src/types.js";

const ID = (n: number): string => `01J${String(n).padStart(23, "0")}`;

function tempRepo(): string {
	return mkdtempSync(join(tmpdir(), "external-runs-"));
}

function registryFor(repos: Record<string, string>): Registry {
	return new Registry(Object.entries(repos).map(([slug, path]) => ({ slug, path })));
}

function writeSegment(root: string, streamId: string, records: unknown[]): void {
	const path = join(root, ".dev", "flow-events", `${streamId}.jsonl`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function writeCycleLog(root: string, records: unknown[]): void {
	const path = join(root, ".dev", "pelaggio-log.jsonl");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function envelope(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		v: 1,
		eventId: ID(2),
		streamId: ID(0),
		seq: 1,
		ts: "2026-07-13T12:00:00.000Z",
		itemId: "40",
		claimId: null,
		readinessEpisodeId: null,
		executionId: ID(1),
		causationId: null,
		...extra,
		type,
	};
}

function cycleRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ts: "2026-07-13T12:00:00.000Z",
		cycle: 1,
		item: "40",
		quick: false,
		steps: [{ name: "ship", model: "x", cost: 1, turns: 1, ok: true }],
		total_cost: 1.5,
		verdict: null,
		completed: true,
		error: null,
		...extra,
	};
}

function supervised(partial: Partial<PersistedRun> & Pick<PersistedRun, "id" | "repo">): PersistedRun {
	return {
		status: "running",
		pid: 1,
		startedAt: "2026-07-13T12:00:00.000Z",
		logPath: "/tmp/x.log",
		cwd: "/tmp/x",
		...partial,
	};
}

function byId(runs: RunSummary[]): Map<string, RunSummary> {
	return new Map(runs.map((run) => [run.id, run]));
}

const T0 = "2026-07-13T12:00:00.000Z";
const T10 = "2026-07-13T12:00:10.000Z";
const T30 = "2026-07-13T12:00:30.000Z";
const lifecycleFlags: Flags = { cycles: "1", parallel: "1", verbose: false, trace: false, budget: "10", "dry-run": false, "no-worktree": false, item: "40" };

describe("listExternalRuns", () => {
	it("keeps a worker-heartbeating run live across a synchronous main-thread block", () => {
		const root = tempRepo();
		const lifecycle = startRunLifecycle({ root, executionId: ID(1), flags: lifecycleFlags, heartbeatMs: 1_000 });
		// Scaled analogue of a 60s sync step crossing the production 45s freshness window.
		// A main-thread interval would emit nothing until after this wait and project abandoned.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, 3_500);
		const runs = listExternalRuns({ registry: registryFor({ main: root }), supervised: [], now: Date.now, staleHeartbeatIntervals: 3 });
		lifecycle.stop();
		assert.equal(runs.length, 1);
		assert.equal(runs[0]?.status, "running");
	});

	it("projects a recent start/heartbeat as running with folded activity", () => {
		const root = tempRepo();
		writeSegment(root, ID(0), [envelope("pelaggio.run-started", { eventId: ID(10), seq: 1, heartbeatMs: 15_000, mode: "watch", ts: T0 }), envelope("pelaggio.run-heartbeat", { eventId: ID(11), seq: 2, ts: T10, itemId: null })]);
		writeSegment(root, ID(2), [envelope("pelaggio.watch-idle", { eventId: ID(12), streamId: ID(2), seq: 1, ts: T10, itemId: null, probeAt: "2026-07-13T12:05:00.000Z" })]);
		const runs = listExternalRuns({
			registry: registryFor({ main: root }),
			supervised: [],
			now: () => Date.parse(T30),
		});
		assert.equal(runs.length, 1);
		assert.equal(runs[0]?.id, `external:main:${ID(1)}`);
		assert.equal(runs[0]?.source, "external");
		assert.equal(runs[0]?.status, "running");
		assert.equal(runs[0]?.mode, "watch");
		assert.equal(runs[0]?.item, "40");
		assert.deepEqual(runs[0]?.activity, { kind: "watch-idle", probeAt: "2026-07-13T12:05:00.000Z" });
	});

	it("maps run-finished outcomes and lets finish win over freshness", () => {
		const root = tempRepo();
		const cases: Array<{ executionId: string; streamId: string; outcome: string; exitCode: number; status: string }> = [
			{ executionId: ID(1), streamId: ID(0), outcome: "completed", exitCode: 0, status: "completed" },
			{ executionId: ID(3), streamId: ID(2), outcome: "failed", exitCode: 1, status: "failed" },
			{ executionId: ID(5), streamId: ID(4), outcome: "parked", exitCode: 75, status: "parked" },
		];
		for (const [index, row] of cases.entries()) {
			writeSegment(root, row.streamId, [
				envelope("pelaggio.run-started", { eventId: ID(20 + index * 3), seq: 1, heartbeatMs: 15_000, executionId: row.executionId, streamId: row.streamId, ts: T0, itemId: null }),
				envelope("pelaggio.run-heartbeat", { eventId: ID(21 + index * 3), seq: 2, executionId: row.executionId, streamId: row.streamId, ts: T30, itemId: null }),
				envelope("pelaggio.run-finished", {
					eventId: ID(22 + index * 3),
					seq: 3,
					executionId: row.executionId,
					streamId: row.streamId,
					ts: T10,
					outcome: row.outcome,
					exitCode: row.exitCode,
					itemId: null,
				}),
			]);
		}
		const runs = listExternalRuns({
			registry: registryFor({ main: root }),
			supervised: [],
			now: () => Date.parse(T30),
		});
		const found = byId(runs);
		assert.equal(found.get(`external:main:${ID(1)}`)?.status, "completed");
		assert.equal(found.get(`external:main:${ID(3)}`)?.status, "failed");
		assert.equal(found.get(`external:main:${ID(5)}`)?.status, "parked");
		assert.equal(found.get(`external:main:${ID(1)}`)?.endedAt, T10);
	});

	it("maps a genuinely dead lifecycle run with no heartbeat to abandoned", () => {
		const root = tempRepo();
		writeSegment(root, ID(0), [envelope("pelaggio.run-started", { eventId: ID(10), seq: 1, heartbeatMs: 15_000, ts: T0, itemId: null })]);
		const runs = listExternalRuns({
			registry: registryFor({ main: root }),
			supervised: [],
			now: () => Date.parse("2026-07-13T12:02:00.000Z"),
		});
		assert.equal(runs.length, 1);
		assert.equal(runs[0]?.status, "abandoned");
		assert.equal(runs[0]?.endedAt, T0);
	});

	it("omits a lifecycle stream whose executionId is in StateStore", () => {
		const root = tempRepo();
		writeSegment(root, ID(1), [envelope("pelaggio.run-started", { eventId: ID(10), seq: 1, heartbeatMs: 15_000, streamId: ID(1), executionId: ID(1), ts: T0 })]);
		writeSegment(root, ID(3), [envelope("pelaggio.run-started", { eventId: ID(11), seq: 1, heartbeatMs: 15_000, streamId: ID(3), executionId: ID(3), ts: T0, itemId: "41" })]);
		const runs = listExternalRuns({
			registry: registryFor({ main: root }),
			supervised: [supervised({ id: ID(1), repo: "main", item: "40" })],
			now: () => Date.parse(T10),
		});
		assert.equal(runs.length, 1);
		assert.equal(runs[0]?.id, `external:main:${ID(3)}`);
		assert.equal(runs[0]?.item, "41");
	});

	it("omits stale activity-only segments and surfaces a fresh one as running", () => {
		const root = tempRepo();
		writeSegment(root, ID(0), [envelope("pelaggio.watch-idle", { eventId: ID(10), seq: 1, ts: T0, probeAt: "2026-07-13T12:05:00.000Z", itemId: null })]);
		const stale = listExternalRuns({
			registry: registryFor({ main: root }),
			supervised: [],
			now: () => Date.parse("2026-07-13T12:16:00.000Z"),
		});
		assert.deepEqual(stale, []);
		const live = listExternalRuns({
			registry: registryFor({ main: root }),
			supervised: [],
			now: () => Date.parse("2026-07-13T12:10:00.000Z"),
		});
		assert.equal(live.length, 1);
		assert.equal(live[0]?.status, "running");
		assert.equal(live[0]?.mode, "watch");
		assert.notEqual(live[0]?.status, "abandoned");
	});

	it("promotes legacy cycle rows with duration, last step, and cost", () => {
		const root = tempRepo();
		writeCycleLog(root, [
			cycleRow({
				ts: "2026-07-13T12:01:00.000Z",
				item: "40",
				completed: true,
				total_cost: 2.25,
				steps: [
					{ name: "implement", model: "x", cost: 1, turns: 1, ok: true },
					{ name: "ship", model: "x", cost: 1.25, turns: 1, ok: true },
				],
				provenance: { durationMs: 60_000 },
			}),
			cycleRow({ ts: "2026-07-13T12:02:00.000Z", item: "41", completed: false, error: "boom", total_cost: 0.5, steps: [{ name: "plan", model: "x", cost: 0.5, turns: 1, ok: false }] }),
			cycleRow({ ts: "2026-07-13T12:03:00.000Z", item: "42", completed: false, parked: true, total_cost: 0.1, steps: [{ name: "implement", model: "x", cost: 0.1, turns: 1, ok: false }] }),
			cycleRow({ ts: "2026-07-13T12:04:00.000Z", cycle: 0, item: null, budgetCharge: true, total_cost: 0.25, steps: [] }),
		]);
		const runs = listExternalRuns({
			registry: registryFor({ main: root }),
			supervised: [],
			now: () => Date.parse("2026-07-13T13:00:00.000Z"),
		});
		assert.equal(runs.length, 3);
		const completed = runs.find((run) => run.item === "40");
		const failed = runs.find((run) => run.item === "41");
		const parked = runs.find((run) => run.item === "42");
		assert.equal(completed?.status, "completed");
		assert.equal(completed?.lastStep, "ship");
		assert.equal(completed?.lastCost, 2.25);
		assert.equal(completed?.startedAt, "2026-07-13T12:00:00.000Z");
		assert.equal(completed?.id.startsWith("external:main:cycle:"), true);
		assert.equal(failed?.status, "failed");
		assert.equal(parked?.status, "parked");
		assert.ok(runs.every((run) => run.source === "external"));
	});

	it("suppresses item-matched lifecycle and supervised cycles; retains overlapping unrelated cycles", () => {
		const root = tempRepo();
		writeSegment(root, ID(0), [
			envelope("pelaggio.run-started", { eventId: ID(10), seq: 1, heartbeatMs: 15_000, ts: "2026-07-13T12:00:00.000Z", itemId: "40" }),
			envelope("pelaggio.run-finished", { eventId: ID(11), seq: 2, ts: "2026-07-13T12:10:00.000Z", outcome: "completed", exitCode: 0, itemId: "40" }),
		]);
		writeCycleLog(root, [cycleRow({ ts: "2026-07-13T12:05:00.000Z", item: "40" }), cycleRow({ ts: "2026-07-13T11:40:00.000Z", item: "40", cycle: 2 }), cycleRow({ ts: "2026-07-13T12:06:00.000Z", item: "99", cycle: 3 })]);
		const runs = listExternalRuns({
			registry: registryFor({ main: root }),
			supervised: [
				supervised({
					id: ID(9),
					repo: "main",
					item: "40",
					startedAt: "2026-07-13T11:30:00.000Z",
					endedAt: "2026-07-13T11:45:00.000Z",
					status: "completed",
				}),
			],
			now: () => Date.parse("2026-07-13T13:00:00.000Z"),
		});
		const items = runs.filter((run) => run.id.includes(":cycle:")).map((run) => run.item);
		assert.deepEqual(items, ["99"]);
		assert.ok(runs.some((run) => run.id === `external:main:${ID(1)}`));
	});

	it("suppresses each cycle covered by a multi-item lifecycle or supervised campaign", () => {
		const root = tempRepo();
		writeSegment(root, ID(0), [
			envelope("pelaggio.run-started", { eventId: ID(10), seq: 1, heartbeatMs: 15_000, ts: "2026-07-13T12:00:00.000Z", itemId: "40, 41" }),
			envelope("pelaggio.run-finished", { eventId: ID(11), seq: 2, ts: "2026-07-13T12:10:00.000Z", outcome: "completed", exitCode: 0, itemId: "40, 41" }),
		]);
		writeCycleLog(root, [
			cycleRow({ ts: "2026-07-13T12:05:00.000Z", item: "40" }),
			cycleRow({ ts: "2026-07-13T12:06:00.000Z", item: "41", cycle: 2 }),
			cycleRow({ ts: "2026-07-13T12:07:00.000Z", item: "42", cycle: 3 }),
			cycleRow({ ts: "2026-07-13T12:08:00.000Z", item: "43", cycle: 4 }),
			cycleRow({ ts: "2026-07-13T12:09:00.000Z", item: "99", cycle: 5 }),
		]);
		const runs = listExternalRuns({
			registry: registryFor({ main: root }),
			supervised: [
				supervised({
					id: ID(9),
					repo: "main",
					item: "42,43",
					startedAt: "2026-07-13T12:00:00.000Z",
					endedAt: "2026-07-13T12:10:00.000Z",
					status: "completed",
				}),
			],
			now: () => Date.parse("2026-07-13T13:00:00.000Z"),
		});
		const cycleItems = runs.filter((run) => run.id.includes(":cycle:")).map((run) => run.item);
		assert.deepEqual(cycleItems, ["99"]);
		assert.ok(runs.some((run) => run.id === `external:main:${ID(1)}`));
	});

	it("does not let an item-less lifecycle hide an overlapping cycle from another run", () => {
		const root = tempRepo();
		writeSegment(root, ID(0), [
			envelope("pelaggio.run-started", { eventId: ID(10), seq: 1, heartbeatMs: 15_000, ts: "2026-07-13T12:00:00.000Z", itemId: null }),
			envelope("pelaggio.run-finished", { eventId: ID(11), seq: 2, ts: "2026-07-13T12:10:00.000Z", outcome: "failed", exitCode: 1, itemId: null }),
		]);
		writeCycleLog(root, [cycleRow({ ts: "2026-07-13T12:05:00.000Z", item: "40" })]);
		const runs = listExternalRuns({
			registry: registryFor({ main: root }),
			supervised: [],
			now: () => Date.parse("2026-07-13T13:00:00.000Z"),
		});
		assert.ok(runs.some((run) => run.id === `external:main:${ID(1)}`));
		assert.ok(runs.some((run) => run.id.includes(":cycle:") && run.item === "40"));
	});

	it("does not let an item-less supervised run hide a concurrent other-item cycle", () => {
		const root = tempRepo();
		writeCycleLog(root, [cycleRow({ ts: "2026-07-13T12:05:00.000Z", item: "40" })]);
		const runs = listExternalRuns({
			registry: registryFor({ main: root }),
			supervised: [
				supervised({
					id: ID(9),
					repo: "main",
					startedAt: "2026-07-13T12:00:00.000Z",
					status: "running",
				}),
			],
			now: () => Date.parse("2026-07-13T12:10:00.000Z"),
		});
		assert.equal(runs.length, 1);
		assert.equal(runs[0]?.item, "40");
	});

	it("isolates malformed, truncated, and missing paths from other repos", () => {
		const good = tempRepo();
		const bad = tempRepo();
		const missing = join(tmpdir(), "external-runs-missing-repo");
		writeSegment(good, ID(0), [envelope("pelaggio.run-started", { eventId: ID(10), seq: 1, heartbeatMs: 15_000, ts: T0, itemId: "40" })]);
		writeSegment(bad, ID(0), [{ not: "an event" }, envelope("pelaggio.run-started", { eventId: ID(11), seq: 1, heartbeatMs: 15_000, streamId: ID(2), executionId: ID(3), ts: T0, itemId: "41" })]);
		const truncated = join(bad, ".dev", "flow-events", `${ID(8)}.jsonl`);
		writeFileSync(truncated, '{"v":1,"type":"pelaggio.run-started"');
		const fileNotDir = tempRepo();
		mkdirSync(join(fileNotDir, ".dev"), { recursive: true });
		writeFileSync(join(fileNotDir, ".dev", "flow-events"), "not-a-dir");
		const runs = listExternalRuns({
			registry: registryFor({ good, bad, missing, broken: fileNotDir }),
			supervised: [],
			now: () => Date.parse(T10),
		});
		assert.ok(runs.some((run) => run.repo === "good" && run.item === "40"));
		assert.ok(runs.some((run) => run.repo === "bad" && run.item === "41"));
		assert.ok(!runs.some((run) => run.repo === "missing"));
		assert.ok(!runs.some((run) => run.repo === "broken"));
	});

	it("filters by repo before scanning other slugs", () => {
		const a = tempRepo();
		const b = tempRepo();
		writeSegment(a, ID(0), [envelope("pelaggio.run-started", { eventId: ID(10), seq: 1, heartbeatMs: 15_000, ts: T0, itemId: "a" })]);
		writeSegment(b, ID(0), [envelope("pelaggio.run-started", { eventId: ID(11), seq: 1, heartbeatMs: 15_000, ts: T0, itemId: "b", streamId: ID(2), executionId: ID(3) })]);
		const registry = registryFor({ alpha: a, beta: b });
		const all = listExternalRuns({ registry, supervised: [], now: () => Date.parse(T10) });
		const filtered = listExternalRuns({ registry, supervised: [], repo: "alpha", now: () => Date.parse(T10) });
		assert.equal(all.length, 2);
		assert.equal(filtered.length, 1);
		assert.equal(filtered[0]?.repo, "alpha");
	});
});
