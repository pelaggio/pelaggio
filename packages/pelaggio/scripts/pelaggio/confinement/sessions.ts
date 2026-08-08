/**
 * Cross-process session records for confinement peer exemption (#369).
 *
 * A gitignored record under MAIN_REPO/.dev/sessions/ lets a concurrent pelaggio
 * invocation prove it owns a claimed worktree so whole-step snapshots do not
 * false-positive on legitimate peer writes. Eligibility is fail-closed:
 * Git claim validation plus either Linux /proc binding (cwd + starttime before
 * evaluator start) or an exact immutable-identity match against the evaluator's
 * run-start inventory. For CONFINEMENT EVALUATION, pid aliveness remains diagnostic
 * only — a wrong answer there degrades an audit.
 *
 * For DESTRUCTIVE RECONCILERS it is not enough and never was, which is why
 * `sessionLiveness()` (#461, bottom of this file) exists as a separate reader with a
 * fail-closed tri-state contract. It corroborates the pid against its /proc cwd rather
 * than trusting `kill(pid, 0)`, and answers `unknown` — which callers must treat as
 * `live` — wherever it cannot establish the answer. Do not substitute one for the other:
 * they have opposite failure postures, because a wrong answer for reap deletes work.
 *
 * Records are NOT a claims registry — the feat/* branch remains authoritative.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SESSION_SCHEMA_VERSION = 1 as const;
/** Content-stored expiry: longer than the worst supported step. */
export const SESSION_EXPIRY_MS = 4 * 60 * 60 * 1000;
/** In-process heartbeat refreshes well before content expiry. */
export const SESSION_HEARTBEAT_MS = 30 * 60 * 1000;
/** Bound first-diff path lists in confinement diagnostics. */
export const FIRST_DIFF_PATH_LIMIT = 10;

// ── Types ──────────────────────────────────────────────────────────────

export interface SessionRecord {
	version: typeof SESSION_SCHEMA_VERSION;
	sessionId: string;
	claimedItem: string;
	/** Exact claim branch checked out at registration — not a reconstructed feat/<id> guess. */
	claimBranch: string;
	worktreePath: string;
	/** Binding PID (mutable across Claude step child replacement). 0/absent = no binding. */
	pid: number;
	/** Epoch-ms expiry stored in content (never mtime). */
	expiresAt: number;
	/** Schema-only reserved field; no scheduler behavior. */
	writeSet?: string[];
}

/** Immutable identity for inventory / fallback eligibility. pid and expiresAt are excluded. */
export interface SessionIdentity {
	sessionId: string;
	claimedItem: string;
	claimBranch: string;
	worktreePath: string;
}

export interface SessionInventory {
	identities: readonly SessionIdentity[];
}

/**
 * Captured once per evaluator run (or once per process by the orchestrator).
 * starttimeJiffies is boot-relative from /proc/self/stat field 22 — never wall-clock.
 */
export interface SessionEvaluatorContext {
	inventory: SessionInventory;
	/** Boot-relative jiffies; unset on non-Linux → only inventory fallback can accept. */
	starttimeJiffies?: number;
	mainRepo: string;
}

export type SessionEligibilityLeg = "binding" | "fallback";

export interface AcceptedSession {
	identity: SessionIdentity;
	worktreePath: string;
	leg: SessionEligibilityLeg;
	pid: number;
	/** True when kill(pid,0) succeeded.
	 *
	 *  Diagnostic corroboration ONLY, and deliberately so: pids are recycled, so this is
	 *  true for an unrelated process that inherited a dead session's number. Never gate a
	 *  destructive action on it — use `sessionLiveness()`, which corroborates against the
	 *  process's /proc cwd and fails closed. */
	pidAlive?: boolean;
}

export interface SessionProbes {
	/** Read a file's UTF-8 contents; return undefined when missing/unreadable. */
	readFile?: (path: string) => string | undefined;
	/** Read a symlink target (e.g. /proc/<pid>/cwd). */
	readlink?: (path: string) => string | undefined;
	/** List .json basenames under the sessions directory. */
	listSessionFiles?: (dir: string) => string[];
	/** Write file contents (used by atomic register). */
	writeFile?: (path: string, data: string, flag?: string) => void;
	rename?: (from: string, to: string) => void;
	unlink?: (path: string) => void;
	mkdir?: (path: string) => void;
	exists?: (path: string) => boolean;
	/** `git worktree list --porcelain` from mainRepo. */
	gitWorktreeList?: (mainRepo: string) => string;
	/** `git -C worktree rev-parse --abbrev-ref HEAD`. */
	gitBranch?: (worktree: string) => string | undefined;
	/** kill(pid, 0) style liveness. */
	isPidAlive?: (pid: number) => boolean;
	/** Platform check; defaults to process.platform. */
	platform?: string;
	now?: () => number;
}

export interface SessionController {
	readonly sessionId: string;
	readonly identity: SessionIdentity;
	/** Refresh binding pid (Claude child replacement) and rewrite the record. */
	updateChild(pid: number): void;
	/** Stop heartbeat and remove the owned record if identity still matches. */
	dispose(): void;
}

export interface SweepResult {
	removed: string[];
	retained: Array<{ file: string; reason: string }>;
}

// ── Paths ──────────────────────────────────────────────────────────────

export function sessionsDir(mainRepo: string): string {
	return resolve(mainRepo, ".dev", "sessions");
}

export function sessionRecordPath(mainRepo: string, sessionId: string): string {
	return join(sessionsDir(mainRepo), `${sessionId}.json`);
}

// ── Schema ─────────────────────────────────────────────────────────────

export function sessionIdentityOf(record: Pick<SessionRecord, "sessionId" | "claimedItem" | "claimBranch" | "worktreePath">): SessionIdentity {
	return {
		sessionId: record.sessionId,
		claimedItem: record.claimedItem,
		claimBranch: record.claimBranch,
		worktreePath: resolve(record.worktreePath),
	};
}

export function identitiesEqual(a: SessionIdentity, b: SessionIdentity): boolean {
	return a.sessionId === b.sessionId && a.claimedItem === b.claimedItem && a.claimBranch === b.claimBranch && resolve(a.worktreePath) === resolve(b.worktreePath);
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

/** Parse untrusted JSON into a validated SessionRecord, or undefined. */
export function parseSessionRecord(raw: unknown): SessionRecord | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const o = raw as Record<string, unknown>;
	if (o.version !== SESSION_SCHEMA_VERSION) return undefined;
	if (!isNonEmptyString(o.sessionId)) return undefined;
	if (!isNonEmptyString(o.claimedItem)) return undefined;
	if (!isNonEmptyString(o.claimBranch)) return undefined;
	if (!isNonEmptyString(o.worktreePath)) return undefined;
	const pid = typeof o.pid === "number" && Number.isInteger(o.pid) && o.pid >= 0 ? o.pid : undefined;
	if (pid === undefined) return undefined;
	const expiresAt = typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt) ? o.expiresAt : undefined;
	if (expiresAt === undefined) return undefined;
	const record: SessionRecord = {
		version: SESSION_SCHEMA_VERSION,
		sessionId: o.sessionId,
		claimedItem: o.claimedItem,
		claimBranch: o.claimBranch,
		worktreePath: resolve(o.worktreePath),
		pid,
		expiresAt,
	};
	if (o.writeSet !== undefined) {
		if (!Array.isArray(o.writeSet) || !o.writeSet.every((x) => typeof x === "string")) return undefined;
		record.writeSet = o.writeSet as string[];
	}
	return record;
}

export function readSessionRecordFromText(text: string): SessionRecord | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
	return parseSessionRecord(raw);
}

// ── Claim branch attribution ───────────────────────────────────────────

/**
 * Whether `claimBranch` attributes to `claimedItem` after stripping `feat/`
 * and adapter-specific prefixes. Mirrors claimedIds' longest-prefix-at-`-`
 * rule for a single known id (github-issues: `issue-<id>[-slug…]`;
 * markdown/linear/beads: bare `<id>` / `<id>-slug`).
 */
export function claimBranchAttributesToItem(claimBranch: string, claimedItem: string): boolean {
	if (!claimBranch.startsWith("feat/")) return false;
	const slug = claimBranch.slice("feat/".length).toLowerCase();
	const id = claimedItem.toLowerCase();
	if (slug === id || slug.startsWith(`${id}-`)) return true;
	// github-issues branches: feat/issue-<id>[-slug…]
	if (slug.startsWith("issue-")) {
		const rest = slug.slice("issue-".length);
		if (rest === id || rest.startsWith(`${id}-`)) return true;
	}
	return false;
}

// ── /proc parsing ──────────────────────────────────────────────────────

/**
 * Parse field 22 (starttime, boot-relative jiffies) from /proc/<pid>/stat.
 * Correctly handles spaces and `)` inside `comm` by scanning after the final `)`.
 */
export function parseProcStatStarttime(stat: string): number | undefined {
	const close = stat.lastIndexOf(")");
	if (close < 0) return undefined;
	const rest = stat
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	// After `)`: field 3 = state at rest[0], … field 22 = starttime at rest[19].
	const raw = rest[19];
	if (raw === undefined) return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : undefined;
}

export interface ProcBinding {
	cwd: string;
	starttimeJiffies: number;
}

// ── Default probes ─────────────────────────────────────────────────────

function defaultIsPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but we lack permission — still "alive".
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function defaultGitWorktreeList(mainRepo: string): string {
	const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: mainRepo, encoding: "utf-8" });
	if (r.status !== 0) return "";
	return r.stdout ?? "";
}

function defaultGitBranch(worktree: string): string | undefined {
	const r = spawnSync("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" });
	if (r.status !== 0) return undefined;
	const b = (r.stdout ?? "").trim();
	return b.length > 0 ? b : undefined;
}

function resolveProbes(probes: SessionProbes = {}): Required<SessionProbes> {
	return {
		readFile:
			probes.readFile ??
			((path) => {
				try {
					return readFileSync(path, "utf-8");
				} catch {
					return undefined;
				}
			}),
		readlink:
			probes.readlink ??
			((path) => {
				try {
					return readlinkSync(path);
				} catch {
					return undefined;
				}
			}),
		listSessionFiles:
			probes.listSessionFiles ??
			((dir) => {
				try {
					return readdirSync(dir).filter((f) => f.endsWith(".json"));
				} catch {
					return [];
				}
			}),
		writeFile:
			probes.writeFile ??
			((path, data, flag) => {
				writeFileSync(path, data, flag ? { flag } : undefined);
			}),
		rename: probes.rename ?? renameSync,
		unlink:
			probes.unlink ??
			((path) => {
				try {
					unlinkSync(path);
				} catch {
					// already gone
				}
			}),
		mkdir:
			probes.mkdir ??
			((path) => {
				mkdirSync(path, { recursive: true });
			}),
		exists: probes.exists ?? ((path) => existsSync(path)),
		gitWorktreeList: probes.gitWorktreeList ?? defaultGitWorktreeList,
		gitBranch: probes.gitBranch ?? defaultGitBranch,
		isPidAlive: probes.isPidAlive ?? defaultIsPidAlive,
		platform: probes.platform ?? process.platform,
		now: probes.now ?? Date.now,
	};
}

// ── Inventory / evaluator context ──────────────────────────────────────

/** Capture syntactically valid records' immutable identities at evaluator start. */
export function captureSessionInventory(mainRepo: string, probes: SessionProbes = {}): SessionInventory {
	const p = resolveProbes(probes);
	const dir = sessionsDir(mainRepo);
	const identities: SessionIdentity[] = [];
	const seen = new Set<string>();
	for (const file of p.listSessionFiles(dir)) {
		const text = p.readFile(join(dir, file));
		if (text === undefined) continue;
		const rec = readSessionRecordFromText(text);
		if (!rec) continue;
		const id = sessionIdentityOf(rec);
		const key = `${id.sessionId}\0${id.claimedItem}\0${id.claimBranch}\0${id.worktreePath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		identities.push(id);
	}
	return { identities };
}

/** Read boot-relative starttime jiffies from /proc/self/stat (Linux only). */
export function readSelfStarttimeJiffies(probes: SessionProbes = {}): number | undefined {
	const p = resolveProbes(probes);
	if (p.platform !== "linux") return undefined;
	const stat = p.readFile("/proc/self/stat");
	if (stat === undefined) return undefined;
	return parseProcStatStarttime(stat);
}

export function captureEvaluatorContext(mainRepo: string, probes: SessionProbes = {}): SessionEvaluatorContext {
	return {
		inventory: captureSessionInventory(mainRepo, probes),
		starttimeJiffies: readSelfStarttimeJiffies(probes),
		mainRepo: resolve(mainRepo),
	};
}

// ── Atomic register / remove ───────────────────────────────────────────

export function writeSessionRecord(mainRepo: string, record: SessionRecord, probes: SessionProbes = {}): void {
	const p = resolveProbes(probes);
	const dir = sessionsDir(mainRepo);
	p.mkdir(dir);
	const path = sessionRecordPath(mainRepo, record.sessionId);
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	const body = JSON.stringify(record, null, "\t") + "\n";
	p.writeFile(tmp, body);
	p.rename(tmp, path);
}

/**
 * Remove the record only if its current on-disk identity still matches
 * `expected` (compare-before-remove — never delete a replacement).
 */
export function removeSessionRecord(mainRepo: string, expected: SessionIdentity, probes: SessionProbes = {}): boolean {
	const p = resolveProbes(probes);
	const path = sessionRecordPath(mainRepo, expected.sessionId);
	const text = p.readFile(path);
	if (text === undefined) return false;
	const rec = readSessionRecordFromText(text);
	if (!rec) return false;
	if (!identitiesEqual(sessionIdentityOf(rec), expected)) return false;
	// Content-compare: re-read identity match already done; unlink the path.
	// A concurrent refresh that keeps identity but rewrites expiry/pid is still
	// "ours" for teardown of a finishing run — the owner is disposing.
	// A replacement with different identity is protected above.
	p.unlink(path);
	// If a concurrent writer replaced the file between read and unlink with a
	// different identity under the same sessionId (unlikely: same sessionId
	// owner), compare-before-remove already blocked. Done.
	return true;
}

export function loadSessionRecord(mainRepo: string, sessionId: string, probes: SessionProbes = {}): SessionRecord | undefined {
	const p = resolveProbes(probes);
	const text = p.readFile(sessionRecordPath(mainRepo, sessionId));
	if (text === undefined) return undefined;
	return readSessionRecordFromText(text);
}

// ── Git claim validation ───────────────────────────────────────────────

export function parseWorktreePathsFromPorcelain(porcelain: string): Set<string> {
	const paths = new Set<string>();
	for (const line of porcelain.split("\n")) {
		if (line.startsWith("worktree ")) {
			paths.add(resolve(line.slice("worktree ".length).trim()));
		}
	}
	return paths;
}

export function validateGitClaim(record: SessionRecord, mainRepo: string, probes: SessionProbes = {}): boolean {
	const p = resolveProbes(probes);
	const wt = resolve(record.worktreePath);
	const registered = parseWorktreePathsFromPorcelain(p.gitWorktreeList(mainRepo));
	if (!registered.has(wt)) return false;
	const branch = p.gitBranch(wt);
	if (branch === undefined || branch !== record.claimBranch) return false;
	if (!claimBranchAttributesToItem(record.claimBranch, record.claimedItem)) return false;
	return true;
}

// ── Linux binding ──────────────────────────────────────────────────────

export function readProcBinding(pid: number, probes: SessionProbes = {}): ProcBinding | undefined {
	const p = resolveProbes(probes);
	if (p.platform !== "linux") return undefined;
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	const cwd = p.readlink(`/proc/${pid}/cwd`);
	if (cwd === undefined) return undefined;
	const stat = p.readFile(`/proc/${pid}/stat`);
	if (stat === undefined) return undefined;
	const starttimeJiffies = parseProcStatStarttime(stat);
	if (starttimeJiffies === undefined) return undefined;
	return { cwd: resolve(cwd), starttimeJiffies };
}

function cwdInsideWorktree(cwd: string, worktree: string): boolean {
	const c = resolve(cwd);
	const w = resolve(worktree);
	return c === w || c.startsWith(`${w}/`);
}

// ── Eligibility (single predicate for step-start and diff-time) ─────────

export interface ResolveEligibleOptions {
	probes?: SessionProbes;
	/** When set, only consider this one sessionId (diff-time revalidation of a root). */
	onlySessionId?: string;
	/** When set, only consider records whose worktreePath resolves to this root. */
	onlyWorktreePath?: string;
}

/**
 * Resolve eligible peer session worktrees for confinement exemption.
 * Rejects mainRepo before returning. Returns evidence keyed for audit diagnostics.
 */
export function resolveEligibleSessions(ctx: SessionEvaluatorContext, opts: ResolveEligibleOptions = {}): AcceptedSession[] {
	const p = resolveProbes(opts.probes);
	const mainAbs = resolve(ctx.mainRepo);
	const dir = sessionsDir(ctx.mainRepo);
	const now = p.now();
	const accepted: AcceptedSession[] = [];
	const acceptedRoots = new Set<string>();

	const inventoryKeys = new Set(ctx.inventory.identities.map((id) => `${id.sessionId}\0${id.claimedItem}\0${id.claimBranch}\0${resolve(id.worktreePath)}`));

	for (const file of p.listSessionFiles(dir)) {
		if (opts.onlySessionId && file !== `${opts.onlySessionId}.json`) continue;
		const text = p.readFile(join(dir, file));
		if (text === undefined) continue;
		const rec = readSessionRecordFromText(text);
		if (!rec) continue;
		if (opts.onlyWorktreePath && resolve(rec.worktreePath) !== resolve(opts.onlyWorktreePath)) continue;
		if (rec.expiresAt <= now) continue; // content-expired

		const identity = sessionIdentityOf(rec);
		const wt = identity.worktreePath;
		if (wt === mainAbs) continue; // never exempt main via records
		if (acceptedRoots.has(wt)) continue;

		if (!validateGitClaim(rec, ctx.mainRepo, p)) continue;

		// Binding leg: Git ok + pid has worktree cwd + starttime < evaluator starttime
		let leg: SessionEligibilityLeg | undefined;
		let pidAlive: boolean | undefined;
		if (rec.pid > 0 && ctx.starttimeJiffies !== undefined) {
			const binding = readProcBinding(rec.pid, p);
			if (binding && cwdInsideWorktree(binding.cwd, wt) && binding.starttimeJiffies < ctx.starttimeJiffies) {
				leg = "binding";
				pidAlive = p.isPidAlive(rec.pid);
			}
		}

		// Fallback leg: exact immutable identity in run-start inventory
		if (leg === undefined) {
			const key = `${identity.sessionId}\0${identity.claimedItem}\0${identity.claimBranch}\0${wt}`;
			if (inventoryKeys.has(key)) {
				leg = "fallback";
				if (rec.pid > 0) pidAlive = p.isPidAlive(rec.pid);
			}
		}

		if (leg === undefined) continue;

		acceptedRoots.add(wt);
		accepted.push({
			identity,
			worktreePath: wt,
			leg,
			pid: rec.pid,
			...(pidAlive !== undefined ? { pidAlive } : {}),
		});
	}

	return accepted;
}

/**
 * Diff-time revalidation: re-run the same eligibility predicate for a changed root.
 * Returns the accepted session if still eligible, else undefined (retain violation).
 */
export function revalidateChangedRoot(ctx: SessionEvaluatorContext, changedRoot: string, probes: SessionProbes = {}): AcceptedSession | undefined {
	const mainAbs = resolve(ctx.mainRepo);
	const root = resolve(changedRoot);
	if (root === mainAbs) return undefined; // main always fails closed
	const hits = resolveEligibleSessions(ctx, { probes, onlyWorktreePath: root });
	return hits[0];
}

// ── Sweep ──────────────────────────────────────────────────────────────

/**
 * Remove content-expired records. Retains live/unexpired and unreadable/malformed
 * records fail-closed. Compare-before-remove protects a concurrently refreshed
 * replacement whose identity still matches (we only remove if still expired).
 */
export function sweepExpiredSessions(mainRepo: string, probes: SessionProbes = {}): SweepResult {
	const p = resolveProbes(probes);
	const dir = sessionsDir(mainRepo);
	const now = p.now();
	const removed: string[] = [];
	const retained: Array<{ file: string; reason: string }> = [];

	for (const file of p.listSessionFiles(dir)) {
		const path = join(dir, file);
		const text = p.readFile(path);
		if (text === undefined) {
			retained.push({ file, reason: "unreadable" });
			continue;
		}
		const rec = readSessionRecordFromText(text);
		if (!rec) {
			retained.push({ file, reason: "malformed" });
			continue;
		}
		if (rec.expiresAt > now) {
			retained.push({ file, reason: "live" });
			continue;
		}
		// Compare-before-remove: re-read and only unlink if still the same expired content identity+expiry.
		const again = p.readFile(path);
		if (again === undefined) {
			// vanished — treat as already cleaned
			continue;
		}
		const rec2 = readSessionRecordFromText(again);
		if (!rec2) {
			retained.push({ file, reason: "malformed-on-recheck" });
			continue;
		}
		if (rec2.expiresAt > now) {
			// Concurrently refreshed — leave it
			retained.push({ file, reason: "refreshed" });
			continue;
		}
		if (!identitiesEqual(sessionIdentityOf(rec), sessionIdentityOf(rec2))) {
			retained.push({ file, reason: "identity-changed" });
			continue;
		}
		p.unlink(path);
		removed.push(file);
	}

	return { removed, retained };
}

// ── Controller (lifecycle) ─────────────────────────────────────────────

export interface CreateSessionControllerArgs {
	mainRepo: string;
	sessionId: string;
	claimedItem: string;
	claimBranch: string;
	worktreePath: string;
	/** Initial binding pid (0 if unknown — binding rejected until updateChild). */
	pid?: number;
	expiryMs?: number;
	heartbeatMs?: number;
	probes?: SessionProbes;
	/** Inject setInterval for tests. */
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
}

export function createSessionController(args: CreateSessionControllerArgs): SessionController {
	const p = resolveProbes(args.probes);
	const expiryMs = args.expiryMs ?? SESSION_EXPIRY_MS;
	const heartbeatMs = args.heartbeatMs ?? SESSION_HEARTBEAT_MS;
	const setInt = args.setIntervalFn ?? setInterval;
	const clearInt = args.clearIntervalFn ?? clearInterval;

	const identity: SessionIdentity = {
		sessionId: args.sessionId,
		claimedItem: args.claimedItem,
		claimBranch: args.claimBranch,
		worktreePath: resolve(args.worktreePath),
	};

	let pid = args.pid !== undefined && args.pid > 0 ? args.pid : 0;
	let disposed = false;

	const write = (): void => {
		if (disposed) return;
		const record: SessionRecord = {
			version: SESSION_SCHEMA_VERSION,
			sessionId: identity.sessionId,
			claimedItem: identity.claimedItem,
			claimBranch: identity.claimBranch,
			worktreePath: identity.worktreePath,
			pid,
			expiresAt: p.now() + expiryMs,
		};
		writeSessionRecord(args.mainRepo, record, p);
	};

	write();

	const timer = setInt(() => {
		write();
	}, heartbeatMs);
	// Don't keep the process alive solely for heartbeats.
	if (typeof timer === "object" && timer !== null && "unref" in timer && typeof (timer as { unref?: () => void }).unref === "function") {
		(timer as { unref: () => void }).unref();
	}

	return {
		sessionId: identity.sessionId,
		identity,
		updateChild(nextPid: number): void {
			if (disposed) return;
			if (!Number.isInteger(nextPid) || nextPid <= 0) return;
			pid = nextPid;
			write();
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			clearInt(timer);
			removeSessionRecord(args.mainRepo, identity, p);
		},
	};
}

// ── Porcelain first-difference paths ───────────────────────────────────

/**
 * Extract path entries from `git status --porcelain` output, including rename/copy
 * destinations and sources (`R`/`C` status lines: `XY score\told\tnew` or
 * `XY old -> new` variants). Returns a sorted unique list.
 */
export function porcelainPaths(porcelain: string): string[] {
	const paths = new Set<string>();
	for (const line of porcelain.split("\n")) {
		if (!line || line === "\0gone") continue;
		// Porcelain v1: first two chars are status, then space, then path.
		// Rename/copy may be: "R  old -> new" or with score "R100 old -> new"
		// or null-separated in -z mode (we don't use -z; stick to space form).
		if (line.length < 4) continue;
		const body = line.slice(3); // skip "XY "
		const status = line.slice(0, 2);
		const isRenameOrCopy = status.includes("R") || status.includes("C") || /^[ R][RC]/.test(status) || /^[RC]/.test(status.trimStart());
		// Also detect via " -> " which is the rename marker in non-z porcelain.
		if (body.includes(" -> ")) {
			const [from, to] = body.split(" -> ");
			if (from?.trim()) paths.add(from.trim());
			if (to?.trim()) paths.add(to.trim());
			continue;
		}
		// Score-prefixed rename sometimes appears as "R100\told\tnew" only in -z;
		// plain form already handled. Single path:
		const path = body.trim();
		if (path) paths.add(path);
		void isRenameOrCopy;
	}
	return [...paths].sort();
}

/**
 * First differing paths between before/after porcelain snapshots for a root.
 * Returns up to `limit` paths that appear only on one side or changed via rename.
 */
export function firstDiffPaths(beforePorcelain: string, afterPorcelain: string, limit = FIRST_DIFF_PATH_LIMIT): string[] {
	if (beforePorcelain === afterPorcelain) return [];
	const before = new Set(porcelainPaths(beforePorcelain));
	const after = new Set(porcelainPaths(afterPorcelain));
	const onlyAfter = [...after].filter((p) => !before.has(p));
	const onlyBefore = [...before].filter((p) => !after.has(p));
	// Prefer newly-appeared paths, then disappeared; fall back to raw line diff sample.
	const ordered = [...onlyAfter.sort(), ...onlyBefore.sort()];
	if (ordered.length > 0) return ordered.slice(0, limit);
	// Status-only change (e.g. same path, different XY): report paths present on either side.
	const union = [...new Set([...before, ...after])].sort();
	if (union.length > 0) return union.slice(0, limit);
	// Unparseable porcelain change — surface a bounded raw snippet for diagnostics.
	const snippet = afterPorcelain.slice(0, 80).replace(/\n/g, "\\n");
	return snippet ? [snippet] : [];
}

/**
 * For each changed root, extract bounded first-diff paths from retained snapshots.
 */
export function firstDiffPathsByRoot(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, changedRoots: readonly string[], limit = FIRST_DIFF_PATH_LIMIT): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const root of changedRoots) {
		const b = before.get(resolve(root)) ?? before.get(root) ?? "";
		const a = after.get(resolve(root)) ?? after.get(root) ?? "";
		out.set(resolve(root), firstDiffPaths(b, a, limit));
	}
	return out;
}

// ── Liveness for destructive reconcilers (#461) ─────────────────────────

/**
 * Verdict a destructive operation may act on.
 *
 * `unknown` is NOT a soft `dead`. It means "this reader could not establish the answer",
 * and every destructive caller must treat it exactly as `live`. The tri-state exists so a
 * refusal can say WHICH it was — an operator debugging a worktree that will not reap needs
 * to distinguish "a session is running" from "this host cannot tell".
 */
export type SessionLivenessState = "live" | "dead" | "unknown";

export interface SessionLivenessVerdict {
	state: SessionLivenessState;
	/** Operator-facing explanation; always populated, including for `dead`. */
	reason: string;
	/** Session ids that produced a `live` or `unknown` contribution, for diagnostics. */
	sessions: string[];
}

/** Least-safe-wins: any live → live; else any unknown → unknown; else dead. */
function mergeLiveness(verdicts: Array<{ state: SessionLivenessState; sessionId: string }>): SessionLivenessState {
	if (verdicts.some((v) => v.state === "live")) return "live";
	if (verdicts.some((v) => v.state === "unknown")) return "unknown";
	return "dead";
}

/**
 * Liveness of one record, corroborated rather than trusted.
 *
 * A bare `kill(pid, 0)` is not sufficient: pids are recycled, so a dead session whose number
 * has been reissued to an unrelated process reads as alive. Corroboration is the /proc
 * binding — the process must currently have its cwd inside the worktree the record claims.
 * A recycled pid will essentially never satisfy that, and a genuinely live pelaggio session
 * always does, because the step runs with cwd set to its own worktree.
 */
function recordLiveness(record: SessionRecord, worktreePath: string, p: Required<SessionProbes>): SessionLivenessState {
	if (!Number.isInteger(record.pid) || record.pid <= 0) {
		// No binding pid was ever recorded. Expiry is all we have, and expiry is a deadline,
		// not evidence — so an unexpired record without a pid is `unknown`, never `dead`.
		return record.expiresAt > p.now() ? "unknown" : "dead";
	}
	if (p.platform !== "linux") {
		// No /proc to corroborate with. `kill(pid, 0)` alone cannot distinguish a live session
		// from a recycled pid, so this host cannot answer — it must not answer `dead`.
		return record.expiresAt > p.now() ? "unknown" : "dead";
	}
	const binding = readProcBinding(record.pid, p);
	if (binding === undefined) {
		// /proc entry absent. If the pid is not alive either, the session is genuinely gone.
		// If it IS alive, /proc was unreadable for some other reason and we cannot corroborate.
		if (p.isPidAlive(record.pid)) return "unknown";
		return "dead";
	}
	if (cwdInsideWorktree(binding.cwd, worktreePath)) return "live";
	// Alive, but working somewhere else: either a recycled pid or a session that moved on.
	// Not corroborated — so `dead` only once the record's own deadline has passed.
	return record.expiresAt > p.now() ? "unknown" : "dead";
}

/**
 * Whether any session is using `worktreePath`. Intended for reconcilers that DELETE — worktree
 * removal, claim-branch deletion — where a wrong answer is unrecoverable.
 *
 * Contract for callers, and it is fail-closed by construction:
 *   - `live`    → refuse the destructive action.
 *   - `unknown` → refuse the destructive action. Identical obligation to `live`.
 *   - `dead`    → the action is permitted by THIS check. Other preconditions still apply;
 *                 this reader answers "is someone using it", never "should it be removed".
 *
 * `dead` is returned when no record claims the worktree at all. That is the honest reading —
 * a live pelaggio session always registers a record before doing work — but it does mean this
 * reader cannot protect a worktree whose record was deleted out from under it. Records live in
 * `MAIN_REPO/.dev/sessions/`, which `blockForeignRootWrite` denies to agent tools absolutely,
 * so that gap is a filesystem-level concern rather than an agent-reachable one.
 */
export function sessionLiveness(mainRepo: string, worktreePath: string, probes: SessionProbes = {}): SessionLivenessVerdict {
	const p = resolveProbes(probes);
	const dir = sessionsDir(mainRepo);
	const target = resolve(worktreePath);
	const perRecord: Array<{ state: SessionLivenessState; sessionId: string }> = [];
	for (const file of p.listSessionFiles(dir)) {
		const text = p.readFile(join(dir, file));
		if (text === undefined) {
			// A session file we can see but cannot read is exactly the case that must not be
			// silently ignored: it may claim this worktree.
			perRecord.push({ state: "unknown", sessionId: file });
			continue;
		}
		const rec = readSessionRecordFromText(text);
		if (!rec) {
			perRecord.push({ state: "unknown", sessionId: file });
			continue;
		}
		if (resolve(rec.worktreePath) !== target) continue;
		perRecord.push({ state: recordLiveness(rec, target, p), sessionId: rec.sessionId });
	}
	if (perRecord.length === 0) {
		return { state: "dead", reason: `no session record claims ${target}`, sessions: [] };
	}
	const state = mergeLiveness(perRecord);
	const contributing = perRecord.filter((v) => v.state === state).map((v) => v.sessionId);
	const reason =
		state === "live"
			? `session ${contributing.join(", ")} is running in ${target}`
			: state === "unknown"
				? `cannot establish liveness for ${target} (session ${contributing.join(", ")}); treating as live`
				: `all ${perRecord.length} session record(s) for ${target} are dead`;
	return { state, reason, sessions: contributing };
}

/** Convenience for destructive callers: true iff the action must be refused. */
export function mustNotDestroy(verdict: SessionLivenessVerdict): boolean {
	return verdict.state !== "dead";
}
