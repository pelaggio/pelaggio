import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeAtomically } from "./record-store.js";
import { type RegisterName, registerPath } from "./registers.js";
import type { ReviewExhaustionReason } from "./review/findings.js";
import type { PrReviewAgreement } from "./types.js";

export type PrReviewFindingDisposition = "fixed" | "refuted" | "accepted";

export interface PrReviewFindingDispositionEntry {
	disposition: PrReviewFindingDisposition;
	rationale: string;
}

export interface PrReviewGateRecordV1 {
	schemaVersion: 1;
	prNumber: number;
	headSha: string;
	itemId: string;
	gate: "pass" | "block";
	ok: boolean;
	subtype: string;
	agreement: PrReviewAgreement;
	breakerReason?: ReviewExhaustionReason;
	iterations?: number;
	survivorCount?: number;
	cost: number;
	costEstimated: boolean;
	turns: number;
	runner: "local";
	reviewedAt: string;
}

export interface PrReviewFleetGateRecordV2 {
	schemaVersion: 2;
	producer: "fleet";
	prNumber: number;
	headSha: string;
	itemId: string;
	gate: "pass" | "block";
	ok: boolean;
	subtype: string;
	agreement: PrReviewAgreement;
	breakerReason?: ReviewExhaustionReason;
	iterations?: number;
	survivorCount?: number;
	cost: number;
	costEstimated: boolean;
	turns: number;
	/** Wall-clock duration of the fleet gate invocation. Absent on historical v2 records. */
	elapsedMs?: number;
	runner: "local";
	reviewedAt: string;
}

export interface PrReviewOperatorGateRecordV2 {
	schemaVersion: 2;
	producer: "operator-adjudication";
	agreement: "not-run";
	prNumber: number;
	itemId: string;
	headSha: string;
	gate: "pass" | "block";
	runner: "local";
	reviewedAt: string;
	adjudicator: string;
	reviewedSourceSha: string;
	interdiffDigest: string;
	dispositions: Record<string, PrReviewFindingDispositionEntry>;
}

export type PrReviewGateRecordV2 = PrReviewFleetGateRecordV2 | PrReviewOperatorGateRecordV2;
export type PrReviewGateRecord = PrReviewGateRecordV1 | PrReviewGateRecordV2;

// Per-branch Omit: mapped Omit on the v2 union would keep only shared keys and erase the producer branch.
export type NewPrReviewFleetGateRecord = Omit<PrReviewFleetGateRecordV2, "schemaVersion" | "elapsedMs"> & { elapsedMs: number };
export type NewPrReviewOperatorGateRecord = Omit<PrReviewOperatorGateRecordV2, "schemaVersion">;
export type NewPrReviewGateRecord = NewPrReviewFleetGateRecord | NewPrReviewOperatorGateRecord;

/** Store directory name under `MAIN_REPO/.dev/`. Exported so the step-runner's Bash register
 *  denial (#510) names the exact same path as the store — the deny list must not drift. */
export const PR_REVIEW_GATE_RECORDS_DIR: RegisterName = "pr-review-gate-records";
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const RECORD_RE = /^(\d+)-([0-9a-f]{7,40})\.json$/i;
const AGREEMENTS: readonly PrReviewAgreement[] = ["consensus-pass", "consensus-block", "disagreement", "invalid"];
const BREAKER_REASONS: readonly ReviewExhaustionReason[] = ["max-passes", "budget", "diminishing-returns", "invalid-pass", "verdict-split", "provider-diversity"];
const DISPOSITIONS: readonly PrReviewFindingDisposition[] = ["fixed", "refuted", "accepted"];

const FLEET_V2_KEYS = [
	"schemaVersion",
	"producer",
	"prNumber",
	"headSha",
	"itemId",
	"gate",
	"ok",
	"subtype",
	"agreement",
	"breakerReason",
	"iterations",
	"survivorCount",
	"cost",
	"costEstimated",
	"turns",
	"elapsedMs",
	"runner",
	"reviewedAt",
] as const;
const OPERATOR_V2_KEYS = ["schemaVersion", "producer", "agreement", "prNumber", "itemId", "headSha", "gate", "runner", "reviewedAt", "adjudicator", "reviewedSourceSha", "interdiffDigest", "dispositions"] as const;
const DISPOSITION_ENTRY_KEYS = ["disposition", "rationale"] as const;

export function gateRecordsDir(mainRepo: string): string {
	return registerPath(mainRepo, PR_REVIEW_GATE_RECORDS_DIR);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function fail(field: string): never {
	throw new Error(`pr-review gate record: invalid ${field}`);
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

function requireSha(value: unknown, field: string): string {
	if (typeof value !== "string" || !SHA_RE.test(value)) fail(field);
	return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) fail(field);
	return value;
}

function requireGate(value: unknown): "pass" | "block" {
	if (value !== "pass" && value !== "block") fail("gate");
	return value;
}

function requireRunner(value: unknown): "local" {
	if (value !== "local") fail("runner");
	return value;
}

function requireReviewedAt(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || !Number.isFinite(Date.parse(value))) fail("reviewedAt");
	return value;
}

function requireFleetAgreement(value: unknown): PrReviewAgreement {
	if (typeof value !== "string" || !AGREEMENTS.includes(value as PrReviewAgreement)) fail("agreement");
	return value as PrReviewAgreement;
}

function requireOptionalBreaker(value: unknown): ReviewExhaustionReason | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !BREAKER_REASONS.includes(value as ReviewExhaustionReason)) fail("breakerReason");
	return value as ReviewExhaustionReason;
}

function requireOptionalCount(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (!isNonNegativeFinite(value)) fail(field);
	return value;
}

function requireOptionalNonNegativeInt(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) < 0) fail(field);
	return value as number;
}

function validateCommonIdentity(value: Record<string, unknown>): {
	prNumber: number;
	headSha: string;
	itemId: string;
	gate: "pass" | "block";
	runner: "local";
	reviewedAt: string;
} {
	return {
		prNumber: requirePositiveInt(value.prNumber, "prNumber"),
		headSha: requireSha(value.headSha, "headSha"),
		itemId: requireNonEmptyString(value.itemId, "itemId"),
		gate: requireGate(value.gate),
		runner: requireRunner(value.runner),
		reviewedAt: requireReviewedAt(value.reviewedAt),
	};
}

function validateFleetMetrics(value: Record<string, unknown>): {
	ok: boolean;
	subtype: string;
	agreement: PrReviewAgreement;
	breakerReason?: ReviewExhaustionReason;
	iterations?: number;
	survivorCount?: number;
	cost: number;
	costEstimated: boolean;
	turns: number;
	elapsedMs?: number;
} {
	if (typeof value.ok !== "boolean") fail("ok");
	const subtype = requireNonEmptyString(value.subtype, "subtype");
	const agreement = requireFleetAgreement(value.agreement);
	const breakerReason = requireOptionalBreaker(value.breakerReason);
	const iterations = requireOptionalCount(value.iterations, "iterations");
	const survivorCount = requireOptionalCount(value.survivorCount, "survivorCount");
	if (!isNonNegativeFinite(value.cost)) fail("cost");
	if (typeof value.costEstimated !== "boolean") fail("costEstimated");
	if (!isNonNegativeFinite(value.turns)) fail("turns");
	const elapsedMs = requireOptionalNonNegativeInt(value.elapsedMs, "elapsedMs");
	return {
		ok: value.ok,
		subtype,
		agreement,
		...(breakerReason !== undefined ? { breakerReason } : {}),
		...(iterations !== undefined ? { iterations } : {}),
		...(survivorCount !== undefined ? { survivorCount } : {}),
		cost: value.cost,
		costEstimated: value.costEstimated,
		turns: value.turns,
		...(elapsedMs !== undefined ? { elapsedMs } : {}),
	};
}

// Historical v1 files stay raw: extra keys survive in memory and are never rewritten.
function validateV1(value: Record<string, unknown>): PrReviewGateRecordV1 {
	if (value.schemaVersion !== 1) fail("schemaVersion");
	validateCommonIdentity(value);
	validateFleetMetrics(value);
	return value as unknown as PrReviewGateRecordV1;
}

function validateDispositions(value: unknown): Record<string, PrReviewFindingDispositionEntry> {
	if (!isRecord(value)) fail("dispositions");
	const entries: [string, PrReviewFindingDispositionEntry][] = [];
	const seen = new Set<string>();
	for (const [rawKey, rawEntry] of Object.entries(value)) {
		const key = rawKey.trim();
		if (key.length === 0 || seen.has(key)) fail("disposition key");
		seen.add(key);
		if (!isRecord(rawEntry)) fail("disposition entry");
		requireClosedKeys(rawEntry, DISPOSITION_ENTRY_KEYS, "disposition entry");
		if (!DISPOSITIONS.includes(rawEntry.disposition as PrReviewFindingDisposition)) fail("disposition");
		if (typeof rawEntry.rationale !== "string" || rawEntry.rationale.trim().length === 0) fail("rationale");
		entries.push([key, { disposition: rawEntry.disposition as PrReviewFindingDisposition, rationale: rawEntry.rationale.trim() }]);
	}
	return Object.fromEntries(entries);
}

function validateFleetV2(value: Record<string, unknown>): PrReviewFleetGateRecordV2 {
	requireClosedKeys(value, FLEET_V2_KEYS, "record");
	if (value.producer !== "fleet") fail("producer");
	return {
		schemaVersion: 2,
		producer: "fleet",
		...validateCommonIdentity(value),
		...validateFleetMetrics(value),
	};
}

function validateOperatorV2(value: Record<string, unknown>): PrReviewOperatorGateRecordV2 {
	requireClosedKeys(value, OPERATOR_V2_KEYS, "record");
	if (value.producer !== "operator-adjudication") fail("producer");
	if (value.agreement !== "not-run") fail("agreement");
	if (typeof value.adjudicator !== "string" || value.adjudicator.trim().length === 0) fail("adjudicator");
	const reviewedSourceSha = requireSha(value.reviewedSourceSha, "reviewedSourceSha");
	if (typeof value.interdiffDigest !== "string" || !DIGEST_RE.test(value.interdiffDigest)) fail("interdiffDigest");
	return {
		schemaVersion: 2,
		producer: "operator-adjudication",
		agreement: "not-run",
		...validateCommonIdentity(value),
		adjudicator: value.adjudicator.trim(),
		reviewedSourceSha,
		interdiffDigest: value.interdiffDigest,
		dispositions: validateDispositions(value.dispositions),
	};
}

export function validatePrReviewGateRecord(value: unknown): PrReviewGateRecord {
	if (!isRecord(value)) fail("record");
	if (value.schemaVersion === 1) return validateV1(value);
	if (value.schemaVersion !== 2) fail("schemaVersion");
	if (value.producer === "fleet") return validateFleetV2(value);
	if (value.producer === "operator-adjudication") return validateOperatorV2(value);
	fail("producer");
}

/** Fleet agreement for v1 and v2 fleet records. Operator adjudication is never consensus. */
export function fleetAgreementOf(record: PrReviewGateRecord): PrReviewAgreement | null {
	if (record.schemaVersion === 1) return record.agreement;
	if (record.producer === "fleet") return record.agreement;
	return null;
}

function recordPath(root: string, prNumber: number, headSha: string): string {
	return resolve(root, `${prNumber}-${headSha}.json`);
}

function readRecord(path: string): PrReviewGateRecord | null {
	try {
		return validatePrReviewGateRecord(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return null;
	}
}

export function writePrReviewGateRecord(root: string, record: NewPrReviewGateRecord): string {
	if (record.producer === "fleet" && record.elapsedMs === undefined) fail("elapsedMs");
	const complete = validatePrReviewGateRecord({ ...record, schemaVersion: 2 });
	mkdirSync(root, { recursive: true });
	const path = recordPath(root, complete.prNumber, complete.headSha);
	writeAtomically(path, `${JSON.stringify(complete, null, 2)}\n`, { mode: 0o600 });
	return path;
}

export function readPrReviewGateRecord(root: string, prNumber: number, headSha: string): PrReviewGateRecord | null {
	if (!Number.isInteger(prNumber) || prNumber <= 0 || !SHA_RE.test(headSha)) return null;
	const record = readRecord(recordPath(root, prNumber, headSha));
	if (!record || record.prNumber !== prNumber || record.headSha.toLowerCase() !== headSha.toLowerCase()) return null;
	return record;
}

export function listPrReviewGateRecords(root: string): PrReviewGateRecord[] {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	const records: PrReviewGateRecord[] = [];
	for (const name of names.sort()) {
		const match = name.match(RECORD_RE);
		if (!match) continue;
		const [, prNumber, headSha] = match;
		if (!prNumber || !headSha) continue;
		const record = readRecord(resolve(root, name));
		if (!record || record.prNumber !== Number.parseInt(prNumber, 10) || record.headSha.toLowerCase() !== headSha.toLowerCase()) continue;
		records.push(record);
	}
	return records;
}
