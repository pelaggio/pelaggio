import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

/** Safety floor vs judgment band (ADR-0016). Safety always parks; judgment is tolerance-configurable (#297). */
export type FindingTier = "safety" | "judgment";
/** Judgment-band default posture. #297 consumes; this item only seeds the default. */
export type JudgmentDefault = "permissive" | "park";

/** Well-formed class token: kebab segments with an optional single `/` (ADR machine tokens). */
export type FindingClassId = string;

export interface TaxonomyConfig {
	/** Forensic owner label (not a crypto identity). */
	owner: string;
	/** Default judgment-band posture. Default: "permissive". */
	judgmentDefault: JudgmentDefault;
	/**
	 * Effective tier assignments (baseline overlaid with config). Classes absent from the map are
	 * treated as safety (unclassified ⇒ safety) via {@link tierOf}.
	 */
	classes: ReadonlyMap<FindingClassId, FindingTier>;
	/** Precedence among safety classes (earlier wins on multi-match). ADR order; extended safety appends. */
	safetyPrecedence: readonly FindingClassId[];
	/**
	 * Contraction signature (required when the contraction set is non-empty). No public key here:
	 * verification uses the out-of-band {@link TAXONOMY_PUBKEY_ENV} owner key, so the agent-writable
	 * config (and source tree) cannot supply its own verification key.
	 */
	contract?: { signatureB64: string };
}

/** Loosely-typed config overlay (from `.pelaggio.yml` or a test). resolveTaxonomy is the validation authority. */
export interface RawTaxonomyInput {
	owner?: string;
	judgmentDefault?: JudgmentDefault;
	classes?: Readonly<Record<string, string>>;
	contract?: { signatureB64: string };
}

/**
 * Trust anchor for contraction signatures. The owner's Ed25519 **public** key (verify-only) is read
 * from the `PELAGGIO_TAXONOMY_PUBKEY` process env var, set OUT-OF-BAND by the operator/CI — never from
 * a repo file. This is the fix for the original source-pinned constant (#352 review): a constant in
 * `review/taxonomy.ts` sits in the *autonomous agent's own write surface*, so an agent could replace
 * the key and self-sign a contraction — reducing the "signed, non-autonomous ritual" guarantee to "the
 * code-review must notice the source edit" (a policy signal, not a deterministic capability denial).
 * Reading `process.env` directly keeps the anchor outside that surface: an agent's worktree edits
 * cannot change the harness process's environment. (The env value must be a literal PEM set by the
 * operator/CI, not sourced from a committed file — else it re-enters the write surface.)
 *
 * Unset ⇒ NO trust anchor ⇒ any taxonomy CONTRACTION is refused (fail-closed). The baseline safety
 * floor and free EXTENSIONS need no key. A residual remains — an agent can still edit
 * `BASELINE_TAXONOMY_CLASSES` directly in source to lower a floor; that source-integrity vector is the
 * code-review + confinement layer's responsibility (a broader concern than this gate).
 */
export const TAXONOMY_PUBKEY_ENV = "PELAGGIO_TAXONOMY_PUBKEY";

/** Resolve the owner verification key from the process environment (out-of-band, not a repo file). */
export function resolveOwnerTaxonomyPubKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[TAXONOMY_PUBKEY_ENV];
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** ADR-0016 owner table: six safety classes + the named judgment tokens (umbrella `judgment` for #293 rules). */
export const BASELINE_TAXONOMY_CLASSES: Readonly<Record<FindingClassId, FindingTier>> = {
	// SAFETY (ADR-0016 owner table)
	"security-and-secrets": "safety",
	"data-loss/destructive-ops": "safety",
	"supply-chain/integrity": "safety",
	"containment-escape": "safety",
	"irreversible-git/unsafe-landing": "safety",
	"correctness-regression": "safety",
	// JUDGMENT (named tokens + umbrella for the #293 rule allowlist)
	judgment: "judgment",
	"spec-fit/scope-drift": "judgment",
	"maintainability/design": "judgment",
	performance: "judgment",
	"test-coverage": "judgment",
	style: "judgment",
	documentation: "judgment",
};

/** Baseline safety precedence (ADR order; deterministic tie-break only — all safety classes park equally). */
export const DEFAULT_SAFETY_PRECEDENCE: readonly FindingClassId[] = ["security-and-secrets", "data-loss/destructive-ops", "supply-chain/integrity", "containment-escape", "irreversible-git/unsafe-landing", "correctness-regression"];

/** Class-id grammar: lowercase kebab segments with an optional single `/`. Rejects whitespace / forged junk. */
export const CLASS_ID_RE = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/;

export function isWellFormedClassId(value: string): boolean {
	return CLASS_ID_RE.test(value);
}

/** Effective tier of a class token. Unclassified ⇒ safety (load-bearing default-to-safety). */
export function tierOf(classId: FindingClassId, taxonomy: TaxonomyConfig): FindingTier {
	return taxonomy.classes.get(classId) ?? "safety";
}

/** Ordered safety classes: precedence entries still tier-safety, then any other safety-tier keys (append). */
export function safetyClasses(taxonomy: TaxonomyConfig): FindingClassId[] {
	const ordered: FindingClassId[] = [];
	const seen = new Set<FindingClassId>();
	for (const id of taxonomy.safetyPrecedence) {
		if (!seen.has(id) && taxonomy.classes.get(id) === "safety") {
			ordered.push(id);
			seen.add(id);
		}
	}
	for (const [id, tier] of taxonomy.classes) {
		if (!seen.has(id) && tier === "safety") {
			ordered.push(id);
			seen.add(id);
		}
	}
	return ordered;
}

/**
 * Canonical sorted contraction set vs a baseline: `[classId, "judgment"]` pairs that shrink the floor —
 * a baseline-safety class now judgment, **or** a class absent from baseline seated as judgment. Extensions
 * (new/elevated safety) are absent, so an autonomous extend never changes these bytes.
 */
export function contractionSet(resolvedClasses: ReadonlyMap<FindingClassId, FindingTier>, baseline: Readonly<Record<FindingClassId, FindingTier>> = BASELINE_TAXONOMY_CLASSES): Array<[FindingClassId, "judgment"]> {
	const contracted: FindingClassId[] = [];
	for (const [id, tier] of resolvedClasses) {
		if (tier !== "judgment") continue;
		const baselineTier = baseline[id];
		// baseline-safety-now-judgment, OR a new class (absent from baseline) seated as judgment.
		if (baselineTier === "safety" || baselineTier === undefined) contracted.push(id);
	}
	return contracted.sort((a, b) => a.localeCompare(b)).map((id) => [id, "judgment"]);
}

/** True when the resolved classes shrink the baseline safety floor. */
export function isContraction(resolvedClasses: ReadonlyMap<FindingClassId, FindingTier>, baseline: Readonly<Record<FindingClassId, FindingTier>> = BASELINE_TAXONOMY_CLASSES): boolean {
	return contractionSet(resolvedClasses, baseline).length > 0;
}

/** Stable JSON of the contraction set — the exact signed bytes. Order-independent by construction. */
export function canonicalizeContractionPayload(resolvedClasses: ReadonlyMap<FindingClassId, FindingTier>, baseline: Readonly<Record<FindingClassId, FindingTier>> = BASELINE_TAXONOMY_CLASSES): string {
	return JSON.stringify(contractionSet(resolvedClasses, baseline));
}

/** Ed25519 verify (fail-closed: any crypto/format error ⇒ false). */
export function verifyContractSignature(payload: string, publicKeyPem: string, signatureB64: string): boolean {
	try {
		const key = createPublicKey(publicKeyPem);
		return verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(signatureB64, "base64"));
	} catch {
		return false;
	}
}

/** Ed25519 sign — owner ritual / tests only. Never called by the pipeline. */
export function signContractionPayload(payload: string, privateKeyPem: string): string {
	const key = createPrivateKey(privateKeyPem);
	return sign(null, Buffer.from(payload, "utf8"), key).toString("base64");
}

export class TaxonomyResolveError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TaxonomyResolveError";
	}
}

/**
 * Overlay-merge config classes onto the baseline (config keys override; omitted keep baseline) with class-id
 * grammar + tier validation, WITHOUT the contraction gate. The operator `taxonomy sign` / `canonical` paths
 * need the pre-gate map: a contracted config is unsigned at sign time, so gating first would reject it before
 * the owner can produce the signature.
 */
export function mergeTaxonomyClasses(raw: RawTaxonomyInput = {}, baseline: Readonly<Record<FindingClassId, FindingTier>> = BASELINE_TAXONOMY_CLASSES): Map<FindingClassId, FindingTier> {
	const classes = new Map<FindingClassId, FindingTier>(Object.entries(baseline));
	for (const [id, tier] of Object.entries(raw.classes ?? {})) {
		if (!isWellFormedClassId(id)) throw new TaxonomyResolveError(`taxonomy class id is malformed: ${JSON.stringify(id)}`);
		if (tier !== "safety" && tier !== "judgment") throw new TaxonomyResolveError(`taxonomy class ${id} must be safety|judgment, got ${JSON.stringify(tier)}`);
		classes.set(id, tier);
	}
	return classes;
}

/**
 * Overlay-merge config classes onto the baseline, validate, then gate: a non-empty contraction set requires
 * a verified Ed25519 signature over the canonical payload against the out-of-band owner key (default:
 * {@link resolveOwnerTaxonomyPubKey} from {@link TAXONOMY_PUBKEY_ENV}). Fail-closed — throws when a
 * contraction lacks a valid signature, or when no owner trust anchor is configured at all.
 */
export function resolveTaxonomy(raw: RawTaxonomyInput = {}, baseline: Readonly<Record<FindingClassId, FindingTier>> = BASELINE_TAXONOMY_CLASSES, ownerPubKeyPem: string | undefined = resolveOwnerTaxonomyPubKey()): TaxonomyConfig {
	const owner = raw.owner ?? "operator";
	if (typeof owner !== "string" || owner.trim() === "") throw new TaxonomyResolveError("taxonomy owner must be a non-empty string");
	const judgmentDefault = raw.judgmentDefault ?? "permissive";
	if (judgmentDefault !== "permissive" && judgmentDefault !== "park") throw new TaxonomyResolveError(`taxonomy judgment-default must be permissive|park, got ${JSON.stringify(judgmentDefault)}`);

	const classes = mergeTaxonomyClasses(raw, baseline);
	const contractions = contractionSet(classes, baseline);
	if (contractions.length > 0) {
		const contracted = contractions.map(([id]) => id).join(", ");
		// Fail closed when no out-of-band trust anchor is configured — a contraction cannot be
		// authorized without the owner's env-provided verification key. (#352 review)
		if (!ownerPubKeyPem) {
			throw new TaxonomyResolveError(`taxonomy contracts the safety floor (${contracted}) but no owner trust anchor is configured; set ${TAXONOMY_PUBKEY_ENV} (the owner's Ed25519 public-key PEM, out-of-band) to enable signed contractions`);
		}
		const signatureB64 = raw.contract?.signatureB64;
		if (typeof signatureB64 !== "string" || signatureB64.trim() === "") {
			throw new TaxonomyResolveError(`taxonomy contracts the safety floor (${contracted}) but is unsigned; run \`npx pelaggio taxonomy sign\` with the owner private key and paste the signature into \`review.taxonomy.contract.signature-b64\``);
		}
		if (!verifyContractSignature(canonicalizeContractionPayload(classes, baseline), ownerPubKeyPem, signatureB64)) {
			throw new TaxonomyResolveError(`taxonomy contracts the safety floor (${contracted}) but the signature does not verify against the ${TAXONOMY_PUBKEY_ENV} owner key; re-sign with \`npx pelaggio taxonomy sign\``);
		}
	}

	return {
		owner,
		judgmentDefault,
		classes,
		safetyPrecedence: DEFAULT_SAFETY_PRECEDENCE,
		...(raw.contract?.signatureB64 ? { contract: { signatureB64: raw.contract.signatureB64 } } : {}),
	};
}

/** Baseline-resolved taxonomy — the default for optional taxonomy params (preserves pre-#294 behavior). */
export const BASELINE_TAXONOMY: TaxonomyConfig = resolveTaxonomy({});

/** Effective safety check. Defaults to the baseline taxonomy so existing call sites keep working. */
export function isSafetyClass(classId: FindingClassId, taxonomy: TaxonomyConfig = BASELINE_TAXONOMY): boolean {
	return tierOf(classId, taxonomy) === "safety";
}
