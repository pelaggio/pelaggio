import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { lintAllSkills, lintSkillFile, type Violation } from "../check-skills.js";

const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function makeRepoWithSkill(skillName: string, body: string, extras: Record<string, string> = {}): { repoRoot: string; skillFile: string } {
	const repoRoot = mkdtempSync(join(tmpdir(), "autopilot-lint-test-"));
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

describe("check-skills — lintAllSkills", () => {
	it("returns [] for this repo's real skills", () => {
		const v: Violation[] = lintAllSkills(REAL_REPO_ROOT);
		assert.deepEqual(v, [], `unexpected violations:\n${v.map((x) => `  ${x.file}${x.line ? `:${x.line}` : ""} [${x.rule}] ${x.message}`).join("\n")}`);
	});

	it("skips directories starting with _", () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "autopilot-lint-all-"));
		const underscoreDir = join(repoRoot, ".claude/skills/_shared");
		mkdirSync(underscoreDir, { recursive: true });
		writeFileSync(join(underscoreDir, "SKILL.md"), "no frontmatter");
		const realDir = join(repoRoot, ".claude/skills/real");
		mkdirSync(realDir, { recursive: true });
		writeFileSync(join(realDir, "SKILL.md"), VALID_FRONTMATTER.replace("name: demo", "name: real"));
		assert.deepEqual(lintAllSkills(repoRoot), []);
	});
});
