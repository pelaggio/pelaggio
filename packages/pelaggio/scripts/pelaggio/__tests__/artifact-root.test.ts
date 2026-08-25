import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { resolveArtifactRoot } from "../artifact-root.js";
import { makeTestTmpDir } from "./tmp-fixture.js";

function makeAnchor(root: string, child: string): string {
	mkdirSync(resolve(root, ".claude/skills"), { recursive: true });
	writeFileSync(resolve(root, "package.json"), "{}");
	const childDir = resolve(root, child);
	mkdirSync(childDir, { recursive: true });
	const modulePath = resolve(childDir, "x.ts");
	writeFileSync(modulePath, "");
	return pathToFileURL(modulePath).href;
}

describe("resolveArtifactRoot", () => {
	it("finds root when skills are siblings of the calling module", () => {
		const root = makeTestTmpDir("artifact-root-flat-");
		const moduleUrl = makeAnchor(root, ".");
		assert.equal(resolveArtifactRoot(moduleUrl), root);
	});

	it("walks up multiple levels to find root", () => {
		const root = makeTestTmpDir("artifact-root-nested-");
		const moduleUrl = makeAnchor(root, "scripts/pelaggio");
		assert.equal(resolveArtifactRoot(moduleUrl), root);
	});

	it("throws when no ancestor has both anchors", () => {
		const root = makeTestTmpDir("artifact-root-missing-");
		const childDir = resolve(root, "deep/nested");
		mkdirSync(childDir, { recursive: true });
		const modulePath = resolve(childDir, "x.ts");
		writeFileSync(modulePath, "");
		assert.throws(() => resolveArtifactRoot(pathToFileURL(modulePath).href), /no ancestor/);
	});

	it("ignores ancestors that have only skills but no package.json", () => {
		const root = makeTestTmpDir("artifact-root-partial-");
		mkdirSync(resolve(root, ".claude/skills"), { recursive: true });
		// no package.json at root — should fail
		const childDir = resolve(root, "child");
		mkdirSync(childDir, { recursive: true });
		const modulePath = resolve(childDir, "x.ts");
		writeFileSync(modulePath, "");
		assert.throws(() => resolveArtifactRoot(pathToFileURL(modulePath).href), /no ancestor/);
	});
});
