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
	/**
	 * #435: opt-in to auditing `cwd` itself instead of auto-exempting it. Default `false`
	 * keeps the historical contract — a step's own cwd is always exempt because its writes
	 * are legitimate. Set `true` for a step whose cwd is execution context but not an
	 * authorized Git write root: `pick` runs with `cwd === mainRepo` yet has a read-only
	 * main-tree contract (its only legitimate writes are gitignored `.dev/` bookkeeping),
	 * so its own cwd must stay audited. The independent `ownWorktree`, active-peer, session,
	 * and ephemeral-review-seat exemptions are unaffected.
	 */
	auditCwd?: boolean;
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
	const exempt = new Set([...(args.auditCwd ? [] : [cwdAbs]), ...(args.ownWorktree ? [resolve(args.ownWorktree)] : []), ...[...(args.activeWorktrees ?? [])].map((w) => resolve(w)), ...sessionExempt]);
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
