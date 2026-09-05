import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { containedPath } from "../local-autopilot/run-worktree.js";

it("allows internal symlinks and missing descendants, while rejecting external and dangling links", () => {
	const root = mkdtempSync(join(tmpdir(), "pelaggio-contained-path-"));
	try {
		mkdirSync(join(root, "source"));
		symlinkSync("source", join(root, "internal"), "dir");
		assert.equal(containedPath(root, "internal/new/file.ts"), join(root, "source/new/file.ts"));
		assert.equal(containedPath(root, "new/file.ts"), join(root, "new/file.ts"));
		symlinkSync(tmpdir(), join(root, "external"), "dir");
		assert.throws(() => containedPath(root, "external/new/file.ts"), /symlink/);
		symlinkSync("missing", join(root, "dangling"), "dir");
		assert.throws(() => containedPath(root, "dangling/file.ts"));
		assert.throws(() => containedPath(root, "../escape"), /escapes/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
