/**
 * Local claim ledger — serializes parallel roadmap operations on a single host.
 *
 * The durable roadmap source (GitHub issues / markdown / Linear) stays the
 * source of record. This ledger is an ephemeral, gitignored overlay that lets
 * concurrent `/pick` cycles avoid claiming the same item (TOCTOU between
 * `roadmap list` and `roadmap claim`) and distinguishes a **live** cycle from a
 * **crashed** one (worktree existence alone cannot).
 *
 * Storage: `${MAIN_REPO}/.dev/autopilot-claims.json` (a `Record<id, Claim>`)
 * with a sibling lock directory `${MAIN_REPO}/.dev/autopilot-claims.lock`.
 * `.dev/` is already gitignored, so both inherit that.
 *
 * Concurrency primitive: directory-as-mutex. `mkdirSync(lockDir)` succeeds for
 * exactly one contender and throws `EEXIST` for the rest — atomic and portable
 * across Windows / POSIX / network FS, unlike `flock`/`O_EXCL` quirks. A crash
 * mid-hold is recovered by the next contender's stale-break (dead owner pid, or
 * lock-dir age past a TTL when `owner.json` is missing/corrupt).
 *
 * Liveness: a claim is stale iff its owner `pid` is not alive OR its `worktree`
 * path no longer exists. The owner pid is the long-lived orchestrator process
 * (see `ownerPid()`), not the short-lived `npx roadmap claim` subprocess.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface Claim {
	id: string;
	branch: string;
	worktree: string;
	claimedAt: number;
	pid: number;
}

// Lock-acquisition tuning. Picks *should* serialize, so waiting out a slow
// claim is correct; the TTL only guards against a holder that crashed without
// leaving a readable `owner.json`.
const LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const LOCK_BACKOFF_MS = 100;
const LOCK_STALE_TTL_MS = 60_000;

// ── Path resolution ────────────────────────────────────────────────────

let cachedMainRepo: string | null = null;

/**
 * Resolve the MAIN_REPO root that hosts the shared ledger.
 *
 * `config.REPO` (`git rev-parse --show-toplevel`) resolves to the *worktree*
 * root when the CLI runs inside one, which would shard the ledger per-worktree.
 * `--git-common-dir` instead points at the shared `.git`, so stripping the
 * trailing `.git` yields the main checkout whether `claim` runs from MAIN_REPO
 * (pick) or `mark-done` runs from a worktree (ship).
 *
 * The `CLAUDE_AUTOPILOT_MAIN_REPO` env var short-circuits the git call (tests /
 * escape hatch) and is intentionally re-read every call so tests can retarget
 * it; the git-resolved path is cached module-level.
 */
export function resolveMainRepo(cwd?: string): string {
	const override = process.env.CLAUDE_AUTOPILOT_MAIN_REPO;
	if (override) return resolve(override);
	if (cachedMainRepo) return cachedMainRepo;
	const common = execSync("git rev-parse --path-format=absolute --git-common-dir", {
		cwd: cwd ?? process.cwd(),
		encoding: "utf-8",
	}).trim();
	cachedMainRepo = resolve(common.replace(/[/\\]\.git[/\\]?$/, ""));
	return cachedMainRepo;
}

function claimsFilePath(mainRepo: string): string {
	return resolve(mainRepo, ".dev", "autopilot-claims.json");
}

function lockDirPath(mainRepo: string): string {
	return resolve(mainRepo, ".dev", "autopilot-claims.lock");
}

/** Canonical ledger key — case-insensitive so `claim TOOL-1` and `mark-done tool-1` match. */
export function canonicalId(id: string): string {
	return id.toLowerCase();
}

// ── Owner pid + liveness ───────────────────────────────────────────────

/**
 * The long-lived process that owns a claim. Under the pipeline this is the
 * orchestrator (one pid shared by all in-process parallel cycles; distinct per
 * server-spawned `pnpm autopilot` subprocess — exactly the cross-process
 * granularity the race needs), exported as `AUTOPILOT_OWNER_PID`. The
 * short-lived `npx roadmap claim` subprocess inherits it via `process.env`.
 *
 * NOTE: this relies on the SDK spawning the Claude CLI (and its Bash tool) with
 * inherited `process.env` (confirmed: `step-runner` passes no `env` to
 * `query()`). If a future SDK curates env, this falls back to `process.ppid`
 * and stale-reaping degrades to worktree-existence only — acceptable graceful
 * degradation.
 */
export function ownerPid(): number {
	return Number(process.env.AUTOPILOT_OWNER_PID) || process.ppid;
}

/** True if `pid` is a running process. `EPERM` (alive but not ours) counts as alive; `ESRCH` is dead. */
export function isAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isStale(claim: Claim): boolean {
	return !isAlive(claim.pid) || !existsSync(claim.worktree);
}

// ── Claims JSON CRUD ───────────────────────────────────────────────────

/** Read the raw claims map. Missing/corrupt file → `{}`. Does not filter stale. */
export function readClaims(mainRepo: string): Record<string, Claim> {
	const file = claimsFilePath(mainRepo);
	if (!existsSync(file)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, Claim>;
		return {};
	} catch {
		return {};
	}
}

/** Overwrite the claims map. Callers that mutate should hold the lock first. */
export function writeClaims(mainRepo: string, claims: Record<string, Claim>): void {
	const file = claimsFilePath(mainRepo);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(claims, null, 2)}\n`);
}

/** Record a claim under its canonical key. Assumes the caller holds the lock. */
export function recordClaim(mainRepo: string, claim: Claim): void {
	const claims = readClaims(mainRepo);
	claims[canonicalId(claim.id)] = claim;
	writeClaims(mainRepo, claims);
}

/** Remove a claim by id. No-op if absent. Assumes the caller holds the lock. */
export function releaseClaim(mainRepo: string, id: string): void {
	const claims = readClaims(mainRepo);
	const key = canonicalId(id);
	if (key in claims) {
		delete claims[key];
		writeClaims(mainRepo, claims);
	}
}

/** Drop stale claims and persist the result. Assumes the caller holds the lock. */
export function reapStale(mainRepo: string): Record<string, Claim> {
	const claims = readClaims(mainRepo);
	const live: Record<string, Claim> = {};
	let changed = false;
	for (const [key, claim] of Object.entries(claims)) {
		if (isStale(claim)) changed = true;
		else live[key] = claim;
	}
	if (changed) writeClaims(mainRepo, live);
	return live;
}

/** Live claim for `id`, or null if absent/stale. Read-only — never takes the lock. */
export function activeClaim(mainRepo: string, id: string): Claim | null {
	const claim = readClaims(mainRepo)[canonicalId(id)];
	if (!claim || isStale(claim)) return null;
	return claim;
}

/** All live claims, keyed by canonical id. Filters stale in-memory; never takes the lock. */
export function activeClaims(mainRepo: string): Record<string, Claim> {
	const live: Record<string, Claim> = {};
	for (const [key, claim] of Object.entries(readClaims(mainRepo))) {
		if (!isStale(claim)) live[key] = claim;
	}
	return live;
}

// ── Lock primitive ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Steal a contended lock if its holder is dead or the dir is older than the TTL. Returns true if the lock is now free to re-acquire. */
function tryStealStale(lockDir: string, ownerFile: string): boolean {
	let shouldSteal = false;
	try {
		const owner: unknown = JSON.parse(readFileSync(ownerFile, "utf-8"));
		const pid = (owner as { pid?: unknown }).pid;
		if (typeof pid === "number") shouldSteal = !isAlive(pid);
	} catch {
		// owner.json missing/corrupt — fall back to the lock-dir-age TTL.
		try {
			shouldSteal = Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_TTL_MS;
		} catch {
			// lockDir vanished between EEXIST and stat — already free.
			return true;
		}
	}
	if (shouldSteal) {
		rmSync(lockDir, { recursive: true, force: true });
		return true;
	}
	return false;
}

/**
 * Run `fn` while holding the ledger lock. Acquires the directory mutex (bounded
 * retry with stale-break), writes `owner.json` for diagnostics + stale
 * detection, and removes the lock dir in `finally` — a crash mid-hold is
 * recovered by the next contender's stale-break.
 */
export async function withClaimLock<T>(mainRepo: string, fn: () => T | Promise<T>): Promise<T> {
	const lockDir = lockDirPath(mainRepo);
	const ownerFile = resolve(lockDir, "owner.json");
	mkdirSync(dirname(lockDir), { recursive: true });
	const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;

	while (true) {
		try {
			mkdirSync(lockDir);
			break;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		if (tryStealStale(lockDir, ownerFile)) continue;
		if (Date.now() >= deadline) throw new Error(`claim-ledger: lock acquisition timed out after ${LOCK_ACQUIRE_TIMEOUT_MS}ms (${lockDir})`);
		await sleep(LOCK_BACKOFF_MS);
	}

	try {
		writeFileSync(ownerFile, JSON.stringify({ pid: ownerPid(), startedAt: Date.now() }));
	} catch {
		// Diagnostics only — a write failure must not abort the critical section.
	}
	try {
		return await fn();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}
