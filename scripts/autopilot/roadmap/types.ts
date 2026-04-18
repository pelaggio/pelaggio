export type RoadmapSourceName = "markdown" | "github-issues";

export const ROADMAP_SOURCE_NAMES: readonly RoadmapSourceName[] = ["markdown", "github-issues"];

export type GhPlanLocation = "issue-comment" | "pr-description";

export const GH_PLAN_LOCATIONS: readonly GhPlanLocation[] = ["issue-comment", "pr-description"];

export interface GithubRoadmapConfig {
	/**
	 * `owner/repo`. Required when roadmap.source is github-issues. Named
	 * `ghRepo` (not `repo`) to avoid collision with the factory's local-git
	 * `opts.repo` when threading config through.
	 */
	ghRepo: string;
	/** Label filtering open issues. Default: `autopilot`. */
	label: string;
	/** Where to look for plan bodies. Default: `issue-comment`. */
	planLocation: GhPlanLocation;
}

export interface RoadmapItem {
	id: string;
	title: string;
	/** Raw deps column (e.g. "TOOL-4, TOOL-8" or "blocked: waiting on X" or "—"). */
	deps: string;
	/** Source-specific payload (roadmap file path, issue number, Linear ID). */
	sourceRef: string;
}

export interface MarkDoneContext {
	/** Human-readable closure note; adapters decide placement (commit body / issue comment / etc.). */
	note?: string;
}

export interface RoadmapSource {
	readonly name: RoadmapSourceName;
	listOpenItems(): Promise<RoadmapItem[]>;
	claimItem(id: string): Promise<{ branch: string; worktree: string }>;
	markDone(id: string, ctx?: MarkDoneContext): Promise<void>;
	getItemPlan(ref: { worktree?: string; id?: string }): Promise<string | null>;
	parseItemId(text: string): string | null;
	isQuickScope(text: string): boolean;
}

export function isRoadmapSourceName(v: unknown): v is RoadmapSourceName {
	return typeof v === "string" && (ROADMAP_SOURCE_NAMES as readonly string[]).includes(v);
}

export function isGhPlanLocation(v: unknown): v is GhPlanLocation {
	return typeof v === "string" && (GH_PLAN_LOCATIONS as readonly string[]).includes(v);
}
