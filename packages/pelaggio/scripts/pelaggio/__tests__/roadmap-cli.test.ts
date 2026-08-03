import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { MarkdownRoadmap, type RoadmapSource } from "../roadmap/index.js";
import { main, setRoadmapFactory } from "../roadmap-cli.js";

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pelaggio-cli-test-"));
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

function stubRoadmap(items: Awaited<ReturnType<RoadmapSource["listItems"]>>, calls: { list: number; claim: number }): RoadmapSource {
	return {
		name: "markdown",
		async listOpenItems() {
			return items.filter((item) => item.status === "open");
		},
		async listItems(opts) {
			assert.deepEqual(opts, { includeDone: true });
			calls.list++;
			return items;
		},
		async getItem() {
			return null;
		},
		async claimItem() {
			calls.claim++;
			return { branch: "unused", worktree: "unused" };
		},
		async markDone() {},
		async getItemPlan() {
			return null;
		},
		resolvePlanPath() {
			return "unused";
		},
		async publishPlan() {},
		async createItem({ title }) {
			return { id: "NEW-1", title, deps: "—", sourceRef: "unused" };
		},
		async archivePlan() {},
		isCharterPickRace() {
			return false;
		},
		async parseItemId() {
			return null;
		},
	};
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

	// Tests that install a stub factory (next, create-item) must not leak it into
	// the tests that follow — restore the seeded markdown factory after each.
	afterEach(() => {
		setRoadmapFactory(() => new MarkdownRoadmap({ repo }));
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

	it("next emits one ordered policy envelope without mutating the roadmap", async () => {
		const calls = { list: 0, claim: 0 };
		setRoadmapFactory(() =>
			stubRoadmap(
				[
					{ id: "TOOL-2", title: "Second", deps: "TOOL-1", sourceRef: "core", status: "open" },
					{ id: "TOOL-1", title: "First", deps: "—", sourceRef: "core", status: "done" },
					{ id: "TOOL-3", title: "Third", deps: "—", sourceRef: "core", status: "open" },
				],
				calls,
			),
		);
		const res = await captureStdout(() => main(["next", "--json"]));
		assert.equal(res.code, 0);
		const parsed = JSON.parse(res.stdout);
		assert.deepEqual(
			parsed.candidates.map(({ item }: { item: { id: string } }) => item.id),
			["TOOL-2", "TOOL-3"],
		);
		assert.equal(parsed.verdicts.length, 3);
		assert.deepEqual(calls, { list: 1, claim: 0 });
	});

	it("next returns an empty successful envelope", async () => {
		const calls = { list: 0, claim: 0 };
		setRoadmapFactory(() => stubRoadmap([{ id: "TOOL-1", title: "Done", deps: "—", sourceRef: "core", status: "done" }], calls));
		const res = await captureStdout(() => main(["next", "--topic", "missing", "--json"]));
		assert.equal(res.code, 0);
		assert.deepEqual(JSON.parse(res.stdout).candidates, []);
		assert.deepEqual(calls, { list: 1, claim: 0 });
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

	it("create-item accepts markdown bootstrap flags and emits JSON", async () => {
		const localRepo = makeRepo();
		mkdirSync(resolve(localRepo, "docs"), { recursive: true });
		setRoadmapFactory(() => new MarkdownRoadmap({ repo: localRepo }));

		const res = await captureStdout(() => main(["create-item", "--title", "New", "--to", "new-track", "--create", "--prefix", "NEW", "--format", "checkbox", "--json"]));
		assert.equal(res.code, 0);
		const parsed = JSON.parse(res.stdout);
		assert.equal(parsed.id, "NEW-1");
		assert.equal(parsed.title, "New");
		assert.match(parsed.sourceRef, /docs\/roadmap-new-track\.md$/);

		const roadmap = readFileSync(resolve(localRepo, "docs/roadmap-new-track.md"), "utf-8");
		assert.match(roadmap, /^- \[ \] \*\*NEW-1\. New\*\*/m);
	});

	it("create-item rejects invalid --format before writing files", async () => {
		const localRepo = makeRepo();
		mkdirSync(resolve(localRepo, "docs"), { recursive: true });
		setRoadmapFactory(() => new MarkdownRoadmap({ repo: localRepo }));

		const res = await captureStdout(() => main(["create-item", "--title", "New", "--to", "new-track", "--create", "--prefix", "NEW", "--format", "bogus", "--json"]));
		assert.equal(res.code, 1);
		assert.match(res.stderr, /--format checkbox\|table/);
		assert.equal(existsSync(resolve(localRepo, "docs/roadmap-new-track.md")), false);
	});

	it("next ranks by priority then FIFO and excludes deferred", async () => {
		const calls = { list: 0, claim: 0 };
		// list order becomes fifoOrdinal; mirrors GitHub ascending issue numbers after sort.
		setRoadmapFactory(() =>
			stubRoadmap(
				[
					{ id: "10", title: "Older normal", deps: "—", sourceRef: "acme#10", status: "open", priority: 2 },
					{ id: "15", title: "Deferred high", deps: "—", sourceRef: "acme#15", status: "open", priority: 1, deferred: true },
					{ id: "20", title: "Eligible high", deps: "—", sourceRef: "acme#20", status: "open", priority: 1 },
					{ id: "30", title: "Unlabeled normal", deps: "—", sourceRef: "acme#30", status: "open", priority: 2 },
				],
				calls,
			),
		);
		const res = await captureStdout(() => main(["next", "--json"]));
		assert.equal(res.code, 0);
		const parsed = JSON.parse(res.stdout);
		assert.deepEqual(
			parsed.candidates.map(({ item }: { item: { id: string } }) => item.id),
			["20", "10", "30"],
		);
		assert.equal(parsed.candidates[0].item.priority, 1);
		assert.equal(parsed.candidates[2].item.priority, 2);
		const deferredVerdict = parsed.verdicts.find((v: { id: string }) => v.id === "15");
		assert.equal(deferredVerdict.reason, "deferred");
		assert.equal(deferredVerdict.eligible, false);
		assert.equal(parsed.verdicts.length, 4);
		assert.deepEqual(calls, { list: 1, claim: 0 });
	});

	it("backfill-priority-labels rejects unsupported sources", async () => {
		const res = await captureStdout(() => main(["backfill-priority-labels"]));
		assert.equal(res.code, 1);
		assert.match(res.stderr, /not supported.*markdown/i);
	});

	it("backfill-priority-labels dispatches supported source and exits 0 on success", async () => {
		const base = stubRoadmap([], { list: 0, claim: 0 });
		const backfillCalls: number[] = [];
		setRoadmapFactory(() => ({
			...base,
			name: "github-issues",
			async backfillPriorityLabels() {
				backfillCalls.push(1);
				return { scanned: 5, labeled: 2, conflicts: [] };
			},
		}));
		const res = await captureStdout(() => main(["backfill-priority-labels", "--json"]));
		assert.equal(res.code, 0);
		assert.deepEqual(JSON.parse(res.stdout), { scanned: 5, labeled: 2, conflicts: [] });
		assert.equal(backfillCalls.length, 1);
	});

	it("backfill-priority-labels exits 1 on conflicts with JSON payload", async () => {
		const base = stubRoadmap([], { list: 0, claim: 0 });
		setRoadmapFactory(() => ({
			...base,
			name: "github-issues",
			async backfillPriorityLabels() {
				return { scanned: 3, labeled: 0, conflicts: ["10", "12"] };
			},
		}));
		const res = await captureStdout(() => main(["backfill-priority-labels", "--json"]));
		assert.equal(res.code, 1);
		const parsed = JSON.parse(res.stdout);
		assert.deepEqual(parsed.conflicts, ["10", "12"]);
		assert.equal(parsed.labeled, 0);
	});

	it("help lists backfill-priority-labels", async () => {
		const res = await captureStdout(() => main(["--help"]));
		assert.equal(res.code, 0);
		assert.match(res.stdout, /backfill-priority-labels/);
	});
});
