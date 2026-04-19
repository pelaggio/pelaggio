import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applyFix, deriveFixDeps, findDrift, formatDrift, parseRoadmap, parseTaskIndex } from "../../../../../scripts/check-roadmap.js";
import { resolveArtifactRoot } from "../artifact-root.js";

const REPO_ROOT = resolveArtifactRoot(import.meta.url);

const SAMPLE_ROADMAP = `# Core Roadmap

Some prose before.

## Progress

**Open items:**

| Item | Depends on |
|------|-----------|
| TOOL-1. Consistency check | — |
| TOOL-2. Dep graph | — |
| ~~TOOL-4. Done thing~~ | **Done** — shipped 2026-04-17 |
| TOOL-9. Abstraction | TOOL-4 |

---

## Items

### TOOL-1. Consistency check
blah
`;

const SAMPLE_TASK_INDEX = `# Task Index

Intro text.

## Open items

| ID | Title | Deps | Plan | Roadmap |
|----|-------|------|------|---------|
| TOOL-1 | Consistency check | — | — | core |
| TOOL-2 | Dep graph | — | — | core |
| TOOL-9 | Abstraction | — | — | core |

## Recently completed

- TOOL-4 ✓
`;

describe("parseRoadmap", () => {
	it("extracts open items from the summary table, ignoring prose", () => {
		const items = parseRoadmap(SAMPLE_ROADMAP, "core");
		const open = items.filter((i) => i.status === "open");
		assert.deepEqual(
			open.map((i) => i.id),
			["TOOL-1", "TOOL-2", "TOOL-9"],
		);
	});

	it("marks strikethrough rows as done", () => {
		const items = parseRoadmap(SAMPLE_ROADMAP, "core");
		const done = items.filter((i) => i.status === "done");
		assert.equal(done.length, 1);
		assert.equal(done[0].id, "TOOL-4");
		assert.equal(done[0].title, "Done thing");
	});

	it("captures the Depends on cell verbatim", () => {
		const items = parseRoadmap(SAMPLE_ROADMAP, "core");
		const tool9 = items.find((i) => i.id === "TOOL-9");
		assert.ok(tool9);
		assert.equal(tool9.deps, "TOOL-4");
		const tool1 = items.find((i) => i.id === "TOOL-1");
		assert.equal(tool1?.deps, "—");
	});

	it("returns an empty list when there's no Progress table", () => {
		const items = parseRoadmap("# Roadmap\n\nNo table here.\n", "core");
		assert.deepEqual(items, []);
	});

	it("stops at the --- separator so later tables aren't captured", () => {
		const body = `## Progress

| Item | Depends on |
|------|-----------|
| TOOL-1. A | — |

---

## Details

| Item | Depends on |
|------|-----------|
| TOOL-99. Should not be picked up | — |
`;
		const items = parseRoadmap(body, "core");
		assert.deepEqual(
			items.map((i) => i.id),
			["TOOL-1", "TOOL-99"],
		);
	});

	it("ignores tables whose header isn't Item | Depends on", () => {
		const body = `## Something

| Foo | Bar |
|-----|-----|
| TOOL-1. ignored | — |
`;
		const items = parseRoadmap(body, "core");
		assert.deepEqual(items, []);
	});
});

describe("parseTaskIndex", () => {
	it("extracts rows from the Open items table only", () => {
		const items = parseTaskIndex(SAMPLE_TASK_INDEX);
		assert.deepEqual(
			items.map((i) => i.id),
			["TOOL-1", "TOOL-2", "TOOL-9"],
		);
	});

	it("tolerates extra whitespace in cells", () => {
		const body = `## Open items

| ID | Title | Deps | Plan | Roadmap |
|----|-------|------|------|---------|
|   TOOL-1   |   Consistency check   |   —   |   —   |   core   |
`;
		const items = parseTaskIndex(body);
		assert.equal(items.length, 1);
		assert.equal(items[0].id, "TOOL-1");
		assert.equal(items[0].title, "Consistency check");
		assert.equal(items[0].roadmap, "core");
	});

	it("does not read rows from sections after Open items", () => {
		const body = `## Open items

| ID | Title | Deps | Plan | Roadmap |
|----|-------|------|------|---------|
| TOOL-1 | Real | — | — | core |

## Recently completed

| TOOL-99 | Fake | — | — | core |
`;
		const items = parseTaskIndex(body);
		assert.deepEqual(
			items.map((i) => i.id),
			["TOOL-1"],
		);
	});
});

describe("findDrift", () => {
	const roadmap = parseRoadmap(SAMPLE_ROADMAP, "core");
	const taskIndex = parseTaskIndex(SAMPLE_TASK_INDEX);

	it("reports nothing on identical sets", () => {
		assert.deepEqual(findDrift(roadmap, taskIndex), []);
	});

	it("flags missing-from-index when roadmap has an open item missing from the index", () => {
		const extraRoadmap = parseRoadmap(SAMPLE_ROADMAP.replace("| TOOL-9. Abstraction | TOOL-4 |", "| TOOL-9. Abstraction | TOOL-4 |\n| TOOL-50. New | — |"), "core");
		const drift = findDrift(extraRoadmap, taskIndex);
		assert.equal(drift.length, 1);
		assert.equal(drift[0].kind, "missing-from-index");
		if (drift[0].kind === "missing-from-index") {
			assert.equal(drift[0].item.id, "TOOL-50");
		}
	});

	it("flags missing-from-roadmap when task-index has an unknown ID", () => {
		const extraIndex = parseTaskIndex(SAMPLE_TASK_INDEX.replace("## Recently completed", `| TOOL-77 | Ghost | — | — | core |\n\n## Recently completed`));
		const drift = findDrift(roadmap, extraIndex);
		assert.equal(drift.length, 1);
		assert.equal(drift[0].kind, "missing-from-roadmap");
	});

	it("flags missing-from-roadmap when the only match is a done row", () => {
		const indexWithDone = parseTaskIndex(SAMPLE_TASK_INDEX.replace("## Recently completed", `| TOOL-4 | Done thing | — | — | core |\n\n## Recently completed`));
		const drift = findDrift(roadmap, indexWithDone);
		const missing = drift.filter((d) => d.kind === "missing-from-roadmap");
		assert.equal(missing.length, 1);
	});

	it("flags id-collision when two roadmaps list the same TOOL-N open", () => {
		const a: ReturnType<typeof parseRoadmap> = [{ id: "TOOL-1", title: "A", deps: "—", status: "open", roadmap: "core" }];
		const b: ReturnType<typeof parseRoadmap> = [{ id: "TOOL-1", title: "A", deps: "—", status: "open", roadmap: "experiments" }];
		const drift = findDrift([...a, ...b], []);
		const collision = drift.find((d) => d.kind === "id-collision");
		assert.ok(collision);
		if (collision?.kind === "id-collision") {
			assert.deepEqual(collision.roadmaps.sort(), ["core", "experiments"]);
		}
	});
});

describe("deriveFixDeps", () => {
	it("drops done IDs and preserves open ones", () => {
		const items = parseRoadmap(SAMPLE_ROADMAP, "core");
		assert.equal(deriveFixDeps("TOOL-4, TOOL-9", items), "TOOL-9");
		assert.equal(deriveFixDeps("TOOL-4", items), "—");
		assert.equal(deriveFixDeps("—", items), "—");
	});
});

describe("formatDrift", () => {
	it("produces a readable multi-section report", () => {
		const drift = [
			{
				kind: "missing-from-index" as const,
				item: { id: "TOOL-50", title: "New", deps: "—", status: "open" as const, roadmap: "core" },
			},
			{
				kind: "id-collision" as const,
				id: "TOOL-1",
				roadmaps: ["core", "experiments"],
			},
		];
		const out = formatDrift(drift);
		assert.match(out, /Missing from task-index/);
		assert.match(out, /TOOL-50/);
		assert.match(out, /ID collisions/);
		assert.match(out, /TOOL-1: appears in core, experiments/);
		assert.match(out, /pnpm check:roadmap --fix/);
	});
});

describe("applyFix", () => {
	it("inserts new rows at the end of the Open items table", () => {
		const additions = [
			{
				item: { id: "TOOL-50", title: "New thing", deps: "—", status: "open" as const, roadmap: "core" },
				deps: "—",
			},
		];
		const next = applyFix(SAMPLE_TASK_INDEX, additions);
		const parsed = parseTaskIndex(next);
		const added = parsed.find((i) => i.id === "TOOL-50");
		assert.ok(added);
		assert.equal(added.title, "New thing");
		assert.equal(added.roadmap, "core");
		assert.equal(added.plan, "—");
	});

	it("is a no-op when additions is empty", () => {
		assert.equal(applyFix(SAMPLE_TASK_INDEX, []), SAMPLE_TASK_INDEX);
	});

	it("round-trips through the filesystem", () => {
		const dir = mkdtempSync(join(tmpdir(), "check-roadmap-fix-"));
		const path = join(dir, "task-index.md");
		writeFileSync(path, SAMPLE_TASK_INDEX);
		const additions = [
			{
				item: { id: "TOOL-50", title: "New thing", deps: "TOOL-9", status: "open" as const, roadmap: "core" },
				deps: "TOOL-9",
			},
		];
		writeFileSync(path, applyFix(readFileSync(path, "utf8"), additions));
		const after = parseTaskIndex(readFileSync(path, "utf8"));
		const added = after.find((i) => i.id === "TOOL-50");
		assert.ok(added);
		assert.equal(added.deps, "TOOL-9");
	});
});

describe("check-roadmap CLI smoke test", () => {
	it("exits 0 against the real repo's current roadmap + task-index", () => {
		execFileSync(process.execPath, ["--import", "tsx", "scripts/check-roadmap.ts"], {
			cwd: REPO_ROOT,
			stdio: "pipe",
		});
	});
});
