import type { ShipContext, ShipResult, ShipTarget, StepResult } from "../types.js";

const PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

export function extractPrUrl(step: StepResult): string | undefined {
	const haystack = `${step.text}\n${step.fullText}`;
	const match = haystack.match(PR_URL_RE);
	return match ? match[0] : undefined;
}

export const pullRequest: ShipTarget = {
	name: "pull-request",
	buildPrompt(_ctx: ShipContext): string {
		return [
			"Mode: pull-request.",
			"Squash the branch. Push it to origin. Create a PR via `gh pr create` with a title and body",
			"derived from the squashed commit message. Do NOT merge into main. Do NOT update docs,",
			"task-index, or archive the plan — a PR merge happens externally and those updates land later.",
			"Do NOT clean up the worktree or branch. Report the PR URL on the final line.",
		].join(" ");
	},
	interpretResult(step): ShipResult {
		const prUrl = extractPrUrl(step);
		return {
			completed: step.ok,
			awaitingMerge: step.ok ? true : undefined,
			prUrl,
			error: step.ok ? undefined : "ship failed",
		};
	},
};
