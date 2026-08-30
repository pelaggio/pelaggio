/**
 * The one atomic file writer for plain `.dev` records (L1; plan step 7b).
 *
 * Every JSON/text register used to carry its own tmp+rename copy with its own temp-name
 * convention. This is a *byte* primitive, deliberately not an envelope: each register keeps
 * its own on-disk shape, version field, validator and failure convention. Excluded on purpose
 * (their write semantics are the guarantee): `execution-receipt` (byte-identical idempotence +
 * collision detection + post-write verify), `attempt-identity` (O_EXCL allocator),
 * `file-lock` (a lock), `flow-events` (append-only JSONL), and `confinement/sessions`
 * (probe-injected for tests).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface WriteAtomicallyOptions {
	/** File mode for the published record. Omit to keep the process umask default. */
	mode?: number;
}

/**
 * Write `body` to `path` atomically: the parent directory is created, the bytes land in a
 * sibling temp file opened `wx` (a stale or predicted temp path is refused rather than reused —
 * `mode` is ignored on an existing inode, which could otherwise publish a permissive file), and
 * the temp is renamed over the destination. Readers never observe a partial record. On any
 * failure the temp file is removed and the error propagates; the destination is untouched.
 */
export function writeAtomically(path: string, body: string, options: WriteAtomicallyOptions = {}): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", ...(options.mode === undefined ? {} : { mode: options.mode }) });
		if (options.mode !== undefined) chmodSync(temporary, options.mode);
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/** `writeAtomically` for a JSON value serialized the way every record register already does. */
export function writeJsonAtomically(path: string, value: unknown, options: WriteAtomicallyOptions = {}): void {
	writeAtomically(path, `${JSON.stringify(value, null, 2)}\n`, options);
}
