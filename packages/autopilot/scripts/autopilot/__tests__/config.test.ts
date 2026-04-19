import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULTS, loadConfig, resolveRepo } from "../config.js";

function tmpRepo(): string {
	return mkdtempSync(join(tmpdir(), "autopilot-config-test-"));
}

function writeYml(repo: string, body: string): string {
	const path = join(repo, ".autopilot.yml");
	writeFileSync(path, body);
	return path;
}

const ENV_KEY = "CLAUDE_AUTOPILOT_WORKTREE_PREFIX";
let savedEnv: string | undefined;

beforeEach(() => {
	savedEnv = process.env[ENV_KEY];
	delete process.env[ENV_KEY];
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = savedEnv;
});

describe("loadConfig — missing / empty", () => {
	it("returns DEFAULTS when .autopilot.yml is absent", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".autopilot.yml") });
		assert.deepEqual(cfg.budgets, DEFAULTS.budgets);
		assert.deepEqual(cfg.turnLimits, DEFAULTS.turnLimits);
		assert.deepEqual(cfg.effort, DEFAULTS.effort);
		assert.deepEqual(cfg.modelProfiles, DEFAULTS.modelProfiles);
	});

	it("treats empty YAML file the same as missing", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "");
		const cfg = loadConfig({ repo, configPath: path });
		assert.deepEqual(cfg.budgets, DEFAULTS.budgets);
		assert.deepEqual(cfg.modelProfiles, DEFAULTS.modelProfiles);
	});
});

describe("loadConfig — overrides", () => {
	it("applies worktree.prefix override", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "worktree:\n  prefix: custom-\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.worktreePrefix, "custom-");
		assert.deepEqual(cfg.budgets, DEFAULTS.budgets);
	});

	it("partial budgets override — only named step changes", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "budgets:\n  implement: 40\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.budgets.implement, 40);
		assert.equal(cfg.budgets.plan, DEFAULTS.budgets.plan);
		assert.equal(cfg.budgets.ship, DEFAULTS.budgets.ship);
	});

	it("partial turn-limits override uses kebab-case section name", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "turn-limits:\n  plan: 100\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.turnLimits.plan, 100);
		assert.equal(cfg.turnLimits.implement, DEFAULTS.turnLimits.implement);
	});

	it("partial profile override leaves siblings intact", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "models:\n  profiles:\n    standard:\n      plan: some-model-id\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.modelProfiles.standard.plan, "some-model-id");
		assert.equal(cfg.modelProfiles.standard.pick, DEFAULTS.modelProfiles.standard.pick);
		assert.deepEqual(cfg.modelProfiles.quick, DEFAULTS.modelProfiles.quick);
	});

	it("user can add a new named profile alongside defaults", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "models:\n  profiles:\n    thrifty:\n      pick: claude-haiku-4-5-20251001\n      plan: claude-haiku-4-5-20251001\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.modelProfiles.thrifty?.pick, "claude-haiku-4-5-20251001");
		assert.equal(cfg.modelProfiles.thrifty?.plan, "claude-haiku-4-5-20251001");
		assert.deepEqual(cfg.modelProfiles.standard, DEFAULTS.modelProfiles.standard);
		assert.deepEqual(cfg.modelProfiles.quick, DEFAULTS.modelProfiles.quick);
	});
});

describe("loadConfig — env var precedence", () => {
	it("env CLAUDE_AUTOPILOT_WORKTREE_PREFIX wins over yml", () => {
		process.env[ENV_KEY] = "env-wins-";
		const repo = tmpRepo();
		const path = writeYml(repo, "worktree:\n  prefix: yml-loses-\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.worktreePrefix, "env-wins-");
	});

	it("falls back to basename(repo) + '-' when neither env nor yml set", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, "missing.yml") });
		assert.ok(cfg.worktreePrefix.endsWith("-"));
		assert.ok(cfg.worktreePrefix.startsWith("autopilot-config-test-"));
	});
});

describe("loadConfig — unknown keys", () => {
	it("ignores unknown top-level keys", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "foo: bar\nproject:\n  name: future-tool-9\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.deepEqual(cfg.budgets, DEFAULTS.budgets);
	});

	it("ignores non-step keys inside budgets", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "budgets:\n  bogus: 5\n  implement: 30\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.budgets.implement, 30);
		assert.equal(cfg.budgets.plan, DEFAULTS.budgets.plan);
		assert.ok(!("bogus" in cfg.budgets));
	});
});

describe("loadConfig — roadmap.source", () => {
	it("defaults to 'markdown' when unset", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".autopilot.yml") });
		assert.equal(cfg.roadmapSource, "markdown");
	});

	it("accepts explicit 'markdown'", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "roadmap:\n  source: markdown\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.roadmapSource, "markdown");
	});

	it("throws on unknown roadmap.source value", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "roadmap:\n  source: gh-issues\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /roadmap\.source.*markdown/);
	});
});

describe("loadConfig — roadmap.github", () => {
	it("defaults github block to {ghRepo:'', label:'autopilot', planLocation:'issue-comment'}", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".autopilot.yml") });
		assert.equal(cfg.roadmapGithub.ghRepo, "");
		assert.equal(cfg.roadmapGithub.label, "autopilot");
		assert.equal(cfg.roadmapGithub.planLocation, "issue-comment");
	});

	it("parses roadmap.github.{repo,label,plan-location} overrides", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["roadmap:", "  source: github-issues", "  github:", "    repo: acme/widgets", "    label: pipeline", "    plan-location: issue-comment", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.roadmapSource, "github-issues");
		assert.equal(cfg.roadmapGithub.ghRepo, "acme/widgets");
		assert.equal(cfg.roadmapGithub.label, "pipeline");
		assert.equal(cfg.roadmapGithub.planLocation, "issue-comment");
	});

	it("throws when roadmap.source=github-issues and roadmap.github.repo is missing", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "roadmap:\n  source: github-issues\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /roadmap\.github\.repo.*required/);
	});

	it("throws on invalid plan-location", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["roadmap:", "  source: github-issues", "  github:", "    repo: acme/widgets", "    plan-location: wiki-page", ""].join("\n"));
		assert.throws(() => loadConfig({ repo, configPath: path }), /plan-location.*issue-comment\|pr-description/);
	});

	it("accepts plan-location: pr-description (parsed; adapter surfaces 'not yet implemented' at call-time)", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["roadmap:", "  source: github-issues", "  github:", "    repo: acme/widgets", "    plan-location: pr-description", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.roadmapGithub.planLocation, "pr-description");
	});
});

describe("loadConfig — roadmap.linear", () => {
	it("defaults linear block to {teamId:'', label:'', planLocation:'issue-comment'}", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".autopilot.yml") });
		assert.equal(cfg.roadmapLinear.teamId, "");
		assert.equal(cfg.roadmapLinear.label, "");
		assert.equal(cfg.roadmapLinear.planLocation, "issue-comment");
	});

	it("parses roadmap.linear.{team,label,plan-location} overrides", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["roadmap:", "  source: linear", "  linear:", "    team: ENG", "    label: autopilot", "    plan-location: issue-comment", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.roadmapSource, "linear");
		assert.equal(cfg.roadmapLinear.teamId, "ENG");
		assert.equal(cfg.roadmapLinear.label, "autopilot");
		assert.equal(cfg.roadmapLinear.planLocation, "issue-comment");
	});

	it("throws when roadmap.source=linear and roadmap.linear.team is missing", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "roadmap:\n  source: linear\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /roadmap\.linear\.team.*required/);
	});

	it("throws on invalid linear plan-location", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["roadmap:", "  source: linear", "  linear:", "    team: ENG", "    plan-location: wiki", ""].join("\n"));
		assert.throws(() => loadConfig({ repo, configPath: path }), /plan-location.*issue-comment\|pr-description/);
	});
});

describe("resolveRepo", () => {
	const REPO_ENV = "CLAUDE_AUTOPILOT_REPO";
	let savedRepoEnv: string | undefined;
	let savedCwd: string;

	beforeEach(() => {
		savedRepoEnv = process.env[REPO_ENV];
		savedCwd = process.cwd();
		delete process.env[REPO_ENV];
	});

	afterEach(() => {
		if (savedRepoEnv === undefined) delete process.env[REPO_ENV];
		else process.env[REPO_ENV] = savedRepoEnv;
		process.chdir(savedCwd);
	});

	it("respects CLAUDE_AUTOPILOT_REPO env var", () => {
		const fake = tmpRepo();
		process.env[REPO_ENV] = fake;
		assert.equal(resolveRepo(), fake);
	});

	it("falls back to git rev-parse — returns the current repo when run inside one", () => {
		// savedCwd is inside a git repo (the autopilot worktree itself)
		const result = resolveRepo();
		assert.ok(result.length > 0);
		assert.ok(!result.includes("\n"));
	});

	it("throws when neither env nor git repo is available", () => {
		const notARepo = mkdtempSync(join(tmpdir(), "autopilot-no-git-"));
		process.chdir(notARepo);
		assert.throws(() => resolveRepo(), /git repository/);
	});
});

describe("loadConfig — errors", () => {
	it("throws with file path in message on invalid shape", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "budgets:\n  - not\n  - a\n  - map\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /\.autopilot\.yml/);
	});

	it("throws with file path on malformed YAML", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "budgets:\n  implement: [unclosed\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /\.autopilot\.yml/);
	});
});
