import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type GhRunner, GitHubIssuesRoadmap } from "../roadmap/github-issues.js";
import { getRoadmapSource } from "../roadmap/index.js";
import { isQuickScope } from "../roadmap/scope.js";

function seedRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "autopilot-gh-roadmap-test-"));
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
	/** Optional fallback result when no route matches. */
	fallback?: { stdout?: string; stderr?: string; status?: number };
}

function makeStub(opts: StubOpts): { run: GhRunner; calls: StubCall[] } {
	const calls: StubCall[] = [];
	const run: GhRunner = (args) => {
		calls.push({ args });
		const hit = opts.routes?.find((r) => r.match(args));
		if (hit) return { stdout: hit.stdout ?? "", stderr: hit.stderr ?? "", status: hit.status ?? 0 };
		if (opts.fallback) return { stdout: opts.fallback.stdout ?? "", stderr: opts.fallback.stderr ?? "", status: opts.fallback.status ?? 0 };
		return { stdout: "", stderr: "", status: 0 };
	};
	return { run, calls };
}

function mk(opts: Partial<ConstructorParameters<typeof GitHubIssuesRoadmap>[0]> & { repo: string; ghRun?: GhRunner }): GitHubIssuesRoadmap {
	return new GitHubIssuesRoadmap({
		repo: opts.repo,
		ghRepo: opts.ghRepo ?? "acme/widgets",
		label: opts.label ?? "autopilot",
		planLocation: opts.planLocation ?? "issue-comment",
		ghRun: opts.ghRun,
	});
}

describe("GitHubIssuesRoadmap.parseItemId", () => {
	const r = mk({ repo: "/tmp" });

	it("extracts from feat/issue-<n> branch names", async () => {
		assert.equal(await r.parseItemId("feat/issue-42"), "42");
		assert.equal(await r.parseItemId("feat/issue-42-fix-bug"), "42");
		assert.equal(await r.parseItemId("checked out feat/issue-7-thing"), "7");
	});

	it("extracts from #<n>", async () => {
		assert.equal(await r.parseItemId("closes #123"), "123");
		assert.equal(await r.parseItemId("#9"), "9");
	});

	it("extracts from loose 'issue <n>'", async () => {
		assert.equal(await r.parseItemId("issue 42"), "42");
		assert.equal(await r.parseItemId("Issue-42 tracking"), "42");
	});

	it("returns null when no match", async () => {
		assert.equal(await r.parseItemId("nothing in here"), null);
	});
});

describe("GitHubIssuesRoadmap.isQuickScope", () => {
	const r = mk({ repo: "/tmp" });
	it("true for scope: S / XS", () => {
		assert.equal(r.isQuickScope({ summaryText: "scope: S" }), true);
		assert.equal(r.isQuickScope({ summaryText: "Scope: XS" }), true);
	});
	it("true for bug / fix: markers", () => {
		assert.equal(r.isQuickScope({ summaryText: "bug in parser" }), true);
		assert.equal(r.isQuickScope({ summaryText: "fix: oops" }), true);
	});
	it("false for scope: M", () => {
		assert.equal(r.isQuickScope({ summaryText: "scope: M" }), false);
	});
});

describe("isQuickScope", () => {
	it("lets explicit standard body scope override bug/fix text", () => {
		assert.equal(isQuickScope({ item: { body: "Scope: M\n\nfix: bug" }, summaryText: "fixes a bug" }), false);
	});

	it("lets explicit standard scope label override bug labels and summary", () => {
		assert.equal(isQuickScope({ item: { labels: ["scope: M", "bug"] }, summaryText: "fix: parser bug" }), false);
	});

	it("treats explicit quick scope labels as quick", () => {
		assert.equal(isQuickScope({ item: { labels: ["scope: S"] } }), true);
	});

	it("falls back to summary text when item metadata has no decisive signal", () => {
		assert.equal(isQuickScope({ item: { body: "Refactor the module" }, summaryText: "bug in flow" }), true);
	});

	it("uses standard body scope even with an empty summary", () => {
		assert.equal(isQuickScope({ item: { body: "Scope: L\n\ndetails" }, summaryText: "" }), false);
	});

	it("keeps summary-only fix detection when no item is available", () => {
		assert.equal(isQuickScope({ summaryText: "fix: small parser issue" }), true);
	});
});

describe("GitHubIssuesRoadmap.listOpenItems", () => {
	it("maps a 3-issue response, extracts deps from body", async () => {
		const issues = [
			{ number: 1, title: "First", body: "Depends on: #2, #3\n\nBody text" },
			{ number: 2, title: "Second", body: "No deps here" },
			{ number: 3, title: "Third", body: "" },
		];
		const { run, calls } = makeStub({
			routes: [{ match: (a) => a[0] === "issue" && a[1] === "list", stdout: JSON.stringify(issues) }],
		});
		const r = mk({ repo: "/tmp", ghRun: run });
		const items = await r.listOpenItems();
		assert.equal(items.length, 3);
		assert.equal(items[0].id, "1");
		assert.equal(items[0].title, "First");
		assert.equal(items[0].deps, "#2, #3");
		assert.equal(items[1].deps, "");
		assert.equal(items[0].sourceRef, "acme/widgets#1");
		assert.deepEqual(calls[0].args.slice(0, 8), ["issue", "list", "--repo", "acme/widgets", "--label", "autopilot", "--state", "open"]);
	});

	it("returns [] on empty array", async () => {
		const { run } = makeStub({ routes: [{ match: () => true, stdout: "[]" }] });
		const r = mk({ repo: "/tmp", ghRun: run });
		assert.deepEqual(await r.listOpenItems(), []);
	});

	it("passes custom label through the args", async () => {
		const { run, calls } = makeStub({ routes: [{ match: () => true, stdout: "[]" }] });
		const r = mk({ repo: "/tmp", label: "triage", ghRun: run });
		await r.listOpenItems();
		assert.ok(calls[0].args.includes("triage"));
	});
});

describe("GitHubIssuesRoadmap.getItem", () => {
	it("exposes labels from the issue response", async () => {
		const issue = {
			number: 42,
			title: "Fix the widget",
			body: "Scope: M",
			state: "OPEN",
			labels: [{ name: "autopilot" }, { name: "scope: M" }],
		};
		const { run } = makeStub({
			routes: [{ match: (a) => a[0] === "issue" && a[1] === "view", stdout: JSON.stringify(issue) }],
		});
		const r = mk({ repo: "/tmp", ghRun: run });
		const item = await r.getItem("42");
		assert.deepEqual(item?.labels, ["autopilot", "scope: M"]);
		assert.equal(item?.body, "Scope: M");
	});
});

let claimCounter = 10_000;
function freshId(): string {
	claimCounter += 1;
	return String(claimCounter + Math.floor(Math.random() * 1000));
}

describe("GitHubIssuesRoadmap.claimItem", () => {
	const claimedWorktrees: string[] = [];
	afterEach(() => {
		while (claimedWorktrees.length) rmSync(claimedWorktrees.pop() as string, { recursive: true, force: true });
	});

	it("adds in-progress label, creates worktree, returns slugged branch", async () => {
		const repo = seedRepo();
		const id = freshId();
		const { run, calls } = makeStub({
			routes: [
				{
					match: (a) => a[1] === "view",
					stdout: JSON.stringify({ title: "Fix the Thing: Make it Better!" }),
				},
				{ match: (a) => a[1] === "edit", stdout: "" },
			],
		});
		const r = mk({ repo, ghRun: run });
		const { branch, worktree } = await r.claimItem(id);
		claimedWorktrees.push(worktree);

		assert.match(branch, new RegExp(`^feat/issue-${id}-fix-the-thing`));
		assert.ok(branch.length <= `feat/issue-${id}-`.length + 40);
		assert.ok(worktree.endsWith(`-${id}`), `worktree should end with -${id}, got ${worktree}`);

		const editCall = calls.find((c) => c.args[1] === "edit");
		assert.ok(editCall, "expected issue edit call");
		assert.ok(editCall.args.includes("--add-label"));
		assert.ok(editCall.args.includes("in-progress"));

		const wtList = execSync("git worktree list", { cwd: repo, encoding: "utf-8" });
		assert.ok(wtList.includes(worktree));
	});

	it("tolerates non-zero gh edit (label missing) but still creates worktree", async () => {
		const repo = seedRepo();
		const id = freshId();
		const { run } = makeStub({
			routes: [
				{ match: (a) => a[1] === "view", stdout: JSON.stringify({ title: "Short" }) },
				{ match: (a) => a[1] === "edit", stderr: "HTTP 422: Validation failed", status: 1 },
			],
		});
		const r = mk({ repo, ghRun: run });
		const { branch, worktree } = await r.claimItem(id);
		claimedWorktrees.push(worktree);
		assert.ok(branch.startsWith(`feat/issue-${id}`));
		const wtList = execSync("git worktree list", { cwd: repo, encoding: "utf-8" });
		assert.ok(wtList.includes(worktree));
	});
});

describe("GitHubIssuesRoadmap.markDone", () => {
	it("comments, closes, and strips label", async () => {
		const { run, calls } = makeStub({});
		const r = mk({ repo: "/tmp", ghRun: run });
		await r.markDone("42", { note: "landed in feat/issue-42" });

		const comment = calls.find((c) => c.args[1] === "comment");
		assert.ok(comment);
		const bodyIdx = comment.args.indexOf("--body");
		assert.ok(bodyIdx >= 0);
		assert.match(comment.args[bodyIdx + 1], /Shipped — landed in feat\/issue-42/);

		const close = calls.find((c) => c.args[1] === "close");
		assert.ok(close);

		const remove = calls.find((c) => c.args[1] === "edit" && c.args.includes("--remove-label"));
		assert.ok(remove);
	});

	it("comments 'Shipped' with no note", async () => {
		const { run, calls } = makeStub({});
		const r = mk({ repo: "/tmp", ghRun: run });
		await r.markDone("5");
		const comment = calls.find((c) => c.args[1] === "comment");
		assert.ok(comment);
		const bodyIdx = comment.args.indexOf("--body");
		assert.equal(comment.args[bodyIdx + 1], "Shipped");
	});
});

describe("GitHubIssuesRoadmap.getItemPlan", () => {
	it("returns local docs/plans file without any gh call when present", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/plans/issue-42-fix-thing.md", "# plan\n");
		const { run, calls } = makeStub({});
		const r = mk({ repo, ghRun: run });
		const path = await r.getItemPlan({ id: "42" });
		assert.ok(path?.endsWith("issue-42-fix-thing.md"));
		assert.equal(calls.length, 0);
	});

	it("prefers the supplied worktree plan over a repo-local stale plan without any gh call", async () => {
		const repo = seedRepo();
		const worktree = seedRepo();
		seedFile(repo, ".dev/plans/42.md", "OLD");
		seedFile(worktree, ".dev/plans/42.md", "NEW");
		const { run, calls } = makeStub({});
		const r = mk({ repo, ghRun: run });
		const path = await r.getItemPlan({ id: "42", worktree });
		assert.equal(path, resolve(worktree, ".dev", "plans", "42.md"));
		assert.equal(readFileSync(path!, "utf-8"), "NEW");
		assert.equal(calls.length, 0);
	});

	it("reads issue comment when no local file, writes .dev/plans/<n>.md, strips marker", async () => {
		const repo = seedRepo();
		const planBody = "# Plan for 42\n\nSteps go here.\n";
		const comments = {
			comments: [
				{ body: "unrelated chatter", createdAt: "2026-01-01T00:00:00Z" },
				{ body: `<!-- autopilot-plan -->\n${planBody}`, createdAt: "2026-02-01T00:00:00Z" },
			],
		};
		const { run } = makeStub({
			routes: [{ match: (a) => a[1] === "view" && a.includes("comments"), stdout: JSON.stringify(comments) }],
		});
		const r = mk({ repo, ghRun: run });
		const path = await r.getItemPlan({ id: "42" });
		assert.ok(path?.endsWith(".dev/plans/42.md"));
		const written = readFileSync(path!, "utf-8");
		assert.equal(written, planBody);
	});

	it("returns null when no local file and no matching comment", async () => {
		const repo = seedRepo();
		const { run } = makeStub({
			routes: [{ match: (a) => a[1] === "view", stdout: JSON.stringify({ comments: [{ body: "chatter", createdAt: "2026-01-01T00:00:00Z" }] }) }],
		});
		const r = mk({ repo, ghRun: run });
		const path = await r.getItemPlan({ id: "42" });
		assert.equal(path, null);
	});

	it("picks the most recent marker comment when multiple exist", async () => {
		const repo = seedRepo();
		const comments = {
			comments: [
				{ body: `<!-- autopilot-plan -->\nOLD`, createdAt: "2026-01-01T00:00:00Z" },
				{ body: `<!-- autopilot-plan -->\nNEW`, createdAt: "2026-02-01T00:00:00Z" },
			],
		};
		const { run } = makeStub({ routes: [{ match: (a) => a[1] === "view", stdout: JSON.stringify(comments) }] });
		const r = mk({ repo, ghRun: run });
		const path = await r.getItemPlan({ id: "42" });
		assert.equal(readFileSync(path!, "utf-8"), "NEW");
	});

	it("throws a clear 'not yet implemented' for plan-location=pr-description", async () => {
		const r = mk({ repo: "/tmp", planLocation: "pr-description" });
		await assert.rejects(() => r.getItemPlan({ id: "42" }), /pr-description.*not yet implemented/);
	});
});

describe("GitHubIssuesRoadmap — gh error surface", () => {
	it("maps 'command not found' to 'gh CLI required'", async () => {
		const { run } = makeStub({ fallback: { stderr: "gh: command not found", status: 127 } });
		const r = mk({ repo: "/tmp", ghRun: run });
		await assert.rejects(() => r.listOpenItems(), /gh CLI required/);
	});

	it("maps 'authentication required' stderr to 'gh CLI not authenticated'", async () => {
		const { run } = makeStub({ fallback: { stderr: "error: authentication required — run gh auth login", status: 4 } });
		const r = mk({ repo: "/tmp", ghRun: run });
		await assert.rejects(() => r.listOpenItems(), /not authenticated/);
	});

	it("maps ENOENT from ghRun to 'gh CLI required'", async () => {
		const run: GhRunner = () => {
			const err: NodeJS.ErrnoException = new Error("spawn gh ENOENT");
			err.code = "ENOENT";
			throw err;
		};
		const r = mk({ repo: "/tmp", ghRun: run });
		await assert.rejects(() => r.listOpenItems(), /gh CLI required/);
	});
});

describe("getRoadmapSource — github-issues factory", () => {
	it("constructs GitHubIssuesRoadmap when github config is supplied", () => {
		const src = getRoadmapSource("github-issues", {
			repo: "/tmp",
			github: { ghRepo: "acme/widgets", label: "autopilot", planLocation: "issue-comment" },
		});
		assert.ok(src instanceof GitHubIssuesRoadmap);
		assert.equal(src.name, "github-issues");
	});

	it("throws when github.ghRepo is missing/empty", () => {
		assert.throws(() => getRoadmapSource("github-issues", { repo: "/tmp", github: { ghRepo: "", label: "autopilot", planLocation: "issue-comment" } }), /roadmap\.github\.repo/);
		assert.throws(() => getRoadmapSource("github-issues", { repo: "/tmp" }), /roadmap\.github\.repo/);
	});
});

describe("GitHubIssuesRoadmap.publishPlan — idempotent upsert (#98)", () => {
	const commentsRoute = (stdout: string) => ({ match: (a: string[]) => a[0] === "issue" && a[1] === "view" && a.includes("comments"), stdout });

	it("posts a new marked comment when no plan comment exists", async () => {
		const dir = seedRepo();
		const { run, calls } = makeStub({ routes: [commentsRoute(JSON.stringify({ comments: [] }))] });
		await mk({ repo: dir, ghRun: run }).publishPlan("PLAN BODY", { id: "5", worktree: dir });
		const post = calls.find((c) => c.args[0] === "issue" && c.args[1] === "comment");
		assert.ok(post, "posts a new comment when none exists");
		assert.ok(post?.args.includes("--body") && post.args.some((s) => s.includes("PLAN BODY")));
		assert.ok(!calls.some((c) => c.args[0] === "api"), "no PATCH when there is nothing to edit");
		rmSync(dir, { recursive: true, force: true });
	});

	it("edits the existing plan comment (by REST id) instead of duplicating", async () => {
		const dir = seedRepo();
		const comments = {
			comments: [
				// a newer NON-marker comment must not shadow the marker comment
				{ body: "unrelated", createdAt: "2026-07-02T00:00:00Z", url: "https://github.com/acme/widgets/issues/5#issuecomment-43" },
				{ body: "<!-- autopilot-plan -->\nold plan", createdAt: "2026-07-01T00:00:00Z", url: "https://github.com/acme/widgets/issues/5#issuecomment-42" },
			],
		};
		const { run, calls } = makeStub({ routes: [commentsRoute(JSON.stringify(comments))] });
		await mk({ repo: dir, ghRun: run }).publishPlan("NEW PLAN", { id: "5", worktree: dir });
		const patch = calls.find((c) => c.args[0] === "api" && c.args.includes("PATCH"));
		assert.ok(patch, "PATCHes the existing plan comment");
		assert.ok(patch?.args.includes("repos/acme/widgets/issues/comments/42"), "targets the marker comment's REST id");
		assert.ok(patch?.args.some((s) => s.startsWith("body=") && s.includes("NEW PLAN")));
		assert.ok(!calls.some((c) => c.args[0] === "issue" && c.args[1] === "comment"), "does not post a duplicate");
		rmSync(dir, { recursive: true, force: true });
	});
});
