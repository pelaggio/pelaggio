import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type EvidenceSignerHandle,
	handleSignerRequestLine,
	loadHarnessSignerAuthToken,
	MIN_SIGNER_AUTH_TOKEN_LENGTH,
	REVIEW_EVIDENCE_SIGNER_SOCKET_ENV,
	resolveReviewEvidenceSignerAuthToken,
	resolveReviewEvidenceSignerSocket,
	SIGNER_PROTOCOL_VERSION,
	serveEvidenceSigner,
	signReviewEvidenceViaSigner,
} from "../review/evidence-signer.js";
import { buildReviewEvidencePayload, REVIEW_EVIDENCE_SIGNER_TOKEN_ENV, REVIEW_EVIDENCE_SIGNER_TOKEN_FILE_ENV, type ReviewEvidenceIdentity, verifyReviewEvidence } from "../review/gate-attestation.js";

const tmpDirs: string[] = [];
const handles: EvidenceSignerHandle[] = [];
after(async () => {
	for (const h of handles.splice(0)) await h.close();
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function keypair(): { publicKeyPem: string; privateKeyPem: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	};
}

function socketPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "evidence-signer-test-"));
	tmpDirs.push(dir);
	return join(dir, "s.sock");
}

const AUTH = "a".repeat(MIN_SIGNER_AUTH_TOKEN_LENGTH);

async function startSigner(privateKeyPem: string, authToken = AUTH): Promise<EvidenceSignerHandle> {
	const handle = await serveEvidenceSigner({ socketPath: socketPath(), privateKeyPem, authToken });
	handles.push(handle);
	return handle;
}

function identity(over: Partial<ReviewEvidenceIdentity> = {}): ReviewEvidenceIdentity {
	return {
		repository: "owner/repo",
		prNumber: 42,
		itemId: "42",
		reviewedSha: "a".repeat(40),
		fleetRecordSha256: "b".repeat(64),
		adjudicationSourceSha256: "c".repeat(64),
		...over,
	};
}

describe("evidence signer round-trip", () => {
	it("signs a canonical payload whose signature verifies with the published pubkey", async () => {
		const { publicKeyPem, privateKeyPem } = keypair();
		const signer = await startSigner(privateKeyPem);
		const id = identity();
		const signature = await signReviewEvidenceViaSigner(id, signer.socketPath, { authToken: AUTH });
		assert.ok(signature, "signer returned a signature");
		assert.equal(Buffer.from(signature!, "base64url").length, 64);
		// Verification stays in-process against the public key — the exact identity the client sent.
		assert.equal(verifyReviewEvidence(buildReviewEvidencePayload(id), publicKeyPem, signature!), true);
		// A different identity must not verify under the same signature (domain + field binding).
		assert.equal(verifyReviewEvidence(buildReviewEvidencePayload(identity({ prNumber: 43 })), publicKeyPem, signature!), false);
	});
});

describe("evidence signer refuses non-canonical / foreign requests (domain binding)", () => {
	it("refuses malformed hex, extra keys, a missing identity, and a raw arbitrary-bytes request", () => {
		const { privateKeyPem } = keypair();
		const req = (body: unknown): { line: string; ok: boolean } => handleSignerRequestLine(JSON.stringify(body), privateKeyPem, AUTH);

		// A well-formed canonical identity with the authenticator signs.
		assert.equal(req({ v: SIGNER_PROTOCOL_VERSION, auth: AUTH, identity: identity() }).ok, true);
		// Missing or wrong authenticator ⇒ refused (same diagnostic; no signature).
		assert.equal(req({ v: SIGNER_PROTOCOL_VERSION, identity: identity() }).ok, false);
		assert.equal(req({ v: SIGNER_PROTOCOL_VERSION, auth: "b".repeat(MIN_SIGNER_AUTH_TOKEN_LENGTH), identity: identity() }).ok, false);
		assert.equal(JSON.parse(req({ v: SIGNER_PROTOCOL_VERSION, identity: identity() }).line).error, "unauthorized");
		// Malformed digest / sha ⇒ refused (buildReviewEvidencePayload rejects it server-side).
		assert.equal(req({ v: SIGNER_PROTOCOL_VERSION, auth: AUTH, identity: identity({ reviewedSha: "a".repeat(39) }) }).ok, false);
		assert.equal(req({ v: SIGNER_PROTOCOL_VERSION, auth: AUTH, identity: identity({ fleetRecordSha256: "Z".repeat(64) }) }).ok, false);
		// Extra keys ⇒ refused (closed shape).
		assert.equal(req({ v: SIGNER_PROTOCOL_VERSION, auth: AUTH, identity: { ...identity(), extra: "x" } }).ok, false);
		// No identity ⇒ refused.
		assert.equal(req({ v: SIGNER_PROTOCOL_VERSION, auth: AUTH }).ok, false);
		// A caller cannot get arbitrary bytes signed: the oracle only signs a reconstructed identity,
		// never a caller-supplied payload / domain.
		assert.equal(req({ v: SIGNER_PROTOCOL_VERSION, auth: AUTH, payload: "give me a signature over this" }).ok, false);
		assert.equal(req({ v: SIGNER_PROTOCOL_VERSION, auth: AUTH, identity: { ...identity(), domain: "attacker.v1" } }).ok, false);
		// Bad protocol / malformed json ⇒ refused.
		assert.equal(req({ v: 999, auth: AUTH, identity: identity() }).ok, false);
		assert.equal(handleSignerRequestLine("not json", privateKeyPem, AUTH).ok, false);

		// Every refusal is a fail-closed JSON response, never a thrown error or a signature.
		const refused = req({ v: SIGNER_PROTOCOL_VERSION, auth: AUTH, payload: "x" });
		const parsed = JSON.parse(refused.line);
		assert.equal(parsed.ok, false);
		assert.equal("signature" in parsed, false);
	});

	it("refuses a non-canonical identity over the live socket too", async () => {
		const { privateKeyPem } = keypair();
		const signer = await startSigner(privateKeyPem);
		const signature = await signReviewEvidenceViaSigner(identity({ itemId: "" }), signer.socketPath, { authToken: AUTH });
		assert.equal(signature, undefined);
	});
});

describe("evidence signer client graceful degrade", () => {
	it("returns undefined (unavailable) when no signer is listening at the socket path", async () => {
		const absent = socketPath(); // never bound
		const signature = await signReviewEvidenceViaSigner(identity(), absent, { timeoutMs: 500, authToken: AUTH });
		assert.equal(signature, undefined);
	});

	it("resolves the signer socket env, treating blank as absent", () => {
		assert.equal(resolveReviewEvidenceSignerSocket({ [REVIEW_EVIDENCE_SIGNER_SOCKET_ENV]: "  " }), undefined);
		assert.equal(resolveReviewEvidenceSignerSocket({}), undefined);
		assert.equal(resolveReviewEvidenceSignerSocket({ [REVIEW_EVIDENCE_SIGNER_SOCKET_ENV]: " /run/x.sock " }), "/run/x.sock");
	});

	it("does not connect when the client has no authenticator", async () => {
		const { privateKeyPem } = keypair();
		const signer = await startSigner(privateKeyPem);
		assert.equal(await signReviewEvidenceViaSigner(identity(), signer.socketPath), undefined);
		assert.equal(await signReviewEvidenceViaSigner(identity(), signer.socketPath, { authToken: "short" }), undefined);
	});

	it("returns undefined over the live socket when the authenticator is wrong", async () => {
		const { privateKeyPem } = keypair();
		const signer = await startSigner(privateKeyPem);
		assert.equal(await signReviewEvidenceViaSigner(identity(), signer.socketPath, { authToken: "b".repeat(MIN_SIGNER_AUTH_TOKEN_LENGTH) }), undefined);
	});
});

describe("harness signer-token file (one-shot, never environ)", () => {
	it("loads a 0400 token, unlinks the file, and ignores a signer-only env value", () => {
		const dir = mkdtempSync(join(tmpdir(), "evidence-signer-token-"));
		tmpDirs.push(dir);
		const file = join(dir, "token");
		writeFileSync(file, `${AUTH}\n`);
		chmodSync(file, 0o400);
		assert.equal(loadHarnessSignerAuthToken(file), AUTH);
		assert.equal(existsSync(file), false);

		// A token value in env is signer-only; the harness resolver never reads it.
		assert.equal(resolveReviewEvidenceSignerAuthToken({ [REVIEW_EVIDENCE_SIGNER_TOKEN_ENV]: AUTH }), undefined);
		assert.equal(resolveReviewEvidenceSignerAuthToken({}), undefined);
	});

	it("aborts on a group/other-accessible token file and leaves it in place", () => {
		const dir = mkdtempSync(join(tmpdir(), "evidence-signer-token-open-"));
		tmpDirs.push(dir);
		const file = join(dir, "token");
		writeFileSync(file, AUTH);
		chmodSync(file, 0o644);
		assert.throws(() => loadHarnessSignerAuthToken(file), /must not grant group or other access/);
		assert.equal(existsSync(file), true);
	});

	it("aborts when the one-shot token cannot be unlinked", () => {
		const dir = mkdtempSync(join(tmpdir(), "evidence-signer-token-unlink-"));
		tmpDirs.push(dir);
		const file = join(dir, "token");
		writeFileSync(file, AUTH);
		chmodSync(file, 0o400);
		chmodSync(dir, 0o500);
		try {
			assert.throws(() => loadHarnessSignerAuthToken(file), /could not unlink configured review-evidence signer token file/);
			assert.equal(existsSync(file), true);
		} finally {
			chmodSync(dir, 0o700);
		}
	});

	it("resolves PELAGGIO_REVIEW_EVIDENCE_SIGNER_TOKEN_FILE and unlinks it", () => {
		const dir = mkdtempSync(join(tmpdir(), "evidence-signer-token-env-"));
		tmpDirs.push(dir);
		const file = join(dir, "token");
		writeFileSync(file, AUTH);
		chmodSync(file, 0o400);
		assert.equal(resolveReviewEvidenceSignerAuthToken({ [REVIEW_EVIDENCE_SIGNER_TOKEN_FILE_ENV]: file }), AUTH);
		assert.equal(existsSync(file), false);
		// Custom env is not cached: a second explicit resolve sees an invalid configuration.
		assert.throws(() => resolveReviewEvidenceSignerAuthToken({ [REVIEW_EVIDENCE_SIGNER_TOKEN_FILE_ENV]: file }), /could not stat configured review-evidence signer token file/);
	});
});

describe("the harness never holds or constructs the evidence private key (#511)", () => {
	it("the harness sign call sites import no in-process signing primitive", () => {
		for (const rel of ["../pr-review-cli.ts", "../pipeline.ts"]) {
			const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
			assert.doesNotMatch(src, /\bsignReviewEvidence\b/, `${rel} must not reference in-process signReviewEvidence`);
			assert.doesNotMatch(src, /\bresolveReviewEvidencePrivateKey\b/, `${rel} must not resolve the private key`);
			assert.doesNotMatch(src, /\bcreatePrivateKey\b/, `${rel} must not construct a private key`);
			assert.doesNotMatch(src, /REVIEW_EVIDENCE_SIGNER_TOKEN_ENV/, `${rel} must not read the signer-only token env`);
		}
	});
});
