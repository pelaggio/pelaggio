import type { ShipContext, ShipResult, ShipTarget } from "../types.js";
import { extractPrUrl } from "./pull-request.js";

export const autoMergePr: ShipTarget = {
	name: "auto-merge-pr",
	buildPrompt(ctx: ShipContext): string {
		return [
			"Mode: auto-merge-pr.",
			"The harness owns squash, push, PR upsert, and enabling auto-merge. Inspect the branch as needed,",
			"but do not mutate git state and do not run network or roadmap commands. Do NOT merge manually.",
			`Write the PR body (markdown, any length) to the file \`.dev/ship/pr-body-${ctx.itemId}.md\` inside the worktree`,
			"(create the directory if needed), then emit exactly one marked decision block that references it by",
			"worktree-relative path. Keep the JSON to short scalar fields only — do NOT inline the body:",
			"SHIP_DECISION",
			`{"target":"auto-merge-pr","itemId":"${ctx.itemId}","headBranch":"<current-branch>","prTitle":"<title>","prBodyFile":".dev/ship/pr-body-${ctx.itemId}.md"}`,
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
