import { ROADMAP_GITHUB, ROADMAP_LINEAR, ROADMAP_SOURCE } from "../config.js";
import { mainWorktree } from "../git.js";
import { getRoadmapSource, type RoadmapSource } from "../roadmap/index.js";
import { type AssessmentInput, makeAssessment } from "./assessment.js";
import { loadAssessmentInput } from "./assessment-store.js";

export async function prepareAssessmentInput(repo: string, prNumber: number, itemId: string, headSha: string, roadmap?: Pick<RoadmapSource, "getItem">, mainRepo = mainWorktree(repo)): Promise<AssessmentInput> {
	const source = roadmap ?? getRoadmapSource(ROADMAP_SOURCE, { repo, github: ROADMAP_GITHUB, linear: ROADMAP_LINEAR });
	const item = await source.getItem(itemId);
	if (!item?.body) throw new Error("Original roadmap task unavailable; assessment context was not admitted.");
	const task = makeAssessment({ itemId, prNumber, source: item.sourceRef, request: `${item.title}\n\n${item.body}` });
	return loadAssessmentInput(mainRepo, repo, task, headSha);
}
