import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Pure computation of the confinement forbidden-root set for a step.
 *
 * Extracted from `forbiddenRootsForStep` so the #269 ↔ #131 interaction is unit
 * testable without booting the pipeline: a concurrent authoring-review seat
 * (`.dev/authoring-review-seats/…`) may hold a dirty cwd from a peer reviewer and
 * MUST be excluded from the forbidden set, or the peer trips `error_confinement`.
 * The exemption is load-bearing; a refactor that drops it must fail CI.
 */
export function forbiddenRootsForConfinement(args: {
	cwd: string;
	mainRepo: string;
	/** Candidate roots to audit — typically `[mainRepo, ...listWorktrees()]`. */
	worktrees: string[];
	/** Own item worktree (a legitimately-mutating step); exempt when present. */
	ownWorktree?: string;
	/** When true, drop mainRepo from the set (operator main-checkout tolerated). */
	allowDirtyMain?: boolean;
	/** Predicate: is this root a harness-managed ephemeral review worktree — an authoring-review
	 *  seat (`.dev/authoring-review-seats/`, #269) or a PR-head review worktree
	 *  (`.dev/review-heads/`, #308)? Both are throwaway, gitignored, and must be exempt so a
	 *  concurrent step's whole-tree snapshot doesn't trip on a peer's dirty/orphaned checkout. */
	isEphemeralReviewWorktree: (root: string) => boolean;
	/** #131: under `--parallel`, the worktrees of peer cycles currently running. A peer's
	 *  legitimate self-write must not trip this cycle's whole-tree snapshot; cross-tree
	 *  corruption is caught by the capability/write-set boundary, not this snapshot.
	 *  `mainRepo` is never a member, so it stays hard-gated below. */
	activeWorktrees?: Iterable<string>;
	/**
	 * #369: cross-process session-record exemptions — worktrees of concurrent pelaggio
	 * invocations proven live by the eligibility predicate (Git claim + Linux binding or
	 * run-start inventory). Kept separate from trusted in-process `activeWorktrees` so the
	 * trust boundary is visible. `mainRepo` is filtered out of this source only (defense in
	 * depth; sessions.ts also rejects main) — `allowDirtyMain` and the in-memory registry
	 * are untouched. Own-run worktrees continue to use the in-memory #131 seam only.
	 */
	sessionWorktrees?: Iterable<string>;
}): string[] {
	const cwdAbs = resolve(args.cwd);
	const mainAbs = resolve(args.mainRepo);
	// Record-derived exemptions: independently drop mainAbs (sessions.ts already filters;
	// this is defense in depth and must not touch allowDirtyMain / activeWorktrees).
	const sessionExempt = [...(args.sessionWorktrees ?? [])].map((w) => resolve(w)).filter((w) => w !== mainAbs);
	const exempt = new Set([cwdAbs, ...(args.ownWorktree ? [resolve(args.ownWorktree)] : []), ...[...(args.activeWorktrees ?? [])].map((w) => resolve(w)), ...sessionExempt]);
	const seen = new Set<string>();
	const roots: string[] = [];
	for (const root of args.worktrees) {
		const abs = resolve(root);
		if (seen.has(abs) || exempt.has(abs)) continue;
		if (args.allowDirtyMain && abs === mainAbs) continue;
		// #269/#308: peer authoring-review seats and PR-head review worktrees are throwaway
		// harness checkouts; a dirty/orphaned peer one must not trip a concurrent step's audit.
		if (args.isEphemeralReviewWorktree(abs)) continue;
		seen.add(abs);
		roots.push(root);
	}
	return roots;
}

/** Fixed confirmation budget for transient Git snapshot interference (not config). */
export const FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS = 3;

/** Sync delay between failed snapshot attempts (ms). */
export const FORBIDDEN_ROOT_SNAPSHOT_RETRY_DELAY_MS = 25;

/**
 * Typed sentinel for a forbidden root unavailable at snapshot time: fully absent (#330), or a
 * residual present directory shell that is not a Git repository (Git's explicit
 * `fatal: not a git repository` diagnostic conjoined with confirmed absence of `<root>/.git` —
 * #339; e.g. `worktree remove` left an empty path). Distinct from any `git status --porcelain`
 * output (which is either "" or newline-separated entries, never NUL-prefixed), so the diff can
 * treat it as no-violation without colliding with a real clean/dirty observation. Never use `""`
 * — that collides with a clean tree.
 */
export const FORBIDDEN_ROOT_GONE = "\0gone";

export interface SnapshotForbiddenRootOptions {
	/** Test seam: replace the real Git runner. Defaults to `git --no-optional-locks status …`. */
	run?: (root: string) => string;
	/** Test seam: replace the sync sleeper between failed attempts. */
	sleepSync?: (ms: number) => void;
	/** Test seam: replace the absence check. Defaults to `existsSync`. */
	exists?: (root: string) => boolean;
	/** Override production attempt budget (tests only). */
	attempts?: number;
	/** Override production retry delay (tests only). */
	retryDelayMs?: number;
}

function sleepSyncDefault(ms: number): void {
	if (ms <= 0) return;
	// Zero-dependency synchronous delay — PreToolUse hooks must stay sync.
	const lock = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(lock, 0, 0, ms);
}

function formatSnapshotExecError(error: unknown): string {
	if (error && typeof error === "object") {
		const e = error as { stderr?: unknown; message?: unknown };
		const stderr = typeof e.stderr === "string" ? e.stderr.trim() : Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf-8").trim() : "";
		if (stderr) return stderr;
		if (typeof e.message === "string" && e.message) return e.message;
	}
	return error instanceof Error ? error.message : String(error);
}

/** Git's canonical non-repository fatal prefix (plain shell and broken-gitdir forms share it). */
function isNotAGitRepositoryDiagnostic(error: unknown): boolean {
	return formatSnapshotExecError(error).includes("fatal: not a git repository");
}

function runForbiddenRootSnapshot(root: string): string {
	// `--no-optional-locks`: parallel cycles snapshot the *shared* main-repo index twice per
	// step; without it `git status` opportunistically takes `index.lock` to write back its
	// refreshed stat cache, and concurrent snapshots collide (`index.lock: File exists`), which
	// the fail-closed audit would misread as a confinement violation. The porcelain output is
	// identical either way — the flag only skips the index writeback.
	return execSync("git --no-optional-locks status --porcelain=v1 --untracked-files=all", {
		cwd: root,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/**
 * Snapshot a forbidden Git root's porcelain status. Retries **execution failures only**
 * (throws from the runner) a fixed number of times; a successful dirty/clean observation
 * is returned immediately and never re-polled.
 */
export function snapshotForbiddenRoot(root: string, opts?: SnapshotForbiddenRootOptions): string {
	const attempts = opts?.attempts ?? FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS;
	const retryDelayMs = opts?.retryDelayMs ?? FORBIDDEN_ROOT_SNAPSHOT_RETRY_DELAY_MS;
	const run = opts?.run ?? runForbiddenRootSnapshot;
	const sleepSync = opts?.sleepSync ?? sleepSyncDefault;
	const exists = opts?.exists ?? ((p: string) => existsSync(p));

	// A registered-but-gone root cannot have been mutated by this step, so it is not a violation.
	// Return the typed GONE sentinel instead of letting the retry loop burn attempts on a permanent
	// ENOENT/`/bin/sh`-missing failure and then fail closed. Keyed strictly on *absence* (`!exists`),
	// never on catching an ENOENT-class error: a missing `git`/`sh` binary on an existing root is a
	// real failure that must still fail closed. (#308 follow-up)
	if (!exists(root)) return FORBIDDEN_ROOT_GONE;

	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return run(root);
		} catch (e: unknown) {
			lastError = e;
			// Re-check absence after a failed exec: the root may have been removed *during* the step
			// (TOCTOU) — a permanent condition the retry loop cannot clear. Only confirmed absence maps
			// to GONE; a real error on a still-present root keeps failing closed through the throw below.
			if (!exists(root)) return FORBIDDEN_ROOT_GONE;
			// Present directory shell that is not a repository (e.g. worktree remove left an empty
			// path): same GONE semantics as full absence. Require BOTH Git's explicit non-repo
			// diagnostic and confirmed absence of `<root>/.git` — the diagnostic alone collides with
			// unreadable-but-present `.git` (`chmod 000`), which must stay fail-closed (#339).
			if (isNotAGitRepositoryDiagnostic(e) && !exists(resolve(root, ".git"))) {
				return FORBIDDEN_ROOT_GONE;
			}
			if (attempt < attempts) sleepSync(retryDelayMs);
		}
	}
	throw new Error(`failed to snapshot forbidden root ${root}: ${formatSnapshotExecError(lastError)}`);
}

export function snapshotForbiddenRoots(roots: readonly string[]): Map<string, string> {
	const snapshots = new Map<string, string>();
	for (const root of roots) {
		const resolved = resolve(root);
		if (snapshots.has(resolved)) continue;
		snapshots.set(resolved, snapshotForbiddenRoot(resolved));
	}
	return snapshots;
}

export function diffForbiddenRootSnapshots(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
	const changed: string[] = [];
	for (const [root, status] of before) {
		const next = after.get(root);
		// A root that is GONE at *either* endpoint was already absent or was removed mid-step; it
		// cannot have been mutated-and-observed by this step, so it is never a violation. Only a
		// present→present pair with differing porcelain output is a real confinement breach. (#308)
		if (status === FORBIDDEN_ROOT_GONE || next === FORBIDDEN_ROOT_GONE) continue;
		if (next !== status) changed.push(root);
	}
	return changed;
}

/**
 * HEAD + full ref-state digest of a Git checkout (#510 round-2, finding 2a). A porcelain
 * snapshot cannot see clean-to-clean mutations — `git commit --allow-empty` on a clean tree or a
 * bare ref move (`git update-ref`) leaves porcelain identical — so `pr-adjudicate` brackets its
 * attacker-influenced verifier run with this digest as well: any HEAD move or ref
 * create/move/delete changes the string and the caller refuses. Throws on execution failure
 * (callers fail closed).
 */
export function snapshotRepoRefState(root: string): string {
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const refs = execFileSync("git", ["for-each-ref"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	return `${head}\n${createHash("sha256").update(refs).digest("hex")}`;
}

/**
 * Porcelain + HEAD snapshot of a registered sibling worktree (#510 round-2, finding 2b).
 * Branch-ref moves are visible in the shared ref store (covered by `snapshotRepoRefState` on the
 * main root); the per-worktree HEAD here additionally catches a commit made in a detached
 * sibling checkout, and the porcelain catches working-tree writes. Returns the GONE sentinel for
 * an absent root (gone at both endpoints compares equal, i.e. no delta); throws on a real
 * execution failure so callers fail closed.
 */
export function snapshotSiblingWorktree(root: string): string {
	const status = snapshotForbiddenRoot(root);
	if (status === FORBIDDEN_ROOT_GONE) return status;
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	return `${status}\n@${head}`;
}

export type MainCheckoutDeltaResult = { kind: "clean" } | { kind: "violation"; roots: readonly string[] } | { kind: "error"; message: string };

export interface MainCheckoutDeltaObserver {
	beforeTool(invocationId: string): MainCheckoutDeltaResult;
	afterTool(invocationId: string): MainCheckoutDeltaResult;
	finish(): MainCheckoutDeltaResult;
}

/** Attribute main-checkout Git-state deltas to individual mutating tool windows. */
export function createMainCheckoutDeltaObserver(root: string): MainCheckoutDeltaObserver {
	const mainRoot = resolve(root);
	const baselines = new Map<string, string>();
	let terminal: MainCheckoutDeltaResult | undefined;
	let accumulated: MainCheckoutDeltaResult = { kind: "clean" };

	const fail = (message: string): MainCheckoutDeltaResult => {
		if (accumulated.kind !== "error") accumulated = { kind: "error", message };
		return accumulated;
	};
	const snapshot = (): string | MainCheckoutDeltaResult => {
		try {
			const status = snapshotForbiddenRoot(mainRoot);
			// mainRepo is never GONE-tolerated: cwd lives inside it and it is hard-gated. If it ever
			// snapshots absent, fail closed rather than silently skipping the delta. (#308)
			if (status === FORBIDDEN_ROOT_GONE) return fail(`main checkout root vanished: ${mainRoot}`);
			return status;
		} catch (error) {
			return fail(error instanceof Error ? error.message : String(error));
		}
	};

	return {
		beforeTool(invocationId) {
			if (terminal) return terminal;
			if (!invocationId) return fail("confinement attribution received a mutating tool without an invocation id");
			if (baselines.has(invocationId)) return fail(`duplicate confinement attribution invocation id: ${invocationId}`);
			const baseline = snapshot();
			if (typeof baseline !== "string") return baseline;
			baselines.set(invocationId, baseline);
			return accumulated;
		},
		afterTool(invocationId) {
			if (terminal) return terminal;
			const baseline = baselines.get(invocationId);
			if (baseline === undefined) return fail(`missing confinement attribution baseline for invocation id: ${invocationId || "<missing>"}`);
			baselines.delete(invocationId);
			const after = snapshot();
			if (typeof after !== "string") return after;
			if (after !== baseline && accumulated.kind !== "error") accumulated = { kind: "violation", roots: [mainRoot] };
			return accumulated;
		},
		finish() {
			if (terminal) return terminal;
			if (baselines.size > 0 && accumulated.kind !== "error") {
				accumulated = { kind: "error", message: `unclosed confinement attribution invocation ids: ${[...baselines.keys()].sort().join(", ")}` };
			}
			terminal = accumulated;
			return terminal;
		},
	};
}
