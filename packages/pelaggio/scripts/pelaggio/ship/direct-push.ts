import type { ShipContext, ShipResult, ShipTarget } from "../types.js";

export const directPush: ShipTarget = {
	name: "direct-push",
	buildPrompt(ctx: ShipContext): string {
		return [
			"Mode: direct-push (pelaggio).",
			"Squash the branch, merge into local main, and run post-merge verification — then STOP.",
			`Report \`ship-merged: ${ctx.itemId}\` on the final line.`,
			"Do NOT push, mark the item done, archive the plan, or clean up the worktree/branch:",
			"the pipeline owns those steps deterministically once the merge lands.",
			"NEVER discard uncommitted changes in MAIN_REPO to get a clean tree — if the merge target is dirty,",
			"commit the stray changes; do not `git checkout`/`reset --hard`/`stash drop` them away.",
			"(The /ship skill body's steps 1–5 are yours; steps 6–10 belong to the pipeline.)",
		].join(" ");
	},
	interpretResult(step): ShipResult {
		return { completed: step.ok, error: step.ok ? undefined : "ship failed" };
	},
};
