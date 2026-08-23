import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const doc = readFileSync(resolve(repo, "docs/assurance/charter-normalization-experiment.md"), "utf8");
const corpus = JSON.parse(readFileSync(resolve(repo, "docs/assurance/charter-normalization-fixtures.json"), "utf8")) as {
  status: string;
  fixtures: Array<{
    id: string;
    source: string;
    rawMechanisms: string[];
    normalizedIntent: string;
    counterexamples: string[];
    mustNotNormalizeTo: string[];
    materialNormalization: boolean;
    candidateGoal: string | null;
  }>;
};

function requirePhrase(phrase: string): void {
  assert.ok(doc.includes(phrase), `charter-normalization experiment lost boundary: ${phrase}`);
}

describe("shadow charter intent normalization", () => {
  it("remains shadow-only and preserves raw intent authority boundaries", () => {
    assert.equal(corpus.status, "experimental-shadow-only");
    requirePhrase("experimental / shadow-only");
    requirePhrase("The raw request remains preserved");
    requirePhrase("carries no authority merely because it was generated earlier in the pipeline");
    requirePhrase("does not make normalized intent authoritative");
  });

  it("ratchets the four intake falsification probes and cheap early exit", () => {
    for (const probe of ["mechanism substitution", "false success", "alternative success", "boundary counterexample"]) requirePhrase(probe);
    requirePhrase("Can the requested deliverable be completed exactly as stated while the apparent desired outcome still fails?");
    requirePhrase("Normalization is not a mandatory essay-producing stage");
  });

  it("keeps intake, planning, review, and reconciliation responsibilities distinct", () => {
    for (const stage of ["**Intake**", "**Planning**", "**Review**", "**Reconciliation**"]) requirePhrase(stage);
    requirePhrase("Moving cheap counterexamples left must not collapse those later responsibilities into intake");
  });

  it("contains historical positive and negative controls", () => {
    const byId = new Map(corpus.fixtures.map((fixture) => [fixture.id, fixture]));
    for (const id of [
      "issue-408-landing",
      "issue-176-credential-broker",
      "issue-337-provider-capabilities",
      "issue-579-temp-fixtures",
      "issue-500-loopback-authority",
      "issue-186-ai-delivery",
      "issue-147-link-integrity",
    ]) assert.ok(byId.has(id), `missing historical charter fixture ${id}`);

    assert.equal(byId.get("issue-147-link-integrity")?.materialNormalization, false, "small bounded repair must remain a no-material-delta control");
    assert.equal(byId.get("issue-408-landing")?.materialNormalization, true);
    assert.equal(byId.get("issue-176-credential-broker")?.materialNormalization, true);
  });

  it("does not allow mechanism-shaped historical outcomes to become normalized intent", () => {
    for (const fixture of corpus.fixtures) {
      const normalized = fixture.normalizedIntent.toLowerCase();
      for (const forbidden of fixture.mustNotNormalizeTo) {
        assert.ok(!normalized.includes(forbidden.toLowerCase()), `${fixture.id} normalized intent leaked forbidden mechanism-shaped objective: ${forbidden}`);
      }
    }
  });

  it("requires counterexamples for every material normalization fixture", () => {
    for (const fixture of corpus.fixtures.filter((candidate) => candidate.materialNormalization)) {
      assert.ok(fixture.counterexamples.length > 0, `${fixture.id} claims material normalization without a falsifying counterexample`);
      assert.ok(fixture.rawMechanisms.length > 0, `${fixture.id} claims material normalization without an identified mechanism hypothesis`);
      assert.ok(fixture.normalizedIntent.length > 40, `${fixture.id} normalized intent is suspiciously thin`);
    }
  });

  it("does not manufacture Goal mappings for every normalized charter", () => {
    const goalMapped = corpus.fixtures.filter((fixture) => fixture.candidateGoal !== null);
    const noGoal = corpus.fixtures.filter((fixture) => fixture.candidateGoal === null);
    assert.ok(goalMapped.length > 0, "fixture corpus must exercise candidate durable Goal mappings");
    assert.ok(noGoal.length > 0, "fixture corpus must prove normalized intent does not imply a Goal");
    requirePhrase("A normalized outcome does **not** automatically become a Goal");
    requirePhrase("Tiny repairs and maintenance work should normally resolve to existing semantics without manufacturing local goals");
  });

  it("retains the direct Goal-vs-proposition falsification experiment", () => {
    requirePhrase("raw charter -> normalization -> current proposition/decision/realization graph -> plan/review");
    requirePhrase("the same normalized charter plus a candidate Goal layer");
    requirePhrase("whether Goal materially improves durable explanations beyond proposition-only semantics");
  });
});
