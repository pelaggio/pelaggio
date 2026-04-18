/**
 * Public library surface for `@cdhorne/claude-autopilot`.
 *
 * Consumers running under `tsx` can `import { run, loadConfig } from "@cdhorne/claude-autopilot"`.
 * Plain Node / bundler consumers need a `.ts` loader until TOOL-18 adds a build step.
 */

export { loadConfig } from "./config.js";
export { orchestrate as run } from "./pipeline.js";
export { runStatsCommand } from "./stats.js";
export type { CycleResult, Flags, PipelineOpts, Step } from "./types.js";
