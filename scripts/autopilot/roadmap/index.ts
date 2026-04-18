import { MarkdownRoadmap } from "./markdown.js";
import { ROADMAP_SOURCE_NAMES, type RoadmapSource, type RoadmapSourceName } from "./types.js";

export { isRoadmapSourceName, type MarkDoneContext, ROADMAP_SOURCE_NAMES, type RoadmapItem, type RoadmapSource, type RoadmapSourceName } from "./types.js";
export { MarkdownRoadmap };

export function getRoadmapSource(name: RoadmapSourceName, opts: { repo: string }): RoadmapSource {
	switch (name) {
		case "markdown":
			return new MarkdownRoadmap(opts);
		default: {
			const exhaustive: never = name;
			throw new Error(`Unknown roadmap source: ${JSON.stringify(exhaustive)}. Valid: ${ROADMAP_SOURCE_NAMES.join(", ")}`);
		}
	}
}
