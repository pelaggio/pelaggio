import type { HarnessAction, HarnessAdapter, HarnessContext } from "./harness.js";
import { configProblem } from "./transport.js";

export const fakeAdapter: HarnessAdapter = {
	name: "fake",
	async next(ctx: HarnessContext): Promise<{ action: HarnessAction; cursor: number }> {
		const script = ctx.config.harness.fake?.script;
		if (!script || script.length === 0) {
			throw Object.assign(new Error(configProblem("fake-script", "harness.fake.script is required for the fake adapter").message), { problem: configProblem("fake-script", "harness.fake.script is required for the fake adapter") });
		}
		if (ctx.cursor >= script.length) return { action: { kind: "complete" }, cursor: ctx.cursor };
		const step = script[ctx.cursor];
		if (!step) return { action: { kind: "complete" }, cursor: ctx.cursor };
		const cursor = ctx.cursor + 1;
		if (step.action === "write") return { action: { kind: "write", path: step.path, content: step.content }, cursor };
		if (step.action === "decision") return { action: { kind: "decision", code: step.code, message: step.message }, cursor };
		if (step.action === "verify-fail") return { action: { kind: "verify-fail", message: step.message }, cursor };
		if (step.action === "crash") return { action: { kind: "crash", message: step.message }, cursor };
		return { action: { kind: "complete" }, cursor };
	},
};
