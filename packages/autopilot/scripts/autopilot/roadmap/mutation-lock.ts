import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Serializes mutations of shared roadmap files (docs/roadmap-*.md, task-index.md)
 * across processes on one host. Taken INTERNALLY by MarkdownRoadmap.markDone /
 * createItem / archivePlan — callers (CLI, ship bookkeeping tail, skills) never
 * manage it, so every present and future write path is covered by construction.
 *
 * Claims are deliberately NOT tracked here (issue #12): "claimed" is git-native —
 * the feat/<id> branch exists — so there is no claims file, no owner pids, and no
 * staleness lifecycle to corrupt. This lock only makes the sub-second
 * read-modify-write-commit sections atomic with respect to each other.
 *
 * Soundness over the #13 directory-mutex (all three races were reproduced):
 * - acquire is a single O_EXCL write of a per-acquisition token — no separate
 *   owner file, so there is no "acquired but metadata-less" window;
 * - a stale lock is stolen via atomic rename: exactly one contender wins the
 *   rename and retries acquisition; losers see ENOENT and just loop;
 * - release compares the token before deleting, so a holder that overran the
 *   TTL and was stolen from cannot remove the thief's live lock.
 */

const LOCK_FILE = "roadmap-mutation.lock";
// Holders do sub-second file edits + one git commit; 60s of lock age means the
// holder is gone (killed mid-commit), not slow. Env overrides exist for tests.
const STALE_MS = Number(process.env.AUTOPILOT_LOCK_STALE_MS) || 60_000;
const ACQUIRE_TIMEOUT_MS = Number(process.env.AUTOPILOT_LOCK_TIMEOUT_MS) || 30_000;
const BACKOFF_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lockPath(repo: string): string {
	const dir = resolve(repo, ".dev");
	mkdirSync(dir, { recursive: true });
	return resolve(dir, LOCK_FILE);
}

/** Steal a stale lock atomically; returns without caring who won (the loop re-tries acquisition either way). */
function stealIfStale(path: string): void {
	let age: number;
	try {
		age = Date.now() - statSync(path).mtimeMs;
	} catch {
		return; // vanished — the holder released; just retry acquisition
	}
	if (age < STALE_MS) return;
	const grave = `${path}.stale-${randomBytes(4).toString("hex")}`;
	try {
		renameSync(path, grave); // atomic: exactly one contender wins
		unlinkSync(grave);
	} catch {
		// lost the steal race (ENOENT) — another contender owns the retry now
	}
}

export async function withMutationLock<T>(repo: string, fn: () => Promise<T> | T): Promise<T> {
	const path = lockPath(repo);
	const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
	const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

	for (;;) {
		try {
			writeFileSync(path, token, { flag: "wx" }); // O_EXCL: acquire + identity in one syscall
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (Date.now() > deadline) {
				throw new Error(`roadmap mutation lock: timed out after ${ACQUIRE_TIMEOUT_MS}ms waiting on ${path} — if no other autopilot/roadmap process is running, delete the lock file`);
			}
			stealIfStale(path);
			await sleep(BACKOFF_MS + Math.floor(Math.random() * BACKOFF_MS));
		}
	}

	try {
		return await fn();
	} finally {
		try {
			if (readFileSync(path, "utf-8") === token) unlinkSync(path);
			// else: we overran STALE_MS and were stolen from — the lock now belongs
			// to another holder; deleting it would cascade the #13 release bug.
		} catch {
			// already gone — nothing to release
		}
	}
}
