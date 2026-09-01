/**
 * Public library surface for `pelaggio`.
 *
 * Consumers running under `tsx` can `import { run, loadConfig } from "pelaggio"`.
 * The package ships `.ts` source; plain Node / bundler consumers need a `.ts` loader.
 */

export { loadConfig, logPathFor } from "./config.js";
export { decodeCycleOutcome } from "./cycle-outcome.js";
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
export type { CreateEventWriterOptions, EventStreamSlice, EventStreamTail, ReadEventLogOptions, ReadEventStreamSlice } from "./flow-events.js";
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
	readEventStreamSlice,
	tailEventStream,
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
	BlockedKind,
	ClassificationProvenance,
	CoreFlowEvent,
	CycleCompletedEvent,
	CycleLogEntry,
	CycleOutcome,
	CycleResult,
	Decision,
	EmittedDecision,
	EventLogDiagnostic,
	EventLogDiagnosticKind,
	EventLogDiagnostics,
	EventWriter,
	FailureClass,
	Flags,
	FlowEvent,
	FlowEventEnvelope,
	FlowEventInput,
	FlowEventProjection,
	LegacyCycleCompletedEvent,
	ParkClass,
	PelaggioEventType,
	PipelineOpts,
	PreUnionCycleLogEntry,
	RawCycleLogRecord,
	ReadEventLogResult,
	RunFinishedEvent,
	RunHeartbeatEvent,
	RunStartedEvent,
	ShipTargetName,
	Step,
} from "./types.js";
