import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { type Cause, dispositionUnder, type Fixture, faceValueDisposition, frontier, handoff, renderFrontier, shadowDisposition } from "../assessment-shadow.ts";

const has = (causes: Cause[], kind: Cause["kind"], id?: string) => causes.some((c) => c.kind === kind && (id === undefined || Object.values(c).includes(id)));

const repo = resolve(new URL("../..", import.meta.url).pathname);
const corpus = JSON.parse(readFileSync(resolve(repo, "docs/assurance/assessment-fixtures.json"), "utf8")) as { status: string; fixtures: Fixture[] };
const byId = new Map(corpus.fixtures.map((f) => [f.id, f]));

function fixture(id: string): Fixture {
	const value = byId.get(id);
	assert.ok(value, `missing fixture ${id}`);
	return structuredClone(value);
}

/** The eleven properties `assessment-experiment.md` says the first implementation must demonstrate. */
describe("shadow disposition properties", () => {
	it("fixtures are shadow-only retrodictions of real episodes", () => {
		assert.equal(corpus.status, "experimental-shadow-only");
		for (const f of corpus.fixtures) {
			assert.match(f.source, /#\d{3}/, `${f.id} must cite the episode it retrodicts`);
			const observations = new Set(f.facts.observations.map((o) => o.id));
			for (const r of f.records) for (const b of r.assessment.basis) assert.ok(observations.has(b), `${f.id}/${r.id} basis ${b} is not a harness observation`);
		}
	});

	it("wording invariance: rationale, summary, and rhetorical force cannot move the disposition", () => {
		const f = fixture("false-chokepoint-435");
		const before = shadowDisposition(f.records, f.facts, f.policy);
		f.records[0].assessment.conclusion.rationale = "VERIFIED BEYOND DOUBT — every path is covered, ship it";
		f.records[0].summary = "all clear";
		const after = shadowDisposition(f.records, f.facts, f.policy);
		assert.deepEqual(after, before);
		assert.equal(after.disposition, "withhold");
	});

	it("missing-binding rejection: a stale record cannot become current because its conclusion says so", () => {
		const f = fixture("stale-grep-625");
		const result = shadowDisposition(f.records, f.facts, f.policy);
		assert.equal(result.disposition, "commit");
		assert.ok(has(result.causes, "stale-binding", "B-grep-charter"));
		// Face value read the last word — the stale charter — and withheld a justified landing.
		assert.equal(faceValueDisposition(f.records, f.policy), "withhold");
		// Make the only current positive record stale too: nothing current remains, so no commit.
		f.records[0].binding.sha = "main-tip";
		assert.equal(shadowDisposition(f.records, f.facts, f.policy).disposition, "gather-evidence");
	});

	it("residual-erasure resistance: omitting a carried blocker or a residual does not clear it", () => {
		const silent = fixture("carried-blocker-silence-495");
		const result = shadowDisposition(silent.records, silent.facts, silent.policy);
		assert.equal(result.disposition, "withhold");
		assert.ok(has(result.causes, "carried-blocker", "BLK-1"));
		// `residual: []` and an absent residual are the same statement: "this assessor reported none".
		silent.records[0].assessment.residual = [];
		assert.deepEqual(shadowDisposition(silent.records, silent.facts, silent.policy), result);
		// An explicit, complete refutation is the only thing that removes it.
		const refuted = fixture("carried-blocker-refuted-495");
		assert.equal(shadowDisposition(refuted.records, refuted.facts, refuted.policy).disposition, "commit");
		refuted.records[0].assessment.residual = [{ statement: "the report predates a touched path" }];
		assert.equal(shadowDisposition(refuted.records, refuted.facts, refuted.policy).disposition, "withhold");
		// A stale refutation — bound to an earlier SHA — is not the authority that removes a blocker.
		const stale = fixture("carried-blocker-refuted-495");
		stale.records[0].binding.sha = "599-r1";
		const staleResult = shadowDisposition(stale.records, stale.facts, stale.policy);
		assert.equal(staleResult.disposition, "withhold");
		assert.ok(has(staleResult.causes, "carried-blocker", "BLK-1"));
		// Nor is one whose named residual has since resolved and awaits reassessment.
		const pending = fixture("carried-blocker-refuted-495");
		pending.records[0].assessment.residual = [{ statement: "unless the path was touched after the report", resolvedBy: "review-r2" }];
		assert.equal(shadowDisposition(pending.records, pending.facts, pending.policy).disposition, "withhold");
	});

	it("contradictory-assessment handling: disagreement is an explicit policy state, not Judge sovereignty", () => {
		const f = fixture("label-vs-split-593");
		const stripped = f.records.map((r) => ({ ...r, assessment: { ...r.assessment, residual: undefined } }));
		const result = shadowDisposition(stripped, f.facts, f.policy);
		assert.equal(result.disposition, "retry-escalate");
		assert.ok(has(result.causes, "contradiction"));
		assert.equal(shadowDisposition(stripped, f.facts, { ...f.policy, onContradiction: "withhold" }).disposition, "withhold");
	});

	it("resolving-evidence transition: acquiring the named observation legitimately changes the outcome", () => {
		const split = fixture("label-vs-split-593");
		assert.notEqual(shadowDisposition(split.records, split.facts, split.policy).disposition, "commit");
		assert.ok(split.recovery);
		// The observation arrives but nobody has reassessed V yet: fail closed, not commit — the
		// resolving observation might have confirmed the violation.
		const pendingResult = shadowDisposition(split.records, split.recovery.facts, split.policy);
		assert.equal(pendingResult.disposition, "gather-evidence");
		assert.ok(has(pendingResult.causes, "residual-resolved-needs-reassessment", "V"));
		assert.ok(has(pendingResult.causes, "pending-reassessment-on-proposition", "V"));
		// Only a reassessment that SUPERSEDES V (harness-linked; V stays in the ledger) lets the proposition commit.
		const after = shadowDisposition(split.recovery.records, split.recovery.facts, split.policy);
		assert.equal(after.disposition, "commit");
		assert.ok(
			split.recovery.records.some((r) => r.id === "V"),
			"the superseded record is retained, not dropped",
		);
		const unlinked = structuredClone(split.recovery);
		const reassessed = unlinked.records.find((r) => r.id === "V-reassessed");
		assert.ok(reassessed);
		reassessed.supersedes = undefined;
		assert.equal(shadowDisposition(unlinked.records, unlinked.facts, split.policy).disposition, "gather-evidence", "without the supersedes link the old V still pends");
		// A hollow successor supersedes nothing: stale binding, or a residual of its own, leaves V pending.
		const hollow = structuredClone(split.recovery);
		const bad = hollow.records.find((r) => r.id === "V-reassessed");
		assert.ok(bad);
		bad.binding.sha = "553-r3";
		assert.equal(shadowDisposition(hollow.records, hollow.facts, split.policy).disposition, "gather-evidence", "a stale successor does not supersede");
		const hollow2 = structuredClone(split.recovery);
		const bad2 = hollow2.records.find((r) => r.id === "V-reassessed");
		assert.ok(bad2);
		bad2.assessment.residual = [{ statement: "unless the adjudicator config changed" }];
		assert.equal(shadowDisposition(hollow2.records, hollow2.facts, split.policy).disposition, "gather-evidence", "a successor carrying its own residual does not supersede");
		// A supersession must name a different, existing record about the SAME proposition.
		const wrongTarget = structuredClone(split.recovery);
		const wt = wrongTarget.records.find((r) => r.id === "V-reassessed");
		assert.ok(wt);
		wt.assessment.proposition = "an unrelated proposition";
		assert.equal(shadowDisposition(wrongTarget.records, wrongTarget.facts, split.policy).disposition, "gather-evidence", "a successor on another proposition supersedes nothing");
		const selfRef = structuredClone(split.recovery);
		const sr = selfRef.records.find((r) => r.id === "V-reassessed");
		assert.ok(sr);
		sr.supersedes = "V-reassessed";
		assert.equal(shadowDisposition(selfRef.records, selfRef.facts, split.policy).disposition, "gather-evidence", "a self-referential link supersedes nothing");

		const outage = fixture("unavailable-observation-555");
		const first = shadowDisposition(outage.records, outage.facts, outage.policy);
		assert.equal(first.disposition, "gather-evidence");
		assert.ok(has(first.causes, "incomplete", "L"));
		assert.ok(outage.recovery);
		assert.equal(shadowDisposition(outage.recovery.records, outage.recovery.facts, outage.policy).disposition, "commit");
	});

	it("consequence sensitivity: one assessment permits reversible work while blocking a load-bearing effect", () => {
		const f = fixture("ambiguous-charter-mediation");
		const consequential = shadowDisposition(f.records, f.facts, f.policy);
		const reversible = shadowDisposition(f.records, f.facts, { ...f.policy, consequence: "reversible" });
		assert.equal(consequential.disposition, "withhold");
		assert.equal(reversible.disposition, "continue");
		assert.deepEqual(reversible.causes, consequential.causes, "the causes are the same facts; only the consequence threshold differs");
	});

	it("basis causes name their clearing actor: unknown needs a principal, stale and unavailable are recoverable", () => {
		const f = fixture("stale-grep-625");
		f.records = [f.records[0]]; // no stale sibling record to re-observe, so nothing is recoverable
		f.records[0].assessment.basis = ["no-such-observation"];
		const unknown = shadowDisposition(f.records, f.facts, f.policy);
		assert.equal(unknown.disposition, "withhold", "an unknown reference is not an evidence-recovery opportunity");
		assert.ok(has(unknown.causes, "basis-unknown", "no-such-observation"));
		f.records[0].assessment.basis = ["grep-main-head-limited"];
		const stale = shadowDisposition(f.records, f.facts, f.policy);
		assert.equal(stale.disposition, "gather-evidence");
		assert.ok(has(stale.causes, "basis-stale", "grep-main-head-limited"));
		const outage = fixture("unavailable-observation-555");
		outage.records[0].assessment.basis = ["mergeable-state"];
		const unavailable = shadowDisposition(outage.records, outage.facts, outage.policy);
		assert.equal(unavailable.disposition, "gather-evidence");
		assert.ok(has(unavailable.causes, "basis-unavailable", "mergeable-state"));
	});

	it("a principal's recorded clearance closes a residual without touching the record", () => {
		const f = fixture("false-chokepoint-435");
		assert.equal(shadowDisposition(f.records, f.facts, f.policy).disposition, "withhold");
		const cleared = { ...f.facts, principalClearances: [{ record: "G", residualIndex: 0, actor: "operator" }] };
		const snapshot = JSON.stringify(f.records);
		assert.equal(shadowDisposition(f.records, cleared, f.policy).disposition, "commit");
		assert.equal(JSON.stringify(f.records), snapshot, "clearance is a harness fact, not a record edit");
	});

	it("a violated finding on a weak basis is never bypassed by a positive record", () => {
		const f = fixture("stale-grep-625");
		// A is current, complete, holds. Add a violated finding whose only basis is unavailable: unresolved, not ignorable.
		f.facts.observations.push({ id: "pending-probe", sha: "589-head", available: false });
		f.records.push({ ...structuredClone(f.records[0]), id: "C-weak", assessment: { proposition: f.policy.proposition, basis: ["pending-probe"], conclusion: { verdict: "violated" } } });
		const weak = shadowDisposition(f.records, f.facts, f.policy);
		assert.equal(weak.disposition, "gather-evidence");
		assert.ok(has(weak.causes, "basis-unavailable", "pending-probe"));
		// With an unknown reference and nothing recoverable elsewhere, it withholds.
		const g = fixture("stale-grep-625");
		g.records = [g.records[0], { ...structuredClone(g.records[0]), id: "C-unknown", assessment: { proposition: g.policy.proposition, basis: ["no-such-observation"], conclusion: { verdict: "violated" } } }];
		assert.equal(shadowDisposition(g.records, g.facts, g.policy).disposition, "withhold");
	});

	it("positive evidence is scoped to the policy's target proposition; a blocker wins over every other state", () => {
		const f = fixture("stale-grep-625");
		// A current, complete, extension-free `holds` on an UNRELATED proposition is not evidence for the target.
		f.records[0].assessment.proposition = "some other proposition entirely";
		const unrelated = shadowDisposition(f.records, f.facts, f.policy);
		assert.notEqual(unrelated.disposition, "commit");
		// A second valid record CONFIRMING the blocker keeps it alive beside the refutation, as a contradiction.
		const confirmedToo = fixture("carried-blocker-refuted-495");
		confirmedToo.records.push({ ...structuredClone(confirmedToo.records[0]), id: "CONFIRM", assessment: { proposition: "#554 env denial is not on the Claude path", basis: ["review-r2"], conclusion: { verdict: "holds" } } });
		const confirmedResult = shadowDisposition(confirmedToo.records, confirmedToo.facts, confirmedToo.policy);
		assert.equal(confirmedResult.disposition, "withhold");
		assert.ok(has(confirmedResult.causes, "carried-blocker", "BLK-1"));
		assert.ok(has(confirmedResult.causes, "contradiction", "#554 env denial is not on the Claude path"));
		// Blocker-first: a contradiction elsewhere cannot downgrade a retained blocker to retry-escalate.
		const blocked = fixture("carried-blocker-silence-495");
		const contradictor = structuredClone(blocked.records[0]);
		contradictor.id = "R2b";
		contradictor.assessment.conclusion = { verdict: "violated" };
		const result = shadowDisposition([...blocked.records, contradictor], blocked.facts, { ...blocked.policy, onContradiction: "retry-escalate" });
		assert.equal(result.disposition, "withhold");
		assert.ok(has(result.causes, "carried-blocker", "BLK-1"));
		assert.ok(has(result.causes, "contradiction"));
	});

	it("cold-handoff control: the ledger keeps every record; a cold seat receives only what policy admits", () => {
		const f = fixture("stale-grep-625");
		const { ledger, delivered } = handoff(f.records, (r) => r.provenance.step !== "charter");
		assert.equal(ledger.length, 2);
		assert.deepEqual(
			delivered.map((r) => r.id),
			["A-reachability"],
		);
	});

	it("selection-policy separation: changing consequence policy changes disposition without mutating the assessment", () => {
		const f = fixture("label-vs-split-593");
		const snapshot = JSON.stringify(f.records);
		const a = shadowDisposition(f.records, f.facts, { ...f.policy, consequence: "consequential", onContradiction: "retry-escalate" });
		const b = shadowDisposition(f.records, f.facts, { ...f.policy, consequence: "consequential", onContradiction: "withhold" });
		const c = shadowDisposition(f.records, f.facts, { ...f.policy, consequence: "reversible", onContradiction: "withhold" });
		assert.deepEqual([a.disposition, b.disposition, c.disposition], ["retry-escalate", "withhold", "continue"]);
		assert.equal(JSON.stringify(f.records), snapshot);
	});

	it("no confidence selector: numeric or rhetorical self-confidence cannot satisfy a positive-evidence requirement", () => {
		const f = fixture("unavailable-observation-555");
		(f.records[0].assessment as unknown as Record<string, unknown>).confidence = 0.99;
		const result = shadowDisposition(f.records, f.facts, f.policy);
		assert.equal(result.disposition, "gather-evidence");
		assert.deepEqual(result.unsupported, ["L:confidence"]);
	});

	it("summary non-authority: a lossy summary cannot substitute for the bound record", () => {
		const f = fixture("carried-blocker-silence-495");
		assert.equal(f.records[0].summary, "all clean, ready to merge");
		assert.equal(shadowDisposition(f.records, f.facts, f.policy).disposition, "withhold");
	});

	it("unsupported-extension safety: an unknown extension cannot strengthen a withheld record, and fails closed on committing evidence", () => {
		const f = fixture("false-chokepoint-435");
		const ext = f.records[0].assessment as unknown as Record<string, unknown>;
		ext["x-residual-resolved"] = true;
		ext["x-verified"] = "by a trusted tool";
		const result = shadowDisposition(f.records, f.facts, f.policy);
		assert.equal(result.disposition, "withhold");
		assert.deepEqual(result.unsupported, ["G:x-residual-resolved", "G:x-verified"]);
		// The load-bearing case: a record that WOULD commit carries an unknown extension. Ignoring it
		// could strengthen the conclusion, so a consequential effect fails closed; reversible work continues.
		const clean = fixture("stale-grep-625");
		assert.equal(shadowDisposition(clean.records, clean.facts, clean.policy).disposition, "commit");
		const tainted = fixture("stale-grep-625");
		(tainted.records[0].assessment as unknown as Record<string, unknown>)["x-applicability"] = "linux-only";
		const consequential = shadowDisposition(tainted.records, tainted.facts, tainted.policy);
		assert.equal(consequential.disposition, "withhold");
		assert.ok(has(consequential.causes, "unsupported-extension-on-evidence", "A-reachability"));
		assert.deepEqual(consequential.unsupported, ["A-reachability:x-applicability"]);
		assert.equal(shadowDisposition(tainted.records, tainted.facts, { ...tainted.policy, consequence: "reversible" }).disposition, "continue");
		// Nested unknown keys are found too, and an extension on a REFUTATION disqualifies it from clearing a blocker.
		const nested = fixture("stale-grep-625");
		(nested.records[0].assessment.conclusion as unknown as Record<string, unknown>)["x-confidence"] = 0.99;
		nested.records[0].assessment.residual = [{ statement: "none material", "x-waived": true } as unknown as { statement: string }];
		const nestedResult = shadowDisposition(nested.records, nested.facts, nested.policy);
		assert.deepEqual(nestedResult.unsupported, ["A-reachability:conclusion.x-confidence", "A-reachability:residual[0].x-waived"]);
		assert.equal(nestedResult.disposition, "withhold");
		const taintedRefutation = fixture("carried-blocker-refuted-495");
		(taintedRefutation.records[0].assessment as unknown as Record<string, unknown>)["x-untouched-path-verified"] = true;
		const refResult = shadowDisposition(taintedRefutation.records, taintedRefutation.facts, taintedRefutation.policy);
		assert.equal(refResult.disposition, "withhold");
		assert.ok(has(refResult.causes, "carried-blocker", "BLK-1"));
	});
});

describe("risk–coverage frontier over the retrodicted episodes", () => {
	const rows = frontier(corpus.fixtures);
	it("renders as a five-row table carrying all five experiment metrics", () => {
		const rendered = renderFrontier(rows);
		assert.equal(rendered.split("\n").length, 7);
		assert.ok(rendered.includes("evidence recovered") && rendered.includes("post-commit residual discovery"));
		assert.equal(row("proposition-basis-conclusion").postCommitResidualDiscovery, 1, "#435's residual is the one discovered after the fact");
		assert.equal(row("with-recovery").evidenceRecovered, 2);
		assert.equal(row("with-residual").evidenceRecovered, 0);
	});
	const row = (condition: string) => {
		const r = rows.find((candidate) => candidate.condition === condition);
		assert.ok(r, `missing frontier row ${condition}`);
		return r;
	};

	it("face value commits on unsupported evidence and withholds justified landings", () => {
		assert.ok(row("face-value").unsupportedCommits > 0);
		assert.ok(row("face-value").unnecessaryWithholding > 0);
	});

	it("binding + basis + completeness remove some unsupported commitments but not the residual-shaped ones", () => {
		assert.ok(row("proposition-basis-conclusion").unsupportedCommits < row("face-value").unsupportedCommits);
		const chokepoint = dispositionUnder(fixture("false-chokepoint-435"), "proposition-basis-conclusion");
		assert.equal(chokepoint.disposition, "commit", "#435 is exactly the shape only a residual catches");
		assert.equal(chokepoint.justified, false);
	});

	it("residuals buy risk with coverage; recovery buys the coverage back", () => {
		assert.equal(row("with-residual").unsupportedCommits, 0);
		assert.ok(row("with-residual").commits < row("proposition-basis-conclusion").commits, "the residual condition withholds more");
		assert.equal(row("with-recovery").unsupportedCommits, 0);
		assert.equal(row("with-recovery").unnecessaryWithholding, 0);
		assert.ok(row("with-recovery").commits >= row("face-value").commits, "recovery reaches face-value coverage at zero unsupported commitments");
		// Scored on the base truth every other row uses, the recovered #555 commit counts as unsupported:
		// that difference is the ground-truth confound, reported rather than hidden.
		assert.equal(row("with-recovery-fixed-truth").commits, row("with-recovery").commits);
		assert.equal(row("with-recovery-fixed-truth").unsupportedCommits, 1);
	});
});
