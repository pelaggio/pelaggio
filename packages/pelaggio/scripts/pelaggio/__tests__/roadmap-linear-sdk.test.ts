import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LinearRoadmap, type LinearSdkClient, linearApiFromClient } from "../roadmap/linear.js";

const TEAM = "team-1";

interface FakeIssue {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	labels: string[];
	stateType: string;
}

interface FakeLabel {
	id: string;
	name: string;
	teamId?: string;
}

/**
 * Mirrors the `@linear/sdk` v82+ shapes the adapter has to cope with: payload relations
 * (`IssuePayload.issue`, `IssueLabelPayload.issueLabel`, `Issue.state`) are getters returning
 * promises, while connections (`labels()`, `inverseRelations()`) are methods.
 */
function sdkIssue(it: FakeIssue) {
	return {
		id: it.id,
		identifier: it.identifier,
		title: it.title,
		description: it.description,
		get state() {
			return Promise.resolve({ type: it.stateType });
		},
		labels: async () => ({ nodes: it.labels.map((name) => ({ name })) }),
		inverseRelations: async () => ({ nodes: [] }),
	};
}

function makeClient(opts: { issues?: FakeIssue[]; labels?: FakeLabel[]; createIssueSuccess?: boolean; createLabelSuccess?: boolean; payloadIssueAsMethod?: boolean } = {}) {
	const labels = [...(opts.labels ?? [])];
	const calls = { createIssue: [] as unknown[], createIssueLabel: [] as unknown[] };
	const client = {
		async issues() {
			return { nodes: (opts.issues ?? []).map(sdkIssue) };
		},
		async issue(identifier: string) {
			const it = (opts.issues ?? []).find((i) => i.identifier === identifier);
			return it ? sdkIssue(it) : null;
		},
		async createComment() {},
		async updateIssue() {},
		async workflowStates() {
			return { nodes: [] };
		},
		async issueLabels(args: { filter: { name: { eq: string } } }) {
			return { nodes: labels.filter((l) => l.name === args.filter.name.eq) };
		},
		async createIssueLabel(input: { name: string; teamId: string }) {
			calls.createIssueLabel.push(input);
			if (opts.createLabelSuccess === false) return { success: false };
			const label = { id: `lbl-${input.name}`, name: input.name, teamId: input.teamId };
			labels.push(label);
			return {
				success: true,
				get issueLabel() {
					return Promise.resolve(label);
				},
			};
		},
		async createIssue(input: { teamId: string; title: string; labelIds?: string[] }) {
			calls.createIssue.push(input);
			if (opts.createIssueSuccess === false) return { success: false };
			const created = sdkIssue({ id: "uuid-9", identifier: "FAT-9", title: input.title, description: null, labels: [], stateType: "unstarted" });
			if (opts.payloadIssueAsMethod) return { success: true, issue: async () => created };
			return {
				success: true,
				get issue() {
					return Promise.resolve(created);
				},
			};
		},
	};
	return { client: client as unknown as LinearSdkClient, calls };
}

describe("linearApiFromClient.createIssue", () => {
	it("resolves the SDK's IssuePayload.issue getter (promise, not a function)", async () => {
		const { client } = makeClient();
		const created = await linearApiFromClient(client, TEAM).createIssue({ teamId: TEAM, title: "New item" });
		assert.deepEqual(created, { id: "uuid-9", identifier: "FAT-9", title: "New item" });
	});

	it("still accepts the older method-shaped payload", async () => {
		const { client } = makeClient({ payloadIssueAsMethod: true });
		const created = await linearApiFromClient(client, TEAM).createIssue({ teamId: TEAM, title: "New item" });
		assert.equal(created.identifier, "FAT-9");
	});

	it("throws when the mutation reports success: false", async () => {
		const { client } = makeClient({ createIssueSuccess: false });
		await assert.rejects(linearApiFromClient(client, TEAM).createIssue({ teamId: TEAM, title: "x" }), /success: false/);
	});

	it("uses the configured team's label over another team's same-named label", async () => {
		const { client, calls } = makeClient({
			labels: [
				{ id: "other-team", name: "pelaggio", teamId: "team-2" },
				{ id: "ours", name: "pelaggio", teamId: TEAM },
			],
		});
		await linearApiFromClient(client, TEAM).createIssue({ teamId: TEAM, title: "x", labelNames: ["pelaggio"] });
		assert.deepEqual((calls.createIssue[0] as { labelIds?: string[] }).labelIds, ["ours"]);
	});

	it("falls back to a workspace-level label", async () => {
		const { client, calls } = makeClient({ labels: [{ id: "ws", name: "pelaggio" }] });
		await linearApiFromClient(client, TEAM).createIssue({ teamId: TEAM, title: "x", labelNames: ["pelaggio"] });
		assert.deepEqual((calls.createIssue[0] as { labelIds?: string[] }).labelIds, ["ws"]);
	});

	it("creates a missing label on the team instead of dropping it", async () => {
		const { client, calls } = makeClient({ labels: [{ id: "p", name: "pelaggio", teamId: TEAM }] });
		await linearApiFromClient(client, TEAM).createIssue({ teamId: TEAM, title: "x", labelNames: ["pelaggio", "deferred"] });
		assert.deepEqual(calls.createIssueLabel, [{ name: "deferred", teamId: TEAM }]);
		assert.deepEqual((calls.createIssue[0] as { labelIds?: string[] }).labelIds, ["p", "lbl-deferred"]);
	});

	it("refuses before creating the issue when a label can't be resolved or created", async () => {
		const { client, calls } = makeClient({ createLabelSuccess: false });
		await assert.rejects(linearApiFromClient(client, TEAM).createIssue({ teamId: TEAM, title: "x", labelNames: ["deferred"] }), /could not be created/);
		assert.equal(calls.createIssue.length, 0);
	});
});

describe("LinearRoadmap over the SDK runner — labels", () => {
	const issues: FakeIssue[] = [
		{ id: "u1", identifier: "FAT-1", title: "Plain", description: null, labels: ["pelaggio"], stateType: "unstarted" },
		{ id: "u2", identifier: "FAT-2", title: "Deferred", description: null, labels: ["pelaggio", "deferred"], stateType: "backlog" },
		{ id: "u3", identifier: "FAT-3", title: "Claimed", description: null, labels: ["pelaggio", "in-progress"], stateType: "unstarted" },
	];

	function roadmap(): LinearRoadmap {
		const { client } = makeClient({ issues });
		return new LinearRoadmap({ repo: "/nonexistent", teamId: TEAM, label: "pelaggio", planLocation: "issue-comment", api: linearApiFromClient(client, TEAM) });
	}

	it("listItems reads labels: deferred flag and in-progress claim marker", async () => {
		const items = await roadmap().listItems();
		const byId = (id: string) => {
			const item = items.find((i) => i.id === id);
			assert.ok(item, `missing ${id}`);
			return item;
		};
		assert.equal(byId("FAT-1").deferred, undefined);
		assert.equal(byId("FAT-1").status, "open");
		assert.equal(byId("FAT-2").deferred, true);
		assert.equal(byId("FAT-3").status, "in-progress");
	});

	it("getItem projects the deferred label", async () => {
		const item = await roadmap().getItem("FAT-2");
		assert.equal(item?.deferred, true);
		assert.deepEqual(item?.labels, ["pelaggio", "deferred"]);
	});
});
