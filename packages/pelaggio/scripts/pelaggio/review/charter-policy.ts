import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { ReviewSlot } from "../config.js";
import { resolveOwnerTaxonomyPubKey } from "./taxonomy.js";

/**
 * Charter-review policy (#367). The one create-time gate resolves this level and, when it is
 * `triad`, executes the configured reviewer/Judge panel before minting a `reviewDigest`.
 *
 * `off` — direct create, no panel (the shipped default).
 * `triad` — run the configured seats + Judge; a non-ship verdict is advisory (defers), never a veto.
 */
export type CharterReviewLevel = "off" | "triad";

export const CHARTER_REVIEW_LEVELS: readonly CharterReviewLevel[] = ["off", "triad"];

export function isCharterReviewLevel(value: unknown): value is CharterReviewLevel {
	return typeof value === "string" && (CHARTER_REVIEW_LEVELS as readonly string[]).includes(value);
}

/** Explicit rank so `max(yml, env-floor)` is a numeric compare, not string order. Higher = stronger. */
const LEVEL_RANK: Record<CharterReviewLevel, number> = { off: 0, triad: 1 };

export function charterLevelRank(level: CharterReviewLevel): number {
	return LEVEL_RANK[level];
}

/**
 * Raise-only floor env var, set out-of-band by the operator/CI (never a repo file — that would re-enter
 * the agent's write surface). Its value strengthens the yml level via `max`; it can never weaken policy.
 * A yml level *below* this floor is a CONTRACTION and needs an owner signature (see {@link resolveCharterPolicy}).
 */
export const CHARTER_REVIEW_FLOOR_ENV = "PELAGGIO_CHARTER_REVIEW_FLOOR";

/** Resolve the raise-only floor from the process environment. Unset ⇒ `off` (no floor). Invalid ⇒ throw. */
export function resolveCharterEnvFloor(env: NodeJS.ProcessEnv = process.env): CharterReviewLevel {
	const raw = env[CHARTER_REVIEW_FLOOR_ENV];
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	if (trimmed === "") return "off";
	if (!isCharterReviewLevel(trimmed)) throw new CharterPolicyError(`${CHARTER_REVIEW_FLOOR_ENV} must be one of ${CHARTER_REVIEW_LEVELS.join("|")}, got ${JSON.stringify(raw)}`);
	return trimmed;
}

/** Providers a charter seat may name AND that have a registered driver. Injectable for capability tests. */
export const CHARTER_CAPABLE_PROVIDERS: readonly ReviewSlot["provider"][] = ["claude", "codex", "grok", "opencode"];

/** Loosely-typed overlay parsed from `.pelaggio.yml`. `resolveCharterPolicy` is the validation authority. */
export interface RawCharterInput {
	level?: CharterReviewLevel;
	reviewers?: ReviewSlot[];
	judge?: ReviewSlot;
	maxPasses?: number;
	contract?: { signatureB64: string };
}

/** Resolved, read-time-gated charter policy. `effectiveLevel` is what the gate applies. */
export interface CharterReviewConfig {
	/** Level the gate applies (raise-only `max(yml, env-floor)`, or the yml level under a signed contraction). */
	effectiveLevel: CharterReviewLevel;
	/** The agent-writable yml level, retained for the record + audit. */
	rawYmlLevel: CharterReviewLevel;
	/** The out-of-band env floor, retained for the record + audit. */
	rawEnvFloor: CharterReviewLevel;
	reviewers: ReviewSlot[];
	judge: ReviewSlot;
	maxPasses: number;
	contract?: { signatureB64: string };
}

export class CharterPolicyError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CharterPolicyError";
	}
}

/**
 * Domain-separated signing prefix. A signature over these bytes cannot be replayed onto a taxonomy
 * contraction (whose bytes start with `{"domain":"pelaggio.taxonomy…`) and vice versa — the byte
 * prefixes differ, so cross-protocol verification fails by construction.
 */
export const CHARTER_FLOOR_DOMAIN = "charter-floor.v1";

/** The exact signed bytes authorizing a yml level below the env floor. Deterministic, domain-separated. */
export function canonicalizeCharterFloorPayload(ymlLevel: CharterReviewLevel, envFloor: CharterReviewLevel): string {
	return `${CHARTER_FLOOR_DOMAIN}\0${JSON.stringify({ ymlLevel, envFloor })}`;
}

/** A yml level strictly weaker than the env floor — the contraction the owner signature authorizes. */
export function isCharterContraction(ymlLevel: CharterReviewLevel, envFloor: CharterReviewLevel): boolean {
	return charterLevelRank(ymlLevel) < charterLevelRank(envFloor);
}

/** Ed25519 verify (fail-closed: any crypto/format error ⇒ false). */
export function verifyCharterFloorSignature(payload: string, publicKeyPem: string, signatureB64: string): boolean {
	try {
		const key = createPublicKey(publicKeyPem);
		return verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(signatureB64, "base64"));
	} catch {
		return false;
	}
}

/** Ed25519 sign — owner ritual / tests only. Never called by the pipeline. */
export function signCharterFloorPayload(payload: string, privateKeyPem: string): string {
	const key = createPrivateKey(privateKeyPem);
	return sign(null, Buffer.from(payload, "utf8"), key).toString("base64");
}

/** Canonicalize a review slot for stable serialization (fixed key order; codex uses codexModel). */
function canonicalizeSlot(slot: ReviewSlot): Record<string, string> {
	if (slot.provider === "codex") return { id: slot.id, provider: "codex", ...(slot.codexModel ? { codexModel: slot.codexModel } : {}) };
	return { id: slot.id, provider: slot.provider, ...(slot.model ? { model: slot.model } : {}) };
}

/**
 * Stable canonical JSON of the effective policy — the exact bytes hashed into a charter-review record so
 * the record binds the policy it ran under. Deterministic key order; reviewer seats sorted by id.
 */
export function canonicalizeCharterPolicy(config: CharterReviewConfig): string {
	const reviewers = [...config.reviewers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(canonicalizeSlot);
	return JSON.stringify({
		version: 1,
		rawYmlLevel: config.rawYmlLevel,
		rawEnvFloor: config.rawEnvFloor,
		effectiveLevel: config.effectiveLevel,
		reviewers,
		judge: canonicalizeSlot(config.judge),
		maxPasses: config.maxPasses,
	});
}

export interface ResolveCharterOptions {
	env?: NodeJS.ProcessEnv;
	ownerPubKeyPem?: string | undefined;
	/** Providers considered to have an available registered driver. Defaults to the registered set. */
	capableProviders?: readonly ReviewSlot["provider"][];
}

/**
 * Resolve + read-time-gate the charter policy. The environment floor can only STRENGTHEN the yml level
 * (`max`); a yml level BELOW the floor is a contraction that requires a verified owner Ed25519 signature
 * over {@link canonicalizeCharterFloorPayload} against the out-of-band `PELAGGIO_TAXONOMY_PUBKEY` anchor
 * (shared owner key; distinct `charter-floor.v1` domain). Fail-closed: an unsigned/invalid contraction,
 * or `triad` with a non-executable seat, throws before any caller can observe a weakened policy.
 */
export function resolveCharterPolicy(raw: RawCharterInput, opts: ResolveCharterOptions = {}): CharterReviewConfig {
	const env = opts.env ?? process.env;
	const ownerPubKeyPem = opts.ownerPubKeyPem ?? resolveOwnerTaxonomyPubKey(env);
	const capable = opts.capableProviders ?? CHARTER_CAPABLE_PROVIDERS;
	const rawYmlLevel: CharterReviewLevel = raw.level ?? "off";
	// An ABSENT yml level is not a contraction — it inherits the floor via `max`. Only an EXPLICIT
	// sub-floor level is the signature-gated weakening (so a floor can bump un-configured repos up).
	const explicitLevel = raw.level !== undefined;
	const rawEnvFloor = resolveCharterEnvFloor(env);
	const reviewers = raw.reviewers ?? [];
	const judge = raw.judge;
	if (!judge) throw new CharterPolicyError("charter policy requires a judge slot");
	const maxPasses = raw.maxPasses ?? 2;
	if (!Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 5) throw new CharterPolicyError(`charter max-passes must be an integer from 1 to 5, got ${JSON.stringify(maxPasses)}`);

	let effectiveLevel: CharterReviewLevel;
	if (explicitLevel && isCharterContraction(rawYmlLevel, rawEnvFloor)) {
		// Fail-closed: an agent-writable yml level below the operator's env floor is a contraction that
		// mirrors taxonomy's signed gate — it can only be honored with a verified owner signature.
		if (!ownerPubKeyPem) {
			throw new CharterPolicyError(
				`review.charter.level (${rawYmlLevel}) is below the ${CHARTER_REVIEW_FLOOR_ENV} floor (${rawEnvFloor}) but no owner trust anchor is configured; set PELAGGIO_TAXONOMY_PUBKEY (the owner's Ed25519 public-key PEM, out-of-band) to authorize a signed contraction`,
			);
		}
		const signatureB64 = raw.contract?.signatureB64;
		if (typeof signatureB64 !== "string" || signatureB64.trim() === "") {
			throw new CharterPolicyError(
				`review.charter.level (${rawYmlLevel}) is below the ${CHARTER_REVIEW_FLOOR_ENV} floor (${rawEnvFloor}) but is unsigned; run \`npx pelaggio charter-floor sign\` with the owner private key and paste the signature into \`review.charter.contract.signature-b64\``,
			);
		}
		if (!verifyCharterFloorSignature(canonicalizeCharterFloorPayload(rawYmlLevel, rawEnvFloor), ownerPubKeyPem, signatureB64)) {
			throw new CharterPolicyError(
				`review.charter.level (${rawYmlLevel}) contracts the ${CHARTER_REVIEW_FLOOR_ENV} floor (${rawEnvFloor}) but the signature does not verify against the PELAGGIO_TAXONOMY_PUBKEY owner key; re-sign with \`npx pelaggio charter-floor sign\``,
			);
		}
		// Authorized contraction: the yml level governs, below the floor.
		effectiveLevel = rawYmlLevel;
	} else {
		// Raise-only: the environment can only strengthen.
		effectiveLevel = charterLevelRank(rawYmlLevel) >= charterLevelRank(rawEnvFloor) ? rawYmlLevel : rawEnvFloor;
	}

	if (effectiveLevel === "triad") {
		if (reviewers.length === 0) throw new CharterPolicyError("charter policy resolves to triad but has no reviewer seats");
		if (new Set(reviewers.map((slot) => slot.id)).size !== reviewers.length) throw new CharterPolicyError("charter reviewer ids must be unique");
		if (new Set(reviewers.map((slot) => slot.provider)).size !== reviewers.length) throw new CharterPolicyError("charter reviewer providers must be unique");
		for (const slot of [...reviewers, judge]) {
			if (!capable.includes(slot.provider)) throw new CharterPolicyError(`charter seat ${slot.id} names provider ${slot.provider}, which has no available registered driver`);
		}
	}

	return {
		effectiveLevel,
		rawYmlLevel,
		rawEnvFloor,
		reviewers,
		judge,
		maxPasses,
		...(raw.contract?.signatureB64 ? { contract: { signatureB64: raw.contract.signatureB64 } } : {}),
	};
}
