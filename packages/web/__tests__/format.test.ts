import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDate, formatDuration, formatTokens, formatUsd, statusBadgeClass } from "../src/lib/format.js";

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

describe("statusBadgeClass", () => {
	it("returns a string class for every known status", () => {
		for (const s of ["running", "completed", "failed", "parked", "paused", "abandoned"] as const) {
			assert.match(statusBadgeClass(s), /rounded/);
		}
	});
});
