/**
 * Typed operator-adjudication evidence and the deterministic churn policy (#497).
 *
 * The local fleet-v2 gate record proves aggregate outcome but does not carry survivor
 * objects or their source hunks. This module owns the sidecar source record, the
 * zero-context interdiff predicate, and the operator-comment renderer. Forge comments
 * are display/audit output only — never reconstructed into authority.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePatch, type StructuredPatch } from "diff";
import type { PrReviewAgreement } from "../pr-review-cli.js";
import type { NewPrReviewOperatorGateRecord, PrReviewFindingDispositionEntry, PrReviewGateRecord } from "../pr-review-gate-record.js";
import { type ClassificationResult, type ClassificationSignalKind, materializeAuthoringFinding, type ReviewFinding, type ReviewFindingClass, type ReviewFindingSeverity, reviewFindingFingerprint } from "./findings.js";
import { type FindingTier, isWellFormedClassId, type TaxonomyConfig, tierOf } from "./taxonomy.js";

/**
 * Marker for the operator PASS comment. DISTINCT from the fleet `<!-- pelaggio-pr-review -->`
 * marker on purpose (#510): `fetchReviewFindings` scrapes the fleet marker into revise/implement
 * prompts, so a PASS body carrying the fleet marker would be fed back to an implementer as
 * "findings" whenever the status post fails and a drain later revises the PR. The adjudication
 * comment is display/audit output under its own marker; it never replaces (or masquerades as)
 * the fleet findings body.
 */
export const PR_ADJUDICATION_MARKER = "<!-- pelaggio-pr-adjudication -->";

export const ADJUDICATION_SOURCES_DIR = "pr-review-adjudication-sources";
export const ADJUDICATION_SOURCE_MAX_BYTES = 1024 * 1024;
export const ADJUDICATION_SOURCE_MAX_SURVIVORS = 64;
export const ADJUDICATION_SOURCE_MAX_PATH = 512;

const SHA40_RE = /^[0-9a-f]{40}$/i;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const RECORD_RE = /^(\d+)-([0-9a-f]{40})\.json$/i;
const CANDIDATE_ID_RE = /^C[1-9]\d*$/;
const SEVERITIES: readonly ReviewFindingSeverity[] = ["must-fix", "nice", "note"];
const TIERS: readonly FindingTier[] = ["safety", "judgment"];
const CLASSIFICATION_SIGNALS: readonly ClassificationSignalKind[] = ["fingerprint", "cwe", "ruleId", "path", "classHint-elevation"];

const DRAFT_KEYS = ["prNumber", "itemId", "reviewedSha", "agreement", "requiredCells", "completedCells", "survivorCount", "survivors"] as const;
const RECORD_KEYS = [...DRAFT_KEYS, "schemaVersion", "fleetRecordDigest"] as const;
const SURVIVOR_KEYS = ["finding", "fingerprint", "class", "classification", "tier", "verification", "hunk"] as const;
const FINDING_KEYS = ["severity", "message", "path", "line"] as const;
const VERIFICATION_KEYS = ["id", "decision", "rationale"] as const;
const HUNK_KEYS = ["path", "start", "end"] as const;
const MATCHED_CLASSIFICATION_KEYS = ["kind", "class", "signal", "ruleId", "conflict"] as const;
const DEFAULT_CLASSIFICATION_KEYS = ["kind", "class"] as const;
const CONFLICT_KEYS = ["winner", "losers"] as const;

export interface PrAdjudicationHunk {
	path: string;
	start: number;
	end: number;
}

export interface PrAdjudicationVerification {
	id: string;
	decision: "survives";
	rationale: string;
}

export interface PrAdjudicationSurvivorEntry {
	finding: ReviewFinding;
	fingerprint: string;
	class: ReviewFindingClass;
	classification: ClassificationResult;
	tier: FindingTier;
	verification: PrAdjudicationVerification;
	hunk: PrAdjudicationHunk;
}

export interface PrAdjudicationSourceDraft {
	prNumber: number;
	itemId: string;
	reviewedSha: string;
	agreement: "consensus-block";
	requiredCells: number;
	completedCells: number;
	survivorCount: number;
	survivors: PrAdjudicationSurvivorEntry[];
}

export interface PrAdjudicationSourceRecordV1 extends PrAdjudicationSourceDraft {
	schemaVersion: 1;
	fleetRecordDigest: string;
}

export type InterdiffEvaluation = { kind: "eligible"; digest: string; dispositions: Record<string, PrReviewFindingDispositionEntry> } | { kind: "refused"; reason: string };

export type AdjudicationSourceBindResult = { ok: true } | { ok: false; reason: string };

export function adjudicationSourcesDir(mainRepo: string): string {
	return resolve(mainRepo, ".dev", ADJUDICATION_SOURCES_DIR);
}

export function fleetRecordDigestOf(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(field: string): never {
	throw new Error(`pr-adjudication source record: invalid ${field}`);
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

function requireDigest(value: unknown, field: string): string {
	if (typeof value !== "string" || !DIGEST_RE.test(value)) fail(field);
	return value;
}

export function normalizeGitPath(path: string | undefined): string | null {
	if (typeof path !== "string") return null;
	let p = path.trim().replace(/\\/g, "/");
	if (p.startsWith("./")) p = p.slice(2);
	if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
	if (p === "" || p === "/dev/null" || p === "dev/null") return null;
	return p;
}

function validateFinding(value: unknown): ReviewFinding {
	if (!isRecord(value)) fail("finding");
	requireClosedKeys(value, FINDING_KEYS, "finding");
	if (!SEVERITIES.includes(value.severity as ReviewFindingSeverity)) fail("finding.severity");
	const message = requireNonEmptyString(value.message, "finding.message");
	if (/[\r\n]/.test(message)) fail("finding.message");
	const finding: ReviewFinding = { severity: value.severity as ReviewFindingSeverity, message };
	if (value.path !== undefined) {
		const path = requireNonEmptyString(value.path, "finding.path");
		if (path.length > ADJUDICATION_SOURCE_MAX_PATH || /[\r\n]/.test(path) || normalizeGitPath(path) === null) fail("finding.path");
		finding.path = path;
	}
	if (value.line !== undefined) {
		if (finding.path === undefined) fail("finding.line");
		finding.line = requirePositiveInt(value.line, "finding.line");
	}
	return finding;
}

function validateClassification(value: unknown): ClassificationResult {
	if (!isRecord(value)) fail("classification");
	if (value.kind === "default-safety") {
		requireClosedKeys(value, DEFAULT_CLASSIFICATION_KEYS, "classification");
		if (value.class !== "correctness-regression") fail("classification.class");
		return { kind: "default-safety", class: "correctness-regression" };
	}
	if (value.kind !== "matched") fail("classification.kind");
	requireClosedKeys(value, MATCHED_CLASSIFICATION_KEYS, "classification");
	const classId = requireNonEmptyString(value.class, "classification.class");
	if (!isWellFormedClassId(classId)) fail("classification.class");
	if (!CLASSIFICATION_SIGNALS.includes(value.signal as ClassificationSignalKind)) fail("classification.signal");
	const ruleId = requireNonEmptyString(value.ruleId, "classification.ruleId");
	let conflict: { winner: ReviewFindingClass; losers: readonly ReviewFindingClass[] } | undefined;
	if (value.conflict !== undefined) {
		if (!isRecord(value.conflict)) fail("classification.conflict");
		requireClosedKeys(value.conflict, CONFLICT_KEYS, "classification.conflict");
		const winner = requireNonEmptyString(value.conflict.winner, "classification.conflict.winner");
		if (!isWellFormedClassId(winner)) fail("classification.conflict.winner");
		if (!Array.isArray(value.conflict.losers) || value.conflict.losers.some((id) => typeof id !== "string" || !isWellFormedClassId(id))) {
			fail("classification.conflict.losers");
		}
		conflict = { winner, losers: value.conflict.losers as ReviewFindingClass[] };
	}
	return {
		kind: "matched",
		class: classId,
		signal: value.signal as ClassificationSignalKind,
		ruleId,
		...(conflict ? { conflict } : {}),
	};
}

function validateVerification(value: unknown): PrAdjudicationVerification {
	if (!isRecord(value)) fail("verification");
	requireClosedKeys(value, VERIFICATION_KEYS, "verification");
	const id = requireNonEmptyString(value.id, "verification.id");
	if (!CANDIDATE_ID_RE.test(id)) fail("verification.id");
	if (value.decision !== "survives") fail("verification.decision");
	const rationale = requireNonEmptyString(value.rationale, "verification.rationale");
	if (rationale.trim().length === 0) fail("verification.rationale");
	return { id, decision: "survives", rationale };
}

function validateHunk(value: unknown): PrAdjudicationHunk {
	if (!isRecord(value)) fail("hunk");
	requireClosedKeys(value, HUNK_KEYS, "hunk");
	const path = requireNonEmptyString(value.path, "hunk.path");
	if (path.length > ADJUDICATION_SOURCE_MAX_PATH || normalizeGitPath(path) === null) fail("hunk.path");
	const start = requirePositiveInt(value.start, "hunk.start");
	const end = requirePositiveInt(value.end, "hunk.end");
	if (start > end) fail("hunk.range");
	return { path, start, end };
}

function validateSurvivor(value: unknown, seen: Set<string>): PrAdjudicationSurvivorEntry {
	if (!isRecord(value)) fail("survivor");
	requireClosedKeys(value, SURVIVOR_KEYS, "survivor");
	const finding = validateFinding(value.finding);
	const fingerprint = requireNonEmptyString(value.fingerprint, "fingerprint");
	if (fingerprint !== reviewFindingFingerprint(finding) || seen.has(fingerprint)) fail("fingerprint");
	seen.add(fingerprint);
	const classId = requireNonEmptyString(value.class, "class");
	if (!isWellFormedClassId(classId)) fail("class");
	const classification = validateClassification(value.classification);
	if (classification.class !== classId) fail("class");
	if (!TIERS.includes(value.tier as FindingTier)) fail("tier");
	const verification = validateVerification(value.verification);
	const hunk = validateHunk(value.hunk);
	return {
		finding,
		fingerprint,
		class: classId,
		classification,
		tier: value.tier as FindingTier,
		verification,
		hunk,
	};
}

function validateDraftFields(value: Record<string, unknown>): PrAdjudicationSourceDraft {
	const prNumber = requirePositiveInt(value.prNumber, "prNumber");
	const itemId = requireNonEmptyString(value.itemId, "itemId");
	const reviewedSha = requireSha40(value.reviewedSha, "reviewedSha");
	if (value.agreement !== "consensus-block") fail("agreement");
	const requiredCells = requirePositiveInt(value.requiredCells, "requiredCells");
	const completedCells = requirePositiveInt(value.completedCells, "completedCells");
	if (requiredCells !== completedCells) fail("completedCells");
	const survivorCount = requirePositiveInt(value.survivorCount, "survivorCount");
	if (!Array.isArray(value.survivors)) fail("survivors");
	if (value.survivors.length > ADJUDICATION_SOURCE_MAX_SURVIVORS) fail("survivors");
	if (value.survivors.length !== survivorCount || survivorCount < 1) fail("survivorCount");
	const seen = new Set<string>();
	const survivors = value.survivors.map((entry) => validateSurvivor(entry, seen));
	return {
		prNumber,
		itemId,
		reviewedSha,
		agreement: "consensus-block",
		requiredCells,
		completedCells,
		survivorCount,
		survivors,
	};
}

export function validateAdjudicationSourceRecord(value: unknown): PrAdjudicationSourceRecordV1 {
	if (!isRecord(value)) fail("record");
	requireClosedKeys(value, RECORD_KEYS, "record");
	if (value.schemaVersion !== 1) fail("schemaVersion");
	const draft = validateDraftFields(value);
	return {
		schemaVersion: 1,
		...draft,
		fleetRecordDigest: requireDigest(value.fleetRecordDigest, "fleetRecordDigest"),
	};
}

function recordPath(root: string, prNumber: number, reviewedSha: string): string {
	return resolve(root, `${prNumber}-${reviewedSha.toLowerCase()}.json`);
}

function readRecord(path: string): PrAdjudicationSourceRecordV1 | null {
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > ADJUDICATION_SOURCE_MAX_BYTES) return null;
		const raw = readFileSync(path);
		if (raw.byteLength > ADJUDICATION_SOURCE_MAX_BYTES) return null;
		return validateAdjudicationSourceRecord(JSON.parse(raw.toString("utf8")));
	} catch {
		return null;
	}
}

export function writeAdjudicationSourceRecord(root: string, record: PrAdjudicationSourceRecordV1 | (PrAdjudicationSourceDraft & { fleetRecordDigest: string })): string {
	const complete = validateAdjudicationSourceRecord({ ...record, schemaVersion: 1 });
	const serialized = `${JSON.stringify(complete, null, 2)}\n`;
	if (Buffer.byteLength(serialized, "utf8") > ADJUDICATION_SOURCE_MAX_BYTES) fail("size");
	mkdirSync(root, { recursive: true });
	const path = recordPath(root, complete.prNumber, complete.reviewedSha);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, serialized, { mode: 0o600 });
	renameSync(tmp, path);
	return path;
}

export function readAdjudicationSourceRecord(root: string, prNumber: number, reviewedSha: string): PrAdjudicationSourceRecordV1 | null {
	if (!Number.isInteger(prNumber) || prNumber <= 0 || !SHA40_RE.test(reviewedSha)) return null;
	const record = readRecord(recordPath(root, prNumber, reviewedSha));
	if (!record || record.prNumber !== prNumber || record.reviewedSha !== reviewedSha.toLowerCase()) return null;
	return record;
}

export function listAdjudicationSourceRecords(root: string): PrAdjudicationSourceRecordV1[] {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	const records: PrAdjudicationSourceRecordV1[] = [];
	for (const name of names.sort()) {
		const match = name.match(RECORD_RE);
		if (!match) continue;
		const [, prNumber, reviewedSha] = match;
		if (!prNumber || !reviewedSha) continue;
		const record = readRecord(resolve(root, name));
		if (!record || record.prNumber !== Number.parseInt(prNumber, 10) || record.reviewedSha !== reviewedSha.toLowerCase()) continue;
		records.push(record);
	}
	return records;
}

const INELIGIBLE_BREAKERS = new Set(["invalid-pass", "provider-diversity"]);

export function isEligibleFleetGateRecord(record: PrReviewGateRecord): boolean {
	if (record.schemaVersion !== 2 || record.producer !== "fleet") return false;
	if (record.gate !== "block" || record.ok !== true) return false;
	if (record.agreement !== "consensus-block") return false;
	if ((record.survivorCount ?? 0) < 1) return false;
	if (record.breakerReason !== undefined && INELIGIBLE_BREAKERS.has(record.breakerReason)) return false;
	return true;
}

export type FleetGateRecordSelection = { kind: "none" } | { kind: "one"; record: PrReviewGateRecord } | { kind: "ambiguous"; files: string[] };

/**
 * Fail-closed fleet-record selection (#510 must-fix). The store keys records by `(pr, headSha)`,
 * so several fleet records can exist for one PR (one per reviewed head). Selection previously
 * preferred the greatest `reviewedAt` — a MODEL-SUPPLIED timestamp in a gitignored store, so a
 * forged future-dated record could outrank the genuine one and steer adjudication to attacker
 * evidence. No field inside the records is a trustworthy ordering signal; with more than one
 * qualifying fleet record for the targeted PR/item pair the selection is ambiguous and the
 * caller must REFUSE, naming the conflicting files so the operator can delete the stale ones
 * (or run a full pr-review). Records for another item are not candidates: PR identity alone is
 * insufficient because the current target item is already known and is part of the evidence
 * identity checked below. A single unambiguous record proceeds as before. Operator-adjudication
 * records are never candidates.
 */
export function selectUnambiguousFleetGateRecord(records: readonly PrReviewGateRecord[], prNumber: number, itemId: string): FleetGateRecordSelection {
	const fleet = records.filter((record) => record.prNumber === prNumber && record.itemId === itemId && (record.schemaVersion === 1 || (record.schemaVersion === 2 && record.producer === "fleet")));
	const only = fleet[0];
	if (only === undefined) return { kind: "none" };
	if (fleet.length === 1) return { kind: "one", record: only };
	return { kind: "ambiguous", files: fleet.map((record) => `${record.prNumber}-${record.headSha}.json`).sort() };
}

export function crossCheckAdjudicationSource(source: PrAdjudicationSourceRecordV1, fleet: PrReviewGateRecord, fleetBytes: Buffer | string, expected: { prNumber: number; itemId: string }): AdjudicationSourceBindResult {
	if (!isEligibleFleetGateRecord(fleet)) return { ok: false, reason: "latest fleet outcome is not an adjudicable consensus-block" };
	if (source.prNumber !== expected.prNumber || fleet.prNumber !== expected.prNumber) return { ok: false, reason: "source record PR does not match the targeted pull request" };
	if (source.itemId !== expected.itemId || fleet.itemId !== expected.itemId) return { ok: false, reason: "source record item does not match the targeted pull request" };
	if (source.reviewedSha !== fleet.headSha.toLowerCase()) return { ok: false, reason: "source record reviewed SHA does not match the fleet record" };
	if (source.agreement !== "consensus-block" || (fleet.schemaVersion === 2 && fleet.producer === "fleet" && fleet.agreement !== "consensus-block")) {
		return { ok: false, reason: "source record agreement does not match the fleet record" };
	}
	const fleetSurvivorCount = fleet.schemaVersion === 1 || (fleet.schemaVersion === 2 && fleet.producer === "fleet") ? (fleet.survivorCount ?? -1) : -1;
	if (source.survivorCount !== source.survivors.length || source.survivorCount !== fleetSurvivorCount) {
		return { ok: false, reason: "source record survivor count does not match the fleet record" };
	}
	if (source.fleetRecordDigest !== fleetRecordDigestOf(fleetBytes)) {
		return { ok: false, reason: "source record is not bound to the exact on-disk fleet record" };
	}
	return { ok: true };
}

export function mapFindingToInspectionHunk(finding: ReviewFinding, patches: readonly StructuredPatch[]): PrAdjudicationHunk | null {
	const path = normalizeGitPath(finding.path);
	if (!path || finding.line === undefined || !Number.isInteger(finding.line) || finding.line <= 0) return null;
	const patch = patches.find((entry) => normalizeGitPath(entry.newFileName) === path);
	if (!patch || patch.isBinary || patch.isRename || patch.isCopy || patch.isCreate || patch.isDelete) return null;
	const containing = patch.hunks.filter((hunk) => {
		if (hunk.newLines <= 0) return false;
		const start = hunk.newStart;
		const end = hunk.newStart + hunk.newLines - 1;
		return finding.line! >= start && finding.line! <= end;
	});
	if (containing.length !== 1 || !containing[0]) return null;
	const hunk = containing[0];
	return { path, start: hunk.newStart, end: hunk.newStart + hunk.newLines - 1 };
}

export function buildAdjudicationSourceDraft(opts: {
	prNumber: number;
	itemId: string;
	reviewedSha: string;
	agreement: PrReviewAgreement;
	requiredCells: number;
	completedCells: number;
	ok: boolean;
	survivors: readonly ReviewFinding[];
	verifications: ReadonlyMap<string, { id: string; rationale: string }>;
	inspectionDiff: string;
	changedFiles: readonly string[];
	taxonomy: TaxonomyConfig;
}): PrAdjudicationSourceDraft | undefined {
	if (!Number.isInteger(opts.prNumber) || opts.prNumber <= 0) return undefined;
	if (typeof opts.itemId !== "string" || opts.itemId.trim() === "") return undefined;
	if (!SHA40_RE.test(opts.reviewedSha)) return undefined;
	if (opts.agreement !== "consensus-block" || !opts.ok) return undefined;
	if (!Number.isInteger(opts.requiredCells) || opts.requiredCells <= 0 || opts.requiredCells !== opts.completedCells) return undefined;
	if (opts.survivors.length < 1 || opts.survivors.length > ADJUDICATION_SOURCE_MAX_SURVIVORS) return undefined;
	let patches: StructuredPatch[];
	try {
		patches = parsePatch(opts.inspectionDiff);
	} catch {
		return undefined;
	}
	const seen = new Set<string>();
	const survivors: PrAdjudicationSurvivorEntry[] = [];
	for (const finding of opts.survivors) {
		const fingerprint = reviewFindingFingerprint(finding);
		if (seen.has(fingerprint)) return undefined;
		seen.add(fingerprint);
		const verification = opts.verifications.get(fingerprint);
		if (!verification) return undefined;
		const hunk = mapFindingToInspectionHunk(finding, patches);
		if (!hunk) return undefined;
		const materialized = materializeAuthoringFinding(finding, { changedFiles: opts.changedFiles }, opts.taxonomy);
		survivors.push({
			finding: {
				severity: finding.severity,
				message: finding.message,
				...(finding.path !== undefined ? { path: finding.path } : {}),
				...(finding.line !== undefined ? { line: finding.line } : {}),
			},
			fingerprint,
			class: materialized.class,
			classification: materialized.classification,
			tier: tierOf(materialized.class, opts.taxonomy),
			verification: { id: verification.id, decision: "survives", rationale: verification.rationale },
			hunk,
		});
	}
	if (survivors.length !== opts.survivors.length) return undefined;
	try {
		return validateDraftFields({
			prNumber: opts.prNumber,
			itemId: opts.itemId,
			reviewedSha: opts.reviewedSha.toLowerCase(),
			agreement: "consensus-block",
			requiredCells: opts.requiredCells,
			completedCells: opts.completedCells,
			survivorCount: survivors.length,
			survivors,
		});
	} catch {
		return undefined;
	}
}

function patchPath(patch: StructuredPatch): string | null {
	return normalizeGitPath(patch.newFileName) ?? normalizeGitPath(patch.oldFileName);
}

function oldSideChangedLines(hunk: StructuredPatch["hunks"][number]): number[] {
	const lines: number[] = [];
	let oldLine = hunk.oldStart;
	for (const line of hunk.lines) {
		if (line.startsWith("\\")) continue;
		if (line.startsWith("+")) continue;
		if (line.startsWith("-")) lines.push(oldLine);
		oldLine++;
	}
	return lines;
}

function rangesForPath(survivors: readonly PrAdjudicationSurvivorEntry[], path: string): Array<{ start: number; end: number; fingerprint: string }> {
	return survivors.filter((survivor) => survivor.hunk.path === path).map((survivor) => ({ start: survivor.hunk.start, end: survivor.hunk.end, fingerprint: survivor.fingerprint }));
}

function containsLine(range: { start: number; end: number }, line: number): boolean {
	return line >= range.start && line <= range.end;
}

function containsInsertionAnchor(range: { start: number; end: number }, oldStart: number): boolean {
	return oldStart >= range.start - 1 && oldStart <= range.end;
}

function addedLineCount(hunk: StructuredPatch["hunks"][number]): number {
	return hunk.lines.filter((line) => line.startsWith("+")).length;
}

/**
 * Byte-containment constants (#510 must-fix). The line-count bounds below cap how MANY lines an
 * interdiff may add, but lines have no intrinsic size: replacing one allowed line with a single
 * arbitrarily large line would smuggle broad unreviewed content past a count-only bound while the
 * refute-only verifier examines only the original finding. Rule, applied per interdiff hunk:
 * every added line's UTF-8 byte length must be at most
 * `clamp(maxRemovedLineBytes, FLOOR, CEILING)`, where `maxRemovedLineBytes` is the longest
 * removed line of the SAME hunk — deleted-side containment already pins every removed line inside
 * a recorded finding hunk, so the removed lines ARE the recorded hunk's own original text and the
 * ceiling is tied to that hunk's real line lengths. Pure insertions carry no original text and
 * get the FLOOR. The FLOOR keeps a fix to a short line from being ineligible at a reasonable
 * length; the CEILING caps the allowance even when the original hunk contained very long lines.
 * Fail-closed: an oversized added line refuses; the fallback is a full pr-review.
 */
export const ADJUDICATION_ADDED_LINE_BYTE_FLOOR = 200;
export const ADJUDICATION_ADDED_LINE_BYTE_CEILING = 1000;

function addedLineByteCeiling(hunk: StructuredPatch["hunks"][number]): number {
	let maxRemoved = 0;
	for (const line of hunk.lines) {
		if (!line.startsWith("-")) continue;
		maxRemoved = Math.max(maxRemoved, Buffer.byteLength(line.slice(1), "utf8"));
	}
	return Math.min(Math.max(maxRemoved, ADJUDICATION_ADDED_LINE_BYTE_FLOOR), ADJUDICATION_ADDED_LINE_BYTE_CEILING);
}

function oversizedAddedLineBytes(hunk: StructuredPatch["hunks"][number]): { bytes: number; ceiling: number } | null {
	const ceiling = addedLineByteCeiling(hunk);
	for (const line of hunk.lines) {
		if (!line.startsWith("+")) continue;
		const bytes = Buffer.byteLength(line.slice(1), "utf8");
		if (bytes > ceiling) return { bytes, ceiling };
	}
	return null;
}

/** Total extent of the distinct recorded finding hunks covering an interdiff hunk (deduped by
 *  span, so several survivors sharing one source hunk do not multiply the budget). */
function coveredExtent(covering: Iterable<{ start: number; end: number }>): number {
	const seen = new Set<string>();
	let extent = 0;
	for (const range of covering) {
		const key = `${range.start}-${range.end}`;
		if (seen.has(key)) continue;
		seen.add(key);
		extent += range.end - range.start + 1;
	}
	return extent;
}

function dispositionRationale(survivor: PrAdjudicationSurvivorEntry): string {
	const hunk = `${survivor.hunk.path}:${survivor.hunk.start}-${survivor.hunk.end}`;
	if (survivor.tier === "safety") {
		// The stored `survivor.verification` is the red-review pass's SURVIVES evidence — it proves
		// the finding was real pre-fix, never that the repair works. Quoting it as repair
		// confirmation corrupted the authorization provenance (#497 must-fix). The durable repair
		// evidence is bound later from the live adjudication-time verification via
		// bindLiveSafetyVerification; until then this rationale claims containment only.
		return `Interdiff contained by source hunk ${hunk}; red-review verification ${survivor.verification.id} recorded the surviving finding; adjudication-time repair verification pending.`;
	}
	return `Interdiff contained by source hunk ${hunk}.`;
}

export interface LiveSafetyRefutation {
	id: string;
	decision: "refuted";
	rationale: string;
}

/**
 * Replace every safety-tier survivor's disposition rationale with the LIVE adjudication-time
 * verification evidence (the refutation produced against the current head), never the stale
 * red-review pass's pre-fix "survives" text. Both passes exist for a safety survivor, so the
 * rationale names which pass produced the quoted evidence. Fail-closed: a safety survivor
 * without live evidence throws — the caller must refuse rather than persist a stale rationale.
 */
export function bindLiveSafetyVerification(
	survivors: readonly PrAdjudicationSurvivorEntry[],
	dispositions: Record<string, PrReviewFindingDispositionEntry>,
	live: ReadonlyMap<string, LiveSafetyRefutation>,
): Record<string, PrReviewFindingDispositionEntry> {
	const bound = { ...dispositions };
	for (const survivor of survivors) {
		if (survivor.tier !== "safety") continue;
		const entry = bound[survivor.fingerprint];
		if (!entry) throw new Error(`no disposition for safety survivor ${survivor.fingerprint}`);
		const evidence = live.get(survivor.fingerprint);
		if (evidence?.decision !== "refuted") {
			throw new Error(`no live adjudication-time verification evidence for safety survivor ${survivor.fingerprint}`);
		}
		const hunk = `${survivor.hunk.path}:${survivor.hunk.start}-${survivor.hunk.end}`;
		bound[survivor.fingerprint] = {
			disposition: entry.disposition,
			rationale:
				`Interdiff contained by source hunk ${hunk}; adjudication-time isolated verification ${evidence.id} refuted the finding (${evidence.rationale}). ` +
				`Evidence pass: adjudication-time verification (the pre-fix red-review verification ${survivor.verification.id} recorded only the survives decision).`,
		};
	}
	return bound;
}

export function evaluateInterdiffPolicy(opts: { isAncestor: boolean; interdiff: Buffer | string; survivors: readonly PrAdjudicationSurvivorEntry[] }): InterdiffEvaluation {
	if (!opts.isAncestor) return { kind: "refused", reason: "current head does not descend from the reviewed revision (force-push or rebase); run a full pr-review" };
	const bytes = typeof opts.interdiff === "string" ? Buffer.from(opts.interdiff, "utf8") : opts.interdiff;
	const digest = fleetRecordDigestOf(bytes);
	const text = bytes.toString("utf8");
	if (text.trim() === "") return { kind: "refused", reason: "interdiff is empty; adjudication requires a narrow non-empty fix" };
	let patches: StructuredPatch[];
	try {
		patches = parsePatch(text);
	} catch {
		return { kind: "refused", reason: "interdiff is malformed and cannot be classified" };
	}
	if (patches.length === 0) return { kind: "refused", reason: "interdiff is malformed and cannot be classified" };

	const allowedPaths = new Set(opts.survivors.map((survivor) => survivor.hunk.path));
	const touched = new Set<string>();
	// Aggregate added-line bookkeeping (#510 must-fix): total added lines across the WHOLE
	// interdiff, and every distinct covering finding hunk (deduped by path+span — the same
	// span-dedupe the per-hunk bound applies within one path).
	let totalAddedLines = 0;
	const aggregateCovering = new Map<string, { start: number; end: number }>();
	const recordCovering = (path: string, ranges: Iterable<{ start: number; end: number }>): void => {
		for (const range of ranges) aggregateCovering.set(`${path}:${range.start}-${range.end}`, range);
	};

	for (const patch of patches) {
		if (patch.isBinary) return { kind: "refused", reason: "interdiff contains a binary change; run a full pr-review" };
		if (patch.isRename) return { kind: "refused", reason: "interdiff contains a rename; run a full pr-review" };
		if (patch.isCopy) return { kind: "refused", reason: "interdiff contains a copy; run a full pr-review" };
		if (patch.isCreate) return { kind: "refused", reason: "interdiff creates a file; run a full pr-review or pelaggio revise" };
		if (patch.isDelete) return { kind: "refused", reason: "interdiff deletes a file; run a full pr-review or pelaggio revise" };
		const path = patchPath(patch);
		if (!path) return { kind: "refused", reason: "interdiff contains an unclassifiable path" };
		if (!allowedPaths.has(path)) return { kind: "refused", reason: `interdiff touches extra file ${path}; run a full pr-review or pelaggio revise` };
		// Mode containment (#510 must-fix): refuse ANY mode metadata, not only hunkless mode-only
		// patches — an in-range text edit combined with `old mode`/`new mode` headers would
		// otherwise smuggle an executable-bit flip (or a file-type transition) into an
		// adjudication-eligible interdiff. Git emits those extended headers only when the mode
		// actually changed (create/delete file modes are already refused above), and jsdiff
		// surfaces them as oldMode/newMode. Narrow fixes never chmod.
		if (patch.oldMode !== undefined || patch.newMode !== undefined) {
			return { kind: "refused", reason: `interdiff changes the file mode on ${path}; run a full pr-review` };
		}
		const ranges = rangesForPath(opts.survivors, path);
		if (ranges.length === 0) return { kind: "refused", reason: `interdiff touches extra file ${path}; run a full pr-review or pelaggio revise` };
		// Added-line containment (#497 must-fix): the deleted-side check bounds removals by
		// requiring every old-side coordinate to fall inside a recorded finding hunk, so one
		// interdiff hunk can remove at most the covering extent. Additions carry no old-side
		// coordinates, so the policy has no per-line check to reuse — fail closed at the
		// equivalent bound: an interdiff hunk may introduce at most as many new lines as the
		// total extent of the distinct recorded finding hunks containing its old-side footprint
		// (its insertion anchor, for pure insertions). Without this bound a one-line in-range
		// replacement could add arbitrarily many unreviewed lines — code the refute-only
		// pr-verify pass never inspects — and still be adjudication-eligible.
		for (const hunk of patch.hunks) {
			// Byte containment (#510 must-fix): applies to every hunk shape. See the rule and
			// constants at ADJUDICATION_ADDED_LINE_BYTE_FLOOR/_CEILING above.
			const oversized = oversizedAddedLineBytes(hunk);
			if (oversized) {
				const at = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart;
				return {
					kind: "refused",
					reason: `interdiff hunk at ${path}:${at} adds a ${oversized.bytes}-byte line, exceeding the ${oversized.ceiling}-byte per-line ceiling derived from the replaced lines; run a full pr-review or pelaggio revise`,
				};
			}
			if (hunk.oldLines === 0) {
				// jsdiff increments oldStart when oldLines === 0 (unified-diff 0-size quirk).
				// The plan's allowlist is the git header anchor, so undo that adjustment.
				const gitOldStart = hunk.oldStart - 1;
				const covering = ranges.filter((range) => containsInsertionAnchor(range, gitOldStart));
				if (covering.length === 0) {
					return { kind: "refused", reason: `interdiff insertion at ${path}:${gitOldStart} is outside recorded finding hunks; run a full pr-review or pelaggio revise` };
				}
				const added = addedLineCount(hunk);
				const allowed = coveredExtent(covering);
				if (added > allowed) {
					return { kind: "refused", reason: `interdiff insertion at ${path}:${gitOldStart} adds ${added} lines, exceeding the ${allowed}-line extent of its covering finding hunks; run a full pr-review or pelaggio revise` };
				}
				totalAddedLines += added;
				recordCovering(path, covering);
				for (const range of covering) touched.add(range.fingerprint);
				continue;
			}
			const changed = oldSideChangedLines(hunk);
			if (changed.length === 0) return { kind: "refused", reason: `interdiff hunk at ${path}:${hunk.oldStart} is unclassifiable` };
			const hunkCovering = new Map<string, { start: number; end: number }>();
			for (const line of changed) {
				const covering = ranges.filter((range) => containsLine(range, line));
				if (covering.length === 0) {
					return { kind: "refused", reason: `interdiff change at ${path}:${line} is outside recorded finding hunks; run a full pr-review or pelaggio revise` };
				}
				for (const range of covering) {
					touched.add(range.fingerprint);
					hunkCovering.set(`${range.start}-${range.end}`, range);
				}
			}
			const added = addedLineCount(hunk);
			const allowed = coveredExtent(hunkCovering.values());
			if (added > allowed) {
				return { kind: "refused", reason: `interdiff hunk at ${path}:${hunk.oldStart} adds ${added} lines, exceeding the ${allowed}-line extent of its covering finding hunks; run a full pr-review or pelaggio revise` };
			}
			totalAddedLines += added;
			recordCovering(path, hunkCovering.values());
		}
	}

	// Aggregate added-line containment (#510 must-fix): the per-hunk allowance above is recomputed
	// inside every hunk iteration, so a `--unified=0` interdiff with one insertion hunk per legal
	// anchor multiplies it — a recorded extent-L hunk admits ~L(L+2) added lines across hunks
	// while each hunk individually stays within bound (observed: extent 11 accepting 132 added
	// lines). In ADDITION to (never instead of) the per-hunk bound, the TOTAL added lines across
	// the whole interdiff must fit within the total extent of the distinct covering finding hunks
	// (deduped by path+span — the same span-dedupe the per-hunk bound uses).
	let aggregateAllowed = 0;
	for (const range of aggregateCovering.values()) aggregateAllowed += range.end - range.start + 1;
	if (totalAddedLines > aggregateAllowed) {
		return { kind: "refused", reason: `interdiff adds ${totalAddedLines} lines in total, exceeding the ${aggregateAllowed}-line total extent of its covering finding hunks; run a full pr-review or pelaggio revise` };
	}

	const uncovered = opts.survivors.find((survivor) => !touched.has(survivor.fingerprint));
	if (uncovered) {
		return { kind: "refused", reason: `survivor ${uncovered.hunk.path}:${uncovered.hunk.start}-${uncovered.hunk.end} was not touched by the interdiff; run a full pr-review` };
	}

	const dispositions: Record<string, PrReviewFindingDispositionEntry> = {};
	for (const survivor of opts.survivors) {
		dispositions[survivor.fingerprint] = { disposition: "fixed", rationale: dispositionRationale(survivor) };
	}
	return { kind: "eligible", digest, dispositions };
}

export function renderOperatorAdjudicationComment(opts: {
	prNumber: number;
	sourceSha: string;
	headSha: string;
	interdiffDigest: string;
	adjudicator: string;
	survivors: readonly PrAdjudicationSurvivorEntry[];
	dispositions: Record<string, PrReviewFindingDispositionEntry>;
}): string {
	const findings = opts.survivors.map((survivor) => {
		const location = survivor.finding.path ? ` (\`${survivor.finding.path}${survivor.finding.line ? `:${survivor.finding.line}` : ""}\`)` : "";
		const entry = opts.dispositions[survivor.fingerprint];
		const disposition = entry ? ` — **${entry.disposition}** (${entry.rationale})` : "";
		return `- **${survivor.finding.severity}**${location}: ${survivor.finding.message}${disposition}`;
	});
	return [
		PR_ADJUDICATION_MARKER,
		"✅ **Operator adjudication: PASS**",
		"",
		`Reviewed \`${opts.sourceSha}\` → \`${opts.headSha}\`. Interdiff digest \`${opts.interdiffDigest}\`. Adjudicator: \`${opts.adjudicator}\`.`,
		"",
		"### Deterministic churn",
		"Every interdiff edit is contained by a recorded finding-bearing hunk, and every survivor hunk was touched.",
		"",
		"### Findings",
		...findings,
		"",
		"If the `review` status was not posted, retry `npx pelaggio pr-adjudicate --pr " + String(opts.prNumber) + "`. Do not run `revise` to recover — any fleet findings comment above predates this adjudication.",
		"",
		"<sub>pelaggio pr-adjudicate · operator-adjudication</sub>",
	].join("\n");
}

export function buildOperatorGateRecord(opts: {
	prNumber: number;
	itemId: string;
	headSha: string;
	reviewedSourceSha: string;
	interdiffDigest: string;
	adjudicator: string;
	dispositions: Record<string, PrReviewFindingDispositionEntry>;
	reviewedAt: string;
}): NewPrReviewOperatorGateRecord {
	return {
		producer: "operator-adjudication",
		agreement: "not-run",
		prNumber: opts.prNumber,
		itemId: opts.itemId,
		headSha: opts.headSha,
		gate: "pass",
		runner: "local",
		reviewedAt: opts.reviewedAt,
		adjudicator: opts.adjudicator,
		reviewedSourceSha: opts.reviewedSourceSha,
		interdiffDigest: opts.interdiffDigest,
		dispositions: opts.dispositions,
	};
}
