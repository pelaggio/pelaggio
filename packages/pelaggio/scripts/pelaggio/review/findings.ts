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

export class ReviewFindingsParseError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ReviewFindingsParseError";
	}
}

const REPORT_RE = /(?:^|\n)REVIEW_FINDINGS[ \t]*\n([\s\S]*?)\nEND_REVIEW_FINDINGS(?=\n|$)/g;
const SEVERITIES: readonly ReviewFindingSeverity[] = ["must-fix", "nice", "note"];

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
