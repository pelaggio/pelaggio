/**
 * Pure provider capability matcher + authoring-review seating overlay (#337 / ADR-0020).
 *
 * - Hard predicates filter fail-closed (discriminated ineligible result, never an empty array).
 * - Soft predicates stable-partition native matches ahead of degraded candidates, preserving
 *   configured order within each group.
 * - Descriptors are injected; this module never imports `getProvider` (avoids config/registry cycles).
 * - Fixed authoring seats stay authoritative — no pool draw from `resolveDriverCandidates`.
 */

import type { AuthoringReviewConfig, ResolvedConfig, ReviewSlot, StepSettings } from "./config.js";
import { resolveStepSettings } from "./config.js";
import type { CapabilityAxis, CapabilityCandidate, CapabilityPredicate, CapabilityRealization, CapabilityRouteResult, ProviderCapabilities, ProviderName } from "./types.js";

// ── Per-axis matching ──────────────────────────────────────────────────

function hasIsolation(caps: ProviderCapabilities, required: readonly string[]): boolean {
	return required.every((mech) => (caps.isolation as readonly string[]).includes(mech));
}

/** True when the candidate fully satisfies the predicate (hard or soft native match). */
export function matchesCapabilityPredicate(caps: ProviderCapabilities, predicate: CapabilityPredicate): boolean {
	if (predicate.semanticDeny !== undefined && caps.semanticDeny !== predicate.semanticDeny) return false;
	if (predicate.isolation !== undefined && !hasIsolation(caps, predicate.isolation)) return false;
	if (predicate.costMeter !== undefined && caps.costMeter.kind !== predicate.costMeter) return false;
	if (predicate.cacheReporting !== undefined && caps.cacheReporting !== predicate.cacheReporting) return false;
	if (predicate.outputTransport !== undefined && caps.outputTransport !== predicate.outputTransport) return false;
	if (predicate.sessionResume !== undefined && caps.sessionResume !== predicate.sessionResume) return false;
	return true;
}

/** Soft axes the candidate fails to satisfy natively (empty = fully native for the soft set). */
export function softDegradedAxes(caps: ProviderCapabilities, soft: CapabilityPredicate | undefined): CapabilityAxis[] {
	if (!soft) return [];
	const degraded: CapabilityAxis[] = [];
	if (soft.semanticDeny !== undefined && caps.semanticDeny !== soft.semanticDeny) degraded.push("semanticDeny");
	if (soft.isolation !== undefined && !hasIsolation(caps, soft.isolation)) degraded.push("isolation");
	if (soft.costMeter !== undefined && caps.costMeter.kind !== soft.costMeter) degraded.push("costMeter");
	if (soft.cacheReporting !== undefined && caps.cacheReporting !== soft.cacheReporting) degraded.push("cacheReporting");
	if (soft.outputTransport !== undefined && caps.outputTransport !== soft.outputTransport) degraded.push("outputTransport");
	if (soft.sessionResume !== undefined && caps.sessionResume !== soft.sessionResume) degraded.push("sessionResume");
	return degraded;
}

export interface MatchEligibleOptions<T> {
	/** Ordered candidates (provider + opaque payload). Configured order is preserved within native/degraded groups. */
	candidates: readonly CapabilityCandidate<T>[];
	/** Capability descriptors keyed by provider — injected, never looked up from a registry. */
	capabilities: Readonly<Partial<Record<ProviderName, ProviderCapabilities>>>;
	/** Hard requirements: failing any removes the candidate; none remaining → ineligible. */
	hard?: CapabilityPredicate;
	/** Soft preferences: native matches rank ahead of degraded; degraded are retained. */
	soft?: CapabilityPredicate;
}

/**
 * Pure eligible-native resolver. Hard filters fail closed; soft preferences stable-partition.
 * Missing descriptors are treated as hard-ineligible (fail closed on unknown providers).
 */
export function matchEligibleProviders<T>(options: MatchEligibleOptions<T>): CapabilityRouteResult<T> {
	const hard = options.hard ?? {};
	const soft = options.soft;
	const retained: Array<{ candidate: CapabilityCandidate<T>; realization: CapabilityRealization }> = [];

	for (const candidate of options.candidates) {
		const caps = options.capabilities[candidate.provider];
		if (!caps) {
			// Unknown / missing descriptor — hard ineligible for this candidate.
			continue;
		}
		if (!matchesCapabilityPredicate(caps, hard)) continue;
		const degradedAxes = softDegradedAxes(caps, soft);
		retained.push({
			candidate,
			realization: {
				provider: candidate.provider,
				mode: degradedAxes.length === 0 ? "native" : "degraded",
				degradedAxes,
			},
		});
	}

	if (retained.length === 0) {
		const hardBits: string[] = [];
		if (hard.semanticDeny !== undefined) hardBits.push(`semanticDeny=${hard.semanticDeny}`);
		if (hard.isolation?.length) hardBits.push(`isolation=[${hard.isolation.join(",")}]`);
		if (hard.costMeter !== undefined) hardBits.push(`costMeter=${hard.costMeter}`);
		if (hard.cacheReporting !== undefined) hardBits.push(`cacheReporting=${hard.cacheReporting}`);
		if (hard.outputTransport !== undefined) hardBits.push(`outputTransport=${hard.outputTransport}`);
		if (hard.sessionResume !== undefined) hardBits.push(`sessionResume=${hard.sessionResume}`);
		const req = hardBits.length > 0 ? hardBits.join(", ") : "no candidates";
		return { ok: false, reason: `no eligible provider for requirements: ${req}` };
	}

	// Soft native preference: stable-partition natives first, then degraded, preserving order within each.
	const natives = retained.filter((r) => r.realization.mode === "native");
	const degraded = retained.filter((r) => r.realization.mode === "degraded");
	const ordered = soft ? [...natives, ...degraded] : retained;

	return {
		ok: true,
		candidates: ordered.map((r) => r.candidate),
		realizations: ordered.map((r) => r.realization),
	};
}

// ── Authoring-review seating overlay ───────────────────────────────────

export interface AuthoringSeatAuthor {
	provider: ProviderName;
	model?: string;
}

export interface AuthoringSeatRealization {
	role: "author" | "reviewer" | "judge";
	seatId: string;
	provider: ProviderName;
	mode: "native" | "degraded";
	degradedAxes: readonly CapabilityAxis[];
}

export type AuthoringSeatResult =
	| {
			ok: true;
			policy: AuthoringReviewConfig;
			author: AuthoringSeatAuthor;
			realizations: AuthoringSeatRealization[];
	  }
	| { ok: false; reason: string };

export interface ResolveAuthoringReviewOptions {
	config: ResolvedConfig;
	profile: string;
	/** Artifact author identity — never reassigned from an implement pool. */
	author: AuthoringSeatAuthor;
	/** Injected descriptors (callers pass `getProvider(name).capabilities` for each registered provider). */
	capabilities: Readonly<Partial<Record<ProviderName, ProviderCapabilities>>>;
	/**
	 * Optional hard capability profile for reviewer/judge seats. Ordinary authoring review
	 * leaves this empty (soft preferences only) so non-Claude seats remain first-class.
	 */
	reviewHard?: CapabilityPredicate;
	/** Soft preferences for reviewer/judge seats (native preferred, degraded retained). */
	reviewSoft?: CapabilityPredicate;
	/** Optional hard profile for the assigned author (write-capable seat). */
	authorHard?: CapabilityPredicate;
	/** Soft preferences for the assigned author. */
	authorSoft?: CapabilityPredicate;
}

function fillSlot(slot: ReviewSlot, defaults: StepSettings): ReviewSlot {
	if (slot.provider === "codex") {
		const codexModel = slot.codexModel ?? defaults.codexModel;
		return codexModel ? { ...slot, codexModel } : { ...slot };
	}
	const model = slot.model ?? defaults.model;
	return model ? { ...slot, model } : { ...slot };
}

function seatRealization(role: AuthoringSeatRealization["role"], seatId: string, provider: ProviderName, caps: ProviderCapabilities | undefined, soft: CapabilityPredicate | undefined): AuthoringSeatRealization {
	if (!caps) {
		return { role, seatId, provider, mode: "degraded", degradedAxes: soft ? (Object.keys(soft) as CapabilityAxis[]) : [] };
	}
	const degradedAxes = softDegradedAxes(caps, soft);
	return {
		role,
		seatId,
		provider,
		mode: degradedAxes.length === 0 ? "native" : "degraded",
		degradedAxes,
	};
}

/**
 * Capability-aware authoring-review seating overlay.
 *
 * Fixed configured seats stay authoritative (no pool draw). Settings inheritance:
 * - Reviewer models from `pr-review`
 * - Judge models from `pr-verify` (matches the step the judge actually runs as)
 * - Author identity is the assigned implementation author (never reassigned)
 *
 * Review-only policy: exclude artifact author from reviewer seats, require distinct
 * reviewer providers, fill remaining fixed seats or fail closed, prefer diversity
 * (already encoded as unique providers + soft native preference).
 */
export function resolveAuthoringReviewConfig(options: ResolveAuthoringReviewOptions): AuthoringSeatResult {
	const { config, profile, author, capabilities } = options;
	const policy = config.review.authoring;
	const reviewHard = options.reviewHard ?? {};
	const reviewSoft = options.reviewSoft ?? {};
	const authorHard = options.authorHard ?? {};
	const authorSoft = options.authorSoft ?? {};

	// Author eligibility: never reassign; refuse when the assigned author is hard-ineligible.
	const authorCaps = capabilities[author.provider];
	if (!authorCaps) return { ok: false, reason: `author provider ${author.provider} has no capability descriptor` };
	if (!matchesCapabilityPredicate(authorCaps, authorHard)) {
		return { ok: false, reason: `assigned author provider ${author.provider} is ineligible for authoring requirements` };
	}

	const reviewerDefaults = resolveStepSettings(config, profile, "pr-review");
	const judgeDefaults = resolveStepSettings(config, profile, "pr-verify");

	// Exclude the artifact author from reviewer seats (fixed seats; no pool replacement).
	const configuredReviewers = policy.reviewers;
	const eligibleReviewerSlots = configuredReviewers.filter((slot) => slot.provider !== author.provider);
	if (eligibleReviewerSlots.length === 0) {
		return { ok: false, reason: `no reviewer seats remain after excluding author provider ${author.provider}` };
	}
	// Distinct providers (defense in depth; config parse already enforces uniqueness).
	const reviewerProviders = eligibleReviewerSlots.map((s) => s.provider);
	if (new Set(reviewerProviders).size !== reviewerProviders.length) {
		return { ok: false, reason: "reviewer providers must be distinct" };
	}

	// Capability filter on each remaining fixed seat — hard fail drops the seat; if any
	// configured-after-author-exclusion seat fails hard requirements, fail closed rather
	// than inventing a replacement from a pool.
	const filledReviewers: ReviewSlot[] = [];
	const realizations: AuthoringSeatRealization[] = [seatRealization("author", "author", author.provider, authorCaps, authorSoft)];

	for (const slot of eligibleReviewerSlots) {
		const caps = capabilities[slot.provider];
		if (!caps) return { ok: false, reason: `reviewer provider ${slot.provider} has no capability descriptor` };
		if (!matchesCapabilityPredicate(caps, reviewHard)) {
			return { ok: false, reason: `reviewer seat ${slot.id} (${slot.provider}) is ineligible for review requirements` };
		}
		const filled = fillSlot(slot, reviewerDefaults);
		filledReviewers.push(filled);
		realizations.push(seatRealization("reviewer", slot.id, slot.provider, caps, reviewSoft));
	}

	// Judge seat
	const judgeSlot = policy.judge;
	const judgeCaps = capabilities[judgeSlot.provider];
	if (!judgeCaps) return { ok: false, reason: `judge provider ${judgeSlot.provider} has no capability descriptor` };
	if (!matchesCapabilityPredicate(judgeCaps, reviewHard)) {
		return { ok: false, reason: `judge seat ${judgeSlot.id} (${judgeSlot.provider}) is ineligible for review requirements` };
	}
	const filledJudge = fillSlot(judgeSlot, judgeDefaults);
	realizations.push(seatRealization("judge", judgeSlot.id, judgeSlot.provider, judgeCaps, reviewSoft));

	// Diversity preference is soft: configured seats already use distinct providers; when
	// prefer is set we do not invent replacements — we only refuse if uniqueness broke.
	// (providerDiversity is fixed to "prefer" in AuthoringReviewConfig.)

	return {
		ok: true,
		policy: {
			...policy,
			reviewers: filledReviewers,
			judge: filledJudge,
		},
		author,
		realizations,
	};
}

/** Build a complete capability map from an injected lookup (e.g. `getProvider`). */
export function capabilityMapFrom(lookup: (name: ProviderName) => { capabilities: ProviderCapabilities }, names: readonly ProviderName[]): Record<ProviderName, ProviderCapabilities> {
	const out = {} as Record<ProviderName, ProviderCapabilities>;
	for (const name of names) out[name] = lookup(name).capabilities;
	return out;
}
