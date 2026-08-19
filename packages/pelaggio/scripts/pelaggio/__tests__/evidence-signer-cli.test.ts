import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadSignerKey, loadSignerToken } from "../evidence-signer-cli.js";
import { MIN_SIGNER_AUTH_TOKEN_LENGTH } from "../review/evidence-signer.js";
import { REVIEW_EVIDENCE_PRIVATE_KEY_ENV, REVIEW_EVIDENCE_SIGNER_TOKEN_ENV } from "../review/gate-attestation.js";

const tmpDirs: string[] = [];
after(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "evidence-signer-cli-"));
	tmpDirs.push(dir);
	return dir;
}

function pem(): string {
	return generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("evidence-signer key loading", () => {
	it("reads the key from its own environment when no --key-file is given", () => {
		const key = pem();
		const loaded = loadSignerKey(undefined, { [REVIEW_EVIDENCE_PRIVATE_KEY_ENV]: key });
		// The env resolver trims surrounding whitespace; the PEM body is preserved.
		assert.deepEqual(loaded, { pem: key.trim() });
	});

	it("errors when neither --key-file nor the env supply a key", () => {
		const loaded = loadSignerKey(undefined, {});
		assert.ok("error" in loaded && /no signing key/.test(loaded.error));
	});

	it("loads a 0400 key file", () => {
		const file = join(tmp(), "key.pem");
		const key = pem();
		writeFileSync(file, key);
		chmodSync(file, 0o400);
		assert.deepEqual(loadSignerKey(file, {}), { pem: key });
	});

	it("refuses a group/other-accessible key file", () => {
		const file = join(tmp(), "key.pem");
		writeFileSync(file, pem());
		chmodSync(file, 0o644);
		const loaded = loadSignerKey(file, {});
		assert.ok("error" in loaded && /group\/other-accessible/.test(loaded.error));
	});

	it("errors on a missing key file", () => {
		const loaded = loadSignerKey(join(tmp(), "absent.pem"), {});
		assert.ok("error" in loaded && /cannot stat/.test(loaded.error));
	});
});

describe("evidence-signer token loading", () => {
	const token = "a".repeat(MIN_SIGNER_AUTH_TOKEN_LENGTH);

	it("reads the token from its own environment when no --token-file is given", () => {
		assert.deepEqual(loadSignerToken(undefined, { [REVIEW_EVIDENCE_SIGNER_TOKEN_ENV]: `  ${token}  ` }), { token });
	});

	it("errors when neither --token-file nor the env supply a token", () => {
		const loaded = loadSignerToken(undefined, {});
		assert.ok("error" in loaded && /no request token/.test(loaded.error));
	});

	it("refuses a token shorter than the documented minimum", () => {
		const loaded = loadSignerToken(undefined, { [REVIEW_EVIDENCE_SIGNER_TOKEN_ENV]: "too-short" });
		assert.ok("error" in loaded && /at least/.test(loaded.error));
	});

	it("loads a 0400 token file", () => {
		const file = join(tmp(), "token");
		writeFileSync(file, token);
		chmodSync(file, 0o400);
		assert.deepEqual(loadSignerToken(file, {}), { token });
	});

	it("refuses a group/other-accessible token file", () => {
		const file = join(tmp(), "token-open");
		writeFileSync(file, token);
		chmodSync(file, 0o644);
		const loaded = loadSignerToken(file, {});
		assert.ok("error" in loaded && /group\/other-accessible/.test(loaded.error));
	});
});
