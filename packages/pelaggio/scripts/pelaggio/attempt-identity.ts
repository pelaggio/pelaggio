import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Attempt identity (#467 / ADR-0026 decision 10, property 1).
 *
 * A cycle's `runId` is derived from its cycle number, and a resume recomputes that number
 * from scratch — `cycle: results.length + i + 1` is 1 for a fresh `--resume`, exactly as it
 * was for the attempt being resumed. Every artifact keyed by runId therefore collides with
 * its own superseded predecessor; the execution-receipt layer catches it and fails closed
 * with `receipt_failed: already exists with different content` (#451, and 2 of the 5 most
 * recent cycle failures at the time of writing).
 *
 * This module supplies the missing term: a monotonic per-item attempt sequence, allocated
 * atomically, that runIds are salted with so a superseded attempt's artifacts are merely
 * *stale* rather than *conflicting*.
 *
 * Allocation is an O_EXCL create of `<attempts>/<item>/<n>` for ascending n — the same
 * primitive `file-lock.ts` acquires with, and for the same reason: it is the one filesystem
 * operation that is atomic across processes without a lock. Two concurrent allocators
 * cannot receive the same n; the loser's create fails EEXIST and it advances.
 *
 * SCOPE, stated because the ADR is stricter than this module: decision 10 requires three
 * properties, and this delivers only the first.
 *  1. Atomic allocation — here.
 *  2. An agent-INACCESSIBLE authoritative register with anti-rollback freshness — NOT here.
 *     These records live under `MAIN_REPO/.dev/`, which `blockForeignRootWrite` protects
 *     from worktree steps but not from a main-cwd step or an opaque Bash command.
 *  3. Consumer-side fencing at the authority — NOT here.
 * So this closes the *collision* (a correctness bug that fails closed today) and does not
 * yet close *forgery* (a trust boundary). An agent that rewrites these records can still
 * cause a superseded attempt to be treated as current; that is properties 2-3, and until
 * they land the attempt number is an identity, never an authorization.
 */

const ATTEMPTS_DIR = "attempts";
/**
 * Monotonic high-water marks: a directory of empty files named for each value ever
 * allocated, created with O_EXCL and never rewritten.
 *
 * Scanning the records alone is not enough: deleting the HIGHEST record makes the scan
 * report the preceding value, and the next allocation then re-creates the deleted number —
 * regenerating the superseded runId and re-opening the very collision this module exists to
 * close. Records are deletable in practice (a `/tidy` sweep, a stray `rm -rf .dev`), so the
 * allocator must not depend on the record set being complete.
 *
 * A single mutable file cannot carry this: read-then-write is a lost update, so two
 * allocators interleaving (A reads 0, B writes 2, A writes 1) LOWER the mark, and a
 * subsequent prune of the highest record then reissues that number — the collision this
 * module exists to close. Create-only markers cannot regress, because nothing is ever
 * overwritten; the maximum of a set that only grows is monotonic by construction.
 *
 * Losing the marker directory degrades to scan-only behaviour, which is the pre-existing
 * weakness rather than a new one — and one more reason properties 2-3 in the header matter.
 */
const HIGH_WATER_DIR = ".high-water";
/** Bounds the ascending-n scan; far above any plausible resume count for one item. */
const MAX_ATTEMPT = 10_000;
const SAFE_ID = /[^a-z0-9._-]+/gi;

/** Directory holding attempt records for an already-resolved main repo. */
export function attemptsDir(mainRepo: string): string {
	return resolve(mainRepo, ".dev", ATTEMPTS_DIR);
}

/**
 * Item ids reach us from roadmap adapters and appear in a path, so they are constrained
 * rather than trusted: anything outside `[a-z0-9._-]` collapses to `-`, and a leading dot
 * cannot survive, so no id can traverse out of the attempts directory.
 */
function itemSlug(itemId: string): string {
	const slug = itemId
		.toLowerCase()
		.replace(SAFE_ID, "-")
		.replace(/^[.-]+/, "");
	return slug.length > 0 ? slug : "unknown";
}

function itemDir(mainRepo: string, itemId: string): string {
	return join(attemptsDir(mainRepo), itemSlug(itemId));
}

/**
 * Allocate the next attempt number for `itemId`. Monotonic per item, never reused, and
 * safe against concurrent allocators (O_EXCL decides the winner).
 *
 * Returns 1 for an item's first attempt, so a runId that has never been resumed keeps the
 * shape it has today with `-a1` appended.
 */
export function allocateAttempt(mainRepo: string, itemId: string): number {
	const dir = itemDir(mainRepo, itemId);
	const marks = ensureMarksDir(dir);
	// Start the scan from what is already there so a long-resumed item does not re-walk
	// every prior attempt; correctness does not depend on the hint being fresh, because a
	// racing allocator only makes our create fail and we advance.
	// Take the greater of the scanned maximum and the high-water mark, so a deleted record
	// (including the highest) can never cause a number to be handed out twice.
	let next = Math.max(scanMaxAttempt(dir), readHighWater(dir)) + 1;
	for (; next <= MAX_ATTEMPT; next++) {
		try {
			// The MARKER is the allocation, and it is written first. Creating the informational
			// record first and marking afterwards would leave a window where a crash (or a
			// swallowed marker-write failure) yields a number with no durable trace, which a
			// later prune of the record turns back into a reissue. O_EXCL both decides the
			// race and makes the allocation durable in one syscall; any error other than
			// EEXIST propagates rather than returning an unprotected number.
			writeFileSync(join(marks, String(next)), "", { flag: "wx", mode: 0o600 });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; // fail closed
			continue; // lost the race for this n — advance and retry
		}
		// Informational metadata, deliberately best-effort and deliberately second: losing it
		// costs a debugging aid, never the no-reuse guarantee.
		try {
			writeFileSync(join(dir, `${next}.json`), `${JSON.stringify({ schemaVersion: 1, itemId, attempt: next }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		} catch {
			// already present, or unwritable — the marker above is what matters
		}
		return next;
	}
	throw new Error(`attempt-identity: exhausted ${MAX_ATTEMPT} attempts for item ${itemId} under ${dir}`);
}

/** Highest numbered record present in `dir`, ignoring anything else living there. */
function scanMaxAttempt(dir: string): number {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0; // never attempted — not an error
	}
	let max = 0;
	for (const name of names) {
		const m = name.match(/^(\d+)\.json$/);
		if (!m?.[1]) continue;
		const n = Number.parseInt(m[1], 10);
		if (Number.isFinite(n) && n > max) max = n;
	}
	return max;
}

/**
 * Create the marker directory, migrating a legacy single-file mark if one is present.
 *
 * An intermediate version of this module wrote `.high-water` as a FILE holding the maximum.
 * `mkdirSync(..., { recursive: true })` does not tolerate a file at the target — it throws
 * EEXIST — so without this, any checkout carrying the old shape fails every allocation.
 * The legacy value is preserved as a marker before the file is removed, so migrating cannot
 * lower the mark.
 */
function ensureMarksDir(dir: string): string {
	const marks = join(dir, HIGH_WATER_DIR);
	try {
		if (statSync(marks).isFile()) {
			const legacy = Number.parseInt(readFileSync(marks, "utf-8").trim(), 10);
			rmSync(marks, { force: true });
			mkdirSync(marks, { recursive: true });
			if (Number.isFinite(legacy) && legacy > 0) {
				try {
					writeFileSync(join(marks, String(legacy)), "", { flag: "wx", mode: 0o600 });
				} catch {
					// already marked — nothing to preserve
				}
			}
			return marks;
		}
	} catch {
		// absent, or unreadable — fall through to the normal create
	}
	mkdirSync(marks, { recursive: true });
	return marks;
}

function readHighWater(dir: string): number {
	let names: string[];
	try {
		names = readdirSync(join(dir, HIGH_WATER_DIR));
	} catch {
		return 0; // absent — fall back to the scan
	}
	let max = 0;
	for (const name of names) {
		const n = Number.parseInt(name, 10);
		if (Number.isFinite(n) && n > max) max = n;
	}
	return max;
}

/**
 * Highest attempt allocated for `itemId`, or 0 when the item has never been attempted.
 * Reads the high-water mark as well as the records, so a pruned record does not make an
 * item look less-attempted than it is.
 */
export function currentAttempt(mainRepo: string, itemId: string): number {
	const dir = itemDir(mainRepo, itemId);
	return Math.max(scanMaxAttempt(dir), readHighWater(dir));
}

/**
 * The attempt-scoped run identifier. Kept in one place so every artifact keyed by runId —
 * execution receipts, effects manifests, review records, session ids — moves together;
 * salting only some of them would leave the collision open on the rest.
 */
export function attemptRunId(runIdBase: string, itemId: string, attempt: number): string {
	return `${runIdBase}-${itemId}-a${attempt}`;
}
