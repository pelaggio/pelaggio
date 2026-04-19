import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { RoadmapItem, RoadmapSource, Stats } from "@cdhorne/claude-autopilot";
import { createApp } from "../src/app.js";
import { LogBroker } from "../src/log-broker.js";
import { StateStore } from "../src/state-store.js";
import { Supervisor } from "../src/supervisor.js";
import type { PersistedRun } from "../src/types.js";

function fakeSpawn(): typeof import("node:child_process").spawn {
	return ((_cmd: string, _args: string[]) => {
		const ee = new EventEmitter() as EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
		ee.pid = 4242;
		ee.stdout = new PassThrough();
		ee.stderr = new PassThrough();
		ee.kill = () => true;
		return ee as unknown as ChildProcess;
	}) as unknown as typeof import("node:child_process").spawn;
}

function makeRoadmap(items: RoadmapItem[]): RoadmapSource {
	return {
		name: "markdown",
		listOpenItems: async () => items,
		listItems: async () => items.map((i) => ({ ...i, status: "open" as const })),
		getItem: async (id) => {
			const found = items.find((i) => i.id === id);
			return found ? { ...found, status: "open" as const } : null;
		},
		claimItem: async () => ({ branch: "x", worktree: "x" }),
		markDone: async () => {},
		archivePlan: async () => {},
		createItem: async () => items[0]!,
		planPath: async () => "x.md",
		publishPlan: async () => {},
	} satisfies RoadmapSource;
}

function setup(opts: { token?: string } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "app-test-"));
	const store = new StateStore(join(dir, "state.json"));
	const broker = new LogBroker();
	const supervisor = new Supervisor({
		store,
		broker,
		repoCwd: dir,
		logDir: join(dir, "logs"),
		spawn: fakeSpawn(),
		now: () => new Date("2026-04-19T00:00:00.000Z"),
	});
	const stats: Stats = { totals: { cycles: 0, completed: 0, failed: 0, parked: 0, costUsd: 0, durationMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } }, byItem: {}, recent: [] } as unknown as Stats;
	const roadmap = makeRoadmap([{ id: "TOOL-1", title: "x", deps: "—", sourceRef: "x" }]);
	const app = createApp({ supervisor, roadmap, computeStats: () => stats, token: opts.token });
	return { app, supervisor, store };
}

describe("createApp", () => {
	it("GET /healthz bypasses bearer auth", async () => {
		const { app } = setup({ token: "secret" });
		const res = await app.request("/healthz");
		assert.equal(res.status, 200);
	});

	it("GET /stats returns computeStats output", async () => {
		const { app } = setup();
		const res = await app.request("/stats");
		assert.equal(res.status, 200);
		const body = (await res.json()) as { totals: unknown };
		assert.ok(body.totals);
	});

	it("GET /roadmap returns source name + items", async () => {
		const { app } = setup();
		const res = await app.request("/roadmap");
		assert.equal(res.status, 200);
		const body = (await res.json()) as { source: string; items: RoadmapItem[] };
		assert.equal(body.source, "markdown");
		assert.equal(body.items.length, 1);
		assert.equal(body.items[0]?.id, "TOOL-1");
	});

	it("POST /runs with missing body → 400", async () => {
		const { app } = setup();
		const res = await app.request("/runs", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
		assert.equal(res.status, 400);
		const body = (await res.json()) as { code: string };
		assert.equal(body.code, "bad-request");
	});

	it("POST /runs with invalid shipTarget → 400", async () => {
		const { app } = setup();
		const res = await app.request("/runs", {
			method: "POST",
			body: JSON.stringify({ item: "TOOL-1", shipTarget: "nope" }),
			headers: { "content-type": "application/json" },
		});
		assert.equal(res.status, 400);
	});

	it("POST /runs happy path → 200 with id+item+startedAt+logPath", async () => {
		const { app } = setup();
		const res = await app.request("/runs", {
			method: "POST",
			body: JSON.stringify({ item: "TOOL-1" }),
			headers: { "content-type": "application/json" },
		});
		assert.equal(res.status, 200);
		const body = (await res.json()) as { id: string; item: string; startedAt: string; logPath: string };
		assert.equal(body.item, "TOOL-1");
		assert.match(body.id, /^[0-9A-Z]{26}$/);
	});

	it("GET /runs/:id 404 for unknown id", async () => {
		const { app } = setup();
		const res = await app.request("/runs/missing");
		assert.equal(res.status, 404);
	});

	it("GET /runs lists current runs", async () => {
		const { app, supervisor } = setup();
		supervisor.start({ item: "TOOL-1" });
		const res = await app.request("/runs");
		assert.equal(res.status, 200);
		const body = (await res.json()) as { runs: PersistedRun[] };
		assert.equal(body.runs.length, 1);
	});

	it("bearer gate: missing token → 401 except /healthz", async () => {
		const { app } = setup({ token: "secret" });
		assert.equal((await app.request("/stats")).status, 401);
		assert.equal((await app.request("/roadmap")).status, 401);
		assert.equal((await app.request("/runs")).status, 401);
		assert.equal((await app.request("/healthz")).status, 200);
	});

	it("bearer gate: correct token → 200", async () => {
		const { app } = setup({ token: "secret" });
		const res = await app.request("/stats", { headers: { Authorization: "Bearer secret" } });
		assert.equal(res.status, 200);
	});
});
