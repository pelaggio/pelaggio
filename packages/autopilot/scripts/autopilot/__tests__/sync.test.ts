import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveArtifactRoot } from "../artifact-root.js";
import { type Action, applyAction, type Prompter, planSync, resolveConsumerRoot, runSync, type SyncPlan } from "../sync.js";

const REAL_PKG_ROOT = resolveArtifactRoot(import.meta.url);

function makeGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "autopilot-sync-test-"));
	execSync("git init -q", { cwd: dir });
	return dir;
}

function makeFakePkg(skills: Record<string, string>, extras: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "autopilot-sync-pkg-"));
	const skillsRoot = join(dir, ".claude/skills");
	mkdirSync(skillsRoot, { recursive: true });
	for (const [name, body] of Object.entries(skills)) {
		const skillDir = join(skillsRoot, name);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), body);
	}
	for (const [rel, body] of Object.entries(extras)) {
		const full = join(skillsRoot, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, body);
	}
	return dir;
}

function writeConsumerSkill(consumer: string, name: string, body: string): string {
	const dest = join(consumer, ".claude/skills", name, "SKILL.md");
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, body);
	return dest;
}

function silenceLogs(): () => void {
	const original = console.log;
	console.log = () => {};
	return () => {
		console.log = original;
	};
}

describe("sync — planSync", () => {
	it("emits create for skills absent in the consumer", () => {
		const pkg = makeFakePkg({ pick: "PICK BODY\n", plan: "PLAN BODY\n" });
		const consumer = makeGitRepo();
		const { plans } = planSync(pkg, consumer);
		assert.equal(plans.length, 2);
		assert.ok(plans.every((p) => p.kind === "create"));
	});

	it("emits identical when consumer byte-matches package", () => {
		const pkg = makeFakePkg({ pick: "PICK BODY\n" });
		const consumer = makeGitRepo();
		writeConsumerSkill(consumer, "pick", "PICK BODY\n");
		const { plans } = planSync(pkg, consumer);
		assert.equal(plans.length, 1);
		assert.equal(plans[0].kind, "identical");
	});

	it("emits conflict when consumer differs", () => {
		const pkg = makeFakePkg({ pick: "NEW\n" });
		const consumer = makeGitRepo();
		writeConsumerSkill(consumer, "pick", "OLD\n");
		const { plans } = planSync(pkg, consumer);
		assert.equal(plans.length, 1);
		assert.equal(plans[0].kind, "conflict");
		if (plans[0].kind === "conflict") {
			assert.equal(plans[0].packageBody, "NEW\n");
			assert.equal(plans[0].consumerBody, "OLD\n");
		}
	});

	it("excludes underscore-prefixed entries and non-directories", () => {
		const pkg = makeFakePkg({ pick: "B\n" }, { "_rubric.md": "RUBRIC\n", "_review-logic.md": "RL\n" });
		const consumer = makeGitRepo();
		const { plans } = planSync(pkg, consumer);
		assert.equal(plans.length, 1);
		assert.equal(plans[0].rel, ".claude/skills/pick/SKILL.md");
	});

	it("ignores consumer-only skill directories", () => {
		const pkg = makeFakePkg({ pick: "B\n" });
		const consumer = makeGitRepo();
		writeConsumerSkill(consumer, "my-custom", "CONSUMER\n");
		const { plans } = planSync(pkg, consumer);
		const rels = plans.map((p) => p.rel);
		assert.deepEqual(rels, [".claude/skills/pick/SKILL.md"]);
	});

	it("omits consumer:false skills and reports them via maintainerOnly", () => {
		const pkg = makeFakePkg({
			pick: "PICK\n",
			"bump-models": "---\nname: bump-models\ndescription: x\nallowed-tools: Read\nconsumer: false\n---\nbody\n",
		});
		const consumer = makeGitRepo();
		const { plans, maintainerOnly } = planSync(pkg, consumer);
		assert.deepEqual(
			plans.map((p) => p.rel),
			[".claude/skills/pick/SKILL.md"],
		);
		assert.deepEqual(maintainerOnly, ["bump-models"]);
	});

	it("self-sync (pkgRoot === consumerRoot) sees all skills regardless of consumer flag", () => {
		const pkg = makeFakePkg({
			"bump-models": "---\nname: bump-models\ndescription: x\nallowed-tools: Read\nconsumer: false\n---\nbody\n",
		});
		const { plans, maintainerOnly } = planSync(pkg, pkg);
		assert.equal(plans.length, 1);
		assert.equal(plans[0].rel, ".claude/skills/bump-models/SKILL.md");
		assert.deepEqual(maintainerOnly, []);
	});
});

describe("sync — applyAction", () => {
	it("overwrite writes package body to dest", () => {
		const consumer = makeGitRepo();
		const dest = join(consumer, ".claude/skills/pick/SKILL.md");
		const plan: SyncPlan = { kind: "conflict", rel: ".claude/skills/pick/SKILL.md", src: "/nowhere", dest, consumerBody: "OLD\n", packageBody: "NEW\n" };
		const { wrote } = applyAction(plan, "overwrite");
		assert.equal(wrote, dest);
		assert.equal(readFileSync(dest, "utf-8"), "NEW\n");
	});

	it("skip is a no-op", () => {
		const consumer = makeGitRepo();
		const dest = join(consumer, ".claude/skills/pick/SKILL.md");
		const plan: SyncPlan = { kind: "conflict", rel: ".claude/skills/pick/SKILL.md", src: "/nowhere", dest, consumerBody: "OLD\n", packageBody: "NEW\n" };
		const { wrote } = applyAction(plan, "skip");
		assert.equal(wrote, null);
		assert.equal(existsSync(dest), false);
	});

	it("merge writes package body to .upstream sidecar only", () => {
		const consumer = makeGitRepo();
		const dest = join(consumer, ".claude/skills/pick/SKILL.md");
		writeConsumerSkill(consumer, "pick", "OLD\n");
		const plan: SyncPlan = { kind: "conflict", rel: ".claude/skills/pick/SKILL.md", src: "/nowhere", dest, consumerBody: "OLD\n", packageBody: "NEW\n" };
		const { wrote } = applyAction(plan, "merge");
		assert.equal(wrote, `${dest}.upstream`);
		assert.equal(readFileSync(dest, "utf-8"), "OLD\n");
		assert.equal(readFileSync(`${dest}.upstream`, "utf-8"), "NEW\n");
	});

	it("quit is a no-op at the apply layer", () => {
		const consumer = makeGitRepo();
		const dest = join(consumer, ".claude/skills/pick/SKILL.md");
		const plan: SyncPlan = { kind: "conflict", rel: ".claude/skills/pick/SKILL.md", src: "/nowhere", dest, consumerBody: "OLD\n", packageBody: "NEW\n" };
		const { wrote } = applyAction(plan, "quit");
		assert.equal(wrote, null);
	});

	it("refuses destinations outside .claude/skills/<name>/SKILL.md", () => {
		const consumer = makeGitRepo();
		const dest = join(consumer, ".claude/skills/_rubric.md");
		const plan: SyncPlan = { kind: "conflict", rel: ".claude/skills/_rubric.md", src: "/nowhere", dest, consumerBody: "X", packageBody: "Y" };
		assert.throws(() => applyAction(plan, "overwrite"), /refuses to write/);
	});

	it("refuses merge sidecar on underscore dest", () => {
		const consumer = makeGitRepo();
		const dest = join(consumer, ".claude/skills/_rubric.md");
		const plan: SyncPlan = { kind: "conflict", rel: ".claude/skills/_rubric.md", src: "/nowhere", dest, consumerBody: "X", packageBody: "Y" };
		assert.throws(() => applyAction(plan, "merge"), /refuses to write/);
	});
});

describe("sync — runSync", () => {
	const restore: Array<() => void> = [];
	beforeEach(() => {
		restore.push(silenceLogs());
	});
	afterEach(() => {
		for (const fn of restore.splice(0)) fn();
	});

	it("empty consumer → all creates applied", async () => {
		const pkg = makeFakePkg({ pick: "P\n", plan: "L\n" });
		const consumer = makeGitRepo();
		const result = await runSync({ pkgRoot: pkg, consumerRoot: consumer, force: false, dryRun: false, isTTY: true });
		assert.equal(result.created, 2);
		assert.equal(result.conflicts, 0);
		assert.equal(readFileSync(join(consumer, ".claude/skills/pick/SKILL.md"), "utf-8"), "P\n");
		assert.equal(readFileSync(join(consumer, ".claude/skills/plan/SKILL.md"), "utf-8"), "L\n");
	});

	it("--dry-run reports plans but writes nothing", async () => {
		const pkg = makeFakePkg({ pick: "NEW\n", plan: "L\n" });
		const consumer = makeGitRepo();
		writeConsumerSkill(consumer, "pick", "OLD\n");
		const result = await runSync({ pkgRoot: pkg, consumerRoot: consumer, force: false, dryRun: true, isTTY: false });
		assert.equal(result.created, 1);
		assert.equal(result.conflicts, 1);
		assert.equal(readFileSync(join(consumer, ".claude/skills/pick/SKILL.md"), "utf-8"), "OLD\n");
		assert.equal(existsSync(join(consumer, ".claude/skills/plan/SKILL.md")), false);
	});

	it("--force auto-overwrites conflicts without invoking prompter", async () => {
		const pkg = makeFakePkg({ pick: "NEW\n" });
		const consumer = makeGitRepo();
		writeConsumerSkill(consumer, "pick", "OLD\n");
		let prompted = 0;
		const prompter: Prompter = async () => {
			prompted++;
			return "skip";
		};
		const result = await runSync({ pkgRoot: pkg, consumerRoot: consumer, force: true, dryRun: false, prompter, isTTY: false });
		assert.equal(prompted, 0);
		assert.equal(result.overwritten, 1);
		assert.equal(result.sidecars.length, 0);
		assert.equal(readFileSync(join(consumer, ".claude/skills/pick/SKILL.md"), "utf-8"), "NEW\n");
	});

	it("--force never touches _rubric.md", async () => {
		const pkg = makeFakePkg({ pick: "NEW\n" }, { "_rubric.md": "PKG_RUBRIC\n" });
		const consumer = makeGitRepo();
		const rubricDest = join(consumer, ".claude/skills/_rubric.md");
		mkdirSync(dirname(rubricDest), { recursive: true });
		writeFileSync(rubricDest, "SENTINEL\n");
		await runSync({ pkgRoot: pkg, consumerRoot: consumer, force: true, dryRun: false, isTTY: false });
		assert.equal(readFileSync(rubricDest, "utf-8"), "SENTINEL\n");
	});

	it("--force never touches _project-context.md or .example", async () => {
		const pkg = makeFakePkg(
			{ pick: "NEW\n" },
			{
				"_project-context.md": "PKG_CONTEXT\n",
				"_project-context.md.example": "PKG_EXAMPLE\n",
			},
		);
		const consumer = makeGitRepo();
		const contextDest = join(consumer, ".claude/skills/_project-context.md");
		const exampleDest = join(consumer, ".claude/skills/_project-context.md.example");
		mkdirSync(dirname(contextDest), { recursive: true });
		writeFileSync(contextDest, "SENTINEL\n");
		writeFileSync(exampleDest, "CONSUMER_EXAMPLE\n");
		await runSync({ pkgRoot: pkg, consumerRoot: consumer, force: true, dryRun: false, isTTY: false });
		assert.equal(readFileSync(contextDest, "utf-8"), "SENTINEL\n");
		assert.equal(readFileSync(exampleDest, "utf-8"), "CONSUMER_EXAMPLE\n");
	});

	it("prompter cycles through overwrite/skip/merge", async () => {
		const pkg = makeFakePkg({ one: "N1\n", two: "N2\n", three: "N3\n" });
		const consumer = makeGitRepo();
		writeConsumerSkill(consumer, "one", "O1\n");
		writeConsumerSkill(consumer, "two", "O2\n");
		writeConsumerSkill(consumer, "three", "O3\n");
		const answers: Action[] = ["overwrite", "skip", "merge"];
		let i = 0;
		const prompter: Prompter = async () => answers[i++];
		const result = await runSync({ pkgRoot: pkg, consumerRoot: consumer, force: false, dryRun: false, prompter, isTTY: true });
		assert.equal(result.overwritten, 1);
		assert.equal(result.skipped, 1);
		assert.equal(result.merged, 1);
		assert.equal(result.sidecars.length, 1);

		// planSync sorts entries alphabetically: one, three, two
		// so: one -> overwrite, three -> skip, two -> merge
		assert.equal(readFileSync(join(consumer, ".claude/skills/one/SKILL.md"), "utf-8"), "N1\n");
		assert.equal(readFileSync(join(consumer, ".claude/skills/three/SKILL.md"), "utf-8"), "O3\n");
		assert.equal(readFileSync(join(consumer, ".claude/skills/two/SKILL.md"), "utf-8"), "O2\n");
		assert.ok(existsSync(join(consumer, ".claude/skills/two/SKILL.md.upstream")));
		assert.equal(readFileSync(join(consumer, ".claude/skills/two/SKILL.md.upstream"), "utf-8"), "N2\n");
	});

	it("quit stops processing remaining files", async () => {
		const pkg = makeFakePkg({ a: "NA\n", b: "NB\n", c: "NC\n" });
		const consumer = makeGitRepo();
		writeConsumerSkill(consumer, "a", "OA\n");
		writeConsumerSkill(consumer, "b", "OB\n");
		writeConsumerSkill(consumer, "c", "OC\n");
		const answers: Action[] = ["overwrite", "quit", "overwrite"];
		let i = 0;
		const prompter: Prompter = async () => answers[i++];
		await runSync({ pkgRoot: pkg, consumerRoot: consumer, force: false, dryRun: false, prompter, isTTY: true });
		assert.equal(readFileSync(join(consumer, ".claude/skills/a/SKILL.md"), "utf-8"), "NA\n");
		assert.equal(readFileSync(join(consumer, ".claude/skills/b/SKILL.md"), "utf-8"), "OB\n");
		assert.equal(readFileSync(join(consumer, ".claude/skills/c/SKILL.md"), "utf-8"), "OC\n");
	});

	it("TTY guard rejects non-interactive runs without --force/--dry-run", async () => {
		const pkg = makeFakePkg({ a: "X\n" });
		const consumer = makeGitRepo();
		await assert.rejects(() => runSync({ pkgRoot: pkg, consumerRoot: consumer, force: false, dryRun: false, isTTY: false }), /--force or --dry-run required/);
	});

	it("all-identical case invokes no prompts", async () => {
		const pkg = makeFakePkg({ a: "X\n" });
		const consumer = makeGitRepo();
		writeConsumerSkill(consumer, "a", "X\n");
		let prompted = 0;
		const prompter: Prompter = async () => {
			prompted++;
			return "skip";
		};
		const result = await runSync({ pkgRoot: pkg, consumerRoot: consumer, force: false, dryRun: false, prompter, isTTY: true });
		assert.equal(prompted, 0);
		assert.equal(result.skipped, 1);
		assert.equal(result.conflicts, 0);
	});

	it("smoke: real PKG_ROOT against itself reports all-identical (or creates for missing)", async () => {
		const consumer = makeGitRepo();
		// Pre-populate consumer from the real package so every SKILL.md matches.
		const { plans } = planSync(REAL_PKG_ROOT, consumer);
		for (const p of plans) {
			mkdirSync(dirname(p.dest), { recursive: true });
			writeFileSync(p.dest, readFileSync(p.src, "utf-8"));
		}
		const result = await runSync({ pkgRoot: REAL_PKG_ROOT, consumerRoot: consumer, force: false, dryRun: true, isTTY: false });
		assert.equal(result.conflicts, 0);
		assert.equal(result.created, 0);
	});
});

describe("sync — resolveConsumerRoot", () => {
	it("returns repo top-level when CWD is inside a git repo", () => {
		const repo = makeGitRepo();
		const nested = join(repo, "sub", "deeper");
		mkdirSync(nested, { recursive: true });
		assert.equal(resolveConsumerRoot(nested), repo);
	});

	it("throws an informative error outside a git repo", () => {
		const notARepo = mkdtempSync(join(tmpdir(), "autopilot-sync-no-git-"));
		assert.throws(() => resolveConsumerRoot(notARepo), /git repository/);
	});
});
