import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { continuousCycleCap, DayBudgetTracker, dayKey, freeQueueProbe, isContinuousPreset, nextLocalMidnightMs, resolveContinuousConfig, sumDaySpendFromLog } from "../continuous.js";
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

	it("CLI --day-budget overrides defaults.dayBudget", () => {
		const r = resolveContinuousConfig({ ...baseFlags, continuous: true, "day-budget": "9" }, { dayBudget: 25 });
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.config?.dayBudget, 9);
	});

	it("falls back to defaults.dayBudget when CLI omits --day-budget", () => {
		const r = resolveContinuousConfig({ ...baseFlags, continuous: true }, { dayBudget: 25 });
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.config?.dayBudget, 25);
	});

	it("unlimited when neither CLI nor defaults set day budget", () => {
		const r = resolveContinuousConfig({ ...baseFlags, continuous: true });
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.config?.dayBudget, undefined);
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

	it("seeds today's spend from initialSpent (process-start reconstruction)", () => {
		const now = () => Date.parse("2026-08-02T12:00:00Z");
		const t = new DayBudgetTracker(10, now, 8);
		assert.equal(t.daySpent, 8);
		assert.equal(t.exceeded(), false);
		t.add(2);
		assert.equal(t.daySpent, 10);
		assert.equal(t.exceeded(), true);
	});

	it("ignores a non-positive or non-finite initialSpent", () => {
		const now = () => Date.parse("2026-08-02T12:00:00Z");
		assert.equal(new DayBudgetTracker(10, now, 0).daySpent, 0);
		assert.equal(new DayBudgetTracker(10, now, -5).daySpent, 0);
		assert.equal(new DayBudgetTracker(10, now, Number.NaN).daySpent, 0);
	});

	it("seeded spend still rolls to zero after local midnight", () => {
		let now = new Date(2026, 7, 2, 12, 0, 0).getTime();
		const t = new DayBudgetTracker(10, () => now, 9);
		assert.equal(t.exceeded(), false);
		assert.equal(t.daySpent, 9);
		now = new Date(2026, 7, 3, 1, 0, 0).getTime(); // next local day
		assert.equal(t.daySpent, 0);
		assert.equal(t.exceeded(), false);
	});
});

describe("sumDaySpendFromLog", () => {
	const localNoonIso = (y: number, m: number, d: number): string => new Date(y, m, d, 12, 0, 0).toISOString();

	function withTempLog(lines: string[], run: (path: string) => void): void {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-daylog-"));
		const path = join(dir, "pelaggio-log.jsonl");
		writeFileSync(path, lines.join("\n"));
		try {
			run(path);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("sums only today's total_cost", () => {
		const now = new Date(2026, 7, 2, 12, 0, 0).getTime();
		const lines = [
			JSON.stringify({ ts: localNoonIso(2026, 7, 2), total_cost: 1.5 }),
			JSON.stringify({ ts: localNoonIso(2026, 7, 2), total_cost: 2.25 }),
			JSON.stringify({ ts: localNoonIso(2026, 7, 1), total_cost: 4 }), // yesterday
			JSON.stringify({ ts: localNoonIso(2026, 7, 3), total_cost: 8 }), // tomorrow
		];
		withTempLog(lines, (path) => {
			assert.equal(sumDaySpendFromLog(path, now), 3.75);
		});
	});

	it("missing file → 0", () => {
		assert.equal(sumDaySpendFromLog(join(tmpdir(), "pelaggio-does-not-exist-daylog.jsonl"), Date.parse("2026-08-02T12:00:00Z")), 0);
	});

	// "absent" and "unreadable" are different facts and only the first means zero: swallowing a
	// read fault would seed the tracker at $0 and hand a restart a second full daily budget.
	// A directory at the ledger path exists but always fails readFileSync (EISDIR) — portable,
	// unlike chmod, which a root-running CI ignores.
	it("existing but unreadable ledger → throws rather than seeding $0", () => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-daylog-unreadable-"));
		const path = join(dir, "pelaggio-log.jsonl");
		mkdirSync(path);
		try {
			assert.throws(() => sumDaySpendFromLog(path, Date.parse("2026-08-02T12:00:00Z")), /could not be read/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// `existsSync` cannot distinguish absent from unreadable — it returns false when a parent
	// directory denies traversal — so gating the read on it routed EACCES into the absent→0 path.
	// Only ENOENT may mean zero; every other errno must throw.
	it("unreadable parent directory → throws, not $0", () => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-daylog-noaccess-"));
		const sub = join(dir, "locked");
		mkdirSync(sub);
		const path = join(sub, "pelaggio-log.jsonl");
		writeFileSync(path, "");
		chmodSync(sub, 0o000);
		try {
			if (process.getuid?.() === 0) return; // root ignores the mode bits
			assert.equal(existsSync(path), false, "precondition: existsSync hides the permission fault");
			assert.throws(() => sumDaySpendFromLog(path, Date.parse("2026-08-02T12:00:00Z")), /could not be read/);
		} finally {
			chmodSync(sub, 0o700);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Overflow is a fail-open in disguise: Infinity trips DayBudgetTracker's isFinite guard,
	// which converts it to 0 and grants a fresh full budget.
	it("accumulator overflow → throws rather than seeding a non-finite total", () => {
		const now = new Date(2026, 7, 2, 12, 0, 0).getTime();
		const row = (c: string) => JSON.stringify({ ts: new Date(2026, 7, 2, 12, 0, 0).toISOString(), total_cost: Number(c) });
		withTempLog([row("1e308"), row("1e308")], (path) => {
			assert.throws(() => sumDaySpendFromLog(path, now), /non-finite/);
		});
	});

	it("empty file → 0", () => {
		const now = new Date(2026, 7, 2, 12, 0, 0).getTime();
		withTempLog([""], (path) => {
			assert.equal(sumDaySpendFromLog(path, now), 0);
		});
	});

	it("skips malformed lines and missing/non-numeric/non-positive costs", () => {
		const now = new Date(2026, 7, 2, 12, 0, 0).getTime();
		const lines = [
			"not json",
			JSON.stringify({ ts: localNoonIso(2026, 7, 2) }), // no total_cost
			JSON.stringify({ ts: localNoonIso(2026, 7, 2), total_cost: "5" }), // string cost
			JSON.stringify({ ts: localNoonIso(2026, 7, 2), total_cost: Number.POSITIVE_INFINITY }), // serializes to null
			JSON.stringify({ total_cost: 9 }), // no ts
			JSON.stringify({ ts: "not-a-date", total_cost: 3 }),
			JSON.stringify({ ts: localNoonIso(2026, 7, 2), total_cost: -2 }), // negative
			JSON.stringify({ ts: localNoonIso(2026, 7, 2), total_cost: 2 }), // the only valid today line
		];
		withTempLog(lines, (path) => {
			assert.equal(sumDaySpendFromLog(path, now), 2);
		});
	});

	it("includes budgetCharge marker rows (they carry ts + total_cost)", () => {
		const now = new Date(2026, 7, 2, 12, 0, 0).getTime();
		const lines = [JSON.stringify({ ts: localNoonIso(2026, 7, 2), total_cost: 1, budgetCharge: true, steps: [] }), JSON.stringify({ ts: localNoonIso(2026, 7, 2), total_cost: 2 })];
		withTempLog(lines, (path) => {
			assert.equal(sumDaySpendFromLog(path, now), 3);
		});
	});
});

describe("dayKey", () => {
	it("formats YYYY-MM-DD", () => {
		// Use local noon to avoid timezone edge cases around midnight.
		const d = new Date(2026, 7, 2, 12, 0, 0); // month is 0-indexed
		assert.equal(dayKey(d.getTime()), "2026-08-02");
	});
});

describe("nextLocalMidnightMs", () => {
	it("returns the next local midnight after the given instant", () => {
		const now = new Date(2026, 7, 2, 15, 30, 0).getTime();
		const midnight = nextLocalMidnightMs(now);
		const d = new Date(midnight);
		assert.equal(d.getFullYear(), 2026);
		assert.equal(d.getMonth(), 7);
		assert.equal(d.getDate(), 3);
		assert.equal(d.getHours(), 0);
		assert.equal(d.getMinutes(), 0);
		assert.ok(midnight > now);
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
