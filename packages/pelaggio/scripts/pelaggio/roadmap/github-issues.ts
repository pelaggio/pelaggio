import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createClaimWorkspace } from "./git-claim.js";
import { isQuickScope } from "./scope.js";
import type { CreateItemOpts, GithubRoadmapConfig, ItemStatus, MarkDoneContext, PlanLocation, QuickScopeInput, RoadmapItem, RoadmapItemStatus, RoadmapSource, RoadmapSourceName } from "./types.js";

const PLAN_MARKER = "<!-- pelaggio-plan -->";

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

	isQuickScope(input: QuickScopeInput): boolean {
		return isQuickScope(input);
	}

	async listItems(opts?: { includeDone?: boolean }): Promise<RoadmapItemStatus[]> {
		const state = opts?.includeDone ? "all" : "open";
		const raw = this.runGh(["issue", "list", "--repo", this.ghRepo, "--label", this.label, "--state", state, "--json", "number,title,body,labels,state", "--limit", "200"]);
		const issues = parseGhJson<GhIssueSummary[]>(raw, (v) => Array.isArray(v));
		return issues.map((it) => {
			const labels = (it.labels ?? []).map((l) => l.name);
			let status: ItemStatus = "open";
			if ((it.state ?? "").toLowerCase() === "closed") status = "done";
			else if (labels.includes("blocked")) status = "blocked";
			else if (labels.includes("in-progress")) status = "in-progress";
			const item: RoadmapItemStatus = {
				id: String(it.number),
				title: it.title,
				deps: extractDeps(it.body ?? ""),
				sourceRef: `${this.ghRepo}#${it.number}`,
				status,
			};
			return item;
		});
	}

	async getItem(id: string): Promise<RoadmapItemStatus | null> {
		try {
			const raw = this.runGh(["issue", "view", id, "--repo", this.ghRepo, "--json", "number,title,body,labels,state"]);
			const it = parseGhJson<GhIssueSummary>(raw, (v) => isPlainObject(v) && typeof (v as { number?: unknown }).number === "number");
			const labels = (it.labels ?? []).map((l) => l.name);
			let status: ItemStatus = "open";
			if ((it.state ?? "").toLowerCase() === "closed") status = "done";
			else if (labels.includes("blocked")) status = "blocked";
			else if (labels.includes("in-progress")) status = "in-progress";
			return {
				id: String(it.number),
				title: it.title,
				deps: extractDeps(it.body ?? ""),
				sourceRef: `${this.ghRepo}#${it.number}`,
				status,
				body: it.body ?? "",
				labels,
			};
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
		if (deps.length > 0) bodyParts.push(`Depends on: ${deps.join(", ")}`);
		if (opts.scope) bodyParts.push(`Scope: ${opts.scope}`);
		if (opts.priority) bodyParts.push(`Priority: ${opts.priority}`);
		const body = bodyParts.join("\n");
		const args = ["issue", "create", "--repo", this.ghRepo, "--title", opts.title, "--label", this.label, "--body", body];
		if (opts.deferred) args.push("--label", "deferred");
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

		// Best-effort label add — the server-side claim marker listItems/getItem
		// surface as `in-progress` for other hosts (issue #12).
		try {
			this.runGh(["issue", "edit", id, "--repo", this.ghRepo, "--add-label", "in-progress"]);
		} catch {
			// swallowed — label may not exist on the repo
		}

		return createClaimWorkspace(this.repo, id, branch, opts);
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
