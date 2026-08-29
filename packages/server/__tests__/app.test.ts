import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { RoadmapItem, RoadmapSource } from "pelaggio";
import { createApp } from "../src/app.js";
import { LogBroker } from "../src/log-broker.js";
import { Registry } from "../src/registry.js";
import { RoadmapCache, type RoadmapList } from "../src/roadmap-cache.js";
import { StateStore } from "../src/state-store.js";
import { Supervisor } from "../src/supervisor.js";

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

type RoadmapItemStatus = NonNullable<Awaited<ReturnType<RoadmapSource["getItem"]>>>;

interface CycleLogFixture {
	ts: string;
	cycle: number;
	item: string | null;
	quick: boolean;
	steps: unknown[];
	total_cost: number;
	verdict: string | null;
	completed: boolean;
	error: string | null;
}

function makeRoadmap(items: RoadmapItemStatus[]): RoadmapSource {
	return {
		name: "markdown",
		listOpenItems: async () => items.filter((item) => item.status === "open"),
		listItems: async () => items,
		getItem: async (id) => {
			const found = items.find((i) => i.id === id);
			return found ?? null;
		},
		claimItem: async () => ({ branch: "x", worktree: "x" }),
		markDone: async () => {},
		archivePlan: async () => {},
		createItem: async () => items[0]!,
		getItemPlan: async () => null,
		resolvePlanPath: () => "x.md",
		publishPlan: async () => {},
		isCharterPickRace: () => false,
		parseItemId: async () => null,
	} satisfies RoadmapSource;
}

function writeCycleLog(repo: string, entries: CycleLogFixture[]): void {
	const devDir = join(repo, ".dev");
	mkdirSync(devDir, { recursive: true });
	writeFileSync(join(devDir, "pelaggio-log.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function cycle(partial: Partial<CycleLogFixture> & { cycle: number }): CycleLogFixture {
	return {
		ts: "2026-04-19T00:00:00.000Z",
		item: null,
		quick: false,
		steps: [],
		total_cost: 0,
		verdict: null,
		completed: false,
		error: null,
		...partial,
	};
}

function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function setup(opts: { token?: string; webDist?: string; trustManifestPath?: string; repos?: Record<string, string>; roadmapFactory?: (repoPath: string) => RoadmapSource; roadmapList?: RoadmapList; titleTtlMs?: number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "app-test-"));
	const repos = opts.repos ?? { main: dir };
	const registry = new Registry(Object.entries(repos).map(([slug, path]) => ({ slug, path })));
	const items: RoadmapItemStatus[] = [{ id: "TOOL-1", title: "x", deps: "—", sourceRef: "x", status: "open" }];
	const roadmapFactory = opts.roadmapFactory ?? (() => makeRoadmap(items));
	const roadmapCache = new RoadmapCache({
		registry,
		factory: roadmapFactory,
		listRoadmap:
			opts.roadmapList ??
			(async (slug) => {
				const roadmap = roadmapFactory(registry.path(slug));
				return JSON.stringify(await roadmap.listItems({ includeDone: true }));
			}),
		...(opts.titleTtlMs !== undefined ? { titleTtlMs: opts.titleTtlMs } : {}),
	});
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
	const token = opts.token ?? "test-token";
	const rawApp = createApp({ supervisor, registry, roadmapCache, token, webDist: opts.webDist, trustManifestPath: opts.trustManifestPath });
	const app = {
		request(path: string, init?: RequestInit): Response | Promise<Response> {
			const headers = new Headers(init?.headers);
			headers.set("Authorization", `Bearer ${token}`);
			return rawApp.request(path, { ...init, headers });
		},
	};
	return { app, rawApp, supervisor, store, dir, registry, roadmapCache };
}

describe("createApp", () => {
	it("GET /healthz bypasses bearer auth", async () => {
		const { rawApp } = setup({ token: "secret" });
		const res = await rawApp.request("/healthz");
		assert.equal(res.status, 200);
	});

	it("GET /.well-known/pelaggio.trust.json bypasses bearer auth and returns JSON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "trust-manifest-"));
		const path = join(dir, "pelaggio.trust.json");
		writeFileSync(path, JSON.stringify({ product: "pelaggio" }));
		const { rawApp } = setup({ token: "secret", trustManifestPath: path });
		const res = await rawApp.request("/.well-known/pelaggio.trust.json");
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /application\/json/);
		assert.deepEqual(await res.json(), { product: "pelaggio" });
	});

	it("GET /.well-known/pelaggio.trust.json returns JSON 404 when missing", async () => {
		const { rawApp } = setup({ trustManifestPath: join(tmpdir(), "missing-pelaggio-trust.json") });
		const res = await rawApp.request("/.well-known/pelaggio.trust.json");
		assert.equal(res.status, 404);
		assert.match(res.headers.get("content-type") ?? "", /application\/json/);
		const body = (await res.json()) as { code: string };
		assert.equal(body.code, "not-found");
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

	it("GET /repos/:slug/stats enriches closed delivered and open failed items from one cached list", async () => {
		let calls = 0;
		const { app, dir } = setup({
			roadmapList: async () => {
				calls++;
				return JSON.stringify([
					{ id: "42", title: "Delivered item", status: "done" },
					{ id: "43", title: "Open item", status: "open" },
				]);
			},
		});
		writeCycleLog(dir, [cycle({ cycle: 1, item: "42", completed: true }), cycle({ cycle: 2, item: "43", error: "implement failed" })]);

		const cold = await app.request("/repos/main/stats");
		assert.equal(cold.status, 200);
		await tick();
		const res = await app.request("/repos/main/stats");
		assert.equal(res.status, 200);
		const body = (await res.json()) as { itemsDelivered: Array<{ id: string; itemTitle?: string }>; recentFailures: Array<{ item: string | null; itemTitle?: string }> };
		assert.equal(body.itemsDelivered[0]?.itemTitle, "Delivered item");
		assert.equal(body.recentFailures[0]?.itemTitle, "Open item");
		assert.equal(calls, 1);
	});

	it("stats and runs preserve ID-only payloads when roadmap list fails", async () => {
		const { app, dir, supervisor } = setup({ roadmapList: async () => Promise.reject(new Error("provider unavailable")) });
		writeCycleLog(dir, [cycle({ cycle: 1, item: "42", completed: true })]);
		supervisor.start({ repo: "main", item: "42" });

		const statsRes = await app.request("/repos/main/stats");
		const runsRes = await app.request("/runs");
		assert.equal(statsRes.status, 200);
		assert.equal(runsRes.status, 200);
		const stats = (await statsRes.json()) as { itemsDelivered: Array<{ id: string; itemTitle?: string }> };
		const runs = (await runsRes.json()) as { runs: Array<{ item?: string; itemTitle?: string }> };
		assert.deepEqual(
			stats.itemsDelivered.map(({ id, itemTitle }) => ({ id, itemTitle })),
			[{ id: "42", itemTitle: undefined }],
		);
		assert.deepEqual(
			runs.runs.map(({ item, itemTitle }) => ({ item, itemTitle })),
			[{ item: "42", itemTitle: undefined }],
		);
		assert.equal(
			stats.itemsDelivered.every((item) => !Object.hasOwn(item, "itemTitle")),
			true,
		);
		assert.equal(
			runs.runs.every((run) => !Object.hasOwn(run, "itemTitle")),
			true,
		);
	});

	it("omits itemTitle when the title is blank", async () => {
		const { app, dir, supervisor } = setup({ roadmapList: async () => JSON.stringify([{ id: "blank", title: "   " }]) });
		writeCycleLog(dir, [cycle({ cycle: 1, item: "blank", completed: true })]);
		supervisor.start({ repo: "main", item: "blank" });

		const statsRes = await app.request("/repos/main/stats");
		const runsRes = await app.request("/runs");
		assert.equal(statsRes.status, 200);
		assert.equal(runsRes.status, 200);
		const stats = (await statsRes.json()) as { itemsDelivered: Array<Record<string, unknown>> };
		const runs = (await runsRes.json()) as { runs: Array<Record<string, unknown>> };
		assert.equal(stats.itemsDelivered.length, 1);
		assert.equal(runs.runs.length, 1);
		assert.equal(
			stats.itemsDelivered.every((item) => !Object.hasOwn(item, "itemTitle")),
			true,
		);
		assert.equal(
			runs.runs.every((run) => !Object.hasOwn(run, "itemTitle")),
			true,
		);
	});

	it("renders an id absent from the bounded title snapshot bare without error", async () => {
		const { app, dir, supervisor } = setup({ roadmapList: async () => JSON.stringify([{ id: "inside-window", title: "Known" }]) });
		writeCycleLog(dir, [cycle({ cycle: 1, item: "outside-window", completed: true })]);
		supervisor.start({ repo: "main", item: "outside-window" });

		await app.request("/repos/main/stats");
		await tick();
		const statsRes = await app.request("/repos/main/stats");
		const runsRes = await app.request("/runs");
		assert.equal(statsRes.status, 200);
		assert.equal(runsRes.status, 200);
		const stats = (await statsRes.json()) as { itemsDelivered: Array<Record<string, unknown>> };
		const runs = (await runsRes.json()) as { runs: Array<Record<string, unknown>> };
		assert.deepEqual(
			stats.itemsDelivered.map(({ id, itemTitle }) => ({ id, itemTitle })),
			[{ id: "outside-window", itemTitle: undefined }],
		);
		assert.deepEqual(
			runs.runs.map(({ item, itemTitle }) => ({ item, itemTitle })),
			[{ item: "outside-window", itemTitle: undefined }],
		);
		assert.equal(Object.hasOwn(stats.itemsDelivered[0] ?? {}, "itemTitle"), false);
		assert.equal(Object.hasOwn(runs.runs[0] ?? {}, "itemTitle"), false);
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

	it("unauthenticated POST /runs rejects a text/plain simple request before spawning", async () => {
		const { rawApp, supervisor } = setup();
		const res = await rawApp.request("/runs", {
			method: "POST",
			body: JSON.stringify({ repo: "main", item: "TOOL-1" }),
			headers: { "content-type": "text/plain" },
		});
		assert.equal(res.status, 401);
		const body = (await res.json()) as { code: string };
		assert.equal(body.code, "unauthorized");
		assert.equal(supervisor.list().length, 0);
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

	it("POST /runs continuous omits item → 200", async () => {
		const { app, supervisor } = setup();
		const res = await app.request("/runs", {
			method: "POST",
			body: JSON.stringify({ repo: "main", mode: "watch", parallel: 2 }),
			headers: { "content-type": "application/json" },
		});
		assert.equal(res.status, 200);
		const body = (await res.json()) as { id: string; mode?: string; item?: string };
		assert.equal(body.mode, "watch");
		assert.equal(body.item, undefined);
		assert.equal(supervisor.get(body.id)?.mode, "watch");
	});

	it("POST /runs continuous with item → 400", async () => {
		const { app } = setup();
		const res = await app.request("/runs", {
			method: "POST",
			body: JSON.stringify({ repo: "main", mode: "drain", item: "TOOL-1" }),
			headers: { "content-type": "application/json" },
		});
		assert.equal(res.status, 400);
	});

	it("POST /runs missing item without mode → 400", async () => {
		const { app } = setup();
		const res = await app.request("/runs", {
			method: "POST",
			body: JSON.stringify({ repo: "main" }),
			headers: { "content-type": "application/json" },
		});
		assert.equal(res.status, 400);
	});

	it("POST /runs watchDailyBudget without watch mode → 400", async () => {
		const { app } = setup();
		const res = await app.request("/runs", {
			method: "POST",
			body: JSON.stringify({ repo: "main", mode: "drain", watchDailyBudget: 10 }),
			headers: { "content-type": "application/json" },
		});
		assert.equal(res.status, 400);
	});

	it("POST /runs invalid mode → 400", async () => {
		const { app } = setup();
		const res = await app.request("/runs", {
			method: "POST",
			body: JSON.stringify({ repo: "main", mode: "forever" }),
			headers: { "content-type": "application/json" },
		});
		assert.equal(res.status, 400);
	});

	it("GET /repos/:slug/config returns watchDailyBudget null when unset", async () => {
		const { app, dir } = setup();
		// loadConfig reads .pelaggio.yml from the registry path (dir)
		const res = await app.request("/repos/main/config");
		assert.equal(res.status, 200);
		const body = (await res.json()) as { watchDailyBudget: number | null };
		assert.equal(body.watchDailyBudget, null);
		void dir;
	});

	it("GET /repos/:slug/config 404 for unknown slug", async () => {
		const { app } = setup();
		const res = await app.request("/repos/missing/config");
		assert.equal(res.status, 404);
	});

	it("GET /runs/:id 404 for unknown id", async () => {
		const { app } = setup();
		const res = await app.request("/runs/missing");
		assert.equal(res.status, 404);
	});

	it("GET /runs lists current runs", async () => {
		const { app, supervisor } = setup();
		supervisor.start({ repo: "main", item: "TOOL-1" });
		await app.request("/runs");
		await tick();
		const res = await app.request("/runs");
		assert.equal(res.status, 200);
		const body = (await res.json()) as { runs: Array<{ source: string; itemTitle?: string }> };
		assert.equal(body.runs.length, 1);
		assert.equal(body.runs[0]?.source, "supervised");
		assert.equal(body.runs[0]?.itemTitle, "x");
	});

	it("GET /runs keeps persisted rows whose repository was removed", async () => {
		const { app, store, dir } = setup();
		store.upsert({
			id: "persisted-removed-repo",
			repo: "removed",
			item: "42",
			status: "completed",
			pid: null,
			startedAt: "2026-04-18T00:00:00.000Z",
			logPath: join(dir, "removed.log"),
			cwd: dir,
		});

		const res = await app.request("/runs");
		assert.equal(res.status, 200);
		const body = (await res.json()) as { runs: Array<{ repo: string; item?: string; itemTitle?: string }> };
		assert.deepEqual(body.runs, [
			{
				id: "persisted-removed-repo",
				repo: "removed",
				item: "42",
				status: "completed",
				startedAt: "2026-04-18T00:00:00.000Z",
				source: "supervised",
			},
		]);
	});

	it("1000 historical ids trigger one non-blocking roadmap list per repo", async (t) => {
		let listCalls = 0;
		const { app, dir, supervisor } = setup({
			roadmapList: () => {
				listCalls++;
				return new Promise(() => {});
			},
		});
		const historical = Array.from({ length: 1_000 }, (_, index) => ({
			id: `historical-${index}`,
			repo: "main",
			item: String(index),
			status: "completed" as const,
			pid: null,
			startedAt: new Date(index).toISOString(),
			logPath: join(dir, `${index}.log`),
			cwd: dir,
		}));
		t.mock.method(supervisor, "list", () => historical);

		const response = await Promise.race([Promise.resolve(app.request("/runs")), new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 250))]);
		assert.notEqual(response, "timed-out");
		assert.equal((response as Response).status, 200);
		const second = await app.request("/runs");
		assert.equal(second.status, 200);
		assert.equal(listCalls, 1);
		const body = (await second.json()) as { runs: Array<{ itemTitle?: string }> };
		assert.equal(
			body.runs.every((run) => !Object.hasOwn(run, "itemTitle")),
			true,
		);
	});

	it("GET /runs resolves identical item ids against each run's repository", async (t) => {
		t.mock.method(console, "warn");
		const dirA = mkdtempSync(join(tmpdir(), "repo-a-"));
		const dirB = mkdtempSync(join(tmpdir(), "repo-b-"));
		const { app, supervisor } = setup({
			repos: { a: dirA, b: dirB },
			roadmapFactory: (repoPath) => makeRoadmap([{ id: "42", title: repoPath === dirA ? "Title A" : "Title B", deps: "—", sourceRef: repoPath, status: "open" }]),
		});
		supervisor.start({ repo: "a", item: "42" });
		supervisor.start({ repo: "b", item: "42" });

		await app.request("/runs");
		await tick();
		const res = await app.request("/runs");
		assert.equal(res.status, 200);
		const body = (await res.json()) as { runs: Array<{ repo: string; itemTitle?: string }> };
		assert.equal(body.runs.find((run) => run.repo === "a")?.itemTitle, "Title A");
		assert.equal(body.runs.find((run) => run.repo === "b")?.itemTitle, "Title B");
	});

	it("GET /runs merges external summaries, stamps source, and sorts startedAt desc / id asc", async () => {
		const { app, supervisor, dir } = setup();
		const run = supervisor.start({ repo: "main", item: "TOOL-1" });
		const eventsDir = join(dir, ".dev", "flow-events");
		mkdirSync(eventsDir, { recursive: true });
		const exec = "01J00000000000000000000099";
		const stream = "01J00000000000000000000098";
		const earlier = "2026-04-18T00:00:00.000Z";
		writeFileSync(
			join(eventsDir, `${stream}.jsonl`),
			`${JSON.stringify({
				v: 1,
				type: "pelaggio.run-started",
				eventId: "01J00000000000000000000097",
				streamId: stream,
				seq: 1,
				ts: earlier,
				itemId: "EXT-1",
				claimId: null,
				readinessEpisodeId: null,
				executionId: exec,
				causationId: null,
				heartbeatMs: 15_000,
			})}\n`,
		);
		const res = await app.request("/runs");
		assert.equal(res.status, 200);
		const body = (await res.json()) as { runs: Array<{ id: string; source: string; startedAt: string; item?: string }> };
		assert.equal(body.runs.length, 2);
		assert.equal(body.runs[0]?.id, run.id);
		assert.equal(body.runs[0]?.source, "supervised");
		assert.equal(body.runs[1]?.source, "external");
		assert.equal(body.runs[1]?.item, "EXT-1");
		assert.ok(body.runs[0]!.startedAt >= body.runs[1]!.startedAt);
	});

	it("GET /runs?repo=<slug> filters both supervised and external rows", async (t) => {
		t.mock.method(console, "warn");
		const dirA = mkdtempSync(join(tmpdir(), "repo-a-"));
		const dirB = mkdtempSync(join(tmpdir(), "repo-b-"));
		const eventsDir = join(dirB, ".dev", "flow-events");
		mkdirSync(eventsDir, { recursive: true });
		writeFileSync(
			join(eventsDir, "01J00000000000000000000088.jsonl"),
			`${JSON.stringify({
				v: 1,
				type: "pelaggio.run-started",
				eventId: "01J00000000000000000000087",
				streamId: "01J00000000000000000000088",
				seq: 1,
				ts: "2026-04-18T00:00:00.000Z",
				itemId: "EXT-B",
				claimId: null,
				readinessEpisodeId: null,
				executionId: "01J00000000000000000000089",
				causationId: null,
				heartbeatMs: 15_000,
			})}\n`,
		);
		const { app, supervisor } = setup({ repos: { main: dirA, other: dirB } });
		supervisor.start({ repo: "main", item: "A" });
		const main = await app.request("/runs?repo=main");
		const other = await app.request("/runs?repo=other");
		const mainBody = (await main.json()) as { runs: Array<{ repo: string; source: string }> };
		const otherBody = (await other.json()) as { runs: Array<{ repo: string; source: string }> };
		assert.equal(mainBody.runs.length, 1);
		assert.equal(mainBody.runs[0]?.source, "supervised");
		assert.equal(otherBody.runs.length, 1);
		assert.equal(otherBody.runs[0]?.source, "external");
		assert.equal(otherBody.runs[0]?.repo, "other");
	});

	it("external ids are 404 on get/pause/resume/stop/log", async () => {
		const { app } = setup();
		const id = "external:main:01J00000000000000000000001";
		assert.equal((await app.request(`/runs/${id}`)).status, 404);
		assert.equal((await app.request(`/runs/${id}/pause`, { method: "POST" })).status, 404);
		assert.equal((await app.request(`/runs/${id}/resume`, { method: "POST" })).status, 404);
		assert.equal((await app.request(`/runs/${id}/stop`, { method: "POST" })).status, 404);
		assert.equal((await app.request(`/runs/${id}/log`)).status, 404);
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
		const { rawApp } = setup({ token: "secret" });
		assert.equal((await rawApp.request("/repos")).status, 401);
		assert.equal((await rawApp.request("/repos/main/roadmap")).status, 401);
		assert.equal((await rawApp.request("/repos/main/stats")).status, 401);
		assert.equal((await rawApp.request("/runs")).status, 401);
		assert.equal((await rawApp.request("/healthz")).status, 200);
		assert.equal((await rawApp.request("/.well-known/pelaggio.trust.json")).status, 404);
	});

	it("bearer gate: correct token → 200", async () => {
		const { rawApp } = setup({ token: "secret" });
		const res = await rawApp.request("/repos", { headers: { Authorization: "Bearer secret" } });
		assert.equal(res.status, 200);
	});

	it("static handler serves /ui/index.html when webDist is set", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-dist-"));
		writeFileSync(join(dir, "index.html"), "<!doctype html><html><body>pelaggio ui</body></html>");
		const { rawApp } = setup({ token: "secret", webDist: dir });
		const res = await rawApp.request("/ui/");
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
		const { rawApp } = setup({ token: "secret", webDist: dir });
		const res = await rawApp.request("/");
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
