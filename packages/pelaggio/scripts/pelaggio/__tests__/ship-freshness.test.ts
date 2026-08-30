import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { ensureMainCheckoutOnBranch, parseShipMerged, preparePrShipFreshness, verifyConflictRepairComplete, verifyPrShipFreshness, verifyShipLanded } from "../ship/freshness.js";

function makeFeatRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pelaggio-helpers-test-"));
	execSync("git init -q -b main", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config commit.gpgsign false", { cwd: dir });
	execSync("git commit --allow-empty -q -m init", { cwd: dir });
	execSync("git checkout -q -b feat/tool-99", { cwd: dir });
	return dir;
}

function commitFile(dir: string, rel: string, content: string, msg: string): void {
	const full = resolve(dir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
	execSync("git add -A", { cwd: dir });
	execSync(`git commit -q -m "${msg}"`, { cwd: dir });
}

function initBareGit(dir: string): void {
	execSync("git init -q -b main", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config commit.gpgsign false", { cwd: dir });
	execSync("git commit --allow-empty -q -m init", { cwd: dir });
}

function makeFreshnessPair(): { worktree: string; origin: string } {
	const origin = mkdtempSync(join(tmpdir(), "pelaggio-fresh-origin-"));
	initBareGit(origin);
	const worktree = mkdtempSync(join(tmpdir(), "pelaggio-fresh-wt-"));
	execSync(`git clone -q ${JSON.stringify(origin)} ${JSON.stringify(worktree)}`);
	execSync("git config user.name t", { cwd: worktree });
	execSync("git config user.email t@t", { cwd: worktree });
	execSync("git config commit.gpgsign false", { cwd: worktree });
	execSync("git checkout -q -b feat/tool-99", { cwd: worktree });
	return { worktree, origin };
}

/** Local two-branch conflict on f.txt: worktree left mid-merge (MERGE_HEAD + markers). */
function makeConflictedFeatRepo(): string {
	const dir = makeFeatRepo();
	commitFile(dir, "f.txt", "feat\n", "feat side");
	execSync("git checkout -q main", { cwd: dir });
	commitFile(dir, "f.txt", "main\n", "main side");
	execSync("git checkout -q feat/tool-99", { cwd: dir });
	try {
		execSync("git merge --no-edit main", { cwd: dir, stdio: "pipe" });
	} catch {
		// conflict expected
	}
	return dir;
}

describe("preparePrShipFreshness / verifyPrShipFreshness", () => {
	it("returns up-to-date without invoking merge when origin/main is already an ancestor", () => {
		const { worktree } = makeFreshnessPair();
		const argv: string[][] = [];
		const result = preparePrShipFreshness(worktree, (args, cwd) => {
			argv.push([...args]);
			return execSync(`git ${args.map((a) => JSON.stringify(a)).join(" ")}`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		assert.equal(result.kind, "up-to-date");
		if (result.kind !== "up-to-date") return;
		// The retained OID is the fetched origin/main tip, resolved immediately post-fetch.
		assert.equal(result.originMainOid, execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim());
		assert.ok(argv.some((a) => a[0] === "fetch" && a[1] === "origin" && a[2] === "main"));
		assert.ok(!argv.some((a) => a[0] === "merge"));
		assert.deepEqual(verifyPrShipFreshness(worktree, result.originMainOid), { ok: true });
	});

	it("merges a branch behind origin/main and records only upstream-side touched paths (three-dot)", () => {
		const { worktree, origin } = makeFreshnessPair();
		// A branch-side commit must NOT appear in upstreamTouchedFiles: two-dot
		// `HEAD..origin/main` would list it (the endpoint trees differ); three-dot
		// lists only the upstream side since the merge-base.
		commitFile(worktree, "src/feature.ts", "export const feat = 1;\n", "feat side");
		commitFile(origin, "src/upstream.ts", "export const up = 1;\n", "upstream");
		commitFile(origin, "docs/note.md", "note\n", "upstream docs");
		const result = preparePrShipFreshness(worktree);
		assert.equal(result.kind, "merged");
		if (result.kind !== "merged") return;
		assert.deepEqual(result.upstreamTouchedFiles.sort(), ["docs/note.md", "src/upstream.ts"]);
		assert.equal(existsSync(join(worktree, "src/upstream.ts")), true);
		assert.deepEqual(verifyPrShipFreshness(worktree, result.originMainOid), { ok: true });
	});

	it("TOCTOU: origin/main moved to an older ancestor between fetch and verify fails naming both OIDs", () => {
		const { worktree, origin } = makeFreshnessPair();
		const olderOid = execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim();
		commitFile(origin, "src/upstream.ts", "export const up = 1;\n", "upstream");
		const result = preparePrShipFreshness(worktree);
		assert.equal(result.kind, "merged");
		if (result.kind !== "merged") return;
		const fetchedOid = result.originMainOid;
		assert.notEqual(fetchedOid, olderOid);
		// Simulate the writable author step moving the shared remote-tracking ref back to
		// an older ancestor (the tree stays clean and still contains the older tip).
		execSync(`git update-ref refs/remotes/origin/main ${olderOid}`, { cwd: worktree });
		const verified = verifyPrShipFreshness(worktree, fetchedOid);
		assert.equal(verified.ok, false);
		if (verified.ok) return;
		assert.ok(verified.detail.includes(fetchedOid), `detail names the fetched OID: ${verified.detail}`);
		assert.ok(verified.detail.includes(olderOid), `detail names the moved-to OID: ${verified.detail}`);
		assert.match(verified.detail, /moved after fetch/);
	});

	it("returns conflicted and leaves MERGE_HEAD when the merge has unmerged paths", () => {
		const { worktree, origin } = makeFreshnessPair();
		commitFile(worktree, "shared.ts", "feat\n", "feat edit");
		commitFile(origin, "shared.ts", "main\n", "main edit");
		const argv: string[][] = [];
		const result = preparePrShipFreshness(worktree, (args, cwd) => {
			argv.push([...args]);
			return execSync(`git ${args.map((a) => JSON.stringify(a)).join(" ")}`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		assert.equal(result.kind, "conflicted");
		if (result.kind !== "conflicted") return;
		assert.ok(result.unmergedFiles.includes("shared.ts"));
		assert.ok(result.upstreamTouchedFiles.includes("shared.ts"));
		assert.equal(result.originMainOid, execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim());
		assert.equal(execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: worktree, encoding: "utf-8" }).trim().length > 0, true);
		assert.ok(!argv.some((a) => a[0] === "merge" && a.includes("--abort")));
		assert.ok(!argv.some((a) => a[0] === "reset" || a[0] === "clean"));
		assert.equal(verifyPrShipFreshness(worktree, result.originMainOid!).ok, false);
	});

	it("treats an already-conflicted input (MERGE_HEAD) as conflicted without fetching or merging again", () => {
		const { worktree, origin } = makeFreshnessPair();
		commitFile(worktree, "shared.ts", "feat\n", "feat edit");
		commitFile(origin, "shared.ts", "main\n", "main edit");
		const first = preparePrShipFreshness(worktree);
		assert.equal(first.kind, "conflicted");
		const argv: string[][] = [];
		const second = preparePrShipFreshness(worktree, (args, cwd) => {
			argv.push([...args]);
			return execSync(`git ${args.map((a) => JSON.stringify(a)).join(" ")}`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		assert.equal(second.kind, "conflicted");
		if (second.kind !== "conflicted") return;
		assert.ok(second.unmergedFiles.includes("shared.ts"));
		// No fetch on the resume path, but the OID observed before the author step is still retained.
		assert.equal(second.originMainOid, execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim());
		assert.ok(!argv.some((a) => a[0] === "fetch" || a[0] === "merge"));
		assert.equal(execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: worktree, encoding: "utf-8" }).trim().length > 0, true);
	});

	it("returns failed with bounded detail on fetch failure, missing origin, dirty-without-merge, and non-conflict merge failure", () => {
		const dirty = makeFeatRepo();
		writeFileSync(join(dirty, "loose.txt"), "x");
		const dirtyResult = preparePrShipFreshness(dirty);
		assert.equal(dirtyResult.kind, "failed");
		if (dirtyResult.kind === "failed") assert.match(dirtyResult.detail, /dirty/);

		const noOrigin = makeFeatRepo();
		const missing = preparePrShipFreshness(noOrigin);
		assert.equal(missing.kind, "failed");
		if (missing.kind === "failed") {
			assert.ok(missing.detail.length > 0);
			assert.ok(missing.detail.length <= 300);
		}

		const argv: string[][] = [];
		const fake = preparePrShipFreshness("/tmp/freshness-argv", (args) => {
			argv.push([...args]);
			const key = args.join(" ");
			if (key === "rev-parse -q --verify MERGE_HEAD") throw new Error("no merge");
			if (key === "diff --name-only --diff-filter=U") return "";
			if (key === "status --porcelain") return "";
			if (key === "fetch origin main") return "";
			if (key === "rev-parse --verify origin/main") return "abc";
			// Post-fetch checks and the merge itself run against the retained OID, never the ref name.
			if (key === "merge-base --is-ancestor abc HEAD") throw new Error("behind");
			if (key === "diff --name-only HEAD...abc") return "src/a.ts\n";
			if (key === "merge --no-edit abc") throw Object.assign(new Error("not a fast-forward"), { stderr: "fatal: refusing to merge unrelated histories" });
			throw new Error(`unexpected argv: ${key}`);
		});
		assert.equal(fake.kind, "failed");
		if (fake.kind === "failed") assert.match(fake.detail, /unrelated histories/);
		assert.deepEqual(argv[0], ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
		assert.ok(argv.every((a) => Array.isArray(a)));
		assert.ok(!argv.some((a) => a[0] === "merge" && a.includes("--abort")));
		assert.ok(!argv.some((a) => a[0] === "reset" || a[0] === "clean"));
	});

	it("post-author verification accepts only clean, conflict-free branches containing the fetched OID", () => {
		const { worktree, origin } = makeFreshnessPair();
		const fetchedOid = execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim();
		assert.deepEqual(verifyPrShipFreshness(worktree, fetchedOid), { ok: true });

		writeFileSync(join(worktree, "dirty.txt"), "x");
		assert.equal(verifyPrShipFreshness(worktree, fetchedOid).ok, false);
		execSync("git clean -fdq", { cwd: worktree });

		commitFile(origin, "src/more.ts", "more\n", "more upstream");
		// The fetched OID no longer being an ancestor fails; force the probe via argv.
		const stale = verifyPrShipFreshness(worktree, "def", (args) => {
			const key = args.join(" ");
			if (key === "rev-parse -q --verify MERGE_HEAD") throw new Error("no merge");
			if (key === "diff --name-only --diff-filter=U") return "";
			if (key === "status --porcelain") return "";
			if (key === "rev-parse --verify origin/main") return "def";
			if (key === "merge-base --is-ancestor def HEAD") throw new Error("not ancestor");
			throw new Error(`unexpected argv: ${key}`);
		});
		assert.equal(stale.ok, false);
		if (!stale.ok) assert.match(stale.detail, /ancestor/);

		const unresolved = verifyPrShipFreshness(worktree, fetchedOid, (args) => {
			const key = args.join(" ");
			if (key === "rev-parse -q --verify MERGE_HEAD") return "mergehead";
			throw new Error(`unexpected argv: ${key}`);
		});
		assert.equal(unresolved.ok, false);
		if (!unresolved.ok) assert.match(unresolved.detail, /MERGE_HEAD/);
	});

	it("never interpolates the worktree path into git argv", () => {
		const seen: string[][] = [];
		preparePrShipFreshness("/tmp/some worktree/with spaces", (args) => {
			seen.push([...args]);
			throw new Error("stop");
		});
		assert.ok(seen.length > 0);
		for (const args of seen) {
			assert.ok(!args.some((a) => a.includes("/tmp/some worktree")));
			assert.ok(!args.join(" ").includes("git -C"));
		}
	});
});

describe("verifyConflictRepairComplete (#424)", () => {
	it("fails while git unmerged-path state remains (no-op repair)", () => {
		const dir = makeConflictedFeatRepo();
		const result = verifyConflictRepairComplete(dir, ["f.txt"]);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.detail, /unmerged paths remain: f\.txt/);
	});

	it("fails when a formerly-conflicted file was staged with its markers intact", () => {
		const dir = makeConflictedFeatRepo();
		execSync("git add f.txt", { cwd: dir });
		const result = verifyConflictRepairComplete(dir, ["f.txt"]);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.detail, /conflict markers remain in: f\.txt/);
	});

	it("passes once the file is genuinely resolved and staged", () => {
		const dir = makeConflictedFeatRepo();
		writeFileSync(join(dir, "f.txt"), "resolved\n");
		execSync("git add f.txt", { cwd: dir });
		assert.deepEqual(verifyConflictRepairComplete(dir, ["f.txt"]), { ok: true });
	});

	it("treats deletion of a conflicted file as a legitimate resolution", () => {
		const dir = makeConflictedFeatRepo();
		execSync("git rm -q -f f.txt", { cwd: dir });
		assert.deepEqual(verifyConflictRepairComplete(dir, ["f.txt"]), { ok: true });
	});

	it("scans only the listed files: markers elsewhere do not trip the gate", () => {
		const dir = makeConflictedFeatRepo();
		writeFileSync(join(dir, "f.txt"), "resolved\n");
		execSync("git add f.txt", { cwd: dir });
		// A doc legitimately containing a seven-equals line, never part of the conflict set.
		writeFileSync(join(dir, "notes.md"), "Heading\n=======\nbody\n");
		assert.deepEqual(verifyConflictRepairComplete(dir, ["f.txt"]), { ok: true });
		const flagged = verifyConflictRepairComplete(dir, ["f.txt", "notes.md"]);
		assert.equal(flagged.ok, false, "the same content IS flagged when the file was conflicted");
	});
});

describe("verifyShipLanded", () => {
	it("returns true when main advanced (feat merged in)", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "src/foo.ts", "export const x = 1;\n", "feat code");
		const featSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
		execSync("git checkout -q main", { cwd: dir });
		const mainBefore = execSync("git rev-parse main", { cwd: dir, encoding: "utf-8" }).trim();
		execSync("git merge feat/tool-99 --no-edit -q", { cwd: dir });
		assert.equal(verifyShipLanded(dir, mainBefore, featSha), true);
	});

	it("returns false when main did not advance (ghost-ship)", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "src/foo.ts", "export const x = 1;\n", "feat code");
		const featSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
		const mainSha = execSync("git rev-parse main", { cwd: dir, encoding: "utf-8" }).trim();
		// main never merged the feat branch.
		assert.equal(verifyShipLanded(dir, mainSha, featSha), false);
	});

	it("fails closed: a git error during verification returns false (routes to /shipwreck, not a blind push)", () => {
		assert.equal(verifyShipLanded("/nonexistent/path/does/not/exist", "deadbeef", "cafebabe"), false);
	});
});

describe("ensureMainCheckoutOnBranch", () => {
	it("returns true and does nothing when already on the target branch", () => {
		const dir = makeFeatRepo();
		execSync("git checkout -q main", { cwd: dir });
		assert.equal(
			ensureMainCheckoutOnBranch(dir, "main", () => assert.fail("should not log")),
			true,
		);
		assert.equal(execSync("git branch --show-current", { cwd: dir, encoding: "utf-8" }).trim(), "main");
	});

	it("reattaches and returns true when on a different branch", () => {
		const dir = makeFeatRepo(); // checked out on feat/tool-99
		const messages: string[] = [];
		assert.equal(
			ensureMainCheckoutOnBranch(dir, "main", (m) => messages.push(m)),
			true,
		);
		assert.equal(execSync("git branch --show-current", { cwd: dir, encoding: "utf-8" }).trim(), "main");
		assert.match(messages[0], /feat\/tool-99/);
	});

	it("reattaches and returns true when HEAD is detached", () => {
		const dir = makeFeatRepo();
		execSync("git checkout -q main", { cwd: dir });
		const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
		execSync(`git checkout -q ${sha}`, { cwd: dir });
		assert.equal(execSync("git branch --show-current", { cwd: dir, encoding: "utf-8" }).trim(), "");
		const messages: string[] = [];
		assert.equal(
			ensureMainCheckoutOnBranch(dir, "main", (m) => messages.push(m)),
			true,
		);
		assert.equal(execSync("git branch --show-current", { cwd: dir, encoding: "utf-8" }).trim(), "main");
		assert.match(messages[0], /detached HEAD/);
	});

	it("fails closed: a nonexistent repo returns false", () => {
		assert.equal(
			ensureMainCheckoutOnBranch("/nonexistent/path/does/not/exist", "main", () => {}),
			false,
		);
	});
});

describe("parseShipMerged", () => {
	it("parses a plain markdown ID", () => {
		assert.equal(parseShipMerged("ship-merged: TOOL-99"), "TOOL-99");
	});

	it("parses a nested/hierarchical ID", () => {
		assert.equal(parseShipMerged("ship-merged: COMP-11C-II"), "COMP-11C-II");
	});

	it("parses a bare numeric github ID", () => {
		assert.equal(parseShipMerged("ship-merged: 37"), "37");
	});

	it("returns null when absent", () => {
		assert.equal(parseShipMerged("nothing to see here"), null);
	});

	it("last occurrence wins when repeated", () => {
		const text = "ship-merged: TOOL-1\nsummary...\nship-merged: TOOL-2\n";
		assert.equal(parseShipMerged(text), "TOOL-2");
	});

	it("rejects malformed values", () => {
		assert.equal(parseShipMerged("ship-merged: foo bar"), null);
		assert.equal(parseShipMerged("ship-merged: "), null);
	});

	it("tolerates surrounding whitespace and a trailing report line", () => {
		assert.equal(parseShipMerged("   ship-merged:  TOOL-99   "), "TOOL-99");
		assert.equal(parseShipMerged("Merged and verified.\nship-merged: TOOL-99\n"), "TOOL-99");
	});

	it("preserves case (returns the raw token, not lowercased)", () => {
		assert.equal(parseShipMerged("ship-merged: Tool-99"), "Tool-99");
	});
});
