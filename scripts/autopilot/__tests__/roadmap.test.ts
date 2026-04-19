import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { getRoadmapSource, MarkdownRoadmap, type RoadmapSourceName } from "../roadmap/index.js";

function seedRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "autopilot-roadmap-test-"));
	execSync("git init -q -b main", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config commit.gpgsign false", { cwd: dir });
	execSync("git commit --allow-empty -q -m init", { cwd: dir });
	return dir;
}

function seedFile(dir: string, rel: string, body: string): void {
	const full = resolve(dir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body);
}

describe("getRoadmapSource — factory", () => {
	it("returns MarkdownRoadmap for 'markdown'", () => {
		const src = getRoadmapSource("markdown", { repo: "/tmp" });
		assert.ok(src instanceof MarkdownRoadmap);
		assert.equal(src.name, "markdown");
	});

	it("throws on unknown name", () => {
		const bogus = "jira" as unknown as RoadmapSourceName;
		assert.throws(() => getRoadmapSource(bogus, { repo: "/tmp" }), /Unknown roadmap source/);
	});
});

describe("MarkdownRoadmap.parseItemId", () => {
	const r = new MarkdownRoadmap({ repo: "/tmp" });

	it("extracts from feat/ branch names (fallback path — no known items)", async () => {
		assert.equal(await r.parseItemId("feat/tool-9-roadmap"), "TOOL-9");
		assert.equal(await r.parseItemId("checked out feat/a11y4-fix"), "A11Y4");
		assert.equal(await r.parseItemId("feat/fore-2-follow"), "FORE-2");
	});

	it("extracts explicit uppercase IDs (fallback path)", async () => {
		assert.equal(await r.parseItemId("claimed TOOL-9 successfully"), "TOOL-9");
		assert.equal(await r.parseItemId("item COMP13"), "COMP13");
	});

	it("returns null when no ID found", async () => {
		assert.equal(await r.parseItemId("nothing in here"), null);
	});

	function seedRoadmap(ids: string[]): MarkdownRoadmap {
		const repo = seedRepo();
		const rows = ids.map((id) => `| ${id}. Title for ${id} | — |`).join("\n");
		seedFile(repo, "docs/roadmap-core.md", ["# Core", "", "| Item | Depends on |", "|------|-----------|", rows, ""].join("\n"));
		return new MarkdownRoadmap({ repo });
	}

	it("hierarchical: picks longest known ID that is a prefix of the branch slug", async () => {
		const src = seedRoadmap(["COMP-11", "COMP-11C", "COMP-11C-II"]);
		assert.equal(await src.parseItemId("feat/comp-11c-ii-fixes"), "COMP-11C-II");
	});

	it("hierarchical: baseline TOOL-9 preserved when only TOOL-9 is known", async () => {
		const src = seedRoadmap(["TOOL-9"]);
		assert.equal(await src.parseItemId("feat/tool-9-roadmap-source"), "TOOL-9");
	});

	it("hierarchical: known-parent-only stops at the parent (does not invent deeper form)", async () => {
		const src = seedRoadmap(["COMP-11"]);
		assert.equal(await src.parseItemId("feat/comp-11c-ii-fixes"), "COMP-11");
	});

	it("explicit-ID path disambiguates between known parent and child", async () => {
		const src = seedRoadmap(["COMP-11", "COMP-11C"]);
		assert.equal(await src.parseItemId("claimed COMP-11C successfully"), "COMP-11C");
	});
});

describe("MarkdownRoadmap.isQuickScope", () => {
	const r = new MarkdownRoadmap({ repo: "/tmp" });

	it("true for scope: S / XS", () => {
		assert.equal(r.isQuickScope("scope: S"), true);
		assert.equal(r.isQuickScope("Scope: XS"), true);
	});

	it("true for bug / fix: markers", () => {
		assert.equal(r.isQuickScope("bug in the parser"), true);
		assert.equal(r.isQuickScope("fix: null pointer"), true);
	});

	it("false for normal scope", () => {
		assert.equal(r.isQuickScope("scope: M"), false);
		assert.equal(r.isQuickScope("scope: L"), false);
		assert.equal(r.isQuickScope("a regular feature"), false);
	});
});

describe("MarkdownRoadmap.getItemPlan", () => {
	it("returns plan path when plan file exists for worktree's branch", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/plans/tool-9-foo.md", "# plan\n");
		execSync("git add -A && git commit -q -m 'plan'", { cwd: repo });
		execSync("git checkout -q -b feat/tool-9-foo", { cwd: repo });
		const r = new MarkdownRoadmap({ repo });
		const path = await r.getItemPlan({ worktree: repo });
		assert.ok(path, "expected non-null plan path");
		assert.ok(path?.endsWith("tool-9-foo.md"));
	});

	it("returns null when no plan file exists", async () => {
		const repo = seedRepo();
		execSync("git checkout -q -b feat/tool-9", { cwd: repo });
		const r = new MarkdownRoadmap({ repo });
		const path = await r.getItemPlan({ worktree: repo });
		assert.equal(path, null);
	});

	it("falls back to id when no worktree supplied", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/plans/tool-9-abc.md", "# plan\n");
		const r = new MarkdownRoadmap({ repo });
		const path = await r.getItemPlan({ id: "TOOL-9" });
		assert.ok(path?.endsWith("tool-9-abc.md"));
	});
});

describe("MarkdownRoadmap.markDone", () => {
	it("strikes out roadmap row, moves task-index entry, and commits", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-core.md", ["# Core Roadmap", "", "| Item | Depends on |", "|------|-----------|", "| TOOL-9. RoadmapSource abstraction | — |", "| TOOL-10. GitHub adapter | TOOL-9 |", ""].join("\n"));
		seedFile(
			repo,
			"docs/task-index.md",
			[
				"# Task Index",
				"",
				"## Open items",
				"",
				"| ID | Title | Deps | Plan | Roadmap |",
				"|----|-------|------|------|---------|",
				"| TOOL-9 | RoadmapSource abstraction | — | — | core |",
				"| TOOL-10 | GitHub adapter | TOOL-9 | — | core |",
				"",
				"## Recently completed",
				"",
				"- TOOL-1 ✓",
				"",
			].join("\n"),
		);
		execSync("git add -A && git commit -q -m 'seed'", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		await r.markDone("TOOL-9", { note: "landed in feat/tool-9" });

		const roadmap = readFileSync(resolve(repo, "docs/roadmap-core.md"), "utf-8");
		assert.match(roadmap, /~~TOOL-9\. RoadmapSource abstraction~~.*\*\*Done\*\* — landed/);
		assert.match(roadmap, /\| TOOL-10\. GitHub adapter \| TOOL-9 \|/);

		const index = readFileSync(resolve(repo, "docs/task-index.md"), "utf-8");
		assert.doesNotMatch(index, /^\| TOOL-9 \|/m);
		assert.match(index, /- TOOL-9 ✓/);
		assert.match(index, /- TOOL-1 ✓/);

		const lastMsg = execSync("git log -1 --format=%s", { cwd: repo, encoding: "utf-8" }).trim();
		assert.match(lastMsg, /docs: mark TOOL-9 done/);
	});

	it("throws when item is absent from all roadmap files", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-core.md", "# empty\n");
		execSync("git add -A && git commit -q -m 'seed'", { cwd: repo });
		const r = new MarkdownRoadmap({ repo });
		await assert.rejects(() => r.markDone("TOOL-404"), /TOOL-404 not found/);
	});
});

describe("MarkdownRoadmap.listItems / getItem", () => {
	function seedStandard(): string {
		const repo = seedRepo();
		seedFile(
			repo,
			"docs/roadmap-core.md",
			[
				"# Core",
				"",
				"| Item | Depends on |",
				"|------|-----------|",
				"| TOOL-1. Open one | — |",
				"| TOOL-2. Blocked one | blocked: waiting on upstream |",
				"| ~~TOOL-3. Done one~~ | **Done** |",
				"",
				"## Recently completed",
				"",
				"- TOOL-0 ✓",
				"",
			].join("\n"),
		);
		execSync("git add -A && git commit -q -m seed", { cwd: repo });
		return repo;
	}

	it("lists open items with open/blocked status and skips done rows by default", async () => {
		const repo = seedStandard();
		const r = new MarkdownRoadmap({ repo });
		const items = await r.listItems();
		const ids = items.map((i) => i.id);
		assert.deepEqual(ids, ["TOOL-1", "TOOL-2"]);
		const blocked = items.find((i) => i.id === "TOOL-2");
		assert.equal(blocked?.status, "blocked");
		assert.equal(blocked?.blockedReason, "waiting on upstream");
	});

	it("listItems includeDone tags strike-through rows as done", async () => {
		const repo = seedStandard();
		const r = new MarkdownRoadmap({ repo });
		const items = await r.listItems({ includeDone: true });
		const done = items.find((i) => i.id === "TOOL-3");
		assert.equal(done?.status, "done");
	});

	it("getItem returns 'done' for items in Recently completed list", async () => {
		const repo = seedStandard();
		const r = new MarkdownRoadmap({ repo });
		const item = await r.getItem("TOOL-0");
		assert.equal(item?.status, "done");
	});

	it("getItem returns null for unknown ids", async () => {
		const repo = seedStandard();
		const r = new MarkdownRoadmap({ repo });
		assert.equal(await r.getItem("TOOL-999"), null);
	});
});

describe("MarkdownRoadmap.resolvePlanPath", () => {
	it("returns <worktree>/docs/plans/<id-lower>.md", () => {
		const r = new MarkdownRoadmap({ repo: "/tmp/any" });
		const path = r.resolvePlanPath({ id: "TOOL-9", worktree: "/wt" });
		assert.equal(path, resolve("/wt", "docs", "plans", "tool-9.md"));
	});
});

describe("MarkdownRoadmap.createItem", () => {
	it("inserts a new row inside the Open items table of task-index (bug regression)", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-core.md", ["# Core", "", "| Item | Depends on |", "|---|---|", "| TOOL-1. First | — |", ""].join("\n"));
		seedFile(
			repo,
			"docs/task-index.md",
			["# Index", "", "## Open items", "", "| ID | Title | Deps | Plan | Roadmap |", "|----|-------|------|------|---------|", "| TOOL-1 | First | — | — | core |", "", "## Recently completed", "", "- TOOL-0 ✓", ""].join("\n"),
		);
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		const created = await r.createItem({ title: "New thing", scope: "M" });
		assert.equal(created.id, "TOOL-2");

		const index = readFileSync(resolve(repo, "docs/task-index.md"), "utf-8");
		// New row must land BEFORE the "Recently completed" heading (inside the Open items table),
		// not appended to the end of the file.
		const newRowIdx = index.indexOf("| TOOL-2 | New thing |");
		const completedIdx = index.indexOf("## Recently completed");
		assert.ok(newRowIdx > 0, "new row should appear in task-index");
		assert.ok(newRowIdx < completedIdx, "new row should land inside Open items, not after Recently completed");
	});

	it("appends to the configured target roadmap file", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-core.md", ["# Core", "", "| Item | Depends on |", "|---|---|", "| TOOL-1. First | — |", ""].join("\n"));
		seedFile(repo, "docs/roadmap-other.md", ["# Other", "", "| Item | Depends on |", "|---|---|", "| COMP-1. Other | — |", ""].join("\n"));
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		const created = await r.createItem({ title: "New other", scope: "S", roadmap: "other" });
		assert.ok(created.id.startsWith("COMP-"));
		const body = readFileSync(resolve(repo, "docs/roadmap-other.md"), "utf-8");
		assert.match(body, /COMP-2\. New other/);
	});
});

describe("MarkdownRoadmap.archivePlan", () => {
	it("git-mvs the plan file from docs/plans to docs/archived and commits", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/plans/tool-9.md", "# plan\n");
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		await r.archivePlan("TOOL-9");

		assert.ok(!existsSync(resolve(repo, "docs/plans/tool-9.md")));
		assert.ok(existsSync(resolve(repo, "docs/archived/tool-9.md")));
		const lastMsg = execSync("git log -1 --format=%s", { cwd: repo, encoding: "utf-8" }).trim();
		assert.match(lastMsg, /docs: archive plan for TOOL-9/);
	});

	it("is a no-op when the plan file is absent", async () => {
		const repo = seedRepo();
		const r = new MarkdownRoadmap({ repo });
		await r.archivePlan("TOOL-NONE");
	});
});

describe("MarkdownRoadmap.isCharterPickRace", () => {
	function commitIndex(dir: string, content: string): void {
		seedFile(dir, "docs/task-index.md", content);
		execSync("git add -A && git commit -q -m 'docs: task-index'", { cwd: dir });
	}

	it("returns false when item exists in both working tree and HEAD", () => {
		const repo = seedRepo();
		commitIndex(repo, "| TOOL-1 | Existing | — | — | core |\n");
		const r = new MarkdownRoadmap({ repo });
		assert.equal(r.isCharterPickRace("TOOL-1"), false);
	});

	it("returns true when item is in working tree but not HEAD (charter→pick race)", () => {
		const repo = seedRepo();
		commitIndex(repo, "| TOOL-1 | Existing | — | — | core |\n");
		// Simulate /charter adding a new item without committing.
		writeFileSync(resolve(repo, "docs", "task-index.md"), "| TOOL-1 | Existing | — | — | core |\n| TOOL-2 | New | — | — | core |\n");
		const r = new MarkdownRoadmap({ repo });
		assert.equal(r.isCharterPickRace("TOOL-2"), true);
	});

	it("returns false when item is absent from the working tree entirely", () => {
		const repo = seedRepo();
		commitIndex(repo, "| TOOL-1 | Existing | — | — | core |\n");
		const r = new MarkdownRoadmap({ repo });
		assert.equal(r.isCharterPickRace("TOOL-99"), false);
	});

	it("returns false when task-index.md does not exist", () => {
		const repo = seedRepo();
		const r = new MarkdownRoadmap({ repo });
		assert.equal(r.isCharterPickRace("TOOL-1"), false);
	});

	it("returns true when task-index.md exists in working tree but HEAD has no such file", () => {
		const repo = seedRepo();
		seedFile(repo, "docs/task-index.md", "| TOOL-5 | Brand new | — | — | core |\n");
		const r = new MarkdownRoadmap({ repo });
		assert.equal(r.isCharterPickRace("TOOL-5"), true);
	});
});
