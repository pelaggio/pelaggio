import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanSkillsOut, copySkillsIn, PACK_TARGETS } from "../../pack-prepare.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("pack-prepare", () => {
	afterEach(() => {
		cleanSkillsOut(PACKAGE_ROOT);
	});

	it("copies skills + templates into the package, then removes them", () => {
		copySkillsIn(PACKAGE_ROOT);
		assert.ok(existsSync(resolve(PACKAGE_ROOT, ".claude/skills/_rubric.md")), "skills copied");
		assert.ok(existsSync(resolve(PACKAGE_ROOT, ".claude-templates")), ".claude-templates copied");

		cleanSkillsOut(PACKAGE_ROOT);
		for (const rel of PACK_TARGETS) {
			assert.equal(existsSync(resolve(PACKAGE_ROOT, rel)), false, `${rel} removed`);
		}
	});
});
