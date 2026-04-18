import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { getRoadmapSource } from "../roadmap/index.js";
import { type LinearApi, type LinearCommentNode, type LinearIssueListItem, LinearRoadmap } from "../roadmap/linear.js";

function seedRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "autopilot-linear-roadmap-test-"));
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
}

interface StubOpts {
	issues?: LinearIssueListItem[];
	issuesByIdentifier?: Record<string, { id: string; identifier: string; title: string } | null>;
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

describe("LinearRoadmap.parseItemId", () => {
	const r = mk({ repo: "/tmp" });

	it("extracts from feat/<team>-<n> branch names", () => {
		assert.equal(r.parseItemId("feat/eng-42"), "ENG-42");
		assert.equal(r.parseItemId("feat/eng-42-fix-bug"), "ENG-42");
		assert.equal(r.parseItemId("checked out feat/tool-7-thing"), "TOOL-7");
	});

	it("extracts bare TEAM-<n>", () => {
		assert.equal(r.parseItemId("Closes ENG-42"), "ENG-42");
		assert.equal(r.parseItemId("TOOL-9"), "TOOL-9");
	});

	it("returns null when no match", () => {
		assert.equal(r.parseItemId("nothing in here"), null);
		assert.equal(r.parseItemId("feat/some-other-branch"), null);
	});
});

describe("LinearRoadmap.isQuickScope", () => {
	const r = mk({ repo: "/tmp" });
	it("true for scope: S / XS", () => {
		assert.equal(r.isQuickScope("scope: S"), true);
		assert.equal(r.isQuickScope("Scope: XS"), true);
	});
	it("true for bug / fix: markers", () => {
		assert.equal(r.isQuickScope("bug in parser"), true);
		assert.equal(r.isQuickScope("fix: oops"), true);
	});
	it("false for scope: M", () => {
		assert.equal(r.isQuickScope("scope: M"), false);
	});
});

describe("LinearRoadmap.listOpenItems", () => {
	it("maps a 3-issue response, extracts deps from relations", async () => {
		const issues: LinearIssueListItem[] = [
			{
				id: "u1",
				identifier: "ENG-1",
				title: "First",
				description: null,
				relations: [
					{ type: "blocked_by", relatedIdentifier: "ENG-2" },
					{ type: "blocks", relatedIdentifier: "ENG-3" },
				],
			},
			{ id: "u2", identifier: "ENG-2", title: "Second", description: null, relations: [] },
			{ id: "u3", identifier: "ENG-3", title: "Third", description: "body", relations: [] },
		];
		const { api, calls } = makeStub({ issues });
		const r = mk({ repo: "/tmp", teamId: "team-x", api });
		const items = await r.listOpenItems();
		assert.equal(items.length, 3);
		assert.equal(items[0].id, "ENG-1");
		assert.equal(items[0].title, "First");
		assert.equal(items[0].deps, "ENG-2, ENG-3");
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
	it("transitions to started, adds in-progress label, creates worktree, returns slugged branch", async () => {
		const repo = seedRepo();
		const id = freshId();
		const { api, calls } = makeStub({
			issuesByIdentifier: { [id]: { id: `uuid-${id}`, identifier: id, title: "Fix the Thing: Make it Better!" } },
		});
		const r = mk({ repo, teamId: "team-x", api });
		const { branch, worktree } = await r.claimItem(id);

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

	it("reads issue comment when no local file, writes .dev/plans/<id>.md, strips marker", async () => {
		const repo = seedRepo();
		const planBody = "# Plan for ENG-42\n\nSteps go here.\n";
		const { api } = makeStub({
			comments: {
				"ENG-42": [
					{ body: "unrelated chatter", createdAt: "2026-01-01T00:00:00Z" },
					{ body: `<!-- autopilot-plan -->\n${planBody}`, createdAt: "2026-02-01T00:00:00Z" },
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
					{ body: `<!-- autopilot-plan -->\nOLD`, createdAt: "2026-01-01T00:00:00Z" },
					{ body: `<!-- autopilot-plan -->\nNEW`, createdAt: "2026-02-01T00:00:00Z" },
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
