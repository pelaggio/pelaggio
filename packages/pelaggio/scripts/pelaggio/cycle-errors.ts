import type { BlockedKind, CycleOutcome, FailureClass, ParkClass } from "./types.js";

export const FAILURE_CLASS_COVERAGE = {
	selection: true,
	provider: true,
	budget: true,
	"turn-limit": true,
	refusal: true,
	confinement: true,
	effects: true,
	verification: true,
	delivery: true,
	aborted: true,
	unclassified: true,
} as const satisfies Record<FailureClass, true>;
export const FAILURE_CLASSES = Object.keys(FAILURE_CLASS_COVERAGE) as FailureClass[];
export const FAILURE_CLASS_SET: ReadonlySet<string> = new Set(FAILURE_CLASSES);

export const NAMED_BLOCKED_KIND_COVERAGE = {
	"spec-defect": true,
	prerequisite: true,
	capability: true,
	environment: true,
	"charter-defect": true,
} as const satisfies Record<Exclude<BlockedKind, "unclassified">, true>;
export const NAMED_BLOCKED_KINDS = Object.keys(NAMED_BLOCKED_KIND_COVERAGE) as Exclude<BlockedKind, "unclassified">[];
export const BLOCKED_KIND_COVERAGE = { ...NAMED_BLOCKED_KIND_COVERAGE, unclassified: true } as const satisfies Record<BlockedKind, true>;
export const BLOCKED_KINDS = Object.keys(BLOCKED_KIND_COVERAGE) as BlockedKind[];
export const BLOCKED_KIND_SET: ReadonlySet<string> = new Set(BLOCKED_KINDS);

export const PARK_CLASS_COVERAGE = {
	"rate-limit": true,
	paused: true,
	"sdk-outage": true,
	"review-escalation": true,
	"review-blocked": true,
	"review-binding": true,
	"effects-failed": true,
	unclassified: true,
} as const satisfies Record<ParkClass, true>;
export const PARK_CLASSES = Object.keys(PARK_CLASS_COVERAGE) as ParkClass[];
export const PARK_CLASS_SET: ReadonlySet<string> = new Set(PARK_CLASSES);

export const CYCLE_OUTCOME_COVERAGE = { completed: true, parked: true, blocked: true, failed: true } as const satisfies Record<CycleOutcome["outcome"], true>;
export const CYCLE_OUTCOMES = Object.keys(CYCLE_OUTCOME_COVERAGE) as CycleOutcome["outcome"][];
export const CYCLE_OUTCOME_SET: ReadonlySet<string> = new Set(CYCLE_OUTCOMES);

/**
 * L0 runtime constant — lives here rather than in `types.ts` so that file stays type-only.
 *
 * Cycle `error` strings that are recoverable / informational — a worker keeps pulling
 * subsequent cycles instead of halting, and (per `notify.ts`) they never page a human.
 * Single-sourced here so the orchestrator's `RECOVERABLE` set and the notification
 * classifier can't drift apart.
 *
 * Parked cycles use the outcome discriminant and never enter this failed-error set. The fatal pick
 * errors (`pick:unknown-id`, `pick:blocked`) are intentionally absent: a typo'd `--item`
 * or a user-requested blocked item should halt loudly and page.
 */
export const RECOVERABLE_ERRORS = ["plan needs rethink", "transient sdk error", "pick:queue-empty", "pick:worktree-exists", "pick:already-claimed", "pick:already-done", "pick:stale-quarantined", "pick:unknown"] as const;
