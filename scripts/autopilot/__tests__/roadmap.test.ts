import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
