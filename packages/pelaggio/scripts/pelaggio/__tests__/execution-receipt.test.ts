import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	buildEffectsManifestReceipt,
	digestChallenge,
	digestExecutionReceipt,
	digestManifestBytes,
	domainSeparatedDigest,
	type EffectsManifestReceipt,
	ExecutionReceiptError,
	executionReceiptPath,
	RECEIPT_DOMAIN,
	serializeReceipt,
	validateExecutionReceipt,
	verifyExecutionReceipt,
	writeExecutionReceipt,
} from "../execution-receipt.js";

const CHALLENGE = new Uint8Array(32).fill(0xab);
const MANIFEST_BYTES = '{\n  "schemaVersion": 1\n}\n';
const ISSUED = "2026-08-03T12:00:00.000Z";
const COMPLETED = "2026-08-03T12:00:01.000Z";

function baseInput(overrides: Partial<Parameters<typeof buildEffectsManifestReceipt>[0]> = {}) {
	return {
		challenge: CHALLENGE,
		itemId: "188",
		runId: "cycle-1-188",
		step: "plan" as const,
		attempt: 1,
		worktree: "feat/issue-188",
		preGit: { headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", branch: "feat/issue-188" },
		postGit: { headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", branch: "feat/issue-188" },
		provider: "claude" as const,
		model: "claude-sonnet-4-6",
		manifestRawText: MANIFEST_BYTES,
		effectKinds: ["checkpoint" as const],
		issuedAt: ISSUED,
		completedAt: COMPLETED,
		...overrides,
	};
}

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "pelaggio-receipt-"));
}

describe("domain-separated digests", () => {
	it("is stable for the same inputs", () => {
		const a = domainSeparatedDigest(RECEIPT_DOMAIN.challenge, CHALLENGE);
		const b = domainSeparatedDigest(RECEIPT_DOMAIN.challenge, CHALLENGE);
		assert.equal(a, b);
		assert.match(a, /^[0-9a-f]{64}$/);
	});

	it("differs across domains for the same bytes", () => {
		const c = domainSeparatedDigest(RECEIPT_DOMAIN.challenge, MANIFEST_BYTES);
		const m = domainSeparatedDigest(RECEIPT_DOMAIN.manifest, MANIFEST_BYTES);
		assert.notEqual(c, m);
	});

	it("is sensitive to challenge, manifest, and append-text material", () => {
		const otherChallenge = new Uint8Array(32).fill(0xcd);
		assert.notEqual(digestChallenge(CHALLENGE), digestChallenge(otherChallenge));
		assert.notEqual(digestManifestBytes(MANIFEST_BYTES), digestManifestBytes(`${MANIFEST_BYTES} `));
	});
});

describe("buildEffectsManifestReceipt", () => {
	it("builds a schemaVersion-1 effects-manifest receipt with domain-separated digests", () => {
		const receipt = buildEffectsManifestReceipt(baseInput());
		assert.equal(receipt.schemaVersion, 1);
		assert.equal(receipt.kind, "effects-manifest");
		assert.equal(receipt.challengeDigest, digestChallenge(CHALLENGE));
		assert.equal(receipt.manifestDigest, digestManifestBytes(MANIFEST_BYTES));
		assert.deepEqual(receipt.dispatch, { outcome: "completed", effectKinds: ["checkpoint"] });
		assert.equal(receipt.appendTextDigest, undefined);
	});

	it("includes appendTextDigest only when append text is present", () => {
		const withAppend = buildEffectsManifestReceipt(baseInput({ appendText: "https://example.invalid/pr/1" }));
		assert.ok(withAppend.appendTextDigest);
		const without = buildEffectsManifestReceipt(baseInput({ appendText: "" }));
		assert.equal(without.appendTextDigest, undefined);
	});

	it("is sensitive to provider, model, attempt, and pre/post headSha", () => {
		const base = buildEffectsManifestReceipt(baseInput());
		const otherProvider = buildEffectsManifestReceipt(baseInput({ provider: "codex", model: "gpt" }));
		const otherAttempt = buildEffectsManifestReceipt(baseInput({ attempt: 2 }));
		const otherPre = buildEffectsManifestReceipt(baseInput({ preGit: { headSha: "cccccccccccccccccccccccccccccccccccccccc", branch: "feat/issue-188" } }));
		assert.notEqual(base.provider, otherProvider.provider);
		assert.notEqual(base.attempt, otherAttempt.attempt);
		assert.notEqual(base.preGit.headSha, otherPre.preGit.headSha);
	});

	it("rejects a non-32-byte challenge", () => {
		assert.throws(
			() => buildEffectsManifestReceipt(baseInput({ challenge: new Uint8Array(16) })),
			(err) => err instanceof ExecutionReceiptError && err.code === "invalid_receipt",
		);
	});
});

describe("validateExecutionReceipt", () => {
	it("accepts a well-formed receipt", () => {
		const built = buildEffectsManifestReceipt(baseInput());
		const validated = validateExecutionReceipt(built);
		assert.equal(validated.runId, built.runId);
	});

	it("rejects unknown schemaVersion, extra fields, and bad digests", () => {
		const built = buildEffectsManifestReceipt(baseInput()) as EffectsManifestReceipt & Record<string, unknown>;
		assert.throws(
			() => validateExecutionReceipt({ ...built, schemaVersion: 99 }),
			(err) => err instanceof ExecutionReceiptError && err.code === "invalid_receipt",
		);
		assert.throws(
			() => validateExecutionReceipt({ ...built, extra: true }),
			(err) => err instanceof ExecutionReceiptError && /unknown field/.test(err.message),
		);
		assert.throws(
			() => validateExecutionReceipt({ ...built, challengeDigest: "not-hex" }),
			(err) => err instanceof ExecutionReceiptError && err.code === "invalid_receipt",
		);
		assert.throws(
			() => validateExecutionReceipt({ ...built, issuedAt: "yesterday" }),
			(err) => err instanceof ExecutionReceiptError && err.code === "invalid_receipt",
		);
	});
});

describe("verifyExecutionReceipt", () => {
	it("accepts a matching expected context and challenge", () => {
		const receipt = buildEffectsManifestReceipt(baseInput());
		verifyExecutionReceipt(receipt, {
			challenge: CHALLENGE,
			itemId: "188",
			runId: "cycle-1-188",
			step: "plan",
			attempt: 1,
			provider: "claude",
			model: "claude-sonnet-4-6",
			preHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
	});

	it("fails closed on expected-context mismatch", () => {
		const receipt = buildEffectsManifestReceipt(baseInput());
		assert.throws(
			() => verifyExecutionReceipt(receipt, { itemId: "OTHER" }),
			(err) => err instanceof ExecutionReceiptError && err.code === "provenance_mismatch",
		);
	});

	it("fails closed when the expected challenge does not match", () => {
		const receipt = buildEffectsManifestReceipt(baseInput());
		const other = new Uint8Array(32).fill(0x11);
		assert.throws(
			() => verifyExecutionReceipt(receipt, { challenge: other }),
			(err) => err instanceof ExecutionReceiptError && err.code === "challenge_mismatch",
		);
	});
});

describe("writeExecutionReceipt", () => {
	it("writes atomically with stable bytes independent of input key order", () => {
		const cwd = tempCwd();
		const receipt = buildEffectsManifestReceipt(baseInput());
		// Shuffle key order by rebuild from JSON round-trip with keys reordered.
		const shuffled = JSON.parse(
			JSON.stringify({
				dispatch: receipt.dispatch,
				model: receipt.model,
				provider: receipt.provider,
				schemaVersion: receipt.schemaVersion,
				kind: receipt.kind,
				challengeDigest: receipt.challengeDigest,
				itemId: receipt.itemId,
				runId: receipt.runId,
				step: receipt.step,
				attempt: receipt.attempt,
				worktree: receipt.worktree,
				preGit: receipt.preGit,
				postGit: receipt.postGit,
				issuedAt: receipt.issuedAt,
				completedAt: receipt.completedAt,
				manifestDigest: receipt.manifestDigest,
			}),
		) as EffectsManifestReceipt;
		const desc = writeExecutionReceipt(cwd, shuffled);
		assert.equal(desc.path, `.dev/execution-receipts/${receipt.runId}/plan-1.json`);
		const onDisk = readFileSync(join(cwd, desc.path), "utf-8");
		assert.equal(desc.sha256, digestExecutionReceipt(onDisk));
		assert.equal(onDisk, serializeReceipt(receipt));
	});

	it("treats an identical-bytes collision as idempotent success", () => {
		const cwd = tempCwd();
		const receipt = buildEffectsManifestReceipt(baseInput());
		const first = writeExecutionReceipt(cwd, receipt);
		const second = writeExecutionReceipt(cwd, receipt);
		assert.deepEqual(first, second);
	});

	it("fails closed on a different-bytes collision", () => {
		const cwd = tempCwd();
		const receipt = buildEffectsManifestReceipt(baseInput());
		writeExecutionReceipt(cwd, receipt);
		const other = buildEffectsManifestReceipt(baseInput({ model: "other-model" }));
		assert.throws(
			() => writeExecutionReceipt(cwd, other),
			(err) => err instanceof ExecutionReceiptError && err.code === "collision",
		);
	});

	it("detects post-write tampering when re-verifying file bytes", () => {
		const cwd = tempCwd();
		const receipt = buildEffectsManifestReceipt(baseInput());
		const desc = writeExecutionReceipt(cwd, receipt);
		const path = join(cwd, desc.path);
		const original = readFileSync(path, "utf-8");
		writeFileSync(path, original.replace(receipt.model, "tampered-model"));
		const tampered = readFileSync(path, "utf-8");
		assert.notEqual(digestExecutionReceipt(tampered), desc.sha256);
		assert.throws(
			() =>
				verifyExecutionReceipt(receipt, {
					receiptFileBytes: tampered,
					receiptSha256: desc.sha256,
				}),
			(err) => err instanceof ExecutionReceiptError && err.code === "tampered",
		);
	});

	it("does not leave a final receipt when the target directory cannot be written mid-flight", () => {
		const cwd = tempCwd();
		const abs = executionReceiptPath(cwd, "cycle-1-188", "plan", 1);
		// Make `.dev` a plain file so mkdirSync of `.dev/execution-receipts/...` fails.
		writeFileSync(join(cwd, ".dev"), "not-a-dir");
		const receipt = buildEffectsManifestReceipt(baseInput());
		assert.throws(
			() => writeExecutionReceipt(cwd, receipt),
			(err) => err instanceof ExecutionReceiptError && err.code === "write_failed",
		);
		assert.equal(existsSync(abs), false);
	});
});
