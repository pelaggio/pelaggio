/**
 * Step runner (L3): resolves the per-step provider, installs the durable provider-observation
 * funnel, and delegates through the registry. The seam types live in `providers/types.ts`, the
 * registry in `providers/index.ts`, and each provider in `providers/<name>.ts`.
 */
import { CONFIG, modelForProvider, REPO, resolveStepSettings } from "./config.js";
import { appendProviderObservation, createEventWriter } from "./flow-events.js";
import { getProvider } from "./providers/index.js";
import type { RunStepFn } from "./providers/types.js";
import type { EventWriter, ProviderName, ProviderObservation, Step } from "./types.js";

export {
	beginMainCheckoutAttribution,
	blockForeignRootWrite,
	blockPlanPolish,
	blockWorktreeInstall,
	CLAUDE_CAPABILITIES,
	classifyClaudeTerminalText,
	claudeProvider,
	createClaudeRateLimitObservationDeduper,
	deriveClaudePoolId,
	endMainCheckoutAttribution,
	isClaudeMaxTurnsError,
	projectClaudeAssistantBlocks,
	projectClaudeRateLimitInfo,
} from "./providers/claude.js";
export { getProvider, REGISTERED_PROVIDERS } from "./providers/index.js";
export type { ForeignRootDenial, RunStepFn, RunStepOpts, StepProvider } from "./providers/types.js";
export { composeSystemAppend, createStepTextProjection, isWorktreePath } from "./step-runner-shared.js";

let standaloneEventWriter: EventWriter | undefined;

export function createProviderObservationHandler(options: {
	writer: EventWriter;
	provider: ProviderName;
	step: Step;
	model: string;
	itemId?: string;
	attempt?: number;
	log?: (message: string) => void;
}): (observation: ProviderObservation) => void {
	const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
	return (observation): void => {
		if (observation.provider !== options.provider) {
			log(`⚠ provider observation dropped: provider mismatch (${observation.provider} != ${options.provider})`);
			return;
		}
		appendProviderObservation(
			options.writer,
			{
				observation,
				...(options.itemId !== undefined ? { itemId: options.itemId } : {}),
				...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
				step: options.step,
				model: options.model,
			},
			log,
		);
	};
}

/**
 * The exported step runner is the dispatcher chokepoint: it resolves the per-step
 * `provider`, installs observation persistence, and delegates. Keeping the exported name
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
	const resolved = resolveStepSettings(CONFIG, opts.profile, name);
	const provider = opts.executionOverride?.provider ?? resolved.provider;
	const model = provider === "codex" ? (opts.executionOverride?.codexModel ?? resolved.codexModel ?? "default") : (opts.executionOverride?.model ?? modelForProvider(resolved, provider) ?? "default");
	let onProviderObservation = opts.onProviderObservation;
	if (!onProviderObservation) {
		if (!opts.eventWriter && !standaloneEventWriter) standaloneEventWriter = createEventWriter({ root: REPO });
		const writer = opts.eventWriter ?? standaloneEventWriter;
		if (!writer) throw new Error("provider observation writer initialization failed");
		onProviderObservation = createProviderObservationHandler({
			writer,
			provider,
			step: name,
			model,
			...(opts.itemId !== undefined ? { itemId: opts.itemId } : {}),
			...(opts.providerObservationAttempt !== undefined ? { attempt: opts.providerObservationAttempt } : {}),
			...(opts.providerObservationLog ? { log: opts.providerObservationLog } : {}),
		});
	}
	return getProvider(provider).runStep(name, prompt, { ...opts, onProviderObservation }, emit);
};
