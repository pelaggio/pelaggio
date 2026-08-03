import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveArtifactRoot } from "../artifact-root.js";
import { planCopies, resolveConsumerRoot, runInit } from "../init.js";

const PKG_ROOT = resolveArtifactRoot(import.meta.url);

function makeGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pelaggio-init-test-"));
	execSync("git init -q", { cwd: dir });
	return dir;
}

function silenceLogs(): () => void {
	const original = console.log;
	console.log = () => {};
	return () => {
		console.log = original;
	};
}

describe("init — planCopies", () => {
	it("plans the expected destinations from the package source-of-truth map", () => {
		const consumer = makeGitRepo();
		const plans = planCopies(PKG_ROOT, consumer);

		const dests = plans.map((p) => p.dest.replace(`${consumer}/`, ""));
		assert.ok(dests.includes(".claude/skills/_rubric.md"), "rubric is scaffolded");
		assert.ok(dests.includes("docs/task-index.md"));
		assert.ok(dests.includes("docs/roadmap-example.md"));
		assert.ok(dests.includes(".pelaggio.yml"));
		assert.ok(
			dests.some((d) => d.startsWith(".claude/skills/") && d.endsWith("SKILL.md")),
			"at least one skill SKILL.md",
		);
		assert.ok(
			dests.some((d) => d.endsWith(".claude/skills/decompose/SKILL.md")),
			"decompose skill is scaffolded",
		);

		// _rubric.md must not be sourced from the package's own .claude/skills/ — it
		// comes from the template.
		const rubricPlan = plans.find((p) => p.dest.endsWith(".claude/skills/_rubric.md"));
		assert.ok(rubricPlan?.src.includes(".claude-templates"), "rubric source is the template");
	});
});

describe("init — runInit", () => {
	const restore: Array<() => void> = [];
	beforeEach(() => {
		restore.push(silenceLogs());
	});
	afterEach(() => {
		for (const fn of restore.splice(0)) fn();
	});

	it("creates files on first run", () => {
		const consumer = makeGitRepo();
		const result = runInit({ pkgRoot: PKG_ROOT, consumerRoot: consumer, force: false, dryRun: false });

		assert.ok(result.created > 0);
		assert.equal(result.skipped, 0);
		assert.equal(result.overwritten, 0);
		assert.ok(existsSync(join(consumer, ".claude/skills/_rubric.md")));
		assert.ok(existsSync(join(consumer, ".claude/skills/decompose/SKILL.md")), "decompose skill installed");
		assert.ok(existsSync(join(consumer, "docs/task-index.md")));
		assert.ok(existsSync(join(consumer, ".pelaggio.yml")));
	});

	it("re-running without --force is a no-op", () => {
		const consumer = makeGitRepo();
		runInit({ pkgRoot: PKG_ROOT, consumerRoot: consumer, force: false, dryRun: false });
		const ymlBefore = readFileSync(join(consumer, ".pelaggio.yml"), "utf-8");
		writeFileSync(join(consumer, ".pelaggio.yml"), `${ymlBefore}# user-edit\n`);

		const result = runInit({ pkgRoot: PKG_ROOT, consumerRoot: consumer, force: false, dryRun: false });
		assert.equal(result.created, 0);
		assert.ok(result.skipped > 0);
		assert.equal(result.overwritten, 0);

		const ymlAfter = readFileSync(join(consumer, ".pelaggio.yml"), "utf-8");
		assert.ok(ymlAfter.includes("# user-edit"), "user edits preserved");
	});

	it("--force overwrites existing files", () => {
		const consumer = makeGitRepo();
		runInit({ pkgRoot: PKG_ROOT, consumerRoot: consumer, force: false, dryRun: false });
		writeFileSync(join(consumer, ".pelaggio.yml"), "# clobber-me\n");

		const result = runInit({ pkgRoot: PKG_ROOT, consumerRoot: consumer, force: true, dryRun: false });
		assert.ok(result.overwritten > 0);
		assert.equal(result.skipped, 0);

		const ymlAfter = readFileSync(join(consumer, ".pelaggio.yml"), "utf-8");
		assert.ok(!ymlAfter.includes("# clobber-me"), "force overwrote user content");
	});

	it("--dry-run prints plan but creates zero files", () => {
		const consumer = makeGitRepo();
		const result = runInit({ pkgRoot: PKG_ROOT, consumerRoot: consumer, force: false, dryRun: true });
		assert.ok(result.created > 0, "dry run still reports planned creates");
		assert.ok(!existsSync(join(consumer, ".claude/skills/_rubric.md")));
		assert.ok(!existsSync(join(consumer, ".pelaggio.yml")));
	});
});

describe("init — resolveConsumerRoot", () => {
	it("returns repo top-level when CWD is inside a git repo", () => {
		const repo = makeGitRepo();
		const nested = join(repo, "sub", "deeper");
		mkdirSync(nested, { recursive: true });
		assert.equal(resolveConsumerRoot(nested), repo);
	});

	it("throws an informative error outside a git repo", () => {
		const notARepo = mkdtempSync(join(tmpdir(), "pelaggio-init-no-git-"));
		assert.throws(() => resolveConsumerRoot(notARepo), /git repository/);
	});
});
