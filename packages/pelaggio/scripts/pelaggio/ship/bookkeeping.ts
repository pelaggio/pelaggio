import { execSync } from "node:child_process";
import type { RoadmapSource } from "../roadmap/index.js";
import { withMutationLock } from "../roadmap/mutation-lock.js";
import { repairMainNodeModules } from "../worktree-deps.js";

// ── Pipeline-owned deterministic bookkeeping tail (direct-push) ─────────
//
// For the `direct-push` ship target the agent's job ends at the merge: squash
// → merge into local `main` → post-merge verification → STOP. Everything past
// the merge — recovering stray MAIN_REPO dirt, mark-done, archive-plan, the
// single push, and worktree/branch cleanup — is discretionary tail work that a
// budget/turn-capped `ship` step kept dropping while still reporting success.
//
// This module lifts that tail out of the model and into deterministic,
// **zero-turn, idempotent, best-effort** code that runs once the merge has
// landed. Every step is wrapped so an already-done item, a gone worktree, or an
// unreachable remote is a logged no-op — overshoot (agent also did the work) is
// swallowed; undershoot (agent stopped early) is completed here. The tail is
// the guarantee; the skill/prompt edits merely stop the agent wasting budget on
// work this will redo.

/** Command runner seam — returns stdout. Injectable for tests. */
export type ExecFn = (cmd: string, cwd: string) => string;
/** `git status --porcelain` seam. Injectable for tests. */
export type StatusFn = (cwd: string) => string;
/** Mutation-lock seam. Injectable for tests whose mainRepo is a fake path. */
export type LockFn = <T>(repo: string, fn: () => Promise<T> | T) => Promise<T>;

const defaultExec: ExecFn = (cmd, cwd) => execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const defaultStatus: StatusFn = (cwd) => execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();

export interface ShipBookkeepingCtx {
	/** The real (non-worktree) repo where `main` lives. */
	mainRepo: string;
	/** The feature worktree. Equal to `mainRepo` in `--no-worktree` mode. */
	worktree: string;
	/** Feature branch name (e.g. `feat/tool-99`). */
	branch: string;
	itemId: string;
}

export interface ShipBookkeepingDeps {
	/** Adapter for mark-done / archive-plan. In production this is the same source the pipeline resolved. */
	roadmap: Pick<RoadmapSource, "markDone" | "archivePlan">;
	log: (msg: string) => void;
	exec?: ExecFn;
	status?: StatusFn;
	lock?: LockFn;
	/** Repair MAIN's `node_modules` symlinks after worktree removal. Injectable for tests. */
	repairMain?: (mainRepo: string) => void;
	/**
	 * Optional post-merge verification of MAIN_REPO, re-run only after a push
	 * rejection forces `git pull` to integrate diverged origin commits. Returns
	 * true when the (now-merged) tree still passes. There is no consumer-agnostic
	 * verification command the tail can hardcode (verification is agent-delegated
	 * via `_rubric.md`), so production leaves this unset — the primary guard is
	 * that the tail only runs on an already-verified `ship.ok` merge (pipeline
	 * gate) and a diverging origin is rare in the single-maintainer direct-push
	 * model. Injectable so the pull+verify path is regression-tested.
	 */
	verify?: (mainRepo: string) => boolean;
}

export interface ShipBookkeepingResult {
	/** Stray MAIN_REPO changes were committed (never discarded). */
	recovered: boolean;
	markedDone: boolean;
	archived: boolean;
	/** `git push origin main` ultimately succeeded. */
	pushed: boolean;
	/** Worktree/branch cleanup succeeded (reflects actual worktree + branch removal, not merely "attempted"). */
	cleanedUp: boolean;
	/** Non-blocking roadmap mutations that remain to be completed manually. */
	warnings: string[];
	/**
	 * Overall success. False when a blocking failure prevented safe completion —
	 * a push failure or pull conflict. Roadmap mutation failures are warnings once
	 * the verified merge exists. On `ok:false` the feature branch is left intact
	 * and the merge is recoverable on local `main`.
	 */
	ok: boolean;
	/** Legible reason when `ok` is false. */
	error?: string;
}

function short(e: unknown): string {
	return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}

/**
 * Commit any uncommitted MAIN_REPO changes as a recovery commit — **never
 * discard**. Used both as the pre-ship guard (so the agent's merge never faces
 * a dirty tree and never has cause to `git checkout`/`reset` it away) and as
 * step 1 of the tail. Returns true iff a commit was created.
 */
export async function commitStrayBookkeeping(mainRepo: string, itemId: string, log: (msg: string) => void, io: { exec?: ExecFn; status?: StatusFn; lock?: LockFn } = {}): Promise<boolean> {
	const exec = io.exec ?? defaultExec;
	const status = io.status ?? defaultStatus;
	const lock = io.lock ?? withMutationLock;
	// `git add -A` in the shared MAIN_REPO must not run while another process's
	// locked roadmap mutation is between its file writes and its own commit —
	// the sweep would steal those edits into this recovery commit and make the
	// rightful holder's commit fail. Same lock the adapter mutations take.
	try {
		return await lock(mainRepo, () => {
			let dirty: string;
			try {
				dirty = status(mainRepo);
			} catch {
				return false;
			}
			if (!dirty) return false;
			log(`recovering ${dirty.split("\n").length} stray MAIN_REPO change(s) as a commit (never discarded)`);
			// Stage everything, then unstage .dev (pelaggio's own runtime bookkeeping —
			// e.g. the mutation lock this very call holds — must never land in a "stray
			// user changes" commit). `git add -A -- . ':(exclude).dev'` used to do this
			// in one shot, but git treats *naming* an already-gitignored path via
			// pathspec exclude magic as an error ("paths are ignored by one of your
			// .gitignore files"), which aborted the whole recover-commit whenever .dev
			// (or any other ignored path) was present. `git reset -- .dev` has no such
			// failure mode: it's a harmless no-op whether .dev was staged, untouched, or
			// absent.
			try {
				exec("git add -A && git reset -- .dev", mainRepo);
			} catch (e) {
				log(`⚠ recover-commit failed: ${short(e)}`);
				return false;
			}
			// Guard against "nothing to commit": if everything dirty turned out to be
			// gitignored, `git add -A` stages nothing and a plain `git commit` would
			// error. Skip cleanly instead of surfacing that as a failure.
			let staged: string;
			try {
				staged = exec("git diff --cached --name-only", mainRepo);
			} catch (e) {
				log(`⚠ recover-commit failed: ${short(e)}`);
				return false;
			}
			if (!staged) return false;
			try {
				exec(`git commit -m ${JSON.stringify(`chore: recover uncommitted bookkeeping (${itemId})`)} --no-verify`, mainRepo);
				return true;
			} catch (e) {
				log(`⚠ recover-commit failed: ${short(e)}`);
				return false;
			}
		});
	} catch (e) {
		log(`⚠ recover-commit skipped (mutation lock): ${short(e)}`);
		return false; // best-effort contract preserved: lock timeout ≠ tail failure
	}
}

/**
 * Push `main` with a single pull + retry on rejection. Returns a distinct
 * outcome so callers can react:
 *  - `{ ok: true }` — pushed.
 *  - `{ ok: false, conflict: true }` — `git pull` hit a merge conflict; the
 *    merge was aborted (MAIN_REPO left clean), nothing pushed. The caller MUST
 *    NOT proceed to cleanup over a would-be-conflicted tree.
 *  - `{ ok: false }` — push rejected and retry failed (or post-pull verify
 *    failed); the merge is safe on local `main` and recoverable.
 */
function pushMain(mainRepo: string, exec: ExecFn, log: (msg: string) => void, verify?: (mainRepo: string) => boolean): { ok: boolean; conflict?: boolean; error?: string } {
	try {
		exec("git push origin main", mainRepo);
		return { ok: true };
	} catch {
		log("push rejected — origin diverged; pulling to integrate, then retrying once");
		try {
			exec("git pull --no-rebase origin main", mainRepo);
		} catch (e) {
			// A merge conflict leaves MAIN_REPO half-merged. Abort so we never push
			// or clean up over a conflicted tree, and surface a distinct error the
			// pipeline can route to /shipwreck.
			try {
				exec("git merge --abort", mainRepo);
			} catch {
				// Nothing to abort (pull failed before starting a merge) — tree is clean.
			}
			const error = `push failed: origin diverged and 'git pull' conflicted (${short(e)}); merge aborted — local main holds the ship, resolve origin/main manually`;
			log(`⚠ ${error}`);
			return { ok: false, conflict: true, error };
		}
		// The pull merged diverged origin commits we have not verified. Re-run
		// verification when a hook is provided; without one, defer to the pipeline's
		// upstream `ship.ok` gate (see `verify` doc on ShipBookkeepingDeps).
		if (verify && !verify(mainRepo)) {
			const error = "push failed: verification did not pass after integrating origin/main — not pushing an unverified auto-merge (local main holds the ship)";
			log(`⚠ ${error}`);
			return { ok: false, error };
		}
		try {
			exec("git push origin main", mainRepo);
			return { ok: true };
		} catch (e) {
			const error = `push failed after pull + retry (${short(e)}) — merge + bookkeeping are committed on local main and recoverable`;
			log(`⚠ ${error}`);
			return { ok: false, error };
		}
	}
}

/**
 * Run the deterministic bookkeeping tail after a `direct-push` merge has landed
 * on local `main`. Ordered: recover stray dirt → mark-done → archive-plan →
 * push → cleanup.
 *
 * Roadmap mutations are independent and best-effort after the verified merge.
 * Push is the completion boundary: only a push/integration failure returns
 * `ok:false` and preserves the feature branch for recovery. Once origin contains
 * the merge, cleanup proceeds even when roadmap metadata needs manual repair.
 */
export async function runShipBookkeeping(ctx: ShipBookkeepingCtx, deps: ShipBookkeepingDeps): Promise<ShipBookkeepingResult> {
	const { mainRepo, worktree, branch, itemId } = ctx;
	const { roadmap, log } = deps;
	const exec = deps.exec ?? defaultExec;
	const status = deps.status ?? defaultStatus;
	const repairMain = deps.repairMain ?? repairMainNodeModules;
	const inWorktree = worktree !== mainRepo;
	const warnings: string[] = [];
	let markedDone = false;
	let archived = false;

	// 1. Recover stray MAIN_REPO changes (never discard).
	const recovered = await commitStrayBookkeeping(mainRepo, itemId, log, { exec, status, ...(deps.lock ? { lock: deps.lock } : {}) });

	// 2. Mark done. A failure leaves metadata incomplete but must not suppress the
	//    verified feature push. The idempotent command can be rerun after repair.
	try {
		await roadmap.markDone(itemId);
		markedDone = true;
	} catch (e) {
		const warning = `mark-done failed (${short(e)}); fix roadmap permissions and rerun 'npx pelaggio roadmap mark-done ${itemId}' from the repository root`;
		warnings.push(warning);
		log(`⚠ ${warning}`);
	}

	// 3. Archive independently, even when mark-done failed.
	try {
		await roadmap.archivePlan(itemId);
		archived = true;
	} catch (e) {
		const warning = `archive-plan failed (${short(e)}); fix roadmap permissions and rerun 'npx pelaggio roadmap archive-plan ${itemId}' from the repository root`;
		warnings.push(warning);
		log(`⚠ ${warning}`);
	}

	// 4. Push merge + bookkeeping together. A push failure or pull conflict is
	//    blocking — the merge is safe on local `main`, but we neither claim the
	//    cycle shipped nor destroy the branch.
	const push = pushMain(mainRepo, exec, log, deps.verify);
	if (!push.ok) {
		return { recovered, markedDone, archived, pushed: false, cleanedUp: false, warnings, ok: false, error: push.error };
	}

	// 5. Cleanup — now that push succeeded it is safe to destroy the feature
	//    branch/worktree. Repair MAIN's node_modules BEFORE
	//    removing the worktree (else symlinks pointing into it break). Each step is
	//    best-effort: a gone worktree / already-deleted branch is a no-op, and
	//    `cleanedUp` reflects what actually happened rather than a hardcoded true.
	let worktreeRemoved = false;
	if (inWorktree) {
		try {
			repairMain(mainRepo);
		} catch (e) {
			log(`repair-main skipped (${short(e)})`);
		}
		try {
			exec(`git worktree remove ${JSON.stringify(worktree)} --force`, mainRepo);
			worktreeRemoved = true;
		} catch (e) {
			log(`worktree remove skipped (${short(e)})`);
		}
	}
	let branchDeleted = false;
	try {
		exec(`git branch -d ${JSON.stringify(branch)}`, mainRepo);
		branchDeleted = true;
	} catch (e) {
		log(`branch delete skipped (${short(e)})`);
	}
	try {
		exec(`git push origin --delete ${JSON.stringify(branch)}`, mainRepo);
	} catch {
		// Remote branch may not exist / no remote — silent, matches SKILL.md's `2>/dev/null`.
	}

	const cleanedUp = (!inWorktree || worktreeRemoved) && branchDeleted;
	log(`bookkeeping tail: recovered=${recovered} markedDone=${markedDone} archived=${archived} pushed=true cleanedUp=${cleanedUp} warnings=${warnings.length}`);
	return { recovered, markedDone, archived, pushed: true, cleanedUp, warnings, ok: true };
}
