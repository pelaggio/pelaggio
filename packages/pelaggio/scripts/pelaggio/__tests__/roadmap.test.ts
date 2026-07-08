import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { AlreadyClaimedError, getRoadmapSource, MarkdownRoadmap, type RoadmapSourceName } from "../roadmap/index.js";

function seedRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pelaggio-roadmap-test-"));
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
		assert.equal(r.isQuickScope({ summaryText: "scope: S" }), true);
		assert.equal(r.isQuickScope({ summaryText: "Scope: XS" }), true);
	});

	it("true for bug / fix: markers", () => {
		assert.equal(r.isQuickScope({ summaryText: "bug in the parser" }), true);
		assert.equal(r.isQuickScope({ summaryText: "fix: null pointer" }), true);
	});

	it("false for normal scope", () => {
		assert.equal(r.isQuickScope({ summaryText: "scope: M" }), false);
		assert.equal(r.isQuickScope({ summaryText: "scope: L" }), false);
		assert.equal(r.isQuickScope({ summaryText: "a regular feature" }), false);
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

	it("reconciles a stale task-index row even when the roadmap row is already done (issue #39)", async () => {
		const repo = seedRepo();
		// Roadmap row is already struck through — simulates an implement agent that
		// pre-marked its own row in-branch — but task-index.md was never touched.
		seedFile(repo, "docs/roadmap-core.md", ["# Core Roadmap", "", "| Item | Depends on |", "|------|-----------|", "| ~~TOOL-9. RoadmapSource abstraction~~ | **Done** |", "| TOOL-10. GitHub adapter | TOOL-9 |", ""].join("\n"));
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
		await r.markDone("TOOL-9"); // must NOT throw — roadmap already done, index still needs reconciling

		const roadmap = readFileSync(resolve(repo, "docs/roadmap-core.md"), "utf-8");
		assert.match(roadmap, /~~TOOL-9\. RoadmapSource abstraction~~/, "roadmap row is left untouched — already done");

		const index = readFileSync(resolve(repo, "docs/task-index.md"), "utf-8");
		assert.doesNotMatch(index, /^\| TOOL-9 \|/m, "stale open-items row for TOOL-9 is removed");
		assert.match(index, /- TOOL-9 ✓/, "TOOL-9 lands in Recently completed");

		assert.equal(execSync("git status --porcelain", { cwd: repo, encoding: "utf-8" }).trim(), "", "index reconciliation is committed");
		const changed = execSync("git show --name-only --format= HEAD", { cwd: repo, encoding: "utf-8" });
		assert.match(changed, /docs\/task-index\.md/);
		assert.doesNotMatch(changed, /docs\/roadmap-core\.md/, "already-done roadmap file is not re-committed");
	});

	it("is a full no-op when roadmap AND task-index are already reconciled (issue #39 counterpart)", async () => {
		const repo = seedRepo();
		// Both artifacts already reflect the done state — the fully-idempotent case
		// the per-artifact check must still short-circuit, not just the single-artifact one.
		seedFile(repo, "docs/roadmap-core.md", ["# Core Roadmap", "", "| Item | Depends on |", "|------|-----------|", "| ~~TOOL-9. RoadmapSource abstraction~~ | **Done** |", ""].join("\n"));
		seedFile(repo, "docs/task-index.md", ["# Task Index", "", "## Open items", "", "| ID | Title | Deps | Plan | Roadmap |", "|----|-------|------|------|---------|", "", "## Recently completed", "", "- TOOL-9 ✓", ""].join("\n"));
		execSync("git add -A && git commit -q -m 'seed'", { cwd: repo });
		const before = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf-8" }).trim();

		const r = new MarkdownRoadmap({ repo });
		await r.markDone("TOOL-9");

		assert.equal(execSync("git status --porcelain", { cwd: repo, encoding: "utf-8" }).trim(), "", "fully-reconciled markDone leaves a clean tree");
		assert.equal(execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf-8" }).trim(), before, "no new commit when neither artifact needed a change");
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

	it("infers prefix from item rows only, ignoring prose tokens shaped like IDs (issue #46)", async () => {
		const repo = seedRepo();
		seedFile(
			repo,
			"docs/roadmap-core.md",
			[
				"# Core",
				"",
				"See ADR-0003 for the rationale. This also affects WSL2 setups and CFG-8 in the sibling repo.",
				"Revisit ADR-0003 again before release; ADR-0003 is the canonical reference.",
				"",
				"- [ ] **INST-1. First** — First. Scope: M.",
				"",
			].join("\n"),
		);
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		const created = await r.createItem({ title: "New thing", scope: "M" });
		assert.equal(created.id, "INST-2");
	});

	it("counts 'Recently completed' list IDs so pruned rows keep the high-water mark (issue #46 follow-up)", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-core.md", ["# Core", "", "| Item | Depends on |", "|------|------------|", "| TOOL-2. Open thing | — |", "", "## Recently completed", "", "- TOOL-5 ✓", "- TOOL-3 ✓", ""].join("\n"));
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		const created = await r.createItem({ title: "New thing", scope: "M" });
		assert.equal(created.id, "TOOL-6");
	});

	it("accepts prefixes longer than six letters, matching the row parsers' grammar", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-core.md", ["# Core", "", "- [ ] **CHARTER-1. First** — First. Scope: M.", ""].join("\n"));
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		const created = await r.createItem({ title: "New thing", scope: "M" });
		assert.equal(created.id, "CHARTER-2");
	});

	it("bootstraps a checkbox roadmap with explicit prefix and updates task-index", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/task-index.md", ["# Index", "", "## Open items", "", "| ID | Title | Deps | Plan | Roadmap |", "|----|-------|------|------|---------|", "", "## Recently completed", ""].join("\n"));
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		const created = await r.createItem({ title: "Instantiate providers", roadmap: "instantiation", create: true, prefix: "inst", format: "checkbox" });
		assert.equal(created.id, "INST-1");

		const roadmap = readFileSync(resolve(repo, "docs/roadmap-instantiation.md"), "utf-8");
		assert.match(roadmap, /^# Instantiation$/m);
		assert.match(roadmap, /^- \[ \] \*\*INST-1\. Instantiate providers\*\*/m);
		const index = readFileSync(resolve(repo, "docs/task-index.md"), "utf-8");
		assert.match(index, /\| INST-1 \| Instantiate providers \| — \| — \| instantiation \|/);
		assert.equal(execSync("git status --porcelain", { cwd: repo, encoding: "utf-8" }).trim(), "");
		const changed = execSync("git show --name-only --format= HEAD", { cwd: repo, encoding: "utf-8" });
		assert.match(changed, /docs\/roadmap-instantiation\.md/);
		assert.match(changed, /docs\/task-index\.md/);
	});

	it("bootstraps a table roadmap when --format table is explicit", async () => {
		const repo = seedRepo();
		mkdirSync(resolve(repo, "docs"), { recursive: true });

		const r = new MarkdownRoadmap({ repo });
		const created = await r.createItem({ title: "New track item", roadmap: "New Track", create: true, prefix: "NEW", format: "table" });
		assert.equal(created.id, "NEW-1");

		const roadmap = readFileSync(resolve(repo, "docs/roadmap-new-track.md"), "utf-8");
		assert.match(roadmap, /^# New Track$/m);
		assert.match(roadmap, /^\| Item \| Depends on \|$/m);
		assert.match(roadmap, /^\| NEW-1\. New track item \| — \|$/m);
	});

	it("uses explicit prefix in prose-only files instead of falling back to ITEM", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-core.md", ["# Core", "", "No item rows yet. ADR-0003 and CFG-8 are prose references.", ""].join("\n"));
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		const created = await r.createItem({ title: "First explicit item", prefix: "INST" });
		assert.equal(created.id, "INST-1");
	});

	it("uses explicit prefix high-water marks from Recently completed", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-tools.md", ["# Tools", "", "| Item | Depends on |", "|------|-----------|", "| OTHER-9. Different prefix | — |", "", "## Recently completed", "", "- TOOL-5 ✓", ""].join("\n"));
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		const created = await r.createItem({ title: "Tooling follow-up", prefix: "TOOL" });
		assert.equal(created.id, "TOOL-6");
	});

	it("rejects a --format that conflicts with an existing file's established format (no mixed-format corruption)", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-core.md", ["# Core", "", "| Item | Depends on |", "|------|-----------|", "| TOOL-1. First | — |", ""].join("\n"));
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		// --format checkbox on a table-formatted file would splice a checkbox row into a table →
		// markDone can't locate it (item stuck open). Reject rather than corrupt (#45 review).
		await assert.rejects(() => r.createItem({ title: "Checkbox override", prefix: "TOOL", format: "checkbox" }), /conflicts with the established table format/);
		// The file is untouched and still round-trips: appending in its OWN format then marking done works.
		const created = await r.createItem({ title: "Same format", prefix: "TOOL" });
		assert.equal(created.id, "TOOL-2");
		await r.markDone("TOOL-2");
		const roadmap = readFileSync(resolve(repo, "docs/roadmap-core.md"), "utf-8");
		assert.doesNotMatch(roadmap, /^- \[ \]/m, "no stray checkbox row spliced into the table");
	});

	it("a bootstrapped --format checkbox file round-trips through markDone", async () => {
		const repo = seedRepo();
		mkdirSync(resolve(repo, "docs"), { recursive: true });
		const r = new MarkdownRoadmap({ repo });
		const created = await r.createItem({ title: "Checkbox item", roadmap: "Cbox", create: true, prefix: "CB", format: "checkbox" });
		assert.equal(created.id, "CB-1");
		// The whole point of #45's format handling: a bootstrapped file's items must be markable.
		await r.markDone("CB-1");
		const roadmap = readFileSync(resolve(repo, "docs/roadmap-cbox.md"), "utf-8");
		assert.match(roadmap, /CB-1/);
		assert.doesNotMatch(roadmap, /^\| CB-1/m, "no stray table row in a checkbox file");
	});

	it("re-running --create with a display-style --to appends instead of clobbering", async () => {
		const repo = seedRepo();
		mkdirSync(resolve(repo, "docs"), { recursive: true });

		const r = new MarkdownRoadmap({ repo });
		const first = await r.createItem({ title: "First item", roadmap: "New Track", create: true, prefix: "NEW", format: "table" });
		assert.equal(first.id, "NEW-1");
		// "New Track" slugs to roadmap-new-track.md, which the raw `includes` match
		// won't recognize on the second call — the existence guard must still catch it.
		const second = await r.createItem({ title: "Second item", roadmap: "New Track", create: true, prefix: "NEW", format: "table" });
		assert.equal(second.id, "NEW-2");

		const roadmap = readFileSync(resolve(repo, "docs/roadmap-new-track.md"), "utf-8");
		assert.match(roadmap, /^\| NEW-1\. First item \| — \|$/m);
		assert.match(roadmap, /^\| NEW-2\. Second item \| — \|$/m);
	});

	it("does not create a missing roadmap unless --create is explicit", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-core.md", ["# Core", "", "| Item | Depends on |", "|------|-----------|", ""].join("\n"));
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const r = new MarkdownRoadmap({ repo });
		await assert.rejects(() => r.createItem({ title: "Missing target", roadmap: "missing" }), /no roadmap file matches 'missing'/);
		assert.equal(existsSync(resolve(repo, "docs/roadmap-missing.md")), false);
	});

	it("requires --to when --create is set", async () => {
		const repo = seedRepo();
		mkdirSync(resolve(repo, "docs"), { recursive: true });

		const r = new MarkdownRoadmap({ repo });
		await assert.rejects(() => r.createItem({ title: "No target", create: true }), /--create requires --to <name>/);
	});

	it("rejects invalid explicit prefixes before writing new files", async () => {
		for (const prefix of ["A-1", "123", "../bad"]) {
			const repo = seedRepo();
			mkdirSync(resolve(repo, "docs"), { recursive: true });
			const r = new MarkdownRoadmap({ repo });
			await assert.rejects(() => r.createItem({ title: "Bad prefix", roadmap: "new", create: true, prefix }), /--prefix must contain letters only/);
			assert.equal(existsSync(resolve(repo, "docs/roadmap-new.md")), false);
		}
	});
});

describe("MarkdownRoadmap.claimItem — git-native claims (issue #12)", () => {
	function seedWithItem(id: string): { repo: string; r: MarkdownRoadmap } {
		const repo = seedRepo();
		seedFile(repo, "docs/roadmap-core.md", ["# Core", "", "| Item | Depends on |", "|------|-----------|", `| ${id}. A thing | — |`, "| TOOL-10. Another | — |", ""].join("\n"));
		execSync("git add -A && git commit -q -m seed", { cwd: repo });
		return { repo, r: new MarkdownRoadmap({ repo }) };
	}

	it("second claim of the same id throws AlreadyClaimedError (git ref lock is the arbiter)", async () => {
		const { r } = seedWithItem("TOOL-9");
		await r.claimItem("TOOL-9");
		await assert.rejects(r.claimItem("TOOL-9"), (err: Error) => err instanceof AlreadyClaimedError && /TOOL-9/.test(err.message));
	});

	it("--no-worktree collision maps to AlreadyClaimedError too", async () => {
		const { repo, r } = seedWithItem("TOOL-9");
		execSync("git branch feat/tool-9", { cwd: repo });
		await assert.rejects(r.claimItem("TOOL-9", { noWorktree: true }), (err: Error) => err instanceof AlreadyClaimedError);
	});

	it("listItems overlays in-progress for open items whose feat/<id> branch exists", async () => {
		const { r } = seedWithItem("TOOL-9");
		await r.claimItem("TOOL-9");
		const items = await r.listItems();
		assert.equal(items.find((i) => i.id === "TOOL-9")?.status, "in-progress");
		assert.equal(items.find((i) => i.id === "TOOL-10")?.status, "open");
	});

	it("claim id matching is word-bounded — feat/tool-1 does not claim TOOL-10", async () => {
		const { repo, r } = seedWithItem("TOOL-1");
		execSync("git branch feat/tool-1-fix", { cwd: repo });
		const items = await r.listItems();
		assert.equal(items.find((i) => i.id === "TOOL-1")?.status, "in-progress");
		assert.equal(items.find((i) => i.id === "TOOL-10")?.status, "open");
	});

	it("hierarchical ids attribute to the longest match — feat/comp-11-c claims COMP-11-C, not COMP-11", async () => {
		const { claimedIds } = await import("../roadmap/git-claim.js");
		const repo = seedRepo();
		execSync("git branch feat/comp-11-c", { cwd: repo });
		const claimed = claimedIds(repo, ["COMP-11", "COMP-11-C"]);
		assert.deepEqual([...claimed], ["COMP-11-C"]);
	});

	it("an orphan worktree DIRECTORY is not 'already claimed' — legible error, no phantom branch left", async () => {
		const { repo, r } = seedWithItem("TOOL-9");
		// bookkeeping removed the branch but the worktree dir survived (or any
		// same-named dir exists): git creates the branch, THEN fails on the dir.
		const orphanDir = resolve(repo, "..", `${repo.split("/").pop()}-tool-9`);
		mkdirSync(orphanDir, { recursive: true });
		writeFileSync(resolve(orphanDir, "junk.txt"), "leftover");
		await assert.rejects(r.claimItem("TOOL-9"), (err: Error) => !(err instanceof AlreadyClaimedError));
		const branches = execSync("git branch --list feat/tool-9", { cwd: repo, encoding: "utf-8" }).trim();
		assert.equal(branches, "", "phantom side-effect branch must be cleaned up");
		const items = await r.listItems();
		assert.equal(items.find((i) => i.id === "TOOL-9")?.status, "open", "item must not read as claimed-by-nobody");
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

	// Regression for issue #53: roadmap-example.md's Format A checkbox rows
	// must match parseCheckboxRows (ID + period inside the bold), or a
	// consumer seeding a roadmap from the template gets rows /pick can't see.
	it("listOpenItems and getItem see the roadmap-example.md Format A checkbox shape", async () => {
		const repo = seedRepo();
		seedFile(
			repo,
			"docs/roadmap-release.md",
			["# Release", "", "- [ ] **PFX-1. One-line title** — Short scope sentence. *(scope: S)*", "- [ ] **PFX-2. Title** — Scope *(scope: M, depends on PFX-1)*", "- [x] **PFX-0. Completed title** — Completed. *(2026-04-11)*", ""].join("\n"),
		);
		execSync("git add -A && git commit -q -m seed", { cwd: repo });
		const r = new MarkdownRoadmap({ repo });
		const open = await r.listOpenItems();
		assert.deepEqual(
			open.map((i) => i.id),
			["PFX-1", "PFX-2"],
		);
		const item = await r.getItem("PFX-1");
		assert.equal(item?.title, "One-line title");
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
