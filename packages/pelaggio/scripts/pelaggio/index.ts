/**
 * Public library surface for `pelaggio`.
 *
 * Consumers running under `tsx` can `import { run, loadConfig } from "pelaggio"`.
 * The package ships `.ts` source; plain Node / bundler consumers need a `.ts` loader.
 */

export { loadConfig, logPathFor } from "./config.js";
export type { AppendDecisionsInput, DecisionAppendInput, DecisionWriteResult, MigrateDecisionsResult, RebuildIndexResult } from "./decisions.js";
export {
	appendDecisions,
	archiveResolvedDecisions,
	contentFingerprint,
	emitDecisionsFromText,
	migrateDecisions,
	rebuildDecisionIndex,
	resolveDecision,
} from "./decisions.js";
export type { CreateEventWriterOptions, ReadEventLogOptions } from "./flow-events.js";
export {
	createEventWriter,
	decodeFlowEvent,
	decodeFlowEventLine,
	eventStreamPath,
	flowEventsDir,
	foldEvents,
	MAX_EVENT_DIAGNOSTIC_DETAILS,
	MAX_FLOW_EVENT_BYTES,
	PELAGGIO_EVENT_TYPE_SET,
	PELAGGIO_EVENT_TYPES,
	projectEvents,
	readEventLog,
} from "./flow-events.js";
export type { FlowCandidate, FlowDependency, FlowEligibleCandidate, FlowEvaluation, FlowItemVerdict, FlowPolicy, FlowReadiness, FlowSnapshot, FlowVerdictReason, QuickScopeInput } from "./flow-policy.js";
export { DEFAULT_FLOW_POLICY, FifoPolicy } from "./flow-policy.js";
export { orchestrate as run } from "./orchestrator.js";
export { REGISTERS, type RegisterName, registerPath, registerRelativePath } from "./registers.js";
export type { RoadmapItem, RoadmapSource, RoadmapSourceName, Scope } from "./roadmap/index.js";
export { getRoadmapSource } from "./roadmap/index.js";
export type { Stats } from "./stats.js";
export { computeStats, runStatsCommand } from "./stats.js";
export type {
	CoreFlowEvent,
	CycleCompletedEvent,
	CycleResult,
	Decision,
	EmittedDecision,
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
	RunFinishedEvent,
	RunHeartbeatEvent,
	RunStartedEvent,
	ShipTargetName,
	Step,
} from "./types.js";
