/**
 * Pipeline step names — the source of truth for `STEPS`. Adding a step requires updating every
 * step-indexed config map in `config.ts` (see AGENTS.md). Lives below `config.ts` and `types.ts`
 * so neither has to import the other for the `Step` union.
 */
export const STEPS = ["pick", "plan", "shakedown-plan", "implement", "shakedown-code", "ship"] as const;
export type PipelineStep = (typeof STEPS)[number];
/** Pipeline steps + non-pipeline actions. These carry per-step config but are absent from `STEPS`. */
export type Step = PipelineStep | "shipwreck" | "pr-review" | "pr-verify";

/** Type guard for a valid pipeline step. Excludes all non-pipeline actions — see `--from` validation in pipeline.ts. */
export function isPipelineStep(s: string): s is PipelineStep {
	return (STEPS as readonly string[]).includes(s);
}

/** Every step that carries per-step config: pipeline steps + non-pipeline actions. */
export const ALL_STEPS: readonly Step[] = [...STEPS, "shipwreck", "pr-review", "pr-verify"];
