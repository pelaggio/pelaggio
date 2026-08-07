import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PrReviewAgreement } from "./pr-review-cli.js";
import type { ReviewExhaustionReason } from "./review/findings.js";

export interface PrReviewGateRecord {
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

export type NewPrReviewGateRecord = Omit<PrReviewGateRecord, "schemaVersion">;

const RECORDS_DIR = "pr-review-gate-records";
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const RECORD_RE = /^(\d+)-([0-9a-f]{7,40})\.json$/i;
const AGREEMENTS: readonly PrReviewAgreement[] = ["consensus-pass", "consensus-block", "disagreement", "invalid"];
const BREAKER_REASONS: readonly ReviewExhaustionReason[] = ["max-passes", "budget", "diminishing-returns", "invalid-pass", "provider-diversity"];

export function gateRecordsDir(mainRepo: string): string {
	return resolve(mainRepo, ".dev", RECORDS_DIR);
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validatePrReviewGateRecord(value: PrReviewGateRecord): PrReviewGateRecord {
	if (value?.schemaVersion !== 1) throw new Error("pr-review gate record: invalid schemaVersion");
	if (!Number.isInteger(value.prNumber) || value.prNumber <= 0) throw new Error("pr-review gate record: invalid prNumber");
	if (typeof value.headSha !== "string" || !SHA_RE.test(value.headSha)) throw new Error("pr-review gate record: invalid headSha");
	if (typeof value.itemId !== "string" || value.itemId.length === 0) throw new Error("pr-review gate record: invalid itemId");
	if (value.gate !== "pass" && value.gate !== "block") throw new Error("pr-review gate record: invalid gate");
	if (typeof value.ok !== "boolean") throw new Error("pr-review gate record: invalid ok");
	if (typeof value.subtype !== "string" || value.subtype.length === 0) throw new Error("pr-review gate record: invalid subtype");
	if (!AGREEMENTS.includes(value.agreement)) throw new Error("pr-review gate record: invalid agreement");
	if (value.breakerReason !== undefined && !BREAKER_REASONS.includes(value.breakerReason)) throw new Error("pr-review gate record: invalid breakerReason");
	if (value.iterations !== undefined && !isNonNegativeFinite(value.iterations)) throw new Error("pr-review gate record: invalid iterations");
	if (value.survivorCount !== undefined && !isNonNegativeFinite(value.survivorCount)) throw new Error("pr-review gate record: invalid survivorCount");
	if (!isNonNegativeFinite(value.cost)) throw new Error("pr-review gate record: invalid cost");
	if (typeof value.costEstimated !== "boolean") throw new Error("pr-review gate record: invalid costEstimated");
	if (!isNonNegativeFinite(value.turns)) throw new Error("pr-review gate record: invalid turns");
	if (value.runner !== "local") throw new Error("pr-review gate record: invalid runner");
	if (typeof value.reviewedAt !== "string" || value.reviewedAt.length === 0 || !Number.isFinite(Date.parse(value.reviewedAt))) throw new Error("pr-review gate record: invalid reviewedAt");
	return value;
}

function recordPath(root: string, prNumber: number, headSha: string): string {
	return resolve(root, `${prNumber}-${headSha}.json`);
}

function readRecord(path: string): PrReviewGateRecord | null {
	try {
		return validatePrReviewGateRecord(JSON.parse(readFileSync(path, "utf8")) as PrReviewGateRecord);
	} catch {
		return null;
	}
}

export function writePrReviewGateRecord(root: string, record: NewPrReviewGateRecord): string {
	const complete = validatePrReviewGateRecord({ schemaVersion: 1, ...record });
	mkdirSync(root, { recursive: true });
	const path = recordPath(root, complete.prNumber, complete.headSha);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(complete, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
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
