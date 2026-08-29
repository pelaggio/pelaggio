import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RoadmapSource } from "pelaggio";
import { Registry } from "../src/registry.js";
import { RoadmapCache } from "../src/roadmap-cache.js";

function fakeSource(name: string): RoadmapSource {
	return {
		name: name as RoadmapSource["name"],
		listOpenItems: async () => [],
		listItems: async () => [],
		getItem: async () => null,
		claimItem: async () => ({ branch: "x", worktree: "x" }),
		markDone: async () => {},
		archivePlan: async () => {},
		createItem: async () => {
			throw new Error("not used");
		},
		getItemPlan: async () => null,
		resolvePlanPath: () => "x.md",
		publishPlan: async () => {},
		isCharterPickRace: () => false,
		parseItemId: async () => null,
	} satisfies RoadmapSource;
}

function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("RoadmapCache", () => {
	it("caches one roadmap source instance per registry slug", () => {
		const registry = new Registry([
			{ slug: "a", path: "/tmp/a" },
			{ slug: "b", path: "/tmp/b" },
		]);
		const seen: string[] = [];
		const cache = new RoadmapCache({
			registry,
			factory: (path) => {
				seen.push(path);
				return fakeSource(path);
			},
			listRoadmap: async () => "[]",
		});

		const a = cache.get("a");
		assert.strictEqual(cache.get("a"), a);
		assert.notStrictEqual(cache.get("b"), a);
		assert.deepEqual(seen, ["/tmp/a", "/tmp/b"]);
	});

	it("keeps source lookup strict but title enrichment fail-open for unknown slugs", () => {
		const registry = new Registry([{ slug: "main", path: "/tmp/main" }]);
		let listCalls = 0;
		const cache = new RoadmapCache({
			registry,
			factory: () => fakeSource("main"),
			listRoadmap: async () => {
				listCalls++;
				return "[]";
			},
		});

		assert.throws(() => cache.get("missing"));
		assert.equal(cache.getTitles("missing").size, 0);
		assert.equal(listCalls, 0);
	});

	it("coalesces every item read into one non-blocking list refresh per repo and TTL", async () => {
		const registry = new Registry([{ slug: "main", path: "/tmp/main" }]);
		let now = 1_000;
		let calls = 0;
		let release: ((output: string) => void) | undefined;
		const cache = new RoadmapCache({
			registry,
			factory: () => fakeSource("main"),
			now: () => now,
			titleTtlMs: 60_000,
			listRoadmap: () => {
				calls++;
				return new Promise((resolve) => {
					release = resolve;
				});
			},
		});

		const first = cache.getTitles("main");
		assert.equal(first.size, 0, "the request must not await an uncached refresh");
		for (let id = 0; id < 1_000; id++) cache.getTitles("main").get(String(id));
		await Promise.resolve();
		assert.equal(calls, 1);

		release?.(JSON.stringify([{ id: "42", title: "Cached title" }]));
		await tick();
		assert.equal(cache.getTitles("main").get("42"), "Cached title");
		assert.equal(calls, 1);

		now += 60_001;
		cache.getTitles("main");
		cache.getTitles("main");
		await Promise.resolve();
		assert.equal(calls, 2);
	});

	it("keeps the last good map when refresh fails or returns invalid JSON", async () => {
		const registry = new Registry([{ slug: "main", path: "/tmp/main" }]);
		let now = 1_000;
		let calls = 0;
		const cache = new RoadmapCache({
			registry,
			factory: () => fakeSource("main"),
			now: () => now,
			titleTtlMs: 100,
			listRoadmap: async () => {
				calls++;
				if (calls === 1) return JSON.stringify([{ id: "42", title: "Last good" }]);
				if (calls === 2) throw new Error("provider unavailable");
				return "not-json";
			},
		});

		cache.getTitles("main");
		await tick();
		assert.equal(cache.getTitles("main").get("42"), "Last good");
		now += 101;
		cache.getTitles("main");
		await tick();
		assert.equal(cache.getTitles("main").get("42"), "Last good");
		assert.equal(calls, 2);
		now += 101;
		cache.getTitles("main");
		await tick();
		assert.equal(cache.getTitles("main").get("42"), "Last good");
		assert.equal(calls, 3);
	});

	it("keeps repository title maps independent and omits blank titles", async () => {
		const registry = new Registry([
			{ slug: "a", path: "/tmp/a" },
			{ slug: "b", path: "/tmp/b" },
		]);
		const cache = new RoadmapCache({
			registry,
			factory: (path) => fakeSource(path),
			listRoadmap: async (slug) =>
				JSON.stringify([
					{ id: "42", title: `Title ${slug}` },
					{ id: "blank", title: "   " },
				]),
		});

		cache.getTitles("a");
		cache.getTitles("b");
		await tick();
		assert.equal(cache.getTitles("a").get("42"), "Title a");
		assert.equal(cache.getTitles("b").get("42"), "Title b");
		assert.equal(cache.getTitles("a").has("blank"), false);
	});
});
