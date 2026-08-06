import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reduce, renderDashboard, renderJson } from "../stats.js";
import type { CycleLogEntry, StepLog } from "../types.js";

function mkStep(partial: Partial<StepLog> & { name: string }): StepLog {
	return {
		model: "m",
		cost: 0,
		turns: 0,
		ok: true,
		...partial,
	};
}

function mkEntry(partial: Partial<CycleLogEntry> & { cycle: number }): CycleLogEntry {
	return {
		ts: "2026-04-17T12:00:00.000Z",
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

describe("reduce — empty log", () => {
	it("returns zeroed stats with no NaN", () => {
		const s = reduce([]);
		assert.equal(s.totalCycles, 0);
		assert.equal(s.completedCycles, 0);
		assert.equal(s.failedCycles, 0);
		assert.equal(s.parkedCycles, 0);
		assert.equal(s.shipwreckedCycles, 0);
		assert.equal(s.totalCostUsd, 0);
		assert.equal(s.cacheHitRatio, 0);
		assert.equal(s.avgShakedownIterations, 0);
		assert.deepEqual(s.totalTokens, { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
		assert.deepEqual(s.itemsDelivered, []);
	});
});

describe("reduce — single completed cycle", () => {
	it("aggregates totals and computes cache ratio", () => {
		const entry = mkEntry({
			cycle: 1,
			item: "TOOL-1",
			completed: true,
			total_cost: 1.25,
			steps: [
				mkStep({ name: "pick", cost: 0.1, tokens: { input: 100, output: 200, cacheCreation: 300, cacheRead: 400 } }),
				mkStep({ name: "implement", cost: 1.0, tokens: { input: 500, output: 1000, cacheCreation: 0, cacheRead: 1500 } }),
				mkStep({ name: "ship", cost: 0.15, tokens: { input: 50, output: 25, cacheCreation: 0, cacheRead: 75 } }),
			],
		});
		const s = reduce([entry]);
		assert.equal(s.totalCycles, 1);
		assert.equal(s.completedCycles, 1);
		assert.equal(s.failedCycles, 0);
		assert.equal(s.totalCostUsd, 1.25);
		assert.equal(s.totalTokens.input, 650);
		assert.equal(s.totalTokens.output, 1225);
		assert.equal(s.totalTokens.cacheCreation, 300);
		assert.equal(s.totalTokens.cacheRead, 1975);
		assert.ok(Math.abs(s.cacheHitRatio - 1975 / (650 + 1975)) < 1e-9);
		assert.equal(s.avgRetriesByStep.implement, 0);
		assert.equal(s.itemsDelivered.length, 1);
		assert.equal(s.itemsDelivered[0].id, "TOOL-1");
		assert.equal(s.itemsDelivered[0].rethinks, 0);
		assert.equal(s.itemsDelivered[0].parked, false);
	});
});

describe("reduce — estimated cost (#80)", () => {
	it("flags estimated totals/steps and renders them with a ~ prefix", () => {
		const estimated = mkEntry({
			cycle: 1,
			item: "TOOL-1",
			completed: true,
			total_cost: 0.5,
			costEstimated: true,
			steps: [mkStep({ name: "implement", cost: 0.5, costEstimated: true, tokens: { input: 10, output: 20, cacheCreation: 0, cacheRead: 5 } })],
		});
		const real = mkEntry({ cycle: 2, item: "TOOL-2", completed: true, total_cost: 1.0, steps: [mkStep({ name: "ship", cost: 1.0 })] });

		const s = reduce([estimated, real]);
		assert.equal(s.costEstimated, true, "any estimated cycle marks the aggregate");
		assert.equal(s.costEstimatedByStep.implement, true);
		assert.notEqual(s.costEstimatedByStep.ship, true, "a billed-USD step is not marked estimated");

		const dash = renderDashboard(s);
		assert.match(dash, /~\$1\.50/, "total spend rendered with ~ when it includes estimates");
	});

	it("does not mark a pure billed-USD run as estimated", () => {
		const s = reduce([mkEntry({ cycle: 1, completed: true, total_cost: 2.0, steps: [mkStep({ name: "ship", cost: 2.0 })] })]);
		assert.equal(s.costEstimated, false);
		assert.doesNotMatch(renderDashboard(s), /~\$/);
	});
});

describe("reduce — retries via attempt field", () => {
	it("computes avgRetriesByStep from max(attempt)-1 per cycle", () => {
		const entry = mkEntry({
			cycle: 1,
			item: "TOOL-2",
			completed: true,
			steps: [mkStep({ name: "implement", attempt: 1, ok: false }), mkStep({ name: "implement", attempt: 2, ok: true }), mkStep({ name: "shakedown-plan", verdict: "APPROVE" })],
		});
		const s = reduce([entry]);
		assert.equal(s.avgRetriesByStep.implement, 1);
		// shakedown-plan had attempt=1 (default), so retries = 0
		assert.equal(s.avgRetriesByStep["shakedown-plan"], 0);
	});
});

describe("reduce — turn-exhaustion retries", () => {
	it("counts retriedMaxTurns per step into maxTurnsRetriesByStep", () => {
		const entry1 = mkEntry({
			cycle: 1,
			item: "TOOL-4",
			completed: true,
			steps: [mkStep({ name: "implement", attempt: 1, ok: false }), mkStep({ name: "implement", attempt: 2, retriedMaxTurns: true, ok: true }), mkStep({ name: "shakedown-code", ok: true })],
		});
		const entry2 = mkEntry({
			cycle: 2,
			item: "TOOL-5",
			completed: true,
			steps: [mkStep({ name: "plan", attempt: 2, retriedMaxTurns: true, ok: true }), mkStep({ name: "shakedown-code", attempt: 2, retriedMaxTurns: true, ok: true })],
		});
		const s = reduce([entry1, entry2]);
		assert.equal(s.maxTurnsRetriesByStep.implement, 1);
		assert.equal(s.maxTurnsRetriesByStep.plan, 1);
		assert.equal(s.maxTurnsRetriesByStep["shakedown-code"], 1);
	});

	it("omits steps that never retried on turn exhaustion (edit-loop retries excluded)", () => {
		const entry = mkEntry({
			cycle: 1,
			item: "TOOL-6",
			completed: true,
			// attempt 2 without retriedMaxTurns models an edit_loop retry — not counted.
			steps: [mkStep({ name: "implement", attempt: 1, ok: false }), mkStep({ name: "implement", attempt: 2, ok: true })],
		});
		const s = reduce([entry]);
		assert.equal(s.maxTurnsRetriesByStep.implement, undefined);
	});
});

describe("reduce — parked cycle", () => {
	it("counts parked and excludes non-completed from itemsDelivered", () => {
		const entry = mkEntry({
			cycle: 1,
			item: "TOOL-3",
			completed: false,
			parked: true,
			parkReason: "5h",
			error: "parked",
		});
		const s = reduce([entry]);
		assert.equal(s.parkedCycles, 1);
		assert.equal(s.completedCycles, 0);
		assert.equal(s.itemsDelivered.length, 0);
	});

	it("keeps parked cycles out of failedCycles — a park is a checkpoint, not a failure", () => {
		const parkedEntry = mkEntry({ cycle: 1, item: "A", completed: false, parked: true, error: "parked" });
		const failedEntry = mkEntry({ cycle: 2, item: "B", completed: false, steps: [mkStep({ name: "implement", ok: false })] });
		const doneEntry = mkEntry({ cycle: 3, item: "C", completed: true });
		const s = reduce([parkedEntry, failedEntry, doneEntry]);
		assert.equal(s.parkedCycles, 1);
		assert.equal(s.failedCycles, 1);
		assert.equal(s.completedCycles, 1);
		// The three buckets partition the cycle set exactly once.
		assert.equal(s.completedCycles + s.failedCycles + s.parkedCycles, s.totalCycles);
	});

	it("groups parks by class and files unclassified legacy records under `unrecorded`", () => {
		const legacy = mkEntry({ cycle: 1, completed: false, parked: true, error: "parked" });
		const reviewBlocked = mkEntry({ cycle: 2, completed: false, parked: true, error: "parked", parkClass: "review-blocked" });
		const alsoBlocked = mkEntry({ cycle: 3, completed: false, parked: true, error: "parked", parkClass: "review-blocked" });
		const rateLimited = mkEntry({ cycle: 4, completed: false, parked: true, error: "parked", parkClass: "rate-limit" });
		const s = reduce([legacy, reviewBlocked, alsoBlocked, rateLimited]);
		assert.deepEqual(s.parksByClass, { unrecorded: 1, "review-blocked": 2, "rate-limit": 1 });
	});
});

describe("reduce — failure attribution", () => {
	it("attributes a failed cycle to its failing step", () => {
		const entry = mkEntry({
			cycle: 1,
			completed: false,
			steps: [mkStep({ name: "plan", ok: true }), mkStep({ name: "implement", ok: false })],
		});
		const s = reduce([entry]);
		assert.deepEqual(s.failuresByCause, { implement: 1 });
	});

	it("files a failed cycle with no failing step and no error under `unattributed`", () => {
		const s = reduce([mkEntry({ cycle: 1, completed: false, steps: [] })]);
		assert.deepEqual(s.failuresByCause, { unattributed: 1 });
	});

	it("attributes guard rejections to the stable error prefix, not one bucket", () => {
		const entries = [
			mkEntry({ cycle: 1, completed: false, error: "pick:worktree-exists" }),
			mkEntry({ cycle: 2, completed: false, error: "pick:diverted" }),
			mkEntry({ cycle: 3, completed: false, error: "plan needs rethink" }),
			// Variable trailing detail must not fragment the grouping.
			mkEntry({ cycle: 4, completed: false, error: "nothing to ship: branch only touches docs/plans/" }),
			mkEntry({ cycle: 5, completed: false, error: "nothing to ship: some other detail entirely" }),
		];
		const s = reduce(entries);
		assert.deepEqual(s.failuresByCause, { pick: 2, "plan needs rethink": 1, "nothing to ship": 2 });
	});

	it("prefers the failing step over the cycle error when both are present", () => {
		const entry = mkEntry({ cycle: 1, completed: false, error: "implement failed", steps: [mkStep({ name: "implement", ok: false })] });
		assert.deepEqual(reduce([entry]).failuresByCause, { implement: 1 });
	});
});

describe("reduce — provider attribution", () => {
	it("splits cost, steps and tokens across the realized drivers", () => {
		const entry = mkEntry({
			cycle: 1,
			completed: true,
			steps: [
				mkStep({ name: "implement", provider: "codex", cost: 10, tokens: { input: 100, output: 10, cacheCreation: 0, cacheRead: 0 } }),
				mkStep({ name: "shakedown-code", provider: "claude", cost: 4, tokens: { input: 20, output: 2, cacheCreation: 0, cacheRead: 0 } }),
				mkStep({ name: "plan", provider: "codex", cost: 6, tokens: { input: 50, output: 5, cacheCreation: 0, cacheRead: 0 } }),
			],
		});
		const s = reduce([entry]);
		assert.equal(s.costByProvider.codex, 16);
		assert.equal(s.costByProvider.claude, 4);
		assert.equal(s.stepsByProvider.codex, 2);
		assert.equal(s.stepsByProvider.claude, 1);
		assert.equal(s.tokensByProvider.codex.input, 150);
		assert.equal(s.tokensByProvider.claude.input, 20);
	});

	it("attributes provider-less legacy steps to `unattributed` rather than a real driver", () => {
		const entry = mkEntry({ cycle: 1, completed: true, steps: [mkStep({ name: "implement", cost: 7 })] });
		const s = reduce([entry]);
		assert.equal(s.costByProvider.unattributed, 7);
		assert.equal(s.costByProvider.codex, undefined);
		assert.equal(s.costByProvider.claude, undefined);
	});

	it("marks a provider's cost estimated when any of its steps was estimated", () => {
		const entry = mkEntry({
			cycle: 1,
			completed: true,
			steps: [mkStep({ name: "implement", provider: "codex", cost: 5, costEstimated: true }), mkStep({ name: "ship", provider: "claude", cost: 1 })],
		});
		const s = reduce([entry]);
		assert.equal(s.costEstimatedByProvider.codex, true);
		assert.equal(s.costEstimatedByProvider.claude, undefined);
	});
});

describe("reduce — shipwreck cycle", () => {
	it("increments shipwreckedCycles regardless of completion", () => {
		const entry1 = mkEntry({ cycle: 1, item: "A", completed: true, shipwrecked: true });
		const entry2 = mkEntry({ cycle: 2, item: "B", completed: false, shipwrecked: true });
		const s = reduce([entry1, entry2]);
		assert.equal(s.shipwreckedCycles, 2);
		assert.equal(s.completedCycles, 1);
	});
});

describe("reduce — RETHINK verdict", () => {
	it("increments rethinkRate and item rethink counter", () => {
		const approve = mkEntry({
			cycle: 1,
			item: "A",
			completed: true,
			steps: [mkStep({ name: "shakedown-plan", verdict: "APPROVE" })],
		});
		const rethink = mkEntry({
			cycle: 2,
			item: "B",
			completed: true,
			steps: [mkStep({ name: "shakedown-plan", verdict: "RETHINK" })],
		});
		const s = reduce([approve, rethink]);
		assert.equal(s.rethinkRateByStep["shakedown-plan"], 0.5);
		const itemB = s.itemsDelivered.find((i) => i.id === "B")!;
		assert.equal(itemB.rethinks, 1);
	});
});

describe("reduce — legacy entry without tokens", () => {
	it("treats missing tokens as zero and does not crash", () => {
		const entry = mkEntry({
			cycle: 1,
			item: "OLD",
			completed: true,
			steps: [mkStep({ name: "pick", cost: 0.05 })],
		});
		const s = reduce([entry]);
		assert.equal(s.totalTokens.input, 0);
		assert.equal(s.totalTokens.cacheRead, 0);
		assert.equal(s.cacheHitRatio, 0);
	});
});

describe("reduce — recentFailures basics", () => {
	it("returns 5 newest-first from 7 failed entries with distinct timestamps", () => {
		const entries: CycleLogEntry[] = [];
		for (let i = 1; i <= 7; i++) {
			entries.push(
				mkEntry({
					cycle: i,
					item: `F-${i}`,
					completed: false,
					error: `err${i}`,
					ts: `2026-04-${String(10 + i).padStart(2, "0")}T12:00:00.000Z`,
				}),
			);
		}
		const s = reduce(entries);
		assert.equal(s.recentFailures.length, 5);
		assert.equal(s.recentFailures[0].item, "F-7");
		assert.equal(s.recentFailures[4].item, "F-3");
	});
});

describe("reduce — recentFailures outputTail sourcing", () => {
	it("surfaces outputTail from the last step when present", () => {
		const entry = mkEntry({
			cycle: 1,
			item: "F-A",
			completed: false,
			error: "implement failed",
			steps: [mkStep({ name: "implement", ok: false, outputTail: "TypeError at line 42" })],
		});
		const s = reduce([entry]);
		assert.equal(s.recentFailures[0].outputTail, "TypeError at line 42");
	});

	it("omits outputTail when last step has none", () => {
		const entry = mkEntry({
			cycle: 1,
			item: "F-B",
			completed: false,
			error: "plan failed",
			steps: [mkStep({ name: "plan", ok: false })],
		});
		const s = reduce([entry]);
		assert.ok(!("outputTail" in s.recentFailures[0]));
	});
});

describe("reduce — recentFailures excludes completed", () => {
	it("filters only completed=false entries", () => {
		const entries: CycleLogEntry[] = [
			mkEntry({ cycle: 1, item: "OK1", completed: true }),
			mkEntry({ cycle: 2, item: "BAD1", completed: false, error: "x" }),
			mkEntry({ cycle: 3, item: "OK2", completed: true }),
			mkEntry({ cycle: 4, item: "BAD2", completed: false, error: "y" }),
		];
		const s = reduce(entries);
		assert.equal(s.recentFailures.length, 2);
		assert.deepEqual(
			s.recentFailures.map((f) => f.item),
			["BAD2", "BAD1"],
		);
	});
});

describe("reduce — recentFailures legacy entries", () => {
	it("does not stringify undefined outputTail on legacy steps", () => {
		const entry = mkEntry({
			cycle: 1,
			item: "LEG",
			completed: false,
			error: "old failure",
			steps: [mkStep({ name: "implement", ok: false })],
		});
		const s = reduce([entry]);
		const f = s.recentFailures[0];
		assert.ok(!("outputTail" in f));
	});
});

describe("renderJson round-trip", () => {
	it("JSON.parse(renderJson(stats)) equals the stats object", () => {
		const entries: CycleLogEntry[] = [
			mkEntry({ cycle: 1, item: "A", completed: true, total_cost: 0.5 }),
			mkEntry({ cycle: 2, item: "B", completed: false, error: "failed", steps: [mkStep({ name: "implement", ok: false, outputTail: "boom" })] }),
		];
		const stats = reduce(entries);
		const parsed = JSON.parse(renderJson(stats));
		assert.deepEqual(parsed, stats);
		assert.equal(parsed.totalCycles, 2);
		assert.equal(parsed.recentFailures.length, 1);
		assert.equal(parsed.recentFailures[0].outputTail, "boom");
	});
});

describe("reduce — mixed legacy and new entries", () => {
	it("aggregates only present fields, counts all cycles", () => {
		const legacy = mkEntry({
			cycle: 1,
			item: "L",
			completed: true,
			total_cost: 0.5,
			steps: [mkStep({ name: "pick", cost: 0.5 })],
		});
		const modern = mkEntry({
			cycle: 2,
			item: "M",
			completed: true,
			total_cost: 1.0,
			steps: [mkStep({ name: "pick", cost: 1.0, tokens: { input: 100, output: 100, cacheCreation: 0, cacheRead: 0 } })],
		});
		const s = reduce([legacy, modern]);
		assert.equal(s.totalCycles, 2);
		assert.equal(s.completedCycles, 2);
		assert.equal(s.totalCostUsd, 1.5);
		assert.equal(s.totalTokens.input, 100);
		assert.equal(s.totalTokens.output, 100);
	});
});
