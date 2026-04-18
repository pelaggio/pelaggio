import { GitHubIssuesRoadmap } from "./github-issues.js";
import { MarkdownRoadmap } from "./markdown.js";
import { type GithubRoadmapConfig, ROADMAP_SOURCE_NAMES, type RoadmapSource, type RoadmapSourceName } from "./types.js";

export {
	GH_PLAN_LOCATIONS,
	type GhPlanLocation,
	type GithubRoadmapConfig,
	isGhPlanLocation,
	isRoadmapSourceName,
	type MarkDoneContext,
	ROADMAP_SOURCE_NAMES,
	type RoadmapItem,
	type RoadmapSource,
	type RoadmapSourceName,
} from "./types.js";
export { GitHubIssuesRoadmap, MarkdownRoadmap };

export function getRoadmapSource(name: RoadmapSourceName, opts: { repo: string; github?: GithubRoadmapConfig }): RoadmapSource {
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
		default: {
			const exhaustive: never = name;
			throw new Error(`Unknown roadmap source: ${JSON.stringify(exhaustive)}. Valid: ${ROADMAP_SOURCE_NAMES.join(", ")}`);
		}
	}
}
