import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReviewLoopResult } from "./loop.js";

export interface ReviewRecord {
	schemaVersion: 1;
	runId: string;
	itemId: string;
	createdAt: string;
	blockingBar: "must-fix";
	result: ReviewLoopResult;
	escalation?: { id: string; status: "active" | "resolved-proceed" | "resolved-block"; actor?: string; rationale?: string };
}

export function validateReviewRecord(value: ReviewRecord): ReviewRecord {
	if (value.schemaVersion !== 1 || !value.runId || !value.itemId || value.blockingBar !== "must-fix") throw new Error("invalid review record");
	if (Number.isNaN(Date.parse(value.createdAt))) throw new Error("invalid review record timestamp");
	return value;
}

export function writeReviewRecord(root: string, record: ReviewRecord): string {
	const valid = validateReviewRecord(record);
	const path = join(root, ".dev", "review-records", `${valid.runId}.json`);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
	return path;
}

export function renderReviewRecord(record: ReviewRecord): string {
	const valid = validateReviewRecord(record);
	const rows = valid.result.passes.map((pass) => `| ${pass.pass} | ${pass.reviewers.filter((seat) => seat.ok).length}/${pass.reviewers.length} | ${pass.judge.valid ? "valid" : "invalid"} | ${pass.carriedAfter.length} |`).join("\n");
	// Surface the captured seat/judge `diagnostic` strings (why a seat or the judge did not complete)
	// so a hard-block — especially a 0-reviewer-seats-ok one — explains itself instead of a bare table (#268).
	const diagnostics = valid.result.passes
		.flatMap((pass) => [
			...pass.reviewers.filter((seat) => seat.diagnostic).map((seat) => `- pass ${pass.pass} ${seat.identity.provider}/${seat.identity.seatId} (${seat.turns}t): ${seat.diagnostic}`),
			...(pass.judge.diagnostic && !pass.judge.valid ? [`- pass ${pass.pass} judge: ${pass.judge.diagnostic}`] : []),
		])
		.join("\n");
	const diagnosticsSection = diagnostics ? `\n\nSeat diagnostics (why a seat or the judge did not complete):\n\n${diagnostics}` : "";
	const disagreement = valid.result.disagreement
		? `\n\nCross-model split (evidence \`${valid.result.disagreement.evidenceFingerprint}\`):\n\n${valid.result.disagreement.drivers.map((driver) => `- ${driver.identity.provider}/${driver.identity.seatId}: **${driver.verdict}** — ${driver.rationale}`).join("\n")}`
		: "";
	const escalation = valid.escalation
		? `\n\nDecision **${valid.escalation.id}**: **${valid.escalation.status}**${valid.escalation.actor ? ` by ${valid.escalation.actor}` : ""}${valid.escalation.rationale ? ` — ${valid.escalation.rationale}` : ""}.`
		: "";
	return `## Adversarial review record\n\nThis is an unbound review record, not a cryptographic attestation.\n\n- Outcome: **${valid.result.outcome}**\n- Diversity: **${valid.result.diversity.state}**${valid.result.diversity.state === "softened" ? ` — ${valid.result.diversity.explanation}` : ""}\n- Cost: $${valid.result.cost.toFixed(2)}\n\n| Pass | Reviewers | Judge | Carried blockers |\n| --- | --- | --- | --- |\n${rows || "| — | — | — | — |"}${diagnosticsSection}${valid.result.dissent ? `\n\nDissent: ${valid.result.dissent.finding.finding.message}\n\nJudge ruling: ${valid.result.dissent.ruling}. Attempted resolution: ${valid.result.dissent.attemptedResolution}. Notification target: ${valid.result.dissent.notificationTarget}.` : ""}${disagreement}${escalation}`;
}
