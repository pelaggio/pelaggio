import type { HarnessAdapter, HarnessContext } from "./harness.js";
import { runLocalProcess } from "./process.js";
import { prepareHarnessPrompt } from "./prompt.js";

export type CodexRunner = (bin: string, args: string[], cwd: string, signal?: AbortSignal, options?: { input?: string }) => Promise<{ ok: boolean; output: string }>;

const runCodex: CodexRunner = runLocalProcess;

export function createCodexAdapter(run: CodexRunner = runCodex): HarnessAdapter {
	return {
		name: "codex",
		async next(ctx: HarnessContext) {
			const prompt = prepareHarnessPrompt(ctx.workContract, ctx.verificationFailure);
			const configured = ctx.config.harness.codex;
			const args = ["exec", "--approve-for-me", "--sandbox", "workspace-write", "--cd", ctx.worktree, ...(configured?.model ? ["--model", configured.model] : []), "-"];
			const result = await run(configured?.bin ?? "codex", args, ctx.worktree, ctx.signal, { input: prompt.text });
			const cursor = ctx.cursor + 1;
			if (!result.ok) return { action: { kind: "crash", message: result.output.slice(0, 2000) || "codex harness failed" }, cursor, usageMeasurement: prompt.usageMeasurement };
			return { action: { kind: "complete" }, cursor, usageMeasurement: prompt.usageMeasurement };
		},
	};
}

export const codexAdapter = createCodexAdapter();
