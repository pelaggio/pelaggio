import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { resolveArtifactRoot } from "../artifact-root.js";
import { lintAgentContext, lintAllSkills, lintSkillFile, lintTemplates, type Violation } from "../check-skills.js";

const REAL_REPO_ROOT = resolveArtifactRoot(import.meta.url);

function makeRepoWithSkill(skillName: string, body: string, extras: Record<string, string> = {}): { repoRoot: string; skillFile: string } {
	const repoRoot = mkdtempSync(join(tmpdir(), "pelaggio-lint-test-"));
	const skillDir = join(repoRoot, ".claude/skills", skillName);
	mkdirSync(skillDir, { recursive: true });
	const skillFile = join(skillDir, "SKILL.md");
	writeFileSync(skillFile, body);
	for (const [rel, content] of Object.entries(extras)) {
		const full = join(repoRoot, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	return { repoRoot, skillFile };
}

const VALID_FRONTMATTER = `---
name: demo
description: A demo skill
allowed-tools: Read
---

Body text.
`;

describe("check-skills — lintSkillFile", () => {
	it("returns no violations for a valid skill", () => {
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", VALID_FRONTMATTER);
		assert.deepEqual(lintSkillFile(skillFile, repoRoot), []);
	});

	it("flags missing frontmatter", () => {
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", "# no frontmatter here\n");
		const v = lintSkillFile(skillFile, repoRoot);
		assert.equal(v.length, 1);
		assert.equal(v[0].rule, "frontmatter.missing");
	});

	it("flags invalid YAML in frontmatter", () => {
		const body = "---\nname: [unbalanced\n---\n\nbody\n";
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		const v = lintSkillFile(skillFile, repoRoot);
		assert.equal(v.length, 1);
		assert.equal(v[0].rule, "frontmatter.invalid-yaml");
	});

	it("flags missing required field", () => {
		const body = "---\nname: demo\nallowed-tools: Read\n---\n\nbody\n";
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		const v = lintSkillFile(skillFile, repoRoot);
		assert.equal(v.length, 1);
		assert.equal(v[0].rule, "frontmatter.required-missing");
		assert.match(v[0].message, /description/);
	});

	it("flags unknown field", () => {
		const body = "---\nname: demo\ndescription: d\nallowed-tools: Read\npriority: high\n---\n\nbody\n";
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		const v = lintSkillFile(skillFile, repoRoot);
		assert.equal(v.length, 1);
		assert.equal(v[0].rule, "frontmatter.unknown-field");
		assert.match(v[0].message, /priority/);
		assert.equal(v[0].line, 5);
	});

	it("flags name-directory mismatch", () => {
		const body = "---\nname: wrongname\ndescription: d\nallowed-tools: Read\n---\n\nbody\n";
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		const v = lintSkillFile(skillFile, repoRoot);
		assert.equal(v.length, 1);
		assert.equal(v[0].rule, "frontmatter.name-mismatch");
	});

	it("flags disable-model-invocation with non-boolean value", () => {
		const body = '---\nname: demo\ndescription: d\nallowed-tools: Read\ndisable-model-invocation: "true"\n---\n\nbody\n';
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		const v = lintSkillFile(skillFile, repoRoot);
		assert.equal(v.length, 1);
		assert.equal(v[0].rule, "frontmatter.type-mismatch");
		assert.match(v[0].message, /boolean/);
	});

	it("accepts disable-model-invocation: true as boolean", () => {
		const body = "---\nname: demo\ndescription: d\nallowed-tools: Read\ndisable-model-invocation: true\n---\n\nbody\n";
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		assert.deepEqual(lintSkillFile(skillFile, repoRoot), []);
	});

	it("flags consumer with non-boolean value", () => {
		const body = '---\nname: demo\ndescription: d\nallowed-tools: Read\nconsumer: "false"\n---\n\nbody\n';
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		const v = lintSkillFile(skillFile, repoRoot);
		assert.equal(v.length, 1);
		assert.equal(v[0].rule, "frontmatter.type-mismatch");
		assert.match(v[0].message, /boolean/);
	});

	it("accepts consumer: false as boolean", () => {
		const body = "---\nname: demo\ndescription: d\nallowed-tools: Read\nconsumer: false\n---\n\nbody\n";
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		assert.deepEqual(lintSkillFile(skillFile, repoRoot), []);
	});

	it("flags skill referencing scripts/pelaggio/*.ts without consumer:false", () => {
		const body = "---\nname: demo\ndescription: d\nallowed-tools: Read\n---\n\nEdit scripts/pelaggio/config.ts as needed.\n";
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		const v = lintSkillFile(skillFile, repoRoot);
		assert.equal(v.length, 1);
		assert.equal(v[0].rule, "consumer.internal-ref");
	});

	it("accepts internal ref when consumer: false is set", () => {
		const body = "---\nname: demo\ndescription: d\nallowed-tools: Read\nconsumer: false\n---\n\nEdit scripts/pelaggio/config.ts as needed.\n";
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		assert.deepEqual(lintSkillFile(skillFile, repoRoot), []);
	});

	it("flags dangling !cat include with correct line number", () => {
		const body = `---
name: demo
description: d
allowed-tools: Read
---

Intro paragraph.

!\`cat .claude/skills/_ghost.md\`
`;
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		const v = lintSkillFile(skillFile, repoRoot);
		assert.equal(v.length, 1);
		assert.equal(v[0].rule, "include.dangling");
		assert.equal(v[0].line, 9);
	});

	it("accepts dangling !cat include when 2>/dev/null suffix is present", () => {
		const body = `---
name: demo
description: d
allowed-tools: Read
---

!\`cat .claude/skills/_optional.md 2>/dev/null\`
`;
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		assert.deepEqual(lintSkillFile(skillFile, repoRoot), []);
	});

	it("accepts resolved !cat include", () => {
		const body = `---
name: demo
description: d
allowed-tools: Read
---

!\`cat .claude/skills/_real.md\`
`;
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body, {
			".claude/skills/_real.md": "shared content\n",
		});
		assert.deepEqual(lintSkillFile(skillFile, repoRoot), []);
	});

	it("accepts 'npx pelaggio' invocation", () => {
		const body = `---
name: demo
description: d
allowed-tools: Read
---

Run \`npx pelaggio roadmap get TOOL-1 --json\` to fetch.
`;
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		assert.deepEqual(lintSkillFile(skillFile, repoRoot), []);
	});

	it("flags 'pnpm pelaggio roadmap' (recursion-shaped substitution)", () => {
		const body = `---
name: demo
description: d
allowed-tools: Read
---

When npx fails, fall back to \`pnpm pelaggio roadmap get <ID>\`.
`;
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		const v = lintSkillFile(skillFile, repoRoot);
		assert.equal(v.length, 1);
		assert.equal(v[0].rule, "skill.pnpm-pelaggio-subcommand");
	});

	it("does not scan frontmatter for recursion-shaped invocations", () => {
		const body = `---
name: demo
description: "Use pnpm pelaggio roadmap to invoke"
allowed-tools: Read
---

Body is clean.
`;
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		assert.deepEqual(lintSkillFile(skillFile, repoRoot), []);
	});

	it("flags $ARGUMENTS without argument-hint", () => {
		const body = `---
name: demo
description: d
allowed-tools: Read
---

Parse $ARGUMENTS for flags.
`;
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		const v = lintSkillFile(skillFile, repoRoot);
		assert.equal(v.length, 1);
		assert.equal(v[0].rule, "arguments.no-hint");
		assert.equal(v[0].line, 7);
	});

	it("accepts $ARGUMENTS when argument-hint is set", () => {
		const body = `---
name: demo
description: d
argument-hint: "[flag]"
allowed-tools: Read
---

Parse $ARGUMENTS for flags.
`;
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		assert.deepEqual(lintSkillFile(skillFile, repoRoot), []);
	});
});

describe("check-skills — model-id.hardcoded", () => {
	it("flags a hardcoded model ID in a skill body", () => {
		const body = `---
name: demo
description: d
allowed-tools: Read
---

Use claude-opus-4-8 for planning.
`;
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		const v = lintSkillFile(skillFile, repoRoot);
		assert.equal(v.length, 1);
		assert.equal(v[0].rule, "model-id.hardcoded");
		assert.equal(v[0].line, 7);
		assert.match(v[0].message, /claude-opus-4-8/);
	});

	it("exempts the bump-models skill", () => {
		const body = `---
name: bump-models
description: d
allowed-tools: Read
---

The current IDs are claude-opus-4-8 and claude-sonnet-5.
`;
		const { repoRoot, skillFile } = makeRepoWithSkill("bump-models", body);
		assert.deepEqual(lintSkillFile(skillFile, repoRoot), []);
	});

	it("does not flag worktree names or spaced prose", () => {
		const body = `---
name: demo
description: d
allowed-tools: Read
---

Branch pelaggio-19 runs on Claude Opus 4.8 by profile.
`;
		const { repoRoot, skillFile } = makeRepoWithSkill("demo", body);
		assert.deepEqual(lintSkillFile(skillFile, repoRoot), []);
	});
});

describe("check-skills — lintTemplates", () => {
	function makeRepoWithTemplate(rel: string, content: string): string {
		const repoRoot = mkdtempSync(join(tmpdir(), "pelaggio-lint-tpl-"));
		const full = join(repoRoot, ".claude-templates", rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
		return repoRoot;
	}

	it("flags a hardcoded model ID in a template", () => {
		const repoRoot = makeRepoWithTemplate("foo.md", "Set the model to claude-sonnet-5.\n");
		const v = lintTemplates(repoRoot);
		assert.equal(v.length, 1);
		assert.equal(v[0].rule, "model-id.hardcoded");
		assert.equal(v[0].file, ".claude-templates/foo.md");
		// The reported ID stops at the digit — the sentence-ending period is not captured.
		assert.ok(v[0].message.includes("`claude-sonnet-5`"), v[0].message);
	});

	it("returns [] for a clean template", () => {
		const repoRoot = makeRepoWithTemplate("foo.md", "Models come from MODEL_PROFILES.\n");
		assert.deepEqual(lintTemplates(repoRoot), []);
	});

	it("returns [] when .claude-templates is absent", () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "pelaggio-lint-notpl-"));
		assert.deepEqual(lintTemplates(repoRoot), []);
	});

	it("returns [] for this repo's real templates", () => {
		const v: Violation[] = lintTemplates(REAL_REPO_ROOT);
		assert.deepEqual(v, [], `unexpected violations:\n${v.map((x) => `  ${x.file}${x.line ? `:${x.line}` : ""} [${x.rule}] ${x.message}`).join("\n")}`);
	});
});

describe("check-skills — lintAllSkills", () => {
	it("returns [] for this repo's real skills", () => {
		const v: Violation[] = lintAllSkills(REAL_REPO_ROOT);
		assert.deepEqual(v, [], `unexpected violations:\n${v.map((x) => `  ${x.file}${x.line ? `:${x.line}` : ""} [${x.rule}] ${x.message}`).join("\n")}`);
	});

	it("skips directories starting with _", () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "pelaggio-lint-all-"));
		const underscoreDir = join(repoRoot, ".claude/skills/_shared");
		mkdirSync(underscoreDir, { recursive: true });
		writeFileSync(join(underscoreDir, "SKILL.md"), "no frontmatter");
		const realDir = join(repoRoot, ".claude/skills/real");
		mkdirSync(realDir, { recursive: true });
		writeFileSync(join(realDir, "SKILL.md"), VALID_FRONTMATTER.replace("name: demo", "name: real"));
		assert.deepEqual(lintAllSkills(repoRoot), []);
	});
});

describe("check-skills — lintAgentContext", () => {
	function makeRepoWithAgentContext(args: { claudeBody?: string; agentsBody?: string; omitAgents?: boolean; omitAgentDocs?: boolean; codexSkills?: "symlink" | "dir" | "wrong-target" | "missing" } = {}): string {
		const repoRoot = mkdtempSync(join(tmpdir(), "pelaggio-lint-agent-"));
		mkdirSync(join(repoRoot, ".claude/skills"), { recursive: true });
		mkdirSync(join(repoRoot, ".agents"), { recursive: true });
		if (!args.omitAgentDocs) mkdirSync(join(repoRoot, "docs/agent-context"), { recursive: true });
		if (!args.omitAgents) writeFileSync(join(repoRoot, "AGENTS.md"), args.agentsBody ?? "# Agents\n\nSee docs/agent-context/pipeline.md.\n");
		writeFileSync(join(repoRoot, "CLAUDE.md"), args.claudeBody ?? "@AGENTS.md\n\n## Claude Code\n\nClaude-only notes.\n");
		const codexSkills = join(repoRoot, ".agents/skills");
		switch (args.codexSkills ?? "symlink") {
			case "symlink":
				symlinkSync("../.claude/skills", codexSkills);
				break;
			case "dir":
				mkdirSync(codexSkills, { recursive: true });
				break;
			case "wrong-target":
				symlinkSync("../.claude", codexSkills);
				break;
			case "missing":
				break;
		}
		return repoRoot;
	}

	function rules(args: Parameters<typeof makeRepoWithAgentContext>[0]): string[] {
		return lintAgentContext(makeRepoWithAgentContext(args)).map((v) => v.rule);
	}

	it("accepts the bilingual context substrate", () => {
		assert.deepEqual(lintAgentContext(makeRepoWithAgentContext()), []);
	});

	it("requires CLAUDE.md to import AGENTS.md", () => {
		assert.deepEqual(rules({ claudeBody: "# Claude-only duplicate\n" }), ["agent-context.no-agents-import"]);
	});

	it("flags a CLAUDE.md that outgrows a thin shim", () => {
		const body = `@AGENTS.md\n${"x\n".repeat(90)}`;
		assert.deepEqual(rules({ claudeBody: body }), ["agent-context.too-large"]);
	});

	it("flags AGENTS.md when it is missing or too large or does not route to detail docs", () => {
		assert.deepEqual(rules({ omitAgents: true }), ["agent-context.missing"]);
		assert.deepEqual(rules({ agentsBody: `docs/agent-context/x.md\n${"x\n".repeat(210)}` }), ["agent-context.too-large"]);
		assert.deepEqual(rules({ agentsBody: "# Agents\n\nNo routing here.\n" }), ["agent-context.no-routing"]);
	});

	it("requires the progressive-disclosure detail docs directory", () => {
		assert.deepEqual(rules({ omitAgentDocs: true }), ["agent-context.missing"]);
	});

	it("requires .agents/skills to be a symlink to the canonical skill tree", () => {
		assert.deepEqual(rules({ codexSkills: "dir" }), ["agent-context.not-symlink"]);
		assert.deepEqual(rules({ codexSkills: "missing" }), ["agent-context.missing"]);
		assert.deepEqual(rules({ codexSkills: "wrong-target" }), ["agent-context.wrong-target"]);
	});
});
