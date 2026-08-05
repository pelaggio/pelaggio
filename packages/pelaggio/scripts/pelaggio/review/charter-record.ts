import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Scope } from "../roadmap/types.js";
import { type CharterReviewConfig, canonicalizeCharterPolicy } from "./charter-policy.js";

/**
 * Charter-review record (#367). Tamper-EVIDENT, not tamper-proof: it binds the exact review inputs by
 * SHA-256 and is content-addressed by the digest of its own canonical bytes — the only value an adapter
 * ever carries as `reviewDigest`. Direct tracker mutation / same-environment forgery stay out of scope.
 */
export const CHARTER_REVIEW_DIR = join(".dev", "charter-reviews");

/** Advisory verdict. `ship` is the only value that lets deferred work activate without a fresh review. */
export type CharterReviewVerdict = "ship" | "defer" | "degenerate" | "execution-error";

/** Who requested the review. Recorded for audit; never trusted as a capability. */
export type CharterReviewOrigin = "create" | "harness-deferral" | "activation";

export interface CharterSeatEvidence {
	role: "reviewer" | "judge";
	seatId: string;
	provider: string;
	ok: boolean;
	verdict?: "pass" | "block";
	diagnostic?: string;
}

/** Normalized panel/Judge evidence — enough to audit the verdict without re-reading the raw loop result. */
export interface CharterReviewEvidence {
	outcome: string;
	diversity: "met" | "softened";
	passes: number;
	survivors: number;
	notes: number;
	cost: number;
	seats: CharterSeatEvidence[];
}

/** Typed andon on a non-ship / degenerate / errored review. Terminal until an operator resolves it. */
export interface CharterAndon {
	id: string;
	status: "active";
	kind: "non-ship" | "degenerate" | "execution-error";
	reason: string;
}

export interface CharterReviewInputs {
	title: string;
	/** SHA-256 of the exact UTF-8 charter body (empty string for legacy/body-less callers). */
	bodySha256: string;
	titleSha256: string;
	/** SHA-256 of {@link canonicalizeCharterPolicy} for the effective policy this review ran under. */
	policySha256: string;
}

export interface CharterReviewRecord {
	schemaVersion: 1;
	recordId: string;
	createdAt: string;
	scope?: Scope;
	origin: CharterReviewOrigin;
	/** Advisory verdict — a review may recommend deferral but never vetoes item creation. */
	verdict: CharterReviewVerdict;
	inputs: CharterReviewInputs;
	/** Complete effective-policy snapshot (both raw floors, resolved level, seats, max passes). */
	policy: CharterReviewConfig;
	evidence: CharterReviewEvidence;
	andon?: CharterAndon;
}

/** SHA-256 hex of a UTF-8 string. */
export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Build the input-hash binding for a title/body/policy triple (empty body ⇒ sha256 of ""). */
export function charterReviewInputs(title: string, body: string, policy: CharterReviewConfig): CharterReviewInputs {
	return { title, bodySha256: sha256Hex(body), titleSha256: sha256Hex(title), policySha256: sha256Hex(canonicalizeCharterPolicy(policy)) };
}

function canonicalizeSlot(slot: CharterReviewConfig["judge"]): Record<string, string> {
	if (slot.provider === "codex") return { id: slot.id, provider: "codex", ...(slot.codexModel ? { codexModel: slot.codexModel } : {}) };
	return { id: slot.id, provider: slot.provider, ...(slot.model ? { model: slot.model } : {}) };
}

/**
 * Deterministic canonical bytes of a record, built in a FIXED key order independent of the input
 * object's insertion order. This is what {@link computeCharterRecordDigest} hashes, so the digest is
 * stable across object-shape churn and a single changed byte of any bound input invalidates it.
 */
export function canonicalizeCharterRecord(record: CharterReviewRecord): string {
	const policy = record.policy;
	return JSON.stringify({
		schemaVersion: record.schemaVersion,
		recordId: record.recordId,
		createdAt: record.createdAt,
		...(record.scope ? { scope: record.scope } : {}),
		origin: record.origin,
		verdict: record.verdict,
		inputs: { title: record.inputs.title, titleSha256: record.inputs.titleSha256, bodySha256: record.inputs.bodySha256, policySha256: record.inputs.policySha256 },
		policy: {
			effectiveLevel: policy.effectiveLevel,
			rawYmlLevel: policy.rawYmlLevel,
			rawEnvFloor: policy.rawEnvFloor,
			reviewers: [...policy.reviewers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(canonicalizeSlot),
			judge: canonicalizeSlot(policy.judge),
			maxPasses: policy.maxPasses,
		},
		evidence: {
			outcome: record.evidence.outcome,
			diversity: record.evidence.diversity,
			passes: record.evidence.passes,
			survivors: record.evidence.survivors,
			notes: record.evidence.notes,
			cost: record.evidence.cost,
			seats: [...record.evidence.seats]
				.sort((a, b) => (a.seatId < b.seatId ? -1 : a.seatId > b.seatId ? 1 : 0))
				.map((seat) => ({ role: seat.role, seatId: seat.seatId, provider: seat.provider, ok: seat.ok, ...(seat.verdict ? { verdict: seat.verdict } : {}), ...(seat.diagnostic ? { diagnostic: seat.diagnostic } : {}) })),
		},
		...(record.andon ? { andon: { id: record.andon.id, status: record.andon.status, kind: record.andon.kind, reason: record.andon.reason } } : {}),
	});
}

/** The content address of a record — the only value an adapter ever carries as `reviewDigest`. */
export function computeCharterRecordDigest(record: CharterReviewRecord): string {
	return sha256Hex(canonicalizeCharterRecord(record));
}

export function validateCharterReviewRecord(value: CharterReviewRecord): CharterReviewRecord {
	if (value.schemaVersion !== 1 || !value.recordId) throw new Error("invalid charter review record");
	if (Number.isNaN(Date.parse(value.createdAt))) throw new Error("invalid charter review record timestamp");
	for (const hash of [value.inputs?.bodySha256, value.inputs?.titleSha256, value.inputs?.policySha256]) {
		if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid charter review record input hash");
	}
	return value;
}

/**
 * Atomically write a record content-addressed by its own canonical digest: `.dev/charter-reviews/<digest>.json`.
 * Returns the path and the digest (== `reviewDigest`).
 */
export function writeCharterReviewRecord(root: string, record: CharterReviewRecord): { path: string; digest: string } {
	const valid = validateCharterReviewRecord(record);
	const digest = computeCharterRecordDigest(valid);
	const path = join(root, CHARTER_REVIEW_DIR, `${digest}.json`);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
	return { path, digest };
}

/**
 * Read + verify a record referenced only by its digest. Fail-closed: returns null when the file is
 * missing, unparseable, invalid, or its recomputed canonical digest does not match `digest`. Never
 * accepts a caller-supplied record object — only a digest that re-derives from bytes on disk. (#367)
 */
export function readCharterReviewRecord(root: string, digest: string): CharterReviewRecord | null {
	if (!/^[a-f0-9]{64}$/.test(digest)) return null;
	const path = join(root, CHARTER_REVIEW_DIR, `${digest}.json`);
	let parsed: CharterReviewRecord;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as CharterReviewRecord;
		validateCharterReviewRecord(parsed);
	} catch {
		return null;
	}
	return computeCharterRecordDigest(parsed) === digest ? parsed : null;
}

/** True when a record's bound input hashes match the then-current title/body/policy. */
export function charterRecordInputsMatch(record: CharterReviewRecord, title: string, body: string, policy: CharterReviewConfig): boolean {
	const now = charterReviewInputs(title, body, policy);
	return record.inputs.titleSha256 === now.titleSha256 && record.inputs.bodySha256 === now.bodySha256 && record.inputs.policySha256 === now.policySha256;
}

/** Human-readable rendering (markdown sidecar / operator report). */
export function renderCharterReviewRecord(record: CharterReviewRecord, digest = computeCharterRecordDigest(record)): string {
	const valid = validateCharterReviewRecord(record);
	const seats = valid.evidence.seats.map((seat) => `- ${seat.role} ${seat.provider}/${seat.seatId}: ${seat.ok ? (seat.verdict ?? "ok") : `not-completed${seat.diagnostic ? ` — ${seat.diagnostic}` : ""}`}`).join("\n");
	const andon = valid.andon ? `\n\nAndon **${valid.andon.id}** (${valid.andon.kind}): ${valid.andon.reason}` : "";
	return [
		"## Charter review record",
		"",
		"This is a tamper-evident review record, not a cryptographic attestation of source.",
		"",
		`- Record: \`${digest}\``,
		`- Verdict: **${valid.verdict}**`,
		`- Origin: ${valid.origin}${valid.scope ? ` · scope ${valid.scope}` : ""}`,
		`- Policy: **${valid.policy.effectiveLevel}** (yml ${valid.policy.rawYmlLevel}, env-floor ${valid.policy.rawEnvFloor}, max-passes ${valid.policy.maxPasses})`,
		`- Outcome: **${valid.evidence.outcome}** · diversity ${valid.evidence.diversity} · passes ${valid.evidence.passes} · survivors ${valid.evidence.survivors} · cost $${valid.evidence.cost.toFixed(2)}`,
		`- Bound inputs: title \`${valid.inputs.titleSha256.slice(0, 12)}\`, body \`${valid.inputs.bodySha256.slice(0, 12)}\`, policy \`${valid.inputs.policySha256.slice(0, 12)}\``,
		seats ? `\n${seats}` : "",
		andon,
	].join("\n");
}
