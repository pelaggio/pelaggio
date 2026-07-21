import type { ShipContext, ShipResult, ShipTarget } from "../types.js";
import { shipBodyFile } from "./decision.js";
import { extractPrUrl } from "./pull-request.js";

export const autoMergePr: ShipTarget = {
	name: "auto-merge-pr",
	buildPrompt(ctx: ShipContext): string {
		return [
			"Mode: auto-merge-pr.",
			"The harness owns squash, push, PR upsert, and enabling auto-merge. Inspect the branch as needed,",
			"but do not mutate git state and do not run network or roadmap commands. Do NOT merge manually.",
			`Write the PR body (markdown, up to 512 KiB) to exactly \`${shipBodyFile(ctx.itemId)}\` inside the worktree`,
			"(create the directory if needed; it must be a plain file at that exact path, not a symlink), then emit",
			"exactly one marked decision block referencing it. Keep the JSON to short scalar fields only — do NOT",
			"inline the body:",
			"SHIP_DECISION",
			`{"target":"auto-merge-pr","itemId":"${ctx.itemId}","headBranch":"<current-branch>","prTitle":"<title>","prBodyFile":"${shipBodyFile(ctx.itemId)}"}`,
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
