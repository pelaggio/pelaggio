/**
 * Mid-run review-request queue (#387). A harness-owned, main-tree queue of PRs that
 * a ship-tail enqueued for the trusted local review runner to post the required
 * `review` commit status. The trusted main-tree reconciler in `pipeline.ts` is the
 * SOLE executor — it drains this queue and runs `runPrReviewGate` + `postReviewStatus`
 * from local main (never from the PR-branch worktree).
 *
 * The store lives under `MAIN_REPO/.dev/review-requests/` (gitignored). Callers resolve
 * the main worktree via `mainWorktree()` before writing so a ship worktree's enqueue lands
 * in the checkout holding `refs/heads/main`, not the invisible worktree-local `.dev/`
 * (same redirect precedent as `stale-quarantine.ts` / the decisions register). These are
 * harness-internal `fs` writes, not agent tool I/O, so they neither trip nor bypass the
 * worktree write-guard.
 *
 * Idempotency key is `(prNumber, headSha)`: one file `{pr}-{sha}.json` per key. A new push
 * (new SHA) is a new file; re-enqueue of the same key is a no-op. Crash protocol: a pending
 * `.json` is atomically renamed to `.claimed` while a drain runs it, renamed back on a
 * rate-limit park, and unlinked on terminal status. An abandoned `.claimed` (crashed drain)
 * is reclaimed to pending after `REVIEW_CLAIM_STALE_MS`. Record completion always requires a
 * POSITIVE terminal check (see `pipeline.ts`) — never "absent from the forge listing".
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ReviewRequestRecord {
	schemaVersion: 1;
	prNumber: number;
	/** Full head OID at ship time — the exact SHA the review status is posted against. */
	headSha: string;
	itemId: string;
	headBranch: string;
	/** ISO timestamp; drives stable FIFO drain order. */
	enqueuedAt: string;
}

/** Enqueue input — the record without its constant `schemaVersion`. */
export type NewReviewRequest = Omit<ReviewRequestRecord, "schemaVersion">;

export interface ListedReviewRequest {
	record: ReviewRequestRecord;
	/** Absolute path of the pending `.json` file this record was read from. */
	path: string;
}

/**
 * Stale window for an abandoned `.claimed` file (a drain that crashed mid-review). Matched
 * to the order of magnitude of the session-expiry lease; reclaim only runs at drain start
 * under the exclusive drain lock, so it can never disturb an actively-running review.
 */
export const REVIEW_CLAIM_STALE_MS = 4 * 60 * 60 * 1000;

/** One drain/adjudication critical section may include a full provider review. */
export const REVIEW_DRAIN_LOCK_STALE_MS = 4 * 60 * 60 * 1000;

const QUEUE_DIR = "review-requests";
const DRAIN_LOCK = ".drain.lock";
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const PENDING_RE = /^(\d+)-([0-9a-f]{7,40})\.json$/i;
const CLAIMED_SUFFIX = ".claimed";

/** Directory holding the review-request queue for an already-resolved main repo. */
export function reviewRequestsDir(mainRepo: string): string {
	return resolve(mainRepo, ".dev", QUEUE_DIR);
}

/** Lock file guarding one drain round (see `withFileLock` / `tryWithFileLock`). */
export function reviewDrainLockPath(queueRoot: string): string {
	return resolve(queueRoot, DRAIN_LOCK);
}

function key(prNumber: number, headSha: string): string {
	return `${prNumber}-${headSha}`;
}

function pendingPath(queueRoot: string, prNumber: number, headSha: string): string {
	return resolve(queueRoot, `${key(prNumber, headSha)}.json`);
}

function claimedPath(queueRoot: string, prNumber: number, headSha: string): string {
	return resolve(queueRoot, `${key(prNumber, headSha)}${CLAIMED_SUFFIX}`);
}

function readRecord(path: string): ReviewRequestRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ReviewRequestRecord>;
		if (parsed?.schemaVersion !== 1) return null;
		if (typeof parsed.prNumber !== "number" || !Number.isInteger(parsed.prNumber)) return null;
		if (typeof parsed.headSha !== "string" || !SHA_RE.test(parsed.headSha)) return null;
		if (typeof parsed.itemId !== "string" || typeof parsed.headBranch !== "string" || typeof parsed.enqueuedAt !== "string") return null;
		return { schemaVersion: 1, prNumber: parsed.prNumber, headSha: parsed.headSha, itemId: parsed.itemId, headBranch: parsed.headBranch, enqueuedAt: parsed.enqueuedAt };
	} catch {
		// Malformed JSON — skip fail-soft (leave the file for the operator / a later parse).
		return null;
	}
}

/**
 * Write one review-request record atomically (tmp + rename, mode 0o600). Idempotent on the
 * `(prNumber, headSha)` key: a no-op if the same key is already pending or in-flight
 * (`.claimed`). Throws on an invalid key (bad prNumber/headSha) so a caller that skips-on-null
 * never writes a half-record; fs errors propagate to the caller (ship-tail treats them non-fatal).
 */
export function enqueueReviewRequest(mainRepo: string, request: NewReviewRequest): void {
	if (!Number.isInteger(request.prNumber) || request.prNumber <= 0) throw new Error(`review-request enqueue: invalid prNumber ${request.prNumber}`);
	if (!SHA_RE.test(request.headSha)) throw new Error(`review-request enqueue: invalid headSha ${request.headSha}`);
	const dir = reviewRequestsDir(mainRepo);
	const pending = pendingPath(dir, request.prNumber, request.headSha);
	const claimed = claimedPath(dir, request.prNumber, request.headSha);
	if (existsSync(pending) || existsSync(claimed)) return;
	mkdirSync(dir, { recursive: true });
	const record: ReviewRequestRecord = { schemaVersion: 1, ...request };
	const tmp = `${pending}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, pending);
}

/**
 * List pending records (`.json` only), skipping `.claimed`/lock/tmp/malformed names and
 * unparsable JSON. Returned in stable FIFO order (enqueuedAt, then key). A missing queue
 * directory is an empty queue, never an error.
 */
export function listReviewRequests(queueRoot: string): ListedReviewRequest[] {
	let names: string[];
	try {
		names = readdirSync(queueRoot);
	} catch {
		return [];
	}
	const out: ListedReviewRequest[] = [];
	for (const name of names) {
		const m = name.match(PENDING_RE);
		if (!m) continue;
		const path = resolve(queueRoot, name);
		const record = readRecord(path);
		if (!record) continue;
		// Filename must agree with content (defense against a hand-edited/renamed file).
		if (record.prNumber !== Number.parseInt(m[1], 10) || record.headSha.toLowerCase() !== m[2].toLowerCase()) continue;
		out.push({ record, path });
	}
	out.sort((a, b) => a.record.enqueuedAt.localeCompare(b.record.enqueuedAt) || key(a.record.prNumber, a.record.headSha).localeCompare(key(b.record.prNumber, b.record.headSha)));
	return out;
}

/** Atomically claim a pending record (rename `.json` → `.claimed`). Returns the claimed path,
 *  or null when the record is already claimed by a peer or gone. */
export function claimReviewRequest(queueRoot: string, prNumber: number, headSha: string): string | null {
	const claimed = claimedPath(queueRoot, prNumber, headSha);
	try {
		renameSync(pendingPath(queueRoot, prNumber, headSha), claimed);
		return claimed;
	} catch {
		return null;
	}
}

/** Release a claimed record back to pending (rate-limit park handback). No-op if not claimed. */
export function unclaimReviewRequest(queueRoot: string, prNumber: number, headSha: string): void {
	try {
		renameSync(claimedPath(queueRoot, prNumber, headSha), pendingPath(queueRoot, prNumber, headSha));
	} catch {
		// nothing claimed for this key
	}
}

/** Delete a record after a terminal review status (or a confirmed already-terminal probe).
 *  Removes both the claimed and pending forms; each unlink is best-effort. */
export function completeReviewRequest(queueRoot: string, prNumber: number, headSha: string): void {
	for (const path of [claimedPath(queueRoot, prNumber, headSha), pendingPath(queueRoot, prNumber, headSha)]) {
		try {
			unlinkSync(path);
		} catch {
			// already gone
		}
	}
}

/**
 * Reclaim abandoned `.claimed` files (a drain that crashed after claiming) back to pending
 * once older than `staleMs`. Runs at drain start under the exclusive drain lock, so a live
 * review — which holds that lock for its whole pass — is never reclaimed out from under itself.
 * `now` is injected so the reconciler shares its clock; a missing directory is a no-op.
 */
export function reclaimStaleReviewClaims(queueRoot: string, now: number, staleMs: number = REVIEW_CLAIM_STALE_MS): void {
	let names: string[];
	try {
		names = readdirSync(queueRoot);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.endsWith(CLAIMED_SUFFIX)) continue;
		const path = resolve(queueRoot, name);
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		if (now - mtimeMs < staleMs) continue;
		const pending = resolve(queueRoot, `${name.slice(0, -CLAIMED_SUFFIX.length)}.json`);
		try {
			renameSync(path, pending);
		} catch {
			// raced with a concurrent reclaim / completion — safe to skip
		}
	}
}
