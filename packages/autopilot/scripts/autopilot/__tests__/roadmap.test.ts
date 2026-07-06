import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

	it("is an idempotent no-op when the item is already marked done (no throw, no new commit) — finding #4", async () => {
		const repo = seedRepo();
		// Row is already struck through (the shape strikethroughRoadmapRow emits).
		seedFile(repo, "docs/roadmap-core.md", ["# Core Roadmap", "", "| Item | Depends on |", "|------|-----------|", "| ~~TOOL-9. RoadmapSource abstraction~~ | **Done** |", ""].join("\n"));
		execSync("git add -A && git commit -q -m 'seed'", { cwd: repo });
		const before = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf-8" }).trim();

		const r = new MarkdownRoadmap({ repo });
		await r.markDone("TOOL-9"); // must NOT throw — already done is a safe no-op

		assert.equal(execSync("git status --porcelain", { cwd: repo, encoding: "utf-8" }).trim(), "", "already-done markDone leaves a clean tree");
		assert.equal(execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf-8" }).trim(), before, "no new commit for an already-done item");
	});

	it("commits only its own pathspec — an unrelated staged change is not swept in (finding #6)", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-core.md", ["# Core Roadmap", "", "| Item | Depends on |", "|------|-----------|", "| TOOL-9. RoadmapSource abstraction | — |", ""].join("\n"));
		execSync("git add -A && git commit -q -m 'seed'", { cwd: repo });
		// An unrelated file is staged before markDone runs.
		seedFile(repo, "unrelated.txt", "do not commit me");
		execSync("git add unrelated.txt", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		await r.markDone("TOOL-9");

		const changed = execSync("git show --name-only --format= HEAD", { cwd: repo, encoding: "utf-8" });
		assert.match(changed, /docs\/roadmap-core\.md/);
		assert.doesNotMatch(changed, /unrelated\.txt/, "unrelated staged file must not be swept into the mark-done commit");
		assert.match(execSync("git status --porcelain", { cwd: repo, encoding: "utf-8" }), /unrelated\.txt/, "unrelated staged change is preserved");
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

	it("commits its edits immediately, leaving a clean tree (bug #28 — deferred items must not linger unstaged)", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-core.md", ["# Core", "", "| Item | Depends on |", "|---|---|", "| TOOL-1. First | — |", ""].join("\n"));
		seedFile(repo, "docs/task-index.md", ["# Index", "", "## Open items", "", "| ID | Title | Deps | Plan | Roadmap |", "|----|-------|------|------|---------|", "| TOOL-1 | First | — | — | core |", ""].join("\n"));
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		await r.createItem({ title: "New thing", scope: "M" });

		// Working tree is clean — the new item was staged + committed, not left dangling.
		assert.equal(execSync("git status --porcelain", { cwd: repo, encoding: "utf-8" }).trim(), "");
		const lastMsg = execSync("git log -1 --format=%s", { cwd: repo, encoding: "utf-8" }).trim();
		assert.match(lastMsg, /docs: add roadmap item TOOL-2 — New thing/);
		// The commit actually contains the roadmap file edit.
		const changed = execSync("git show --name-only --format= HEAD", { cwd: repo, encoding: "utf-8" });
		assert.match(changed, /docs\/roadmap-core\.md/);
	});

	it("commits with --no-verify so a failing pre-commit hook does not break the step (finding #6)", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-core.md", ["# Core", "", "| Item | Depends on |", "|---|---|", "| TOOL-1. First | — |", ""].join("\n"));
		execSync("git add -A && git commit -q -m seed", { cwd: repo });
		// A pre-commit hook that always fails — would abort the commit without --no-verify.
		const hookPath = resolve(repo, ".git", "hooks", "pre-commit");
		mkdirSync(dirname(hookPath), { recursive: true });
		writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
		chmodSync(hookPath, 0o755);

		const r = new MarkdownRoadmap({ repo });
		const created = await r.createItem({ title: "New thing", scope: "M" }); // must not throw
		assert.equal(created.id, "TOOL-2");
		assert.equal(execSync("git status --porcelain", { cwd: repo, encoding: "utf-8" }).trim(), "", "createItem must commit despite the failing hook");
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

describe("MarkdownRoadmap — checkbox-format roadmap", () => {
	function seedCheckboxRoadmap(): string {
		const repo = seedRepo();
		seedFile(
			repo,
			"docs/roadmap-release.md",
			["# Release", "", "- [ ] **A-54. First open** — First. Scope: M.", "- [ ] **A-55. Blocked one** — Blocked. Scope: S. Depends on blocked: waiting on upstream.", "- [x] **A-56. Done one** — Done. Scope: XS.", ""].join("\n"),
		);
		execSync("git add -A && git commit -q -m seed", { cwd: repo });
		return repo;
	}

	it("listItems surfaces open and blocked checkbox rows, skips [x] by default", async () => {
		const repo = seedCheckboxRoadmap();
		const r = new MarkdownRoadmap({ repo });
		const items = await r.listItems();
		const ids = items.map((i) => i.id);
		assert.deepEqual(ids, ["A-54", "A-55"]);
		const blocked = items.find((i) => i.id === "A-55");
		assert.equal(blocked?.status, "blocked");
		assert.equal(blocked?.blockedReason, "waiting on upstream");
	});

	it("listItems includeDone tags [x] rows as done", async () => {
		const repo = seedCheckboxRoadmap();
		const r = new MarkdownRoadmap({ repo });
		const items = await r.listItems({ includeDone: true });
		const done = items.find((i) => i.id === "A-56");
		assert.equal(done?.status, "done");
	});

	it("getItem finds a checkbox row by ID", async () => {
		const repo = seedCheckboxRoadmap();
		const r = new MarkdownRoadmap({ repo });
		const item = await r.getItem("A-54");
		assert.equal(item?.id, "A-54");
		assert.equal(item?.title, "First open");
		assert.equal(item?.status, "open");
	});

	it("listOpenItems filters out [x] rows", async () => {
		const repo = seedCheckboxRoadmap();
		const r = new MarkdownRoadmap({ repo });
		const items = await r.listOpenItems();
		const ids = items.map((i) => i.id);
		assert.ok(ids.includes("A-54"));
		assert.ok(ids.includes("A-55"));
		assert.ok(!ids.includes("A-56"));
	});

	it("markDone flips [ ] → [x] and appends note on a checkbox row", async () => {
		const repo = seedCheckboxRoadmap();
		const r = new MarkdownRoadmap({ repo });
		await r.markDone("A-54", { note: "landed" });
		const body = readFileSync(resolve(repo, "docs/roadmap-release.md"), "utf-8");
		assert.match(body, /^- \[x\] \*\*A-54\. First open\*\* — First\. Scope: M\. \*\*Done\*\* — landed$/m);
		const lastMsg = execSync("git log -1 --format=%s", { cwd: repo, encoding: "utf-8" }).trim();
		assert.match(lastMsg, /docs: mark A-54 done — landed/);
	});
});

describe("MarkdownRoadmap — alt task-index filename (fathom)", () => {
	it("createItem updates docs/roadmap-task-index.md when that is the present file", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-release.md", ["# Release", "", "- [ ] **A-1. First** — First. Scope: M.", ""].join("\n"));
		seedFile(
			repo,
			"docs/roadmap-task-index.md",
			["# Index", "", "## Open items", "", "| ID | Title | Deps | Plan | Roadmap |", "|----|-------|------|------|---------|", "| A-1 | First | — | — | release |", "", "## Recently completed", "", ""].join("\n"),
		);
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		const created = await r.createItem({ title: "Second", scope: "S" });
		assert.equal(created.id, "A-2");

		const index = readFileSync(resolve(repo, "docs/roadmap-task-index.md"), "utf-8");
		assert.match(index, /\| A-2 \| Second \|/);
		assert.ok(!existsSync(resolve(repo, "docs/task-index.md")));
	});

	it("createItem ignores roadmap-task-index.md as a target even when it sorts first", async () => {
		const repo = seedRepo();
		// Seed the index FIRST so readdir on ext4 surfaces it before the real roadmap.
		seedFile(
			repo,
			"docs/roadmap-task-index.md",
			["# Index", "", "## Open items", "", "| ID | Title | Deps | Plan | Roadmap |", "|----|-------|------|------|---------|", "| A-1 | First | — | — | release |", "", "## Recently completed", "", ""].join("\n"),
		);
		seedFile(repo, "docs/roadmap-release.md", ["# Release", "", "- [ ] **A-1. First** — First. Scope: M.", ""].join("\n"));
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		await r.createItem({ title: "Second", scope: "S" });

		const release = readFileSync(resolve(repo, "docs/roadmap-release.md"), "utf-8");
		assert.match(release, /^- \[ \] \*\*A-2\. Second\*\*/m);
		const index = readFileSync(resolve(repo, "docs/roadmap-task-index.md"), "utf-8");
		// Index gets one task-index-style row, not a roadmap-style one.
		assert.match(index, /\| A-2 \| Second \|/);
		assert.doesNotMatch(index, /\| A-2\. Second \|/);
	});

	it("markDone commits index changes when only the alt filename exists", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-release.md", ["# Release", "", "- [ ] **A-1. First** — First. Scope: M.", ""].join("\n"));
		seedFile(
			repo,
			"docs/roadmap-task-index.md",
			["# Index", "", "## Open items", "", "| ID | Title | Deps | Plan | Roadmap |", "|----|-------|------|------|---------|", "| A-1 | First | — | — | release |", "", "## Recently completed", "", ""].join("\n"),
		);
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		await r.markDone("A-1", { note: "done" });

		const index = readFileSync(resolve(repo, "docs/roadmap-task-index.md"), "utf-8");
		assert.doesNotMatch(index, /^\| A-1 \|/m);
		assert.match(index, /- A-1 ✓/);
		const changed = execSync("git show --name-only --format= HEAD", { cwd: repo, encoding: "utf-8" });
		assert.match(changed, /docs\/roadmap-task-index\.md/);
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
