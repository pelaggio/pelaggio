import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fmtWait, formatResumeHint } from "../text.js";

describe("fmtWait", () => {
	it("formats zero as <1m", () => {
		assert.equal(fmtWait(0), "<1m");
	});

	it("formats exactly 1 minute", () => {
		assert.equal(fmtWait(60_000), "1m");
	});

	it("formats hours and minutes", () => {
		assert.equal(fmtWait(5_400_000), "1h 30m");
	});

	it("formats exact hours", () => {
		assert.equal(fmtWait(3_600_000), "1h");
	});

	it("formats small durations", () => {
		assert.equal(fmtWait(270_000), "5m");
	});

	it("rounds up partial minutes", () => {
		assert.equal(fmtWait(61_000), "2m");
	});

	it("rounds up 30s to 1m", () => {
		assert.equal(fmtWait(30_000), "1m");
	});

	it("formats negative as <1m", () => {
		assert.equal(fmtWait(-1000), "<1m");
	});
});

describe("formatResumeHint", () => {
	it("emits --resume, not --item (#56: --item is refused by pick's worktree-exists guard)", () => {
		assert.equal(formatResumeHint(["X-1"]), "pnpm pelaggio --resume X-1");
	});

	it("emits one --resume command per id, joined for aligned multi-line display", () => {
		assert.equal(formatResumeHint(["X-1", "X-2"]), "pnpm pelaggio --resume X-1\n          pnpm pelaggio --resume X-2");
	});
});
