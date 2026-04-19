import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
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
