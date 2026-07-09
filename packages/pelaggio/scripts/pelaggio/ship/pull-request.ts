import type { ShipContext, ShipResult, ShipTarget, StepResult } from "../types.js";

const PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

export function extractPrUrl(step: StepResult): string | undefined {
	const haystack = `${step.text}\n${step.fullText}`;
	const match = haystack.match(PR_URL_RE);
	return match ? match[0] : undefined;
}

export const pullRequest: ShipTarget = {
	name: "pull-request",
	buildPrompt(ctx: ShipContext): string {
		return [
			"Mode: pull-request.",
			"The harness owns squash, push, PR upsert, and all forge effects. Inspect the branch as needed,",
			"but do not mutate git state and do not run network or roadmap commands. Do NOT merge into main.",
			"Emit exactly one marked decision block for the harness:",
			"SHIP_DECISION",
			`{"target":"pull-request","itemId":"${ctx.itemId}","headBranch":"<current-branch>","prTitle":"<title>","prBody":"<body>"}`,
			"END_SHIP_DECISION",
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
