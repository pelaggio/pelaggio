import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { checkpoint, filesChangedSince, getHeadSha, hasDeliverableCommits, quarantineCheckpoint } from "../git.js";

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

describe("filesChangedSince", () => {
	it("returns [] when preSha is null", () => {
		assert.deepEqual(filesChangedSince("/does/not/matter", null), []);
	});

	it("returns [] when preSha matches HEAD (no-op)", () => {
		const dir = makeFeatRepo();
		const head = getHeadSha(dir);
		assert.ok(head);
		assert.deepEqual(filesChangedSince(dir, head), []);
	});
});

describe("hasDeliverableCommits", () => {
	it("returns true when branch has a non-plan code commit", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "src/foo.ts", "export const x = 1;\n", "feat code");
		assert.equal(hasDeliverableCommits(dir), true);
	});

	it("returns false when branch only touches docs/plans/ (plan-only ghost)", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "docs/plans/x.md", "# plan\n", "docs plan");
		assert.equal(hasDeliverableCommits(dir), false);
	});

	it("returns true for doc-only work outside docs/plans/ (rubric/skill edits)", () => {
		const dir = makeFeatRepo();
		commitFile(dir, ".claude/skills/_rubric.md", "# rubric\n", "rubric edit");
		assert.equal(hasDeliverableCommits(dir), true);
	});

	it("returns true for README-only edits (not a plan)", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "README.md", "# readme\n", "readme only");
		assert.equal(hasDeliverableCommits(dir), true);
	});

	it("returns true for docs/ edits that are not plans (e.g. roadmap)", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "docs/roadmap-core.md", "# roadmap\n", "roadmap edit");
		assert.equal(hasDeliverableCommits(dir), true);
	});

	it("returns false when branch is identical to main", () => {
		const dir = makeFeatRepo();
		assert.equal(hasDeliverableCommits(dir), false);
	});

	it("returns false for a non-existent worktree (no throw)", () => {
		assert.equal(hasDeliverableCommits("/nonexistent/path/does/not/exist"), false);
	});

	it("returns true when branch has plan + code commits", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "docs/plans/x.md", "# plan\n", "plan");
		commitFile(dir, "src/foo.ts", "export const x = 1;\n", "code");
		assert.equal(hasDeliverableCommits(dir), true);
	});

	it("returns false when feat branch is plan-only but main advanced independently", () => {
		// Regression for two-dot vs three-dot diff: if main has moved forward
		// with code/doc commits since the feat branch was created, a two-dot
		// diff (`main..HEAD`) would show those files too and falsely credit
		// the feat branch with them. Three-dot (`main...HEAD`) only counts
		// changes on the feat branch side.
		const dir = makeFeatRepo();
		commitFile(dir, "docs/plans/x.md", "# plan\n", "plan-only on feat");
		execSync("git checkout -q main", { cwd: dir });
		commitFile(dir, "src/unrelated.ts", "export const y = 2;\n", "main moved ahead");
		execSync("git checkout -q feat/tool-99", { cwd: dir });
		assert.equal(hasDeliverableCommits(dir), false);
	});
});

describe("checkpoint — unresolved merge refusal (#424)", () => {
	it("refuses to conclude an unresolved merge: no commit, MERGE_HEAD and markers intact", () => {
		const dir = makeConflictedFeatRepo();
		const before = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
		assert.equal(checkpoint(dir, "test"), false);
		assert.equal(execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim(), before, "no commit may land");
		assert.equal(execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: dir, encoding: "utf-8" }).trim().length > 0, true, "merge stays open");
		assert.match(readFileSync(join(dir, "f.txt"), "utf-8"), /^<{7} /m, "markers stay in the working tree");
		assert.match(execSync("git diff --name-only --diff-filter=U", { cwd: dir, encoding: "utf-8" }), /f\.txt/, "unmerged state is preserved");
	});

	it("still commits a resolved-and-staged merge (concluding it) as before", () => {
		const dir = makeConflictedFeatRepo();
		writeFileSync(join(dir, "f.txt"), "resolved\n");
		execSync("git add f.txt", { cwd: dir });
		assert.equal(checkpoint(dir, "merge done"), true);
		assert.throws(() => execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: dir, stdio: "pipe" }), "merge must be concluded");
		assert.equal(execSync("git log -1 --format=%P", { cwd: dir, encoding: "utf-8" }).trim().split(" ").length, 2, "two-parent merge commit");
	});

	// #424 gate fix (rate-limit-during-repair interleave): mid-repair the author has
	// `git add`-ed the conflicted file with its markers intact — unmerged-path state is
	// empty, so the original refusal above is blind — and a rate-limit park then calls
	// this unguarded checkpoint while MERGE_HEAD is still open.
	it("refuses the rate-limit-park interleave: staged conflict markers with MERGE_HEAD open never commit", () => {
		const dir = makeConflictedFeatRepo();
		execSync("git add f.txt", { cwd: dir });
		assert.equal(execSync("git diff --name-only --diff-filter=U", { cwd: dir, encoding: "utf-8" }).trim(), "", "precondition: staging cleared unmerged-path state — the unmerged-path guard alone is blind here");
		const before = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
		assert.equal(checkpoint(dir, "rate-limit park"), false);
		assert.equal(execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim(), before, "no commit may land");
		assert.equal(execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: dir, encoding: "utf-8" }).trim().length > 0, true, "merge stays open for resume to re-enter `conflicted`");
		assert.match(readFileSync(join(dir, "f.txt"), "utf-8"), /^<{7} /m, "markers stay observable in the working tree");
	});

	it("conservatively refuses ANY staged marker lines while a merge is open (conflicted set unknown at this choke point)", () => {
		const dir = makeConflictedFeatRepo();
		writeFileSync(join(dir, "f.txt"), "resolved\n");
		execSync("git add f.txt", { cwd: dir });
		// A separate file with a marker-shaped line (setext underline). With MERGE_HEAD open the
		// checkpoint cannot know the conflicted set, so it must fail closed and park dirty.
		writeFileSync(join(dir, "notes.md"), "Heading\n=======\nbody\n");
		assert.equal(checkpoint(dir, "rate-limit park"), false);
		assert.equal(execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: dir, encoding: "utf-8" }).trim().length > 0, true, "merge stays open");
	});
});

describe("checkpoint", () => {
	it("returns false silently on a clean tree (git reports on stdout, stderr is empty string)", () => {
		const dir = makeFeatRepo();
		const writes: string[] = [];
		const orig = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			writes.push(chunk.toString());
			return true;
		}) as typeof process.stderr.write;
		try {
			assert.equal(checkpoint(dir, "test"), false);
		} finally {
			process.stderr.write = orig;
		}
		assert.deepEqual(
			writes.filter((w) => w.includes("checkpoint commit failed")),
			[],
			`clean tree must not warn; got:\n${writes.join("")}`,
		);
	});

	it("returns true and commits when the tree is dirty", () => {
		const dir = makeFeatRepo();
		writeFileSync(resolve(dir, "f.txt"), "x");
		assert.equal(checkpoint(dir, "test"), true);
		const log = execSync("git log --format=%s -1", { cwd: dir, encoding: "utf-8" }).trim();
		assert.equal(log, "wip: pelaggio test");
	});
});

describe("quarantineCheckpoint", () => {
	it("commits a dirty tree and leaves it clean", () => {
		const dir = makeFeatRepo();
		writeFileSync(resolve(dir, "wip.txt"), "work");
		assert.equal(quarantineCheckpoint(dir, "andon quarantine"), true);
		assert.equal(execSync("git status --porcelain", { cwd: dir, encoding: "utf-8" }).trim(), "");
	});

	it("accepts an already-clean tree", () => {
		assert.equal(quarantineCheckpoint(makeFeatRepo(), "andon quarantine"), true);
	});

	it("fails closed outside a git repository", () => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-quarantine-"));
		assert.equal(quarantineCheckpoint(dir, "andon quarantine"), false);
	});
});
