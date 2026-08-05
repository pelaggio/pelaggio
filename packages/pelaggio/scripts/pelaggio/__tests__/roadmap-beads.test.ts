import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { AlreadyClaimedError } from "../roadmap/git-claim.js";
import { BD_PRIORITY_HIGH, BD_PRIORITY_NORMAL, type BdRunner, BeadsRoadmap, getRoadmapSource, isBeadsItemId, parseBdJson, resolveBeadsStoreRoot } from "../roadmap/index.js";

// ─── fixtures (Beads 1.1.x JSON shapes) ──────────────────────────────────────

const ID_A = "bd-main-a1b2c3";
const ID_B = "bd-main-b4d5e6";
const ID_C = "bd-main-c7e8f9";
const ID_D = "bd-main-d0f1a2";

function issue(partial: { id: string; title: string; status?: string; description?: string; priority?: number; dependencies?: unknown[]; depends_on?: string[]; blocked_reason?: string }): Record<string, unknown> {
	return {
		id: partial.id,
		title: partial.title,
		status: partial.status ?? "open",
		description: partial.description ?? "",
		priority: partial.priority,
		dependencies: partial.dependencies,
		depends_on: partial.depends_on,
		blocked_reason: partial.blocked_reason,
	};
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function seedRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pelaggio-beads-roadmap-test-"));
	execSync("git init -q -b main", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config commit.gpgsign false", { cwd: dir });
	execSync("git commit --allow-empty -q -m init", { cwd: dir });
	return dir;
}

function seedFile(dir: string, rel: string, body: string): void {
	const full = resolve(dir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body);
}

interface StubCall {
	args: string[];
}

interface StubOpts {
	routes?: Array<{ match: (args: string[]) => boolean; stdout?: string; stderr?: string; status?: number }>;
	fallback?: { stdout?: string; stderr?: string; status?: number };
	/** Throw instead of returning (simulates ENOENT / runner crash). */
	throwOn?: (args: string[]) => Error | null;
}

function makeStub(opts: StubOpts): { run: BdRunner; calls: StubCall[] } {
	const calls: StubCall[] = [];
	const run: BdRunner = (args) => {
		calls.push({ args });
		const err = opts.throwOn?.(args);
		if (err) throw err;
		const hit = opts.routes?.find((r) => r.match(args));
		if (hit) return { stdout: hit.stdout ?? "", stderr: hit.stderr ?? "", status: hit.status ?? 0 };
		if (opts.fallback) return { stdout: opts.fallback.stdout ?? "", stderr: opts.fallback.stderr ?? "", status: opts.fallback.status ?? 0 };
		return { stdout: "[]", stderr: "", status: 0 };
	};
	return { run, calls };
}

function mk(opts: { repo: string; bdRun?: BdRunner; storeRoot?: string }): BeadsRoadmap {
	return new BeadsRoadmap({
		repo: opts.repo,
		bdRun: opts.bdRun,
		storeRoot: opts.storeRoot ?? opts.repo,
	});
}

// ─── parseBdJson ─────────────────────────────────────────────────────────────

describe("parseBdJson", () => {
	it("parses valid JSON that matches the shape guard", () => {
		const v = parseBdJson<{ id: string }>(`{"id":"x"}`, (x) => typeof x === "object" && x !== null);
		assert.equal(v.id, "x");
	});

	it("rejects malformed JSON", () => {
		assert.throws(() => parseBdJson("not-json", () => true), /non-JSON/);
	});

	it("rejects wrong top-level shape", () => {
		assert.throws(() => parseBdJson("{}", (v) => Array.isArray(v)), /unexpected JSON shape/);
	});
});

describe("isBeadsItemId", () => {
	it("accepts real bd 1.1.x ids: bd-<hash>, bd-<prefix>-<hash>, and hierarchical", () => {
		assert.equal(isBeadsItemId("bd-a1b2"), true); // no db prefix (README default shape)
		assert.equal(isBeadsItemId("bd-main-a1b2c3"), true); // with a db prefix
		assert.equal(isBeadsItemId("bd-probe-l5g"), true); // real probed id
		assert.equal(isBeadsItemId("bd-a3f8.1"), true); // hierarchical task
		assert.equal(isBeadsItemId("bd-main-a1b2c3.1.2"), true); // prefixed hierarchical sub-task
		assert.equal(isBeadsItemId("BD-Main-A1B2C3"), true); // case-insensitive
	});

	it("rejects non-bd / malformed tokens", () => {
		assert.equal(isBeadsItemId("main-a1b2c3"), false); // no bd- prefix
		assert.equal(isBeadsItemId("bd-"), false); // no segment after bd-
		assert.equal(isBeadsItemId("TOOL-9"), false);
		assert.equal(isBeadsItemId("42"), false);
	});
});

// ─── parseItemId ─────────────────────────────────────────────────────────────

describe("BeadsRoadmap.parseItemId", () => {
	const r = mk({ repo: "/tmp" });

	it("extracts bare, hierarchical, and slug-free branch ids, normalizes to lowercase", async () => {
		assert.equal(await r.parseItemId(ID_A), ID_A);
		assert.equal(await r.parseItemId("BD-MAIN-A1B2C3"), ID_A);
		assert.equal(await r.parseItemId("bd-a1b2"), "bd-a1b2"); // single-segment id
		assert.equal(await r.parseItemId(`${ID_A}.1`), `${ID_A}.1`); // hierarchical sub-task
		assert.equal(await r.parseItemId(`feat/${ID_A}`), ID_A); // exact slug-free branch (claimItem format)
		assert.equal(await r.parseItemId(`checked out feat/${ID_A} now`), ID_A); // branch mentioned in prose
	});

	it("rejects non-bd and unrelated tokens", async () => {
		assert.equal(await r.parseItemId("nothing here"), null);
		assert.equal(await r.parseItemId("feat/issue-42"), null);
		assert.equal(await r.parseItemId("TOOL-9"), null);
	});

	it("terminates at non-id boundaries in prose (word-bounded)", async () => {
		assert.equal(await r.parseItemId("see bd-a1b2, then stop"), "bd-a1b2"); // comma boundary
		assert.equal(await r.parseItemId("(bd-main-a1b2c3)"), ID_A); // paren boundary
		assert.equal(await r.parseItemId("xbd-a1b2"), null); // not a token start — no false partial
		// Inherent: a hyphen-joined trailing word is indistinguishable from a real multi-segment id.
		assert.equal(await r.parseItemId("bd-a1b2-and-more"), "bd-a1b2-and-more");
	});
});

// ─── listItems / readiness / claim overlay ───────────────────────────────────

describe("BeadsRoadmap.listItems — readiness + claim overlay", () => {
	const claimedWorktrees: string[] = [];
	afterEach(() => {
		while (claimedWorktrees.length) rmSync(claimedWorktrees.pop() as string, { recursive: true, force: true });
	});

	it("maps open ∈ ready → open; open ∉ ready → blocked; done from bd; bd in_progress w/o branch → open (git-authoritative)", async () => {
		const list = [
			issue({ id: ID_A, title: "Ready open", status: "open", priority: 1 }),
			issue({ id: ID_B, title: "Blocked open", status: "open", depends_on: [ID_A], blocked_reason: "waiting on dep" }),
			issue({ id: ID_C, title: "In progress", status: "in_progress" }),
			issue({ id: ID_D, title: "Closed", status: "closed" }),
		];
		const ready = [list[0]];
		const { run, calls } = makeStub({
			routes: [
				{ match: (a) => a[0] === "list", stdout: JSON.stringify(list) },
				{ match: (a) => a[0] === "ready", stdout: JSON.stringify(ready) },
			],
		});
		const r = mk({ repo: seedRepo(), bdRun: run });
		const items = await r.listItems({ includeDone: true });
		assert.equal(items.length, 4);

		const byId = Object.fromEntries(items.map((i) => [i.id, i]));
		assert.equal(byId[ID_A].status, "open");
		assert.equal(byId[ID_B].status, "blocked");
		assert.equal(byId[ID_B].blockedReason, "waiting on dep");
		assert.equal(byId[ID_B].deps, ID_A);
		// #347: ID_C is bd `in_progress` but has NO live feat/<id> branch → bd status is not
		// authoritative, so it surfaces as available ("open"), not stuck "in-progress" (dead-holder).
		assert.equal(byId[ID_C].status, "open");
		assert.equal(byId[ID_D].status, "done");
		assert.equal((byId[ID_A] as { priority?: number }).priority, 1);
		assert.equal(byId[ID_A].sourceRef, ID_A);

		assert.ok(calls.some((c) => c.args[0] === "list" && c.args.includes("--all")));
		assert.ok(calls.some((c) => c.args[0] === "ready"));
	});

	it("open + live feat/<id> branch → in-progress even if still in ready", async () => {
		const repo = seedRepo();
		execSync(`git branch feat/${ID_A}`, { cwd: repo });
		const list = [issue({ id: ID_A, title: "Claimed", status: "open" })];
		const { run } = makeStub({
			routes: [
				{ match: (a) => a[0] === "list", stdout: JSON.stringify(list) },
				{ match: (a) => a[0] === "ready", stdout: JSON.stringify(list) },
			],
		});
		const r = mk({ repo, bdRun: run });
		const items = await r.listItems();
		assert.equal(items[0].status, "in-progress");
	});

	it("#347 dead-holder: bd in_progress with NO live branch → open and pickable via listOpenItems", async () => {
		const repo = seedRepo(); // no feat/<id> branch — the authoritative claim is absent
		const inProg = issue({ id: ID_C, title: "Stale bd claim", status: "in_progress" });
		const { run, calls } = makeStub({
			routes: [
				{ match: (a) => a[0] === "list", stdout: JSON.stringify([inProg]) },
				{ match: (a) => a[0] === "ready", stdout: "[]" }, // bd excludes in_progress from `ready`
			],
		});
		const r = mk({ repo, bdRun: run });
		// Without the fix this item is permanently unpickable (bd status acting as the registry).
		const items = await r.listItems();
		assert.equal(items[0].status, "open");
		const open = await r.listOpenItems();
		assert.deepEqual(
			open.map((i) => i.id),
			[ID_C],
			"a bd in_progress item whose git branch is gone must re-enter availability",
		);
		// The dead-holder query must be UNLIMITED + status-scoped — bd `list`/`ready` default to a
		// window (50/100), which would silently drop stale holders past it. (#347 re-review)
		const readyCall = calls.find((c) => c.args[0] === "ready");
		const inProgCall = calls.find((c) => c.args[0] === "list" && c.args.includes("--status"));
		assert.ok(readyCall?.args.join(" ").includes("--limit 0"), "bd ready must be unlimited");
		assert.ok(inProgCall?.args.includes("in_progress") && inProgCall.args.join(" ").includes("--limit 0"), "in_progress reconcile must be status-scoped + unlimited");
	});

	it("#347 bd in_progress WITH a live branch → in-progress and not offered (git-authoritative)", async () => {
		const repo = seedRepo();
		execSync(`git branch feat/${ID_C}`, { cwd: repo });
		const inProg = issue({ id: ID_C, title: "Actively claimed", status: "in_progress" });
		const { run } = makeStub({
			routes: [
				{ match: (a) => a[0] === "list", stdout: JSON.stringify([inProg]) },
				{ match: (a) => a[0] === "ready", stdout: "[]" },
			],
		});
		const r = mk({ repo, bdRun: run });
		assert.equal((await r.listItems())[0].status, "in-progress");
		assert.equal((await r.listOpenItems()).length, 0);
	});

	it("includeDone=false omits --all flag", async () => {
		const { run, calls } = makeStub({
			routes: [
				{ match: (a) => a[0] === "list", stdout: "[]" },
				{ match: (a) => a[0] === "ready", stdout: "[]" },
			],
		});
		const r = mk({ repo: seedRepo(), bdRun: run });
		await r.listItems();
		const listCall = calls.find((c) => c.args[0] === "list");
		assert.ok(listCall);
		assert.ok(!listCall.args.includes("--all"));
	});
});

describe("BeadsRoadmap.listOpenItems", () => {
	it("returns ready ∩ not-claimed only", async () => {
		const repo = seedRepo();
		execSync(`git branch feat/${ID_B}`, { cwd: repo });
		const ready = [issue({ id: ID_A, title: "Startable" }), issue({ id: ID_B, title: "Already claimed" })];
		const { run } = makeStub({
			routes: [{ match: (a) => a[0] === "ready", stdout: JSON.stringify(ready) }],
		});
		const r = mk({ repo, bdRun: run });
		const items = await r.listOpenItems();
		assert.equal(items.length, 1);
		assert.equal(items[0].id, ID_A);
		assert.equal(items[0].title, "Startable");
		assert.equal(items[0].sourceRef, ID_A);
	});
});

// ─── getItem ─────────────────────────────────────────────────────────────────

describe("BeadsRoadmap.getItem", () => {
	it("maps show payload with body + priority duck-type + ready/claim rules", async () => {
		const shown = issue({
			id: ID_A,
			title: "Spec item",
			status: "open",
			description: "Do the thing\nScope: M",
			priority: 2,
			depends_on: [ID_B],
		});
		const { run } = makeStub({
			routes: [
				{ match: (a) => a[0] === "show", stdout: JSON.stringify(shown) },
				{ match: (a) => a[0] === "ready", stdout: JSON.stringify([shown]) },
			],
		});
		const r = mk({ repo: seedRepo(), bdRun: run });
		const item = await r.getItem(ID_A);
		assert.ok(item);
		assert.equal(item.status, "open");
		assert.equal(item.body, "Do the thing\nScope: M");
		assert.equal(item.deps, ID_B);
		assert.equal((item as { priority?: number }).priority, 2);
	});

	it("returns null on not-found", async () => {
		const { run } = makeStub({
			routes: [{ match: (a) => a[0] === "show", stderr: "Error: issue not found", status: 1 }],
		});
		const r = mk({ repo: seedRepo(), bdRun: run });
		assert.equal(await r.getItem(ID_A), null);
	});

	it("accepts array-wrapped show output", async () => {
		const shown = issue({ id: ID_A, title: "Wrapped", status: "open" });
		const { run } = makeStub({
			routes: [
				{ match: (a) => a[0] === "show", stdout: JSON.stringify([shown]) },
				{ match: (a) => a[0] === "ready", stdout: JSON.stringify([shown]) },
			],
		});
		const r = mk({ repo: seedRepo(), bdRun: run });
		const item = await r.getItem(ID_A);
		assert.equal(item?.title, "Wrapped");
	});
});

// ─── claimItem ───────────────────────────────────────────────────────────────

describe("BeadsRoadmap.claimItem", () => {
	const claimedWorktrees: string[] = [];
	afterEach(() => {
		while (claimedWorktrees.length) rmSync(claimedWorktrees.pop() as string, { recursive: true, force: true });
	});

	it("creates git claim before bd update --claim; branch is slug-free feat/<id>", async () => {
		const repo = seedRepo();
		const shown = issue({ id: ID_A, title: "Fix the Thing: Make it Better!" });
		const { run, calls } = makeStub({
			routes: [
				{ match: (a) => a[0] === "show", stdout: JSON.stringify(shown) },
				{ match: (a) => a[0] === "update" && a.includes("--claim"), stdout: "" },
			],
		});
		const r = mk({ repo, bdRun: run });
		const { branch, worktree } = await r.claimItem(ID_A);
		claimedWorktrees.push(worktree);

		// #347: bd ids contain hyphens/dots, so the claim branch is exactly `feat/<id>` (no `-slug`),
		// keeping id-in-branch parsing unambiguous. The worktree name still derives from the id.
		assert.equal(branch, `feat/${ID_A}`);
		assert.ok(worktree.endsWith(`-${ID_A}`), `worktree should end with -${ID_A}, got ${worktree}`);

		const showIdx = calls.findIndex((c) => c.args[0] === "show");
		const claimIdx = calls.findIndex((c) => c.args[0] === "update" && c.args.includes("--claim"));
		assert.ok(showIdx >= 0);
		assert.ok(claimIdx > showIdx, "bd update --claim must run after show (and after git claim)");
		assert.deepEqual(calls[claimIdx].args, ["update", ID_A, "--claim"]);

		const wtList = execSync("git worktree list", { cwd: repo, encoding: "utf-8" });
		assert.ok(wtList.includes(worktree));
	});

	it("pre-existing branch raises AlreadyClaimedError without bd update --claim", async () => {
		const repo = seedRepo();
		const shown = issue({ id: ID_A, title: "Short" });
		// The slug-free claim branch already exists → a new claim must fail closed.
		execSync(`git branch feat/${ID_A}`, { cwd: repo });
		const { run, calls } = makeStub({
			routes: [
				{ match: (a) => a[0] === "show", stdout: JSON.stringify(shown) },
				{ match: (a) => a[0] === "update", stdout: "" },
			],
		});
		const r = mk({ repo, bdRun: run });
		await assert.rejects(
			() => r.claimItem(ID_A),
			(e: unknown) => e instanceof AlreadyClaimedError,
		);
		assert.ok(!calls.some((c) => c.args.includes("--claim")), "must not call bd update --claim on pre-existing branch");
	});

	it("failed bd --claim still returns the valid git claim", async () => {
		const repo = seedRepo();
		const shown = issue({ id: ID_A, title: "Ok" });
		const { run } = makeStub({
			routes: [
				{ match: (a) => a[0] === "show", stdout: JSON.stringify(shown) },
				{ match: (a) => a[0] === "update" && a.includes("--claim"), stderr: "db locked", status: 1 },
			],
		});
		const r = mk({ repo, bdRun: run });
		const { branch, worktree } = await r.claimItem(ID_A);
		claimedWorktrees.push(worktree);
		assert.ok(branch.startsWith(`feat/${ID_A}`));
		const wtList = execSync("git worktree list", { cwd: repo, encoding: "utf-8" });
		assert.ok(wtList.includes(worktree));
	});
});

// ─── markDone / createItem ───────────────────────────────────────────────────

describe("BeadsRoadmap.markDone", () => {
	it("issues bd close <id>", async () => {
		const { run, calls } = makeStub({});
		const r = mk({ repo: "/tmp", bdRun: run });
		await r.markDone(ID_A, { note: "landed" });
		assert.deepEqual(calls[0].args, ["close", ID_A]);
	});

	it("treats already-closed as success", async () => {
		const { run } = makeStub({
			routes: [{ match: (a) => a[0] === "close", stderr: "Error: issue is already closed", status: 1 }],
		});
		const r = mk({ repo: "/tmp", bdRun: run });
		await r.markDone(ID_A);
	});
});

describe("BeadsRoadmap.createItem", () => {
	it("maps priority, description prose, returns source-assigned lowercase id", async () => {
		const created = issue({ id: "BD-MAIN-NEWID1", title: "New work", status: "open", priority: BD_PRIORITY_HIGH });
		const { run, calls } = makeStub({
			routes: [{ match: (a) => a[0] === "create", stdout: JSON.stringify(created) }],
		});
		const r = mk({ repo: "/tmp", bdRun: run });
		const item = await r.createItem({ title: "New work", description: "Full charter", priority: "high", scope: "M", deferred: true });
		assert.equal(item.id, "bd-main-newid1");
		assert.equal(item.title, "New work");
		assert.equal(item.sourceRef, "bd-main-newid1");

		const create = calls.find((c) => c.args[0] === "create");
		assert.ok(create);
		assert.ok(create.args.includes("--title"));
		assert.ok(create.args.includes("New work"));
		assert.ok(create.args.includes("--priority"));
		assert.ok(create.args.includes(String(BD_PRIORITY_HIGH)));
		assert.ok(create.args.includes("--json"));
		const descIdx = create.args.indexOf("--description");
		assert.ok(descIdx >= 0);
		assert.match(create.args[descIdx + 1], /^Full charter\n/);
		assert.match(create.args[descIdx + 1], /Scope: M/);
		assert.match(create.args[descIdx + 1], /Deferred: true/);
		// No shell-string interpolation — every arg is a discrete array element.
		assert.ok(create.args.every((a) => typeof a === "string"));
	});

	it("issues one dep add per dependency", async () => {
		const created = issue({ id: ID_A, title: "With deps" });
		const { run, calls } = makeStub({
			routes: [
				{ match: (a) => a[0] === "create", stdout: JSON.stringify(created) },
				{ match: (a) => a[0] === "dep", stdout: "" },
			],
		});
		const r = mk({ repo: "/tmp", bdRun: run });
		const item = await r.createItem({ title: "With deps", deps: [ID_B, ID_C], priority: "normal" });
		assert.equal(item.deps, `${ID_B}, ${ID_C}`);
		const depCalls = calls.filter((c) => c.args[0] === "dep");
		assert.equal(depCalls.length, 2);
		assert.deepEqual(depCalls[0].args, ["dep", "add", ID_A, ID_B]);
		assert.deepEqual(depCalls[1].args, ["dep", "add", ID_A, ID_C]);
		const create = calls.find((c) => c.args[0] === "create");
		assert.ok(create?.args.includes(String(BD_PRIORITY_NORMAL)));
	});

	it("partial dep failure includes the created id", async () => {
		const created = issue({ id: ID_A, title: "Partial" });
		const { run } = makeStub({
			routes: [
				{ match: (a) => a[0] === "create", stdout: JSON.stringify(created) },
				{ match: (a) => a[0] === "dep", stderr: "dep missing", status: 1 },
			],
		});
		const r = mk({ repo: "/tmp", bdRun: run });
		await assert.rejects(
			() => r.createItem({ title: "Partial", deps: [ID_B] }),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, new RegExp(ID_A));
				assert.match(e.message, /dependency attach failed/);
				return true;
			},
		);
	});
});

// ─── plans ───────────────────────────────────────────────────────────────────

describe("BeadsRoadmap plans", () => {
	it("resolvePlanPath is docs/plans/<lowercase-id>.md", () => {
		const r = mk({ repo: "/tmp" });
		assert.equal(r.resolvePlanPath({ id: "BD-MAIN-A1B2C3", worktree: "/wt" }), resolve("/wt", "docs", "plans", `${ID_A}.md`));
	});

	it("getItemPlan finds plan under worktree then repo", async () => {
		const repo = seedRepo();
		const wt = mkdtempSync(join(tmpdir(), "pelaggio-beads-wt-"));
		try {
			seedFile(repo, `docs/plans/${ID_A}.md`, "# plan in repo\n");
			const r = mk({ repo, bdRun: makeStub({}).run });
			assert.equal(await r.getItemPlan({ id: ID_A }), resolve(repo, "docs", "plans", `${ID_A}.md`));

			seedFile(wt, `docs/plans/${ID_A}.md`, "# plan in wt\n");
			assert.equal(await r.getItemPlan({ id: ID_A, worktree: wt }), resolve(wt, "docs", "plans", `${ID_A}.md`));
			assert.equal(await r.getItemPlan({ id: ID_B }), null);
		} finally {
			rmSync(wt, { recursive: true, force: true });
		}
	});

	it("publishPlan links via --spec-id with safe relative path", async () => {
		const repo = seedRepo();
		seedFile(repo, `docs/plans/${ID_A}.md`, "# plan\n");
		const { run, calls } = makeStub({});
		const r = mk({ repo, bdRun: run });
		await r.publishPlan("# plan\n", { id: ID_A, worktree: repo });
		assert.deepEqual(calls[0].args, ["update", ID_A, "--spec-id", `docs/plans/${ID_A}.md`]);
	});

	it("publishPlan rejects missing plan file", async () => {
		const repo = seedRepo();
		const r = mk({ repo, bdRun: makeStub({}).run });
		await assert.rejects(() => r.publishPlan("# no file\n", { id: ID_A, worktree: repo }), /plan file not found/);
	});

	it("archivePlan is a no-op; isCharterPickRace is false", async () => {
		const r = mk({ repo: "/tmp", bdRun: makeStub({}).run });
		await r.archivePlan(ID_A);
		assert.equal(r.isCharterPickRace(ID_A), false);
	});
});

// ─── errors / missing tool ───────────────────────────────────────────────────

describe("BeadsRoadmap errors", () => {
	it("surfaces ENOENT as actionable bd-required diagnostic", async () => {
		const err = Object.assign(new Error("spawn bd ENOENT"), { code: "ENOENT" });
		const { run } = makeStub({ throwOn: () => err });
		const r = mk({ repo: "/tmp", bdRun: run });
		await assert.rejects(() => r.listItems(), /bd CLI required/);
	});

	it("surfaces status 127 as bd-required", async () => {
		const { run } = makeStub({
			routes: [{ match: () => true, stderr: "command not found", status: 127 }],
		});
		const r = mk({ repo: "/tmp", bdRun: run });
		await assert.rejects(() => r.listItems(), /bd CLI required/);
	});

	it("surfaces non-zero stderr with command context", async () => {
		const { run } = makeStub({
			routes: [{ match: (a) => a[0] === "list", stderr: "db corrupt", status: 1 }],
		});
		const r = mk({ repo: "/tmp", bdRun: run });
		await assert.rejects(() => r.listItems(), /bd list .* failed: db corrupt/);
	});

	it("rejects missing required identity fields in list payloads", async () => {
		const { run } = makeStub({
			routes: [
				{ match: (a) => a[0] === "list", stdout: JSON.stringify([{ title: "no id", status: "open" }]) },
				{ match: (a) => a[0] === "ready", stdout: "[]" },
			],
		});
		const r = mk({ repo: "/tmp", bdRun: run });
		await assert.rejects(() => r.listItems(), /unexpected JSON shape/);
	});
});

// ─── store root ──────────────────────────────────────────────────────────────

describe("BeadsRoadmap store root", () => {
	it("resolveBeadsStoreRoot returns main worktree for a linked worktree", () => {
		const main = seedRepo();
		const wtPath = join(dirname(main), `beads-wt-${Date.now()}`);
		try {
			execSync(`git worktree add -q ${JSON.stringify(wtPath)} -b feat/store-root-probe`, { cwd: main });
			assert.equal(resolveBeadsStoreRoot(wtPath), main);
			assert.equal(resolveBeadsStoreRoot(main), main);
		} finally {
			try {
				execSync(`git worktree remove -f ${JSON.stringify(wtPath)}`, { cwd: main });
			} catch {
				rmSync(wtPath, { recursive: true, force: true });
			}
			rmSync(main, { recursive: true, force: true });
		}
	});

	it("falls back to repo when git resolution fails", () => {
		assert.equal(resolveBeadsStoreRoot("/tmp/not-a-git-repo-xyz"), "/tmp/not-a-git-repo-xyz");
	});

	it("constructor stores resolved storeRoot; injectable override works", () => {
		const r = mk({ repo: "/tmp/fake", storeRoot: "/custom/store" });
		assert.equal(r.beadsStoreRoot, "/custom/store");
	});
});

// ─── factory ─────────────────────────────────────────────────────────────────

describe("getRoadmapSource — beads factory", () => {
	it("constructs BeadsRoadmap without config-time bd probe", () => {
		const src = getRoadmapSource("beads", { repo: "/tmp" });
		assert.ok(src instanceof BeadsRoadmap);
		assert.equal(src.name, "beads");
	});
});

// ─── full surface smoke (interface completeness) ─────────────────────────────

describe("BeadsRoadmap RoadmapSource surface", () => {
	it("exposes every RoadmapSource method", () => {
		const r = mk({ repo: "/tmp", bdRun: makeStub({}).run });
		const methods = ["listOpenItems", "listItems", "getItem", "claimItem", "markDone", "getItemPlan", "resolvePlanPath", "publishPlan", "createItem", "archivePlan", "isCharterPickRace", "parseItemId"] as const;
		for (const m of methods) {
			assert.equal(typeof r[m], "function", `missing ${m}`);
		}
		assert.equal(r.name, "beads");
	});
});
