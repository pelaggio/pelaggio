import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter, HarnessContext } from "./harness.js";
import { runLocalProcess } from "./process.js";

function grokBin(ctx: HarnessContext): string {
	return ctx.config.harness.grok?.bin ?? join(homedir(), ".grok", "bin", "grok");
}

export type GrokRunner = (bin: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<{ ok: boolean; output: string }>;

const runGrok: GrokRunner = runLocalProcess;

export function createGrokAdapter(run: GrokRunner = runGrok): HarnessAdapter {
	return {
		name: "grok",
		async next(ctx: HarnessContext) {
			const bin = grokBin(ctx);
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
			const model = ctx.config.harness.grok?.model;
			const args = ["agent", "--always-approve", ...(model ? ["-m", model] : []), "-p", prompt];
			const result = await run(bin, args, ctx.worktree, ctx.signal);
			const cursor = ctx.cursor + 1;
			if (!result.ok) return { action: { kind: "crash", message: result.output.slice(0, 2000) || "grok harness failed" }, cursor };
			return { action: { kind: "complete" }, cursor };
		},
	};
}

export const grokAdapter = createGrokAdapter();
