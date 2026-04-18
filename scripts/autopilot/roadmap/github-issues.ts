import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { WORKTREE_PREFIX } from "../config.js";
import type { GithubRoadmapConfig, MarkDoneContext, PlanLocation, RoadmapItem, RoadmapSource, RoadmapSourceName } from "./types.js";

const PLAN_MARKER = "<!-- autopilot-plan -->";

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
	labels?: { name: string }[];
}

interface GhIssueComments {
	comments: { body: string; createdAt: string }[];
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

	parseItemId(text: string): string | null {
		const branch = text.match(/feat\/issue-(\d+)/);
		if (branch) return branch[1];
		const hash = text.match(/#(\d+)/);
		if (hash) return hash[1];
		const loose = text.match(/\bissue[- ]?(\d+)\b/i);
		if (loose) return loose[1];
		return null;
	}

	isQuickScope(text: string): boolean {
		return /scope:\s*x?s\b/i.test(text) || /\bbug\b|\bfix:/i.test(text);
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

	async claimItem(id: string): Promise<{ branch: string; worktree: string }> {
		const titleRaw = this.runGh(["issue", "view", id, "--repo", this.ghRepo, "--json", "title"]);
		const { title } = parseGhJson<GhIssueTitle>(titleRaw, (v) => isPlainObject(v) && typeof (v as { title?: unknown }).title === "string");
		const slug = kebab(title).slice(0, 40);
		const branch = `feat/issue-${id}${slug ? `-${slug}` : ""}`;
		const worktree = resolve(this.repo, "..", `${WORKTREE_PREFIX}${id.toLowerCase()}`);

		// Best-effort label add — advisory, not critical.
		try {
			this.runGh(["issue", "edit", id, "--repo", this.ghRepo, "--add-label", "in-progress"]);
		} catch {
			// swallowed — label may not exist on the repo
		}

		execSync(`git worktree add -b ${branch} ${worktree} main`, { cwd: this.repo, stdio: "pipe" });
		return { branch, worktree };
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
		const n = this.resolveIssueNumber(ref);
		if (!n) return null;

		const local = this.findPlanFile(n);
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

	private resolveIssueNumber(ref: { worktree?: string; id?: string }): string | null {
		if (ref.id) {
			const digits = ref.id.match(/^\d+$/) ? ref.id : this.parseItemId(ref.id);
			if (digits) return digits;
		}
		if (ref.worktree) {
			try {
				const branch = execSync("git branch --show-current", { cwd: ref.worktree, encoding: "utf-8" }).trim();
				const n = this.parseItemId(branch);
				if (n) return n;
			} catch {
				// fall through
			}
		}
		return null;
	}

	private findPlanFile(n: string): string | null {
		const dirs = [resolve(this.repo, "docs", "plans"), resolve(this.repo, ".dev", "plans")];
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

function defaultGhRun(args: string[]): { stdout: string; stderr: string; status: number } {
	const r = spawnSync("gh", args, { encoding: "utf-8" });
	if (r.error && isEnoent(r.error)) {
		throw new Error("gh CLI required — install https://cli.github.com/");
	}
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

function isEnoent(e: unknown): boolean {
	return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseGhJson<T>(stdout: string, shapeOk: (v: unknown) => boolean): T {
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
