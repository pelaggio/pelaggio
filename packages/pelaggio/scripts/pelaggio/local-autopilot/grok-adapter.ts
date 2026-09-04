import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter, HarnessContext } from "./harness.js";

function grokBin(ctx: HarnessContext): string {
	return ctx.config.harness.grok?.bin ?? join(homedir(), ".grok", "bin", "grok");
}

function runGrok(bin: string, args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { cwd, env: process.env });
		let output = "";
		child.stdout?.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			output += String(chunk);
		});
		child.on("error", (err) => resolve({ ok: false, output: err.message }));
		child.on("close", (code) => resolve({ ok: code === 0, output }));
	});
}

export const grokAdapter: HarnessAdapter = {
	name: "grok",
	async next(ctx: HarnessContext) {
		if (ctx.cursor > 0) return { action: { kind: "complete" as const }, cursor: ctx.cursor };
		const bin = grokBin(ctx);
		const prompt = [
			"Implement the following task in this git worktree.",
			"Do not push, open a pull request, merge, release, or deploy.",
			"Stay inside the current working directory.",
			"",
			`# ${ctx.workContract.title}`,
			"",
			ctx.workContract.body,
		].join("\n");
		const model = ctx.config.harness.grok?.model;
		const args = ["agent", "--always-approve", ...(model ? ["-m", model] : []), "-p", prompt];
		const result = await runGrok(bin, args, ctx.worktree);
		if (!result.ok) return { action: { kind: "crash", message: result.output.slice(0, 2000) || "grok harness failed" }, cursor: 1 };
		return { action: { kind: "complete" }, cursor: 1 };
	},
};
