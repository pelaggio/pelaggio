import type { ResolvedConfig } from "../config.js";
import { type CharterExecutorResult, executeCharterReview } from "../review/charter-executor.js";
import { type CharterReviewVerdict, charterRecordInputsMatch, readCharterReviewRecord } from "../review/charter-record.js";
import type { CreateItemOpts, RoadmapItem, RoadmapItemStatus, RoadmapSource, Scope } from "./types.js";

/**
 * The one create-time charter-review gate (#367). Every `createItem` — human charters, both pipeline
 * deferred markers — routes through here. It owns all scope/floor decisions, runs the executor when the
 * resolved policy requires it, applies advisory verdict semantics, and is the ONLY code allowed to mint a
 * `reviewDigest` or force `deferred: true`. A review may recommend deferral but never vetoes creation;
 * it then delegates exactly once to the adapter's raw `createItem`.
 */

const SCOPE_RANK: Record<Scope, number> = { XS: 0, S: 1, M: 2, L: 3, XL: 4 };

/** The settled scope threshold at/above which a `triad` policy runs the panel at direct create. */
const REVIEW_FLOOR_SCOPE: Scope = "M";

export interface CharterGateContext {
	config: ResolvedConfig;
	profile?: string;
	cwd?: string;
	/** Injected executor for tests (defaults to {@link executeCharterReview}). */
	executor?: (opts: Parameters<typeof executeCharterReview>[0]) => Promise<CharterExecutorResult>;
}

/** True when a direct (non-harness-deferral) create must run the panel: triad policy AND scope ≥ M. */
export function charterReviewRequired(level: string, scope: Scope | undefined): boolean {
	// Ambiguous/absent scope is treated as M (fail toward review), matching the "scope at least M" rule.
	const effectiveScope = scope ?? REVIEW_FLOOR_SCOPE;
	return level === "triad" && SCOPE_RANK[effectiveScope] >= SCOPE_RANK[REVIEW_FLOOR_SCOPE];
}

/**
 * Gate + create. Direct creates above the floor execute the panel exactly once, supply only the
 * internally-minted digest, and are forced deferred on any non-ship verdict (advisory, never a veto).
 * Sub-floor / `off` creates skip execution but still record the declared scope + resolved level. The
 * two pipeline marker sites pass `origin: "harness-deferral"`: minted deferred with review skipped now
 * (activation reviews later, at every declared scope).
 */
export async function createReviewedItem(source: RoadmapSource, opts: CreateItemOpts, ctx: CharterGateContext): Promise<RoadmapItem> {
	const charter = ctx.config.review.charter;
	const level = charter.effectiveLevel;
	// Normalize the public `description` spelling into the settled `body` once, at the gate boundary.
	const body = opts.body ?? opts.description ?? "";
	const scope = opts.scope;

	// Harness deferral (the two pipeline marker sites): never review at create; mint deferred and let
	// activation review the then-current body regardless of declared scope. Non-fatal by the caller.
	if (opts.origin === "harness-deferral") {
		return source.createItem(stampProvenance(opts, body, { deferred: true, reviewLevel: level, origin: "harness-deferral" }));
	}

	if (charterReviewRequired(level, scope)) {
		const executor = ctx.executor ?? executeCharterReview;
		const result = await executor({
			title: opts.title,
			body,
			...(scope ? { scope } : {}),
			origin: "create",
			policy: charter,
			config: ctx.config,
			...(ctx.profile ? { profile: ctx.profile } : {}),
			...(ctx.cwd ? { cwd: ctx.cwd } : {}),
		});
		// ship ⇒ create directly; every other verdict (defer / degenerate / execution-error) forces
		// deferred — driver failure is advisory for direct creation, never a veto of creation itself.
		const deferred = result.verdict !== "ship";
		return source.createItem(stampProvenance(opts, body, { deferred, reviewDigest: result.digest, reviewLevel: level }));
	}

	// Sub-floor or level=off: review-skipped, but record declared scope + resolved level (residual channel).
	return source.createItem(stampProvenance(opts, body, { deferred: false, reviewLevel: level }));
}

export interface ActivationResult {
	activated: boolean;
	item: RoadmapItemStatus;
	verdict?: CharterReviewVerdict;
	/** Human reason on a failed activation (non-ship / degenerate / error / not-found). */
	reason?: string;
}

/**
 * Activate (un-defer) a deferred item behind a fresh review of its THEN-CURRENT body (#367). A current,
 * valid, body/title/config-matching ship record avoids duplicate execution; anything stale/missing/
 * mismatched triggers a backfill review regardless of declared scope. On `ship` the adapter appends
 * provenance and clears deferred atomically; on any non-ship the item stays deferred with a typed andon
 * and the result is a failure (the caller must not proceed to claim / must return nonzero). Declared
 * sub-floor scope is never trusted to skip the review.
 */
export async function activateDeferredItem(source: RoadmapSource, id: string, ctx: CharterGateContext): Promise<ActivationResult> {
	const charter = ctx.config.review.charter;
	const item = await source.getItem(id);
	if (!item) return { activated: false, item: { id, title: "", deps: "", sourceRef: "", status: "unknown" }, reason: `not found: ${id}` };
	if (!item.deferred) return { activated: true, item };

	const title = item.title;
	const body = item.body ?? "";
	// Activation ALWAYS forces the triad panel, at every declared scope — the deferred exemption is the
	// one documented exception to the M+ create-time threshold.
	const activationPolicy = { ...charter, effectiveLevel: "triad" as const };

	let digest = item.reviewDigest;
	let verdict: CharterReviewVerdict;
	const existing = digest ? readCharterReviewRecord(ctx.config.repo, digest) : null;
	if (existing && existing.verdict === "ship" && charterRecordInputsMatch(existing, title, body, activationPolicy)) {
		verdict = "ship";
	} else {
		const executor = ctx.executor ?? executeCharterReview;
		const result = await executor({
			title,
			body,
			...(item.scope ? { scope: item.scope } : {}),
			origin: "activation",
			policy: activationPolicy,
			config: ctx.config,
			...(ctx.profile ? { profile: ctx.profile } : {}),
			...(ctx.cwd ? { cwd: ctx.cwd } : {}),
		});
		digest = result.digest;
		verdict = result.verdict;
	}

	if (verdict === "ship" && digest) {
		const activated = await source.activateItem(id, { reviewDigest: digest, level: "triad", ...(item.scope ? { scope: item.scope } : {}), deferred: false });
		return { activated: true, item: activated, verdict };
	}
	return { activated: false, item, verdict, reason: `activation review did not ship (verdict ${verdict}); item stays deferred with a typed andon` };
}

/** Overlay the gate-owned provenance fields onto the opts handed to the adapter. */
function stampProvenance(opts: CreateItemOpts, body: string, minted: { deferred: boolean; reviewLevel: string; reviewDigest?: string; origin?: "harness-deferral" }): CreateItemOpts {
	return {
		...opts,
		description: body,
		body,
		deferred: minted.deferred,
		reviewLevel: minted.reviewLevel,
		...(minted.reviewDigest ? { reviewDigest: minted.reviewDigest } : {}),
		...(minted.origin ? { origin: minted.origin } : { origin: undefined }),
	};
}
