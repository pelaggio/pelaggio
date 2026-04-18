import type { ShipContext, ShipResult, ShipTarget } from "../types.js";
import { extractPrUrl } from "./pull-request.js";

export const autoMergePr: ShipTarget = {
	name: "auto-merge-pr",
	buildPrompt(_ctx: ShipContext): string {
		return [
			"Mode: auto-merge-pr.",
			"Squash the branch. Push it to origin. Create a PR via `gh pr create` with a title and body",
			"derived from the squashed commit message. After creating the PR, enable auto-merge:",
			"`gh pr merge --auto --squash <pr-number>`. Do NOT merge manually. Do NOT update docs,",
			"task-index, or archive the plan — those land when the PR auto-merges externally.",
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
