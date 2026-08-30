import { withFileLock } from "../file-lock.js";
import { type RegisterName, registerPath } from "../registers.js";

/**
 * Serializes mutations of shared roadmap files across processes on one host.
 * Taken INTERNALLY by MarkdownRoadmap.markDone / createItem / archivePlan and by
 * commitStrayBookkeeping — callers never manage it, so every shared-file write
 * path is covered by construction.
 *
 * Decision hot-path writes do not use this roadmap lock: their per-item authority
 * lives under `docs/decision-log/`. Cold maintenance and operator resolution may
 * reuse the primitive, scoped to the checkout they mutate, for local RMW safety.
 *
 * Claims are deliberately NOT tracked here (issue #12): "claimed" is git-native —
 * the feat/<id> branch exists — so there is no claims file, no owner pids, and no
 * staleness lifecycle to corrupt. This lock only makes the short
 * read-modify-write-commit sections atomic with respect to each other.
 *
 * The generic locking primitive (O_EXCL acquire, content-addressed steal/
 * release) lives in `../file-lock.ts`, shared with `repairMainNodeModules`'s
 * node_modules-repair lock. This module only owns the roadmap-specific lock
 * path and timing envelope.
 */

const LOCK_FILE: RegisterName = "roadmap-mutation.lock";
// Holders do file edits + one git commit — usually sub-second, but 2 minutes
// covers cold-cache git on slow filesystems (WSL2 drvfs). Env overrides for tests.
const STALE_MS = Number(process.env.AUTOPILOT_LOCK_STALE_MS) || 120_000;
const ACQUIRE_TIMEOUT_MS = Number(process.env.AUTOPILOT_LOCK_TIMEOUT_MS) || 30_000;

function lockPath(repo: string): string {
	return registerPath(repo, LOCK_FILE);
}

export function withMutationLock<T>(repo: string, fn: () => Promise<T> | T): Promise<T> {
	return withFileLock(lockPath(repo), fn, { label: "roadmap mutation lock", staleMs: STALE_MS, acquireTimeoutMs: ACQUIRE_TIMEOUT_MS });
}
