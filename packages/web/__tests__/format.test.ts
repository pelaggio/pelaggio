import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDate, formatDuration, formatItemId, formatRunState, formatRunTitle, formatTokens, formatUsd, runStateBadgeClass, statusBadgeClass } from "../src/lib/format.js";

describe("formatDate", () => {
	it("returns em-dash on undefined", () => {
		assert.equal(formatDate(undefined), "—");
	});
	it("returns the input when not a parseable date", () => {
		assert.equal(formatDate("not-a-date"), "not-a-date");
	});
	it("renders a parseable ISO string via toLocaleString", () => {
		const out = formatDate("2026-04-19T12:00:00.000Z");
		assert.notEqual(out, "—");
		assert.notEqual(out, "2026-04-19T12:00:00.000Z");
	});
});

describe("formatDuration", () => {
	it("em-dash on negative or non-finite", () => {
		assert.equal(formatDuration(-1), "—");
		assert.equal(formatDuration(Number.NaN), "—");
	});
	it("seconds for sub-minute", () => {
		assert.equal(formatDuration(0), "0s");
		assert.equal(formatDuration(45_000), "45s");
	});
	it("m s for sub-hour", () => {
		assert.equal(formatDuration(75_000), "1m 15s");
	});
	it("h m for over-hour", () => {
		assert.equal(formatDuration(3_600_000 + 5 * 60_000), "1h 5m");
	});
});

describe("formatUsd", () => {
	it("zero is $0.00", () => {
		assert.equal(formatUsd(0), "$0.00");
	});
	it("sub-cent gets 4 decimals", () => {
		assert.equal(formatUsd(0.0042), "$0.0042");
	});
	it("normal gets 2 decimals", () => {
		assert.equal(formatUsd(12.345), "$12.35");
	});
	it("non-finite is em-dash", () => {
		assert.equal(formatUsd(Number.POSITIVE_INFINITY), "—");
	});
});

describe("formatTokens", () => {
	it("raw under 1000", () => assert.equal(formatTokens(999), "999"));
	it("k-suffix under 1M", () => assert.equal(formatTokens(12_500), "12.5k"));
	it("M-suffix at 1M+", () => assert.equal(formatTokens(2_500_000), "2.50M"));
	it("em-dash on negative", () => assert.equal(formatTokens(-1), "—"));
});

describe("formatItemId", () => {
	it("prefixes bare-numeric ids with the repo slug", () => {
		assert.equal(formatItemId("30", "pelaggio"), "pelaggio#30");
	});
	it("leaves ids with their own prefix alone", () => {
		assert.equal(formatItemId("TOOL-47", "pelaggio"), "TOOL-47");
		assert.equal(formatItemId("AGT-1", "trellis-term"), "AGT-1");
	});
	it("returns the id unchanged when no repo is known", () => {
		assert.equal(formatItemId("30", null), "30");
		assert.equal(formatItemId("30", undefined), "30");
	});
});

describe("statusBadgeClass", () => {
	it("returns a string class for every known status", () => {
		for (const s of ["running", "completed", "failed", "parked", "paused", "abandoned"] as const) {
			assert.match(statusBadgeClass(s), /rounded/);
		}
	});
});

describe("formatRunTitle", () => {
	it("uses formatItemId when item is present", () => {
		assert.equal(formatRunTitle({ item: "30", repo: "pelaggio" }), "pelaggio#30");
	});
	it("renders continuous labels without item", () => {
		assert.equal(formatRunTitle({ mode: "drain", parallel: 2, repo: "pelaggio" }), "drain ×2");
		assert.equal(formatRunTitle({ mode: "watch", parallel: 2, repo: "pelaggio" }), "watch ×2");
		assert.equal(formatRunTitle({ mode: "drain", parallel: 1, repo: "pelaggio" }), "drain");
		assert.equal(formatRunTitle({ mode: "drain", repo: "pelaggio" }), "drain");
	});
});

describe("formatRunState", () => {
	it("process status wins when not running", () => {
		assert.equal(formatRunState("paused", { kind: "watch-idle", probeAt: "x" }), "paused");
		assert.equal(formatRunState("completed", { kind: "active" }), "completed");
		assert.equal(formatRunState("parked"), "parked");
	});
	it("decorates running with activity", () => {
		assert.equal(formatRunState("running"), "running");
		assert.equal(formatRunState("running", { kind: "active" }), "running");
		assert.equal(formatRunState("running", { kind: "watch-idle", probeAt: "x" }), "idle (watching)");
		assert.equal(formatRunState("running", { kind: "budget-idle", resumeAt: "x", budget: 1, spent: 1 }), "budget-idled");
		assert.equal(formatRunState("running", { kind: "parked" }), "parked");
	});
	it("formats parked until HH:MM from local ISO", () => {
		const d = new Date(2026, 7, 2, 14, 5, 0);
		const label = formatRunState("running", { kind: "parked", resumeAt: d.toISOString() });
		assert.equal(label, "parked until 14:05");
	});
});

describe("runStateBadgeClass", () => {
	it("returns activity-aware class for running decorations", () => {
		assert.match(runStateBadgeClass("running", { kind: "parked" }), /amber/);
		assert.match(runStateBadgeClass("running", { kind: "watch-idle", probeAt: "x" }), /slate/);
		assert.match(runStateBadgeClass("completed"), /green/);
	});
});
