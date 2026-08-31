import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const workflow = readFileSync(resolve(repo, ".github/workflows/assurance-atlas-pages.yml"), "utf8");

describe("assurance Pages publication", () => {
	it("publishes one canonical main page when an owning source changes", () => {
		assert.match(workflow, /branches:\n\s+- main\n\s+paths:/);
		assert.doesNotMatch(workflow, /feat\/assurance-atlas/);
		assert.match(workflow, /Checkout main revision[\s\S]*?with:\n\s+ref: main/);
		for (const path of ["AGENTS.md", "ci/assurance-explorer.ts", "ci/assurance-graph.ts", "ci/assurance-observations.ts", "ci/assurance-views.ts", "docs/assurance/**", "docs/decisions/**", "docs/trust/**", "package.json", "pnjm-lock.yaml"]) {
			assert.ok(workflow.includes(`- '${path}'`), `missing Pages trigger for ${path}`);
		}
		assert.match(workflow, /PELAGGIO_ASSURANCE_SOURCE_BASE_URL="https:\/\/github\.com\/\$\{\{ github\.repository \}\}\/blob\/\$\{revision\}\/"/);
		assert.doesNotMatch(workflow, /\.pages\/test|\/test\/index\.html/);
	});
});
