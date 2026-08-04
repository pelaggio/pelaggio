import { BASELINE_TAXONOMY, DEFAULT_SAFETY_PRECEDENCE, DEFAULT_SAFETY_SINK_CLASS, type FindingClassId, isSafetyClass, isWellFormedClassId, safetyClasses, type TaxonomyConfig } from "./taxonomy.js";

export type { FindingClassId, TaxonomyConfig } from "./taxonomy.js";
export { isSafetyClass, safetyClasses, tierOf } from "./taxonomy.js";

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

/**
 * Well-formed class token (#294: was a closed six-safety + judgment union; now an open, grammar-validated
 * string whose tier is resolved from the taxonomy at use sites — default safety). The ADR baseline seats
 * the six safety + named judgment tokens; config may extend the safety floor freely and shrink it only
 * with an owner signature.
 */
export type ReviewFindingClass = FindingClassId;

/**
 * @deprecated Prefer `safetyClasses(taxonomy)`. Kept as the baseline (ADR) safety list in precedence order
 * so tests and importers that iterate the six baseline tokens keep working; the runtime floor consults the
 * resolved taxonomy via `isSafetyClass(id, taxonomy)`.
 */
export const SAFETY_CLASSES: readonly FindingClassId[] = DEFAULT_SAFETY_PRECEDENCE;

/** Wire evidence (schema v3) — no harness-owned `class` or `fingerprint`. */
export interface RawAuthoringReviewFinding extends ReviewFinding {
	ruleId?: string;
	cwe?: string;
	classHint?: ReviewFindingClass;
}

export type DiffPathSignal = "lifecycle-manifest" | "workflow" | "confinement-surface" | "ship-landing" | "dependency-lock" | "secrets-adjacent";

export type ClassificationSignalKind = "fingerprint" | "cwe" | "ruleId" | "path" | "classHint-elevation";

export type ClassificationResult =
	| {
			kind: "matched";
			class: ReviewFindingClass;
			signal: ClassificationSignalKind;
			ruleId: string;
			conflict?: { winner: ReviewFindingClass; losers: readonly ReviewFindingClass[] };
	  }
	| {
			kind: "default-safety";
			class: typeof DEFAULT_SAFETY_SINK_CLASS;
	  };

/** Effective finding after harness classification. */
export interface AuthoringReviewFinding extends ReviewFinding {
	class: ReviewFindingClass;
	classification: ClassificationResult;
	ruleId?: string;
	cwe?: string;
	classHint?: ReviewFindingClass;
}

export interface AuthoringReviewReport {
	schemaVersion: 3;
	summary: string;
	findings: RawAuthoringReviewFinding[];
}

export type ClassificationContext = {
	fingerprint: string;
	changedFiles: readonly string[];
	pathSignals: readonly DiffPathSignal[];
};

export type ClassificationContextBase = {
	changedFiles: readonly string[];
};

export type ClassificationRule =
	| { id: string; signal: "fingerprint"; match: string; class: ReviewFindingClass }
	| { id: string; signal: "cwe"; match: string; class: ReviewFindingClass }
	| { id: string; signal: "ruleId"; match: string; class: ReviewFindingClass }
	| { id: string; signal: "path"; match: DiffPathSignal; class: ReviewFindingClass };

/** Built-in owner-authored rules. #294 may replace this data source without changing the algorithm. */
export const CLASSIFICATION_RULES: readonly ClassificationRule[] = [
	// fingerprint inventory intentionally empty — extension point for stable message fingerprints
	// CWE → security-and-secrets
	{ id: "cwe-78", signal: "cwe", match: "CWE-78", class: "security-and-secrets" },
	{ id: "cwe-79", signal: "cwe", match: "CWE-79", class: "security-and-secrets" },
	{ id: "cwe-89", signal: "cwe", match: "CWE-89", class: "security-and-secrets" },
	{ id: "cwe-22", signal: "cwe", match: "CWE-22", class: "security-and-secrets" },
	{ id: "cwe-798", signal: "cwe", match: "CWE-798", class: "security-and-secrets" },
	{ id: "cwe-502", signal: "cwe", match: "CWE-502", class: "security-and-secrets" },
	{ id: "cwe-918", signal: "cwe", match: "CWE-918", class: "security-and-secrets" },
	// CWE → data-loss/destructive-ops
	{ id: "cwe-404", signal: "cwe", match: "CWE-404", class: "data-loss/destructive-ops" },
	{ id: "cwe-459", signal: "cwe", match: "CWE-459", class: "data-loss/destructive-ops" },
	// exact ruleId → safety
	{ id: "rule-secret-leak", signal: "ruleId", match: "pelaggio/security/secret-leak", class: "security-and-secrets" },
	{ id: "rule-lifecycle-script", signal: "ruleId", match: "pelaggio/supply-chain/lifecycle-script", class: "supply-chain/integrity" },
	{ id: "rule-write-guard", signal: "ruleId", match: "pelaggio/containment/write-guard", class: "containment-escape" },
	{ id: "rule-force-push", signal: "ruleId", match: "pelaggio/git/force-push", class: "irreversible-git/unsafe-landing" },
	// exact ruleId → judgment allowlist (narrow; classHint alone never yields judgment)
	{ id: "rule-judgment-style", signal: "ruleId", match: "pelaggio/judgment/style", class: "judgment" },
	{ id: "rule-judgment-docs", signal: "ruleId", match: "pelaggio/judgment/docs", class: "judgment" },
	{ id: "rule-judgment-maintainability", signal: "ruleId", match: "pelaggio/judgment/maintainability", class: "judgment" },
	// path/diff-shape signals
	{ id: "path-workflow", signal: "path", match: "workflow", class: "security-and-secrets" },
	{ id: "path-lifecycle", signal: "path", match: "lifecycle-manifest", class: "supply-chain/integrity" },
	{ id: "path-dependency-lock", signal: "path", match: "dependency-lock", class: "supply-chain/integrity" },
	{ id: "path-confinement", signal: "path", match: "confinement-surface", class: "containment-escape" },
	{ id: "path-ship-landing", signal: "path", match: "ship-landing", class: "irreversible-git/unsafe-landing" },
	{ id: "path-secrets", signal: "path", match: "secrets-adjacent", class: "security-and-secrets" },
];

export type JudgeRuling = "fixable-blocker" | "unfixable-blocker" | "judgment-dissent";
export interface JudgeReport {
	schemaVersion: 1;
	decisions: Array<{ candidateId: string; decision: ReviewVerificationDecision; rationale: string; class?: ReviewFindingClass; ruling?: JudgeRuling }>;
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

/**
 * Pure path → DiffPathSignal extractor for emission-time classification.
 * Path patterns only; does not scan message prose or full unified diffs.
 */
export function extractDiffPathSignals(path: string | undefined): DiffPathSignal[] {
	if (!path || path.trim() === "") return [];
	const p = path.trim().replace(/^\.\//, "");
	const signals: DiffPathSignal[] = [];
	if (/^\.github\/workflows\//.test(p)) signals.push("workflow");
	if (/(^|\/)package\.json$/.test(p)) signals.push("lifecycle-manifest");
	if (/(^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(p)) signals.push("dependency-lock");
	if (
		/(?:^|\/)(?:step-runner|secret-hygiene|worktree-deps)\.ts$/.test(p) ||
		/packages\/pelaggio\/scripts\/pelaggio\/(?:step-runner|helpers|secret-hygiene|codex-provider)\.ts$/.test(p) ||
		/packages\/pelaggio\/scripts\/pelaggio\/review\/(?:findings|taxonomy)\.ts$/.test(p) ||
		/(?:write-guard|egress|confinement|sandbox)/i.test(p)
	) {
		signals.push("confinement-surface");
	}
	if (/packages\/pelaggio\/scripts\/pelaggio\/ship\//.test(p) || /(?:^|\/)ship\//.test(p)) {
		signals.push("ship-landing");
	}
	if (/packages\/server\/src\/(?:auth|config|app)\.ts$/.test(p) || /(^|\/)\.env(?:\.|$)/.test(p)) {
		signals.push("secrets-adjacent");
	}
	return signals;
}

/**
 * Deterministic emission-time classifier. Safety dominates judgment; unmatched/ambiguous
 * → correctness-regression + default-safety. classHint alone never yields judgment or a
 * specific non-default safety class.
 */
export function classifyAuthoringReviewFinding(raw: RawAuthoringReviewFinding, context: ClassificationContext, taxonomy: TaxonomyConfig = BASELINE_TAXONOMY): ClassificationResult {
	const matches: Array<{ rule: ClassificationRule; class: ReviewFindingClass }> = [];

	for (const rule of CLASSIFICATION_RULES) {
		if (rule.signal === "fingerprint" && context.fingerprint === rule.match) {
			matches.push({ rule, class: rule.class });
		} else if (rule.signal === "cwe" && raw.cwe !== undefined && raw.cwe === rule.match) {
			matches.push({ rule, class: rule.class });
		} else if (rule.signal === "ruleId" && raw.ruleId !== undefined && raw.ruleId === rule.match) {
			matches.push({ rule, class: rule.class });
		} else if (rule.signal === "path" && context.pathSignals.includes(rule.match)) {
			matches.push({ rule, class: rule.class });
		}
	}

	// Tier is resolved from the taxonomy (safety dominates) — not a hard-coded set, so a signed
	// contraction / owner extension shifts these buckets without an algorithm change.
	const safetyMatches = matches.filter((m) => isSafetyClass(m.class, taxonomy));
	const judgmentMatches = matches.filter((m) => !isSafetyClass(m.class, taxonomy));

	if (safetyMatches.length > 0) {
		const classes = [...new Set(safetyMatches.map((m) => m.class))];
		const winner = pickSafetyByPrecedence(classes, taxonomy);
		const winning = safetyMatches.find((m) => m.class === winner) ?? safetyMatches[0];
		const losers = classes.filter((c) => c !== winner);
		return {
			kind: "matched",
			class: winner,
			signal: winning.rule.signal,
			ruleId: winning.rule.id,
			...(losers.length > 0 ? { conflict: { winner, losers } } : {}),
		};
	}

	if (judgmentMatches.length > 0) {
		// Only judgment-tier rules matched. classHint as a safety class elevates (safety dominates).
		if (raw.classHint !== undefined && isSafetyClass(raw.classHint, taxonomy)) {
			return {
				kind: "matched",
				class: raw.classHint,
				signal: "classHint-elevation",
				ruleId: judgmentMatches[0].rule.id,
			};
		}
		return {
			kind: "matched",
			class: "judgment",
			signal: "ruleId",
			ruleId: judgmentMatches[0].rule.id,
		};
	}

	// No unambiguous match (including unknown CWE/ruleId, classHint-only, or empty evidence).
	// The sink class is non-contractible (see NON_CONTRACTIBLE_SINK_CLASSES) so this always resolves safety.
	return { kind: "default-safety", class: DEFAULT_SAFETY_SINK_CLASS };
}

/** Materialize a raw finding into an effective harness-owned finding. */
export function materializeAuthoringFinding(raw: RawAuthoringReviewFinding, base: ClassificationContextBase, taxonomy: TaxonomyConfig = BASELINE_TAXONOMY): AuthoringReviewFinding {
	const fingerprint = reviewFindingFingerprint(raw);
	const pathSignals = extractDiffPathSignals(raw.path);
	const classification = classifyAuthoringReviewFinding(
		raw,
		{
			fingerprint,
			changedFiles: base.changedFiles,
			pathSignals,
		},
		taxonomy,
	);
	return {
		severity: raw.severity,
		message: raw.message,
		...(raw.path !== undefined ? { path: raw.path } : {}),
		...(raw.line !== undefined ? { line: raw.line } : {}),
		...(raw.ruleId !== undefined ? { ruleId: raw.ruleId } : {}),
		...(raw.cwe !== undefined ? { cwe: raw.cwe } : {}),
		...(raw.classHint !== undefined ? { classHint: raw.classHint } : {}),
		class: classification.class,
		classification,
	};
}

function pickSafetyByPrecedence(classes: readonly ReviewFindingClass[], taxonomy: TaxonomyConfig = BASELINE_TAXONOMY): ReviewFindingClass {
	for (const preferred of safetyClasses(taxonomy)) {
		if (classes.includes(preferred)) return preferred;
	}
	return DEFAULT_SAFETY_SINK_CLASS;
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
const JUDGE_RULINGS: readonly JudgeRuling[] = ["fixable-blocker", "unfixable-blocker", "judgment-dissent"];
const CWE_RE = /^CWE-\d{1,5}$/i;

// The verbatim schema-example placeholder printed in `.claude/skills/pr-review/SKILL.md`
// (the `AUTHORING_REVIEW_FINDINGS` example block). A seat that echoes the example instead of
// reviewing would emit a schema-valid `must-fix / correctness-regression` at `src/file.ts:1`,
// manufacturing a cross-model split and a spurious escalation/park. Reject it fail-closed so the
// seat is recorded as not-completed rather than as a fabricated blocker. Provider-agnostic: any
// seat that parrots the example is rejected.
//
// This guard was originally attributed to the codex seat being "a weaker instruction-follower"
// that runs one turn and does no inspection. That diagnosis was wrong. The codex seat performs a
// full review; its first tool call is typically `sed .claude/skills/pr-review/SKILL.md`, and the
// codex provider folds command OUTPUT into `fullText` — so the example block printed by that
// `sed` entered the parsed text ahead of the model's real block and tripped this guard on every
// run. The parse source is now the final assistant message (see selectAuthoringFindingsSource).
const EXAMPLE_SUMMARY = "Concise single-line summary.";
const EXAMPLE_FINDING_MESSAGE = "Concrete single-line finding.";
const EXAMPLE_FINDING_PATH = "src/file.ts";

/** Works on raw or classified findings — only message/path/line are compared. */
function isSchemaExampleFinding(finding: Pick<ReviewFinding, "message" | "path" | "line">): boolean {
	return finding.message === EXAMPLE_FINDING_MESSAGE && finding.path === EXAMPLE_FINDING_PATH && finding.line === 1;
}

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

/** Normalize CWE identifiers: `cwe-079` / `CWE-79` → `CWE-79` (strip leading zeros). */
export function normalizeCwe(value: string): string | null {
	const trimmed = value.trim();
	const match = trimmed.match(/^CWE-0*(\d{1,5})$/i);
	if (!match) return null;
	const numeric = String(Number(match[1]));
	if (numeric === "NaN" || match[1] === "") return null;
	return `CWE-${numeric}`;
}

function parseRawAuthoringFinding(value: unknown, index: number): RawAuthoringReviewFinding {
	if (!isRecord(value)) throw new ReviewFindingsParseError(`review finding ${index + 1} must be a JSON object`);
	// Wire contract: no `class` or `fingerprint` — harness owns both.
	assertKeys(value, ["severity", "message", "path", "line", "ruleId", "cwe", "classHint"], ["severity", "message"], `review finding ${index + 1}`);
	const finding = parseFindingFields(value, index);
	const raw: RawAuthoringReviewFinding = { ...finding };
	if (value.ruleId !== undefined) {
		if (typeof value.ruleId !== "string") throw new ReviewFindingsParseError(`review finding ${index + 1} ruleId must be a string`);
		const ruleId = value.ruleId.trim();
		if (ruleId === "" || /[\r\n]/.test(value.ruleId)) throw new ReviewFindingsParseError(`review finding ${index + 1} ruleId must be a non-empty single-line string`);
		raw.ruleId = ruleId;
	}
	if (value.cwe !== undefined) {
		if (typeof value.cwe !== "string") throw new ReviewFindingsParseError(`review finding ${index + 1} cwe must be a string`);
		if (!CWE_RE.test(value.cwe.trim()) && normalizeCwe(value.cwe) === null) {
			throw new ReviewFindingsParseError(`review finding ${index + 1} cwe must match CWE-<digits>`);
		}
		const normalized = normalizeCwe(value.cwe);
		if (normalized === null) throw new ReviewFindingsParseError(`review finding ${index + 1} cwe must match CWE-<digits>`);
		raw.cwe = normalized;
	}
	if (value.classHint !== undefined) {
		// #294: open the wire to any well-formed class id (unknown ids resolve to safety at use sites).
		// A free-form judgment hint still never yields judgment tier — #293 emission rules require a
		// positive allowlist match, unchanged.
		if (typeof value.classHint !== "string" || !isWellFormedClassId(value.classHint)) {
			throw new ReviewFindingsParseError(`review finding ${index + 1} has an invalid classHint`);
		}
		raw.classHint = value.classHint;
	}
	return raw;
}

/** True when `text` contains at least one well-formed findings block. */
export function hasAuthoringReviewFindingsBlock(text: string): boolean {
	// AUTHORING_RE is /g and therefore stateful; `matchAll` does not mutate lastIndex.
	return [...text.matchAll(AUTHORING_RE)].length > 0;
}

/**
 * Choose which of a seat's outputs to parse findings from.
 *
 * The final assistant message is authoritative: the skill mandates ending with exactly the v3
 * block. The full transcript is NOT interchangeable — for the codex provider `fullText` includes
 * command *output*, so any file a reviewer reads can inject blocks into the parse. Reading
 * `.claude/skills/pr-review/SKILL.md`, which the reviewer does first and which contains the schema
 * example, deterministically poisoned every codex seat. Treating tool output as a findings source
 * is also an injection surface: a reviewed repo could plant a block in a file and manufacture
 * findings it never earned.
 *
 * The transcript is still the fallback when the final message carries no block at all — an
 * incomplete seat (max-turns, provider error) may have emitted findings mid-run, and dropping a
 * security must-fix from such a seat would be a fail-open (see the ingestion comment in loop.ts).
 */
export function selectAuthoringFindingsSource(text: string | undefined, fullText: string | undefined): string {
	if (text && hasAuthoringReviewFindingsBlock(text)) return text;
	return fullText ?? text ?? "";
}

/**
 * Parse schema-v3 authoring review findings. Returns raw evidence only — the harness
 * assigns effective class via {@link classifyAuthoringReviewFinding} / {@link materializeAuthoringFinding}.
 * Multiple blocks are unioned (#280); mixed/old schemas fail closed.
 */
export function parseAuthoringReviewFindings(text: string): AuthoringReviewReport {
	const matches = [...text.matchAll(AUTHORING_RE)];
	if (matches.length === 0) throw new ReviewFindingsParseError("authoring review findings block not found");
	let summary: string | undefined;
	const findings: RawAuthoringReviewFinding[] = [];
	matches.forEach((match, block) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(match[1]);
		} catch (error) {
			throw new ReviewFindingsParseError(`authoring review findings block ${block + 1} is not valid JSON`, { cause: error });
		}
		if (!isRecord(parsed)) throw new ReviewFindingsParseError(`authoring review findings block ${block + 1} must be a JSON object`);
		assertKeys(parsed, ["schemaVersion", "summary", "findings"], ["schemaVersion", "summary", "findings"], "authoring review findings");
		if (parsed.schemaVersion !== 3) throw new ReviewFindingsParseError("unsupported authoring review schemaVersion");
		if (!Array.isArray(parsed.findings)) throw new ReviewFindingsParseError("authoring review findings must be an array");
		if (summary === undefined) summary = parseSingleLine(parsed.summary, "summary");
		for (const [index, value] of parsed.findings.entries()) {
			findings.push(parseRawAuthoringFinding(value, index));
		}
	});
	// Fail closed on the parroted schema example (see EXAMPLE_* above). The seat did not review;
	// treat it as an incomplete seat, not a real blocker. Trip on either the example summary or any
	// example finding — a real review never emits these exact placeholder strings, so this cannot
	// false-positive, and it also catches a fake-clean echo (example summary, empty findings). The v3
	// example keeps these same sentinel strings, so the guard covers #293's evidence schema too.
	if (summary?.trim() === EXAMPLE_SUMMARY || findings.some(isSchemaExampleFinding)) {
		throw new ReviewFindingsParseError("authoring review findings echo the schema example verbatim (the seat did not review the diff)");
	}
	return { schemaVersion: 3, summary: summary ?? "", findings };
}

export function parseJudgeReport(text: string): JudgeReport {
	const parsed = parseDelimited(text, JUDGE_RE, "authoring review Judge");
	assertKeys(parsed, ["schemaVersion", "decisions"], ["schemaVersion", "decisions"], "authoring review Judge report");
	if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.decisions)) throw new ReviewFindingsParseError("invalid authoring review Judge schema");
	return {
		schemaVersion: 1,
		decisions: parsed.decisions.map((value, index) => {
			if (!isRecord(value)) throw new ReviewFindingsParseError(`Judge decision ${index + 1} must be an object`);
			// #280: `class` is optional — candidate already carries harness-owned effective class.
			// When present it is validated; loop.ts blocks a safety→non-safety downgrade (#272).
			assertKeys(value, ["candidateId", "decision", "rationale", "class", "ruling"], ["candidateId", "decision", "rationale"], `Judge decision ${index + 1}`);
			const { class: _class, ruling: _ruling, ...verification } = value;
			const base = parseVerificationDecision(verification, index);
			if (value.class !== undefined && (typeof value.class !== "string" || !isWellFormedClassId(value.class))) throw new ReviewFindingsParseError(`Judge decision ${index + 1} has an invalid class`);
			if (value.ruling !== undefined && !JUDGE_RULINGS.includes(value.ruling as JudgeRuling)) throw new ReviewFindingsParseError(`Judge decision ${index + 1} has an invalid ruling`);
			if (value.ruling === "judgment-dissent" && value.class !== undefined && value.class !== "judgment") throw new ReviewFindingsParseError("judgment-dissent is only valid for judgment findings");
			if (base.decision === "survives" && value.ruling === undefined) throw new ReviewFindingsParseError(`surviving Judge decision ${base.candidateId} requires a ruling`);
			return { ...base, ...(value.class !== undefined ? { class: value.class as ReviewFindingClass } : {}), ...(value.ruling ? { ruling: value.ruling as JudgeRuling } : {}) };
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

export function reviewFindingsGate(report: Pick<ReviewFindingsReport, "findings">): "pass" | "block" {
	return report.findings.some((finding) => finding.severity === "must-fix") ? "block" : "pass";
}

function parseFindingFields(value: Record<string, unknown>, index: number): ReviewFinding {
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

function parseFinding(value: unknown, index: number): ReviewFinding {
	if (!isRecord(value)) throw new ReviewFindingsParseError(`review finding ${index + 1} must be a JSON object`);
	assertKeys(value, ["severity", "message", "path", "line"], ["severity", "message"], `review finding ${index + 1}`);
	return parseFindingFields(value, index);
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
