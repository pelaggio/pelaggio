import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertActivationInputsUnchanged, CharterActivationStaleError, hasCharterProvenance, parseCharterMarker, provenanceFromCreateOpts, stripCharterMarker, withCharterMarker } from "./charter-provenance.js";
import { createClaimWorkspace } from "./git-claim.js";
import type {
	ActivationExpectation,
	CreateItemOpts,
	GithubRoadmapConfig,
	ItemStatus,
	MarkDoneContext,
	PlanLocation,
	PriorityLabelBackfillResult,
	ReviewProvenance,
	RoadmapItem,
	RoadmapItemStatus,
	RoadmapSource,
	RoadmapSourceName,
} from "./types.js";
import { isScope, type Scope } from "./types.js";

const PLAN_MARKER = "<!-- pelaggio-plan -->";

/** GitHub numeric priority tiers (lower = more urgent). Match BD_PRIORITY_* so FIFO policy ranks consistently. */
export const GH_PRIORITY_HIGH = 1;
export const GH_PRIORITY_NORMAL = 2;

const LABEL_PRIORITY_HIGH = "priority:high";
const LABEL_PRIORITY_NORMAL = "priority:normal";
const LABEL_DEFERRED = "deferred";
/** Line-level, case-insensitive body marker used only by the priority-label migration. */
const BODY_PRIORITY_HIGH_RE = /^\s*Priority:\s*high\s*$/im;

export type GhRunner = (args: string[]) => { stdout: string; stderr: string; status: number };

export interface GitHubIssuesRoadmapOpts extends GithubRoadmapConfig {
	/** Local git repo root (for worktree creation). */
	repo: string;
	/** Injectable for tests; defaults to `spawnSync("gh", args)`. */
	ghRun?: GhRunner;
}

interface GhIssueSummary {
	number: number;
	title: string;
	body: string;
	state?: string;
	labels?: { name: string }[];
}

interface GhIssueComments {
	comments: { body: string; createdAt: string; url: string }[];
}

interface GhIssueTitle {
	title: string;
}

/**
 * Pure projector from a GitHub issue payload to `RoadmapItemStatus`.
 * Labels are the sole runtime source of truth for priority and deferred;
 * body text is never consulted here (migration is the only body→label path).
 * Every projected item materializes `priority` as 1 or 2 so DEFAULT_PRIORITY=0 cannot invert ranking.
 */
export function projectGhIssue(
	it: {
		number: number;
		title: string;
		body?: string;
		state?: string;
		labels?: { name: string }[];
	},
	ghRepo: string,
	opts?: { includeBodyLabels?: boolean },
): RoadmapItemStatus {
	const labels = (it.labels ?? []).map((l) => l.name);
	let status: ItemStatus = "open";
	if ((it.state ?? "").toLowerCase() === "closed") status = "done";
	else if (labels.includes("blocked")) status = "blocked";
	else if (labels.includes("in-progress")) status = "in-progress";

	const priority = labels.includes(LABEL_PRIORITY_HIGH) ? GH_PRIORITY_HIGH : GH_PRIORITY_NORMAL;
	const scope = extractScope(it.body ?? "", labels);
	const item: RoadmapItemStatus = {
		id: String(it.number),
		title: it.title,
		deps: extractDeps(it.body ?? ""),
		sourceRef: `${ghRepo}#${it.number}`,
		status,
		priority,
		...(scope ? { scope } : {}),
	};
	if (labels.includes(LABEL_DEFERRED)) item.deferred = true;
	// Charter-review provenance (#367) rides a body marker; label stays the SoT for the deferred flag.
	const provenance = parseCharterMarker(it.body ?? "");
	if (provenance) {
		if (provenance.reviewDigest) item.reviewDigest = provenance.reviewDigest;
		if (provenance.level) item.reviewLevel = provenance.level;
	}
	if (opts?.includeBodyLabels) {
		item.body = it.body ?? "";
		item.labels = labels;
	}
	return item;
}

export class GitHubIssuesRoadmap implements RoadmapSource {
	readonly name: RoadmapSourceName = "github-issues";
	private readonly repo: string;
	private readonly ghRepo: string;
	private readonly label: string;
	private readonly planLocation: PlanLocation;
	private readonly ghRun: GhRunner;

	constructor(opts: GitHubIssuesRoadmapOpts) {
		this.repo = opts.repo;
		this.ghRepo = opts.ghRepo;
		this.label = opts.label;
		this.planLocation = opts.planLocation;
		this.ghRun = opts.ghRun ?? defaultGhRun;
	}

	async parseItemId(text: string): Promise<string | null> {
		const branch = text.match(/feat\/issue-(\d+)/);
		if (branch) return branch[1];
		const hash = text.match(/#(\d+)/);
		if (hash) return hash[1];
		const loose = text.match(/\bissue[- ]?(\d+)\b/i);
		if (loose) return loose[1];
		return null;
	}

	async listItems(opts?: { includeDone?: boolean }): Promise<RoadmapItemStatus[]> {
		const state = opts?.includeDone ? "all" : "open";
		const raw = this.runGh(["issue", "list", "--repo", this.ghRepo, "--label", this.label, "--state", state, "--json", "number,title,body,labels,state", "--limit", "200"]);
		const issues = parseGhJson<GhIssueSummary[]>(raw, (v) => Array.isArray(v));
		// FIFO within the newest-200 fetch window: ascending issue number so equal-priority
		// ties drain oldest-first. Does not convert the window into the 200 oldest open issues.
		const sorted = [...issues].sort((a, b) => a.number - b.number);
		return sorted.map((it) => projectGhIssue(it, this.ghRepo));
	}

	async getItem(id: string): Promise<RoadmapItemStatus | null> {
		try {
			const raw = this.runGh(["issue", "view", id, "--repo", this.ghRepo, "--json", "number,title,body,labels,state"]);
			const it = parseGhJson<GhIssueSummary>(raw, (v) => isPlainObject(v) && typeof (v as { number?: unknown }).number === "number");
			return projectGhIssue(it, this.ghRepo, { includeBodyLabels: true });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/not found|could not resolve/i.test(msg)) return null;
			throw e;
		}
	}

	resolvePlanPath(ctx: { id: string; worktree: string }): string {
		return resolve(ctx.worktree, ".dev", "plans", `${ctx.id}.md`);
	}

	async publishPlan(body: string, ctx: { id: string; worktree: string }): Promise<void> {
		const marked = `${PLAN_MARKER}\n${body}`;
		// Idempotent upsert: edit the existing plan comment if present, else post a new one. A
		// re-plan / retry / harness-owned republish must not duplicate the marked comment —
		// retrieval takes "latest marker wins", so a duplicate could change which plan body a
		// resume materializes.
		const existingId = this.findPlanCommentId(ctx.id);
		if (existingId) {
			this.runGh(["api", `repos/${this.ghRepo}/issues/comments/${existingId}`, "-X", "PATCH", "-f", `body=${marked}`]);
		} else {
			this.runGh(["issue", "comment", ctx.id, "--repo", this.ghRepo, "--body", marked]);
		}
	}

	/** REST id of the most-recent `<!-- pelaggio-plan -->` comment on the issue, or null. */
	private findPlanCommentId(id: string): string | null {
		const raw = this.runGh(["issue", "view", id, "--repo", this.ghRepo, "--json", "comments"]);
		const { comments } = parseGhJson<GhIssueComments>(raw, (v) => isPlainObject(v) && Array.isArray((v as { comments?: unknown }).comments));
		const match = [...comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((c) => c.body.startsWith(PLAN_MARKER));
		// `?.url?.` guards a marker comment with no url; an unparseable url → null → publishPlan posts
		// a new comment (real gh always emits a parseable `#issuecomment-<id>` url, so benign).
		return match?.url?.match(/#issuecomment-(\d+)/)?.[1] ?? null;
	}

	async createItem(opts: CreateItemOpts): Promise<RoadmapItem> {
		const deps = opts.deps ?? [];
		const bodyParts: string[] = [];
		if (opts.description) bodyParts.push(opts.description);
		if (deps.length > 0) bodyParts.push(`Depends on: ${deps.join(", ")}`);
		if (opts.scope) bodyParts.push(`Scope: ${opts.scope}`);
		if (opts.priority) bodyParts.push(`Priority: ${opts.priority}`);
		const rawBody = bodyParts.join("\n");
		// Append the canonical charter-review marker when the gate stamped provenance (#367).
		const body = hasCharterProvenance(opts) ? withCharterMarker(rawBody, provenanceFromCreateOpts(opts)) : rawBody;
		const args = ["issue", "create", "--repo", this.ghRepo, "--title", opts.title, "--label", this.label, "--body", body];
		if (opts.deferred) args.push("--label", LABEL_DEFERRED);
		// Labels are the runtime SoT for priority; body marker stays as human-readable prose.
		if (opts.priority === "high") args.push("--label", LABEL_PRIORITY_HIGH);
		else if (opts.priority === "normal") args.push("--label", LABEL_PRIORITY_NORMAL);
		const rawUrl = this.runGh(args).trim();
		// `gh issue create` prints the URL on stdout.
		const m = rawUrl.match(/\/issues\/(\d+)/);
		const number = m ? m[1] : "";
		return {
			id: number,
			title: opts.title,
			deps: deps.join(", "),
			sourceRef: `${this.ghRepo}#${number}`,
		};
	}

	async activateItem(id: string, provenance: ReviewProvenance, expected?: ActivationExpectation): Promise<RoadmapItemStatus> {
		// Re-stamp the marker (deferred=false + verified digest) into the body, THEN drop the deferred
		// label — a failed edit throws and leaves the label (and deferred state) intact (#367).
		const raw = this.runGh(["issue", "view", id, "--repo", this.ghRepo, "--json", "number,title,body,labels,state"]);
		const summary = parseGhJson<GhIssueSummary>(raw, (v) => isPlainObject(v) && typeof (v as { number?: unknown }).number === "number");
		// Both checks precede every mutation below, so a refusal leaves the item deferred.
		if (typeof summary.state === "string" && summary.state.toUpperCase() !== "OPEN") {
			throw new CharterActivationStaleError(`activateItem: ${id} is ${summary.state.toLowerCase()}, not open; refusing to stamp an activation review onto a closed item`);
		}
		// Compare through the same projection the gate read, so a formatting difference in the raw
		// payload cannot masquerade as an edit.
		assertActivationInputsUnchanged(id, expected, projectGhIssue(summary, this.ghRepo, { includeBodyLabels: true }) as { title: string; body: string });
		const restamped: ReviewProvenance = { ...provenance, deferred: false };
		const newBody = withCharterMarker(stripCharterMarker(summary.body ?? ""), restamped);
		this.runGh(["issue", "edit", id, "--repo", this.ghRepo, "--body", newBody, "--remove-label", LABEL_DEFERRED]);
		const projected = projectGhIssue({ ...summary, body: newBody, labels: (summary.labels ?? []).filter((l) => l.name !== LABEL_DEFERRED) }, this.ghRepo, { includeBodyLabels: true });
		projected.deferred = false;
		return projected;
	}

	/**
	 * Idempotent migration: issues whose body has a line-level `Priority: high` marker
	 * but lack the `priority:high` label get that label. Fail-closed on conflicts
	 * (body-high + already `priority:normal`) — no partial edits.
	 */
	async backfillPriorityLabels(): Promise<PriorityLabelBackfillResult> {
		const raw = this.runGh(["issue", "list", "--repo", this.ghRepo, "--label", this.label, "--state", "all", "--json", "number,title,body,labels,state", "--limit", "200"]);
		const issues = parseGhJson<GhIssueSummary[]>(raw, (v) => Array.isArray(v));
		const scanned = issues.length;
		const toLabel: number[] = [];
		const conflicts: string[] = [];

		for (const it of issues) {
			const body = it.body ?? "";
			if (!BODY_PRIORITY_HIGH_RE.test(body)) continue;
			const labels = (it.labels ?? []).map((l) => l.name);
			if (labels.includes(LABEL_PRIORITY_HIGH)) continue;
			if (labels.includes(LABEL_PRIORITY_NORMAL)) {
				conflicts.push(String(it.number));
				continue;
			}
			toLabel.push(it.number);
		}

		// Fail-closed: any conflict aborts the whole migration with zero edits.
		if (conflicts.length > 0) {
			return { scanned, labeled: 0, conflicts };
		}

		for (const n of toLabel) {
			this.runGh(["issue", "edit", String(n), "--repo", this.ghRepo, "--add-label", LABEL_PRIORITY_HIGH]);
		}
		return { scanned, labeled: toLabel.length, conflicts: [] };
	}

	async archivePlan(_id: string): Promise<void> {
		// No-op: closing the issue already moves it out of the open set.
	}

	isCharterPickRace(_id: string): boolean {
		return false;
	}

	async listOpenItems(): Promise<RoadmapItem[]> {
		const raw = this.runGh(["issue", "list", "--repo", this.ghRepo, "--label", this.label, "--state", "open", "--json", "number,title,body,labels", "--limit", "200"]);
		const issues = parseGhJson<GhIssueSummary[]>(raw, (v) => Array.isArray(v));
		return issues.map((it) => ({
			id: String(it.number),
			title: it.title,
			deps: extractDeps(it.body ?? ""),
			sourceRef: `${this.ghRepo}#${it.number}`,
		}));
	}

	async claimItem(id: string, opts?: { noWorktree?: boolean }): Promise<{ branch: string; worktree: string }> {
		const titleRaw = this.runGh(["issue", "view", id, "--repo", this.ghRepo, "--json", "title"]);
		const { title } = parseGhJson<GhIssueTitle>(titleRaw, (v) => isPlainObject(v) && typeof (v as { title?: unknown }).title === "string");
		const slug = kebab(title).slice(0, 40);
		const branch = `feat/issue-${id}${slug ? `-${slug}` : ""}`;

		// Authoritative git claim first — AlreadyClaimedError before any GitHub write-back.
		const claim = createClaimWorkspace(this.repo, id, branch, opts);

		// Best-effort GitHub projection; never roll back a valid git claim. The server-side
		// marker makes listItems/getItem surface the claim as `in-progress` for other hosts.
		try {
			this.runGh(["issue", "edit", id, "--repo", this.ghRepo, "--add-label", "in-progress"]);
		} catch {
			// swallowed — label may not exist on the repo
		}

		return claim;
	}

	async markDone(id: string, ctx?: MarkDoneContext): Promise<void> {
		const body = ctx?.note ? `Shipped — ${ctx.note}` : "Shipped";
		this.runGh(["issue", "comment", id, "--repo", this.ghRepo, "--body", body]);
		this.runGh(["issue", "close", id, "--repo", this.ghRepo]);
		try {
			this.runGh(["issue", "edit", id, "--repo", this.ghRepo, "--remove-label", "in-progress"]);
		} catch {
			// swallowed — best-effort label strip
		}
	}

	async getItemPlan(ref: { worktree?: string; id?: string }): Promise<string | null> {
		if (this.planLocation !== "issue-comment") {
			throw new Error(`plan-location '${this.planLocation}' not yet implemented for TOOL-10; track TOOL-10.1`);
		}
		const n = await this.resolveIssueNumber(ref);
		if (!n) return null;

		const local = (ref.worktree ? this.findPlanFile(n, ref.worktree) : null) ?? this.findPlanFile(n, this.repo);
		if (local) return local;

		const raw = this.runGh(["issue", "view", n, "--repo", this.ghRepo, "--json", "comments"]);
		const { comments } = parseGhJson<GhIssueComments>(raw, (v) => isPlainObject(v) && Array.isArray((v as { comments?: unknown }).comments));

		// Most recent marker-prefixed comment wins.
		const sorted = [...comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		const match = sorted.find((c) => c.body.startsWith(`${PLAN_MARKER}\n`) || c.body.startsWith(PLAN_MARKER));
		if (!match) return null;

		const body = stripMarker(match.body);
		const destRoot = ref.worktree ?? this.repo;
		const destPath = resolve(destRoot, ".dev", "plans", `${n}.md`);
		mkdirSync(dirname(destPath), { recursive: true });
		writeFileSync(destPath, body);
		return destPath;
	}

	private async resolveIssueNumber(ref: { worktree?: string; id?: string }): Promise<string | null> {
		if (ref.id) {
			const digits = ref.id.match(/^\d+$/) ? ref.id : await this.parseItemId(ref.id);
			if (digits) return digits;
		}
		if (ref.worktree) {
			try {
				const branch = execSync("git branch --show-current", { cwd: ref.worktree, encoding: "utf-8" }).trim();
				const n = await this.parseItemId(branch);
				if (n) return n;
			} catch {
				// fall through
			}
		}
		return null;
	}

	private findPlanFile(n: string, root: string): string | null {
		const dirs = [resolve(root, "docs", "plans"), resolve(root, ".dev", "plans")];
		const prefix = `issue-${n}-`;
		for (const dir of dirs) {
			const exact = resolve(dir, `${n}.md`);
			if (existsSync(exact)) return exact;
			if (!existsSync(dir)) continue;
			const hit = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(".md"));
			if (hit) return resolve(dir, hit);
		}
		return null;
	}

	private runGh(args: string[]): string {
		let result: { stdout: string; stderr: string; status: number };
		try {
			result = this.ghRun(args);
		} catch (e) {
			if (isEnoent(e)) throw new Error("gh CLI required — install https://cli.github.com/");
			throw e;
		}
		if (result.status !== 0) {
			const stderr = result.stderr ?? "";
			if (/command not found/i.test(stderr) || result.status === 127) {
				throw new Error("gh CLI required — install https://cli.github.com/");
			}
			if (/gh auth login|authentication required/i.test(stderr)) {
				throw new Error("gh CLI not authenticated — run 'gh auth login'");
			}
			throw new Error(`gh ${args[0] ?? ""} failed: ${stderr.trim() || result.status}`);
		}
		return result.stdout;
	}
}

// `spawnSync` blocks the Node event loop for its full duration — every timer,
// parallel worker, and TUI render in the pipeline freezes with it. Without a
// timeout a hung `gh` (network blackhole, surprise auth prompt) stalls the whole
// run indefinitely; no legitimate single gh call takes this long.
const GH_TIMEOUT_MS = 30_000;

export function defaultGhRun(args: string[]): { stdout: string; stderr: string; status: number } {
	const r = spawnSync("gh", args, { encoding: "utf-8", timeout: GH_TIMEOUT_MS });
	if (r.error && isEnoent(r.error)) {
		throw new Error("gh CLI required — install https://cli.github.com/");
	}
	if (r.error && (r.error as { code?: string }).code === "ETIMEDOUT") {
		throw new Error(`gh ${args[0] ?? ""} timed out after ${GH_TIMEOUT_MS / 1000}s`);
	}
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

function isEnoent(e: unknown): boolean {
	return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseGhJson<T>(stdout: string, shapeOk: (v: unknown) => boolean): T {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (e) {
		const hint = e instanceof Error ? e.message : String(e);
		throw new Error(`gh returned non-JSON output: ${hint}`);
	}
	if (!shapeOk(parsed)) {
		throw new Error(`gh returned unexpected JSON shape: ${stdout.slice(0, 200)}`);
	}
	return parsed as T;
}

function extractDeps(body: string): string {
	const m = body.match(/^\s*Depends on:\s*(.+)$/m);
	return m ? m[1].trim() : "";
}

function extractScope(body: string, labels: readonly string[]): Scope | undefined {
	for (const label of labels) {
		const value = label.match(/^scope[\s:/-]*(xs|s|m|l|xl)$/i)?.[1]?.toUpperCase();
		if (isScope(value)) return value;
	}
	const value = body.match(/^\s*Scope:\s*(XS|S|M|L|XL)\b/im)?.[1]?.toUpperCase();
	return isScope(value) ? value : undefined;
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
