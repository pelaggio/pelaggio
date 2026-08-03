import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Daemon state-path exclusivity is a PID-liveness lock for an indefinite
 * holder. It deliberately does **not** use `file-lock.ts` /
 * `roadmap/mutation-lock.ts`: those permit expiry-based steal of a still-live
 * holder, which would let a second daemon take over a healthy instance's
 * `state.json`.
 *
 * Wire format (single line, UTF-8): `${pid}:${token}`
 * - pid — decimal positive integer
 * - token — randomBytes(8).toString("hex") for content-addressed release
 */

const MAX_RECLAIM_ATTEMPTS = 8;

export interface StatePathLock {
	readonly lockPath: string;
	/** Idempotent. Removes the lock only if content still matches our claim. */
	release(): void;
}

/**
 * Claim exclusive ownership of `statePath` via `${statePath}.lock`.
 * Throws if a foreign live PID already holds the lock, or if the lock
 * content is unreadable/malformed.
 */
export function acquireStatePathLock(statePath: string): StatePathLock {
	mkdirSync(dirname(statePath), { recursive: true });
	const lockPath = `${statePath}.lock`;
	const claim = `${process.pid}:${randomBytes(8).toString("hex")}`;

	for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt++) {
		try {
			writeFileSync(lockPath, claim, { flag: "wx" });
			return makeLock(lockPath, claim);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}

		let existing: string;
		try {
			existing = readFileSync(lockPath, "utf-8");
		} catch (err) {
			const e = err as NodeJS.ErrnoException;
			if (e.code === "ENOENT") continue; // vanished — retry O_EXCL
			throw new Error(`state path lock unreadable at ${lockPath}: ${e.message} — inspect or remove the file before starting the daemon`);
		}

		const parsed = parseLockContent(existing);
		if (parsed === null) {
			throw new Error(`state path lock malformed at ${lockPath} (expected "pid:token"): inspect or remove the file before starting the daemon`);
		}

		// Self-PID residue is reclaimable: after a crash the OS may recycle our
		// PID onto the new daemon; refusing would soft-brick restarts. A true
		// second instance cannot share process.pid.
		if (parsed.pid !== process.pid && isPidAlive(parsed.pid)) {
			throw new Error(`state path already held by pid ${parsed.pid}: ${statePath} (lock: ${lockPath})`);
		}

		// Dead (or self-PID) owner: content-addressed reclaim, then retry O_EXCL.
		takeIfContent(lockPath, existing);
	}

	throw new Error(`state path lock: failed to acquire ${lockPath} after ${MAX_RECLAIM_ATTEMPTS} reclaim attempts — inspect or remove the file before starting the daemon`);
}

function makeLock(lockPath: string, claim: string): StatePathLock {
	let released = false;
	return {
		lockPath,
		release(): void {
			if (released) return;
			released = true;
			takeIfContent(lockPath, claim);
		},
	};
}

/**
 * Parse `${pid}:${token}`. Returns null on malformed input (fail closed).
 */
function parseLockContent(content: string): { pid: number; token: string } | null {
	const trimmed = content.trim();
	const colon = trimmed.indexOf(":");
	if (colon <= 0) return null;
	const pidStr = trimmed.slice(0, colon);
	const token = trimmed.slice(colon + 1);
	if (token.length === 0) return null;
	// Reject non-decimal / leading zeros ambiguity by requiring strict integer form.
	if (!/^\d+$/.test(pidStr)) return null;
	const pid = Number(pidStr);
	if (!Number.isInteger(pid) || pid <= 0) return null;
	return { pid, token };
}

/** Liveness probe matching supervisor.ts isPidAlive (local copy — no module coupling). */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		// EPERM means the process exists but we can't signal it — still alive.
		return e.code === "EPERM";
	}
}

/**
 * Atomically remove the lock iff it still holds `expected`. Mirrors
 * file-lock.ts takeIfContent — rename to a private grave, verify content,
 * then unlink. On mismatch restore via O_EXCL so a new owner is unharmed.
 */
function takeIfContent(path: string, expected: string): boolean {
	const grave = `${path}.grave-${randomBytes(4).toString("hex")}`;
	try {
		renameSync(path, grave);
	} catch {
		return false; // already gone
	}
	let got = "";
	try {
		got = readFileSync(grave, "utf-8");
	} catch {
		// unreadable grave — treat as not-ours
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
		// harmless residue
	}
	return false;
}
