/**
 * Cross-push finding-disposition carry (#495).
 *
 * Persists per-run finding dispositions (survived + refuted fingerprints, bound to
 * `(prNumber, headSha)`) so the next gate run on the same PR seeds from the prior SHA's
 * dispositions plus the interdiff instead of re-discovering the world. Every decision here is
 * deterministic harness logic over git trees and strictly validated records (ADR-0014): the
 * carry trigger, the path-level untouched predicate, prior selection by git ancestry, and the
 * auto-refutation eligibility all degrade to today's cold behavior on ANY failure — never to a
 * weaker gate.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PrReviewAgreement } from "../pr-review-cli.js";
import { normalizeGitPath } from "./adjudication.js";
import { materializeAuthoringFinding, type ReviewFinding, type ReviewFindingClass, type ReviewFindingSeverity, reviewFindingFingerprint } from "./findings.js";
import { type FindingTier, isWellFormedClassId, type TaxonomyConfig, tierOf } from "./taxonomy.js";

/** Store directory name under `MAIN_REPO/.dev/`. Exported so the step-runner's Bash register
 *  denial (#510) names the exact same path as the store — the deny list must not drift. */
export const PR_FINDING_DISPOSITIONS_DIR = "pr-review-finding-dispositions";
export const FINDING_DISPOSITION_MAX_BYTES = 1024 * 1024;
export const FINDING_DISPOSITION_MAX_ENTRIES = 128;
export const FINDING_DISPOSITION_MAX_PATH = 512;

const SHA40_RE = /^[0-9a-f]{40}$/i;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const RECORD_RE = /^(\d+)-([0-9a-f]{40})\.json$/;
const CANDIDATE_ID_RE = /^C[1-9]\d*$/;
const TIERS: readonly FindingTier[] = ["safety", "judgment"];
const PROVENANCES = ["verified", "carried"] as const;
const AGREEMENTS: readonly PrReviewAgreement[] = ["consensus-pass", "consensus-block", "disagreement", "invalid"];

const DRAFT_KEYS = ["prNumber", "itemId", "headSha", "gate", "agreement", "ok", "survived", "refuted"] as const;
const RECORD_KEYS = [...DRAFT_KEYS, "schemaVersion", "fleetRecordDigest", "reviewedAt"] as const;
const SURVIVOR_KEYS = ["finding", "fingerprint", "class", "tier", "verification"] as const;
const REFUTED_KEYS = ["finding", "fingerprint", "class", "tier", "refutation"] as const;
const FINDING_KEYS = ["severity", "message", "path", "line"] as const;
const VERIFICATION_KEYS = ["id", "rationale"] as const;
const REFUTATION_KEYS = ["provenance", "id", "refutedAtSha"] as const;

export interface PrCarryFindingEntry {
	finding: ReviewFinding;
	fingerprint: string;
	class: ReviewFindingClass;
	tier: FindingTier;
}

export interface PrCarrySurvivorEntry extends PrCarryFindingEntry {
	/** Last survives-evidence when this run verified it; null when retained because the
	 *  required pass was incomplete (retention-without-verification is toward blocking). */
	verification: { id: string; rationale: string } | null;
}

export interface PrCarryRefutedEntry extends PrCarryFindingEntry {
	refutation: {
		/** "verified": a complete valid verification report in the recording run refuted it.
		 *  "carried": auto-refuted via untouched-path carry; chains back to a verified origin. */
		provenance: "verified" | "carried";
		/** Candidate id (C<n>) in the originating verification report. */
		id: string;
		/** 40-hex head of the run whose valid verification refuted it. */
		refutedAtSha: string;
	};
}

export interface PrFindingDispositionRecordV1 {
	schemaVersion: 1;
	prNumber: number;
	itemId: string;
	/** 40-hex, lowercased — the reviewed head this run bound to. */
	headSha: string;
	gate: "pass" | "block";
	agreement: PrReviewAgreement;
	ok: boolean;
	/** sha256 of the exact on-disk fleet gate record for (prNumber, headSha) — the same
	 *  binding discipline as the adjudication sidecar's fleetRecordDigest. */
	fleetRecordDigest: string;
	/** ISO; diagnostic only — NEVER a selection/ordering signal (#510). */
	reviewedAt: string;
	survived: PrCarrySurvivorEntry[];
	refuted: PrCarryRefutedEntry[];
}

/** What the gate emits: the record minus the writer-supplied binding fields. */
export type PrCarryDispositionDraft = Omit<PrFindingDispositionRecordV1, "schemaVersion" | "fleetRecordDigest" | "reviewedAt">;

export function prFindingDispositionsDir(mainRepo: string): string {
	return resolve(mainRepo, ".dev", PR_FINDING_DISPOSITIONS_DIR);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(field: string): never {
	throw new Error(`pr finding-disposition record: invalid ${field}`);
}

function requireClosedKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) fail(field);
	}
}

function requirePositiveInt(value: unknown, field: string): number {
	if (!Number.isInteger(value) || (value as number) <= 0) fail(field);
	return value as number;
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) fail(field);
	return value;
}

function requireSha40(value: unknown, field: string): string {
	if (typeof value !== "string" || !SHA40_RE.test(value)) fail(field);
	return value.toLowerCase();
}

function requireSingleLine(value: unknown, field: string): string {
	const text = requireNonEmptyString(value, field);
	if (text.trim().length === 0 || /[\r\n]/.test(text)) fail(field);
	return text;
}

function requireCandidateId(value: unknown, field: string): string {
	const id = requireNonEmptyString(value, field);
	if (!CANDIDATE_ID_RE.test(id)) fail(field);
	return id;
}

function validateFinding(value: unknown): ReviewFinding {
	if (!isRecord(value)) fail("finding");
	requireClosedKeys(value, FINDING_KEYS, "finding");
	// Only must-fix findings ever enter the carried/refuted sets — anything else is forged.
	if (value.severity !== ("must-fix" satisfies ReviewFindingSeverity)) fail("finding.severity");
	const message = requireSingleLine(value.message, "finding.message");
	const finding: ReviewFinding = { severity: "must-fix", message };
	if (value.path !== undefined) {
		const path = requireNonEmptyString(value.path, "finding.path");
		if (path.length > FINDING_DISPOSITION_MAX_PATH || /[\r\n]/.test(path) || normalizeGitPath(path) === null) fail("finding.path");
		finding.path = path;
	}
	if (value.line !== undefined) {
		if (finding.path === undefined) fail("finding.line");
		finding.line = requirePositiveInt(value.line, "finding.line");
	}
	return finding;
}

function validateEntryBase(value: Record<string, unknown>, seen: Set<string>): PrCarryFindingEntry {
	const finding = validateFinding(value.finding);
	const fingerprint = requireNonEmptyString(value.fingerprint, "fingerprint");
	// Shared `seen` across both arrays: one fingerprint is either surviving or refuted, never both.
	if (fingerprint !== reviewFindingFingerprint(finding) || seen.has(fingerprint)) fail("fingerprint");
	seen.add(fingerprint);
	const classId = requireNonEmptyString(value.class, "class");
	if (!isWellFormedClassId(classId)) fail("class");
	if (!TIERS.includes(value.tier as FindingTier)) fail("tier");
	return { finding, fingerprint, class: classId, tier: value.tier as FindingTier };
}

function validateSurvivor(value: unknown, seen: Set<string>): PrCarrySurvivorEntry {
	if (!isRecord(value)) fail("survived");
	requireClosedKeys(value, SURVIVOR_KEYS, "survived");
	const base = validateEntryBase(value, seen);
	if (value.verification === null) return { ...base, verification: null };
	if (!isRecord(value.verification)) fail("survived.verification");
	requireClosedKeys(value.verification, VERIFICATION_KEYS, "survived.verification");
	return {
		...base,
		verification: {
			id: requireCandidateId(value.verification.id, "survived.verification.id"),
			rationale: requireSingleLine(value.verification.rationale, "survived.verification.rationale"),
		},
	};
}

function validateRefuted(value: unknown, seen: Set<string>): PrCarryRefutedEntry {
	if (!isRecord(value)) fail("refuted");
	requireClosedKeys(value, REFUTED_KEYS, "refuted");
	const base = validateEntryBase(value, seen);
	if (!isRecord(value.refutation)) fail("refuted.refutation");
	requireClosedKeys(value.refutation, REFUTATION_KEYS, "refuted.refutation");
	if (!PROVENANCES.includes(value.refutation.provenance as (typeof PROVENANCES)[number])) fail("refuted.refutation.provenance");
	return {
		...base,
		refutation: {
			provenance: value.refutation.provenance as "verified" | "carried",
			id: requireCandidateId(value.refutation.id, "refuted.refutation.id"),
			refutedAtSha: requireSha40(value.refutation.refutedAtSha, "refuted.refutation.refutedAtSha"),
		},
	};
}

function validateDraftFields(value: Record<string, unknown>): PrCarryDispositionDraft {
	const prNumber = requirePositiveInt(value.prNumber, "prNumber");
	const itemId = requireNonEmptyString(value.itemId, "itemId");
	const headSha = requireSha40(value.headSha, "headSha");
	if (value.gate !== "pass" && value.gate !== "block") fail("gate");
	if (!AGREEMENTS.includes(value.agreement as PrReviewAgreement)) fail("agreement");
	if (typeof value.ok !== "boolean") fail("ok");
	if (!Array.isArray(value.survived)) fail("survived");
	if (!Array.isArray(value.refuted)) fail("refuted");
	if (value.survived.length > FINDING_DISPOSITION_MAX_ENTRIES) fail("survived");
	if (value.refuted.length > FINDING_DISPOSITION_MAX_ENTRIES) fail("refuted");
	const seen = new Set<string>();
	const survived = value.survived.map((entry) => validateSurvivor(entry, seen));
	const refuted = value.refuted.map((entry) => validateRefuted(entry, seen));
	return { prNumber, itemId, headSha, gate: value.gate, agreement: value.agreement as PrReviewAgreement, ok: value.ok, survived, refuted };
}

export function validatePrFindingDispositionRecord(value: unknown): PrFindingDispositionRecordV1 {
	if (!isRecord(value)) fail("record");
	requireClosedKeys(value, RECORD_KEYS, "record");
	if (value.schemaVersion !== 1) fail("schemaVersion");
	const draft = validateDraftFields(value);
	if (typeof value.fleetRecordDigest !== "string" || !DIGEST_RE.test(value.fleetRecordDigest)) fail("fleetRecordDigest");
	if (typeof value.reviewedAt !== "string" || value.reviewedAt.length === 0 || !Number.isFinite(Date.parse(value.reviewedAt))) fail("reviewedAt");
	return { schemaVersion: 1, ...draft, fleetRecordDigest: value.fleetRecordDigest, reviewedAt: value.reviewedAt };
}

function recordPath(root: string, prNumber: number, headSha: string): string {
	return resolve(root, `${prNumber}-${headSha.toLowerCase()}.json`);
}

export function writePrFindingDispositionRecord(root: string, record: PrFindingDispositionRecordV1 | (PrCarryDispositionDraft & { fleetRecordDigest: string; reviewedAt: string })): string {
	const complete = validatePrFindingDispositionRecord({ ...record, schemaVersion: 1 });
	const serialized = `${JSON.stringify(complete, null, 2)}\n`;
	if (Buffer.byteLength(serialized, "utf8") > FINDING_DISPOSITION_MAX_BYTES) fail("size");
	mkdirSync(root, { recursive: true });
	const path = recordPath(root, complete.prNumber, complete.headSha);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, serialized, { mode: 0o600 });
	renameSync(tmp, path);
	return path;
}

function readRecord(path: string): PrFindingDispositionRecordV1 | null {
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > FINDING_DISPOSITION_MAX_BYTES) return null;
		const raw = readFileSync(path);
		if (raw.byteLength > FINDING_DISPOSITION_MAX_BYTES) return null;
		return validatePrFindingDispositionRecord(JSON.parse(raw.toString("utf8")));
	} catch {
		return null;
	}
}

export function readPrFindingDispositionRecord(root: string, prNumber: number, headSha: string): PrFindingDispositionRecordV1 | null {
	if (!Number.isInteger(prNumber) || prNumber <= 0 || !SHA40_RE.test(headSha)) return null;
	const record = readRecord(recordPath(root, prNumber, headSha));
	if (!record || record.prNumber !== prNumber || record.headSha !== headSha.toLowerCase()) return null;
	return record;
}

export interface PrFindingDispositionListing {
	records: PrFindingDispositionRecordV1[];
	/** Record-named files that failed strict read-validation — surfaced so the caller can
	 *  refuse carry with a diagnostic instead of silently skipping a malformed prior (I1). */
	invalid: string[];
}

export function listPrFindingDispositionRecords(root: string): PrFindingDispositionListing {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return { records: [], invalid: [] };
	}
	const records: PrFindingDispositionRecordV1[] = [];
	const invalid: string[] = [];
	for (const name of names.sort()) {
		const match = name.match(RECORD_RE);
		if (!match) continue;
		const [, prNumber, headSha] = match;
		if (!prNumber || !headSha) continue;
		const record = readRecord(resolve(root, name));
		if (!record || record.prNumber !== Number.parseInt(prNumber, 10) || record.headSha !== headSha.toLowerCase()) {
			invalid.push(name);
			continue;
		}
		records.push(record);
	}
	return { records, invalid };
}

export type CarrySourceSelection = { kind: "none" } | { kind: "selected"; record: PrFindingDispositionRecordV1 } | { kind: "refused"; reason: string };

/**
 * Fail-closed prior-record selection (D2). At most one prior may seed a run: candidates are
 * filtered by identity, proven ancestors of the reviewed head via the injected git predicate
 * (ground truth — nothing inside the records, notably `reviewedAt`, participates in ordering:
 * #510), and reduced to the unique maximal record along the branch. Any malformed store file for
 * the targeted PR, a non-totally-ordered candidate set, or a failed digest bind to the exact
 * on-disk fleet gate record refuses with a diagnostic — the caller runs cold.
 */
export function selectCarrySource(
	listing: Pick<PrFindingDispositionListing, "records" | "invalid">,
	opts: {
		prNumber: number;
		itemId: string;
		/** 40-hex reviewed head of the run about to start. */
		reviewedSha: string;
		isAncestor: (ancestor: string, descendant: string) => boolean;
		readFleetBytes: (prNumber: number, headSha: string) => Buffer | null;
	},
): CarrySourceSelection {
	if (!SHA40_RE.test(opts.reviewedSha)) return { kind: "none" };
	const reviewedSha = opts.reviewedSha.toLowerCase();
	const invalidForPr = listing.invalid.filter((name) => name.startsWith(`${opts.prNumber}-`));
	if (invalidForPr.length > 0) {
		return { kind: "refused", reason: `disposition store holds malformed record(s) for PR ${opts.prNumber}: ${invalidForPr.sort().join(", ")}` };
	}
	// Same-SHA reruns are deliberately excluded — a re-review of the same head behaves as today.
	const candidates = listing.records.filter((record) => record.prNumber === opts.prNumber && record.itemId === opts.itemId && record.headSha !== reviewedSha);
	if (candidates.length === 0) return { kind: "none" };
	const ancestors = candidates.filter((record) => opts.isAncestor(record.headSha, reviewedSha));
	if (ancestors.length === 0) {
		return { kind: "refused", reason: `no prior disposition record for PR ${opts.prNumber} is an ancestor of ${reviewedSha.slice(0, 7)} (force-push or rebase)` };
	}
	// The maximal candidate: every other ancestor candidate must precede it along the branch.
	const maximal = ancestors.find((record) => ancestors.every((other) => other === record || opts.isAncestor(other.headSha, record.headSha)));
	if (!maximal) {
		const files = ancestors.map((record) => `${record.prNumber}-${record.headSha}.json`).sort();
		return { kind: "refused", reason: `prior disposition records for PR ${opts.prNumber} are not totally ordered along the branch: ${files.join(", ")}` };
	}
	const fleetBytes = opts.readFleetBytes(maximal.prNumber, maximal.headSha);
	if (!fleetBytes) {
		return { kind: "refused", reason: `fleet gate record for prior ${maximal.prNumber}-${maximal.headSha}.json is missing` };
	}
	if (createHash("sha256").update(fleetBytes).digest("hex") !== maximal.fleetRecordDigest) {
		return { kind: "refused", reason: `disposition record ${maximal.prNumber}-${maximal.headSha}.json is not bound to the exact on-disk fleet gate record` };
	}
	return { kind: "selected", record: maximal };
}

/** Parse `git diff --no-renames --name-only -z` output into normalized touched paths. With
 *  `--no-renames` a rename is a delete + create, so BOTH sides land in the set (D3). */
export function computeTouchedPaths(nameOnlyZOutput: string): Set<string> {
	const touched = new Set<string>();
	for (const raw of nameOnlyZOutput.split("\0")) {
		const path = normalizeGitPath(raw);
		if (path !== null) touched.add(path);
	}
	return touched;
}

export interface CarryPlan {
	priorSha: string;
	/** Prior survivors, fingerprint-keyed. Seeding is toward blocking, so no eligibility test
	 *  applies (I2); safety survivors seed like any other. */
	seedSurvivors: Map<string, ReviewFinding>;
	/** Refuted entries eligible for deterministic auto-refutation this hop (D3 + I3 applied). */
	autoRefutable: Map<string, PrCarryRefutedEntry>;
	/** Refutation memory to carry into the new record (rule 3) — identical entries to
	 *  `autoRefutable`; the draft builder dedupes against this run's own dispositions. */
	carriedForward: PrCarryRefutedEntry[];
}

/**
 * Apply auto-refutation eligibility BEFORE the gate ever sees an entry (D4). Eligible :=
 * anchoring path present ∧ path untouched by the two-dot interdiff ∧ non-safety under BOTH the
 * recorded tier AND the current taxonomy's resolution of the recorded class (I3 belt-and-braces —
 * a taxonomy edit between pushes cannot demote a safety finding into auto-refutable). Ineligible
 * refuted entries drop: their refutation could never auto-apply again, and a later re-discovery
 * is verified fresh — the safe direction.
 */
export function planCarry(record: PrFindingDispositionRecordV1, touchedPaths: ReadonlySet<string>, taxonomy: TaxonomyConfig): CarryPlan {
	const seedSurvivors = new Map<string, ReviewFinding>();
	for (const entry of record.survived) seedSurvivors.set(entry.fingerprint, entry.finding);
	const autoRefutable = new Map<string, PrCarryRefutedEntry>();
	for (const entry of record.refuted) {
		// The validator forbids duplicate fingerprints across arrays; a violation here means a
		// non-validated record leaked in, so refuse loudly rather than seed and refute one finding.
		if (seedSurvivors.has(entry.fingerprint)) throw new Error(`carry plan: fingerprint in both survived and refuted: ${entry.fingerprint}`);
		const path = normalizeGitPath(entry.finding.path);
		if (path === null || touchedPaths.has(path)) continue;
		if (entry.tier === "safety" || tierOf(entry.class, taxonomy) === "safety") continue;
		autoRefutable.set(entry.fingerprint, {
			finding: entry.finding,
			fingerprint: entry.fingerprint,
			class: entry.class,
			tier: entry.tier,
			refutation: { provenance: "carried", id: entry.refutation.id, refutedAtSha: entry.refutation.refutedAtSha },
		});
	}
	return { priorSha: record.headSha, seedSurvivors, autoRefutable, carriedForward: [...autoRefutable.values()] };
}

function bareFinding(finding: ReviewFinding): ReviewFinding {
	return {
		severity: finding.severity,
		message: finding.message,
		...(finding.path !== undefined ? { path: finding.path } : {}),
		...(finding.line !== undefined ? { line: finding.line } : {}),
	};
}

/**
 * Pure terminal emission (D1 content rules). `refuted` =
 *   1. fingerprints explicitly refuted this run by a valid pass and not terminally carried
 *      (`provenance: "verified"`, `refutedAtSha` = this run's head) — any tier;
 *   2./3. every carry-eligible prior refuted entry (`provenance: "carried"`, origin preserved) —
 *      whether auto-refuted this run or simply not re-encountered, the recorded entry is the
 *      same chained memory.
 * `survived` = the terminal carried map, enriched with emission-time class/tier and the latest
 * survives-evidence when present. Returns undefined (no record) on any identity/validation
 * failure — the caller warns; absence of a record only ever means a future cold run.
 */
export function buildCarryDispositionDraft(opts: {
	prNumber: number;
	itemId: string;
	reviewedSha: string;
	gate: "pass" | "block";
	agreement: PrReviewAgreement;
	ok: boolean;
	/** Terminal carried survivors, fingerprint-keyed. */
	survivors: ReadonlyMap<string, ReviewFinding>;
	/** Latest-per-fingerprint disposition evidence from the run's passes. */
	verifications: ReadonlyMap<string, { id: string; decision: "survives" | "refuted"; rationale: string }>;
	/** Harness-side mirror of applyReviewPass's delete branch: fingerprints a VALID summary refuted. */
	refutedThisRun: ReadonlyMap<string, { id: string; finding: ReviewFinding }>;
	autoRefutable: ReadonlyMap<string, PrCarryRefutedEntry>;
	carriedForward: readonly PrCarryRefutedEntry[];
	changedFiles: readonly string[];
	taxonomy: TaxonomyConfig;
}): PrCarryDispositionDraft | undefined {
	if (!Number.isInteger(opts.prNumber) || opts.prNumber <= 0) return undefined;
	if (typeof opts.itemId !== "string" || opts.itemId.trim() === "") return undefined;
	if (!SHA40_RE.test(opts.reviewedSha)) return undefined;
	const headSha = opts.reviewedSha.toLowerCase();
	const survived: PrCarrySurvivorEntry[] = [];
	for (const [fingerprint, finding] of opts.survivors) {
		const materialized = materializeAuthoringFinding(finding, { changedFiles: opts.changedFiles }, opts.taxonomy);
		const evidence = opts.verifications.get(fingerprint);
		survived.push({
			finding: bareFinding(finding),
			fingerprint,
			class: materialized.class,
			tier: tierOf(materialized.class, opts.taxonomy),
			verification: evidence?.decision === "survives" ? { id: evidence.id, rationale: evidence.rationale } : null,
		});
	}
	const refuted = new Map<string, PrCarryRefutedEntry>();
	for (const [fingerprint, { id, finding }] of opts.refutedThisRun) {
		// A later valid pass (or the fail-closed invalid-summary re-add) put it back in carried —
		// it is a survivor, never refutation memory.
		if (opts.survivors.has(fingerprint)) continue;
		const chained = opts.autoRefutable.get(fingerprint);
		if (chained) {
			// Auto-refuted this run: the refuting authority is the prior recorded report, so the
			// entry keeps `provenance: "carried"` with the origin id + SHA (rule 2).
			refuted.set(fingerprint, chained);
			continue;
		}
		const materialized = materializeAuthoringFinding(finding, { changedFiles: opts.changedFiles }, opts.taxonomy);
		refuted.set(fingerprint, {
			finding: bareFinding(finding),
			fingerprint,
			class: materialized.class,
			tier: tierOf(materialized.class, opts.taxonomy),
			refutation: { provenance: "verified", id, refutedAtSha: headSha },
		});
	}
	// Rule 3: eligible prior refutation memory not re-encountered this run survives
	// reviewer-sampling gaps. Entries already disposed this run (or terminally carried) win.
	for (const entry of opts.carriedForward) {
		if (refuted.has(entry.fingerprint) || opts.survivors.has(entry.fingerprint)) continue;
		refuted.set(entry.fingerprint, entry);
	}
	try {
		return validateDraftFields({
			prNumber: opts.prNumber,
			itemId: opts.itemId,
			headSha,
			gate: opts.gate,
			agreement: opts.agreement,
			ok: opts.ok,
			survived,
			refuted: [...refuted.values()],
		});
	} catch {
		return undefined;
	}
}
