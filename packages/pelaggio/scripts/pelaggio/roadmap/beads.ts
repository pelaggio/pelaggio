/**
 * Beads (`bd`) RoadmapSource adapter — Beads 1.1.x `--json` CLI contract.
 *
 * Compatibility target: steveyegge/beads 1.1.x (`bd list|ready|show|create|update|close|dep`).
 * Store root is always the git main worktree (`dirname(git-common-dir)`), so list/claim/close
 * hit one shared `MAIN_REPO/.beads` even when the CLI is invoked from a feature worktree.
 * The `feat/<id>` branch remains the authoritative claim; `bd update --claim` is best-effort
 * write-back only. Status listing overlays live claims via `claimedIds`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { claimedIds, createClaimWorkspace } from "./git-claim.js";
import type { CreateItemOpts, ItemStatus, MarkDoneContext, RoadmapItem, RoadmapItemStatus, RoadmapSource, RoadmapSourceName } from "./types.js";

/** Spawn timeout for a single `bd` invocation — mirrors `GH_TIMEOUT_MS`. */
export const BD_TIMEOUT_MS = 30_000;

/**
 * Beads numeric priority tiers (lower = more urgent).
 * Pelaggio `high` → P1; `normal` → P2 (medium).
 */
export const BD_PRIORITY_HIGH = 1;
export const BD_PRIORITY_NORMAL = 2;

/**
 * Injectable process runner — same shape as `GhRunner`. Production default closes over
 * the resolved store root so tests can inject deterministic stubs without a real `bd`.
 */
export type BdRunner = (args: string[]) => { stdout: string; stderr: string; status: number };

export interface BeadsRoadmapOpts {
	/** Local git repo (or worktree) path used for claim worktrees / claimedIds. */
	repo: string;
	/** Injectable for tests; defaults to `spawnSync("bd", args, { cwd: storeRoot })`. */
	bdRun?: BdRunner;
	/** Test-only override for store-root resolution. */
	storeRoot?: string;
}

// ─── Beads 1.1.x JSON boundary ───────────────────────────────────────────────

// Canonical Beads id. Verified against bd 1.1.x: a `bd-` prefix, then one or more
// hyphen-joined alphanumeric segments (`bd-a1b2` with no db prefix, or `bd-probe-l5g`
// with one), then an optional dotted hierarchy for epics/sub-tasks (`bd-probe-l5g.1`,
// `bd-a3f8.1.1`). The greedy multi-segment core makes id-in-branch parsing ambiguous
// against a `-slug`, so bd claim branches are slug-free (`feat/<id>` — see claimItem)
// and the branch regex is anchored; claim *detection* is separately robust via
// `claimedIds` (known-id prefix match). (#181 review: #347)
const BD_ID_CORE = "bd-[a-z0-9]+(?:-[a-z0-9]+)*(?:\\.\\d+)*";
const BD_ID_EXACT_RE = new RegExp(`^${BD_ID_CORE}$`, "i");
const BD_ID_IN_TEXT_RE = new RegExp(`\\b(${BD_ID_CORE})`, "i");
const BD_ID_IN_BRANCH_RE = new RegExp(`^feat\\/(${BD_ID_CORE})$`, "i");

interface BdDependency {
	depends_on_id?: string;
	dependency_id?: string;
	issue_id?: string;
	id?: string;
	type?: string;
}

interface BdIssue {
	id: string;
	title: string;
	description?: string;
	status: string;
	priority?: number;
	/** Structured deps when present. */
	dependencies?: BdDependency[] | string[];
	depends_on?: string[];
	blocked_by?: string[];
	blocked_reason?: string;
	/** Optional plan link (spec-id) when Beads surfaces it. */
	spec_id?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEnoent(e: unknown): boolean {
	return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

function isBdIssue(v: unknown): v is BdIssue {
	if (!isPlainObject(v)) return false;
	if (typeof v.id !== "string" || v.id.length === 0) return false;
	if (typeof v.title !== "string") return false;
	if (typeof v.status !== "string" || v.status.length === 0) return false;
	return true;
}

function isBdIssueArray(v: unknown): v is BdIssue[] {
	return Array.isArray(v) && v.every(isBdIssue);
}

/**
 * Fail-closed JSON decoder for `bd --json` stdout. Patterned on `parseGhJson`.
 * Rejects malformed JSON and wrong top-level shapes.
 */
export function parseBdJson<T>(stdout: string, shapeOk: (v: unknown) => boolean): T {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (e) {
		const hint = e instanceof Error ? e.message : String(e);
		throw new Error(`bd returned non-JSON output: ${hint}`);
	}
	if (!shapeOk(parsed)) {
		throw new Error(`bd returned unexpected JSON shape: ${stdout.slice(0, 200)}`);
	}
	return parsed as T;
}

/** Resolve the git main worktree that owns `MAIN_REPO/.beads`. Falls back to `repo` when git fails. */
export function resolveBeadsStoreRoot(repo: string): string {
	try {
		const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd: repo,
			encoding: "utf-8",
			timeout: BD_TIMEOUT_MS,
		});
		if (r.status === 0 && r.stdout?.trim()) {
			return dirname(r.stdout.trim());
		}
	} catch {
		// fall through
	}
	return repo;
}

export function defaultBdRun(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
	const r = spawnSync("bd", args, { cwd, encoding: "utf-8", timeout: BD_TIMEOUT_MS });
	if (r.error && isEnoent(r.error)) {
		throw new Error(BD_MISSING_MSG);
	}
	if (r.error && (r.error as { code?: string }).code === "ETIMEDOUT") {
		throw new Error(`bd ${args[0] ?? ""} timed out after ${BD_TIMEOUT_MS / 1000}s`);
	}
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

const BD_MISSING_MSG = "bd CLI required — install Beads (https://github.com/steveyegge/beads) and ensure `bd` is on PATH";

// ─── Mapping helpers ─────────────────────────────────────────────────────────

function mapBdStatus(raw: string): ItemStatus {
	switch (raw.toLowerCase()) {
		case "closed":
		case "done":
			return "done";
		case "in_progress":
		case "in-progress":
			return "in-progress";
		case "blocked":
			return "blocked";
		case "open":
		case "todo":
		case "deferred":
			return "open";
		default:
			return "unknown";
	}
}

function extractDepIds(issue: BdIssue): string[] {
	const out: string[] = [];
	const push = (id: unknown) => {
		if (typeof id === "string" && id.length > 0) out.push(id);
	};
	if (Array.isArray(issue.depends_on)) {
		for (const d of issue.depends_on) push(d);
	}
	if (Array.isArray(issue.blocked_by)) {
		for (const d of issue.blocked_by) push(d);
	}
	if (Array.isArray(issue.dependencies)) {
		for (const d of issue.dependencies) {
			if (typeof d === "string") {
				push(d);
			} else if (isPlainObject(d)) {
				push(d.depends_on_id ?? d.dependency_id ?? (typeof d.id === "string" && d.id !== issue.id ? d.id : undefined));
			}
		}
	}
	return [...new Set(out)];
}

function formatDeps(issue: BdIssue): string {
	return extractDepIds(issue).join(", ");
}

function attachPriority(item: RoadmapItemStatus, priority: unknown): RoadmapItemStatus {
	if (typeof priority === "number" && Number.isFinite(priority)) {
		return Object.assign(item, { priority });
	}
	return item;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class BeadsRoadmap implements RoadmapSource {
	readonly name: RoadmapSourceName = "beads";
	private readonly repo: string;
	private readonly storeRoot: string;
	private readonly bdRun: BdRunner;

	constructor(opts: BeadsRoadmapOpts) {
		this.repo = opts.repo;
		this.storeRoot = opts.storeRoot ?? resolveBeadsStoreRoot(opts.repo);
		const storeRoot = this.storeRoot;
		this.bdRun = opts.bdRun ?? ((args) => defaultBdRun(args, storeRoot));
	}

	/** Store root used for `bd` cwd — exposed for tests. */
	get beadsStoreRoot(): string {
		return this.storeRoot;
	}

	async parseItemId(text: string): Promise<string | null> {
		const branch = text.match(BD_ID_IN_BRANCH_RE);
		if (branch) return branch[1].toLowerCase();
		const bare = text.match(BD_ID_IN_TEXT_RE);
		if (bare) return bare[1].toLowerCase();
		return null;
	}

	async listOpenItems(): Promise<RoadmapItem[]> {
		// Availability derives from bd WORK-readiness (deps met), never from bd claim status. `bd ready`
		// lists deps-met items bd doesn't consider claimed; bd excludes `in_progress` items from it, but
		// those were ready when claimed, so a dead-holder (bd `in_progress` whose authoritative feat/<id>
		// branch is gone) must re-enter availability — otherwise bd status would act as the claims
		// registry, violating the git-native invariant. Claimed = live git branch only. (#347 review)
		const ready = this.fetchReadySet();
		const inProgress = this.fetchInProgressSet();
		const byId = new Map<string, BdIssue>([...inProgress, ...ready]); // ready wins on overlap
		const claimed = claimedIds(this.repo, [...byId.keys()]);
		const out: RoadmapItem[] = [];
		for (const [id, issue] of byId) {
			if (claimed.has(id)) continue;
			out.push({ id, title: issue.title, deps: formatDeps(issue), sourceRef: id });
		}
		return out;
	}

	async listItems(opts?: { includeDone?: boolean }): Promise<RoadmapItemStatus[]> {
		const args = opts?.includeDone ? ["list", "--all", "--json"] : ["list", "--json"];
		const raw = this.runBd(args);
		const issues = parseBdJson<BdIssue[]>(raw, isBdIssueArray);
		// Work-ready = deps-met (`bd ready`) ∪ bd-in_progress (already fetched in `issues`). bd claim
		// status is not authoritative; applyClaimOverlay marks in-progress from live git branches. (#347)
		const workReady = new Set([...this.fetchReadySet().keys(), ...issues.filter((it) => mapBdStatus(it.status) === "in-progress").map((it) => it.id.toLowerCase())]);
		const items = issues.map((it) => this.toStatus(it, workReady));
		return this.applyClaimOverlay(items);
	}

	async getItem(id: string): Promise<RoadmapItemStatus | null> {
		const canonical = id.toLowerCase();
		try {
			const raw = this.runBd(["show", canonical, "--json"]);
			// `bd show` may return a single object or a one-element array.
			const parsed = parseBdJson<BdIssue | BdIssue[]>(raw, (v) => isBdIssue(v) || isBdIssueArray(v));
			const issue = Array.isArray(parsed) ? parsed[0] : parsed;
			if (!issue) return null;
			// bd-in_progress is a work item (deps were met at claim); git decides claimed. (#347)
			const workReady = new Set([...this.fetchReadySet().keys(), ...(mapBdStatus(issue.status) === "in-progress" ? [issue.id.toLowerCase()] : [])]);
			const item = this.toStatus(issue, workReady, { includeBody: true });
			const [overlaid] = this.applyClaimOverlay([item]);
			return overlaid;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/not found|no such|unknown issue|does not exist/i.test(msg)) return null;
			throw e;
		}
	}

	async claimItem(id: string, opts?: { noWorktree?: boolean }): Promise<{ branch: string; worktree: string }> {
		const canonical = id.toLowerCase();
		const raw = this.runBd(["show", canonical, "--json"]);
		const parsed = parseBdJson<BdIssue | BdIssue[]>(raw, (v) => isBdIssue(v) || isBdIssueArray(v));
		const issue = Array.isArray(parsed) ? parsed[0] : parsed;
		if (!issue) throw new Error(`Beads issue not found: ${canonical}`);
		// Slug-free branch: bd ids contain hyphens (and dots), so a `-slug` suffix would make
		// id-in-branch parsing ambiguous. The worktree name derives from the id (not the branch),
		// so dropping the slug costs only branch cosmetics and buys an unambiguous `feat/<id>`. Claim
		// detection stays robust either way via `claimedIds` (known-id prefix match). (#347 review)
		const branch = `feat/${canonical}`;

		// Authoritative git claim first — AlreadyClaimedError before any Beads write-back.
		const claim = createClaimWorkspace(this.repo, canonical, branch, opts);

		// Best-effort Beads projection; never roll back a valid git claim.
		try {
			this.runBd(["update", canonical, "--claim"]);
		} catch {
			// swallowed
		}
		return claim;
	}

	async markDone(id: string, _ctx?: MarkDoneContext): Promise<void> {
		const canonical = id.toLowerCase();
		// Note is omitted: Beads close has no portable structured note flag without shell embedding.
		try {
			this.runBd(["close", canonical]);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/already closed|already done|is closed/i.test(msg)) return;
			throw e;
		}
	}

	resolvePlanPath(ctx: { id: string; worktree: string }): string {
		return resolve(ctx.worktree, "docs", "plans", `${ctx.id.toLowerCase()}.md`);
	}

	async publishPlan(_body: string, ctx: { id: string; worktree: string }): Promise<void> {
		const planPath = this.resolvePlanPath(ctx);
		const plansDir = resolve(ctx.worktree, "docs", "plans");
		const relToPlans = relative(plansDir, planPath);
		if (relToPlans.startsWith("..") || isAbsolute(relToPlans)) {
			throw new Error(`plan path escapes docs/plans/: ${planPath}`);
		}
		// Reject when the resolved path is outside the worktree entirely.
		const relToWorktree = relative(ctx.worktree, planPath);
		if (relToWorktree.startsWith("..") || isAbsolute(relToWorktree)) {
			throw new Error(`plan path outside worktree: ${planPath}`);
		}
		if (!existsSync(planPath)) {
			throw new Error(`plan file not found at ${planPath}`);
		}
		const repoRel = `docs/plans/${ctx.id.toLowerCase()}.md`;
		this.runBd(["update", ctx.id.toLowerCase(), "--spec-id", repoRel]);
	}

	async getItemPlan(ref: { worktree?: string; id?: string }): Promise<string | null> {
		const id = ref.id?.toLowerCase();
		if (!id) return null;
		if (ref.worktree) {
			const wt = resolve(ref.worktree, "docs", "plans", `${id}.md`);
			if (existsSync(wt)) return wt;
		}
		const main = resolve(this.repo, "docs", "plans", `${id}.md`);
		if (existsSync(main)) return main;
		return null;
	}

	async createItem(opts: CreateItemOpts): Promise<RoadmapItem> {
		const deps = opts.deps ?? [];
		const bodyParts: string[] = [];
		if (opts.scope) bodyParts.push(`Scope: ${opts.scope}`);
		if (opts.deferred) bodyParts.push("Deferred: true");
		const description = bodyParts.join("\n");
		const priority = opts.priority === "high" ? BD_PRIORITY_HIGH : BD_PRIORITY_NORMAL;

		const args = ["create", "--title", opts.title, "--priority", String(priority), "--json"];
		if (description) args.push("--description", description);

		const raw = this.runBd(args);
		const created = parseBdJson<BdIssue>(raw, isBdIssue);
		const id = created.id.toLowerCase();

		for (const dep of deps) {
			try {
				this.runBd(["dep", "add", id, dep.toLowerCase()]);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				throw new Error(`Beads item ${id} created but dependency attach failed for ${dep}: ${msg}`);
			}
		}

		return {
			id,
			title: created.title,
			deps: deps.map((d) => d.toLowerCase()).join(", "),
			sourceRef: id,
		};
	}

	async archivePlan(_id: string): Promise<void> {
		// No-op: plans stay committed under docs/plans/; Beads has no archive step.
	}

	isCharterPickRace(_id: string): boolean {
		return false;
	}

	// ─── internals ───────────────────────────────────────────────────────────

	private toStatus(issue: BdIssue, workReady: Set<string>, opts?: { includeBody?: boolean }): RoadmapItemStatus {
		const id = issue.id.toLowerCase();
		const raw = mapBdStatus(issue.status);
		let status: ItemStatus;
		let blockedReason: string | undefined;
		const reason = typeof issue.blocked_reason === "string" ? issue.blocked_reason.trim() : "";

		// #347: bd `in_progress` is NOT authoritative for "claimed" — the git `feat/<id>` branch is
		// (applied in applyClaimOverlay). So a non-done bd item is "open" (available) when its deps are
		// met (workReady = `bd ready` ∪ bd-in_progress), else "blocked". A dead-holder (bd in_progress
		// with no branch) therefore surfaces as open and re-enters availability instead of being stuck.
		if (raw === "done") {
			status = "done";
		} else if (raw === "blocked") {
			status = "blocked";
			if (reason) blockedReason = reason;
		} else if (workReady.has(id)) {
			status = "open";
		} else {
			status = "blocked";
			if (reason) blockedReason = reason;
		}

		const item: RoadmapItemStatus = {
			id,
			title: issue.title,
			deps: formatDeps(issue),
			sourceRef: id,
			status,
		};
		if (blockedReason) item.blockedReason = blockedReason;
		if (opts?.includeBody && typeof issue.description === "string") {
			item.body = issue.description;
		}
		return attachPriority(item, issue.priority);
	}

	private applyClaimOverlay(items: RoadmapItemStatus[]): RoadmapItemStatus[] {
		const openIds = items.filter((i) => i.status === "open").map((i) => i.id);
		if (openIds.length === 0) return items;
		const claimed = claimedIds(this.repo, openIds);
		for (const it of items) {
			if (it.status === "open" && claimed.has(it.id)) it.status = "in-progress";
		}
		return items;
	}

	/** Ready issues keyed by lowercase id. */
	private fetchReadySet(): Map<string, BdIssue> {
		const raw = this.runBd(["ready", "--json"]);
		// Empty ready set may be `[]` or blank — treat blank as empty.
		if (!raw.trim()) return new Map();
		const issues = parseBdJson<BdIssue[]>(raw, isBdIssueArray);
		const map = new Map<string, BdIssue>();
		for (const it of issues) map.set(it.id.toLowerCase(), it);
		return map;
	}

	/** bd `in_progress` issues keyed by lowercase id (from `bd list`). `bd ready` excludes them, but
	 *  they were deps-ready when claimed; a dead-holder among them (no live git branch) must re-enter
	 *  availability — the git branch is the authoritative claim, not bd status. (#347) */
	private fetchInProgressSet(): Map<string, BdIssue> {
		const raw = this.runBd(["list", "--json"]);
		if (!raw.trim()) return new Map();
		const issues = parseBdJson<BdIssue[]>(raw, isBdIssueArray);
		const map = new Map<string, BdIssue>();
		for (const it of issues) if (mapBdStatus(it.status) === "in-progress") map.set(it.id.toLowerCase(), it);
		return map;
	}

	private runBd(args: string[]): string {
		let result: { stdout: string; stderr: string; status: number };
		try {
			result = this.bdRun(args);
		} catch (e) {
			if (isEnoent(e)) throw new Error(BD_MISSING_MSG);
			throw e;
		}
		if (result.status !== 0) {
			const stderr = result.stderr ?? "";
			if (/command not found/i.test(stderr) || result.status === 127) {
				throw new Error(BD_MISSING_MSG);
			}
			throw new Error(`bd ${args.join(" ")} failed: ${stderr.trim() || result.status}`);
		}
		return result.stdout;
	}
}

/** @internal test helper — exact-id grammar check without list context. */
export function isBeadsItemId(id: string): boolean {
	return BD_ID_EXACT_RE.test(id);
}
