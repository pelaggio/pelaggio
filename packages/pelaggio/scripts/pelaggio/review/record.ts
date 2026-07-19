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
	return `## Adversarial review record\n\nThis is an unbound review record, not a cryptographic attestation.\n\n- Outcome: **${valid.result.outcome}**\n- Diversity: **${valid.result.diversity.state}**${valid.result.diversity.state === "softened" ? ` — ${valid.result.diversity.explanation}` : ""}\n- Cost: $${valid.result.cost.toFixed(2)}\n\n| Pass | Reviewers | Judge | Carried blockers |\n| --- | --- | --- | --- |\n${rows || "| — | — | — | — |"}${valid.result.dissent ? `\n\nDissent: ${valid.result.dissent.finding.finding.message}\n\nJudge ruling: ${valid.result.dissent.ruling}. Attempted resolution: ${valid.result.dissent.attemptedResolution}. Notification target: ${valid.result.dissent.notificationTarget}.` : ""}`;
}
