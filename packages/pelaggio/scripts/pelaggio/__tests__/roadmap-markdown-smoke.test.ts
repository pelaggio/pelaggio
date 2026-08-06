import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { AlreadyClaimedError, getRoadmapSource } from "../roadmap/index.js";

// The one test that wires the real config seam end to end: an `.pelaggio.yml`
// with `roadmap.source: markdown` → loadConfig → getRoadmapSource → a live
// charter/pick/ship sequence. roadmap.test.ts covers each adapter method in
// isolation and roadmap-cli.test.ts injects a fake factory; neither proves that
// config selection yields a working markdown source, nor that ship's mark-done
// lands on `main` rather than the claimed feature branch. This is the canary for
// the markdown consumers this repo does not itself dogfood.

const tmpDirs: string[] = [];

function seedRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pelaggio-md-smoke-"));
	tmpDirs.push(dir);
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

function git(repo: string, args: string): string {
	return execSync(`git ${args}`, { cwd: repo, encoding: "utf-8" }).trim();
}

after(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("markdown roadmap — config-selected source drives a real lifecycle", () => {
	it("`.pelaggio.yml` source: markdown resolves an adapter that ships on main", async () => {
		const repo = seedRepo();
		seedFile(repo, ".pelaggio.yml", "roadmap:\n  source: markdown\n");
		seedFile(repo, "docs/roadmap-core.md", ["# Core", "", "| Item | Depends on |", "|------|-----------|", "| TOOL-1. Existing open item | — |", "", "## Recently completed", "", "- TOOL-0 ✓", ""].join("\n"));
		seedFile(
			repo,
			"docs/task-index.md",
			["# Index", "", "## Open items", "", "| ID | Title | Deps | Plan | Roadmap |", "|----|-------|------|------|---------|", "| TOOL-1 | Existing open item | — | — | core |", "", "## Recently completed", "", "- TOOL-0 ✓", ""].join("\n"),
		);
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		// The seam under test: the YAML — not a hard-coded name — picks the adapter.
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
		assert.equal(cfg.roadmapSource, "markdown");
		const src = getRoadmapSource(cfg.roadmapSource, { repo, github: cfg.roadmapGithub });

		const created = await src.createItem({ title: "Smoke lifecycle item", scope: "M" });
		assert.equal(created.id, "TOOL-2");
		assert.ok(
			(await src.listOpenItems()).some((i) => i.id === "TOOL-2"),
			"charter adds the item to the open set",
		);

		// pick moves HEAD onto feat/<id>; the claim self-serializes on the git ref.
		await src.claimItem("TOOL-2", { noWorktree: true });
		assert.equal(git(repo, "rev-parse --abbrev-ref HEAD"), "feat/tool-2");
		assert.equal((await src.listItems()).find((i) => i.id === "TOOL-2")?.status, "in-progress");
		await assert.rejects(src.claimItem("TOOL-2", { noWorktree: true }), (e: Error) => e instanceof AlreadyClaimedError);

		// ship marks done back on main (where bookkeeping lands it), not the branch.
		git(repo, "checkout -q main");
		await src.markDone("TOOL-2", { note: "landed via smoke test" });
		assert.equal(git(repo, "status --porcelain"), "", "mark-done commits its edit — clean tree");
		assert.match(git(repo, "log -1 --format=%s"), /TOOL-2 done/, "the done commit lands on main");

		const roadmap = readFileSync(resolve(repo, "docs/roadmap-core.md"), "utf-8");
		assert.match(roadmap, /~~TOOL-2\. Smoke lifecycle item~~.*\*\*Done\*\* — landed via smoke test/);
		const index = readFileSync(resolve(repo, "docs/task-index.md"), "utf-8");
		assert.doesNotMatch(index, /^\| TOOL-2 \|/m, "shipped item leaves the Open items table");
		assert.match(index, /- TOOL-2 ✓/, "shipped item lands in Recently completed");
	});

	// The canonical layout gitignores `.dev/`, where the charter sidecar lives. The lifecycle test
	// above seeds no `.gitignore`, so a non-forced `git add` of the sidecar passes there and fails
	// on every real consumer — the create throws *after* the roadmap row is written, leaving dirty
	// partial state. Scope rides the same sidecar and is what `charter-audit` filters the S/XS
	// sub-floor on, so an unprojected scope silently empties that audit.
	it("gitignored `.dev/`: the charter sidecar commits, and its scope reaches the projected item", async () => {
		const repo = seedRepo();
		seedFile(repo, ".gitignore", ".dev/\n");
		seedFile(repo, ".pelaggio.yml", "roadmap:\n  source: markdown\n");
		seedFile(repo, "docs/roadmap-core.md", ["# Core", "", "| Item | Depends on |", "|------|-----------|", "| TOOL-1. Existing open item | — |", ""].join("\n"));
		execSync("git add -A && git commit -q -m seed", { cwd: repo });

		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
		const src = getRoadmapSource(cfg.roadmapSource, { repo, github: cfg.roadmapGithub });

		const created = await src.createItem({ title: "Sub-floor item", scope: "XS", reviewLevel: "triad", reviewDigest: "a".repeat(64) });
		assert.equal(git(repo, "status --porcelain"), "", "create commits the ignored sidecar rather than throwing mid-write");

		const listed = (await src.listItems()).find((i) => i.id === created.id);
		assert.equal(listed?.scope, "XS", "sidecar scope projects onto the item, so charter-audit's S/XS filter can match");
		assert.equal(listed?.reviewLevel, "triad");
	});
});
