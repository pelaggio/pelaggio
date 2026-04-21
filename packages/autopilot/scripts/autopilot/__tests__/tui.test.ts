import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { A, computeTuiEnabled, createStepRenderer, LiveStatus, Spinner, StatusBar } from "../tui.js";
import type { CycleStatus } from "../types.js";

function captureStderr(): { chunks: string[]; restore: () => void } {
	const chunks: string[] = [];
	const orig = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stderr.write;
	const restore = (): void => {
		process.stderr.write = orig;
	};
	return { chunks, restore };
}

describe("computeTuiEnabled", () => {
	it("env override wins over isTTY", () => {
		assert.equal(computeTuiEnabled({ CLAUDE_AUTOPILOT_PLAIN: "1" }, { isTTY: true }), false);
	});
	it("isTTY true with no override enables tui", () => {
		assert.equal(computeTuiEnabled({}, { isTTY: true }), true);
	});
	it("isTTY false disables tui", () => {
		assert.equal(computeTuiEnabled({}, { isTTY: false }), false);
	});
	it("CLAUDE_AUTOPILOT_PLAIN=0 does not disable (only exact '1')", () => {
		assert.equal(computeTuiEnabled({ CLAUDE_AUTOPILOT_PLAIN: "0" }, { isTTY: true }), true);
	});
});

describe("A rewire (module-init plain mode under node:test non-TTY)", () => {
	it("color wrappers pass strings through unchanged", () => {
		assert.equal(A.bold("x"), "x");
		assert.equal(A.cyan("y"), "y");
	});
	it("cursor/clear strings are empty", () => {
		assert.equal(A.clearLine, "");
		assert.equal(A.hideCursor, "");
		assert.equal(A.showCursor, "");
	});
});

describe("StatusBar plain mode", () => {
	it("setup/update/teardown write nothing and active stays false", () => {
		const { chunks, restore } = captureStderr();
		try {
			const bar = new StatusBar({ plain: true });
			bar.setup(2);
			bar.update(["hello"]);
			bar.teardown();
			assert.equal(chunks.join(""), "");
			assert.equal(bar.active, false);
		} finally {
			restore();
		}
	});
});

describe("Spinner plain mode", () => {
	it("start/stop with or without final line write nothing", () => {
		const { chunks, restore } = captureStderr();
		try {
			const sp = new Spinner(null, { plain: true });
			sp.start("working…");
			sp.stop();
			sp.stop("▸ done");
			assert.equal(chunks.join(""), "");
			assert.equal(sp.active, false);
		} finally {
			restore();
		}
	});
});

describe("createStepRenderer plain mode", () => {
	it("emits ANSI-stripped single-line events to stderr matching the file-log shape", () => {
		const { chunks, restore } = captureStderr();
		try {
			const statusBar = new StatusBar({ plain: true });
			const liveStatus = new LiveStatus(statusBar);
			const ws: CycleStatus = { itemId: "TOOL-1", status: "running", cost: 0 };
			const emit = createStepRenderer({
				verbose: true,
				trace: false,
				toFile: false,
				plain: true,
				liveStatus,
				workerStatus: ws,
			});

			emit({ type: "step_header", name: "plan", model: "claude-opus-4-7", budget: 1.5, maxTurns: 12, prompt: "" });
			emit({ type: "tool_use", name: "Edit", brief: "foo.ts", mutating: true });
			emit({ type: "tool_use", name: "Grep", brief: "needle", mutating: false });
			emit({ type: "done", ok: true, subtype: "end_turn", cost: 0.42, turns: 3, elapsed: 1000 });

			const out = chunks.join("");
			assert.equal(out.includes("\x1b"), false, "no ANSI escapes");
			assert.equal(out.includes("\r"), false, "no carriage returns");
			assert.ok(out.includes("── plan ──"), "header");
			assert.ok(out.includes("   ▸ Editing foo.ts"), "mutating tool line");
			assert.ok(out.includes("   · Searching needle"), "non-mutating tool line");
			assert.ok(out.includes("   ✓ done"), "done marker");
			assert.ok(out.includes("$0.42"), "cost");
		} finally {
			restore();
		}
	});
});
