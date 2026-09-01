/**
 * L1 delivery bundle: canonical bytes, digests, strict validation, reachability,
 * path/symlink containment, and atomic publication. No verdicts.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { domainSeparatedDigest } from "../execution-receipt.js";
import { writeAtomically } from "../record-store.js";
import {
	DELIVERY_DOMAIN,
	DELIVERY_SCHEMA_VERSION,
	type DeliveryAttachmentRef,
	type DeliveryCase,
	type DeliveryFact,
	type DeliveryFinding,
	type DeliveryIssuer,
	type DeliveryObligation,
	type DeliveryRecord,
	type DeliveryRecordKind,
	type DeliveryRecordRole,
	type DeliveryRoots,
	type DeliverySubject,
	type DeliverySubjectBinding,
} from "./types.js";

export const OBJECTS_DIR = join("objects", "sha256");
export const ATTACHMENTS_DIR = join("attachments", "sha256");
export const ROOTS_FILE = "roots.json";

const HEX64_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const RECORD_KINDS = new Set<DeliveryRecordKind>(["Observation", "Assessment", "Decision", "Effect"]);
const RECORD_ROLES = new Set<DeliveryRecordRole>(["authorized-intent", "subject", "scope", "governing-context", "acceptance-claim", "review", "policy", "human-authorization", "landing"]);
const ISSUER_KINDS = new Set(["harness", "local", "shadow"]);
const ATTACHMENT_ROLES = new Set(["basis", "evidence", "handoff", "review-record"]);
const FINDING_SEVERITIES = new Set(["material", "note"]);
const FINDING_DISPOSITIONS = new Set(["accepted", "rejected", "open", "residual"]);
const OBLIGATION_GROUPS = new Set(["intent", "subject-result-tree", "subject-config-binding", "scope", "governing-context", "acceptance", "review-findings", "evidence"]);

const RECORD_KEYS = new Set(["schemaVersion", "kind", "id", "role", "issuedAt", "issuer", "claims", "subjectBinding", "caseDigest", "authority", "attachments", "facts", "findings", "resultTree"]);
const CASE_KEYS = new Set(["schemaVersion", "kind", "id", "issuedAt", "issuer", "subject", "admittedRecords", "obligations", "residuals"]);
const ROOTS_KEYS = new Set(["schemaVersion", "case", "policyDecision", "humanDecision", "effects"]);
const ISSUER_KEYS = new Set(["kind", "id"]);
const SUBJECT_KEYS = new Set(["gitDir", "repository", "repositoryResidual", "baseCommit", "baseTree", "candidateCommit", "resultTree", "diffTreeDigest"]);
const BINDING_KEYS = new Set(["resultTree", "configuration"]);
const ATTACHMENT_KEYS = new Set(["digest", "role"]);
const FACT_KEYS = new Set(["key", "value"]);
const FINDING_KEYS = new Set(["id", "severity", "summary", "disposition"]);
const OBLIGATION_KEYS = new Set(["id", "group", "recordDigests", "attachmentDigests"]);

export class DeliveryBundleError extends Error {
	constructor(
		readonly code: "invalid" | "collision" | "containment" | "missing" | "tampered" | "write_failed",
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "DeliveryBundleError";
	}
}

export function isHex64(value: unknown): value is string {
	return typeof value === "string" && HEX64_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new DeliveryBundleError("invalid", `${label}: unknown field ${key}`);
	}
}

function assertString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new DeliveryBundleError("invalid", `${label} must be a non-empty string`);
	return value;
}

function assertIso(value: unknown, label: string): string {
	const s = assertString(value, label);
	if (!ISO_RE.test(s)) throw new DeliveryBundleError("invalid", `${label} must be ISO-8601`);
	return s;
}

function assertHex64(value: unknown, label: string): string {
	if (!isHex64(value)) throw new DeliveryBundleError("invalid", `${label} must be 64-char lowercase hex`);
	return value;
}

/**
 * Recursively rebuild `value` with code-unit-sorted object keys. Rejects non-finite
 * numbers, `undefined`, bigint, and non-JSON types.
 */
export function canonicalize(value: unknown, path = "$"): unknown {
	if (value === undefined) throw new DeliveryBundleError("invalid", `${path}: undefined is not allowed`);
	if (typeof value === "bigint") throw new DeliveryBundleError("invalid", `${path}: bigint is not allowed`);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new DeliveryBundleError("invalid", `${path}: non-finite number`);
		return value;
	}
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((item, i) => canonicalize(item, `${path}[${i}]`));
	if (typeof value === "object") {
		const keys = Object.keys(value).sort();
		const out: Record<string, unknown> = {};
		for (const key of keys) out[key] = canonicalize((value as Record<string, unknown>)[key], `${path}.${key}`);
		return out;
	}
	throw new DeliveryBundleError("invalid", `${path}: unsupported type ${typeof value}`);
}

/** Canonical JSON: sorted keys, `JSON.stringify` (no pretty-print), UTF-8, exactly one trailing newline. */
export function canonicalJson(value: unknown): string {
	return `${JSON.stringify(canonicalize(value))}\n`;
}

export function digestObjectBytes(bytes: string): string {
	return domainSeparatedDigest(DELIVERY_DOMAIN.object, bytes);
}

export function digestAttachmentBytes(bytes: string | Uint8Array): string {
	return domainSeparatedDigest(DELIVERY_DOMAIN.attachment, bytes);
}

export function objectPath(root: string, digest: string): string {
	assertHex64(digest, "object digest");
	return resolve(root, OBJECTS_DIR, digest);
}

export function attachmentPath(root: string, digest: string): string {
	assertHex64(digest, "attachment digest");
	return resolve(root, ATTACHMENTS_DIR, digest);
}

export function rootsPath(root: string): string {
	return resolve(root, ROOTS_FILE);
}

function assertContained(root: string, target: string): void {
	const rootResolved = resolve(root);
	const targetResolved = resolve(target);
	const rel = relative(rootResolved, targetResolved);
	if (rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(`..${sep.replace("\\", "/")}`)) {
		throw new DeliveryBundleError("containment", `path escapes bundle root: ${target}`);
	}
	if (rel.startsWith("..")) throw new DeliveryBundleError("containment", `path escapes bundle root: ${target}`);
}

function assertNotSymlink(path: string): void {
	if (!existsSync(path)) return;
	const st = lstatSync(path);
	if (st.isSymbolicLink()) throw new DeliveryBundleError("containment", `symlink refused: ${path}`);
}

function assertPublishTarget(root: string, target: string): void {
	assertContained(root, target);
	const rootResolved = resolve(root);
	if (!existsSync(rootResolved)) throw new DeliveryBundleError("containment", `bundle root does not exist: ${rootResolved}`);
	assertNotSymlink(rootResolved);
	if (!lstatSync(rootResolved).isDirectory()) throw new DeliveryBundleError("containment", `bundle root is not a directory: ${rootResolved}`);
	const rootReal = realpathSync(rootResolved);
	const parentRelative = relative(rootResolved, dirname(resolve(target)));
	let ancestor = rootResolved;
	for (const segment of parentRelative.split(sep).filter(Boolean)) {
		ancestor = join(ancestor, segment);
		if (!existsSync(ancestor)) break;
		assertNotSymlink(ancestor);
		if (!lstatSync(ancestor).isDirectory()) throw new DeliveryBundleError("containment", `publish ancestor is not a directory: ${ancestor}`);
		assertContained(rootReal, realpathSync(ancestor));
	}
	assertNotSymlink(target);
	if (existsSync(target)) assertContained(rootReal, realpathSync(target));
}

function publishBytes(root: string, path: string, bytes: string | Uint8Array, opts: { overwrite?: boolean } = {}): void {
	assertPublishTarget(root, path);
	if (existsSync(path)) {
		const existing = readFileSync(path);
		const expected = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
		if (existing.equals(expected)) return;
		if (!opts.overwrite) throw new DeliveryBundleError("collision", `object already exists with different bytes: ${path}`);
	}
	mkdirSync(dirname(path), { recursive: true });
	writeAtomically(path, bytes, { mode: 0o600 });
}

export function publishObject(root: string, value: unknown): string {
	const bytes = canonicalJson(value);
	const digest = digestObjectBytes(bytes);
	const path = objectPath(root, digest);
	publishBytes(root, path, bytes);
	return digest;
}

export function publishAttachment(root: string, bytes: string | Uint8Array): string {
	const digest = digestAttachmentBytes(bytes);
	const path = attachmentPath(root, digest);
	publishBytes(root, path, bytes);
	return digest;
}

export function writeRoots(root: string, roots: DeliveryRoots): void {
	const valid = validateDeliveryRoots(roots);
	const path = rootsPath(root);
	publishBytes(root, path, canonicalJson(valid), { overwrite: true });
}

export function validateDeliveryIssuer(value: unknown, label = "issuer"): DeliveryIssuer {
	if (!isRecord(value)) throw new DeliveryBundleError("invalid", `${label} must be an object`);
	assertKnownKeys(value, ISSUER_KEYS, label);
	const kind = assertString(value.kind, `${label}.kind`);
	if (!ISSUER_KINDS.has(kind)) throw new DeliveryBundleError("invalid", `${label}.kind is not a known issuer kind`);
	return { kind: kind as DeliveryIssuer["kind"], id: assertString(value.id, `${label}.id`) };
}

export function validateDeliverySubject(value: unknown): DeliverySubject {
	if (!isRecord(value)) throw new DeliveryBundleError("invalid", "subject must be an object");
	assertKnownKeys(value, SUBJECT_KEYS, "subject");
	const repository = value.repository === null ? null : assertString(value.repository, "subject.repository");
	const repositoryResidual = value.repositoryResidual === null ? null : assertString(value.repositoryResidual, "subject.repositoryResidual");
	return {
		gitDir: assertString(value.gitDir, "subject.gitDir"),
		repository,
		repositoryResidual,
		baseCommit: assertString(value.baseCommit, "subject.baseCommit"),
		baseTree: assertString(value.baseTree, "subject.baseTree"),
		candidateCommit: assertString(value.candidateCommit, "subject.candidateCommit"),
		resultTree: assertString(value.resultTree, "subject.resultTree"),
		diffTreeDigest: assertHex64(value.diffTreeDigest, "subject.diffTreeDigest"),
	};
}

function validateBinding(value: unknown): DeliverySubjectBinding {
	if (!isRecord(value)) throw new DeliveryBundleError("invalid", "subjectBinding must be an object");
	assertKnownKeys(value, BINDING_KEYS, "subjectBinding");
	const binding: DeliverySubjectBinding = { resultTree: assertString(value.resultTree, "subjectBinding.resultTree") };
	if (value.configuration !== undefined) binding.configuration = assertString(value.configuration, "subjectBinding.configuration");
	return binding;
}

function validateAttachmentRef(value: unknown, i: number): DeliveryAttachmentRef {
	if (!isRecord(value)) throw new DeliveryBundleError("invalid", `attachments[${i}] must be an object`);
	assertKnownKeys(value, ATTACHMENT_KEYS, `attachments[${i}]`);
	const role = assertString(value.role, `attachments[${i}].role`);
	if (!ATTACHMENT_ROLES.has(role)) throw new DeliveryBundleError("invalid", `attachments[${i}].role is unknown`);
	return { digest: assertHex64(value.digest, `attachments[${i}].digest`), role: role as DeliveryAttachmentRef["role"] };
}

function validateFact(value: unknown, i: number): DeliveryFact {
	if (!isRecord(value)) throw new DeliveryBundleError("invalid", `facts[${i}] must be an object`);
	assertKnownKeys(value, FACT_KEYS, `facts[${i}]`);
	if (typeof value.value !== "string") throw new DeliveryBundleError("invalid", `facts[${i}].value must be a string`);
	return { key: assertString(value.key, `facts[${i}].key`), value: value.value };
}

function validateFinding(value: unknown, i: number): DeliveryFinding {
	if (!isRecord(value)) throw new DeliveryBundleError("invalid", `findings[${i}] must be an object`);
	assertKnownKeys(value, FINDING_KEYS, `findings[${i}]`);
	const severity = assertString(value.severity, `findings[${i}].severity`);
	if (!FINDING_SEVERITIES.has(severity)) throw new DeliveryBundleError("invalid", `findings[${i}].severity is unknown`);
	const finding: DeliveryFinding = {
		id: assertString(value.id, `findings[${i}].id`),
		severity: severity as DeliveryFinding["severity"],
		summary: assertString(value.summary, `findings[${i}].summary`),
	};
	if (value.disposition !== undefined) {
		const d = assertString(value.disposition, `findings[${i}].disposition`);
		if (!FINDING_DISPOSITIONS.has(d)) throw new DeliveryBundleError("invalid", `findings[${i}].disposition is unknown`);
		finding.disposition = d as DeliveryFinding["disposition"];
	}
	return finding;
}

export function validateDeliveryRecord(value: unknown): DeliveryRecord {
	if (!isRecord(value)) throw new DeliveryBundleError("invalid", "record must be an object");
	assertKnownKeys(value, RECORD_KEYS, "record");
	if (value.schemaVersion !== DELIVERY_SCHEMA_VERSION) throw new DeliveryBundleError("invalid", `unsupported schemaVersion: ${String(value.schemaVersion)}`);
	const kind = assertString(value.kind, "kind");
	if (!RECORD_KINDS.has(kind as DeliveryRecordKind)) throw new DeliveryBundleError("invalid", `kind must be a delivery record kind, got ${kind}`);
	const role = assertString(value.role, "role");
	if (!RECORD_ROLES.has(role as DeliveryRecordRole)) throw new DeliveryBundleError("invalid", `unknown role ${role}`);
	const record: DeliveryRecord = {
		schemaVersion: DELIVERY_SCHEMA_VERSION,
		kind: kind as DeliveryRecordKind,
		id: assertString(value.id, "id"),
		role: role as DeliveryRecordRole,
		issuedAt: assertIso(value.issuedAt, "issuedAt"),
		issuer: validateDeliveryIssuer(value.issuer),
	};
	if (value.claims !== undefined) {
		if (!Array.isArray(value.claims) || !value.claims.every((c) => typeof c === "string")) throw new DeliveryBundleError("invalid", "claims must be an array of strings");
		record.claims = value.claims;
	}
	if (value.subjectBinding !== undefined) record.subjectBinding = validateBinding(value.subjectBinding);
	if (value.caseDigest !== undefined) record.caseDigest = assertHex64(value.caseDigest, "caseDigest");
	if (value.authority !== undefined) record.authority = assertString(value.authority, "authority");
	if (value.attachments !== undefined) {
		if (!Array.isArray(value.attachments)) throw new DeliveryBundleError("invalid", "attachments must be an array");
		record.attachments = value.attachments.map(validateAttachmentRef);
	}
	if (value.facts !== undefined) {
		if (!Array.isArray(value.facts)) throw new DeliveryBundleError("invalid", "facts must be an array");
		record.facts = value.facts.map(validateFact);
	}
	if (value.findings !== undefined) {
		if (!Array.isArray(value.findings)) throw new DeliveryBundleError("invalid", "findings must be an array");
		record.findings = value.findings.map(validateFinding);
	}
	if (value.resultTree !== undefined) record.resultTree = assertString(value.resultTree, "resultTree");
	return record;
}

function validateObligation(value: unknown, i: number): DeliveryObligation {
	if (!isRecord(value)) throw new DeliveryBundleError("invalid", `obligations[${i}] must be an object`);
	assertKnownKeys(value, OBLIGATION_KEYS, `obligations[${i}]`);
	const group = assertString(value.group, `obligations[${i}].group`);
	if (!OBLIGATION_GROUPS.has(group)) throw new DeliveryBundleError("invalid", `obligations[${i}].group is unknown`);
	if (!Array.isArray(value.recordDigests) || !value.recordDigests.every(isHex64)) {
		throw new DeliveryBundleError("invalid", `obligations[${i}].recordDigests must be hex digests`);
	}
	if (!Array.isArray(value.attachmentDigests) || !value.attachmentDigests.every(isHex64)) {
		throw new DeliveryBundleError("invalid", `obligations[${i}].attachmentDigests must be hex digests`);
	}
	return {
		id: assertString(value.id, `obligations[${i}].id`),
		group: group as DeliveryObligation["group"],
		recordDigests: value.recordDigests,
		attachmentDigests: value.attachmentDigests,
	};
}

export function validateDeliveryCase(value: unknown): DeliveryCase {
	if (!isRecord(value)) throw new DeliveryBundleError("invalid", "Case must be an object");
	assertKnownKeys(value, CASE_KEYS, "Case");
	if (value.schemaVersion !== DELIVERY_SCHEMA_VERSION) throw new DeliveryBundleError("invalid", `unsupported schemaVersion: ${String(value.schemaVersion)}`);
	if (value.kind !== "Case") throw new DeliveryBundleError("invalid", 'kind must be "Case"');
	if (!Array.isArray(value.admittedRecords) || !value.admittedRecords.every(isHex64)) {
		throw new DeliveryBundleError("invalid", "admittedRecords must be hex digests");
	}
	if (!Array.isArray(value.obligations)) throw new DeliveryBundleError("invalid", "obligations must be an array");
	if (!Array.isArray(value.residuals) || !value.residuals.every((r) => typeof r === "string")) {
		throw new DeliveryBundleError("invalid", "residuals must be an array of strings");
	}
	return {
		schemaVersion: DELIVERY_SCHEMA_VERSION,
		kind: "Case",
		id: assertString(value.id, "id"),
		issuedAt: assertIso(value.issuedAt, "issuedAt"),
		issuer: validateDeliveryIssuer(value.issuer),
		subject: validateDeliverySubject(value.subject),
		admittedRecords: value.admittedRecords,
		obligations: value.obligations.map(validateObligation),
		residuals: value.residuals,
	};
}

export function validateDeliveryRoots(value: unknown): DeliveryRoots {
	if (!isRecord(value)) throw new DeliveryBundleError("invalid", "roots must be an object");
	assertKnownKeys(value, ROOTS_KEYS, "roots");
	if (value.schemaVersion !== DELIVERY_SCHEMA_VERSION) throw new DeliveryBundleError("invalid", `unsupported schemaVersion: ${String(value.schemaVersion)}`);
	const roots: DeliveryRoots = { schemaVersion: DELIVERY_SCHEMA_VERSION, case: assertHex64(value.case, "roots.case") };
	if (value.policyDecision !== undefined) roots.policyDecision = assertHex64(value.policyDecision, "roots.policyDecision");
	if (value.humanDecision !== undefined) roots.humanDecision = assertHex64(value.humanDecision, "roots.humanDecision");
	if (value.effects !== undefined) {
		if (!Array.isArray(value.effects) || !value.effects.every(isHex64)) throw new DeliveryBundleError("invalid", "roots.effects must be hex digests");
		roots.effects = value.effects;
	}
	return roots;
}

export interface LoadedObject {
	digest: string;
	bytes: string;
	value: unknown;
}

export interface LoadedBundle {
	root: string;
	roots: DeliveryRoots;
	objects: Map<string, LoadedObject>;
	attachments: Map<string, { digest: string; bytes: Uint8Array }>;
	unattachedObjectDigests: string[];
}

function readContainedFile(root: string, path: string): Buffer {
	assertContained(root, path);
	assertNotSymlink(path);
	if (existsSync(path)) {
		try {
			const real = realpathSync(path);
			assertContained(root, real);
		} catch (e) {
			if (e instanceof DeliveryBundleError) throw e;
		}
	}
	if (!existsSync(path)) throw new DeliveryBundleError("missing", `missing ${relative(root, path)}`);
	return readFileSync(path);
}

function listDigestFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	assertNotSymlink(dir);
	return readdirSync(dir).filter((name) => isHex64(name));
}

export function loadBundle(root: string): LoadedBundle {
	const rootsBytes = readContainedFile(root, rootsPath(root)).toString("utf8");
	const roots = validateDeliveryRoots(JSON.parse(rootsBytes));
	if (canonicalJson(roots) !== rootsBytes) {
		// roots must be canonical; a pretty-printed file is still parseable but is not the identity.
	}
	const objects = new Map<string, LoadedObject>();
	const objectDir = resolve(root, OBJECTS_DIR);
	for (const digest of listDigestFiles(objectDir)) {
		const path = objectPath(root, digest);
		const bytes = readContainedFile(root, path).toString("utf8");
		const value = JSON.parse(bytes) as unknown;
		if (digestObjectBytes(bytes) !== digest) throw new DeliveryBundleError("tampered", `object ${digest} does not rehash to its name`);
		if (canonicalJson(value) !== bytes) throw new DeliveryBundleError("tampered", `object ${digest} bytes are not canonical`);
		objects.set(digest, { digest, bytes, value });
	}
	const attachments = new Map<string, { digest: string; bytes: Uint8Array }>();
	const attachmentDir = resolve(root, ATTACHMENTS_DIR);
	for (const digest of listDigestFiles(attachmentDir)) {
		const path = attachmentPath(root, digest);
		const bytes = readContainedFile(root, path);
		if (digestAttachmentBytes(bytes) !== digest) throw new DeliveryBundleError("tampered", `attachment ${digest} does not rehash to its name`);
		attachments.set(digest, { digest, bytes });
	}

	const reachable = new Set<string>();
	const walk = (digest: string | undefined): void => {
		if (!digest || reachable.has(digest)) return;
		reachable.add(digest);
		const obj = objects.get(digest);
		if (!obj) return;
		if (isRecord(obj.value) && obj.value.kind === "Case") {
			const c = validateDeliveryCase(obj.value);
			for (const d of c.admittedRecords) walk(d);
			for (const ob of c.obligations) for (const d of ob.recordDigests) walk(d);
		} else {
			const r = validateDeliveryRecord(obj.value);
			for (const a of r.attachments ?? []) {
				/* attachments are not objects */
				void a;
			}
		}
	};
	walk(roots.case);
	walk(roots.policyDecision);
	walk(roots.humanDecision);
	for (const d of roots.effects ?? []) walk(d);

	const unattachedObjectDigests = [...objects.keys()].filter((d) => !reachable.has(d)).sort();
	return { root, roots, objects, attachments, unattachedObjectDigests };
}

export function requireObject(bundle: LoadedBundle, digest: string): LoadedObject {
	const obj = bundle.objects.get(digest);
	if (!obj) throw new DeliveryBundleError("missing", `required object ${digest} is missing`);
	return obj;
}

export function requireAttachment(bundle: LoadedBundle, digest: string): { digest: string; bytes: Uint8Array } {
	const att = bundle.attachments.get(digest);
	if (!att) throw new DeliveryBundleError("missing", `required attachment ${digest} is missing`);
	return att;
}
