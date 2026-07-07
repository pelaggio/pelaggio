import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Serializes mutations of shared roadmap files (docs/roadmap-*.md, task-index.md)
 * across processes on one host. Taken INTERNALLY by MarkdownRoadmap.markDone /
 * createItem / archivePlan and by commitStrayBookkeeping — callers never manage
 * it, so every shared-file write path is covered by construction.
 *
 * Claims are deliberately NOT tracked here (issue #12): "claimed" is git-native —
 * the feat/<id> branch exists — so there is no claims file, no owner pids, and no
 * staleness lifecycle to corrupt. This lock only makes the short
 * read-modify-write-commit sections atomic with respect to each other.
 *
 * Soundness (review-hardened; the #13 races and this file's first draft's
 * stat→rename TOCTOU are all closed by the same primitive):
 * - acquire is a single O_EXCL write of `<expiresAt>:<token>` — expiry lives in
 *   the CONTENT, not mtime, so staleness is judged against the value the
 *   contender actually read (no cross-inode stat confusion, no fs-granularity
 *   dependence);
 * - both steal and release go through takeIfContent(): atomically rename the
 *   lock to a private grave, verify the grave holds exactly the content we
 *   decided on, and only then delete. Yanking a lock that changed hands mid-
 *   decision is detected and undone via an O_EXCL restore of the identical
 *   content (the rightful holder's token still compares equal at its release).
 * - Residual: a holder suspended longer than STALE_MS (laptop sleep, SIGSTOP)
 *   loses exclusion by definition — the deadline is the recovery contract. Size
 *   STALE_MS to worst-case holder work (git commit on drvfs/NFS), not the mean.
 */

const LOCK_FILE = "roadmap-mutation.lock";
// Holders do file edits + one git commit — usually sub-second, but 2 minutes
// covers cold-cache git on slow filesystems (WSL2 drvfs). Env overrides for tests.
const STALE_MS = Number(process.env.AUTOPILOT_LOCK_STALE_MS) || 120_000;
const ACQUIRE_TIMEOUT_MS = Number(process.env.AUTOPILOT_LOCK_TIMEOUT_MS) || 30_000;
const BACKOFF_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lockPath(repo: string): string {
	const dir = resolve(repo, ".dev");
	mkdirSync(dir, { recursive: true });
	return resolve(dir, LOCK_FILE);
}

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

export async function withMutationLock<T>(repo: string, fn: () => Promise<T> | T): Promise<T> {
	const path = lockPath(repo);
	const token = `${Date.now() + STALE_MS}:${process.pid}-${randomBytes(8).toString("hex")}`;
	const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
	// A waiter must be allowed to outlive an orphan's expiry or the steal path is
	// unreachable for early arrivals (deadline < staleness). The hard cap bounds
	// the extension so live-contention starvation still surfaces as a timeout.
	const hardCap = deadline + STALE_MS + 2_000;

	for (;;) {
		try {
			writeFileSync(path, token, { flag: "wx" }); // O_EXCL: acquire + identity + expiry in one syscall
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (Date.now() > deadline && Date.now() > hardCap) {
				throw new Error(`roadmap mutation lock: timed out waiting on ${path} — if no other autopilot/roadmap process is running, delete the lock file`);
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
					throw new Error(`roadmap mutation lock: timed out after ${ACQUIRE_TIMEOUT_MS}ms waiting on ${path} — held live by another process`);
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
