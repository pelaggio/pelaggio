import type { ShipContext, ShipResult, ShipTarget } from "../types.js";

export const directPush: ShipTarget = {
	name: "direct-push",
	buildPrompt(_ctx: ShipContext): string {
		return [
			"Mode: direct-push.",
			"Squash the branch, merge into main locally, run post-merge verification, mark the item done,",
			"commit doc updates, push main, and clean up the worktree and branch.",
			"(The /ship skill body has the full steps — run them end to end.)",
		].join(" ");
	},
	interpretResult(step): ShipResult {
		return { completed: step.ok, error: step.ok ? undefined : "ship failed" };
	},
};
