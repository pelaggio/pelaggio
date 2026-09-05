import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter, HarnessContext } from "./harness.js";
import { runLocalProcess } from "./process.js";
import { prepareHarnessPrompt } from "./prompt.js";

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
			const prompt = prepareHarnessPrompt(ctx.workContract, ctx.verificationFailure);
			const model = ctx.config.harness.grok?.model;
			// Keep execution in this process group so cancellation cannot leave a shared leader running.
			const promptDir = mkdtempSync(join(tmpdir(), "pelaggio-grok-prompt-"));
			const promptPath = join(promptDir, "prompt.txt");
			writeFileSync(promptPath, prompt.text, { mode: 0o600 });
			let result: Awaited<ReturnType<GrokRunner>>;
			try {
				const args = ["--no-leader", "--always-approve", ...(model ? ["-m", model] : []), "--prompt-file", promptPath];
				result = await run(bin, args, ctx.worktree, ctx.signal);
			} finally {
				rmSync(promptDir, { recursive: true, force: true });
			}
			const cursor = ctx.cursor + 1;
			if (!result.ok) return { action: { kind: "crash", message: result.output.slice(0, 2000) || "grok harness failed" }, cursor, usageMeasurement: prompt.usageMeasurement };
			return { action: { kind: "complete" }, cursor, usageMeasurement: prompt.usageMeasurement };
		},
	};
}

export const grokAdapter = createGrokAdapter();
