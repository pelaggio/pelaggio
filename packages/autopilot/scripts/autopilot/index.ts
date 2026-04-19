/**
 * Public library surface for `@cdhorne/claude-autopilot`.
 *
 * Consumers running under `tsx` can `import { run, loadConfig } from "@cdhorne/claude-autopilot"`.
 * The package ships `.ts` source; plain Node / bundler consumers need a `.ts` loader.
 */

export { loadConfig } from "./config.js";
export { orchestrate as run } from "./pipeline.js";
export type { RoadmapItem, RoadmapSource, RoadmapSourceName } from "./roadmap/index.js";
export { getRoadmapSource } from "./roadmap/index.js";
export type { Stats } from "./stats.js";
export { computeStats, runStatsCommand } from "./stats.js";
export type { CycleResult, Flags, PipelineOpts, ShipTargetName, Step } from "./types.js";
