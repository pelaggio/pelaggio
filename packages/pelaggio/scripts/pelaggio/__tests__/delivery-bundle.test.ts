import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { canonicalJson, DeliveryBundleError, digestObjectBytes, loadBundle, objectPath, publishAttachment, publishObject, validateDeliveryCase, validateDeliveryRecord, validateDeliveryRoots, writeRoots } from "../delivery/bundle.js";
import type { DeliveryCase, DeliveryRecord, DeliverySubject } from "../delivery/types.js";

const ISSUED = "2026-08-31T12:00:00.000Z";
const TREE = "a".repeat(40);
const DIGEST = "b".repeat(64);

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "pelaggio-delivery-"));
}

function issuer() {
	return { kind: "harness" as const, id: "pelaggio-local" };
}

function subject(overrides: Partial<DeliverySubject> = {}): DeliverySubject {
	return {
		gitDir: "/tmp/repo/.git",
		repository: null,
		repositoryResidual: "no-origin",
		baseCommit: "c".repeat(40),
		baseTree: TREE,
		candidateCommit: "d".repeat(40),
		resultTree: TREE,
		diffTreeDigest: DIGEST,
		...overrides,
	};
}

function record(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
	return {
		schemaVersion: 1,
		kind: "Observation",
		id: "obs-1",
		role: "subject",
		issuedAt: ISSUED,
		issuer: issuer(),
		...overrides,
	};
}

describe("canonicalJson", () => {
	it("is invariant to source object key order", () => {
		const a = canonicalJson({ b: 1, a: 2 });
		const b = canonicalJson({ a: 2, b: 1 });
		assert.equal(a, b);
		assert.equal(a, '{"a":2,"b":1}\n');
		assert.equal(digestObjectBytes(a), digestObjectBytes(b));
	});

	it("is sensitive to every semantic byte", () => {
		assert.notEqual(digestObjectBytes(canonicalJson({ a: 1 })), digestObjectBytes(canonicalJson({ a: 2 })));
	});

	it("rejects non-finite numbers, undefined, and bigint", () => {
		assert.throws(() => canonicalJson({ n: Number.NaN }), /non-finite/);
		assert.throws(() => canonicalJson({ n: Number.POSITIVE_INFINITY }), /non-finite/);
		assert.throws(() => canonicalJson({ u: undefined }), /undefined/);
		assert.throws(() => canonicalJson({ n: 1n }), /bigint/);
	});

	it("sorts nested keys by code unit and emits one trailing newline", () => {
		const bytes = canonicalJson({ z: { b: 1, a: { d: 1, c: 1 } } });
		assert.equal(bytes, '{"z":{"a":{"c":1,"d":1},"b":1}}\n');
		assert.equal(bytes.endsWith("\n"), true);
		assert.equal(bytes.endsWith("\n\n"), false);
	});
});

describe("strict schemas", () => {
	it("rejects unknown record fields and schema versions", () => {
		assert.throws(() => validateDeliveryRecord({ ...record(), extra: true }), /unknown field extra/);
		assert.throws(() => validateDeliveryRecord({ ...record(), schemaVersion: 99 }), /unsupported schemaVersion/);
		assert.throws(() => validateDeliveryRecord({ ...record(), kind: "Case" }), /kind must be a delivery record kind/);
	});

	it("rejects unknown Case/roots fields", () => {
		const c: DeliveryCase = {
			schemaVersion: 1,
			kind: "Case",
			id: "case-1",
			issuedAt: ISSUED,
			issuer: issuer(),
			subject: subject(),
			admittedRecords: [DIGEST],
			obligations: [{ id: "o1", group: "intent", recordDigests: [DIGEST], attachmentDigests: [] }],
			residuals: [],
		};
		assert.throws(() => validateDeliveryCase({ ...c, extra: 1 }), /unknown field extra/);
		assert.throws(() => validateDeliveryRoots({ schemaVersion: 1, case: DIGEST, extra: 1 }), /unknown field extra/);
		validateDeliveryCase(c);
		validateDeliveryRoots({ schemaVersion: 1, case: DIGEST });
	});
});

describe("publish + load integrity", () => {
	it("publishes canonical objects and is idempotent for identical bytes", () => {
		const root = tempRoot();
		const rec = record({ facts: [{ key: "k", value: "v" }] });
		const first = publishObject(root, rec);
		const second = publishObject(root, { facts: rec.facts, ...rec });
		assert.equal(first, second);
		const onDisk = readFileSync(objectPath(root, first), "utf8");
		assert.equal(onDisk, canonicalJson(rec));
	});

	it("fails closed on a digest collision with different bytes", () => {
		const root = tempRoot();
		const digest = publishObject(root, record());
		writeFileSync(objectPath(root, digest), canonicalJson(record({ id: "other" })));
		assert.throws(
			() => publishObject(root, record()),
			(e: unknown) => e instanceof DeliveryBundleError && e.code === "collision",
		);
	});

	it("fails closed on tamper, missing reachable material, and non-canonical bytes", () => {
		const root = tempRoot();
		const rec = record();
		const digest = publishObject(root, rec);
		const c: DeliveryCase = {
			schemaVersion: 1,
			kind: "Case",
			id: "case-1",
			issuedAt: ISSUED,
			issuer: issuer(),
			subject: subject(),
			admittedRecords: [digest],
			obligations: [{ id: "o1", group: "intent", recordDigests: [digest], attachmentDigests: [] }],
			residuals: [],
		};
		const caseDigest = publishObject(root, c);
		writeRoots(root, { schemaVersion: 1, case: caseDigest });
		loadBundle(root);

		writeFileSync(objectPath(root, digest), `${readFileSync(objectPath(root, digest), "utf8").trim()}\n `);
		assert.throws(() => loadBundle(root), /not canonical|does not rehash/);
	});

	it("loads attachments by digest and rehashes them", () => {
		const root = tempRoot();
		const att = publishAttachment(root, "handoff-bytes\n");
		const rec = record({ role: "authorized-intent", kind: "Decision", attachments: [{ digest: att, role: "handoff" }] });
		const recDigest = publishObject(root, rec);
		const c: DeliveryCase = {
			schemaVersion: 1,
			kind: "Case",
			id: "case-1",
			issuedAt: ISSUED,
			issuer: issuer(),
			subject: subject(),
			admittedRecords: [recDigest],
			obligations: [{ id: "o1", group: "intent", recordDigests: [recDigest], attachmentDigests: [att] }],
			residuals: [],
		};
		const caseDigest = publishObject(root, c);
		writeRoots(root, { schemaVersion: 1, case: caseDigest });
		const loaded = loadBundle(root);
		assert.equal(loaded.attachments.get(att)?.bytes, "handoff-bytes\n");
		assert.deepEqual(loaded.unattachedObjectDigests, []);
	});

	it("reports extra unreachable objects without treating them as roots", () => {
		const root = tempRoot();
		const rec = record();
		const digest = publishObject(root, rec);
		const extra = publishObject(root, record({ id: "extra" }));
		const c: DeliveryCase = {
			schemaVersion: 1,
			kind: "Case",
			id: "case-1",
			issuedAt: ISSUED,
			issuer: issuer(),
			subject: subject(),
			admittedRecords: [digest],
			obligations: [{ id: "o1", group: "intent", recordDigests: [digest], attachmentDigests: [] }],
			residuals: [],
		};
		const caseDigest = publishObject(root, c);
		writeRoots(root, { schemaVersion: 1, case: caseDigest });
		const loaded = loadBundle(root);
		assert.deepEqual(loaded.unattachedObjectDigests, [extra]);
	});

	it("refuses a symlink object path", () => {
		const root = tempRoot();
		const outside = tempRoot();
		writeFileSync(join(outside, "x"), "nope\n");
		mkdirSync(join(root, "objects", "sha256"), { recursive: true });
		symlinkSync(join(outside, "x"), join(root, "objects", "sha256", DIGEST));
		writeRoots(root, { schemaVersion: 1, case: DIGEST });
		assert.throws(() => loadBundle(root), /symlink|missing/);
	});
});
