/**
 * Pure protocol for harness-attested local review evidence (#511).
 *
 * Signs the canonical evidence payload (digests of the exact fleet/source bytes)
 * with an Ed25519 key and carries the detached signature on the forge `review`
 * status. Design A (#511): the private key lives ONLY in the out-of-process
 * signer (`review/evidence-signer.ts`), never in the harness — the sign/verify
 * primitives here are pure functions; the signer calls `signReviewEvidence`, the
 * harness calls only `verifyReviewEvidence` (the public key is not secret). The
 * module never reads or writes `.dev` files and never hashes — callers pass
 * already-hex SHA-256 digests from `fleetRecordDigestOf()`.
 */

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

/** Domain-separated payload tag. Bump the `.v1` suffix if the signed shape changes. */
export const REVIEW_EVIDENCE_DOMAIN = "pelaggio.pr-review.adjudication-evidence.v1";

/** Ed25519 signing key (PKCS#8 PEM text). Belongs to the SEPARATE-UID signer process
 *  ONLY (#511, Design A) — never set on the harness, never inherited by a model
 *  subprocess. Kept in `HARNESS_ONLY_ENV_DENY` as defense-in-depth. */
export const REVIEW_EVIDENCE_PRIVATE_KEY_ENV = "PELAGGIO_REVIEW_EVIDENCE_PRIVATE_KEY";

/** Out-of-band verification key (SPKI PEM text). Grants no signing authority. */
export const REVIEW_EVIDENCE_PUBKEY_ENV = "PELAGGIO_REVIEW_EVIDENCE_PUBKEY";

/**
 * Harness → out-of-process signer unix-socket path (#511, Design A). Set on the
 * HARNESS; it names an address, never a secret. The private key lives ONLY in the
 * separate-UID signer process behind this socket, so the harness (and any same-UID
 * prompt-injected worker that walks /proc) can never read the key from a harness
 * `environ`. See `review/evidence-signer.ts` and docs/server.md.
 */
export const REVIEW_EVIDENCE_SIGNER_SOCKET_ENV = "PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET";

/** Request-auth token (signer process ONLY). Never set on the harness — a value in
 *  harness `environ` is the same /proc-readable secret the private-key split removes. */
export const REVIEW_EVIDENCE_SIGNER_TOKEN_ENV = "PELAGGIO_REVIEW_EVIDENCE_SIGNER_TOKEN";

/** Harness path to a 0400 token file. The harness loads the value into memory and
 *  unlinks the file so the secret is never in `environ` and does not remain on a
 *  same-UID-readable path after startup. See `review/evidence-signer.ts`. */
export const REVIEW_EVIDENCE_SIGNER_TOKEN_FILE_ENV = "PELAGGIO_REVIEW_EVIDENCE_SIGNER_TOKEN_FILE";

/** Compact status-description prefix. Prefix + 64-byte Ed25519 base64url is 124 chars (≤140). */
export const REVIEW_EVIDENCE_MARKER_PREFIX = "pelaggio review blocked; evidence-v1=";

const SHA40_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const INPUT_KEYS = ["repository", "prNumber", "itemId", "reviewedSha", "fleetRecordSha256", "adjudicationSourceSha256"] as const;

export interface ReviewEvidenceIdentity {
	repository: string;
	prNumber: number;
	itemId: string;
	reviewedSha: string;
	fleetRecordSha256: string;
	adjudicationSourceSha256: string;
}

export class ReviewEvidencePayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReviewEvidencePayloadError";
	}
}

function blankAsAbsent(value: string | undefined): string | undefined {
	const trimmed = typeof value === "string" ? value.trim() : "";
	return trimmed !== "" ? trimmed : undefined;
}

/** Resolve the signer's signing key from the process environment (literal PEM, not a path).
 *  Called only by the out-of-process signer (`evidence-signer` CLI), never the harness. */
export function resolveReviewEvidencePrivateKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return blankAsAbsent(env[REVIEW_EVIDENCE_PRIVATE_KEY_ENV]);
}

/** Resolve the out-of-band verification key from the process environment (literal PEM, not a path). */
export function resolveReviewEvidencePubKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return blankAsAbsent(env[REVIEW_EVIDENCE_PUBKEY_ENV]);
}

/**
 * Canonical signed UTF-8 bytes: compact `JSON.stringify` of a hand-built object
 * with this exact insertion order (no pretty-print, no key sort — order is the protocol).
 * Closed-shape: exact 40/64 lowercase hex, no extra keys.
 */
export function buildReviewEvidencePayload(input: ReviewEvidenceIdentity): string {
	if (!isRecord(input)) throw new ReviewEvidencePayloadError("evidence identity is not an object");
	for (const key of Object.keys(input)) {
		if (!(INPUT_KEYS as readonly string[]).includes(key)) throw new ReviewEvidencePayloadError(`unexpected evidence identity key: ${key}`);
	}
	const repository = requireNonEmptyString(input.repository, "repository");
	const prNumber = requirePositiveInt(input.prNumber, "prNumber");
	const itemId = requireNonEmptyString(input.itemId, "itemId");
	const reviewedSha = requireExactHex(input.reviewedSha, "reviewedSha", SHA40_RE);
	const fleetRecordSha256 = requireExactHex(input.fleetRecordSha256, "fleetRecordSha256", DIGEST_RE);
	const adjudicationSourceSha256 = requireExactHex(input.adjudicationSourceSha256, "adjudicationSourceSha256", DIGEST_RE);
	return JSON.stringify({
		domain: REVIEW_EVIDENCE_DOMAIN,
		repository,
		prNumber,
		itemId,
		reviewedSha,
		fleetRecordSha256,
		adjudicationSourceSha256,
	});
}

/** Ed25519 sign — called ONLY by the out-of-process signer (#511). Returns unpadded base64url. */
export function signReviewEvidence(payload: string, privateKeyPem: string): string {
	const key = createPrivateKey(privateKeyPem);
	return sign(null, Buffer.from(payload, "utf8"), key).toString("base64url");
}

/** Ed25519 verify (fail-closed: any crypto/format error ⇒ false). */
export function verifyReviewEvidence(payload: string, publicKeyPem: string, signatureB64url: string): boolean {
	try {
		if (!B64URL_RE.test(signatureB64url)) return false;
		const signature = Buffer.from(signatureB64url, "base64url");
		if (signature.length !== 64) return false;
		const key = createPublicKey(publicKeyPem);
		return verify(null, Buffer.from(payload, "utf8"), key, signature);
	} catch {
		return false;
	}
}

/** Compact `review` status description carrying the detached v1 signature. */
export function formatReviewEvidenceDescription(signatureB64url: string): string {
	return `${REVIEW_EVIDENCE_MARKER_PREFIX}${signatureB64url}`;
}

/**
 * Parse a status description for a v1 evidence marker. Fail-closed: exact prefix,
 * base64url charset, decoded length exactly 64. Returns the signature string.
 */
export function parseReviewEvidenceDescription(description: string): string | undefined {
	if (typeof description !== "string" || !description.startsWith(REVIEW_EVIDENCE_MARKER_PREFIX)) return undefined;
	const signature = description.slice(REVIEW_EVIDENCE_MARKER_PREFIX.length);
	if (!B64URL_RE.test(signature)) return undefined;
	let decoded: Buffer;
	try {
		decoded = Buffer.from(signature, "base64url");
	} catch {
		return undefined;
	}
	if (decoded.length !== 64) return undefined;
	return signature;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new ReviewEvidencePayloadError(`invalid ${field}`);
	return value;
}

function requirePositiveInt(value: unknown, field: string): number {
	if (!Number.isInteger(value) || (value as number) <= 0) throw new ReviewEvidencePayloadError(`invalid ${field}`);
	return value as number;
}

function requireExactHex(value: unknown, field: string, re: RegExp): string {
	if (typeof value !== "string" || !re.test(value)) throw new ReviewEvidencePayloadError(`invalid ${field}`);
	return value;
}
