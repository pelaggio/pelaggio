import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuthoringReviewStage } from "../types.js";
import type { ReviewLoopResult } from "./loop.js";

export type { AuthoringReviewStage };

export const AUTHORING_REVIEW_STAGES: readonly AuthoringReviewStage[] = ["plan", "code"];

export interface ReviewRecord {
	schemaVersion: 1;
	runId: string;
	itemId: string;
	/** Required stage binding so plan/code records cannot overwrite or render interchangeably. */
	stage: AuthoringReviewStage;
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
}

export function validateReviewRecord(value: ReviewRecord): ReviewRecord {
	if (value.schemaVersion !== 1 || !value.runId || !value.itemId || value.blockingBar !== "must-fix") throw new Error("invalid review record");
	// Stage is required — never default a missing stage to "code" (would launder plan records).
	if (value.stage !== "plan" && value.stage !== "code") throw new Error("invalid review record stage");
	if (Number.isNaN(Date.parse(value.createdAt))) throw new Error("invalid review record timestamp");
	return value;
}

export function validateDocReviewRecord(value: DocReviewRecord): DocReviewRecord {
	if (value.schemaVersion !== 1 || !value.runId || value.blockingBar !== "must-fix") throw new Error("invalid doc review record");
	if (value.safetyFloor !== "disabled") throw new Error("doc review record safety floor must be disabled");
	if (!value.document?.path || !/^[a-f0-9]{64}$/.test(value.document.digest) || !Number.isInteger(value.document.byteLength) || value.document.byteLength < 0) throw new Error("invalid doc review record document binding");
	if (Number.isNaN(Date.parse(value.createdAt))) throw new Error("invalid doc review record timestamp");
	return value;
}

export function writeReviewRecord(root: string, record: ReviewRecord): string {
	const valid = validateReviewRecord(record);
	return atomicWriteJson(join(root, ".dev", "review-records", `${valid.runId}.json`), valid);
}

export function writeDocReviewRecord(root: string, record: DocReviewRecord): string {
	const valid = validateDocReviewRecord(record);
	return atomicWriteJson(join(root, ".dev", "doc-review-records", `${valid.runId}.json`), valid);
}

/** Shared atomic write: tmp + rename, mode 0o600. */
function atomicWriteJson(path: string, value: unknown): string {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
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
	const stageLabel = valid.stage === "plan" ? "plan" : "code";
	return `## Adversarial review record\n\nThis is an unbound review record, not a cryptographic attestation.\n\n- Stage: **${stageLabel}**\n- Outcome: **${valid.result.outcome}**\n${renderDiversity(valid.result)}\n- Cost: $${valid.result.cost.toFixed(2)}\n\n${renderResultDetail(valid.result)}${escalation}`;
}

export function renderDocReviewRecord(record: DocReviewRecord): string {
	const valid = validateDocReviewRecord(record);
	// The safety-floor pin is rendered prominently so the badge cannot be mistaken for a code-diff
	// safety-floor run: the code-diff path-signal taxonomy is not applied to a bare document.
	return `## Document review record\n\nThis is an unbound review record, not a cryptographic attestation.\n\n- Document: \`${valid.document.path}\` (\`${valid.document.digest}\`, ${valid.document.byteLength} bytes)\n- Safety floor: **${valid.safetyFloor}** — ${valid.safetyFloorNote}\n- Outcome: **${valid.result.outcome}**\n${renderDiversity(valid.result)}\n- Cost: $${valid.result.cost.toFixed(2)}\n\n${renderResultDetail(valid.result)}`;
}
