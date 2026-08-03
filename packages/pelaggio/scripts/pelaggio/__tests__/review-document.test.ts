import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { assertDocumentUnchanged, DOCUMENT_INJECTION_MAX_BYTES, DocumentSnapshotError, documentInjectionState, formatDocumentUnderReview, snapshotDocument } from "../review/document.js";

describe("document snapshot contract (#384)", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "pelaggio-doc-"));
	});
	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("snapshots a file and binds a stable sha256 digest over the raw bytes", () => {
		const path = join(dir, "plan.md");
		writeFileSync(path, "# Plan\n\nbody\n", "utf-8");
		const snap = snapshotDocument(path);
		assert.equal(snap.text, "# Plan\n\nbody\n");
		assert.equal(snap.byteLength, Buffer.byteLength("# Plan\n\nbody\n"));
		assert.match(snap.digest, /^[a-f0-9]{64}$/);
		// Deterministic: re-snapshotting identical bytes yields the identical digest.
		assert.equal(snapshotDocument(path).digest, snap.digest);
	});

	it("throws on a missing path", () => {
		assert.throws(() => snapshotDocument(join(dir, "nope.md")), DocumentSnapshotError);
	});

	it("throws on a non-file path (directory)", () => {
		const sub = join(dir, "adir");
		mkdirSync(sub, { recursive: true });
		assert.throws(() => snapshotDocument(sub), /not a file/);
	});

	it("rejects an empty path argument", () => {
		assert.throws(() => snapshotDocument("   "), DocumentSnapshotError);
	});

	it("rejects non-UTF-8 content", () => {
		const path = join(dir, "binary.md");
		writeFileSync(path, Buffer.from([0xff, 0xfe, 0x00, 0x80]));
		assert.throws(() => snapshotDocument(path), /not valid UTF-8/);
	});

	it("assertDocumentUnchanged passes on identical bytes and throws after a mid-review edit", () => {
		const path = join(dir, "mutate.md");
		writeFileSync(path, "original\n", "utf-8");
		const snap = snapshotDocument(path);
		assert.doesNotThrow(() => assertDocumentUnchanged(snap));
		writeFileSync(path, "tampered\n", "utf-8");
		assert.throws(() => assertDocumentUnchanged(snap), /changed during review/);
	});

	it("assertDocumentUnchanged throws when the file disappears mid-review", () => {
		const path = join(dir, "vanish.md");
		writeFileSync(path, "here\n", "utf-8");
		const snap = snapshotDocument(path);
		rmSync(path);
		assert.throws(() => assertDocumentUnchanged(snap), /unreadable during review/);
	});

	it("truncates the injected block without changing the full-file digest", () => {
		const path = join(dir, "big.md");
		const big = `${"x".repeat(DOCUMENT_INJECTION_MAX_BYTES + 4096)}\n`;
		writeFileSync(path, big, "utf-8");
		const snap = snapshotDocument(path);
		assert.equal(documentInjectionState(snap), "truncated");
		const block = formatDocumentUnderReview(snap, "truncated");
		assert.match(block, /document truncated at the injection cap/);
		// The digest in the header covers the full file, not the truncated injection.
		assert.match(block, new RegExp(snap.digest));
		assert.ok(block.length < big.length + 4096);
	});

	it("emits an ok state block with the full body for a small document", () => {
		const path = join(dir, "small.md");
		writeFileSync(path, "tiny doc\n", "utf-8");
		const snap = snapshotDocument(path);
		assert.equal(documentInjectionState(snap), "ok");
		const block = formatDocumentUnderReview(snap, "ok");
		assert.match(block, /## DOCUMENT UNDER REVIEW/);
		assert.match(block, /tiny doc/);
		assert.doesNotMatch(block, /truncated at the injection cap/);
	});
});
