import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { it } from "node:test";

const repo = resolve(new URL("../..", import.meta.url).pathname);

it("requires a verified signed tag and publishes with npm provenance", () => {
	const workflow = readFileSync(resolve(repo, ".github/workflows/publish.yml"), "utf8");
	assert.match(workflow, /git tag -v/);
	assert.match(workflow, /npm publish --provenance/);
	assert.match(workflow, /id-token:\s*write/);
});
