import { GitHubIssuesRoadmap } from "./github-issues.js";
import { LinearRoadmap } from "./linear.js";
import { MarkdownRoadmap } from "./markdown.js";
import { type GithubRoadmapConfig, type LinearRoadmapConfig, ROADMAP_SOURCE_NAMES, type RoadmapSource, type RoadmapSourceName } from "./types.js";

export { AlreadyClaimedError } from "./git-claim.js";
export {
	type CreateItemOpts,
	type GithubRoadmapConfig,
	type ItemStatus,
	isMarkdownRoadmapFormat,
	isPlanLocation,
	isRoadmapSourceName,
	type LinearRoadmapConfig,
	MARKDOWN_ROADMAP_FORMATS,
	type MarkDoneContext,
	type MarkdownRoadmapFormat,
	PLAN_LOCATIONS,
	type PlanLocation,
	type QuickScopeInput,
	ROADMAP_SOURCE_NAMES,
	type RoadmapItem,
	type RoadmapItemStatus,
	type RoadmapSource,
	type RoadmapSourceName,
} from "./types.js";
export { GitHubIssuesRoadmap, LinearRoadmap, MarkdownRoadmap };

export function getRoadmapSource(name: RoadmapSourceName, opts: { repo: string; github?: GithubRoadmapConfig; linear?: LinearRoadmapConfig }): RoadmapSource {
	switch (name) {
		case "markdown":
			return new MarkdownRoadmap({ repo: opts.repo });
		case "github-issues":
			if (!opts.github?.ghRepo) {
				throw new Error("github-issues roadmap requires `roadmap.github.repo` (owner/repo) in .autopilot.yml");
			}
			return new GitHubIssuesRoadmap({
				repo: opts.repo,
				ghRepo: opts.github.ghRepo,
				label: opts.github.label,
				planLocation: opts.github.planLocation,
			});
		case "linear":
			if (!opts.linear?.teamId) {
				throw new Error("linear roadmap requires `roadmap.linear.team` in .autopilot.yml");
			}
			return new LinearRoadmap({
				repo: opts.repo,
				teamId: opts.linear.teamId,
				label: opts.linear.label,
				planLocation: opts.linear.planLocation,
			});
		default: {
			const exhaustive: never = name;
			throw new Error(`Unknown roadmap source: ${JSON.stringify(exhaustive)}. Valid: ${ROADMAP_SOURCE_NAMES.join(", ")}`);
		}
	}
}
