/**
 * Step runner (L3): resolves the per-step provider through the registry and delegates. The
 * seam types live in `providers/types.ts`, the registry in `providers/index.ts`, and each
 * provider in `providers/<name>.ts`; the re-exports below keep existing import sites working.
 */
import { CONFIG, resolveStepSettings } from "./config.js";
import { getProvider } from "./providers/index.js";
import type { RunStepFn } from "./providers/types.js";

export {
	beginMainCheckoutAttribution,
	blockForeignRootWrite,
	blockPlanPolish,
	blockWorktreeInstall,
	CLAUDE_CAPABILITIES,
	claudeProvider,
	endMainCheckoutAttribution,
	isClaudeMaxTurnsError,
	projectClaudeAssistantBlocks,
} from "./providers/claude.js";
export { getProvider, REGISTERED_PROVIDERS } from "./providers/index.js";
export type { ForeignRootDenial, RunStepFn, RunStepOpts, StepProvider } from "./providers/types.js";
export { composeSystemAppend, createStepTextProjection, isWorktreePath } from "./step-runner-shared.js";

/**
 * The exported step runner is a thin dispatcher: it resolves the per-step
 * `provider` and delegates to that provider's `runStep`. Keeping the exported name
 * `runStep` means both importers — `pipeline.ts` (the `deps.runStep` DI default) and
 * `pr-review-cli.ts` — route through the dispatcher with no import edits. The
 * provider's runner re-resolves `resolveStepSettings` for budget/turns/effort/model;
 * `resolveStepSettings` is pure and cheap, so the double call keeps the runner body
 * byte-identical at no real cost.
 */
export const runStep: RunStepFn = (name, prompt, opts, emit) => {
	// Production call paths share this dispatcher, including the local PR-review drain.
	// Fail before provider selection under node:test so a missed dependency injection can
	// never turn an otherwise hermetic test into a live Claude/Codex/Grok/OpenCode run.
	// Provider unit/conformance tests call the provider-local runner directly with a
	// controlled binary or an explicit live-test opt-in.
	if (process.env.NODE_TEST_CONTEXT !== undefined) {
		throw new Error(`provider execution blocked under node --test: inject a RunStepFn instead of calling the production dispatcher (step: ${name}; #420)`);
	}
	return getProvider(opts.executionOverride?.provider ?? resolveStepSettings(CONFIG, opts.profile, name).provider).runStep(name, prompt, opts, emit);
};
