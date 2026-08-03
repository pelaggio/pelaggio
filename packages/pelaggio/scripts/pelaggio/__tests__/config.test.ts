import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULTS, loadConfig, resolveDriverCandidates, resolveProviderBin, resolveRepo, resolveStepSettings } from "../config.js";
import { BASELINE_TAXONOMY_CLASSES, canonicalizeContractionPayload, isSafetyClass, mergeTaxonomyClasses, signContractionPayload } from "../review/taxonomy.js";

function tmpRepo(): string {
	return mkdtempSync(join(tmpdir(), "pelaggio-config-test-"));
}

function writeYml(repo: string, body: string): string {
	const path = join(repo, ".pelaggio.yml");
	writeFileSync(path, body);
	return path;
}

const ENV_KEY = "PELAGGIO_WORKTREE_PREFIX";
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
	it("returns DEFAULTS when .pelaggio.yml is absent", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
		assert.deepEqual(cfg.budgets, DEFAULTS.budgets);
		assert.deepEqual(cfg.turnLimits, DEFAULTS.turnLimits);
		assert.deepEqual(cfg.effort, DEFAULTS.effort);
		assert.deepEqual(cfg.modelProfiles, DEFAULTS.modelProfiles);
		assert.equal(cfg.confinement.allowDirtyMain, false);
		assert.deepEqual(cfg.profileCodexModels, {});
		assert.equal(cfg.pick.maxScope, "M");
	});

	it("treats empty YAML file the same as missing", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "");
		const cfg = loadConfig({ repo, configPath: path });
		assert.deepEqual(cfg.budgets, DEFAULTS.budgets);
		assert.deepEqual(cfg.modelProfiles, DEFAULTS.modelProfiles);
		assert.deepEqual(cfg.profileCodexModels, {});
	});
});

describe("loadConfig — pick.max-scope", () => {
	it("parses and normalizes valid thresholds", () => {
		for (const [input, expected] of [
			["L", "L"],
			["s", "S"],
		] as const) {
			const repo = tmpRepo();
			const path = writeYml(repo, `pick:\n  max-scope: ${input}\n`);
			assert.equal(loadConfig({ repo, configPath: path }).pick.maxScope, expected);
		}
	});

	it("rejects invalid strings and non-strings with the config path diagnostic", () => {
		for (const value of ["XXL", "3", "{}"] as const) {
			const repo = tmpRepo();
			const path = writeYml(repo, `pick:\n  max-scope: ${value}\n`);
			assert.throws(() => loadConfig({ repo, configPath: path }), /expected `pick\.max-scope` to be one of XS\|S\|M\|L\|XL/);
		}
	});
});

describe("loadConfig — confinement", () => {
	it("accepts explicit boolean values", () => {
		for (const value of [true, false]) {
			const repo = mkdtempSync(join(tmpdir(), "pelaggio-config-"));
			const path = join(repo, ".pelaggio.yml");
			writeFileSync(path, `confinement:\n  allow-dirty-main: ${value}\n`);
			assert.equal(loadConfig({ repo, configPath: path }).confinement.allowDirtyMain, value);
		}
	});

	it("rejects non-boolean values", () => {
		for (const value of ['"true"', "1", "{}"]) {
			const repo = mkdtempSync(join(tmpdir(), "pelaggio-config-"));
			const path = join(repo, ".pelaggio.yml");
			writeFileSync(path, `confinement:\n  allow-dirty-main: ${value}\n`);
			assert.throws(() => loadConfig({ repo, configPath: path }), /confinement\.allow-dirty-main.*boolean/);
		}
	});
});

describe("loadConfig — ship.required-checks (#292)", () => {
	it("defaults to [ci] when unset", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
		assert.deepEqual(cfg.shipRequiredChecks, ["ci"]);
	});

	it("accepts an explicit list", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "ship:\n  required-checks: [ci, review]\n");
		assert.deepEqual(loadConfig({ repo, configPath: path }).shipRequiredChecks, ["ci", "review"]);
	});

	it("accepts an explicit empty list (escape hatch)", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "ship:\n  required-checks: []\n");
		assert.deepEqual(loadConfig({ repo, configPath: path }).shipRequiredChecks, []);
	});

	it("rejects a non-list or non-string entries", () => {
		for (const value of ['"ci"', "true", "[ci, 3]"]) {
			const repo = tmpRepo();
			const path = writeYml(repo, `ship:\n  required-checks: ${value}\n`);
			assert.throws(() => loadConfig({ repo, configPath: path }), /ship\.required-checks.*list of check-name strings/);
		}
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
	it("env PELAGGIO_WORKTREE_PREFIX wins over yml", () => {
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
		assert.ok(cfg.worktreePrefix.startsWith("pelaggio-config-test-"));
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
		assert.throws(() => loadConfig({ repo, configPath: path }), /\.pelaggio\.yml/);
		assert.throws(() => loadConfig({ repo, configPath: path }), /models\.profiles\.deep\.budgets\.plan/);
	});

	it("throws with file path when an override block is not a map", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      budgets: 16", ""].join("\n"));
		assert.throws(() => loadConfig({ repo, configPath: path }), /\.pelaggio\.yml/);
		assert.throws(() => loadConfig({ repo, configPath: path }), /models\.profiles\.deep\.budgets/);
	});

	it("built-in profiles carry no override entries", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
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
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
		assert.equal(resolveStepSettings(cfg, "standard", "plan").budget, DEFAULTS.budgets.plan);
	});

	it("resolves the non-pipeline pr-review step from DEFAULTS", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
		const s = resolveStepSettings(cfg, "standard", "pr-review");
		assert.equal(s.budget, DEFAULTS.budgets["pr-review"]);
		assert.equal(s.turns, DEFAULTS.turnLimits["pr-review"]);
		assert.equal(s.effort, DEFAULTS.effort["pr-review"]);
		assert.equal(s.model, DEFAULTS.modelProfiles.standard["pr-review"]);
	});

	it("resolves pr-verify defaults independently while inheriting pr-review model settings", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
		const s = resolveStepSettings(cfg, "standard", "pr-verify");
		assert.equal(s.budget, DEFAULTS.budgets["pr-verify"]);
		assert.equal(s.turns, DEFAULTS.turnLimits["pr-verify"]);
		assert.equal(s.effort, DEFAULTS.effort["pr-verify"]);
		assert.equal(s.model, DEFAULTS.modelProfiles.standard["pr-review"]);
		assert.equal(s.provider, "claude");
	});

	it("inherits consumer pr-review model, codex model, and provider overrides", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    mixed:", "      pr-review: reviewer", "      codex:", "        pr-review: gpt-reviewer", "      providers:", "        pr-review: codex", ""].join("\n"));
		const s = resolveStepSettings(loadConfig({ repo, configPath: path }), "mixed", "pr-verify");
		assert.equal(s.model, "reviewer");
		assert.equal(s.codexModel, "gpt-reviewer");
		assert.equal(s.provider, "codex");
	});

	it("explicit pr-verify model, codex model, and provider overrides win", () => {
		const repo = tmpRepo();
		const path = writeYml(
			repo,
			[
				"models:",
				"  profiles:",
				"    mixed:",
				"      pr-review: reviewer",
				"      pr-verify: verifier",
				"      codex:",
				"        pr-review: gpt-reviewer",
				"        pr-verify: gpt-verifier",
				"      providers:",
				"        pr-review: claude",
				"        pr-verify: codex",
				"",
			].join("\n"),
		);
		const s = resolveStepSettings(loadConfig({ repo, configPath: path }), "mixed", "pr-verify");
		assert.equal(s.model, "verifier");
		assert.equal(s.codexModel, "gpt-verifier");
		assert.equal(s.provider, "codex");
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
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
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

	it("parses a sparse per-profile codex override and resolves undefined for omitted steps", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      codex:", "        implement: gpt-5-codex", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.profileCodexModels.deep?.implement, "gpt-5-codex");
		assert.equal(resolveStepSettings(cfg, "deep", "implement").codexModel, "gpt-5-codex");
		assert.equal(resolveStepSettings(cfg, "deep", "plan").codexModel, undefined);
	});

	it("keeps per-profile codex maps sparse and ignores unknown steps", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      codex:", "        implement: gpt-5-codex", "        bogus: gpt-5-codex", "    shallow:", "      plan: claude-sonnet-5", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.deepEqual(cfg.profileCodexModels, { deep: { implement: "gpt-5-codex" } });
		assert.equal(resolveStepSettings(cfg, "shallow", "plan").codexModel, undefined);
	});

	it("throws on invalid codex model override values", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      codex:", "        implement: 123", ""].join("\n"));
		assert.throws(() => loadConfig({ repo, configPath: path }), /\.pelaggio\.yml/);
		assert.throws(() => loadConfig({ repo, configPath: path }), /models\.profiles\.deep\.codex\.implement/);
	});

	it("throws when a codex override block is not a map", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      codex: gpt-5-codex", ""].join("\n"));
		assert.throws(() => loadConfig({ repo, configPath: path }), /expected `models\.profiles\.deep\.codex` to be a map/);
	});

	it("throws on an invalid provider value (documents #80's two-spot widening)", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      providers:", "        implement: gpt", ""].join("\n"));
		assert.throws(() => loadConfig({ repo, configPath: path }), /\.pelaggio\.yml/);
		assert.throws(() => loadConfig({ repo, configPath: path }), /models\.profiles\.deep\.providers\.implement/);
	});

	it("throws on an unknown step in a provider mapping", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["models:", "  profiles:", "    deep:", "      providers:", "        implment: codex", ""].join("\n"));
		assert.throws(() => loadConfig({ repo, configPath: path }), /unknown step at `models\.profiles\.deep\.providers\.implment`/);
	});
});

describe("provider pools", () => {
	it("parses ordered policy-step pools while scalar resolution remains compatible", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "models:\n  profiles:\n    mixed:\n      providers:\n        plan: [claude, codex, grok]\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.deepEqual(cfg.profileProviders.mixed?.plan, ["claude", "codex", "grok"]);
		assert.equal(resolveStepSettings(cfg, "mixed", "plan").provider, "claude");
		assert.deepEqual(
			resolveDriverCandidates(cfg, "mixed", "plan").map((candidate) => candidate.provider),
			["claude", "codex", "grok"],
		);
	});

	it("rejects empty, duplicate, unknown, and unsupported pools", () => {
		for (const providers of ["plan: []", "plan: [claude, claude]", "plan: [claude, nope]", "ship: [claude, codex]"]) {
			const repo = tmpRepo();
			const path = writeYml(repo, `models:\n  profiles:\n    bad:\n      providers:\n        ${providers}\n`);
			assert.throws(() => loadConfig({ repo, configPath: path }), /models\.profiles\.bad\.providers\.(plan|ship)/);
		}
	});
});

describe("loadConfig — roadmap.source", () => {
	it("defaults to 'markdown' when unset", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
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

	it("accepts roadmap.source: beads without github/linear fields", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "roadmap:\n  source: beads\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.roadmapSource, "beads");
		// No Beads-specific config object; github/linear blocks remain defaults and unused.
		assert.equal(cfg.roadmapGithub.ghRepo, "");
		assert.equal(cfg.roadmapLinear.teamId, "");
	});
});

describe("loadConfig — roadmap.github", () => {
	it("defaults github block to {ghRepo:'', label:'autopilot', planLocation:'issue-comment'}", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
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
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
		assert.equal(cfg.roadmapLinear.teamId, "");
		assert.equal(cfg.roadmapLinear.label, "");
		assert.equal(cfg.roadmapLinear.planLocation, "issue-comment");
	});

	it("parses roadmap.linear.{team,label,plan-location} overrides", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, ["roadmap:", "  source: linear", "  linear:", "    team: ENG", "    label: pelaggio", "    plan-location: issue-comment", ""].join("\n"));
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.roadmapSource, "linear");
		assert.equal(cfg.roadmapLinear.teamId, "ENG");
		assert.equal(cfg.roadmapLinear.label, "pelaggio");
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
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
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
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
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

describe("loadConfig — review", () => {
	it("defaults to the safe one-pass review policy when unset", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
		assert.deepEqual(cfg.review, DEFAULTS.review);
		assert.deepEqual(Object.fromEntries(cfg.review.taxonomy.classes), BASELINE_TAXONOMY_CLASSES);
		assert.equal(cfg.review.taxonomy.judgmentDefault, "permissive");
	});

	it("parses review.runner: local and review.statusless-after", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "review:\n  runner: local\n  statusless-after: 45m\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.deepEqual(cfg.review, { ...DEFAULTS.review, runner: "local", statuslessAfter: "45m" });
	});

	it("allows a partial review override", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "review:\n  statusless-after: 1h30m\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.deepEqual(cfg.review, { ...DEFAULTS.review, statuslessAfter: "1h30m" });
	});

	it("parses bounded convergence policy", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "review:\n  max-passes: 3\n  budget-cap: 40.5\n  provider-diversity: require\n");
		assert.deepEqual(loadConfig({ repo, configPath: path }).review, { ...DEFAULTS.review, maxPasses: 3, budgetCap: 40.5, providerDiversity: "require" });
	});

	it("loads free safety extensions and elevations", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "review:\n  taxonomy:\n    judgment-default: park\n    classes:\n      my-extra: safety\n      style: safety\n");
		const taxonomy = loadConfig({ repo, configPath: path }).review.taxonomy;
		assert.equal(taxonomy.judgmentDefault, "park");
		assert.equal(isSafetyClass("my-extra", taxonomy), true);
		assert.equal(isSafetyClass("style", taxonomy), true);
	});

	it("rejects a contraction when no owner trust anchor is configured (#352 — env unset)", () => {
		// With PELAGGIO_TAXONOMY_PUBKEY unset (the default), ANY contraction fails closed on the
		// missing out-of-band anchor. The anchor lives in the operator's environment, not in the
		// agent-writable source/config, so a worker cannot seat its own key and self-sign.
		const prev = process.env.PELAGGIO_TAXONOMY_PUBKEY;
		delete process.env.PELAGGIO_TAXONOMY_PUBKEY;
		try {
			for (const contract of ["", "    contract:\n      signature-b64: ZmFrZQ==\n"]) {
				const repo = tmpRepo();
				const path = writeYml(repo, `review:\n  taxonomy:\n    classes:\n      security-and-secrets: judgment\n${contract}`);
				assert.throws(() => loadConfig({ repo, configPath: path }), /security-and-secrets.*no owner trust anchor/);
			}
		} finally {
			if (prev !== undefined) process.env.PELAGGIO_TAXONOMY_PUBKEY = prev;
		}
	});

	it("loads a validly-signed contraction end-to-end through loadConfig when the anchor is set (#352 review)", () => {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
		const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		// Sign the canonical payload for contracting `security-and-secrets` (a contractible safety class).
		const payload = canonicalizeContractionPayload(mergeTaxonomyClasses({ classes: { "security-and-secrets": "judgment" } }));
		const sig = signContractionPayload(payload, privPem);
		const prev = process.env.PELAGGIO_TAXONOMY_PUBKEY;
		process.env.PELAGGIO_TAXONOMY_PUBKEY = pem;
		try {
			const repo = tmpRepo();
			const path = writeYml(repo, `review:\n  taxonomy:\n    classes:\n      security-and-secrets: judgment\n    contract:\n      signature-b64: "${sig}"\n`);
			const taxonomy = loadConfig({ repo, configPath: path }).review.taxonomy;
			assert.equal(isSafetyClass("security-and-secrets", taxonomy), false);
		} finally {
			if (prev === undefined) delete process.env.PELAGGIO_TAXONOMY_PUBKEY;
			else process.env.PELAGGIO_TAXONOMY_PUBKEY = prev;
		}
	});

	it("rejects unsigned or incorrectly signed contractions when the anchor IS set", () => {
		const { publicKey } = generateKeyPairSync("ed25519");
		const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
		const prev = process.env.PELAGGIO_TAXONOMY_PUBKEY;
		process.env.PELAGGIO_TAXONOMY_PUBKEY = pem;
		try {
			for (const contract of ["", "    contract:\n      signature-b64: ZmFrZQ==\n"]) {
				const repo = tmpRepo();
				const path = writeYml(repo, `review:\n  taxonomy:\n    classes:\n      security-and-secrets: judgment\n${contract}`);
				assert.throws(() => loadConfig({ repo, configPath: path }), /security-and-secrets.*(?:unsigned|signature)/);
			}
			const repo = tmpRepo();
			const path = writeYml(repo, "review:\n  taxonomy:\n    classes:\n      my-lint: judgment\n");
			assert.throws(() => loadConfig({ repo, configPath: path }), /my-lint.*unsigned/);
		} finally {
			if (prev === undefined) delete process.env.PELAGGIO_TAXONOMY_PUBKEY;
			else process.env.PELAGGIO_TAXONOMY_PUBKEY = prev;
		}
	});

	it("strictly rejects malformed taxonomy subkeys", () => {
		for (const body of ["mystery: true", "contract:\n      public-key-pem: nope", "judgment-default: loose", "classes:\n      bad_class: safety"]) {
			const repo = tmpRepo();
			const path = writeYml(repo, `review:\n  taxonomy:\n    ${body}\n`);
			assert.throws(() => loadConfig({ repo, configPath: path }), /taxonomy/);
		}
	});

	it("parses the bounded authoring policy and provider-specific models", () => {
		const repo = tmpRepo();
		const path = writeYml(
			repo,
			"review:\n  authoring:\n    enabled: true\n    budget-cap: 30\n    reviewers:\n      - id: cdx\n        provider: codex\n        codex-model: gpt-review\n      - id: grk\n        provider: grok\n        model: grok-review\n    judge:\n      provider: claude\n      model: claude-judge\n",
		);
		assert.deepEqual(loadConfig({ repo, configPath: path }).review.authoring, {
			enabled: true,
			reviewers: [
				{ id: "cdx", provider: "codex", codexModel: "gpt-review" },
				{ id: "grk", provider: "grok", model: "grok-review" },
			],
			judge: { id: "judge", provider: "claude", model: "claude-judge" },
			blockingBar: "must-fix",
			maxPasses: 5,
			maxRevisions: 4,
			budgetCap: 30,
			providerDiversity: "prefer",
		});
	});

	it("parses a bounded authoring convergence policy (max-passes / max-revisions)", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "review:\n  authoring:\n    max-passes: 3\n    max-revisions: 2\n");
		const authoring = loadConfig({ repo, configPath: path }).review.authoring;
		assert.equal(authoring.maxPasses, 3);
		assert.equal(authoring.maxRevisions, 2);
	});

	it("clamps default max-revisions when only max-passes is lowered", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "review:\n  authoring:\n    max-passes: 2\n");
		const authoring = loadConfig({ repo, configPath: path }).review.authoring;
		assert.equal(authoring.maxPasses, 2);
		assert.equal(authoring.maxRevisions, 1);
	});

	it("rejects authoring convergence boundaries", () => {
		for (const [yaml, pattern] of [
			["max-passes: 0", /review\.authoring\.max-passes/],
			["max-passes: 6", /review\.authoring\.max-passes/],
			["max-passes: 2.5", /review\.authoring\.max-passes/],
			["max-revisions: -1", /review\.authoring\.max-revisions/],
			["max-passes: 3\n    max-revisions: 3", /review\.authoring\.max-revisions/],
			["max-revisions: 5", /review\.authoring\.max-revisions/],
			["blocking-bar: nice", /review\.authoring\.blocking-bar/],
			["provider-diversity: require", /review\.authoring\.provider-diversity/],
		] as const) {
			const repo = tmpRepo();
			const path = writeYml(repo, `review:\n  authoring:\n    ${yaml}\n`);
			assert.throws(() => loadConfig({ repo, configPath: path }), pattern);
		}
	});

	it("rejects every convergence policy boundary", () => {
		for (const [yaml, pattern] of [
			["max-passes: 0", /review\.max-passes/],
			["max-passes: 4", /review\.max-passes/],
			["max-passes: 1.5", /review\.max-passes/],
			["max-passes: '2'", /review\.max-passes/],
			["budget-cap: 0", /review\.budget-cap/],
			["budget-cap: -1", /review\.budget-cap/],
			["budget-cap: nope", /review\.budget-cap/],
			["provider-diversity: preferred", /review\.provider-diversity/],
		] as const) {
			const repo = tmpRepo();
			const path = writeYml(repo, `review:\n  ${yaml}\n`);
			assert.throws(() => loadConfig({ repo, configPath: path }), pattern);
		}
	});

	it("throws on an invalid review.runner", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "review:\n  runner: self-hosted\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /review\.runner.*ci\|local/);
	});

	it("throws on a non-string review.statusless-after", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "review:\n  statusless-after: 120\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /review\.statusless-after.*string/);
	});

	it("throws when review is not a map", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "review: local\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /expected `review` to be a map/);
	});
});

describe("loadConfig — notify", () => {
	it("defaults to { url: '', format: 'json', events: <all events> } when unset", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
		assert.deepEqual(cfg.notify, {
			url: "",
			format: "json",
			events: ["parked", "failed", "shipped", "pr-opened", "shipwrecked", "review-stranded", "decision"],
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
	const REPO_ENV = "PELAGGIO_REPO";
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

	it("respects PELAGGIO_REPO env var", () => {
		const fake = tmpRepo();
		process.env[REPO_ENV] = fake;
		assert.equal(resolveRepo(), fake);
	});

	it("falls back to git rev-parse — returns the current repo when run inside one", () => {
		// savedCwd is inside a git repo (the pelaggio worktree itself)
		const result = resolveRepo();
		assert.ok(result.length > 0);
		assert.ok(!result.includes("\n"));
	});

	it("throws when neither env nor git repo is available", () => {
		const notARepo = mkdtempSync(join(tmpdir(), "pelaggio-no-git-"));
		process.chdir(notARepo);
		assert.throws(() => resolveRepo(), /git repository/);
	});
});

describe("loadConfig — providers.<name>.bin (#241)", () => {
	it("defaults to an empty map when no providers block is present", () => {
		const repo = tmpRepo();
		const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
		assert.deepEqual(cfg.providerBins, {});
		assert.equal(cfg.grokAllowUnsandboxedFallback, false);
	});

	it("parses a per-provider bin override", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "providers:\n  codex:\n    bin: /opt/codex/bin/codex\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.providerBins.codex, "/opt/codex/bin/codex");
	});

	it("accepts a bin override for grok (registered since #136)", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "providers:\n  grok:\n    bin: ~/.grok/bin/grok\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.providerBins.grok, "~/.grok/bin/grok");
	});

	it("accepts a bin override for opencode (registered since #137)", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "providers:\n  opencode:\n    bin: ~/.opencode/bin/opencode\n");
		const cfg = loadConfig({ repo, configPath: path });
		assert.equal(cfg.providerBins.opencode, "~/.opencode/bin/opencode");
	});

	it("parses the Grok-only unsandboxed fallback escape hatch", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "providers:\n  grok:\n    allow-unsandboxed-fallback: true\n");
		assert.equal(loadConfig({ repo, configPath: path }).grokAllowUnsandboxedFallback, true);
	});

	it("rejects invalid or non-Grok unsandboxed fallback settings", () => {
		const repo = tmpRepo();
		const invalid = writeYml(repo, "providers:\n  grok:\n    allow-unsandboxed-fallback: yes\n");
		assert.throws(() => loadConfig({ repo, configPath: invalid }), /providers\.grok\.allow-unsandboxed-fallback.*boolean/);
		const unsupported = writeYml(repo, "providers:\n  codex:\n    allow-unsandboxed-fallback: true\n");
		assert.throws(() => loadConfig({ repo, configPath: unsupported }), /only supported for grok/);
	});

	it("rejects an unknown provider name", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "providers:\n  gemini:\n    bin: /opt/gemini\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /unknown provider `providers\.gemini`/);
	});

	it("rejects a non-map providers block", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "providers: nope\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /expected `providers` to be a map/);
	});

	it("rejects an empty bin string", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "providers:\n  codex:\n    bin: ''\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /providers\.codex\.bin` to be a non-empty string/);
	});
});

describe("resolveProviderBin (#241)", () => {
	const base = loadConfig({ repo: tmpRepo(), configPath: join(tmpRepo(), ".pelaggio.yml") });

	it("returns the fallback when no override is set", () => {
		assert.equal(resolveProviderBin(base, "codex", "codex"), "codex");
	});

	it("returns an absolute override verbatim", () => {
		const cfg = { ...base, providerBins: { codex: "/opt/codex" } };
		assert.equal(resolveProviderBin(cfg, "codex", "codex"), "/opt/codex");
	});

	it("expands a leading ~/ to the home directory", () => {
		const cfg = { ...base, providerBins: { codex: "~/.grok/bin/grok" } };
		assert.equal(resolveProviderBin(cfg, "codex", "codex"), join(homedir(), ".grok/bin/grok"));
	});
});

describe("loadConfig — errors", () => {
	it("throws with file path in message on invalid shape", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "budgets:\n  - not\n  - a\n  - map\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /\.pelaggio\.yml/);
	});

	it("throws with file path on malformed YAML", () => {
		const repo = tmpRepo();
		const path = writeYml(repo, "budgets:\n  implement: [unclosed\n");
		assert.throws(() => loadConfig({ repo, configPath: path }), /\.pelaggio\.yml/);
	});
});
