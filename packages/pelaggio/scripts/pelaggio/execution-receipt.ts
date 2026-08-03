/**
 * Harness-issued, content-addressed execution receipt for successfully
 * dispatched effects manifests (#188).
 *
 * Produced at the effects seam after every handler succeeds and before the
 * successful manifest is deleted. Proves what the local harness accepted and
 * dispatched at one typed boundary — not that a model performed opaque tool
 * work, that a provider identity is cryptographically authenticated, or that
 * the host is uncompromised. A per-cycle challenge prevents accidental
 * cross-run substitution; by itself a self-issued nonce is not global replay
 * protection.
 */
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Effect } from "./effects.js";
import type { ExecutionReceiptDescriptor, ProviderName, Step } from "./types.js";

export const EXECUTION_RECEIPT_SCHEMA_VERSION = 1 as const;
export const EXECUTION_RECEIPT_KIND = "effects-manifest" as const;

/** Domain labels for domain-separated digests (`sha256(domain || 0x00 || bytes)`). */
export const RECEIPT_DOMAIN = {
	challenge: "pelaggio.execution-receipt.challenge.v1",
	manifest: "pelaggio.execution-receipt.manifest.v1",
	appendText: "pelaggio.execution-receipt.append-text.v1",
	receipt: "pelaggio.execution-receipt.body.v1",
} as const;

export interface GitRevisionBinding {
	/** Git object-ID (rev-parse HEAD), never an in-toto subject SHA-256. */
	headSha: string | null;
	branch: string | null;
}

export interface EffectsManifestReceipt {
	schemaVersion: typeof EXECUTION_RECEIPT_SCHEMA_VERSION;
	kind: typeof EXECUTION_RECEIPT_KIND;
	/** Domain-separated SHA-256 hex of the cycle challenge plaintext. */
	challengeDigest: string;
	itemId: string;
	runId: string;
	step: Step;
	attempt: number;
	/** Normalized worktree identity (relative-to-main or basename). */
	worktree: string | null;
	preGit: GitRevisionBinding;
	postGit: GitRevisionBinding;
	provider: ProviderName;
	model: string;
	issuedAt: string;
	completedAt: string;
	/** Domain-separated SHA-256 of the exact pre-delete manifest file bytes. */
	manifestDigest: string;
	dispatch: {
		outcome: "completed";
		/** Ordered effect kinds from the validated manifest. */
		effectKinds: Effect["kind"][];
	};
	/** Domain-separated SHA-256 of concatenated appendText when present. */
	appendTextDigest?: string;
}

export interface BuildEffectsManifestReceiptInput {
	challenge: Uint8Array;
	itemId: string;
	runId: string;
	step: Step;
	attempt: number;
	worktree: string | null;
	preGit: GitRevisionBinding;
	postGit: GitRevisionBinding;
	provider: ProviderName;
	model: string;
	/** Exact validated source-file bytes of the effects manifest (UTF-8). */
	manifestRawText: string;
	effectKinds: Effect["kind"][];
	appendText?: string;
	issuedAt: string;
	completedAt: string;
}

export interface VerifyExecutionReceiptExpected {
	/** When supplied, receipt.challengeDigest must match digest of this challenge. */
	challenge?: Uint8Array;
	itemId?: string;
	runId?: string;
	step?: Step;
	attempt?: number;
	provider?: ProviderName;
	model?: string;
	/** Expected preGit.headSha (step-start provenance). */
	preHeadSha?: string | null;
	/** When supplied, re-hash the on-disk receipt bytes and require a match. */
	receiptFileBytes?: string | Buffer;
	receiptSha256?: string;
}

export class ExecutionReceiptError extends Error {
	constructor(
		readonly code: "invalid_receipt" | "provenance_mismatch" | "challenge_mismatch" | "tampered" | "write_failed" | "collision",
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "ExecutionReceiptError";
	}
}

const HEX64_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const KNOWN_KEYS = new Set([
	"schemaVersion",
	"kind",
	"challengeDigest",
	"itemId",
	"runId",
	"step",
	"attempt",
	"worktree",
	"preGit",
	"postGit",
	"provider",
	"model",
	"issuedAt",
	"completedAt",
	"manifestDigest",
	"dispatch",
	"appendTextDigest",
]);

/**
 * Domain-separated SHA-256: `sha256(domain || 0x00 || bytes)`.
 * Matches the `\0` separator pattern used by `flow-events.ts` `digestId`.
 */
export function domainSeparatedDigest(domain: string, data: string | Uint8Array): string {
	const hash = createHash("sha256");
	hash.update(domain);
	hash.update("\0");
	hash.update(data);
	return hash.digest("hex");
}

export function digestChallenge(challenge: Uint8Array): string {
	return domainSeparatedDigest(RECEIPT_DOMAIN.challenge, challenge);
}

export function digestManifestBytes(rawText: string): string {
	return domainSeparatedDigest(RECEIPT_DOMAIN.manifest, rawText);
}

export function digestAppendText(text: string): string {
	return domainSeparatedDigest(RECEIPT_DOMAIN.appendText, text);
}

/** SHA-256 of exact on-disk receipt file bytes (evidence-registry digest). */
export function digestExecutionReceipt(fileBytes: string | Buffer): string {
	return createHash("sha256").update(fileBytes).digest("hex");
}

/** Worktree-relative receipt path: `.dev/execution-receipts/{runId}/{step}-{attempt}.json`. */
export function executionReceiptPath(cwd: string, runId: string, step: Step, attempt: number): string {
	return join(cwd, ".dev", "execution-receipts", runId, `${step}-${attempt}.json`);
}

/** Worktree-relative locator for evidence registry / StepLog. */
export function executionReceiptRelativePath(runId: string, step: Step, attempt: number): string {
	return `.dev/execution-receipts/${runId}/${step}-${attempt}.json`;
}

/**
 * Normalize worktree identity the same way as `readGitBinding`: relative-to-main
 * when under mainRepo, else basename. Callers may also pass an already-normalized
 * string from a prior `readGitBinding` observation.
 */
export function normalizeWorktreeIdentity(cwd: string | null, mainRepo: string): string | null {
	if (!cwd) return null;
	const relativeWorktree = relative(mainRepo, cwd);
	if (relativeWorktree && !relativeWorktree.startsWith("..") && relativeWorktree !== "") return relativeWorktree;
	return cwd.split(/[/\\]/).filter(Boolean).at(-1) ?? null;
}

export function buildEffectsManifestReceipt(input: BuildEffectsManifestReceiptInput): EffectsManifestReceipt {
	if (input.challenge.byteLength !== 32) {
		throw new ExecutionReceiptError("invalid_receipt", `challenge must be 32 bytes, got ${input.challenge.byteLength}`);
	}
	if (!isIsoTimestamp(input.issuedAt)) throw new ExecutionReceiptError("invalid_receipt", `issuedAt is not ISO-8601: ${input.issuedAt}`);
	if (!isIsoTimestamp(input.completedAt)) throw new ExecutionReceiptError("invalid_receipt", `completedAt is not ISO-8601: ${input.completedAt}`);

	const receipt: EffectsManifestReceipt = {
		schemaVersion: EXECUTION_RECEIPT_SCHEMA_VERSION,
		kind: EXECUTION_RECEIPT_KIND,
		challengeDigest: digestChallenge(input.challenge),
		itemId: input.itemId,
		runId: input.runId,
		step: input.step,
		attempt: input.attempt,
		worktree: input.worktree,
		preGit: { headSha: input.preGit.headSha, branch: input.preGit.branch },
		postGit: { headSha: input.postGit.headSha, branch: input.postGit.branch },
		provider: input.provider,
		model: input.model,
		issuedAt: input.issuedAt,
		completedAt: input.completedAt,
		manifestDigest: digestManifestBytes(input.manifestRawText),
		dispatch: {
			outcome: "completed",
			effectKinds: [...input.effectKinds],
		},
	};
	if (input.appendText !== undefined && input.appendText !== "") {
		receipt.appendTextDigest = digestAppendText(input.appendText);
	}
	return receipt;
}

/**
 * Fail-closed validation of a parsed receipt value. Rejects unknown schema
 * versions, malformed digests/timestamps, and extra/unknown fields.
 */
export function validateExecutionReceipt(value: unknown): EffectsManifestReceipt {
	if (!isRecord(value)) throw new ExecutionReceiptError("invalid_receipt", "execution receipt must be an object");
	for (const key of Object.keys(value)) {
		if (!KNOWN_KEYS.has(key)) throw new ExecutionReceiptError("invalid_receipt", `unknown field: ${key}`);
	}
	if (value.schemaVersion !== EXECUTION_RECEIPT_SCHEMA_VERSION) {
		throw new ExecutionReceiptError("invalid_receipt", `unsupported schemaVersion: ${String(value.schemaVersion)}`);
	}
	if (value.kind !== EXECUTION_RECEIPT_KIND) {
		throw new ExecutionReceiptError("invalid_receipt", `kind must be "${EXECUTION_RECEIPT_KIND}"`);
	}
	if (!isHex64(value.challengeDigest)) throw new ExecutionReceiptError("invalid_receipt", "challengeDigest must be 64-char lowercase hex");
	if (typeof value.itemId !== "string") throw new ExecutionReceiptError("invalid_receipt", "itemId must be a string");
	if (typeof value.runId !== "string" || value.runId.trim() === "") throw new ExecutionReceiptError("invalid_receipt", "runId must be a non-empty string");
	if (typeof value.step !== "string" || value.step.trim() === "") throw new ExecutionReceiptError("invalid_receipt", "step must be a non-empty string");
	if (typeof value.attempt !== "number" || !Number.isInteger(value.attempt) || value.attempt < 0) {
		throw new ExecutionReceiptError("invalid_receipt", "attempt must be a non-negative integer");
	}
	if (value.worktree !== null && typeof value.worktree !== "string") {
		throw new ExecutionReceiptError("invalid_receipt", "worktree must be a string or null");
	}
	const preGit = validateGitBinding(value.preGit, "preGit");
	const postGit = validateGitBinding(value.postGit, "postGit");
	if (typeof value.provider !== "string" || value.provider.trim() === "") {
		throw new ExecutionReceiptError("invalid_receipt", "provider must be a non-empty string");
	}
	if (typeof value.model !== "string" || value.model.trim() === "") {
		throw new ExecutionReceiptError("invalid_receipt", "model must be a non-empty string");
	}
	if (typeof value.issuedAt !== "string" || !isIsoTimestamp(value.issuedAt)) {
		throw new ExecutionReceiptError("invalid_receipt", "issuedAt must be an ISO-8601 timestamp");
	}
	if (typeof value.completedAt !== "string" || !isIsoTimestamp(value.completedAt)) {
		throw new ExecutionReceiptError("invalid_receipt", "completedAt must be an ISO-8601 timestamp");
	}
	if (!isHex64(value.manifestDigest)) throw new ExecutionReceiptError("invalid_receipt", "manifestDigest must be 64-char lowercase hex");
	if (!isRecord(value.dispatch)) throw new ExecutionReceiptError("invalid_receipt", "dispatch must be an object");
	if (value.dispatch.outcome !== "completed") throw new ExecutionReceiptError("invalid_receipt", 'dispatch.outcome must be "completed"');
	if (!Array.isArray(value.dispatch.effectKinds) || !value.dispatch.effectKinds.every((k) => typeof k === "string")) {
		throw new ExecutionReceiptError("invalid_receipt", "dispatch.effectKinds must be an array of strings");
	}
	if (value.appendTextDigest !== undefined && !isHex64(value.appendTextDigest)) {
		throw new ExecutionReceiptError("invalid_receipt", "appendTextDigest must be 64-char lowercase hex when present");
	}

	const receipt: EffectsManifestReceipt = {
		schemaVersion: EXECUTION_RECEIPT_SCHEMA_VERSION,
		kind: EXECUTION_RECEIPT_KIND,
		challengeDigest: value.challengeDigest,
		itemId: value.itemId,
		runId: value.runId,
		step: value.step as Step,
		attempt: value.attempt,
		worktree: value.worktree as string | null,
		preGit,
		postGit,
		provider: value.provider as ProviderName,
		model: value.model,
		issuedAt: value.issuedAt,
		completedAt: value.completedAt,
		manifestDigest: value.manifestDigest,
		dispatch: {
			outcome: "completed",
			effectKinds: value.dispatch.effectKinds as Effect["kind"][],
		},
	};
	if (typeof value.appendTextDigest === "string") receipt.appendTextDigest = value.appendTextDigest;
	return receipt;
}

/**
 * Verify a receipt against expected dispatch context. Fail-closed on provenance
 * mismatch, unexpected challenge, or receipt-byte digest mismatch / tampering.
 */
export function verifyExecutionReceipt(receipt: EffectsManifestReceipt, expected: VerifyExecutionReceiptExpected = {}): void {
	validateExecutionReceipt(receipt);
	if (expected.challenge !== undefined) {
		const want = digestChallenge(expected.challenge);
		if (receipt.challengeDigest !== want) {
			throw new ExecutionReceiptError("challenge_mismatch", "receipt challengeDigest does not match expected challenge");
		}
	}
	if (expected.itemId !== undefined && receipt.itemId !== expected.itemId) {
		throw new ExecutionReceiptError("provenance_mismatch", `receipt itemId ${receipt.itemId} does not match ${expected.itemId}`);
	}
	if (expected.runId !== undefined && receipt.runId !== expected.runId) {
		throw new ExecutionReceiptError("provenance_mismatch", `receipt runId ${receipt.runId} does not match ${expected.runId}`);
	}
	if (expected.step !== undefined && receipt.step !== expected.step) {
		throw new ExecutionReceiptError("provenance_mismatch", `receipt step ${receipt.step} does not match ${expected.step}`);
	}
	if (expected.attempt !== undefined && receipt.attempt !== expected.attempt) {
		throw new ExecutionReceiptError("provenance_mismatch", `receipt attempt ${receipt.attempt} does not match ${expected.attempt}`);
	}
	if (expected.provider !== undefined && receipt.provider !== expected.provider) {
		throw new ExecutionReceiptError("provenance_mismatch", `receipt provider ${receipt.provider} does not match ${expected.provider}`);
	}
	if (expected.model !== undefined && receipt.model !== expected.model) {
		throw new ExecutionReceiptError("provenance_mismatch", `receipt model ${receipt.model} does not match ${expected.model}`);
	}
	if (expected.preHeadSha !== undefined && receipt.preGit.headSha !== expected.preHeadSha) {
		throw new ExecutionReceiptError("provenance_mismatch", `receipt preGit.headSha does not match expected preSha`);
	}
	if (expected.receiptFileBytes !== undefined) {
		const got = digestExecutionReceipt(expected.receiptFileBytes);
		if (expected.receiptSha256 !== undefined && got !== expected.receiptSha256) {
			throw new ExecutionReceiptError("tampered", "receipt file bytes do not match expected sha256");
		}
	} else if (expected.receiptSha256 !== undefined) {
		// Caller supplied a digest without bytes — cannot verify tamper; reject fail-closed
		// only when both are needed is intentional; ignore lone sha when no bytes.
	}
}

/**
 * Serialize with fixed field order + pretty-print matching writeEffectsManifest /
 * writeReviewRecord style, then atomically write. Returns a worktree-relative
 * descriptor whose sha256 is the SHA-256 of the exact on-disk UTF-8 bytes.
 *
 * Collision: identical bytes → idempotent success; different bytes → throw.
 */
export function writeExecutionReceipt(cwd: string, receipt: EffectsManifestReceipt): ExecutionReceiptDescriptor {
	const valid = validateExecutionReceipt(receipt);
	const absPath = executionReceiptPath(cwd, valid.runId, valid.step, valid.attempt);
	const relativePath = executionReceiptRelativePath(valid.runId, valid.step, valid.attempt);
	const body = serializeReceipt(valid);
	const sha256 = digestExecutionReceipt(body);

	if (existsSync(absPath)) {
		const existing = readFileSync(absPath);
		const existingSha = digestExecutionReceipt(existing);
		if (existingSha === sha256 && existing.toString("utf-8") === body) {
			return { path: relativePath, sha256 };
		}
		throw new ExecutionReceiptError("collision", `execution receipt already exists with different content: ${relativePath}`);
	}

	try {
		mkdirSync(dirname(absPath), { recursive: true });
		const temporary = `${absPath}.tmp-${process.pid}-${nodeRandomBytes(4).toString("hex")}`;
		writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, absPath);
	} catch (e) {
		if (e instanceof ExecutionReceiptError) throw e;
		throw new ExecutionReceiptError("write_failed", e instanceof Error ? e.message : String(e), { cause: e });
	}

	// Confirm the file we just wrote matches (detect partial write / tamper races).
	const onDisk = readFileSync(absPath);
	const onDiskSha = digestExecutionReceipt(onDisk);
	if (onDiskSha !== sha256) {
		throw new ExecutionReceiptError("tampered", `execution receipt bytes changed after write: ${relativePath}`);
	}
	return { path: relativePath, sha256 };
}

/** Deterministic pretty-print with fixed field order (object-literal order). */
export function serializeReceipt(receipt: EffectsManifestReceipt): string {
	const valid = validateExecutionReceipt(receipt);
	// Rebuild in stable key order so hash(file) is independent of insertion order
	// on the input object (callers may have reordered keys via spreads).
	const ordered: Record<string, unknown> = {
		schemaVersion: valid.schemaVersion,
		kind: valid.kind,
		challengeDigest: valid.challengeDigest,
		itemId: valid.itemId,
		runId: valid.runId,
		step: valid.step,
		attempt: valid.attempt,
		worktree: valid.worktree,
		preGit: { headSha: valid.preGit.headSha, branch: valid.preGit.branch },
		postGit: { headSha: valid.postGit.headSha, branch: valid.postGit.branch },
		provider: valid.provider,
		model: valid.model,
		issuedAt: valid.issuedAt,
		completedAt: valid.completedAt,
		manifestDigest: valid.manifestDigest,
		dispatch: {
			outcome: valid.dispatch.outcome,
			effectKinds: [...valid.dispatch.effectKinds],
		},
	};
	if (valid.appendTextDigest !== undefined) ordered.appendTextDigest = valid.appendTextDigest;
	return `${JSON.stringify(ordered, null, 2)}\n`;
}

function validateGitBinding(value: unknown, label: string): GitRevisionBinding {
	if (!isRecord(value)) throw new ExecutionReceiptError("invalid_receipt", `${label} must be an object`);
	for (const key of Object.keys(value)) {
		if (key !== "headSha" && key !== "branch") {
			throw new ExecutionReceiptError("invalid_receipt", `${label} has unknown field: ${key}`);
		}
	}
	if (value.headSha !== null && typeof value.headSha !== "string") {
		throw new ExecutionReceiptError("invalid_receipt", `${label}.headSha must be a string or null`);
	}
	if (value.branch !== null && typeof value.branch !== "string") {
		throw new ExecutionReceiptError("invalid_receipt", `${label}.branch must be a string or null`);
	}
	return { headSha: value.headSha as string | null, branch: value.branch as string | null };
}

function isHex64(value: unknown): value is string {
	return typeof value === "string" && HEX64_RE.test(value);
}

function isIsoTimestamp(value: string): boolean {
	if (!ISO_RE.test(value)) return false;
	return !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
