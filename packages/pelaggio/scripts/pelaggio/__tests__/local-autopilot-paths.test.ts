import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { cancelRun } from "../local-autopilot/engine.js";
import { appendRunEvent, readRunEvents } from "../local-autopilot/journal.js";
import { checkedStatePath, eventsPath, leasePath, requestIndexPath, requestLockPath, runDir } from "../local-autopilot/paths.js";
import { containedPath, worktreePathFor } from "../local-autopilot/run-worktree.js";
import type { RunEvent } from "../local-autopilot/types.js";

test("allows internal worktree symlinks and missing descendants, while rejecting external and dangling links", () => {
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

test("state path boundary rejects symlink ancestors and leaves before access", () => {
	const aliases = [
		".pelaggio",
		".pelaggio/runs",
		".pelaggio/runs/run",
		".pelaggio/runs/run/events.jsonl",
		".pelaggio/runs/run/lease",
		".pelaggio/runs/run/artifacts",
		".pelaggio/runs/run/artifacts/digest.json",
		".pelaggio/runs/by-request",
		".pelaggio/runs/by-request/request",
		".pelaggio/runs/request-locks",
		".pelaggio/runs/request-locks/digest",
		".pelaggio/worktrees",
		".pelaggio/worktrees/run",
	];
	for (const alias of aliases) {
		const cwd = mkdtempSync(join(tmpdir(), "pelaggio-paths-"));
		try {
			const outside = join(cwd, "outside");
			mkdirSync(outside);
			const target = join(cwd, alias);
			mkdirSync(dirname(target), { recursive: true });
			symlinkSync(outside, target);
			assert.throws(() => checkedStatePath(cwd, ...alias.split("/").slice(1)), /symlink/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});

test("ordinary internal state paths resolve and all named helpers share the boundary", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pelaggio-paths-"));
	try {
		for (const path of [runDir(cwd, "run"), eventsPath(cwd, "run"), leasePath(cwd, "run"), requestIndexPath(cwd, "request"), requestLockPath(cwd, "digest"), worktreePathFor(cwd, "run")]) assert.ok(path.startsWith(join(cwd, ".pelaggio")));
		assert.throws(() => runDir(cwd, "../escape"));
		assert.throws(() => worktreePathFor(cwd, "../escape"));
		assert.throws(() => checkedStatePath(cwd, "../../escape"));
		mkdirSync(join(cwd, "outside"));
		symlinkSync("outside", join(cwd, ".pelaggio"));
		for (const get of [() => runDir(cwd, "run"), () => eventsPath(cwd, "run"), () => leasePath(cwd, "run"), () => requestIndexPath(cwd, "request"), () => requestLockPath(cwd, "digest"), () => worktreePathFor(cwd, "run")])
			assert.throws(get, /symlink/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("journal reads, appends, and cancellation preserve a symlink target", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pelaggio-paths-"));
	try {
		const target = join(cwd, "outside.jsonl");
		writeFileSync(target, "preserved\n");
		mkdirSync(runDir(cwd, "run"), { recursive: true });
		symlinkSync(target, eventsPath(cwd, "run"));
		assert.throws(() => readRunEvents(cwd, "run"), /symlink/);
		assert.throws(() => appendRunEvent(cwd, { runId: "run" } as RunEvent), /symlink/);
		const result = await cancelRun(cwd, "run");
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.problem.message, /symlink/);
		assert.equal(readFileSync(target, "utf8"), "preserved\n");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
