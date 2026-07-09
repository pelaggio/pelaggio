import type { ShipContext, ShipResult, ShipTarget } from "../types.js";
import { extractPrUrl } from "./pull-request.js";

export const autoMergePr: ShipTarget = {
	name: "auto-merge-pr",
	buildPrompt(ctx: ShipContext): string {
		return [
			"Mode: auto-merge-pr.",
			"The harness owns squash, push, PR upsert, and enabling auto-merge. Inspect the branch as needed,",
			"but do not mutate git state and do not run network or roadmap commands. Do NOT merge manually.",
			"Emit exactly one marked decision block for the harness:",
			"SHIP_DECISION",
			`{"target":"auto-merge-pr","itemId":"${ctx.itemId}","headBranch":"<current-branch>","prTitle":"<title>","prBody":"<body>"}`,
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
