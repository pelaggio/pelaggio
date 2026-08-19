import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import {
	buildReviewEvidencePayload,
	formatReviewEvidenceDescription,
	parseReviewEvidenceDescription,
	REVIEW_EVIDENCE_DOMAIN,
	REVIEW_EVIDENCE_MARKER_PREFIX,
	REVIEW_EVIDENCE_PRIVATE_KEY_ENV,
	REVIEW_EVIDENCE_PUBKEY_ENV,
	type ReviewEvidenceIdentity,
	ReviewEvidencePayloadError,
	resolveReviewEvidencePrivateKey,
	resolveReviewEvidencePubKey,
	signReviewEvidence,
	verifyReviewEvidence,
} from "../review/gate-attestation.js";

function keypair(): { publicKeyPem: string; privateKeyPem: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	};
}

function identity(over: Partial<ReviewEvidenceIdentity> = {}): ReviewEvidenceIdentity {
	return {
		repository: "owner/repo",
		prNumber: 123,
		itemId: "123",
		reviewedSha: "a".repeat(40),
		fleetRecordSha256: "b".repeat(64),
		adjudicationSourceSha256: "c".repeat(64),
		...over,
	};
}

describe("review evidence payload", () => {
	it("canonicalizes with the versioned domain and exact insertion order", () => {
		const payload = buildReviewEvidencePayload(identity());
		assert.equal(
			payload,
			JSON.stringify({
				domain: REVIEW_EVIDENCE_DOMAIN,
				repository: "owner/repo",
				prNumber: 123,
				itemId: "123",
				reviewedSha: "a".repeat(40),
				fleetRecordSha256: "b".repeat(64),
				adjudicationSourceSha256: "c".repeat(64),
			}),
		);
		assert.equal(payload.includes("\n"), false);
		assert.ok(payload.startsWith(`{"domain":"${REVIEW_EVIDENCE_DOMAIN}"`));
	});

	it("rejects extra keys and malformed hex / identity fields", () => {
		assert.throws(() => buildReviewEvidencePayload({ ...identity(), extra: "x" } as ReviewEvidenceIdentity), ReviewEvidencePayloadError);
		assert.throws(() => buildReviewEvidencePayload(identity({ reviewedSha: "A".repeat(40) })), ReviewEvidencePayloadError);
		assert.throws(() => buildReviewEvidencePayload(identity({ reviewedSha: "a".repeat(39) })), ReviewEvidencePayloadError);
		assert.throws(() => buildReviewEvidencePayload(identity({ fleetRecordSha256: "B".repeat(64) })), ReviewEvidencePayloadError);
		assert.throws(() => buildReviewEvidencePayload(identity({ fleetRecordSha256: "b".repeat(63) })), ReviewEvidencePayloadError);
		assert.throws(() => buildReviewEvidencePayload(identity({ adjudicationSourceSha256: "C".repeat(64) })), ReviewEvidencePayloadError);
		assert.throws(() => buildReviewEvidencePayload(identity({ prNumber: 0 })), ReviewEvidencePayloadError);
		assert.throws(() => buildReviewEvidencePayload(identity({ itemId: "" })), ReviewEvidencePayloadError);
		assert.throws(() => buildReviewEvidencePayload(identity({ repository: "" })), ReviewEvidencePayloadError);
	});
});

describe("review evidence sign / verify", () => {
	it("verifies an exact pair and fails closed on any identity, byte, domain, key, or signature change", () => {
		const { publicKeyPem, privateKeyPem } = keypair();
		const payload = buildReviewEvidencePayload(identity());
		const sig = signReviewEvidence(payload, privateKeyPem);
		assert.equal(verifyReviewEvidence(payload, publicKeyPem, sig), true);

		assert.equal(verifyReviewEvidence(buildReviewEvidencePayload(identity({ repository: "other/repo" })), publicKeyPem, sig), false);
		assert.equal(verifyReviewEvidence(buildReviewEvidencePayload(identity({ prNumber: 124 })), publicKeyPem, sig), false);
		assert.equal(verifyReviewEvidence(buildReviewEvidencePayload(identity({ itemId: "124" })), publicKeyPem, sig), false);
		assert.equal(verifyReviewEvidence(buildReviewEvidencePayload(identity({ reviewedSha: "d".repeat(40) })), publicKeyPem, sig), false);
		assert.equal(verifyReviewEvidence(buildReviewEvidencePayload(identity({ fleetRecordSha256: "e".repeat(64) })), publicKeyPem, sig), false);
		assert.equal(verifyReviewEvidence(buildReviewEvidencePayload(identity({ adjudicationSourceSha256: "f".repeat(64) })), publicKeyPem, sig), false);
		assert.equal(verifyReviewEvidence(payload.replace(REVIEW_EVIDENCE_DOMAIN, "pelaggio.pr-review.adjudication-evidence.v2"), publicKeyPem, sig), false);
		assert.equal(verifyReviewEvidence(payload, keypair().publicKeyPem, sig), false);
		// Flip a byte of the decoded signature (not a trailing base64url char, whose spare bits can
		// re-encode to the same 64 bytes) so the tampered signature always differs from the original.
		const tampered = Buffer.from(sig, "base64url");
		tampered[0] ^= 0xff;
		assert.equal(verifyReviewEvidence(payload, publicKeyPem, tampered.toString("base64url")), false);
	});

	it("fails closed on malformed PEM or signature", () => {
		const { publicKeyPem, privateKeyPem } = keypair();
		const payload = buildReviewEvidencePayload(identity());
		assert.equal(verifyReviewEvidence(payload, "not-a-pem", signReviewEvidence(payload, privateKeyPem)), false);
		assert.equal(verifyReviewEvidence(payload, publicKeyPem, "not@@valid"), false);
		assert.equal(verifyReviewEvidence(payload, publicKeyPem, "abcd"), false);
		assert.throws(() => signReviewEvidence(payload, "not-a-pem"));
	});
});

describe("review evidence status marker", () => {
	it("emits a compact description that fits GitHub's 140-char limit and decodes to 64 bytes", () => {
		const { privateKeyPem } = keypair();
		const sig = signReviewEvidence(buildReviewEvidencePayload(identity()), privateKeyPem);
		const description = formatReviewEvidenceDescription(sig);
		assert.ok(description.startsWith(REVIEW_EVIDENCE_MARKER_PREFIX));
		assert.ok(description.length <= 140);
		assert.equal(description.length, REVIEW_EVIDENCE_MARKER_PREFIX.length + sig.length);
		const parsed = parseReviewEvidenceDescription(description);
		assert.equal(parsed, sig);
		assert.equal(Buffer.from(parsed!, "base64url").length, 64);
	});

	it("rejects unknown versions, padded/standard base64, and the wrong decoded length", () => {
		const { privateKeyPem } = keypair();
		const sig = signReviewEvidence(buildReviewEvidencePayload(identity()), privateKeyPem);
		assert.equal(parseReviewEvidenceDescription(`pelaggio review blocked; evidence-v2=${sig}`), undefined);
		assert.equal(parseReviewEvidenceDescription("pelaggio review block"), undefined);
		assert.equal(parseReviewEvidenceDescription(`${REVIEW_EVIDENCE_MARKER_PREFIX}${sig}=`), undefined);
		assert.equal(parseReviewEvidenceDescription(`${REVIEW_EVIDENCE_MARKER_PREFIX}${Buffer.from(sig, "base64url").toString("base64")}`), undefined);
		assert.equal(parseReviewEvidenceDescription(`${REVIEW_EVIDENCE_MARKER_PREFIX}abcd`), undefined);
		assert.equal(parseReviewEvidenceDescription(`${REVIEW_EVIDENCE_MARKER_PREFIX}`), undefined);
	});
});

describe("review evidence env resolvers", () => {
	it("treats blank as absent and does not reuse the taxonomy key name", () => {
		assert.notEqual(REVIEW_EVIDENCE_PUBKEY_ENV, "PELAGGIO_TAXONOMY_PUBKEY");
		assert.equal(resolveReviewEvidencePrivateKey({ [REVIEW_EVIDENCE_PRIVATE_KEY_ENV]: "  " }), undefined);
		assert.equal(resolveReviewEvidencePubKey({ [REVIEW_EVIDENCE_PUBKEY_ENV]: "" }), undefined);
		assert.equal(resolveReviewEvidencePrivateKey({ [REVIEW_EVIDENCE_PRIVATE_KEY_ENV]: " pem " }), "pem");
		assert.equal(resolveReviewEvidencePubKey({ [REVIEW_EVIDENCE_PUBKEY_ENV]: "pub" }), "pub");
		assert.equal(resolveReviewEvidencePrivateKey({}), undefined);
		assert.equal(resolveReviewEvidencePubKey({}), undefined);
	});
});
