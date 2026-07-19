export type ReviewFindingSeverity = "must-fix" | "nice" | "note";

export interface ReviewFinding {
	severity: ReviewFindingSeverity;
	message: string;
	path?: string;
	line?: number;
}

export interface ReviewFindingsReport {
	schemaVersion: 1;
	summary: string;
	findings: ReviewFinding[];
}

export type ReviewFindingClass = "security" | "data-loss" | "correctness-regression" | "judgment";
export interface AuthoringReviewFinding extends ReviewFinding {
	class: ReviewFindingClass;
}
export interface AuthoringReviewReport {
	schemaVersion: 2;
	summary: string;
	findings: AuthoringReviewFinding[];
}
export type JudgeRuling = "fixable-blocker" | "unfixable-blocker" | "judgment-dissent";
export interface JudgeReport {
	schemaVersion: 1;
	decisions: Array<{ candidateId: string; decision: ReviewVerificationDecision; rationale: string; class: ReviewFindingClass; ruling?: JudgeRuling }>;
}

export type ReviewVerificationDecision = "refuted" | "survives";

export interface ReviewVerificationReport {
	schemaVersion: 1;
	decisions: Array<{
		candidateId: string;
		decision: ReviewVerificationDecision;
		rationale: string;
	}>;
}

export interface VerificationCandidate {
	id: string;
	finding: ReviewFinding;
}

export interface VerificationDisposition extends VerificationCandidate {
	decision: ReviewVerificationDecision;
	rationale: string;
}

export type ReviewExhaustionReason = "max-passes" | "budget" | "diminishing-returns" | "invalid-pass" | "provider-diversity";

export interface ReviewPassSummary {
	valid: boolean;
	dispositions: readonly VerificationDisposition[];
	cost: number;
	diagnostic?: string;
}

export type ReviewConvergenceResult =
	| { state: "converged"; survivors: ReadonlyMap<string, ReviewFinding> }
	| { state: "continue"; survivors: ReadonlyMap<string, ReviewFinding> }
	| { state: "exhausted"; reason: ReviewExhaustionReason; survivors: ReadonlyMap<string, ReviewFinding> };

/** Identity owned by deterministic orchestration, not the per-pass candidate ID. */
export function reviewFindingFingerprint(finding: ReviewFinding): string {
	return JSON.stringify([finding.message.trim().replace(/\s+/g, " "), finding.path?.trim() ?? "", finding.line ?? 0]);
}

/** Apply a complete verifier report to carried blockers. Omission never refutes. */
export function applyReviewPass(carried: ReadonlyMap<string, ReviewFinding>, summary: ReviewPassSummary): ReadonlyMap<string, ReviewFinding> {
	const next = new Map(carried);
	if (!summary.valid) return next;
	const decisions = new Map<string, VerificationDisposition[]>();
	for (const disposition of summary.dispositions) {
		const fingerprint = reviewFindingFingerprint(disposition.finding);
		const grouped = decisions.get(fingerprint) ?? [];
		grouped.push(disposition);
		decisions.set(fingerprint, grouped);
	}
	for (const [fingerprint, grouped] of decisions) {
		const surviving = grouped.find((item) => item.decision === "survives");
		if (surviving) next.set(fingerprint, surviving.finding);
		else next.delete(fingerprint);
	}
	return next;
}

export function evaluateReviewConvergence(options: { carried: ReadonlyMap<string, ReviewFinding>; summary: ReviewPassSummary; previousSurvivorCount?: number; hasNextPass: boolean; nextPassAffordable: boolean }): ReviewConvergenceResult {
	const survivors = new Map(applyReviewPass(options.carried, options.summary));
	if (!options.summary.valid) {
		for (const disposition of options.summary.dispositions) survivors.set(reviewFindingFingerprint(disposition.finding), disposition.finding);
		return { state: "exhausted", reason: "invalid-pass", survivors };
	}
	if (survivors.size === 0) return { state: "converged", survivors };
	if (!options.hasNextPass) return { state: "exhausted", reason: "max-passes", survivors };
	if (!options.nextPassAffordable) return { state: "exhausted", reason: "budget", survivors };
	if (options.previousSurvivorCount !== undefined && survivors.size >= options.previousSurvivorCount) {
		return { state: "exhausted", reason: "diminishing-returns", survivors };
	}
	return { state: "continue", survivors };
}

export class ReviewFindingsParseError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ReviewFindingsParseError";
	}
}

const REPORT_RE = /(?:^|\n)REVIEW_FINDINGS[ \t]*\n([\s\S]*?)\nEND_REVIEW_FINDINGS(?=\n|$)/g;
const VERIFICATION_RE = /(?:^|\n)REVIEW_VERIFICATION[ \t]*\n([\s\S]*?)\nEND_REVIEW_VERIFICATION(?=\n|$)/g;
const AUTHORING_RE = /(?:^|\n)AUTHORING_REVIEW_FINDINGS[ \t]*\n([\s\S]*?)\nEND_AUTHORING_REVIEW_FINDINGS(?=\n|$)/g;
const JUDGE_RE = /(?:^|\n)AUTHORING_REVIEW_JUDGE[ \t]*\n([\s\S]*?)\nEND_AUTHORING_REVIEW_JUDGE(?=\n|$)/g;
const SEVERITIES: readonly ReviewFindingSeverity[] = ["must-fix", "nice", "note"];
const VERIFICATION_DECISIONS: readonly ReviewVerificationDecision[] = ["refuted", "survives"];
const CANDIDATE_ID_RE = /^C[1-9]\d*$/;
const FINDING_CLASSES: readonly ReviewFindingClass[] = ["security", "data-loss", "correctness-regression", "judgment"];
const JUDGE_RULINGS: readonly JudgeRuling[] = ["fixable-blocker", "unfixable-blocker", "judgment-dissent"];

function parseDelimited(text: string, regex: RegExp, label: string): Record<string, unknown> {
	const matches = [...text.matchAll(regex)];
	if (matches.length !== 1) throw new ReviewFindingsParseError(matches.length === 0 ? `${label} block not found` : `multiple ${label} blocks found`);
	try {
		const value: unknown = JSON.parse(matches[0][1]);
		if (!isRecord(value)) throw new ReviewFindingsParseError(`${label} must be a JSON object`);
		return value;
	} catch (error) {
		if (error instanceof ReviewFindingsParseError) throw error;
		throw new ReviewFindingsParseError(`${label} block is not valid JSON`, { cause: error });
	}
}

export function parseAuthoringReviewFindings(text: string): AuthoringReviewReport {
	const parsed = parseDelimited(text, AUTHORING_RE, "authoring review findings");
	assertKeys(parsed, ["schemaVersion", "summary", "findings"], ["schemaVersion", "summary", "findings"], "authoring review findings");
	if (parsed.schemaVersion !== 2) throw new ReviewFindingsParseError("unsupported authoring review schemaVersion");
	if (!Array.isArray(parsed.findings)) throw new ReviewFindingsParseError("authoring review findings must be an array");
	return {
		schemaVersion: 2,
		summary: parseSingleLine(parsed.summary, "summary"),
		findings: parsed.findings.map((value, index) => {
			if (!isRecord(value) || !FINDING_CLASSES.includes(value.class as ReviewFindingClass)) throw new ReviewFindingsParseError(`review finding ${index + 1} has an invalid class`);
			const { class: _class, ...v1 } = value;
			const finding = parseFinding(v1, index);
			return { ...finding, class: value.class as ReviewFindingClass };
		}),
	};
}

export function parseJudgeReport(text: string): JudgeReport {
	const parsed = parseDelimited(text, JUDGE_RE, "authoring review Judge");
	assertKeys(parsed, ["schemaVersion", "decisions"], ["schemaVersion", "decisions"], "authoring review Judge report");
	if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.decisions)) throw new ReviewFindingsParseError("invalid authoring review Judge schema");
	return {
		schemaVersion: 1,
		decisions: parsed.decisions.map((value, index) => {
			if (!isRecord(value)) throw new ReviewFindingsParseError(`Judge decision ${index + 1} must be an object`);
			assertKeys(value, ["candidateId", "decision", "rationale", "class", "ruling"], ["candidateId", "decision", "rationale", "class"], `Judge decision ${index + 1}`);
			const { class: _class, ruling: _ruling, ...verification } = value;
			const base = parseVerificationDecision(verification, index);
			if (!FINDING_CLASSES.includes(value.class as ReviewFindingClass)) throw new ReviewFindingsParseError(`Judge decision ${index + 1} has an invalid class`);
			if (value.ruling !== undefined && !JUDGE_RULINGS.includes(value.ruling as JudgeRuling)) throw new ReviewFindingsParseError(`Judge decision ${index + 1} has an invalid ruling`);
			if (value.ruling === "judgment-dissent" && value.class !== "judgment") throw new ReviewFindingsParseError("judgment-dissent is only valid for judgment findings");
			if (base.decision === "survives" && value.ruling === undefined) throw new ReviewFindingsParseError(`surviving Judge decision ${base.candidateId} requires a ruling`);
			return { ...base, class: value.class as ReviewFindingClass, ...(value.ruling ? { ruling: value.ruling as JudgeRuling } : {}) };
		}),
	};
}

export function parseReviewFindings(text: string): ReviewFindingsReport {
	const matches = [...text.matchAll(REPORT_RE)];
	if (matches.length === 0) throw new ReviewFindingsParseError("review findings block not found");
	if (matches.length !== 1) throw new ReviewFindingsParseError("multiple review findings blocks found");

	let parsed: unknown;
	try {
		parsed = JSON.parse(matches[0][1]);
	} catch (error) {
		throw new ReviewFindingsParseError("review findings block is not valid JSON", { cause: error });
	}
	if (!isRecord(parsed)) throw new ReviewFindingsParseError("review findings report must be a JSON object");
	assertKeys(parsed, ["schemaVersion", "summary", "findings"], ["schemaVersion", "summary", "findings"], "review findings report");
	if (parsed.schemaVersion !== 1) throw new ReviewFindingsParseError("unsupported review findings schemaVersion");
	const summary = parseSingleLine(parsed.summary, "summary");
	if (!Array.isArray(parsed.findings)) throw new ReviewFindingsParseError("review findings must be an array");

	return {
		schemaVersion: 1,
		summary,
		findings: parsed.findings.map(parseFinding),
	};
}

export function parseReviewVerification(text: string): ReviewVerificationReport {
	const matches = [...text.matchAll(VERIFICATION_RE)];
	if (matches.length === 0) throw new ReviewFindingsParseError("review verification block not found");
	if (matches.length !== 1) throw new ReviewFindingsParseError("multiple review verification blocks found");

	let parsed: unknown;
	try {
		parsed = JSON.parse(matches[0][1]);
	} catch (error) {
		throw new ReviewFindingsParseError("review verification block is not valid JSON", { cause: error });
	}
	if (!isRecord(parsed)) throw new ReviewFindingsParseError("review verification report must be a JSON object");
	assertKeys(parsed, ["schemaVersion", "decisions"], ["schemaVersion", "decisions"], "review verification report");
	if (parsed.schemaVersion !== 1) throw new ReviewFindingsParseError("unsupported review verification schemaVersion");
	if (!Array.isArray(parsed.decisions)) throw new ReviewFindingsParseError("review verification decisions must be an array");

	return {
		schemaVersion: 1,
		decisions: parsed.decisions.map((value, index) => parseVerificationDecision(value, index)),
	};
}

export function reconcileReviewVerification(candidates: readonly VerificationCandidate[], report: ReviewVerificationReport): VerificationDisposition[] {
	const originals = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	if (originals.size !== candidates.length) throw new ReviewFindingsParseError("verification candidates contain duplicate IDs");
	const decisions = new Map<string, ReviewVerificationReport["decisions"][number]>();
	for (const decision of report.decisions) {
		if (decisions.has(decision.candidateId)) throw new ReviewFindingsParseError(`duplicate verification decision for ${decision.candidateId}`);
		if (!originals.has(decision.candidateId)) throw new ReviewFindingsParseError(`unknown verification candidate: ${decision.candidateId}`);
		decisions.set(decision.candidateId, decision);
	}
	const missing = candidates.find((candidate) => !decisions.has(candidate.id));
	if (missing) throw new ReviewFindingsParseError(`missing verification decision for ${missing.id}`);
	return candidates.map((candidate) => {
		const decision = decisions.get(candidate.id);
		if (!decision) throw new ReviewFindingsParseError(`missing verification decision for ${candidate.id}`);
		return { ...candidate, decision: decision.decision, rationale: decision.rationale };
	});
}

export function reviewFindingsGate(report: ReviewFindingsReport): "pass" | "block" {
	return report.findings.some((finding) => finding.severity === "must-fix") ? "block" : "pass";
}

function parseFinding(value: unknown, index: number): ReviewFinding {
	if (!isRecord(value)) throw new ReviewFindingsParseError(`review finding ${index + 1} must be a JSON object`);
	assertKeys(value, ["severity", "message", "path", "line"], ["severity", "message"], `review finding ${index + 1}`);
	if (!SEVERITIES.includes(value.severity as ReviewFindingSeverity)) throw new ReviewFindingsParseError(`review finding ${index + 1} has an invalid severity`);
	const finding: ReviewFinding = {
		severity: value.severity as ReviewFindingSeverity,
		message: parseSingleLine(value.message, `review finding ${index + 1} message`),
	};
	if (value.path !== undefined) finding.path = parseSingleLine(value.path, `review finding ${index + 1} path`);
	if (value.line !== undefined) {
		if (finding.path === undefined) throw new ReviewFindingsParseError(`review finding ${index + 1} line requires path`);
		if (!Number.isInteger(value.line) || (value.line as number) <= 0) throw new ReviewFindingsParseError(`review finding ${index + 1} line must be a positive integer`);
		finding.line = value.line as number;
	}
	return finding;
}

function parseVerificationDecision(value: unknown, index: number): ReviewVerificationReport["decisions"][number] {
	if (!isRecord(value)) throw new ReviewFindingsParseError(`review verification decision ${index + 1} must be a JSON object`);
	assertKeys(value, ["candidateId", "decision", "rationale"], ["candidateId", "decision", "rationale"], `review verification decision ${index + 1}`);
	const candidateId = parseSingleLine(value.candidateId, `review verification decision ${index + 1} candidateId`);
	if (!CANDIDATE_ID_RE.test(candidateId)) throw new ReviewFindingsParseError(`review verification decision ${index + 1} has an invalid candidateId`);
	if (!VERIFICATION_DECISIONS.includes(value.decision as ReviewVerificationDecision)) throw new ReviewFindingsParseError(`review verification decision ${index + 1} has an invalid decision`);
	return {
		candidateId,
		decision: value.decision as ReviewVerificationDecision,
		rationale: parseSingleLine(value.rationale, `review verification decision ${index + 1} rationale`),
	};
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
	const unknown = Object.keys(value).find((key) => !allowed.includes(key));
	if (unknown) throw new ReviewFindingsParseError(`${label} contains unknown key: ${unknown}`);
	const missing = required.find((key) => !(key in value));
	if (missing) throw new ReviewFindingsParseError(`${label} is missing ${missing}`);
}

function parseSingleLine(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new ReviewFindingsParseError(`${label} must be a non-empty string`);
	if (/[\r\n]/.test(value)) throw new ReviewFindingsParseError(`${label} must be a single line`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
