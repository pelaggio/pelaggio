import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCli } from "../cli.js";

describe("parseCli", () => {
	it("returns run with empty flags for no args", () => {
		const intent = parseCli([]);
		assert.equal(intent.kind, "run");
		if (intent.kind !== "run") return;
		assert.equal(intent.flags.cycles, "1");
		assert.equal(intent.flags.parallel, "1");
	});

	it("returns run with parsed flags", () => {
		const intent = parseCli(["--cycles", "2", "--parallel", "3", "--verbose"]);
		assert.equal(intent.kind, "run");
		if (intent.kind !== "run") return;
		assert.equal(intent.flags.cycles, "2");
		assert.equal(intent.flags.parallel, "3");
		assert.equal(intent.flags.verbose, true);
	});

	it("parses `--resume X --from implement`", () => {
		const intent = parseCli(["--resume", "X", "--from", "implement"]);
		assert.equal(intent.kind, "run");
		if (intent.kind !== "run") return;
		assert.equal(intent.flags.resume, "X");
		assert.equal(intent.flags.from, "implement");
	});

	it("returns stats for `stats`", () => {
		const intent = parseCli(["stats"]);
		assert.deepEqual(intent, { kind: "stats", json: false });
	});

	it("returns stats with json for `stats --json`", () => {
		const intent = parseCli(["stats", "--json"]);
		assert.deepEqual(intent, { kind: "stats", json: true });
	});

	it("returns error for `stats <extra>`", () => {
		const intent = parseCli(["stats", "extra"]);
		assert.equal(intent.kind, "error");
		if (intent.kind !== "error") return;
		assert.equal(intent.exitCode, 2);
		assert.match(intent.message, /extra args after 'stats'/);
	});

	it("returns error for the recursion-shaped invocation", () => {
		const intent = parseCli(["roadmap", "get", "TOOL-1", "--json"]);
		assert.equal(intent.kind, "error");
		if (intent.kind !== "error") return;
		assert.equal(intent.exitCode, 2);
		assert.match(intent.message, /unknown positional args/);
		assert.match(intent.message, /roadmap/);
		assert.match(intent.message, /@cdhorne\/claude-autopilot roadmap get TOOL-1/);
		assert.match(intent.message, /TOOL-50/);
	});

	it("returns error for a single unknown positional", () => {
		const intent = parseCli(["pickle"]);
		assert.equal(intent.kind, "error");
		if (intent.kind !== "error") return;
		assert.match(intent.message, /unknown positional args/);
		assert.match(intent.message, /pickle/);
	});

	it("returns error from parseArgs failure (unknown flag)", () => {
		const intent = parseCli(["--bogus"]);
		assert.equal(intent.kind, "error");
		if (intent.kind !== "error") return;
		assert.equal(intent.exitCode, 2);
	});
});
