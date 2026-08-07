export type RoadmapSourceName = "markdown" | "github-issues" | "linear" | "beads";

export const ROADMAP_SOURCE_NAMES: readonly RoadmapSourceName[] = ["markdown", "github-issues", "linear", "beads"];

export type Scope = "XS" | "S" | "M" | "L" | "XL";

export const SCOPE_NAMES: readonly Scope[] = ["XS", "S", "M", "L", "XL"];

export type PlanLocation = "issue-comment" | "pr-description";

export const PLAN_LOCATIONS: readonly PlanLocation[] = ["issue-comment", "pr-description"];

export type MarkdownRoadmapFormat = "checkbox" | "table";

export const MARKDOWN_ROADMAP_FORMATS: readonly MarkdownRoadmapFormat[] = ["checkbox", "table"];

export interface GithubRoadmapConfig {
	/**
	 * `owner/repo`. Required when roadmap.source is github-issues. Named
	 * `ghRepo` (not `repo`) to avoid collision with the factory's local-git
	 * `opts.repo` when threading config through.
	 */
	ghRepo: string;
	/** Label filtering open issues. Default: `pelaggio`. */
	label: string;
	/** Where to look for plan bodies. Default: `issue-comment`. */
	planLocation: PlanLocation;
}

export interface LinearRoadmapConfig {
	/** Linear team UUID. Required when roadmap.source is linear. */
	teamId: string;
	/** Label filtering open issues. Default `""` = no label filter. */
	label: string;
	/** Where to look for plan bodies. Only `issue-comment` is implemented. */
	planLocation: PlanLocation;
}

export interface RoadmapItem {
	id: string;
	title: string;
	/** Raw deps column (e.g. "TOOL-4, TOOL-8" or "blocked: waiting on X" or "—"). */
	deps: string;
	/** Source-specific payload (roadmap file path, issue number, Linear ID). */
	sourceRef: string;
}

export type ItemStatus = "open" | "done" | "blocked" | "unknown" | "in-progress";

export interface RoadmapItemStatus extends RoadmapItem {
	status: ItemStatus;
	/** Parsed "blocked: waiting on X" reason; present only when status is blocked */
	blockedReason?: string;
	/** Item body/spec text when the adapter carries it — GitHub issue body, markdown item row,
	 *  Beads description, or Linear description. Lets the harness inject requirements into the
	 *  plan prompt for a sandboxed model that can't fetch it itself (#103). */
	body?: string;
	/** Item labels when the adapter carries them. Absent for sources without label metadata. */
	labels?: string[];
	/**
	 * Numeric priority for flow ranking (lower = more urgent). Optional at the cross-adapter
	 * contract — markdown/Linear omit it; GitHub and Beads always materialize a tier.
	 */
	priority?: number;
	/**
	 * Declared T-shirt size, extracted from the item body like `deps`. Adapters populate
	 * this best-effort; an omitted value is never gated by automatic selection.
	 */
	scope?: Scope;
	/**
	 * When true, automatic `roadmap next` excludes the item (reason `deferred`). Explicit
	 * `/pick <id>` / `--item <id>` still claim it. Omitted or false means not deferred.
	 */
	deferred?: boolean;
	/** Charter-review digest parsed from the provenance marker, when present (#367). Content-addresses the record. */
	reviewDigest?: string;
	/** Resolved charter-review level recorded on the item (`off` | `triad`), when a provenance marker is present. */
	reviewLevel?: string;
}

/**
 * Charter-review provenance stamped on an item at create/activation (#367). Rendered into a stable
 * marker so every adapter persists compatible bytes; `reviewDigest` is the only adapter credential and
 * is minted solely by the create gate / activation wrapper.
 */
/**
 * The exact content the activation panel reviewed. Adapters refetch before restamping, so without
 * this they would stamp "reviewed" onto whatever the item says *now* — an edit or close landing
 * during the (asynchronous, minutes-long) panel would be silently blessed.
 */
export interface ActivationExpectation {
	title: string;
	/** Verbatim body as the panel saw it, marker included. */
	body: string;
}

export interface ReviewProvenance {
	/** Content address of the charter-review record (`.dev/charter-reviews/<digest>.json`). */
	reviewDigest: string;
	/** Effective charter-review level this item was minted under. */
	level: string;
	/** Declared scope recorded for audit (untrusted for sub-floor exemption). */
	scope?: Scope;
	/** Internal origin: only the two pipeline marker sites may claim the harness deferral exemption. */
	origin?: "create" | "harness-deferral";
	/** True when the item is created/left deferred pending a successful activation review. */
	deferred?: boolean;
}

/** Result of an idempotent body→label priority migration (`backfillPriorityLabels`). */
export interface PriorityLabelBackfillResult {
	readonly scanned: number;
	readonly labeled: number;
	/** Issue ids that already carry `priority:normal` while the body says high — fail-closed. */
	readonly conflicts: readonly string[];
}

export interface CreateItemOpts {
	title: string;
	/** Full charter/spec text. Remote work stores persist it as the item body/description. */
	description?: string;
	/**
	 * Settled internal charter body (#367). Normalized once at the CLI boundary from `description`; the
	 * create gate hashes exactly these bytes into the review record. Adapters persist body ⇒ description.
	 */
	body?: string;
	/**
	 * Charter-review digest — the ONLY adapter review credential. Minted solely by `createReviewedItem`
	 * / `activateDeferredItem`; the public CLI boundary rejects any caller-supplied value (#367).
	 */
	reviewDigest?: string;
	/** Recorded charter-review level (`off` | `triad`) minted alongside `reviewDigest`. */
	reviewLevel?: string;
	/**
	 * Internal harness-deferral exemption. ONLY the two pipeline marker call sites may set it; the public
	 * CLI rejects it. A `harness-deferral` create records the declared scope but is minted deferred.
	 */
	origin?: "harness-deferral";
	deps?: string[];
	scope?: Scope;
	/** Markdown: target roadmap file (partial match). Gh/Linear: no-op (issue goes to configured repo/team). */
	roadmap?: string;
	/** Markdown-only. Gh/Linear ignore. */
	after?: string;
	priority?: "high" | "normal";
	/** Shakedown-origin flag. Adapters may use it for triage labeling; markdown ignores. */
	deferred?: boolean;
	/** Markdown-only. Create docs/roadmap-<roadmap>.md when --to has no existing match. */
	create?: boolean;
	/** Markdown-only. Explicit ID prefix, e.g. INST. Bypasses prefix inference. */
	prefix?: string;
	/** Markdown-only. Explicit target format. Bypasses format inference. */
	format?: MarkdownRoadmapFormat;
}

export interface MarkDoneContext {
	/** Human-readable closure note; adapters decide placement (commit body / issue comment / etc.). */
	note?: string;
}

export interface RoadmapSource {
	readonly name: RoadmapSourceName;
	listOpenItems(): Promise<RoadmapItem[]>;
	/** List items with status; optionally include done/closed items. */
	listItems(opts?: { includeDone?: boolean }): Promise<RoadmapItemStatus[]>;
	/** Single-item lookup with status (`unknown` if not found in open or done sets). */
	getItem(id: string): Promise<RoadmapItemStatus | null>;
	claimItem(id: string, opts?: { noWorktree?: boolean }): Promise<{ branch: string; worktree: string }>;
	markDone(id: string, ctx?: MarkDoneContext): Promise<void>;
	getItemPlan(ref: { worktree?: string; id?: string }): Promise<string | null>;
	/** Resolve the path where /plan should write, whether or not the file exists yet. */
	resolvePlanPath(ctx: { id: string; worktree: string }): string;
	/** Publish a written plan to the adapter's upstream. Markdown: no-op. Gh/Linear: post comment. */
	publishPlan(body: string, ctx: { id: string; worktree: string }): Promise<void>;
	/** Create a new backlog item. Returns the item; id is source-assigned for gh/linear. */
	createItem(opts: CreateItemOpts): Promise<RoadmapItem>;
	/**
	 * Clear an item's deferred state, appending verified review provenance atomically as far as the
	 * provider allows (#367). Narrow by design — the harness never issues free-form body edits. Adapters
	 * remove the deferred label/marker only here, and only after the provenance write succeeds.
	 */
	activateItem(id: string, provenance: ReviewProvenance, expected?: ActivationExpectation): Promise<RoadmapItemStatus>;
	/** Archive a shipped plan. Markdown: `git mv` + commit. No-op elsewhere. */
	archivePlan(id: string): Promise<void>;
	/** True when the item exists in uncommitted working-tree state but not yet in HEAD. Gh/linear: always false. */
	isCharterPickRace(id: string): boolean;
	parseItemId(text: string): Promise<string | null>;
	/**
	 * Optional one-time migration: apply `priority:high` labels to issues whose body
	 * carries `Priority: high` but lack the label. GitHub-only today; CLI capability-checks.
	 */
	backfillPriorityLabels?(): Promise<PriorityLabelBackfillResult>;
}

export function isRoadmapSourceName(v: unknown): v is RoadmapSourceName {
	return typeof v === "string" && (ROADMAP_SOURCE_NAMES as readonly string[]).includes(v);
}

export function isScope(v: unknown): v is Scope {
	return typeof v === "string" && (SCOPE_NAMES as readonly string[]).includes(v);
}

export function isPlanLocation(v: unknown): v is PlanLocation {
	return typeof v === "string" && (PLAN_LOCATIONS as readonly string[]).includes(v);
}

export function isMarkdownRoadmapFormat(v: unknown): v is MarkdownRoadmapFormat {
	return typeof v === "string" && (MARKDOWN_ROADMAP_FORMATS as readonly string[]).includes(v);
}
