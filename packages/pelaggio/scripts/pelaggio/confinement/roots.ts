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
	/** Predicate: is this root a harness-managed authoring-review seat? */
	isAuthoringReviewSeatPath: (root: string) => boolean;
	/** #131: under `--parallel`, the worktrees of peer cycles currently running. A peer's
	 *  legitimate self-write must not trip this cycle's whole-tree snapshot; cross-tree
	 *  corruption is caught by the capability/write-set boundary, not this snapshot.
	 *  `mainRepo` is never a member, so it stays hard-gated below. */
	activeWorktrees?: Iterable<string>;
}): string[] {
	const cwdAbs = resolve(args.cwd);
	const mainAbs = resolve(args.mainRepo);
	const exempt = new Set([cwdAbs, ...(args.ownWorktree ? [resolve(args.ownWorktree)] : []), ...[...(args.activeWorktrees ?? [])].map((w) => resolve(w))]);
	const seen = new Set<string>();
	const roots: string[] = [];
	for (const root of args.worktrees) {
		const abs = resolve(root);
		if (seen.has(abs) || exempt.has(abs)) continue;
		if (args.allowDirtyMain && abs === mainAbs) continue;
		// #269: peer authoring-review seats are throwaway per-seat checkouts; a
		// dirty peer seat must not trip a concurrent reviewer's confinement audit.
		if (args.isAuthoringReviewSeatPath(abs)) continue;
		seen.add(abs);
		roots.push(root);
	}
	return roots;
}
