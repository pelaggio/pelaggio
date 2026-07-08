import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { RoadmapItem, RoadmapSource } from "pelaggio";
import { createApp } from "../src/app.js";
import { LogBroker } from "../src/log-broker.js";
import { Registry } from "../src/registry.js";
import { RoadmapCache } from "../src/roadmap-cache.js";
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

function setup(opts: { token?: string; webDist?: string; repos?: Record<string, string> } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "app-test-"));
	const repos = opts.repos ?? { main: dir };
	const registry = new Registry(Object.entries(repos).map(([slug, path]) => ({ slug, path })));
	const items: RoadmapItem[] = [{ id: "TOOL-1", title: "x", deps: "—", sourceRef: "x" }];
	const roadmapCache = new RoadmapCache({ registry, factory: () => makeRoadmap(items) });
	const store = new StateStore(join(dir, "state.json"));
	const broker = new LogBroker();
	const supervisor = new Supervisor({
		store,
		broker,
		registry,
		logDir: join(dir, "logs"),
		spawn: fakeSpawn(),
		now: () => new Date("2026-04-19T00:00:00.000Z"),
	});
	const app = createApp({ supervisor, registry, roadmapCache, token: opts.token, webDist: opts.webDist });
	return { app, supervisor, store, dir, registry };
}

describe("createApp", () => {
	it("GET /healthz bypasses bearer auth", async () => {
		const { app } = setup({ token: "secret" });
		const res = await app.request("/healthz");
		assert.equal(res.status, 200);
	});

	it("GET /repos lists registry entries with exists flag", async () => {
		const realDir = mkdtempSync(join(tmpdir(), "repo-real-"));
		const { app } = setup({ repos: { main: realDir, missing: join(tmpdir(), "no-such-repo-xyz") } });
		const res = await app.request("/repos");
		assert.equal(res.status, 200);
		const body = (await res.json()) as { repos: Array<{ slug: string; path: string; exists: boolean }> };
		assert.equal(body.repos.length, 2);
		const main = body.repos.find((r) => r.slug === "main");
		const missing = body.repos.find((r) => r.slug === "missing");
		assert.equal(main?.exists, true);
		assert.equal(missing?.exists, false);
	});

	it("GET /repos/:slug/roadmap returns source name + items", async () => {
		const { app } = setup();
		const res = await app.request("/repos/main/roadmap");
		assert.equal(res.status, 200);
		const body = (await res.json()) as { source: string; items: RoadmapItem[] };
		assert.equal(body.source, "markdown");
		assert.equal(body.items.length, 1);
		assert.equal(body.items[0]?.id, "TOOL-1");
	});

	it("GET /repos/missing/roadmap returns 404", async () => {
		const { app } = setup();
		const res = await app.request("/repos/missing/roadmap");
		assert.equal(res.status, 404);
		const body = (await res.json()) as { code: string };
		assert.equal(body.code, "not-found");
	});

	it("GET /repos/:slug/stats returns stats payload", async () => {
		const { app } = setup();
		const res = await app.request("/repos/main/stats");
		assert.equal(res.status, 200);
		const body = (await res.json()) as { totalCycles: number; itemsDelivered: unknown[] };
		assert.equal(typeof body.totalCycles, "number");
		assert.ok(Array.isArray(body.itemsDelivered));
	});

	it("GET /repos/missing/stats returns 404", async () => {
		const { app } = setup();
		const res = await app.request("/repos/missing/stats");
		assert.equal(res.status, 404);
	});

	it("GET /roadmap and GET /stats are removed (404)", async () => {
		const { app } = setup();
		assert.equal((await app.request("/roadmap")).status, 404);
		assert.equal((await app.request("/stats")).status, 404);
	});

	it("POST /runs with missing body → 400", async () => {
		const { app } = setup();
		const res = await app.request("/runs", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
		assert.equal(res.status, 400);
		const body = (await res.json()) as { code: string };
		assert.equal(body.code, "bad-request");
	});

	it("POST /runs missing repo → 400", async () => {
		const { app } = setup();
		const res = await app.request("/runs", {
			method: "POST",
			body: JSON.stringify({ item: "TOOL-1" }),
			headers: { "content-type": "application/json" },
		});
		assert.equal(res.status, 400);
		const body = (await res.json()) as { code: string; error: string };
		assert.equal(body.code, "bad-request");
		assert.match(body.error, /repo/);
	});

	it("POST /runs unknown repo → 400 (mapped from unknown-repo)", async () => {
		const { app } = setup();
		const res = await app.request("/runs", {
			method: "POST",
			body: JSON.stringify({ repo: "missing", item: "TOOL-1" }),
			headers: { "content-type": "application/json" },
		});
		assert.equal(res.status, 400);
		const body = (await res.json()) as { code: string };
		assert.equal(body.code, "bad-request");
	});

	it("POST /runs with invalid shipTarget → 400", async () => {
		const { app } = setup();
		const res = await app.request("/runs", {
			method: "POST",
			body: JSON.stringify({ repo: "main", item: "TOOL-1", shipTarget: "nope" }),
			headers: { "content-type": "application/json" },
		});
		assert.equal(res.status, 400);
	});

	it("POST /runs happy path → 200; persisted run carries repo", async () => {
		const { app, supervisor } = setup();
		const res = await app.request("/runs", {
			method: "POST",
			body: JSON.stringify({ repo: "main", item: "TOOL-1" }),
			headers: { "content-type": "application/json" },
		});
		assert.equal(res.status, 200);
		const body = (await res.json()) as { id: string; repo: string; item: string; startedAt: string; logPath: string };
		assert.equal(body.repo, "main");
		assert.equal(body.item, "TOOL-1");
		assert.match(body.id, /^[0-9A-Z]{26}$/);
		const persisted = supervisor.get(body.id);
		assert.equal(persisted?.repo, "main");
	});

	it("GET /runs/:id 404 for unknown id", async () => {
		const { app } = setup();
		const res = await app.request("/runs/missing");
		assert.equal(res.status, 404);
	});

	it("GET /runs lists current runs", async () => {
		const { app, supervisor } = setup();
		supervisor.start({ repo: "main", item: "TOOL-1" });
		const res = await app.request("/runs");
		assert.equal(res.status, 200);
		const body = (await res.json()) as { runs: PersistedRun[] };
		assert.equal(body.runs.length, 1);
	});

	it("GET /runs?repo=<slug> filters by repo", async (t) => {
		t.mock.method(console, "warn"); // suppress potential basename-collision warning
		const dirA = mkdtempSync(join(tmpdir(), "repo-a-"));
		const dirB = mkdtempSync(join(tmpdir(), "repo-b-"));
		const { app, supervisor } = setup({ repos: { main: dirA, other: dirB } });
		supervisor.start({ repo: "main", item: "A" });
		supervisor.start({ repo: "other", item: "B" });
		const main = await app.request("/runs?repo=main");
		const other = await app.request("/runs?repo=other");
		const none = await app.request("/runs?repo=nope");
		const all = await app.request("/runs");
		const mainBody = (await main.json()) as { runs: Array<{ repo: string }> };
		const otherBody = (await other.json()) as { runs: Array<{ repo: string }> };
		const noneBody = (await none.json()) as { runs: unknown[] };
		const allBody = (await all.json()) as { runs: unknown[] };
		assert.equal(mainBody.runs.length, 1);
		assert.equal(mainBody.runs[0]?.repo, "main");
		assert.equal(otherBody.runs.length, 1);
		assert.equal(otherBody.runs[0]?.repo, "other");
		assert.equal(noneBody.runs.length, 0);
		assert.equal(allBody.runs.length, 2);
	});

	it("bearer gate: missing token → 401 except /healthz", async () => {
		const { app } = setup({ token: "secret" });
		assert.equal((await app.request("/repos")).status, 401);
		assert.equal((await app.request("/repos/main/roadmap")).status, 401);
		assert.equal((await app.request("/repos/main/stats")).status, 401);
		assert.equal((await app.request("/runs")).status, 401);
		assert.equal((await app.request("/healthz")).status, 200);
	});

	it("bearer gate: correct token → 200", async () => {
		const { app } = setup({ token: "secret" });
		const res = await app.request("/repos", { headers: { Authorization: "Bearer secret" } });
		assert.equal(res.status, 200);
	});

	it("static handler serves /ui/index.html when webDist is set", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-dist-"));
		writeFileSync(join(dir, "index.html"), "<!doctype html><html><body>pelaggio ui</body></html>");
		const { app } = setup({ webDist: dir });
		const res = await app.request("/ui/");
		assert.equal(res.status, 200);
		const body = await res.text();
		assert.match(body, /pelaggio ui/);
	});

	it("API routes still return JSON when webDist is set (no /ui collision)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-dist-"));
		writeFileSync(join(dir, "index.html"), "<!doctype html>");
		const { app } = setup({ webDist: dir });
		const runs = await app.request("/runs");
		assert.equal(runs.status, 200);
		assert.match(runs.headers.get("content-type") ?? "", /application\/json/);
		const repos = await app.request("/repos");
		assert.equal(repos.status, 200);
		assert.match(repos.headers.get("content-type") ?? "", /application\/json/);
	});

	it("GET / 302s to /ui/ when webDist is set", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-dist-"));
		writeFileSync(join(dir, "index.html"), "<!doctype html>");
		const { app } = setup({ webDist: dir });
		const res = await app.request("/");
		assert.equal(res.status, 302);
		assert.equal(res.headers.get("location"), "/ui/");
	});

	it("no static handler / no redirect when webDist is undefined", async () => {
		const { app } = setup();
		const root = await app.request("/");
		assert.equal(root.status, 404);
		const ui = await app.request("/ui/");
		assert.equal(ui.status, 404);
	});
});
