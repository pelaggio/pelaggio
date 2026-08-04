import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Generic cross-process mutual exclusion over a single lock file path. Used to
 * serialize short critical sections across pelaggio processes on one host —
 * roadmap file mutations (`roadmap/mutation-lock.ts`) and MAIN_REPO
 * `node_modules` repair (`worktree-deps.ts`) under `--parallel`.
 *
 * Soundness (review-hardened; the #13 races and an earlier stat->rename TOCTOU
 * are all closed by the same primitive):
 * - acquire is a single O_EXCL write of `<expiresAt>:<token>` — expiry lives in
 *   the CONTENT, not mtime, so staleness is judged against the value the
 *   contender actually read (no cross-inode stat confusion, no fs-granularity
 *   dependence);
 * - both steal and release go through takeIfContent(): atomically rename the
 *   lock to a private grave, verify the grave holds exactly the content we
 *   decided on, and only then delete. Yanking a lock that changed hands mid-
 *   decision is detected and undone via an O_EXCL restore of the identical
 *   content (the rightful holder's token still compares equal at its release).
 * - Residual: a holder suspended longer than `staleMs` (laptop sleep, SIGSTOP)
 *   loses exclusion by definition — the deadline is the recovery contract. Size
 *   `staleMs` to worst-case holder work, not the mean.
 */

const BACKOFF_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Atomically remove the lock iff it still holds `expected`. Returns true when
 * we removed it. On mismatch (the lock changed hands between our read and the
 * rename) the yanked content is restored via O_EXCL so the rightful holder is
 * unharmed; if a new acquirer slipped into that microsecond window the restore
 * yields and the yanked holder simply fails its own token-compare later.
 */
function takeIfContent(path: string, expected: string): boolean {
	const grave = `${path}.grave-${randomBytes(4).toString("hex")}`;
	try {
		renameSync(path, grave);
	} catch {
		return false; // already gone — someone else resolved it
	}
	let got = "";
	try {
		got = readFileSync(grave, "utf-8");
	} catch {
		// unreadable grave — treat as not-ours and fall through to restore-or-drop
	}
	if (got === expected) {
		try {
			unlinkSync(grave);
		} catch {
			// grave left behind: content is dead, name is random — harmless
		}
		return true;
	}
	try {
		writeFileSync(path, got, { flag: "wx" }); // restore the wrongly-yanked lock
	} catch {
		// a new acquirer owns the path now — nothing to restore
	}
	try {
		unlinkSync(grave);
	} catch {
		// see above — harmless residue
	}
	return false;
}

/** Steal the lock iff the content we read has expired. */
function stealIfStale(path: string): void {
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch {
		return; // vanished — the holder released; just retry acquisition
	}
	const expiresAt = Number.parseInt(content, 10);
	if (Number.isFinite(expiresAt) && Date.now() < expiresAt) return; // live
	takeIfContent(path, content); // steal exactly what we judged stale
}

export interface FileLockOptions {
	/** Used in timeout error messages, e.g. "roadmap mutation lock". */
	label: string;
	/** How long a holder may run before its lock is considered orphaned. */
	staleMs: number;
	/** How long a waiter blocks before giving up (subject to the stale-steal extension below). */
	acquireTimeoutMs: number;
}

/**
 * Acquire the lock at `path`, run `fn`, then release. Blocks (with jittered
 * backoff) until the lock is free, stolen from a stale holder, or the timeout
 * is exhausted.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T> | T, opts: FileLockOptions): Promise<T> {
	const { label, staleMs, acquireTimeoutMs } = opts;
	mkdirSync(dirname(path), { recursive: true });
	const deadline = Date.now() + acquireTimeoutMs;
	// A waiter must be allowed to outlive an orphan's expiry or the steal path is
	// unreachable for early arrivals (deadline < staleness). The hard cap bounds
	// the extension so live-contention starvation still surfaces as a timeout.
	const hardCap = deadline + staleMs + 2_000;

	// Minted fresh on every attempt: the lease must date from ACQUISITION, not from
	// entry to the wait loop — a long wait would otherwise acquire an already-expired
	// lease that another process can immediately steal mid-critical-section.
	let token: string;
	for (;;) {
		token = `${Date.now() + staleMs}:${process.pid}-${randomBytes(8).toString("hex")}`;
		try {
			writeFileSync(path, token, { flag: "wx" }); // O_EXCL: acquire + identity + expiry in one syscall
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (Date.now() > deadline && Date.now() > hardCap) {
				throw new Error(`${label}: timed out waiting on ${path} — if no other process is holding it, delete the lock file`);
			}
			if (Date.now() > deadline) {
				// Past the soft deadline: only keep waiting if stealing the current
				// lock is still in prospect (its expiry is within the hard cap).
				let expiresAt = Number.NaN;
				try {
					expiresAt = Number.parseInt(readFileSync(path, "utf-8"), 10);
				} catch {
					// vanished — retry acquisition immediately
				}
				if (Number.isFinite(expiresAt) && expiresAt > hardCap) {
					throw new Error(`${label}: timed out after ${acquireTimeoutMs}ms waiting on ${path} — held live by another process`);
				}
			}
			stealIfStale(path);
			await sleep(BACKOFF_MS + Math.floor(Math.random() * BACKOFF_MS));
		}
	}

	try {
		return await fn();
	} finally {
		takeIfContent(path, token); // release iff still ours — never a thief's lock
	}
}

/**
 * Non-blocking acquire: one O_EXCL attempt (after stealing an expired holder), then either
 * run `fn` under the lock or report contention without waiting. Used by the per-worker
 * post-cycle review drain (#387), whose caller decides whether contention can safely skip or
 * must wait and re-list. Returns `{ ran: true, value }` when it held the lock, `{ ran: false }`
 * when a live holder owns it.
 */
export async function tryWithFileLock<T>(path: string, fn: () => Promise<T> | T, opts: { label: string; staleMs: number }): Promise<{ ran: true; value: T } | { ran: false }> {
	const { staleMs } = opts;
	mkdirSync(dirname(path), { recursive: true });
	const token = `${Date.now() + staleMs}:${process.pid}-${randomBytes(8).toString("hex")}`;
	for (const attempt of [0, 1]) {
		try {
			writeFileSync(path, token, { flag: "wx" }); // O_EXCL: acquire + identity + expiry
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (attempt === 0) {
				stealIfStale(path); // reclaim an orphaned (crashed-holder) lock, then retry once
				continue;
			}
			return { ran: false }; // live contention — a peer holds the lock
		}
		try {
			return { ran: true, value: await fn() };
		} finally {
			takeIfContent(path, token); // release iff still ours
		}
	}
	return { ran: false };
}
