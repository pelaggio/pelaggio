import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { MarkdownRoadmap, type RoadmapSource } from "../roadmap/index.js";
import { loadQuarantine } from "../roadmap/stale-quarantine.js";
import type { CreateItemOpts, RoadmapItemStatus } from "../roadmap/types.js";
import { main, setRepo, setRoadmapFactory } from "../roadmap-cli.js";

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
		// Pin the staleness scan / quarantine store to the fixture repo (its git log has no
		// completion commits) so `next`'s write-through never quarantines a fixture item.
		setRepo(repo);
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
		setRepo(repo);
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

	it("next excludes declared over-scope items", async () => {
		const calls = { list: 0, claim: 0 };
		setRoadmapFactory(() =>
			stubRoadmap(
				[
					{ id: "small", title: "Small", deps: "—", sourceRef: "core", status: "open", scope: "S" },
					{ id: "large", title: "Large", deps: "—", sourceRef: "core", status: "open", scope: "L" },
				],
				calls,
			),
		);
		const res = await captureStdout(() => main(["next", "--json"]));
		const parsed = JSON.parse(res.stdout);
		assert.deepEqual(
			parsed.candidates.map(({ item }: { item: { id: string } }) => item.id),
			["small"],
		);
		assert.deepEqual(
			parsed.verdicts.find(({ id }: { id: string }) => id === "large"),
			{ id: "large", eligible: false, reason: "over-scope", blockers: ["L"] },
		);
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

	it("create-item forwards the charter description", async () => {
		let received: CreateItemOpts | undefined;
		const roadmap = stubRoadmap([], { list: 0, claim: 0 });
		roadmap.createItem = async (opts) => {
			received = opts;
			return { id: "NEW-1", title: opts.title, deps: "—", sourceRef: "unused" };
		};
		setRoadmapFactory(() => roadmap);

		const res = await captureStdout(() => main(["create-item", "--title", "Concise", "--description", "Full requirements and acceptance criteria", "--json"]));
		assert.equal(res.code, 0);
		assert.equal(received?.description, "Full requirements and acceptance criteria");
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

	it("help lists the stale-* subcommands", async () => {
		const res = await captureStdout(() => main(["--help"]));
		assert.match(res.stdout, /stale-scan/);
		assert.match(res.stdout, /stale-list/);
		assert.match(res.stdout, /stale-resolve/);
	});
});

interface StaleCalls {
	claim: string[];
	markDone: Array<{ id: string; note?: string }>;
}

function staleItems(): RoadmapItemStatus[] {
	return [
		{ id: "300", title: "Stale open item already superseded", deps: "—", sourceRef: "acme#300", status: "open", body: "Superseded by #105" },
		{ id: "105", title: "The confinement work", deps: "—", sourceRef: "acme#105", status: "done" },
		{ id: "301", title: "Fresh unrelated work", deps: "—", sourceRef: "acme#301", status: "open" },
	];
}

function staleStub(items: RoadmapItemStatus[], calls: StaleCalls, opts: { markDoneThrows?: boolean } = {}): RoadmapSource {
	return {
		name: "github-issues",
		async listOpenItems() {
			return items.filter((item) => item.status === "open");
		},
		async listItems() {
			return items;
		},
		async getItem(id) {
			return items.find((item) => item.id === id) ?? null;
		},
		async claimItem(id) {
			calls.claim.push(id);
			return { branch: `feat/issue-${id}`, worktree: `/tmp/${id}` };
		},
		async markDone(id, ctx) {
			if (opts.markDoneThrows) throw new Error("markDone boom");
			calls.markDone.push({ id, note: ctx?.note });
		},
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

describe("roadmap-cli staleness quarantine", () => {
	function setup(opts: { markDoneThrows?: boolean } = {}): { repo: string; calls: StaleCalls } {
		const repo = makeRepo();
		const calls: StaleCalls = { claim: [], markDone: [] };
		setRepo(repo);
		setRoadmapFactory(() => staleStub(staleItems(), calls, opts));
		return { repo, calls };
	}

	after(() => {
		setRepo(process.cwd());
	});

	it("stale-scan --json reports hits without writing when store is absent", async () => {
		const { repo } = setup();
		const res = await captureStdout(() => main(["stale-scan", "--json"]));
		assert.equal(res.code, 0);
		const parsed = JSON.parse(res.stdout);
		assert.equal(parsed.wrote, false);
		assert.deepEqual(
			parsed.hits.map((h: { id: string }) => h.id),
			["300"],
		);
		assert.equal(parsed.hits[0].reason, "superseded-marker");
		assert.deepEqual(loadQuarantine(repo).entries, {});
	});

	it("stale-scan --write creates the store and stale-list shows the entry", async () => {
		const { repo } = setup();
		const scan = await captureStdout(() => main(["stale-scan", "--write"]));
		assert.equal(scan.code, 0);
		assert.ok(loadQuarantine(repo).entries["300"]);

		const list = await captureStdout(() => main(["stale-list", "--json"]));
		assert.equal(list.code, 0);
		const rows = JSON.parse(list.stdout);
		assert.deepEqual(
			rows.map((r: { id: string }) => r.id),
			["300"],
		);
		assert.equal(rows[0].suppressed, false);
	});

	it("next excludes a quarantined id via write-through", async () => {
		setup();
		const res = await captureStdout(() => main(["next", "--json"]));
		assert.equal(res.code, 0);
		const parsed = JSON.parse(res.stdout);
		assert.deepEqual(
			parsed.candidates.map((c: { item: { id: string } }) => c.item.id),
			["301"],
		);
		const staleVerdict = parsed.verdicts.find((v: { id: string }) => v.id === "300");
		assert.equal(staleVerdict.reason, "stale-quarantined");
	});

	it("claim on a quarantined id exits 4 without calling claimItem", async () => {
		const { calls } = setup();
		await captureStdout(() => main(["stale-scan", "--write"]));
		const res = await captureStdout(() => main(["claim", "300"]));
		assert.equal(res.code, 4);
		assert.match(res.stderr, /stale-quarantined/);
		assert.match(res.stderr, /stale-resolve/);
		assert.deepEqual(calls.claim, []);
	});

	it("stale-resolve --as keep lets a subsequent claim succeed", async () => {
		const { calls } = setup();
		await captureStdout(() => main(["stale-scan", "--write"]));
		const keep = await captureStdout(() => main(["stale-resolve", "300", "--as", "keep"]));
		assert.equal(keep.code, 0);
		const res = await captureStdout(() => main(["claim", "300"]));
		assert.equal(res.code, 0);
		assert.deepEqual(calls.claim, ["300"]);
	});

	it("stale-resolve --as done marks done with a note and clears the entry", async () => {
		const { repo, calls } = setup();
		await captureStdout(() => main(["stale-scan", "--write"]));
		const res = await captureStdout(() => main(["stale-resolve", "300", "--as", "done", "--note", "confirmed shipped"]));
		assert.equal(res.code, 0);
		assert.deepEqual(calls.markDone, [{ id: "300", note: "confirmed shipped" }]);
		assert.equal(loadQuarantine(repo).entries["300"], undefined);
	});

	it("stale-resolve --as done retains the entry when markDone throws", async () => {
		const { repo } = setup({ markDoneThrows: true });
		await captureStdout(() => main(["stale-scan", "--write"]));
		const res = await captureStdout(() => main(["stale-resolve", "300", "--as", "done"]));
		assert.equal(res.code, 1);
		assert.ok(loadQuarantine(repo).entries["300"]);
	});

	it("stale-resolve requires a valid --as value", async () => {
		setup();
		const res = await captureStdout(() => main(["stale-resolve", "300"]));
		assert.equal(res.code, 1);
		assert.match(res.stderr, /--as done\|keep/);
	});
});
