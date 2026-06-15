import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { activeClaim, readClaims, writeClaims } from "../claim-ledger.js";
import { MarkdownRoadmap } from "../roadmap/index.js";
import { main, setRoadmapFactory } from "../roadmap-cli.js";

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "autopilot-cli-test-"));
	execSync("git init -q -b main", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config commit.gpgsign false", { cwd: dir });
	execSync("git commit --allow-empty -q -m init", { cwd: dir });
	return dir;
}

function seed(dir: string, rel: string, body: string): void {
	const full = resolve(dir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body);
}

function captureStdout<T>(run: () => Promise<T>): Promise<{ code: T; stdout: string; stderr: string }> {
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	let out = "";
	let err = "";
	(process.stdout as unknown as { write: (s: string) => boolean }).write = ((s: string) => {
		out += typeof s === "string" ? s : String(s);
		return true;
	}) as typeof process.stdout.write;
	(process.stderr as unknown as { write: (s: string) => boolean }).write = ((s: string) => {
		err += typeof s === "string" ? s : String(s);
		return true;
	}) as typeof process.stderr.write;
	return run()
		.then((code) => ({ code, stdout: out, stderr: err }))
		.finally(() => {
			process.stdout.write = origOut;
			process.stderr.write = origErr;
		});
}

describe("roadmap-cli", () => {
	let repo: string;

	before(() => {
		repo = makeRepo();
		setRoadmapFactory(() => new MarkdownRoadmap({ repo }));
		seed(repo, "docs/roadmap-core.md", ["# Core", "", "| Item | Depends on |", "|---|---|", "| TOOL-1. First item | — |", "| TOOL-2. Second item | blocked: waiting on X |", "", "## Recently completed", "", "- TOOL-0 ✓", ""].join("\n"));
		seed(repo, "docs/task-index.md", "| TOOL-1 | First item | — | — | core |\n| TOOL-2 | Second item | blocked | — | core |\n");
		execSync("git add -A && git commit -q -m seed", { cwd: repo });
	});

	after(() => {
		// no-op
	});

	it("source prints configured name", async () => {
		const res = await captureStdout(() => main(["source"]));
		assert.equal(res.code, 0);
		assert.match(res.stdout, /markdown/);
	});

	it("list emits JSON with status field", async () => {
		const res = await captureStdout(() => main(["list", "--json"]));
		assert.equal(res.code, 0);
		const parsed = JSON.parse(res.stdout);
		assert.ok(Array.isArray(parsed));
		const tool1 = parsed.find((p: { id: string }) => p.id === "TOOL-1");
		assert.equal(tool1.status, "open");
		const tool2 = parsed.find((p: { id: string }) => p.id === "TOOL-2");
		assert.equal(tool2.status, "blocked");
	});

	it("get returns exit 2 for unknown id", async () => {
		const res = await captureStdout(() => main(["get", "ZZZ-999"]));
		assert.equal(res.code, 2);
	});

	it("get returns done status for item in Recently completed", async () => {
		const res = await captureStdout(() => main(["get", "TOOL-0", "--json"]));
		assert.equal(res.code, 0);
		const parsed = JSON.parse(res.stdout);
		assert.equal(parsed.status, "done");
	});

	it("plan-path prints adapter-resolved path and exits 2 when missing", async () => {
		const res = await captureStdout(() => main(["plan-path", "--id", "TOOL-1", "--worktree", repo]));
		assert.equal(res.code, 2);
		assert.match(res.stdout, /docs\/plans\/tool-1\.md/);
	});

	it("unknown subcommand returns exit 1", async () => {
		const res = await captureStdout(() => main(["bogus"]));
		assert.equal(res.code, 1);
	});
});

const DEAD_PID = 2_147_483_646; // implausibly high → ESRCH

describe("roadmap-cli claim ledger", () => {
	let repo: string;
	const createdWorktrees: string[] = [];
	let prevMain: string | undefined;
	let prevOwner: string | undefined;
	let prevPrefix: string | undefined;

	before(() => {
		repo = makeRepo();
		// TOOL-1 + TOOL-3 open, TOOL-2 blocked — TOOL-3 stays unclaimed so the
		// overlay test can show open-stays-open while the claimed item flips.
		seed(repo, "docs/roadmap-core.md", ["# Core", "", "| Item | Depends on |", "|---|---|", "| TOOL-1. First item | — |", "| TOOL-2. Second item | blocked: waiting on X |", "| TOOL-3. Third item | — |", ""].join("\n"));
		seed(repo, "docs/task-index.md", "| TOOL-1 | First item | — | — | core |\n| TOOL-2 | Second item | blocked | — | core |\n| TOOL-3 | Third item | — | — | core |\n");
		execSync("git add -A && git commit -q -m seed", { cwd: repo });
		setRoadmapFactory(() => new MarkdownRoadmap({ repo }));

		prevMain = process.env.CLAUDE_AUTOPILOT_MAIN_REPO;
		prevOwner = process.env.AUTOPILOT_OWNER_PID;
		prevPrefix = process.env.CLAUDE_AUTOPILOT_WORKTREE_PREFIX;
		process.env.CLAUDE_AUTOPILOT_MAIN_REPO = repo; // ledger lives under this repo's .dev/
		process.env.AUTOPILOT_OWNER_PID = String(process.pid); // recorded claims read as live
		process.env.CLAUDE_AUTOPILOT_WORKTREE_PREFIX = "wt-"; // predictable sibling worktree path
	});

	after(() => {
		for (const w of createdWorktrees) {
			try {
				execSync(`git worktree remove --force ${JSON.stringify(w)}`, { cwd: repo, stdio: "pipe" });
			} catch {
				/* ignore */
			}
			rmSync(w, { recursive: true, force: true });
		}
		restoreEnv("CLAUDE_AUTOPILOT_MAIN_REPO", prevMain);
		restoreEnv("AUTOPILOT_OWNER_PID", prevOwner);
		restoreEnv("CLAUDE_AUTOPILOT_WORKTREE_PREFIX", prevPrefix);
	});

	function restoreEnv(key: string, prev: string | undefined): void {
		if (prev === undefined) delete process.env[key];
		else process.env[key] = prev;
	}

	it("claim records a claim and prints branch/worktree", async () => {
		const res = await captureStdout(() => main(["claim", "TOOL-1"]));
		assert.equal(res.code, 0);
		assert.match(res.stdout, /branch=feat\/tool-1/);
		const m = res.stdout.match(/worktree=(.+)/);
		assert.ok(m, "expected worktree= line");
		createdWorktrees.push(m[1].trim());
		assert.ok(activeClaim(repo, "TOOL-1"), "claim should be recorded in the ledger");
	});

	it("second claim while the first is active → exit 3 + already-claimed", async () => {
		const res = await captureStdout(() => main(["claim", "TOOL-1"]));
		assert.equal(res.code, 3);
		assert.match(res.stdout, /claim-result: already-claimed/);
		// Case-insensitive: a different-cased id matches the canonical key too.
		const lower = await captureStdout(() => main(["claim", "tool-1"]));
		assert.equal(lower.code, 3);
	});

	it("list overlays in-progress on the claimed item only", async () => {
		const res = await captureStdout(() => main(["list", "--json"]));
		assert.equal(res.code, 0);
		const parsed = JSON.parse(res.stdout);
		assert.equal(parsed.find((p: { id: string }) => p.id === "TOOL-1").status, "in-progress");
		assert.equal(parsed.find((p: { id: string }) => p.id === "TOOL-3").status, "open");
		assert.equal(parsed.find((p: { id: string }) => p.id === "TOOL-2").status, "blocked");
	});

	it("get overlays in-progress on the claimed item", async () => {
		const res = await captureStdout(() => main(["get", "TOOL-1", "--json"]));
		assert.equal(res.code, 0);
		assert.equal(JSON.parse(res.stdout).status, "in-progress");
	});

	it("mark-done releases the claim and the item is no longer in-progress", async () => {
		const res = await captureStdout(() => main(["mark-done", "TOOL-1"]));
		assert.equal(res.code, 0);
		assert.equal(activeClaim(repo, "TOOL-1"), null, "claim should be released");
		const list = await captureStdout(() => main(["list", "--json"]));
		const t1 = JSON.parse(list.stdout).find((p: { id: string }) => p.id === "TOOL-1");
		assert.ok(t1?.status !== "in-progress", "TOOL-1 should not be in-progress after release");
	});

	it("a reaped (dead-pid) claim does not overlay in-progress", async () => {
		// TOOL-3 is open and unclaimed; inject a dead-pid claim directly.
		writeClaims(repo, { ...readClaims(repo), "tool-3": { id: "TOOL-3", branch: "feat/tool-3", worktree: repo, claimedAt: 1, pid: DEAD_PID } });
		const res = await captureStdout(() => main(["list", "--json"]));
		const t3 = JSON.parse(res.stdout).find((p: { id: string }) => p.id === "TOOL-3");
		assert.equal(t3.status, "open");
	});
});
