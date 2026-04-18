import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULTS, loadConfig } from "../config.js";

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
