/**
 * Shadow disposition over assessment records — the "first implementation" that
 * `docs/assurance/assessment-experiment.md` prescribes: compute a disposition and stop, touching no
 * real gate.
 *
 * The split is the point. A worker authors only `Assessment { proposition, basis, conclusion,
 * residual }`; everything that decides the disposition — current SHA, which observations exist and
 * are available, which surfaces were required, which blockers are carried — is a `HarnessFacts`
 * value the worker cannot write. Rationale text, summaries, confidence fields, and unknown
 * extensions are read nowhere in this file, so they cannot move the answer.
 */

export type Verdict = "holds" | "violated" | "undetermined";
export type Consequence = "reversible" | "consequential";
export type Disposition = "continue" | "gather-evidence" | "retry-escalate" | "withhold" | "commit";

export interface Residual {
	statement: string;
	/** Observation id whose availability resolves the condition. Absent = only a principal can. */
	resolvedBy?: string;
}

export interface Assessment {
	proposition: string;
	basis: string[];
	conclusion: { verdict: Verdict; rationale?: string };
	residual?: Residual[];
}

/** Harness-owned envelope. A worker never writes any of this. */
export interface AssessmentRecord {
	id: string;
	binding: { subject: string; sha: string };
	provenance: { runId: string; step: string; attempt: number; seat: string; provider: string };
	completeness: { covered: string[] };
	assessment: Assessment;
	/** Lossy human/model presentation. Never consulted by disposition. */
	summary?: string;
}

export interface Observation {
	id: string;
	sha: string;
	/** `false` = known to exist but not yet acquired (an evidence-recovery opportunity). */
	available: boolean;
}

export interface CarriedBlocker {
	id: string;
	proposition: string;
	/** Record id of an explicit refutation; the harness has already judged carry validity (#495). */
	refutedBy?: string;
}

export interface HarnessFacts {
	subject: string;
	currentSha: string;
	requiredSurfaces: string[];
	observations: Observation[];
	carriedBlockers: CarriedBlocker[];
}

export interface Policy {
	consequence: Consequence;
	onContradiction: "withhold" | "retry-escalate";
}

export interface ShadowResult {
	disposition: Disposition;
	/** Typed causes, in the spirit of ADR-0026's per-cell causes; the prose is derivable from these. */
	causes: string[];
	/** Extension keys seen and ignored — retained as unsupported, never consumed. */
	unsupported: string[];
}

const KNOWN_ASSESSMENT_KEYS = new Set(["proposition", "basis", "conclusion", "residual"]);

interface Classified {
	record: AssessmentRecord;
	current: boolean;
	basisValid: boolean;
	complete: boolean;
	openResiduals: Residual[];
	recoverableResiduals: Residual[];
	resolvedResiduals: Residual[];
}

function classify(record: AssessmentRecord, facts: HarnessFacts, unsupported: string[]): Classified {
	for (const key of Object.keys(record.assessment)) if (!KNOWN_ASSESSMENT_KEYS.has(key)) unsupported.push(`${record.id}:${key}`);
	const byId = new Map(facts.observations.map((o) => [o.id, o]));
	const currentAvailable = (id: string): boolean => {
		const o = byId.get(id);
		return Boolean(o?.available && o.sha === facts.currentSha);
	};
	const current = record.binding.sha === facts.currentSha && record.binding.subject === facts.subject;
	const basisValid = record.assessment.basis.length > 0 && record.assessment.basis.every(currentAvailable);
	const covered = new Set(record.completeness.covered);
	const complete = facts.requiredSurfaces.every((s) => covered.has(s));
	const openResiduals: Residual[] = [];
	const recoverableResiduals: Residual[] = [];
	const resolvedResiduals: Residual[] = [];
	for (const residual of record.assessment.residual ?? []) {
		if (!residual.resolvedBy) openResiduals.push(residual);
		else if (currentAvailable(residual.resolvedBy)) resolvedResiduals.push(residual);
		else if (byId.has(residual.resolvedBy)) recoverableResiduals.push(residual);
		else openResiduals.push(residual);
	}
	return { record, current, basisValid, complete, openResiduals, recoverableResiduals, resolvedResiduals };
}

/**
 * Deterministic shadow disposition. Reads only typed fields of the records plus harness facts and
 * explicit policy — never rationale, summary, confidence, or extension content.
 */
export function shadowDisposition(records: AssessmentRecord[], facts: HarnessFacts, policy: Policy): ShadowResult {
	const causes: string[] = [];
	const unsupported: string[] = [];
	const classified = records.map((r) => classify(r, facts, unsupported));
	const recordById = new Map(classified.map((c) => [c.record.id, c]));

	// Positive evidence: current, valid basis, complete, verdict holds, no residual left in any state.
	// A resolved residual means the condition the assessor named has since been observed; the record
	// needs reassessment rather than silently counting for either side.
	const positive: Classified[] = [];
	const caution: Classified[] = [];
	let recoverable = false;

	// A record about a carried blocker's own proposition is a refutation candidate, not evidence
	// about the subject: "the blocker claim is violated" is the good case, judged below.
	const blockerPropositions = new Set(facts.carriedBlockers.map((b) => b.proposition));

	for (const c of classified) {
		const id = c.record.id;
		if (blockerPropositions.has(c.record.assessment.proposition)) continue;
		if (!c.current) {
			causes.push(`stale-binding:${id}`);
			recoverable = true;
			continue;
		}
		if (c.resolvedResiduals.length > 0) {
			causes.push(`residual-resolved-needs-reassessment:${id}`);
			recoverable = true;
			continue;
		}
		const verdict = c.record.assessment.conclusion.verdict;
		if (!c.basisValid) {
			causes.push(`unresolved-basis:${id}`);
			recoverable = true;
			// Caution survives a weak basis; positive authority does not.
			if (verdict === "violated") caution.push(c);
			continue;
		}
		if (!c.complete) {
			causes.push(`incomplete:${id}`);
			recoverable = true;
			if (verdict === "violated") caution.push(c);
			continue;
		}
		if (c.recoverableResiduals.length > 0) {
			causes.push(`residual-recoverable:${id}`);
			recoverable = true;
			if (verdict === "violated") caution.push(c);
			continue;
		}
		if (c.openResiduals.length > 0) {
			causes.push(`residual-open:${id}`);
			caution.push(c);
			continue;
		}
		if (verdict === "holds") positive.push(c);
		else if (verdict === "violated") caution.push(c);
		else {
			causes.push(`undetermined:${id}`);
			caution.push(c);
		}
	}

	// Carried blockers survive silence. Only an explicit, current, valid, complete refutation clears one.
	let blockerSurvives = false;
	for (const blocker of facts.carriedBlockers) {
		const refutation = blocker.refutedBy ? recordById.get(blocker.refutedBy) : undefined;
		const refuted =
			refutation !== undefined &&
			refutation.record.assessment.proposition === blocker.proposition &&
			refutation.record.assessment.conclusion.verdict === "violated" &&
			refutation.basisValid &&
			refutation.complete &&
			refutation.openResiduals.length === 0 &&
			refutation.recoverableResiduals.length === 0;
		if (!refuted) {
			causes.push(`carried-blocker:${blocker.id}`);
			blockerSurvives = true;
		}
	}

	// Contradiction between valid records on one proposition is an explicit policy state.
	const contradicted = new Set<string>();
	for (const p of positive) {
		if (caution.some((c) => c.basisValid && c.complete && c.record.assessment.conclusion.verdict === "violated" && c.record.assessment.proposition === p.record.assessment.proposition)) {
			contradicted.add(p.record.assessment.proposition);
		}
	}
	for (const proposition of contradicted) causes.push(`contradiction:${proposition}`);

	if (policy.consequence === "reversible") return { disposition: "continue", causes, unsupported };
	if (contradicted.size > 0) return { disposition: policy.onContradiction, causes, unsupported };
	if (blockerSurvives || caution.some((c) => c.openResiduals.length > 0 || (c.basisValid && c.complete))) {
		return { disposition: "withhold", causes, unsupported };
	}
	if (positive.length === 0) return { disposition: recoverable ? "gather-evidence" : "withhold", causes, unsupported };
	return { disposition: "commit", causes, unsupported };
}

/**
 * Control condition: take the assessor's conclusion at face value, as a free-form review comment
 * would be read. No binding, basis, completeness, residual, or carried-blocker check.
 */
export function faceValueDisposition(records: AssessmentRecord[], policy: Policy): Disposition {
	if (policy.consequence === "reversible") return "continue";
	const last = records.at(-1);
	if (!last) return "gather-evidence";
	switch (last.assessment.conclusion.verdict) {
		case "holds":
			return "commit";
		case "violated":
			return "withhold";
		default:
			return "gather-evidence";
	}
}

/** Cold handoff: the ledger keeps every record; a cold seat receives only what policy admits. */
export function handoff(records: AssessmentRecord[], admit: (record: AssessmentRecord) => boolean): { ledger: AssessmentRecord[]; delivered: AssessmentRecord[] } {
	return { ledger: records, delivered: records.filter(admit) };
}

export interface Fixture {
	id: string;
	source: string;
	facts: HarnessFacts;
	policy: Policy;
	records: AssessmentRecord[];
	/**
	 * Facts after the obtainable observation is acquired, plus any reassessment it permits, and
	 * whether committing was justified in THAT state — recovery can change the truth (#555).
	 */
	recovery?: { facts: HarnessFacts; records: AssessmentRecord[]; justifiedCommit: boolean };
	/** Ground truth from the episode's known outcome: was committing justified on the base facts? */
	justifiedCommit: boolean;
}

export type Condition = "face-value" | "proposition-basis-conclusion" | "with-residual" | "with-recovery";

export interface FrontierRow {
	condition: Condition;
	commits: number;
	unsupportedCommits: number;
	unnecessaryWithholding: number;
	total: number;
}

function stripResiduals(records: AssessmentRecord[]): AssessmentRecord[] {
	return records.map((r) => ({ ...r, assessment: { ...r.assessment, residual: undefined } }));
}

export function dispositionUnder(fixture: Fixture, condition: Condition): { disposition: Disposition; justified: boolean } {
	const base = { justified: fixture.justifiedCommit };
	switch (condition) {
		case "face-value":
			return { disposition: faceValueDisposition(fixture.records, fixture.policy), ...base };
		case "proposition-basis-conclusion":
			return { disposition: shadowDisposition(stripResiduals(fixture.records), fixture.facts, fixture.policy).disposition, ...base };
		case "with-residual":
			return { disposition: shadowDisposition(fixture.records, fixture.facts, fixture.policy).disposition, ...base };
		case "with-recovery": {
			const first = shadowDisposition(fixture.records, fixture.facts, fixture.policy);
			// Recovery is only an opportunity when the harness knows of an obtainable observation.
			if (first.disposition === "commit" || !fixture.recovery) return { disposition: first.disposition, ...base };
			const after = shadowDisposition(fixture.recovery.records, fixture.recovery.facts, fixture.policy);
			return { disposition: after.disposition, justified: fixture.recovery.justifiedCommit };
		}
	}
}

/** The risk–coverage table the experiment asks for. Counts, not a scalar score. */
export function frontier(fixtures: Fixture[]): FrontierRow[] {
	const conditions: Condition[] = ["face-value", "proposition-basis-conclusion", "with-residual", "with-recovery"];
	return conditions.map((condition) => {
		const row: FrontierRow = { condition, commits: 0, unsupportedCommits: 0, unnecessaryWithholding: 0, total: fixtures.length };
		for (const fixture of fixtures) {
			const { disposition, justified } = dispositionUnder(fixture, condition);
			if (disposition === "commit") {
				row.commits++;
				if (!justified) row.unsupportedCommits++;
			} else if (justified && disposition !== "continue") {
				row.unnecessaryWithholding++;
			}
		}
		return row;
	});
}

export function renderFrontier(rows: FrontierRow[]): string {
	const lines = ["| condition | commits | unsupported commits | unnecessary withholding |", "|---|---|---|---|"];
	for (const r of rows) lines.push(`| ${r.condition} | ${r.commits}/${r.total} | ${r.unsupportedCommits} | ${r.unnecessaryWithholding} |`);
	return lines.join("\n");
}
