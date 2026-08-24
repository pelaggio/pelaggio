import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { dispositionUnder, type Fixture, faceValueDisposition, frontier, handoff, shadowDisposition } from "../assessment-shadow.ts";

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
			assert.match(f.source, /#\d{3}|charter-normalization-fixtures/, `${f.id} must cite the episode it retrodicts`);
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
		assert.ok(result.causes.includes("stale-binding:B-grep-charter"));
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
		assert.ok(result.causes.includes("carried-blocker:BLK-1"));
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
		assert.ok(staleResult.causes.includes("carried-blocker:BLK-1"));
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
		assert.ok(result.causes.some((c) => c.startsWith("contradiction:")));
		assert.equal(shadowDisposition(stripped, f.facts, { ...f.policy, onContradiction: "withhold" }).disposition, "withhold");
	});

	it("resolving-evidence transition: acquiring the named observation legitimately changes the outcome", () => {
		const split = fixture("label-vs-split-593");
		assert.notEqual(shadowDisposition(split.records, split.facts, split.policy).disposition, "commit");
		assert.ok(split.recovery);
		const after = shadowDisposition(split.recovery.records, split.recovery.facts, split.policy);
		assert.equal(after.disposition, "commit");
		assert.ok(after.causes.includes("residual-resolved-needs-reassessment:V"));

		const outage = fixture("unavailable-observation-555");
		const first = shadowDisposition(outage.records, outage.facts, outage.policy);
		assert.equal(first.disposition, "gather-evidence");
		assert.ok(first.causes.includes("incomplete:L"));
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
		const a = shadowDisposition(f.records, f.facts, { consequence: "consequential", onContradiction: "retry-escalate" });
		const b = shadowDisposition(f.records, f.facts, { consequence: "consequential", onContradiction: "withhold" });
		const c = shadowDisposition(f.records, f.facts, { consequence: "reversible", onContradiction: "withhold" });
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
		assert.ok(consequential.causes.includes("unsupported-extension-on-evidence:A-reachability"));
		assert.deepEqual(consequential.unsupported, ["A-reachability:x-applicability"]);
		assert.equal(shadowDisposition(tainted.records, tainted.facts, { ...tainted.policy, consequence: "reversible" }).disposition, "continue");
	});
});

describe("risk–coverage frontier over the retrodicted episodes", () => {
	const rows = frontier(corpus.fixtures);
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
	});
});
