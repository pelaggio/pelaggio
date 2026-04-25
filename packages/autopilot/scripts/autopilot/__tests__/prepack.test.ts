import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanSkillsOut, copySkillsIn, PACK_TARGETS } from "../../pack-prepare.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe("pack-prepare", () => {
	let target: string | null = null;
	afterEach(() => {
		if (target) {
			rmSync(target, { recursive: true, force: true });
			target = null;
		}
	});

	it("copies skills + templates into the package, then removes them", () => {
		target = mkdtempSync(join(tmpdir(), "autopilot-prepack-"));
		copySkillsIn(target, REPO_ROOT);
		assert.ok(existsSync(resolve(target, ".claude/skills/_rubric.md")), "skills copied");
		assert.ok(existsSync(resolve(target, ".claude-templates")), ".claude-templates copied");

		cleanSkillsOut(target);
		for (const rel of PACK_TARGETS) {
			assert.equal(existsSync(resolve(target, rel)), false, `${rel} removed`);
		}
	});
});
