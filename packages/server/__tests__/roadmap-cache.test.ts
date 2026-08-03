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

describe("RoadmapCache", () => {
	it("first get builds via factory; second get returns the same instance", () => {
		const registry = new Registry([{ slug: "main", path: "/tmp/main" }]);
		let calls = 0;
		const factory = (path: string) => {
			calls++;
			return fakeSource(`for-${path}`);
		};
		const cache = new RoadmapCache({ registry, factory });
		const first = cache.get("main");
		const second = cache.get("main");
		assert.equal(calls, 1);
		assert.strictEqual(first, second);
	});

	it("different slugs yield different instances and call factory once each", () => {
		const registry = new Registry([
			{ slug: "a", path: "/tmp/a" },
			{ slug: "b", path: "/tmp/b" },
		]);
		const seen: string[] = [];
		const factory = (path: string) => {
			seen.push(path);
			return fakeSource(path);
		};
		const cache = new RoadmapCache({ registry, factory });
		const a = cache.get("a");
		const b = cache.get("b");
		assert.notStrictEqual(a, b);
		assert.deepEqual(seen, ["/tmp/a", "/tmp/b"]);
		// Re-fetch caches both
		assert.strictEqual(cache.get("a"), a);
		assert.strictEqual(cache.get("b"), b);
		assert.equal(seen.length, 2);
	});

	it("unknown slug propagates registry error; factory never called", () => {
		const registry = new Registry([{ slug: "main", path: "/tmp/main" }]);
		let called = false;
		const factory = () => {
			called = true;
			return fakeSource("never");
		};
		const cache = new RoadmapCache({ registry, factory });
		assert.throws(() => cache.get("missing"));
		assert.equal(called, false);
	});
});
