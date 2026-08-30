import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registerPath, registerRelativePath } from "../registers.js";
import { escapeRegExp } from "../text.js";
import type { ReviewFindingsParseErrorCode } from "./findings.js";
import type { ReviewLoopResult, UnreadableSource } from "./loop.js";

export interface ReviewRecord {
	schemaVersion: 1;
	runId: string;
	itemId: string;
	createdAt: string;
	blockingBar: "must-fix";
	result: ReviewLoopResult;
	escalation?: { id: string; status: "active" | "resolved-proceed" | "resolved-block"; actor?: string; rationale?: string };
}

/**
 * Path+digest-bound record for `pelaggio doc-review` (#384). Deliberately NOT a {@link ReviewRecord}:
 * that record's `itemId` is roadmap-shaped, and a document review has no roadmap item — overloading it
 * with a path string would be a type lie. The binding here is `{ path, digest, byteLength }`.
 */
export interface DocReviewRecord {
	schemaVersion: 1;
	runId: string;
	createdAt: string;
	document: { path: string; digest: string; byteLength: number };
	blockingBar: "must-fix";
	safetyFloor: "disabled";
	safetyFloorNote: string;
	result: ReviewLoopResult;
	/** POSIX-relative pointer at a private failed-seat transcript; never the transcript bytes. */
	failedSeatTranscript?: { path: string; sha256: string };
}

export interface DocReviewSeatTranscriptEntry {
	role: "reviewer" | "judge";
	seatId: string;
	provider: string;
	model?: string;
	pass: number;
	attempt: number;
	subtype: string;
	turns: number;
	parseCode: ReviewFindingsParseErrorCode;
	source: UnreadableSource;
	assistantText: string;
}

export interface DocReviewSeatTranscriptRecord {
	schemaVersion: 1;
	runId: string;
	createdAt: string;
	seats: DocReviewSeatTranscriptEntry[];
}

export function validateReviewRecord(value: ReviewRecord): ReviewRecord {
	if (value.schemaVersion !== 1 || !value.runId || !value.itemId || value.blockingBar !== "must-fix") throw new Error("invalid review record");
	if (Number.isNaN(Date.parse(value.createdAt))) throw new Error("invalid review record timestamp");
	return value;
}

export function validateDocReviewRecord(value: DocReviewRecord): DocReviewRecord {
	if (value.schemaVersion !== 1 || !value.runId || value.blockingBar !== "must-fix") throw new Error("invalid doc review record");
	if (value.safetyFloor !== "disabled") throw new Error("doc review record safety floor must be disabled");
	if (!value.document?.path || !/^[a-f0-9]{64}$/.test(value.document.digest) || !Number.isInteger(value.document.byteLength) || value.document.byteLength < 0) throw new Error("invalid doc review record document binding");
	if (Number.isNaN(Date.parse(value.createdAt))) throw new Error("invalid doc review record timestamp");
	if (value.failedSeatTranscript !== undefined) validateFailedSeatTranscriptDescriptor(value.failedSeatTranscript);
	return value;
}

function validateFailedSeatTranscriptDescriptor(value: { path: string; sha256: string }): void {
	if (!/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("invalid doc review record transcript digest");
	if (value.path.includes("..") || !new RegExp(`^${escapeRegExp(registerRelativePath("doc-review-transcripts"))}/[^/]+$`).test(value.path)) throw new Error("invalid doc review record transcript path");
}

export function validateDocReviewSeatTranscriptRecord(value: DocReviewSeatTranscriptRecord): DocReviewSeatTranscriptRecord {
	if (value.schemaVersion !== 1 || !value.runId || !Array.isArray(value.seats) || value.seats.length === 0) throw new Error("invalid doc review seat transcript");
	if (Number.isNaN(Date.parse(value.createdAt))) throw new Error("invalid doc review seat transcript timestamp");
	for (const seat of value.seats) {
		if (seat.role !== "reviewer" && seat.role !== "judge") throw new Error("invalid doc review seat transcript role");
		if (typeof seat.assistantText !== "string") throw new Error("invalid doc review seat transcript text");
	}
	return value;
}

export function writeReviewRecord(root: string, record: ReviewRecord): string {
	const valid = validateReviewRecord(record);
	return atomicWriteJson(registerPath(root, "review-records", `${valid.runId}.json`), valid);
}

export function writeDocReviewRecord(root: string, record: DocReviewRecord): string {
	const valid = validateDocReviewRecord(record);
	return atomicWriteJson(registerPath(root, "doc-review-records", `${valid.runId}.json`), valid);
}

/**
 * Private failed-seat transcript: serialize once, hash those bytes, write those bytes.
 * Returns a POSIX-relative path from the write root — never an absolute path.
 */
export function writeDocReviewSeatTranscript(root: string, record: DocReviewSeatTranscriptRecord): { path: string; sha256: string } {
	const valid = validateDocReviewSeatTranscriptRecord(record);
	const relativePath = registerRelativePath("doc-review-transcripts", `${valid.runId}.json`);
	const body = `${JSON.stringify(valid, null, 2)}\n`;
	const sha256 = createHash("sha256").update(body).digest("hex");
	const directory = ensurePrivateTranscriptDirectory(root);
	chmodSync(directory, 0o700);
	atomicReplaceText(join(directory, `${valid.runId}.json`), body);
	return { path: relativePath, sha256 };
}

/** Create each repository-controlled component separately and refuse links before any raw text write. */
function ensurePrivateTranscriptDirectory(root: string): string {
	const transcriptDirectory = registerPath(root, "doc-review-transcripts");
	const devDirectory = dirname(transcriptDirectory);
	for (const directory of [devDirectory, transcriptDirectory]) {
		try {
			mkdirSync(directory, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const stat = lstatSync(directory);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`private transcript path component must be a plain directory: ${directory}`);
	}
	return transcriptDirectory;
}

/** Shared atomic write: tmp + rename, mode 0o600. */
function atomicWriteText(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true });
	atomicReplaceText(path, body);
}

/** Atomic replacement once the caller has established the destination directory. */
function atomicReplaceText(path: string, body: string): void {
	const temporary = `${path}.tmp-${process.pid}`;
	// Refuse a stale/predicted temp path instead of reopening it: `mode` is ignored for an
	// existing file, which could otherwise turn a permissive inode into the published transcript.
	writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
}

function atomicWriteJson(path: string, value: unknown): string {
	atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
	return path;
}

/**
 * Shared pass table + seat diagnostics + dissent + cross-model split rendering. Used by both the
 * roadmap review record and the document review record so the two stay in lockstep. Escalation is
 * {@link ReviewRecord}-specific and appended by {@link renderReviewRecord} only.
 */
function renderResultDetail(result: ReviewLoopResult): string {
	const rows = result.passes.map((pass) => `| ${pass.pass} | ${pass.reviewers.filter((seat) => seat.ok).length}/${pass.reviewers.length} | ${pass.judge.valid ? "valid" : "invalid"} | ${pass.carriedAfter.length} |`).join("\n");
	// Surface the captured seat/judge `diagnostic` strings (why a seat or the judge did not complete)
	// so a hard-block — especially a 0-reviewer-seats-ok one — explains itself instead of a bare table (#268).
	const diagnostics = result.passes
		.flatMap((pass) => [
			...pass.reviewers.filter((seat) => seat.diagnostic).map((seat) => `- pass ${pass.pass} ${seat.identity.provider}/${seat.identity.seatId} (${seat.turns}t): ${seat.diagnostic}`),
			...(pass.judge.diagnostic && !pass.judge.valid ? [`- pass ${pass.pass} judge: ${pass.judge.diagnostic}`] : []),
		])
		.join("\n");
	const diagnosticsSection = diagnostics ? `\n\nSeat diagnostics (why a seat or the judge did not complete):\n\n${diagnostics}` : "";
	const dissent = result.dissent
		? `\n\nDissent: ${result.dissent.finding.finding.message}\n\nJudge ruling: ${result.dissent.ruling}. Attempted resolution: ${result.dissent.attemptedResolution}. Notification target: ${result.dissent.notificationTarget}.`
		: "";
	const disagreement = result.disagreement
		? `\n\nCross-model split (evidence \`${result.disagreement.evidenceFingerprint}\`):\n\n${result.disagreement.drivers.map((driver) => `- ${driver.identity.provider}/${driver.identity.seatId}: **${driver.verdict}** — ${driver.rationale}`).join("\n")}`
		: "";
	return `| Pass | Reviewers | Judge | Carried blockers |\n| --- | --- | --- | --- |\n${rows || "| — | — | — | — |"}${diagnosticsSection}${dissent}${disagreement}`;
}

function renderDiversity(result: ReviewLoopResult): string {
	return `- Diversity: **${result.diversity.state}**${result.diversity.state === "softened" ? ` — ${result.diversity.explanation}` : ""}`;
}

export function renderReviewRecord(record: ReviewRecord): string {
	const valid = validateReviewRecord(record);
	const escalation = valid.escalation
		? `\n\nDecision **${valid.escalation.id}**: **${valid.escalation.status}**${valid.escalation.actor ? ` by ${valid.escalation.actor}` : ""}${valid.escalation.rationale ? ` — ${valid.escalation.rationale}` : ""}.`
		: "";
	return `## Adversarial review record\n\nThis is an unbound review record, not a cryptographic attestation.\n\n- Outcome: **${valid.result.outcome}**\n${renderDiversity(valid.result)}\n- Cost: $${valid.result.cost.toFixed(2)}\n\n${renderResultDetail(valid.result)}${escalation}`;
}

export function renderDocReviewRecord(record: DocReviewRecord): string {
	const valid = validateDocReviewRecord(record);
	// The safety-floor pin is rendered prominently so the badge cannot be mistaken for a code-diff
	// safety-floor run: the code-diff path-signal taxonomy is not applied to a bare document.
	const evidence = valid.failedSeatTranscript ? `\n- Failed-seat transcript (local diagnostic, do not commit): \`${valid.failedSeatTranscript.path}\` (\`${valid.failedSeatTranscript.sha256}\`)` : "";
	return `## Document review record\n\nThis is an unbound review record, not a cryptographic attestation.\n\n- Document: \`${valid.document.path}\` (\`${valid.document.digest}\`, ${valid.document.byteLength} bytes)\n- Safety floor: **${valid.safetyFloor}** — ${valid.safetyFloorNote}\n- Outcome: **${valid.result.outcome}**\n${renderDiversity(valid.result)}\n- Cost: $${valid.result.cost.toFixed(2)}${evidence}\n\n${renderResultDetail(valid.result)}`;
}
