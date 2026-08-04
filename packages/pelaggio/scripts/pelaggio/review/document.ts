/**
 * Document snapshot contract for `pelaggio doc-review` (#384).
 *
 * A document review is bound to the exact bytes reviewed, not to a mutable path. The CLI reads the
 * file once, hashes the raw bytes, injects the identical content into every seat prompt, and
 * re-verifies the digest before writing a success-bound report. This module is pure (no shell, no
 * config import) so the fail-closed rules are unit-testable in isolation.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Injection cap for the DOCUMENT UNDER REVIEW block. Mirrors `REVIEW_DIFF_MAX_BYTES` (256 KiB): a huge
 * document would blow the seat's context, and the seat can always open the path for the remainder. The
 * digest always covers the FULL file bytes, never this truncated injection.
 */
export const DOCUMENT_INJECTION_MAX_BYTES = 256 * 1024;

export type DocumentSnapshot = {
	/** Caller-supplied path in posix display form (used for the report binding + prompt label). */
	path: string;
	/** Resolved absolute path used for I/O and re-verification. */
	absPath: string;
	/** Raw bytes read from disk. */
	bytes: Buffer;
	/** UTF-8 decode of {@link bytes} (non-UTF-8 input is rejected at snapshot time). */
	text: string;
	/** sha256 hex of the full file bytes. */
	digest: string;
	byteLength: number;
};

export class DocumentSnapshotError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DocumentSnapshotError";
	}
}

/** Posix display form: normalize backslashes so the report binding is stable across platforms. */
function toPosixDisplay(path: string): string {
	return path.replace(/\\/g, "/");
}

function sha256Hex(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8Strict(bytes: Buffer, path: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new DocumentSnapshotError(`document is not valid UTF-8: ${path}`);
	}
}

/**
 * Read a document once and bind it to its byte digest. Fail-closed: a missing path, a non-file
 * (directory / device), an unreadable file, or non-UTF-8 content all throw {@link DocumentSnapshotError}.
 */
export function snapshotDocument(path: string, cwd: string = process.cwd()): DocumentSnapshot {
	if (typeof path !== "string" || path.trim() === "") throw new DocumentSnapshotError("document path is required");
	const absPath = isAbsolute(path) ? path : resolve(cwd, path);
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(absPath);
	} catch (error) {
		throw new DocumentSnapshotError(`document path is missing or unreadable: ${path}`, { cause: error });
	}
	if (!stat.isFile()) throw new DocumentSnapshotError(`document path is not a file: ${path}`);
	let bytes: Buffer;
	try {
		bytes = readFileSync(absPath);
	} catch (error) {
		throw new DocumentSnapshotError(`document path is unreadable: ${path}`, { cause: error });
	}
	const text = decodeUtf8Strict(bytes, path);
	return { path: toPosixDisplay(path), absPath, bytes, text, digest: sha256Hex(bytes), byteLength: bytes.byteLength };
}

/**
 * Re-read the snapshotted file and confirm its digest is unchanged. Throws when the file changed,
 * disappeared, or became unreadable mid-review — the report must never be written against stale bytes.
 */
export function assertDocumentUnchanged(snapshot: DocumentSnapshot): void {
	let bytes: Buffer;
	try {
		bytes = readFileSync(snapshot.absPath);
	} catch (error) {
		throw new DocumentSnapshotError(`document became unreadable during review: ${snapshot.path}`, { cause: error });
	}
	const digest = sha256Hex(bytes);
	if (digest !== snapshot.digest) throw new DocumentSnapshotError(`document changed during review: ${snapshot.path} (${snapshot.digest.slice(0, 12)} → ${digest.slice(0, 12)})`);
}

/** Whether the injected document must be truncated to fit the cap. */
export function documentInjectionState(snapshot: DocumentSnapshot): "ok" | "truncated" {
	return snapshot.byteLength > DOCUMENT_INJECTION_MAX_BYTES ? "truncated" : "ok";
}

/**
 * Format the DOCUMENT UNDER REVIEW block injected into every seat prompt. Pure/testable: the caller
 * decides `state` via {@link documentInjectionState}. A truncated document appends the open-the-path
 * pointer; the header always carries the full-file digest + byte length so a seat cannot be fooled into
 * reviewing a truncated stand-in as if it were the whole document.
 */
export function formatDocumentUnderReview(snapshot: DocumentSnapshot, state: "ok" | "truncated"): string {
	const header = "## DOCUMENT UNDER REVIEW";
	const meta = [`- path: \`${snapshot.path}\``, `- sha256: \`${snapshot.digest}\``, `- bytes: ${snapshot.byteLength}`].join("\n");
	// Truncate on a byte boundary, then drop any partial trailing line so the fenced block stays clean.
	let body = snapshot.text;
	if (state === "truncated") {
		const sliced = snapshot.bytes.subarray(0, DOCUMENT_INJECTION_MAX_BYTES).toString("utf-8");
		body = sliced.slice(0, Math.max(0, sliced.lastIndexOf("\n")));
	}
	const trailer = state === "truncated" ? "\n\n[document truncated at the injection cap — open the path for the remainder; the sha256 above covers the full file]" : "";
	return `${header}\n\nThis is the authoritative document under review (read-only). Do not edit, stage, or commit anything.\n\n${meta}\n\n\`\`\`\n${body}\n\`\`\`${trailer}`;
}
