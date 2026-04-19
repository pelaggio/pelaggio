import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RoadmapItem } from "../../../../../scripts/check-roadmap.js";
import { buildGraph, emitMermaid, parseDeps, runCli } from "../../../../../scripts/roadmap-graph.js";
import { resolveArtifactRoot } from "../artifact-root.js";

const REPO_ROOT = resolveArtifactRoot(import.meta.url);

function item(id: string, title: string, deps: string, status: "open" | "done" = "open", roadmap = "core"): RoadmapItem {
	return { id, title, deps, status, roadmap };
}

describe("parseDeps", () => {
	it("treats em-dash as empty", () => {
		assert.deepEqual(parseDeps("—"), { ids: [], blockedExternal: false });
	});

	it("treats ASCII dash as empty", () => {
		assert.deepEqual(parseDeps("-"), { ids: [], blockedExternal: false });
	});

	it("treats empty string as empty", () => {
		assert.deepEqual(parseDeps(""), { ids: [], blockedExternal: false });
	});

	it("parses a single TOOL id", () => {
		assert.deepEqual(parseDeps("TOOL-9"), { ids: ["TOOL-9"], blockedExternal: false });
	});

	it("parses a comma-separated list preserving order", () => {
		assert.deepEqual(parseDeps("TOOL-4, TOOL-8"), { ids: ["TOOL-4", "TOOL-8"], blockedExternal: false });
	});

	it("tolerates whitespace", () => {
		assert.deepEqual(parseDeps("  TOOL-4 ,TOOL-8  "), { ids: ["TOOL-4", "TOOL-8"], blockedExternal: false });
	});

	it("detects blocked: prefix", () => {
		assert.deepEqual(parseDeps("blocked: waiting on legal review"), { ids: [], blockedExternal: true });
	});

	it("detects Blocked: case-insensitively", () => {
		assert.deepEqual(parseDeps("Blocked: X"), { ids: [], blockedExternal: true });
	});

	it("silently drops non-TOOL tokens", () => {
		assert.deepEqual(parseDeps("TOOL-4, FOO-1"), { ids: ["TOOL-4"], blockedExternal: false });
	});
});

describe("buildGraph", () => {
	it("marks an item with all-done deps as open", () => {
		const { graph } = buildGraph([item("TOOL-1", "Done one", "—", "done"), item("TOOL-2", "Open two", "TOOL-1")]);
		const n = graph.nodes.find((n) => n.id === "TOOL-2");
		assert.equal(n?.status, "open");
	});

	it("marks an item with an open dep as blocked", () => {
		const { graph } = buildGraph([item("TOOL-1", "Open one", "—"), item("TOOL-2", "Open two", "TOOL-1")]);
		const n = graph.nodes.find((n) => n.id === "TOOL-2");
		assert.equal(n?.status, "blocked");
	});

	it("marks a blocked: prefix as blocked with no edges from it", () => {
		const { graph } = buildGraph([item("TOOL-1", "Ext blocked", "blocked: waiting on vendor")]);
		const n = graph.nodes.find((n) => n.id === "TOOL-1");
		assert.equal(n?.status, "blocked");
		assert.equal(graph.edges.length, 0);
	});

	it("marks a strikethrough row as done regardless of deps", () => {
		const { graph } = buildGraph([item("TOOL-1", "Done thing", "TOOL-99", "done")]);
		const n = graph.nodes.find((n) => n.id === "TOOL-1");
		assert.equal(n?.status, "done");
	});

	it("reports unknown deps without emitting edges", () => {
		const { graph, unknown } = buildGraph([item("TOOL-4", "Item", "TOOL-999")]);
		assert.equal(unknown.length, 1);
		assert.deepEqual(unknown[0], { item: "TOOL-4", unknown: "TOOL-999", roadmap: "core" });
		assert.equal(graph.edges.length, 0);
	});

	it("sorts nodes by numeric suffix", () => {
		const { graph } = buildGraph([item("TOOL-10", "Ten", "—"), item("TOOL-2", "Two", "—"), item("TOOL-1", "One", "—")]);
		assert.deepEqual(
			graph.nodes.map((n) => n.id),
			["TOOL-1", "TOOL-2", "TOOL-10"],
		);
	});

	it("emits one edge per known dep", () => {
		const { graph } = buildGraph([item("TOOL-1", "A", "—", "done"), item("TOOL-2", "B", "—", "done"), item("TOOL-3", "C", "TOOL-1, TOOL-2")]);
		assert.deepEqual(graph.edges, [
			{ from: "TOOL-1", to: "TOOL-3" },
			{ from: "TOOL-2", to: "TOOL-3" },
		]);
	});
});

describe("emitMermaid", () => {
	it("emits an open node as a rectangle", () => {
		const out = emitMermaid({ nodes: [{ id: "TOOL-1", title: "Hello", status: "open", roadmap: "core" }], edges: [] });
		assert.match(out, /TOOL-1\["TOOL-1\. Hello"\]/);
	});

	it("emits a blocked node as rounded", () => {
		const out = emitMermaid({ nodes: [{ id: "TOOL-1", title: "Hello", status: "blocked", roadmap: "core" }], edges: [] });
		assert.match(out, /TOOL-1\("TOOL-1\. Hello"\)/);
	});

	it("emits a done node with :::done class and includes the classDef", () => {
		const out = emitMermaid({ nodes: [{ id: "TOOL-1", title: "Hello", status: "done", roadmap: "core" }], edges: [] });
		assert.match(out, /classDef done stroke-dasharray: 5 5,opacity:0\.6/);
		assert.match(out, /TOOL-1\["TOOL-1\. Hello"\]:::done/);
	});

	it("escapes quotes in titles", () => {
		const out = emitMermaid({ nodes: [{ id: "TOOL-1", title: `quote " inside`, status: "open", roadmap: "core" }], edges: [] });
		assert.match(out, /&quot;/);
		assert.doesNotMatch(out, /" inside"/);
	});

	it("escapes brackets in titles", () => {
		const out = emitMermaid({ nodes: [{ id: "TOOL-1", title: "hello [world]", status: "open", roadmap: "core" }], edges: [] });
		assert.match(out, /&#91;world&#93;/);
	});

	it("collapses newlines in titles to a space", () => {
		const out = emitMermaid({ nodes: [{ id: "TOOL-1", title: "a\nb", status: "open", roadmap: "core" }], edges: [] });
		assert.match(out, /"TOOL-1\. a b"/);
	});

	it("matches a stable snapshot for a small fixture", () => {
		const out = emitMermaid({
			nodes: [
				{ id: "TOOL-1", title: "One", status: "done", roadmap: "core" },
				{ id: "TOOL-2", title: "Two", status: "blocked", roadmap: "core" },
				{ id: "TOOL-3", title: "Three", status: "open", roadmap: "core" },
			],
			edges: [{ from: "TOOL-1", to: "TOOL-3" }],
		});
		assert.equal(
			out,
			`flowchart LR
  classDef done stroke-dasharray: 5 5,opacity:0.6

  TOOL-1["TOOL-1. One"]:::done
  TOOL-2("TOOL-2. Two")
  TOOL-3["TOOL-3. Three"]

  TOOL-1 --> TOOL-3
`,
		);
	});
});

describe("runCli integration", () => {
	it("runs against the real repo and emits flowchart LR to stdout", () => {
		const out = execFileSync("npx", ["tsx", "scripts/roadmap-graph.ts", "--stdout"], { cwd: REPO_ROOT, encoding: "utf8" });
		assert.match(out, /^flowchart LR/);
	});

	it("returns 1 and writes a named error on unknown dep", () => {
		const tmp = mkdtempSync(join(tmpdir(), "roadmap-graph-"));
		mkdirSync(join(tmp, "docs"));
		writeFileSync(join(tmp, "docs", "roadmap-core.md"), `# core\n\n## Progress\n\n| Item | Depends on |\n|------|-----------|\n| TOOL-1. First | TOOL-999 |\n\n---\n`);
		const origErr = process.stderr.write.bind(process.stderr);
		let captured = "";
		(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
			captured += s;
			return true;
		};
		try {
			const code = runCli([], tmp);
			assert.equal(code, 1);
			assert.match(captured, /TOOL-1 \[core\] references unknown dep TOOL-999/);
		} finally {
			(process.stderr as unknown as { write: typeof origErr }).write = origErr;
		}
	});

	it("rejects unknown flags", () => {
		const origErr = process.stderr.write.bind(process.stderr);
		let captured = "";
		(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
			captured += s;
			return true;
		};
		try {
			const code = runCli(["--bogus"], REPO_ROOT);
			assert.equal(code, 1);
			assert.match(captured, /unknown flag: --bogus/);
		} finally {
			(process.stderr as unknown as { write: typeof origErr }).write = origErr;
		}
	});
});
