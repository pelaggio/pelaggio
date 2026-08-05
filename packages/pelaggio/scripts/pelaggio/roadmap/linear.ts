import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hasCharterProvenance, parseCharterMarker, provenanceFromCreateOpts, stripCharterMarker, withCharterMarker } from "./charter-provenance.js";
import { createClaimWorkspace } from "./git-claim.js";
import type { CreateItemOpts, ItemStatus, LinearRoadmapConfig, MarkDoneContext, PlanLocation, ReviewProvenance, RoadmapItem, RoadmapItemStatus, RoadmapSource, RoadmapSourceName } from "./types.js";

const PLAN_MARKER = "<!-- pelaggio-plan -->";
const IN_PROGRESS_LABEL = "in-progress";
const LABEL_DEFERRED = "deferred";

/** Apply parsed charter provenance + the deferred label/marker to a projected item (#367). */
function applyCharterProjection(item: RoadmapItemStatus, description: string | null | undefined, labels: readonly string[]): void {
	const provenance = parseCharterMarker(description ?? "");
	// listIssues does not fetch labels, so the marker's own deferred flag is the round-trip signal there;
	// getItem fetches labels and the `deferred` label is the SoT when present.
	if (labels.includes(LABEL_DEFERRED) || provenance?.deferred) item.deferred = true;
	if (provenance) {
		if (provenance.reviewDigest) item.reviewDigest = provenance.reviewDigest;
		if (provenance.level) item.reviewLevel = provenance.level;
	}
}

interface LinearIssueRelation {
	type: string;
	relatedIdentifier: string;
}

export interface LinearIssueListItem {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	inverseRelations?: LinearIssueRelation[];
	/** Optional claim markers (issue #12); stubs that omit them read as unclaimed. */
	stateType?: string;
	labels?: string[];
}

export interface LinearCommentNode {
	body: string;
	createdAt: string;
}

/**
 * Narrow facade over `@linear/sdk`. Methods match adapter needs, not the SDK surface.
 * Tests inject a stub implementation; production path lazy-imports `@linear/sdk`.
 */
export interface LinearApi {
	listIssues(opts: { teamId: string; label?: string; includeDone?: boolean }): Promise<LinearIssueListItem[]>;
	getIssue(identifier: string): Promise<{ id: string; identifier: string; title: string; description?: string | null; stateType?: string; labels?: string[]; inverseRelations?: LinearIssueRelation[] } | null>;
	createComment(issueId: string, body: string): Promise<void>;
	transitionIssue(issueId: string, teamId: string, stateType: "started" | "completed"): Promise<void>;
	addLabel(issueId: string, labelName: string): Promise<void>;
	removeLabel(issueId: string, labelName: string): Promise<void>;
	/** Charter-review activation re-stamps the description marker before deferral can be cleared (#367). */
	updateDescription(issueId: string, description: string): Promise<void>;
	getIssueComments(identifier: string): Promise<LinearCommentNode[]>;
	createIssue(input: { teamId: string; title: string; description?: string; labelNames?: string[] }): Promise<{ id: string; identifier: string; title: string }>;
}

export interface LinearRoadmapOpts extends LinearRoadmapConfig {
	/** Local git repo root (for worktree creation). */
	repo: string;
	/** Injectable for tests; defaults to an SDK-backed runner built on first use. */
	api?: LinearApi;
}

export class LinearRoadmap implements RoadmapSource {
	readonly name: RoadmapSourceName = "linear";
	private readonly repo: string;
	private readonly teamId: string;
	private readonly label: string;
	private readonly planLocation: PlanLocation;
	private readonly apiSeed?: LinearApi;
	private cachedApi?: LinearApi;

	constructor(opts: LinearRoadmapOpts) {
		this.repo = opts.repo;
		this.teamId = opts.teamId;
		this.label = opts.label;
		this.planLocation = opts.planLocation;
		this.apiSeed = opts.api;
	}

	private async api(): Promise<LinearApi> {
		if (this.apiSeed) return this.apiSeed;
		if (!this.cachedApi) this.cachedApi = await defaultLinearApi();
		return this.cachedApi;
	}

	async parseItemId(text: string): Promise<string | null> {
		const branch = text.match(/\bfeat\/([a-z][a-z0-9]*-\d+)(?:[-/]|$)/i);
		if (branch) return branch[1].toUpperCase();
		const bare = text.match(/\b([A-Za-z][A-Za-z0-9]*-\d+)\b/);
		if (bare) return bare[1].toUpperCase();
		return null;
	}

	async listItems(opts?: { includeDone?: boolean }): Promise<RoadmapItemStatus[]> {
		const api = await this.api();
		const issues = await api.listIssues({ teamId: this.teamId, label: this.label || undefined, includeDone: opts?.includeDone });
		return issues.map((it) => {
			const inverseRelations = it.inverseRelations ?? [];
			const blocked = hasBlocker(inverseRelations);
			// Server-side claim markers double as the cross-host claim signal (issue #12).
			const claimed = it.stateType === "started" || (it.labels ?? []).includes(IN_PROGRESS_LABEL);
			const status: ItemStatus = blocked ? "blocked" : claimed ? "in-progress" : "open";
			const item: RoadmapItemStatus = {
				id: it.identifier,
				title: it.title,
				deps: formatBlockers(inverseRelations),
				sourceRef: it.identifier,
				status,
			};
			applyCharterProjection(item, it.description, it.labels ?? []);
			return item;
		});
	}

	async getItem(id: string): Promise<RoadmapItemStatus | null> {
		const api = await this.api();
		const issue = await api.getIssue(id);
		if (!issue) return null;
		const inverseRelations = issue.inverseRelations ?? [];
		let status: ItemStatus = "open";
		if (issue.stateType === "completed" || issue.stateType === "canceled") status = "done";
		else if (hasBlocker(inverseRelations)) status = "blocked";
		else if (issue.stateType === "started" || (issue.labels ?? []).includes(IN_PROGRESS_LABEL)) status = "in-progress";
		const item: RoadmapItemStatus = {
			id: issue.identifier,
			title: issue.title,
			deps: formatBlockers(inverseRelations),
			sourceRef: issue.identifier,
			status,
			body: issue.description ?? "",
			labels: issue.labels ?? [],
		};
		applyCharterProjection(item, issue.description, issue.labels ?? []);
		return item;
	}

	resolvePlanPath(ctx: { id: string; worktree: string }): string {
		return resolve(ctx.worktree, ".dev", "plans", `${ctx.id.toLowerCase()}.md`);
	}

	async publishPlan(body: string, ctx: { id: string; worktree: string }): Promise<void> {
		const api = await this.api();
		const issue = await api.getIssue(ctx.id);
		if (!issue) throw new Error(`Linear issue not found: ${ctx.id}`);
		const marked = `${PLAN_MARKER}\n${body}`;
		// NOTE (#98): not yet idempotent — a re-publish posts a duplicate marked comment (retrieval
		// takes "latest marker wins", so it's tolerated but noisy). The GitHub adapter upserts by
		// editing the existing plan comment; mirroring that here needs list/update-comment methods on
		// LinearApi. Tracked as a parity follow-up (Linear is fathom's consumer, not exercised here).
		await api.createComment(issue.id, marked);
	}

	async createItem(opts: CreateItemOpts): Promise<RoadmapItem> {
		const api = await this.api();
		const parts: string[] = [];
		if (opts.description) parts.push(opts.description);
		if (opts.deps && opts.deps.length > 0) parts.push(`Depends on: ${opts.deps.join(", ")}`);
		if (opts.scope) parts.push(`Scope: ${opts.scope}`);
		if (opts.priority) parts.push(`Priority: ${opts.priority}`);
		const rawDescription = parts.join("\n");
		const description = hasCharterProvenance(opts) ? withCharterMarker(rawDescription, provenanceFromCreateOpts(opts)) : rawDescription;
		const labelNames: string[] = [];
		if (this.label) labelNames.push(this.label);
		if (opts.deferred) labelNames.push(LABEL_DEFERRED);
		const created = await api.createIssue({ teamId: this.teamId, title: opts.title, description: description || undefined, labelNames: labelNames.length > 0 ? labelNames : undefined });
		return {
			id: created.identifier,
			title: created.title,
			deps: (opts.deps ?? []).join(", "),
			sourceRef: created.identifier,
		};
	}

	async activateItem(id: string, provenance: ReviewProvenance): Promise<RoadmapItemStatus> {
		const api = await this.api();
		const issue = await api.getIssue(id);
		if (!issue) throw new Error(`activateItem: Linear issue ${id} not found`);
		// Re-stamp the description marker (deferred=false + digest) then drop the deferred label. A throw
		// before the label removal retains the deferred state (#367).
		const restamped: ReviewProvenance = { ...provenance, deferred: false };
		const newDescription = withCharterMarker(stripCharterMarker(issue.description ?? ""), restamped);
		await api.updateDescription(id, newDescription);
		await api.removeLabel(id, LABEL_DEFERRED);
		const item = await this.getItem(id);
		if (!item) throw new Error(`activateItem: Linear issue ${id} vanished after activation`);
		item.deferred = false;
		item.reviewDigest = provenance.reviewDigest;
		item.reviewLevel = provenance.level;
		return item;
	}

	async archivePlan(_id: string): Promise<void> {
		// No-op: plan lives on the issue; closing moves it out of open set.
	}

	isCharterPickRace(_id: string): boolean {
		return false;
	}

	async listOpenItems(): Promise<RoadmapItem[]> {
		const api = await this.api();
		const issues = await api.listIssues({ teamId: this.teamId, label: this.label || undefined });
		// This status-less list feeds the server /roadmap endpoint and the web
		// StartForm — claimed (started/in-progress) issues must not look startable,
		// preserving pre-#12 membership now that listIssues includes "started".
		return issues
			.filter((it) => !(it.stateType === "started" || (it.labels ?? []).includes(IN_PROGRESS_LABEL)))
			.map((it) => ({
				id: it.identifier,
				title: it.title,
				deps: formatBlockers(it.inverseRelations ?? []),
				sourceRef: it.identifier,
			}));
	}

	async claimItem(id: string, opts?: { noWorktree?: boolean }): Promise<{ branch: string; worktree: string }> {
		const api = await this.api();
		const issue = await api.getIssue(id);
		if (!issue) throw new Error(`Linear issue not found: ${id}`);
		const slug = kebab(issue.title).slice(0, 40);
		const branch = `feat/${id.toLowerCase()}${slug ? `-${slug}` : ""}`;

		try {
			await api.transitionIssue(issue.id, this.teamId, "started");
		} catch {
			// best-effort — state name may not exist on the workspace
		}
		try {
			await api.addLabel(issue.id, IN_PROGRESS_LABEL);
		} catch {
			// best-effort — label may not exist on the workspace
		}

		return createClaimWorkspace(this.repo, id, branch, opts);
	}

	async markDone(id: string, ctx?: MarkDoneContext): Promise<void> {
		const api = await this.api();
		const issue = await api.getIssue(id);
		if (!issue) throw new Error(`Linear issue not found: ${id}`);
		const body = ctx?.note ? `Shipped — ${ctx.note}` : "Shipped";
		await api.createComment(issue.id, body);
		await api.transitionIssue(issue.id, this.teamId, "completed");
		try {
			await api.removeLabel(issue.id, IN_PROGRESS_LABEL);
		} catch {
			// best-effort label strip
		}
	}

	async getItemPlan(ref: { worktree?: string; id?: string }): Promise<string | null> {
		if (this.planLocation !== "issue-comment") {
			throw new Error(`plan-location '${this.planLocation}' not yet implemented for linear adapter`);
		}
		const id = await this.resolveIdentifier(ref);
		if (!id) return null;

		const local = (ref.worktree ? this.findPlanFile(id, ref.worktree) : null) ?? this.findPlanFile(id, this.repo);
		if (local) return local;

		const api = await this.api();
		const comments = await api.getIssueComments(id);
		const sorted = [...comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		const match = sorted.find((c) => c.body.startsWith(`${PLAN_MARKER}\n`) || c.body.startsWith(PLAN_MARKER));
		if (!match) return null;

		const body = stripMarker(match.body);
		const destRoot = ref.worktree ?? this.repo;
		const destPath = resolve(destRoot, ".dev", "plans", `${id.toLowerCase()}.md`);
		mkdirSync(dirname(destPath), { recursive: true });
		writeFileSync(destPath, body);
		return destPath;
	}

	private async resolveIdentifier(ref: { worktree?: string; id?: string }): Promise<string | null> {
		if (ref.id) {
			const parsed = await this.parseItemId(ref.id);
			if (parsed) return parsed;
		}
		if (ref.worktree) {
			try {
				const branch = execSync("git branch --show-current", { cwd: ref.worktree, encoding: "utf-8" }).trim();
				const parsed = await this.parseItemId(branch);
				if (parsed) return parsed;
			} catch {
				// fall through
			}
		}
		return null;
	}

	private findPlanFile(id: string, root: string): string | null {
		const lower = id.toLowerCase();
		const dirs = [resolve(root, "docs", "plans"), resolve(root, ".dev", "plans")];
		const prefix = `${lower}-`;
		for (const dir of dirs) {
			const exact = resolve(dir, `${lower}.md`);
			if (existsSync(exact)) return exact;
			if (!existsSync(dir)) continue;
			const hit = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(".md"));
			if (hit) return resolve(dir, hit);
		}
		return null;
	}
}

function hasBlocker(inverseRelations: LinearIssueRelation[]): boolean {
	return inverseRelations.some((relation) => relation.type === "blocks");
}

function formatBlockers(inverseRelations: LinearIssueRelation[]): string {
	const blockers = inverseRelations.filter((relation) => relation.type === "blocks").map((relation) => relation.relatedIdentifier);
	return blockers.join(", ");
}

function kebab(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^\da-z]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function stripMarker(body: string): string {
	if (body.startsWith(`${PLAN_MARKER}\n`)) return body.slice(PLAN_MARKER.length + 1);
	if (body.startsWith(PLAN_MARKER)) return body.slice(PLAN_MARKER.length).replace(/^\n/, "");
	return body;
}

// ── Default SDK-backed runner ──────────────────────────────────────────
// Lazy-imports `@linear/sdk` so consumers on other roadmap sources never pay the load cost.
// Never called in unit tests (which inject `api`). Types are defined structurally because
// the SDK is an optional runtime dep.

interface LinearSdkIssue {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	labelIds?: string[];
	state?: { type: string } | (() => Promise<{ type: string } | null>);
	inverseRelations?: () => Promise<{ nodes: LinearSdkRelation[] }>;
	comments?: () => Promise<{ nodes: LinearSdkComment[] }>;
	labels?: () => Promise<{ nodes: { name: string }[] }>;
}

interface LinearSdkRelation {
	type: string;
	issue?: Promise<{ identifier: string } | null>;
}

interface LinearSdkComment {
	body: string;
	createdAt: string | Date;
}

interface LinearSdkClient {
	issues(args: unknown): Promise<{ nodes: LinearSdkIssue[] }>;
	issue(identifier: string): Promise<LinearSdkIssue | null>;
	createComment(input: { issueId: string; body: string }): Promise<unknown>;
	updateIssue(id: string, input: { stateId?: string; labelIds?: string[]; description?: string }): Promise<unknown>;
	workflowStates(args: unknown): Promise<{ nodes: { id: string; type: string }[] }>;
	issueLabels(args: unknown): Promise<{ nodes: { id: string; name: string }[] }>;
	createIssue(input: { teamId: string; title: string; description?: string; labelIds?: string[] }): Promise<{ issue?: () => Promise<LinearSdkIssue | null> }>;
}

interface LinearSdkModule {
	LinearClient: new (opts: { apiKey: string }) => LinearSdkClient;
}

async function defaultLinearApi(): Promise<LinearApi> {
	const apiKey = process.env.LINEAR_API_KEY;
	if (!apiKey) throw new Error("LINEAR_API_KEY env var is required for Linear roadmap adapter");

	let mod: LinearSdkModule;
	try {
		mod = (await import("@linear/sdk")) as unknown as LinearSdkModule;
	} catch {
		throw new Error("`@linear/sdk` is not installed — run `pnpm add @linear/sdk`");
	}
	const client = new mod.LinearClient({ apiKey });

	async function resolveStateId(teamId: string, type: "started" | "completed"): Promise<string> {
		const res = await client.workflowStates({ filter: { team: { id: { eq: teamId } }, type: { eq: type } } });
		const state = res.nodes[0];
		if (!state) throw new Error(`Linear: no workflow state of type '${type}' for team ${teamId}`);
		return state.id;
	}

	async function resolveLabelId(labelName: string): Promise<string | null> {
		const res = await client.issueLabels({ filter: { name: { eq: labelName } } });
		return res.nodes[0]?.id ?? null;
	}

	// SDK v82 exposes Issue.state as a GETTER returning LinearFetch (a promise) —
	// `typeof state === "function"` is false, so probe all three shapes: method
	// (older SDKs), promise-from-getter (v82), plain object (test stubs).
	async function stateTypeOf(holder: { state?: unknown }): Promise<string | undefined> {
		let s = holder.state;
		if (typeof s === "function") s = (s as () => unknown).call(holder);
		if (s && typeof (s as { then?: unknown }).then === "function") s = await (s as Promise<unknown>);
		return (s as { type?: string } | undefined)?.type;
	}

	return {
		async listIssues({ teamId, label, includeDone }) {
			const filter: Record<string, unknown> = {
				team: { id: { eq: teamId } },
			};
			// "started" stays in the open listing so claimed items surface as
			// in-progress instead of silently vanishing (issue #12).
			if (!includeDone) filter.state = { type: { in: ["unstarted", "backlog", "triage", "started"] } };
			if (label) filter.labels = { some: { name: { eq: label } } };
			const res = await client.issues({ filter, first: 200 });
			const items: LinearIssueListItem[] = [];
			for (const node of res.nodes) {
				const inverseRelations: LinearIssueRelation[] = [];
				const inverseRel = typeof node.inverseRelations === "function" ? await node.inverseRelations() : null;
				if (inverseRel) {
					for (const r of inverseRel.nodes) {
						const related = await r.issue;
						if (related?.identifier) inverseRelations.push({ type: r.type, relatedIdentifier: related.identifier });
					}
				}
				items.push({ id: node.id, identifier: node.identifier, title: node.title, description: node.description ?? null, inverseRelations, stateType: await stateTypeOf(node) });
			}
			return items;
		},
		async getIssue(identifier) {
			const issue = await client.issue(identifier);
			if (!issue) return null;
			const stateType = await stateTypeOf(issue);
			const inverseRelations: LinearIssueRelation[] = [];
			if (typeof issue.inverseRelations === "function") {
				const rel = await issue.inverseRelations();
				for (const r of rel.nodes) {
					const related = await r.issue;
					if (related?.identifier) inverseRelations.push({ type: r.type, relatedIdentifier: related.identifier });
				}
			}
			let labels: string[] | undefined;
			if (typeof issue.labels === "function") {
				const l = await issue.labels();
				labels = l.nodes.map((n) => n.name);
			}
			return { id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description ?? null, stateType, labels, inverseRelations };
		},
		async createComment(issueId, body) {
			await client.createComment({ issueId, body });
		},
		async transitionIssue(issueId, teamId, stateType) {
			const stateId = await resolveStateId(teamId, stateType);
			await client.updateIssue(issueId, { stateId });
		},
		async addLabel(issueId, labelName) {
			const labelId = await resolveLabelId(labelName);
			if (!labelId) throw new Error(`Linear label '${labelName}' not found`);
			const issue = await client.issue(issueId);
			const existing = issue?.labelIds ?? [];
			await client.updateIssue(issueId, { labelIds: [...existing, labelId] });
		},
		async removeLabel(issueId, labelName) {
			const labelId = await resolveLabelId(labelName);
			if (!labelId) return;
			const issue = await client.issue(issueId);
			const existing = issue?.labelIds ?? [];
			await client.updateIssue(issueId, { labelIds: existing.filter((lid) => lid !== labelId) });
		},
		async updateDescription(issueId, description) {
			await client.updateIssue(issueId, { description });
		},
		async getIssueComments(identifier) {
			const issue = await client.issue(identifier);
			if (!issue || typeof issue.comments !== "function") return [];
			const res = await issue.comments();
			return res.nodes.map((c) => ({
				body: c.body,
				createdAt: typeof c.createdAt === "string" ? c.createdAt : c.createdAt.toISOString(),
			}));
		},
		async createIssue({ teamId, title, description, labelNames }) {
			const labelIds: string[] = [];
			for (const name of labelNames ?? []) {
				const id = await resolveLabelId(name);
				if (id) labelIds.push(id);
			}
			const input: { teamId: string; title: string; description?: string; labelIds?: string[] } = { teamId, title };
			if (description) input.description = description;
			if (labelIds.length > 0) input.labelIds = labelIds;
			const res = await client.createIssue(input);
			const issue = typeof res.issue === "function" ? await res.issue() : null;
			if (!issue) throw new Error("Linear createIssue returned no issue");
			return { id: issue.id, identifier: issue.identifier, title: issue.title };
		},
	};
}
