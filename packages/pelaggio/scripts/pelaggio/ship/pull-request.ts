import type { ShipContext, ShipResult, ShipTarget, StepResult } from "../types.js";
import { shipBodyFile } from "./decision.js";

const PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

export function extractPrUrl(step: StepResult): string | undefined {
	const match = step.text.match(PR_URL_RE);
	return match ? match[0] : undefined;
}

export const pullRequest: ShipTarget = {
	name: "pull-request",
	buildPrompt(ctx: ShipContext): string {
		return [
			"Mode: pull-request.",
			"The harness owns squash, push, PR upsert, and all forge effects. Inspect the branch as needed,",
			"but do not mutate git state and do not run network or roadmap commands. Do NOT merge into main.",
			`Write the PR body (markdown, up to 512 KiB) to exactly \`${shipBodyFile(ctx.itemId)}\` inside the worktree`,
			"(create the directory if needed; it must be a plain file at that exact path, not a symlink), then emit",
			"exactly one marked decision block referencing it. Keep the JSON to short scalar fields only — do NOT",
			"inline the body:",
			"SHIP_DECISION",
			`{"target":"pull-request","itemId":"${ctx.itemId}","headBranch":"<current-branch>","prTitle":"<title>","prBodyFile":"${shipBodyFile(ctx.itemId)}"}`,
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
