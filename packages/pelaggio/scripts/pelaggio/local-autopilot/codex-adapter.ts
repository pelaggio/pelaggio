import type { HarnessAdapter, HarnessContext } from "./harness.js";
import { runLocalProcess } from "./process.js";

export type CodexRunner = (bin: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<{ ok: boolean; output: string }>;

const runCodex: CodexRunner = runLocalProcess;

export function createCodexAdapter(run: CodexRunner = runCodex): HarnessAdapter {
	return {
		name: "codex",
		async next(ctx: HarnessContext) {
			const prompt = [
				"Implement the following task in this git worktree.",
				"Do not push, open a pull request, merge, release, or deploy.",
				"Stay inside the current working directory.",
				"",
				`# ${ctx.workContract.title}`,
				"",
				ctx.workContract.body,
				...(ctx.verificationFailure ? ["", "The previous verification failed. Repair this exact failure:", ctx.verificationFailure] : []),
			].join("\n");
			const configured = ctx.config.harness.codex;
			const args = ["exec", "--approve-for-me", "--sandbox", "workspace-write", "--cd", ctx.worktree, ...(configured?.model ? ["--model", configured.model] : []), prompt];
			const result = await run(configured?.bin ?? "codex", args, ctx.worktree, ctx.signal);
			const cursor = ctx.cursor + 1;
			if (!result.ok) return { action: { kind: "crash", message: result.output.slice(0, 2000) || "codex harness failed" }, cursor };
			return { action: { kind: "complete" }, cursor };
		},
	};
}

export const codexAdapter = createCodexAdapter();
