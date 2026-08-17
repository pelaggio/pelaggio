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
import { modelForProvider, resolveStepSettings } from "./config.js";
import { DIRECT_KEY_AUTH_PROVIDERS, PROVIDER_KEY_ENV } from "./secret-hygiene.js";
import type { CapabilityAxis, CapabilityCandidate, CapabilityPredicate, CapabilityRealization, CapabilityRouteResult, ProviderCapabilities, ProviderName } from "./types.js";

// ── Per-axis matching ──────────────────────────────────────────────────

type AxisMatcher = (caps: ProviderCapabilities, predicate: CapabilityPredicate) => boolean | undefined;

const AXIS_MATCHERS = {
	semanticDeny: (caps, predicate) => (predicate.semanticDeny === undefined ? undefined : caps.semanticDeny === predicate.semanticDeny),
	isolation: (caps, predicate) => (predicate.isolation === undefined ? undefined : predicate.isolation.every((mechanism) => caps.isolation.includes(mechanism))),
	costMeter: (caps, predicate) => (predicate.costMeter === undefined ? undefined : caps.costMeter.kind === predicate.costMeter),
	cacheReporting: (caps, predicate) => (predicate.cacheReporting === undefined ? undefined : caps.cacheReporting === predicate.cacheReporting),
	outputTransport: (caps, predicate) => (predicate.outputTransport === undefined ? undefined : caps.outputTransport === predicate.outputTransport),
	sessionResume: (caps, predicate) => (predicate.sessionResume === undefined ? undefined : caps.sessionResume === predicate.sessionResume),
} satisfies Record<CapabilityAxis, AxisMatcher>;

const CAPABILITY_AXES = Object.keys(AXIS_MATCHERS) as CapabilityAxis[];
const CAPABILITY_AXIS_SET = new Set<string>(CAPABILITY_AXES);

function unknownPredicateAxis(predicate: CapabilityPredicate): string | undefined {
	return Object.keys(predicate).find((axis) => !CAPABILITY_AXIS_SET.has(axis));
}

/** True when the candidate fully satisfies the predicate (hard or soft native match). */
export function matchesCapabilityPredicate(caps: ProviderCapabilities, predicate: CapabilityPredicate): boolean {
	if (unknownPredicateAxis(predicate)) return false;
	return CAPABILITY_AXES.every((axis) => AXIS_MATCHERS[axis](caps, predicate) !== false);
}

/** Soft axes the candidate fails to satisfy natively (empty = fully native for the soft set). */
export function softDegradedAxes(caps: ProviderCapabilities, soft: CapabilityPredicate | undefined): CapabilityAxis[] {
	if (!soft) return [];
	const unknownAxis = unknownPredicateAxis(soft);
	if (unknownAxis) throw new Error(`unknown capability axis: ${unknownAxis}`);
	return CAPABILITY_AXES.filter((axis) => AXIS_MATCHERS[axis](caps, soft) === false);
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
	const unknownAxis = unknownPredicateAxis(hard) ?? (soft ? unknownPredicateAxis(soft) : undefined);
	if (unknownAxis) return { ok: false, reason: `unknown capability axis: ${unknownAxis}` };
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

export type AuthoringReviewExecutionResult =
	| { ok: true; enabled: false }
	| {
			ok: true;
			enabled: true;
			policy: AuthoringReviewConfig;
			softened: string[];
			/** Attestation-suppressed unattended signals (see `detectUnattendedSignals`) — carried so the resolution site can log them into the cycle log. */
			suppressedSignals: string[];
	  }
	| { ok: false; reason: string };

/**
 * Deterministic evidence for the `contained-execution.md` local/unattended boundary.
 * `local` subscription auth is only defensible for operator-attended execution, so every
 * field is a positive signal that no operator is (verifiably) attending this run.
 */
export interface UnattendedSignalContext {
	/** CI / `--no-worktree` / `PELAGGIO_SINGLE_SHOT` single-shot execution. */
	singleShot: boolean;
	/**
	 * Resolved cycle budget > 1 (subsumes `--parallel`, which floors the cycle count).
	 * A multi-cycle campaign is at-scale execution the harness cannot verify as attended.
	 */
	multiCycle: boolean;
	/**
	 * Injected environment. `PELAGGIO_SUPERVISED_RUN=1` marks daemon (server Supervisor)-spawned
	 * children. `PELAGGIO_OPERATOR_ATTENDED=1` (exact value) is the per-invocation operator
	 * attestation that disambiguates the headless/TTY signal — see `detectUnattendedSignals`.
	 */
	env: NodeJS.ProcessEnv;
	/**
	 * `process.stdout.isTTY === true` at the entrypoint. Cron/headless/redirected runs have
	 * no interactive TTY; per `contained-execution.md` those are keys-required contexts, so a
	 * missing TTY fails closed even when output is merely piped through `tee` — unless the
	 * operator attests attendance via `PELAGGIO_OPERATOR_ATTENDED=1` (suppression is recorded,
	 * never silent).
	 */
	stdoutIsTTY: boolean;
}

/** Audit line recorded (and logged at resolution time) whenever the attestation suppresses the TTY signal. */
export const OPERATOR_ATTESTED_TTY_SUPPRESSION = "headless TTY signal suppressed by PELAGGIO_OPERATOR_ATTENDED attestation";

export interface UnattendedSignalReport {
	/** Positive unattended-execution signals; empty means verifiably attended context. */
	signals: string[];
	/**
	 * Signals suppressed by an explicit per-invocation operator attestation — audit evidence,
	 * threaded to the cycle log so every attested run is reconstructible after the fact.
	 * Only the headless/TTY signal is attestable.
	 */
	suppressed: string[];
}

/**
 * Pure fail-closed detector: returns the (possibly empty) list of unattended-execution
 * signals plus any attestation-suppressed signals. An empty `signals` list means
 * "attended interactive single-cycle run" — the only context where
 * `review.authoring.enabled=local` subscription auth is permitted.
 *
 * The headless/TTY signal is the one mechanically-ambiguous signal: bare `isTTY` cannot
 * distinguish an operator-initiated backgrounded/piped invocation (which the `local`
 * definition — operator's own machine, operator-initiated, single-tenant — permits) from
 * cron. `PELAGGIO_OPERATOR_ATTENDED=1` — exact value; absent/"0"/"true"/empty all fail
 * closed — is a per-invocation operator attestation that suppresses ONLY this signal.
 * It never overrides CI/single-shot, the daemon marker, or multi-cycle, and every
 * suppression is surfaced in `suppressed` (never silent).
 */
export function detectUnattendedSignals(context: UnattendedSignalContext): UnattendedSignalReport {
	const signals: string[] = [];
	const suppressed: string[] = [];
	if (context.singleShot) signals.push("CI/single-shot (--no-worktree)");
	if (context.env.PELAGGIO_SUPERVISED_RUN === "1") signals.push("daemon-spawned (PELAGGIO_SUPERVISED_RUN=1)");
	if (context.multiCycle) signals.push("multi-cycle campaign (--cycles/--parallel > 1)");
	if (!context.stdoutIsTTY) {
		if (context.env.PELAGGIO_OPERATOR_ATTENDED === "1") suppressed.push(OPERATOR_ATTESTED_TTY_SUPPRESSION);
		else signals.push("headless (stdout is not an interactive TTY)");
	}
	return { signals, suppressed };
}

/**
 * Resolve the authoring loop against the runtime trust context.
 *
 * `local` is an explicit operator attestation and is refused whenever any unattended
 * signal is present (CI/single-shot, daemon-spawned, multi-cycle campaign, headless —
 * see `detectUnattendedSignals`; the headless signal alone is operator-attestable via
 * `PELAGGIO_OPERATOR_ATTENDED=1`, and such suppressions arrive in `suppressedSignals`
 * and are echoed on the result for the cycle log). `keys` requires direct provider keys; unavailable
 * reviewer seats are a soft diversity degradation, while an unavailable Judge (or every
 * reviewer) fails closed. The author revision seat fails closed too: a surviving fixable
 * finding re-invokes the implementation author inside the same unattended execution, so
 * its provider key is validated here — before any seat runs — rather than silently
 * falling back to stored subscription auth. Keys for integrated subprocess routes must also be
 * forwarded through the child-env allowlist; Claude's SDK consumes its key in-process. Grok is
 * ineligible here until its direct-key egress route is implemented and reviewed.
 */
export function resolveAuthoringReviewExecution(
	policy: AuthoringReviewConfig,
	options: { unattendedSignals: readonly string[]; suppressedSignals?: readonly string[]; author?: AuthoringSeatAuthor; env?: NodeJS.ProcessEnv; envAllowlist?: readonly string[] },
): AuthoringReviewExecutionResult {
	const suppressedSignals = [...(options.suppressedSignals ?? [])];
	if (policy.enabled === "off") return { ok: true, enabled: false };
	if (policy.enabled === "local") {
		if (options.unattendedSignals.length > 0) {
			// The attestation disambiguates only the TTY signal — a remaining signal still
			// refuses; surface any suppression in the reason so the refusal is auditable too.
			const note = suppressedSignals.length > 0 ? ` (${suppressedSignals.join("; ")}; the attestation never overrides other signals)` : "";
			return { ok: false, reason: `review.authoring.enabled=local requires attended interactive execution; unattended signals: ${options.unattendedSignals.join("; ")}; use keys or off${note}` };
		}
		return { ok: true, enabled: true, policy, softened: [], suppressedSignals };
	}

	const env = options.env ?? process.env;
	const allowed = new Set(options.envAllowlist ?? []);
	const unavailableReason = (provider: ProviderName): string | undefined => {
		const key = PROVIDER_KEY_ENV[provider];
		if (!key || !DIRECT_KEY_AUTH_PROVIDERS.has(provider)) return `${provider} has no integrated direct-key authentication route`;
		if (!env[key]?.trim()) return `${key} is not set`;
		if (provider !== "claude" && !allowed.has(key)) return `${key} is not forwarded by security.env-allowlist`;
		return undefined;
	};

	const judgeReason = unavailableReason(policy.judge.provider);
	if (judgeReason) return { ok: false, reason: `authoring review Judge ${policy.judge.id} (${policy.judge.provider}) requires key auth: ${judgeReason}` };

	// The author revision seat runs whenever a fixable finding survives, under the same
	// unattended trust context as the review seats — validate its key with the same rule
	// and failure mode as the Judge, and fail closed when the identity itself is missing.
	if (!options.author) return { ok: false, reason: "authoring review author seat requires key auth: author identity was not provided at resolution" };
	const authorReason = unavailableReason(options.author.provider);
	if (authorReason) return { ok: false, reason: `authoring review author seat (${options.author.provider}) requires key auth: ${authorReason}` };

	const softened: string[] = [];
	const reviewers = policy.reviewers.filter((slot) => {
		const reason = unavailableReason(slot.provider);
		if (!reason) return true;
		softened.push(`reviewer ${slot.id} (${slot.provider}) omitted: ${reason}`);
		return false;
	});
	if (reviewers.length === 0) return { ok: false, reason: `authoring review has no key-authenticated reviewer seats (${softened.join("; ")})` };
	return { ok: true, enabled: true, policy: { ...policy, reviewers }, softened, suppressedSignals };
}

function fillSlot(slot: ReviewSlot, defaults: StepSettings): ReviewSlot {
	if (slot.provider === "codex") {
		const codexModel = slot.codexModel ?? defaults.codexModel;
		return codexModel ? { ...slot, codexModel } : { ...slot };
	}
	// Fill a non-Codex seat from that provider's own step-settings slot, never the top-level
	// Claude `model` slot — a Grok/OpenCode seat must not scavenge the Claude id (#431).
	const model = slot.model ?? modelForProvider(defaults, slot.provider);
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
