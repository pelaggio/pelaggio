import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULTS, loadConfig, resolveRepo, resolveStepSettings } from "../config.js";

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

describe("loadConfig — per-profile overrides", () => {
	it("parses a profile budgets override into profileBudgets", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      budgets:", "        plan: 16", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.profileBudgets.deep.plan, 16);
	});

	it("parses effort and turn-limits (kebab) override blocks", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      effort:", "        plan: high", "      turn-limits:", "        plan: 100", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.profileEffort.deep.plan, "high");
		assert.equal(cfg.profileTurnLimits.deep.plan, 100);
	});

	it("keeps override maps sparse — omitted steps are absent", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      budgets:", "        plan: 16", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.ok(!("implement" in cfg.profileBudgets.deep));
	});

	it("ignores unknown steps inside an override block", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      budgets:", "        bogus: 5", "        plan: 16", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.profileBudgets.deep.plan, 16);
		assert.ok(!("bogus" in cfg.profileBudgets.deep));
	});

	it("throws with file path and dotted key on wrong value type", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      budgets:", "        plan: high", ""].join("\n"));
		assert.throws(() => loadConfig({ repo, configPath: path }), /\.autopilot\.yml/);
		assert.throws(() => loadConfig({ repo, configPath: path }), /models\.profiles\.deep\.budgets\.plan/);
	});

	it("throws with file path when an override block is not a map", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      budgets: 16", ""].join("\n"));
		assert.throws(() => loadConfig({ repo, configPath: path }), /\.autopilot\.yml/);
		assert.throws(() => loadConfig({ repo, configPath: path }), /models\.profiles\.deep\.budgets/);
	});

	it("built-in profiles carry no override entries", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".autopilot.yml") });
		assert.deepEqual(cfg.profileBudgets, {});
		assert.deepEqual(cfg.profileTurnLimits, {});
		assert.deepEqual(cfg.profileEffort, {});
		assert.deepEqual(cfg.profileProviders, {});
	});

	it("adding override blocks to a default profile leaves its models intact", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    standard:", "      budgets:", "        plan: 16", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.profileBudgets.standard.plan, 16);
		assert.equal(cfg.modelProfiles.standard.plan, DEFAULTS.modelProfiles.standard.plan);
		assert.equal(cfg.modelProfiles.standard.pick, DEFAULTS.modelProfiles.standard.pick);
	});
});

describe("resolveStepSettings — precedence & fallback", () => {
	it("profile override wins over a top-level global override and the default", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["budgets:", "  plan: 10", "models:", "  profiles:", "    deep:", "      budgets:", "        plan: 16", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(resolveStepSettings(cfg, "deep", "plan").budget, 16);
	});

	it("falls back to the global step value when the profile omits the step", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["budgets:", "  plan: 10", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(resolveStepSettings(cfg, "deep", "plan").budget, 10);
	});

	it("falls back to DEFAULTS when neither profile nor global set it", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".autopilot.yml") });
		assert.equal(resolveStepSettings(cfg, "standard", "plan").budget, DEFAULTS.budgets.plan);
	});

	it("resolves the non-pipeline pr-review step from DEFAULTS", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".autopilot.yml") });
		const s = resolveStepSettings(cfg, "standard", "pr-review");
		assert.equal(s.budget, DEFAULTS.budgets["pr-review"]);
		assert.equal(s.turns, DEFAULTS.turnLimits["pr-review"]);
		assert.equal(s.effort, DEFAULTS.effort["pr-review"]);
		assert.equal(s.model, DEFAULTS.modelProfiles.standard["pr-review"]);
	});

	it("applies the same precedence to turns and effort", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      turn-limits:", "        plan: 100", "      effort:", "        plan: high", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		const s = resolveStepSettings(cfg, "deep", "plan");
		assert.equal(s.turns, 100);
		assert.equal(s.effort, "high");
	});

	it("resolves model from modelProfiles — value when set, undefined when the profile lacks the step", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    thrifty:", "      plan: claude-haiku-4-5-20251001", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(resolveStepSettings(cfg, "thrifty", "plan").model, "claude-haiku-4-5-20251001");
		assert.equal(resolveStepSettings(cfg, "thrifty", "ship").model, undefined);
	});

	it("resolves a profile with zero override blocks entirely to globals/defaults", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    thrifty:", "      plan: claude-haiku-4-5-20251001", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		const s = resolveStepSettings(cfg, "thrifty", "plan");
		assert.equal(s.budget, DEFAULTS.budgets.plan);
		assert.equal(s.turns, DEFAULTS.turnLimits.plan);
		assert.equal(s.effort, DEFAULTS.effort.plan);
		assert.equal(s.model, "claude-haiku-4-5-20251001");
	});

	it("resolves provider to the default 'claude' when no yml is present", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".autopilot.yml") });
		assert.equal(resolveStepSettings(cfg, "standard", "implement").provider, "claude");
	});

	it("parses a sparse per-profile providers override and falls back to the default for omitted steps", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      providers:", "        implement: codex", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		// The override is parsed into the sparse map (distinct from the default-fallback path)...
		assert.equal(cfg.profileProviders.deep?.implement, "codex");
		// ...and resolves for the named step...
		assert.equal(resolveStepSettings(cfg, "deep", "implement").provider, "codex");
		// ...while a step the profile omits still resolves via DEFAULT_PROVIDER.
		assert.equal(resolveStepSettings(cfg, "deep", "plan").provider, "claude");
	});

	it("throws on an invalid provider value (documents #80's two-spot widening)", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      providers:", "        implement: gpt", ""].join("\n"));
		assert.throws(() => loadConfig({ repo, configPath: path }), /\.autopilot\.yml/);
		assert.throws(() => loadConfig({ repo, configPath: path }), /models\.profiles\.deep\.providers\.implement/);
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

describe("loadConfig — park", () => {
	it("defaults to { autoResume: true, maxWait: '6h', unknownResetWait: '60m' } when unset", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".autopilot.yml") });
		assert.deepEqual(cfg.park, { autoResume: true, maxWait: "6h", unknownResetWait: "60m" });
	});

	it("parses park.unknown-reset-wait (string), leaving other keys at default", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "park:\n  unknown-reset-wait: 30m\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.park.unknownResetWait, "30m");
		assert.equal(cfg.park.maxWait, "6h");
	});

	it("throws on non-string park.unknown-reset-wait", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "park:\n  unknown-reset-wait: 30\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /park\.unknown-reset-wait.*string/);
	});

	it("parses park.auto-resume (boolean) and park.max-wait (string)", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "park:\n  auto-resume: false\n  max-wait: 2h\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.park.autoResume, false);
		assert.equal(cfg.park.maxWait, "2h");
	});

	it("partial park override leaves the other key at its default", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "park:\n  auto-resume: false\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.park.autoResume, false);
		assert.equal(cfg.park.maxWait, "6h");
	});

	it("throws on non-boolean park.auto-resume", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "park:\n  auto-resume: yes-please\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /park\.auto-resume.*boolean/);
	});

	it("throws on non-string park.max-wait", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "park:\n  max-wait: 360\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /park\.max-wait.*string/);
	});

	it("throws when park is not a map", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "park: nope\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /expected `park` to be a map/);
	});
});

describe("loadConfig — revise", () => {
	it("defaults to { local: true } when unset", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".autopilot.yml") });
		assert.deepEqual(cfg.revise, { local: true });
	});

	it("parses revise.local: false", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "revise:\n  local: false\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.revise.local, false);
	});

	it("throws on a non-boolean revise.local", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "revise:\n  local: sometimes\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /revise\.local.*boolean/);
	});

	it("throws when revise is not a map", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "revise: nope\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /expected `revise` to be a map/);
	});
});

describe("loadConfig — notify", () => {
	it("defaults to { url: '', format: 'json', events: <all five> } when unset", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".autopilot.yml") });
		assert.deepEqual(cfg.notify, {
			url: "",
			format: "json",
			events: ["parked", "failed", "shipped", "pr-opened", "shipwrecked"],
		});
	});

	it("parses url/format/events overrides", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["notify:", "  url: https://ntfy.sh/my-topic", "  format: ntfy", "  events:", "    - failed", "    - shipwrecked", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.notify.url, "https://ntfy.sh/my-topic");
		assert.equal(cfg.notify.format, "ntfy");
		assert.deepEqual(cfg.notify.events, ["failed", "shipwrecked"]);
	});

	it("respects an explicitly empty events list", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "notify:\n  url: https://hook\n  events: []\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.deepEqual(cfg.notify.events, []);
	});

	it("throws when notify is not a map", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "notify: nope\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /expected `notify` to be a map/);
	});

	it("throws on a non-string notify.url", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "notify:\n  url: 12345\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /notify\.url.*string/);
	});

	it("throws on an unknown notify.format", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "notify:\n  format: telegram\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /notify\.format.*json\|ntfy/);
	});

	it("throws when notify.events is not an array", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "notify:\n  events: failed\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /notify\.events.*array/);
	});

	it("throws on an unknown event string", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "notify:\n  events:\n    - failed\n    - exploded\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /notify\.events.*parked\|failed/);
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
