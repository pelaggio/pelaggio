import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ALLOWED_PREFIXES,
	ALLOWED_TEST_DATA_PREFIX,
	checkAllowlist,
	checkPackageScripts,
	checkRequiredPackagedData,
	INSTALL_SCRIPTS,
	isAllowedPackagedTestData,
	REQUIRED_PACKAGED_TEST_DATA,
	SECRET_PATTERNS,
	scanContentsForSecrets,
} from "../../check-publish.js";

describe("checkAllowlist", () => {
	it("passes one representative file per allowed prefix", () => {
		const files = [
			{ path: "scripts/pelaggio/main.ts", size: 100 },
			{ path: ".claude/skills/pick/SKILL.md", size: 100 },
			{ path: ".claude-templates/migration-checklist.md", size: 100 },
			{ path: "bin/pelaggio.js", size: 100 },
			{ path: "package.json", size: 100 },
			{ path: "README.md", size: 100 },
			{ path: "LICENSE", size: 100 },
			{ path: "scripts/pelaggio.ts", size: 100 },
		];
		const violations = checkAllowlist(files);
		assert.deepEqual(violations, []);
	});

	it("covers every ALLOWED_PREFIX with a fixture (exhaustiveness lock)", () => {
		const fixtures = ["scripts/pelaggio/main.ts", ".claude/skills/pick/SKILL.md", ".claude-templates/migration-checklist.md", "bin/pelaggio.js"];
		for (const prefix of ALLOWED_PREFIXES) {
			assert.ok(
				fixtures.some((f) => f.startsWith(prefix)),
				`no fixture covers allowed prefix ${prefix}`,
			);
		}
	});

	it("rejects disallowed top-level files", () => {
		const files = [
			{ path: "docs/foo.md", size: 100 },
			{ path: "CLAUDE.md", size: 100 },
			{ path: ".dev/log", size: 100 },
			{ path: "biome.json", size: 100 },
		];
		const violations = checkAllowlist(files);
		assert.equal(violations.length, 4);
		for (const v of violations) assert.equal(v.kind, "disallowed-path");
	});

	it("rejects tests nested inside allowed dirs", () => {
		const files = [
			{ path: "scripts/pelaggio/__tests__/x.ts", size: 100 },
			{ path: "scripts/pelaggio/x.test.ts", size: 100 },
		];
		const violations = checkAllowlist(files);
		assert.equal(violations.length, 2);
		assert.equal(violations[0].kind, "disallowed-path");
		assert.equal(violations[1].kind, "disallowed-path");
	});

	it("allows only JSON under the review-bench fixture prefix (#291 narrow exception)", () => {
		const files = [
			{ path: `${ALLOWED_TEST_DATA_PREFIX}manifest.json`, size: 100 },
			{ path: `${ALLOWED_TEST_DATA_PREFIX}review-bench.baseline.json`, size: 100 },
			{ path: `${ALLOWED_TEST_DATA_PREFIX}clean/fixture.json`, size: 100 },
			{ path: `${ALLOWED_TEST_DATA_PREFIX}clean/golden.json`, size: 100 },
		];
		assert.deepEqual(checkAllowlist(files), []);
	});

	it("still rejects non-JSON, test source, and sibling fixtures near the exception", () => {
		const files = [
			// a .test.ts even under the exempt prefix stays rejected
			{ path: `${ALLOWED_TEST_DATA_PREFIX}clean/replay.test.ts`, size: 100 },
			// a non-JSON data file under the exempt prefix stays rejected
			{ path: `${ALLOWED_TEST_DATA_PREFIX}clean/transcript.txt`, size: 100 },
			// a sibling fixture directory (not the exempt prefix) stays rejected
			{ path: "scripts/pelaggio/__tests__/fixtures/egress/case.json", size: 100 },
			// the test helper stays rejected
			{ path: "scripts/pelaggio/__tests__/mocks.ts", size: 100 },
		];
		const violations = checkAllowlist(files);
		assert.equal(violations.length, 4);
		for (const v of violations) assert.equal(v.kind, "disallowed-path");
	});

	it("isAllowedPackagedTestData is exactly the JSON-under-prefix predicate", () => {
		assert.ok(isAllowedPackagedTestData(`${ALLOWED_TEST_DATA_PREFIX}manifest.json`));
		assert.ok(!isAllowedPackagedTestData(`${ALLOWED_TEST_DATA_PREFIX}clean/fixture.ts`));
		assert.ok(!isAllowedPackagedTestData("scripts/pelaggio/__tests__/fixtures/other/manifest.json"));
	});
});

describe("checkRequiredPackagedData", () => {
	it("passes when every required review-bench corpus file is packed", () => {
		const files = REQUIRED_PACKAGED_TEST_DATA.map((path) => ({ path, size: 100 }));
		assert.deepEqual(checkRequiredPackagedData(files), []);
	});

	it("reports each missing corpus file (installed CLI would be broken)", () => {
		const dropped = REQUIRED_PACKAGED_TEST_DATA[0];
		const files = REQUIRED_PACKAGED_TEST_DATA.slice(1).map((path) => ({ path, size: 100 }));
		const violations = checkRequiredPackagedData(files);
		assert.equal(violations.length, 1);
		const [violation] = violations;
		assert.ok(violation);
		assert.equal(violation.kind, "missing-packaged-data");
		if (violation.kind === "missing-packaged-data") assert.equal(violation.path, dropped);
	});

	it("requires the manifest, baseline, and all four cases' fixture+golden", () => {
		// manifest + baseline + 4 cases × {fixture,golden}
		assert.equal(REQUIRED_PACKAGED_TEST_DATA.length, 2 + 4 * 2);
	});
});

describe("scanContentsForSecrets", () => {
	const fixtures: Record<string, string> = {
		"anthropic-api-key": 'const k = "sk-ant-abcdefghijklmnopqrstuvwxyz1234";',
		"github-token": 'const k = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";',
		"aws-access-key": 'const k = "AKIAIOSFODNN7EXAMPLE";',
		"npm-token": 'const k = "npm_abcdefghijklmnopqrstuvwxyz0123456789";',
		"private-key-header": "-----BEGIN RSA PRIVATE KEY-----",
	};

	it("produces exactly one violation per pattern fixture", () => {
		for (const { name } of SECRET_PATTERNS) {
			const fixture = fixtures[name];
			assert.ok(fixture, `missing fixture for ${name}`);
			const violations = scanContentsForSecrets([{ path: "f.ts", contents: fixture }]);
			const matched = violations.filter((v) => v.kind === "secret" && v.pattern === name);
			assert.equal(matched.length, 1, `expected one ${name} violation, got ${violations.length}`);
		}
	});

	it("produces no violations for clean content", () => {
		const violations = scanContentsForSecrets([{ path: "f.ts", contents: "export const hello = 1;\n// nothing secret here\n" }]);
		assert.deepEqual(violations, []);
	});
});

describe("checkPackageScripts", () => {
	it("flags each install-script hook", () => {
		for (const name of INSTALL_SCRIPTS) {
			const violations = checkPackageScripts({ scripts: { [name]: "echo pwned" } });
			assert.equal(violations.length, 1);
			assert.equal(violations[0].kind, "install-script");
			if (violations[0].kind === "install-script") {
				assert.equal(violations[0].name, name);
			}
		}
	});

	it("ignores benign scripts", () => {
		const violations = checkPackageScripts({ scripts: { build: "tsc", test: "node --test", prepare: "lefthook install" } });
		assert.deepEqual(violations, []);
	});

	it("handles missing scripts field", () => {
		assert.deepEqual(checkPackageScripts({}), []);
	});
});
