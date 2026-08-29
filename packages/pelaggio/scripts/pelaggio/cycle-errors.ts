/** Closed set of recoverable cycle error classifications (L0 runtime constant; `types.ts` stays type-only). */
/**
 * Cycle `error` strings that are recoverable / informational — a worker keeps pulling
 * subsequent cycles instead of halting, and (per `notify.ts`) they never page a human.
 * Single-sourced here so the orchestrator's `RECOVERABLE` set and the notification
 * classifier can't drift apart.
 *
 * `parked` belongs to the set but is classified first in `classifyEvent`. The fatal pick
 * errors (`pick:unknown-id`, `pick:blocked`) are intentionally absent: a typo'd `--item`
 * or a user-requested blocked item should halt loudly and page.
 */
export const RECOVERABLE_ERRORS = ["plan needs rethink", "parked", "transient sdk error", "pick:queue-empty", "pick:worktree-exists", "pick:already-claimed", "pick:already-done", "pick:stale-quarantined", "pick:unknown"] as const;
