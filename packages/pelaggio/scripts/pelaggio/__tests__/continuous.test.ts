import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { continuousCycleCap, DayBudgetTracker, dayKey, freeQueueProbe, isContinuousPreset, resolveContinuousConfig } from "../continuous.js";
import { DEFAULT_FLOW_POLICY } from "../flow-policy.js";
import type { RoadmapItemStatus } from "../roadmap/types.js";
import type { Flags } from "../types.js";

const baseFlags: Flags = {
	cycles: "1",
	parallel: "1",
	verbose: false,
	trace: false,
	budget: "40",
	"dry-run": false,
	"no-worktree": false,
};

describe("isContinuousPreset", () => {
	it("accepts drain and watch", () => {
		assert.equal(isContinuousPreset("drain"), true);
		assert.equal(isContinuousPreset("watch"), true);
		assert.equal(isContinuousPreset("loop"), false);
	});
});

describe("resolveContinuousConfig", () => {
	it("returns null when continuous is off", () => {
		const r = resolveContinuousConfig(baseFlags);
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.config, null);
	});

	it("enables continuous with default drain preset", () => {
		const r = resolveContinuousConfig({ ...baseFlags, continuous: true });
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.deepEqual(r.config, {
			enabled: true,
			preset: "drain",
			probeIntervalMs: 5 * 60_000,
		});
	});

	it("--preset alone enables continuous", () => {
		const r = resolveContinuousConfig({ ...baseFlags, preset: "watch" });
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.config?.preset, "watch");
		assert.equal(r.config?.probeIntervalMs, 5 * 60_000);
	});

	it("parses day-budget and probe-interval", () => {
		const r = resolveContinuousConfig({
			...baseFlags,
			continuous: true,
			preset: "watch",
			"day-budget": "12.5",
			"probe-interval": "10m",
		});
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.config?.dayBudget, 12.5);
		assert.equal(r.config?.probeIntervalMs, 10 * 60_000);
	});

	it("rejects invalid preset", () => {
		const r = resolveContinuousConfig({ ...baseFlags, preset: "forever" });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.message, /invalid --preset/);
	});

	it("rejects continuous with --item", () => {
		const r = resolveContinuousConfig({ ...baseFlags, continuous: true, item: "82" });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.message, /auto-pick/);
	});

	it("rejects continuous with --resume", () => {
		const r = resolveContinuousConfig({ ...baseFlags, continuous: true, resume: "82" });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.message, /resume/);
	});

	it("rejects non-positive day-budget", () => {
		const r = resolveContinuousConfig({ ...baseFlags, continuous: true, "day-budget": "0" });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.message, /day-budget/);
	});

	it("rejects partially numeric day-budget", () => {
		const r = resolveContinuousConfig({ ...baseFlags, continuous: true, "day-budget": "5usd" });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.message, /day-budget/);
	});

	it("rejects malformed and zero probe intervals", () => {
		for (const interval of ["later", "5minutes", "0", "0m"]) {
			const r = resolveContinuousConfig({ ...baseFlags, continuous: true, "probe-interval": interval });
			assert.equal(r.ok, false, interval);
			if (r.ok) continue;
			assert.match(r.message, /probe-interval/);
		}
	});
});

describe("continuousCycleCap", () => {
	it("non-continuous: max of cycles/parallel/items", () => {
		assert.equal(continuousCycleCap({ ...baseFlags, cycles: "2", item: "a,b,c" }, null), 3);
	});

	it("continuous with default cycles=1 → unlimited", () => {
		const cfg = { enabled: true as const, preset: "drain" as const, probeIntervalMs: 1 };
		assert.equal(continuousCycleCap(baseFlags, cfg), Number.MAX_SAFE_INTEGER);
	});

	it("continuous with explicit cycles>1 → that max", () => {
		const cfg = { enabled: true as const, preset: "drain" as const, probeIntervalMs: 1 };
		assert.equal(continuousCycleCap({ ...baseFlags, cycles: "7" }, cfg), 7);
	});
});

describe("DayBudgetTracker", () => {
	it("tracks spend and reports exceeded", () => {
		const t = new DayBudgetTracker(10, () => Date.parse("2026-08-02T12:00:00Z"));
		assert.equal(t.exceeded(), false);
		t.add(4);
		t.add(6);
		assert.equal(t.daySpent, 10);
		assert.equal(t.exceeded(), true);
	});

	it("resets on calendar day rollover", () => {
		let now = Date.parse("2026-08-02T23:00:00");
		const t = new DayBudgetTracker(5, () => now);
		t.add(5);
		assert.equal(t.exceeded(), true);
		now = Date.parse("2026-08-03T01:00:00");
		assert.equal(t.exceeded(), false);
		assert.equal(t.daySpent, 0);
	});

	it("no cap when dayBudget is undefined", () => {
		const t = new DayBudgetTracker(undefined);
		t.add(999);
		assert.equal(t.exceeded(), false);
	});
});

describe("dayKey", () => {
	it("formats YYYY-MM-DD", () => {
		// Use local noon to avoid timezone edge cases around midnight.
		const d = new Date(2026, 7, 2, 12, 0, 0); // month is 0-indexed
		assert.equal(dayKey(d.getTime()), "2026-08-02");
	});
});

describe("freeQueueProbe", () => {
	it("reports empty when no eligible open items", async () => {
		const items: RoadmapItemStatus[] = [
			{ id: "1", title: "done", deps: "", sourceRef: "x#1", status: "done" },
			{ id: "2", title: "blocked", deps: "", sourceRef: "x#2", status: "blocked" },
		];
		const roadmap = {
			listItems: async () => items,
		} as unknown as import("../roadmap/index.js").RoadmapSource;
		const probe = await freeQueueProbe(roadmap, DEFAULT_FLOW_POLICY);
		assert.equal(probe.empty, true);
		assert.equal(probe.readyCount, 0);
	});

	it("reports ready when an open non-deferred item exists", async () => {
		const items: RoadmapItemStatus[] = [{ id: "82", title: "work", deps: "", sourceRef: "x#82", status: "open", priority: 1 }];
		const roadmap = {
			listItems: async () => items,
		} as unknown as import("../roadmap/index.js").RoadmapSource;
		const probe = await freeQueueProbe(roadmap, DEFAULT_FLOW_POLICY);
		assert.equal(probe.empty, false);
		assert.equal(probe.readyCount, 1);
	});
});
