/**
 * Public library surface for `pelaggio`.
 *
 * Consumers running under `tsx` can `import { run, loadConfig } from "pelaggio"`.
 * The package ships `.ts` source; plain Node / bundler consumers need a `.ts` loader.
 */

export { loadConfig } from "./config.js";
export type { CreateEventWriterOptions, ReadEventLogOptions } from "./flow-events.js";
export { createEventWriter, foldEvents, MAX_EVENT_DIAGNOSTIC_DETAILS, MAX_FLOW_EVENT_BYTES, PELAGGIO_EVENT_TYPE_SET, PELAGGIO_EVENT_TYPES, projectEvents, readEventLog } from "./flow-events.js";
export { orchestrate as run } from "./pipeline.js";
export type { RoadmapItem, RoadmapSource, RoadmapSourceName } from "./roadmap/index.js";
export { getRoadmapSource } from "./roadmap/index.js";
export type { Stats } from "./stats.js";
export { computeStats, runStatsCommand } from "./stats.js";
export type {
	CoreFlowEvent,
	CycleCompletedEvent,
	CycleResult,
	EventLogDiagnostic,
	EventLogDiagnosticKind,
	EventLogDiagnostics,
	EventWriter,
	Flags,
	FlowEvent,
	FlowEventEnvelope,
	FlowEventInput,
	FlowEventProjection,
	LegacyCycleCompletedEvent,
	PelaggioEventType,
	PipelineOpts,
	ReadEventLogResult,
	ShipTargetName,
	Step,
} from "./types.js";
