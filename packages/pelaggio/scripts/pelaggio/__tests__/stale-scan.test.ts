import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanStaleItems } from "../roadmap/stale-scan.js";
import type { RoadmapItemStatus } from "../roadmap/types.js";

function item(overrides: Partial<RoadmapItemStatus> = {}): RoadmapItemStatus {
	return { id: "111", title: "Make confinement independent of the harness", deps: "—", sourceRef: "acme#111", status: "open", ...overrides };
}

function scan(items: readonly RoadmapItemStatus[], log: string): ReturnType<typeof scanStaleItems> {
	return scanStaleItems(items, "/repo", { gitLogMain: () => log });
}

describe("scanStaleItems — shipped-by-commit", () => {
	it("does not fire when only a different id is completed", () => {
		assert.deepEqual(scan([item()], "abc1234 fix confinement (#105)"), []);
	});

	it("fires on a conventional merge trailer (#N) with the commit as evidence", () => {
		const hits = scan([item()], "2ad0ba0 make confinement independent (#111)\nabc1234 unrelated");
		assert.equal(hits.length, 1);
		assert.equal(hits[0]?.id, "111");
		assert.equal(hits[0]?.reason, "shipped-by-commit");
		assert.ok(hits[0]?.evidence.some((e) => e.includes("2ad0ba0")));
	});

	it("fires on closes/fixes/resolves keywords", () => {
		assert.equal(scan([item()], "deadbee closes #111")[0]?.reason, "shipped-by-commit");
		assert.equal(scan([item()], "deadbee fixes 111")[0]?.reason, "shipped-by-commit");
		assert.equal(scan([item()], "deadbee resolves #111")[0]?.reason, "shipped-by-commit");
	});

	it("fires on a numeric feat/issue branch subject", () => {
		assert.equal(scan([item()], "deadbee Merge feat/issue-111 into main")[0]?.reason, "shipped-by-commit");
	});

	it("requires a completion verb for a bare issue-N mention", () => {
		assert.deepEqual(scan([item()], "deadbee mentions issue-111 in passing"), []);
		assert.equal(scan([item()], "deadbee ship issue-111")[0]?.reason, "shipped-by-commit");
	});

	it("does not match a longer id superstring (111 vs 1119)", () => {
		assert.deepEqual(scan([item()], "deadbee closes #1119"), []);
	});

	it("supports markdown ids via closes keyword", () => {
		const md = item({ id: "TOOL-11", title: "Refit the split logic across adapters" });
		assert.equal(scan([md], "deadbee closes TOOL-11")[0]?.reason, "shipped-by-commit");
	});
});

describe("scanStaleItems — superseded-marker", () => {
	it("fires when the body says done by a done sibling", () => {
		const items = [item({ body: "Already done by #105." }), item({ id: "105", title: "Confinement work", status: "done" })];
		const hits = scan(items, "");
		assert.equal(hits.length, 1);
		assert.equal(hits[0]?.id, "111");
		assert.equal(hits[0]?.reason, "superseded-marker");
		assert.ok(hits[0]?.evidence.includes("105"));
	});

	it("does not fire when the referenced sibling is not done", () => {
		const items = [item({ body: "Superseded by #105" }), item({ id: "105", title: "Still open work", status: "open" })];
		assert.deepEqual(scan(items, ""), []);
	});
});

describe("scanStaleItems — title-match-done", () => {
	it("fires when a long title equals a done sibling's title", () => {
		const items = [item({ id: "200", title: "Roadmap staleness sweep for open items" }), item({ id: "150", title: "Roadmap staleness sweep for open items", status: "done" })];
		const hits = scan(items, "");
		assert.equal(hits.length, 1);
		assert.equal(hits[0]?.id, "200");
		assert.equal(hits[0]?.reason, "title-match-done");
		assert.deepEqual(hits[0]?.evidence, ["150"]);
	});

	it("ignores a trailing issue-number / parenthetical suffix when comparing", () => {
		const items = [item({ id: "200", title: "Roadmap staleness sweep (#200)" }), item({ id: "150", title: "Roadmap staleness sweep", status: "done" })];
		assert.equal(scan(items, "")[0]?.reason, "title-match-done");
	});

	it("does not fire for a short title", () => {
		const items = [item({ id: "200", title: "fix" }), item({ id: "150", title: "fix", status: "done" })];
		assert.deepEqual(scan(items, ""), []);
	});
});

describe("scanStaleItems — status gating", () => {
	it("never fires for done, blocked, or in-progress items", () => {
		const items = [item({ id: "1", status: "done" }), item({ id: "2", status: "blocked" }), item({ id: "3", status: "in-progress" })];
		assert.deepEqual(scan(items, "deadbee closes #1\ndeadbee closes #2\ndeadbee closes #3"), []);
	});

	it("returns [] when there are no open items without invoking git", () => {
		let called = false;
		const hits = scanStaleItems([item({ status: "done" })], "/repo", {
			gitLogMain: () => {
				called = true;
				return "";
			},
		});
		assert.deepEqual(hits, []);
		assert.equal(called, false);
	});
});
