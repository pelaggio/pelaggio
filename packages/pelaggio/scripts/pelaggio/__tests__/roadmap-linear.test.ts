import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getRoadmapSource } from "../roadmap/index.js";
import { type LinearApi, type LinearCommentNode, type LinearIssueListItem, LinearRoadmap } from "../roadmap/linear.js";

function seedRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pelaggio-linear-roadmap-test-"));
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

interface ApiCalls {
	listIssues: { teamId: string; label?: string }[];
	getIssue: string[];
	createComment: { issueId: string; body: string }[];
	transitionIssue: { issueId: string; teamId: string; stateType: "started" | "completed" }[];
	addLabel: { issueId: string; labelName: string }[];
	removeLabel: { issueId: string; labelName: string }[];
	getIssueComments: string[];
	createIssue: Parameters<LinearApi["createIssue"]>[0][];
}

interface StubOpts {
	issues?: LinearIssueListItem[];
	issuesByIdentifier?: Record<string, Awaited<ReturnType<LinearApi["getIssue"]>>>;
	comments?: Record<string, LinearCommentNode[]>;
	addLabelError?: Error;
	removeLabelError?: Error;
	transitionError?: Error;
}

function makeStub(opts: StubOpts = {}): { api: LinearApi; calls: ApiCalls } {
	const calls: ApiCalls = {
		listIssues: [],
		getIssue: [],
		createComment: [],
		transitionIssue: [],
		addLabel: [],
		removeLabel: [],
		getIssueComments: [],
		createIssue: [],
	};
	const api: LinearApi = {
		async listIssues(args) {
			calls.listIssues.push(args);
			return opts.issues ?? [];
		},
		async getIssue(identifier) {
			calls.getIssue.push(identifier);
			if (opts.issuesByIdentifier && identifier in opts.issuesByIdentifier) return opts.issuesByIdentifier[identifier];
			return { id: `uuid-${identifier}`, identifier, title: identifier };
		},
		async createComment(issueId, body) {
			calls.createComment.push({ issueId, body });
		},
		async transitionIssue(issueId, teamId, stateType) {
			calls.transitionIssue.push({ issueId, teamId, stateType });
			if (opts.transitionError) throw opts.transitionError;
		},
		async addLabel(issueId, labelName) {
			calls.addLabel.push({ issueId, labelName });
			if (opts.addLabelError) throw opts.addLabelError;
		},
		async removeLabel(issueId, labelName) {
			calls.removeLabel.push({ issueId, labelName });
			if (opts.removeLabelError) throw opts.removeLabelError;
		},
		async getIssueComments(identifier) {
			calls.getIssueComments.push(identifier);
			return opts.comments?.[identifier] ?? [];
		},
		async createIssue(input) {
			calls.createIssue.push(input);
			return { id: "uuid-new", identifier: "ENG-99", title: input.title };
		},
	};
	return { api, calls };
}

function mk(opts: { repo: string; teamId?: string; label?: string; planLocation?: "issue-comment" | "pr-description"; api?: LinearApi }): LinearRoadmap {
	return new LinearRoadmap({
		repo: opts.repo,
		teamId: opts.teamId ?? "team-uuid",
		label: opts.label ?? "",
		planLocation: opts.planLocation ?? "issue-comment",
		api: opts.api,
	});
}

describe("LinearRoadmap.createItem", () => {
	it("preserves the charter before generated metadata", async () => {
		const { api, calls } = makeStub();
		const r = mk({ repo: "/tmp", api });

		await r.createItem({ title: "Concise", description: "Full charter", scope: "S", deps: ["ENG-1"] });

		assert.equal(calls.createIssue.length, 1);
		assert.equal(calls.createIssue[0].description, "Full charter\nDepends on: ENG-1\nScope: S");
	});
});

describe("LinearRoadmap.parseItemId", () => {
	const r = mk({ repo: "/tmp" });

	it("extracts from feat/<team>-<n> branch names", async () => {
		assert.equal(await r.parseItemId("feat/eng-42"), "ENG-42");
		assert.equal(await r.parseItemId("feat/eng-42-fix-bug"), "ENG-42");
		assert.equal(await r.parseItemId("checked out feat/tool-7-thing"), "TOOL-7");
	});

	it("extracts bare TEAM-<n>", async () => {
		assert.equal(await r.parseItemId("Closes ENG-42"), "ENG-42");
		assert.equal(await r.parseItemId("TOOL-9"), "TOOL-9");
	});

	it("returns null when no match", async () => {
		assert.equal(await r.parseItemId("nothing in here"), null);
		assert.equal(await r.parseItemId("feat/some-other-branch"), null);
	});
});

describe("LinearRoadmap.getItem", () => {
	it("exposes labels from the issue response", async () => {
		const { api } = makeStub({
			issuesByIdentifier: {
				"ENG-42": {
					id: "uuid-42",
					identifier: "ENG-42",
					title: "Fix widget",
					labels: ["autopilot", "scope: L"],
				},
			},
		});
		const r = mk({ repo: "/tmp", api });
		const item = await r.getItem("ENG-42");
		assert.deepEqual(item?.labels, ["autopilot", "scope: L"]);
	});

	it("projects description into body (null becomes empty string)", async () => {
		const { api } = makeStub({
			issuesByIdentifier: {
				"ENG-10": {
					id: "uuid-10",
					identifier: "ENG-10",
					title: "With body",
					description: "Scope: L\n\nDeliver the full workflow.",
				},
				"ENG-11": {
					id: "uuid-11",
					identifier: "ENG-11",
					title: "Null description",
					description: null,
				},
			},
		});
		const r = mk({ repo: "/tmp", api });
		assert.equal((await r.getItem("ENG-10"))?.body, "Scope: L\n\nDeliver the full workflow.");
		assert.equal((await r.getItem("ENG-11"))?.body, "");
	});

	it("derives blockers from incoming blocks relations and preserves done precedence", async () => {
		const { api } = makeStub({
			issuesByIdentifier: {
				"ENG-2": {
					id: "uuid-2",
					identifier: "ENG-2",
					title: "Blocked issue",
					stateType: "started",
					inverseRelations: [
						{ type: "blocks", relatedIdentifier: "ENG-1" },
						{ type: "related", relatedIdentifier: "ENG-3" },
					],
				},
				"ENG-4": {
					id: "uuid-4",
					identifier: "ENG-4",
					title: "Completed blocked issue",
					stateType: "completed",
					inverseRelations: [{ type: "blocks", relatedIdentifier: "ENG-1" }],
				},
			},
		});
		const r = mk({ repo: "/tmp", api });

		const blocked = await r.getItem("ENG-2");
		assert.equal(blocked?.deps, "ENG-1");
		assert.equal(blocked?.status, "blocked");
		assert.equal((await r.getItem("ENG-4"))?.status, "done");
	});
});

describe("LinearRoadmap.listItems", () => {
	it("models both sides of A blocks B with the correct dependency direction", async () => {
		const { api } = makeStub({
			issues: [
				{
					id: "u1",
					identifier: "ENG-1",
					title: "Blocker",
					description: null,
				},
				{
					id: "u2",
					identifier: "ENG-2",
					title: "Blocked",
					description: null,
					inverseRelations: [
						{ type: "blocks", relatedIdentifier: "ENG-1" },
						{ type: "related", relatedIdentifier: "ENG-3" },
					],
				},
			],
		});
		const items = await mk({ repo: "/tmp", api }).listItems();

		assert.deepEqual(
			items.map(({ id, deps, status }) => ({ id, deps, status })),
			[
				{ id: "ENG-1", deps: "", status: "open" },
				{ id: "ENG-2", deps: "ENG-1", status: "blocked" },
			],
		);
	});
});

describe("LinearRoadmap.listOpenItems", () => {
	it("extracts deps only from incoming blocks relations", async () => {
		const issues: LinearIssueListItem[] = [
			{
				id: "u1",
				identifier: "ENG-1",
				title: "First",
				description: null,
				inverseRelations: [
					{ type: "blocks", relatedIdentifier: "ENG-2" },
					{ type: "related", relatedIdentifier: "ENG-4" },
				],
			},
			{ id: "u2", identifier: "ENG-2", title: "Second", description: null },
			{ id: "u3", identifier: "ENG-3", title: "Third", description: "body" },
		];
		const { api, calls } = makeStub({ issues });
		const r = mk({ repo: "/tmp", teamId: "team-x", api });
		const items = await r.listOpenItems();
		assert.equal(items.length, 3);
		assert.equal(items[0].id, "ENG-1");
		assert.equal(items[0].title, "First");
		assert.equal(items[0].deps, "ENG-2");
		assert.equal(items[1].deps, "");
		assert.equal(items[0].sourceRef, "ENG-1");
		assert.equal(calls.listIssues[0].teamId, "team-x");
		assert.equal(calls.listIssues[0].label, undefined);
	});

	it("returns [] on empty response", async () => {
		const { api } = makeStub({ issues: [] });
		const r = mk({ repo: "/tmp", api });
		assert.deepEqual(await r.listOpenItems(), []);
	});

	it("passes label filter through to the api", async () => {
		const { api, calls } = makeStub({ issues: [] });
		const r = mk({ repo: "/tmp", label: "triage", api });
		await r.listOpenItems();
		assert.equal(calls.listIssues[0].label, "triage");
	});
});

let claimCounter = 20_000;
function freshId(): string {
	claimCounter += 1;
	return `ENG-${claimCounter + Math.floor(Math.random() * 1000)}`;
}

describe("LinearRoadmap.claimItem", () => {
	const claimedWorktrees: string[] = [];
	afterEach(() => {
		while (claimedWorktrees.length) rmSync(claimedWorktrees.pop() as string, { recursive: true, force: true });
	});

	it("transitions to started, adds in-progress label, creates worktree, returns slugged branch", async () => {
		const repo = seedRepo();
		const id = freshId();
		const { api, calls } = makeStub({
			issuesByIdentifier: { [id]: { id: `uuid-${id}`, identifier: id, title: "Fix the Thing: Make it Better!" } },
		});
		const r = mk({ repo, teamId: "team-x", api });
		const { branch, worktree } = await r.claimItem(id);
		claimedWorktrees.push(worktree);

		const lower = id.toLowerCase();
		assert.match(branch, new RegExp(`^feat/${lower}-fix-the-thing`));
		assert.ok(branch.length <= `feat/${lower}-`.length + 40);
		assert.ok(worktree.endsWith(`-${lower}`), `worktree should end with -${lower}, got ${worktree}`);

		assert.deepEqual(calls.transitionIssue[0], { issueId: `uuid-${id}`, teamId: "team-x", stateType: "started" });
		assert.deepEqual(calls.addLabel[0], { issueId: `uuid-${id}`, labelName: "in-progress" });

		const wtList = execSync("git worktree list", { cwd: repo, encoding: "utf-8" });
		assert.ok(wtList.includes(worktree));
	});

	it("tolerates addLabel error but still creates worktree", async () => {
		const repo = seedRepo();
		const id = freshId();
		const { api } = makeStub({
			issuesByIdentifier: { [id]: { id: `uuid-${id}`, identifier: id, title: "Short" } },
			addLabelError: new Error("label missing"),
		});
		const r = mk({ repo, api });
		const { branch, worktree } = await r.claimItem(id);
		claimedWorktrees.push(worktree);
		assert.ok(branch.startsWith(`feat/${id.toLowerCase()}`));
		const wtList = execSync("git worktree list", { cwd: repo, encoding: "utf-8" });
		assert.ok(wtList.includes(worktree));
	});

	it("throws when issue lookup returns null", async () => {
		const repo = seedRepo();
		const { api } = makeStub({ issuesByIdentifier: { "ENG-99": null } });
		const r = mk({ repo, api });
		await assert.rejects(() => r.claimItem("ENG-99"), /not found/);
	});
});

describe("LinearRoadmap.markDone", () => {
	it("comments with note, transitions to completed, strips label", async () => {
		const { api, calls } = makeStub({
			issuesByIdentifier: { "ENG-42": { id: "uuid-42", identifier: "ENG-42", title: "Thing" } },
		});
		const r = mk({ repo: "/tmp", teamId: "team-x", api });
		await r.markDone("ENG-42", { note: "landed in feat/eng-42" });

		assert.equal(calls.createComment.length, 1);
		assert.equal(calls.createComment[0].issueId, "uuid-42");
		assert.match(calls.createComment[0].body, /Shipped — landed in feat\/eng-42/);

		assert.deepEqual(calls.transitionIssue[0], { issueId: "uuid-42", teamId: "team-x", stateType: "completed" });
		assert.deepEqual(calls.removeLabel[0], { issueId: "uuid-42", labelName: "in-progress" });
	});

	it("comments 'Shipped' with no note", async () => {
		const { api, calls } = makeStub({
			issuesByIdentifier: { "ENG-5": { id: "uuid-5", identifier: "ENG-5", title: "Five" } },
		});
		const r = mk({ repo: "/tmp", api });
		await r.markDone("ENG-5");
		assert.equal(calls.createComment[0].body, "Shipped");
	});

	it("tolerates removeLabel error", async () => {
		const { api } = makeStub({
			issuesByIdentifier: { "ENG-5": { id: "uuid-5", identifier: "ENG-5", title: "Five" } },
			removeLabelError: new Error("missing"),
		});
		const r = mk({ repo: "/tmp", api });
		await r.markDone("ENG-5");
	});
});

describe("LinearRoadmap.getItemPlan", () => {
	it("returns local docs/plans file without any api comment call when present", async () => {
		const repo = seedRepo();
		seedFile(repo, "docs/plans/eng-42-fix-thing.md", "# plan\n");
		const { api, calls } = makeStub({});
		const r = mk({ repo, api });
		const path = await r.getItemPlan({ id: "ENG-42" });
		assert.ok(path?.endsWith("eng-42-fix-thing.md"));
		assert.equal(calls.getIssueComments.length, 0);
	});

	it("prefers the supplied worktree plan over a repo-local stale plan without any api comment call", async () => {
		const repo = seedRepo();
		const worktree = seedRepo();
		seedFile(repo, ".dev/plans/eng-42.md", "OLD");
		seedFile(worktree, ".dev/plans/eng-42.md", "NEW");
		const { api, calls } = makeStub({});
		const r = mk({ repo, api });
		const path = await r.getItemPlan({ id: "ENG-42", worktree });
		assert.equal(path, resolve(worktree, ".dev", "plans", "eng-42.md"));
		assert.equal(readFileSync(path!, "utf-8"), "NEW");
		assert.equal(calls.getIssueComments.length, 0);
	});

	it("reads issue comment when no local file, writes .dev/plans/<id>.md, strips marker", async () => {
		const repo = seedRepo();
		const planBody = "# Plan for ENG-42\n\nSteps go here.\n";
		const { api } = makeStub({
			comments: {
				"ENG-42": [
					{ body: "unrelated chatter", createdAt: "2026-01-01T00:00:00Z" },
					{ body: `<!-- pelaggio-plan -->\n${planBody}`, createdAt: "2026-02-01T00:00:00Z" },
				],
			},
		});
		const r = mk({ repo, api });
		const path = await r.getItemPlan({ id: "ENG-42" });
		assert.ok(path?.endsWith(".dev/plans/eng-42.md"));
		assert.equal(readFileSync(path!, "utf-8"), planBody);
	});

	it("returns null when no local file and no matching comment", async () => {
		const repo = seedRepo();
		const { api } = makeStub({
			comments: { "ENG-42": [{ body: "chatter", createdAt: "2026-01-01T00:00:00Z" }] },
		});
		const r = mk({ repo, api });
		assert.equal(await r.getItemPlan({ id: "ENG-42" }), null);
	});

	it("picks the most recent marker comment when multiple exist", async () => {
		const repo = seedRepo();
		const { api } = makeStub({
			comments: {
				"ENG-42": [
					{ body: `<!-- pelaggio-plan -->\nOLD`, createdAt: "2026-01-01T00:00:00Z" },
					{ body: `<!-- pelaggio-plan -->\nNEW`, createdAt: "2026-02-01T00:00:00Z" },
				],
			},
		});
		const r = mk({ repo, api });
		const path = await r.getItemPlan({ id: "ENG-42" });
		assert.equal(readFileSync(path!, "utf-8"), "NEW");
	});

	it("throws 'not yet implemented' for plan-location=pr-description", async () => {
		const r = mk({ repo: "/tmp", planLocation: "pr-description" });
		await assert.rejects(() => r.getItemPlan({ id: "ENG-42" }), /pr-description.*not yet implemented/);
	});
});

describe("LinearRoadmap — error surface", () => {
	it("throws clear diagnostic when LINEAR_API_KEY missing and no api injected", async () => {
		const savedKey = process.env.LINEAR_API_KEY;
		delete process.env.LINEAR_API_KEY;
		try {
			const r = mk({ repo: "/tmp" });
			// Override seeded api to force default path
			Object.assign(r, { apiSeed: undefined });
			await assert.rejects(() => r.listOpenItems(), /LINEAR_API_KEY/);
		} finally {
			if (savedKey !== undefined) process.env.LINEAR_API_KEY = savedKey;
		}
	});
});

describe("getRoadmapSource — linear factory", () => {
	it("constructs LinearRoadmap when linear config is supplied", () => {
		const src = getRoadmapSource("linear", {
			repo: "/tmp",
			linear: { teamId: "team-x", label: "", planLocation: "issue-comment" },
		});
		assert.ok(src instanceof LinearRoadmap);
		assert.equal(src.name, "linear");
	});

	it("throws when linear.teamId is missing/empty", () => {
		assert.throws(() => getRoadmapSource("linear", { repo: "/tmp", linear: { teamId: "", label: "", planLocation: "issue-comment" } }), /roadmap\.linear\.team/);
		assert.throws(() => getRoadmapSource("linear", { repo: "/tmp" }), /roadmap\.linear\.team/);
	});
});
