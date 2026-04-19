/**
 * Public library surface for `@cdhorne/claude-autopilot`.
 *
 * Consumers running under `tsx` can `import { run, loadConfig } from "@cdhorne/claude-autopilot"`.
 * The package ships `.ts` source; plain Node / bundler consumers need a `.ts` loader.
 */

export { loadConfig } from "./config.js";
export { orchestrate as run } from "./pipeline.js";
export { runStatsCommand } from "./stats.js";
export type { CycleResult, Flags, PipelineOpts, Step } from "./types.js";
