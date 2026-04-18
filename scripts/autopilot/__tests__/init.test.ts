import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { planCopies, resolveConsumerRoot, runInit, updatePackageJson } from "../init.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function makeGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "autopilot-init-test-"));
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
		assert.ok(dests.includes(".autopilot.yml"));
		assert.ok(
			dests.some((d) => d.startsWith(".claude/skills/") && d.endsWith("SKILL.md")),
			"at least one skill SKILL.md",
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
		assert.ok(existsSync(join(consumer, "docs/task-index.md")));
		assert.ok(existsSync(join(consumer, ".autopilot.yml")));
	});

	it("re-running without --force is a no-op", () => {
		const consumer = makeGitRepo();
		runInit({ pkgRoot: PKG_ROOT, consumerRoot: consumer, force: false, dryRun: false });
		const ymlBefore = readFileSync(join(consumer, ".autopilot.yml"), "utf-8");
		writeFileSync(join(consumer, ".autopilot.yml"), `${ymlBefore}# user-edit\n`);

		const result = runInit({ pkgRoot: PKG_ROOT, consumerRoot: consumer, force: false, dryRun: false });
		assert.equal(result.created, 0);
		assert.ok(result.skipped > 0);
		assert.equal(result.overwritten, 0);

		const ymlAfter = readFileSync(join(consumer, ".autopilot.yml"), "utf-8");
		assert.ok(ymlAfter.includes("# user-edit"), "user edits preserved");
	});

	it("--force overwrites existing files", () => {
		const consumer = makeGitRepo();
		runInit({ pkgRoot: PKG_ROOT, consumerRoot: consumer, force: false, dryRun: false });
		writeFileSync(join(consumer, ".autopilot.yml"), "# clobber-me\n");

		const result = runInit({ pkgRoot: PKG_ROOT, consumerRoot: consumer, force: true, dryRun: false });
		assert.ok(result.overwritten > 0);
		assert.equal(result.skipped, 0);

		const ymlAfter = readFileSync(join(consumer, ".autopilot.yml"), "utf-8");
		assert.ok(!ymlAfter.includes("# clobber-me"), "force overwrote user content");
	});

	it("--dry-run prints plan but creates zero files", () => {
		const consumer = makeGitRepo();
		const result = runInit({ pkgRoot: PKG_ROOT, consumerRoot: consumer, force: false, dryRun: true });
		assert.ok(result.created > 0, "dry run still reports planned creates");
		assert.ok(!existsSync(join(consumer, ".claude/skills/_rubric.md")));
		assert.ok(!existsSync(join(consumer, ".autopilot.yml")));
	});
});

describe("init — updatePackageJson", () => {
	it("adds scripts.autopilot when missing, preserves siblings", () => {
		const consumer = makeGitRepo();
		writeFileSync(join(consumer, "package.json"), `${JSON.stringify({ name: "demo", scripts: { test: "echo ok" } }, null, 2)}\n`);

		const changed = updatePackageJson(consumer, false);
		assert.equal(changed, true);

		const pkg = JSON.parse(readFileSync(join(consumer, "package.json"), "utf-8"));
		assert.equal(pkg.scripts.autopilot, "claude-autopilot run");
		assert.equal(pkg.scripts.test, "echo ok");
	});

	it("leaves preexisting scripts.autopilot alone", () => {
		const consumer = makeGitRepo();
		writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "demo", scripts: { autopilot: "custom" } }, null, 2));

		const changed = updatePackageJson(consumer, false);
		assert.equal(changed, false);

		const pkg = JSON.parse(readFileSync(join(consumer, "package.json"), "utf-8"));
		assert.equal(pkg.scripts.autopilot, "custom");
	});

	it("dry-run reports change but does not write", () => {
		const consumer = makeGitRepo();
		writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "demo" }, null, 2));

		const changed = updatePackageJson(consumer, true);
		assert.equal(changed, true);

		const pkg = JSON.parse(readFileSync(join(consumer, "package.json"), "utf-8"));
		assert.equal(pkg.scripts, undefined);
	});

	it("returns false when consumer has no package.json", () => {
		const consumer = makeGitRepo();
		assert.equal(updatePackageJson(consumer, false), false);
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
		const notARepo = mkdtempSync(join(tmpdir(), "autopilot-init-no-git-"));
		assert.throws(() => resolveConsumerRoot(notARepo), /git repository/);
	});
});
