import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const text = readFileSync(resolve(repo, "docs/assurance/question-contract-experiment.md"), "utf8");

function requirePhrase(phrase: string): void {
  assert.ok(text.includes(phrase), `question-contract experiment lost boundary: ${phrase}`);
}

describe("semantic question contract experiment", () => {
  it("keeps question-driven growth and failure classification explicit", () => {
    requirePhrase("A new primitive, relation, or qualifier is earned only when an important question cannot be answered correctly, traceably, and economically");
    for (const owner of [
      "missing semantic knowledge or relationship",
      "missing binding/provenance",
      "missing runtime/control-state semantics",
      "insufficient question grammar/query planning",
      "presentation deficiency",
    ]) requirePhrase(owner);
  });

  it("keeps the candidate grammar small and shadow-only", () => {
    for (const family of ["explain", "trace", "challenge", "recover", "steer"]) requirePhrase(family);
    requirePhrase("not ontology");
    requirePhrase("not yet a stable/public API");
    requirePhrase("semantic-diff(before, after)");
  });

  it("keeps probabilistic interpretation outside deterministic retrieval", () => {
    requirePhrase("Natural language is outside the deterministic contract");
    requirePhrase("Equivalent natural-language prompts should be allowed to normalize to equivalent semantic contracts");
    requirePhrase("scalar interpretation confidence must not become authority");
  });

  it("uses recursive why without root-cause collapse", () => {
    requirePhrase("Recursive why, not Five Whys");
    requirePhrase("competing explanatory branches must not be collapsed into a single causal chain");
  });

  it("keeps 5W1H as an experimental answer coverage lens", () => {
    requirePhrase("5W1H as answer coverage, not API taxonomy");
    for (const dimension of ["who", "what", "when", "where", "why", "how"]) requirePhrase(`${dimension}: covered | missing | unknown | not-material`);
    requirePhrase("not mandatory answer fields or ontology slots");
  });

  it("standardizes meaning rather than storage or transport", () => {
    requirePhrase("Question meaning and answer semantics are the compatibility contract");
    requirePhrase("Semantic conformance should be demonstrated with competency-question fixtures and invariant behavior rather than field-for-field representation identity");
    requirePhrase("Unknown/unsupported extensions may be ignored only when doing so cannot strengthen a claim, grant authority, erase uncertainty, or create false equivalence");
  });

  it("ratchets low-maintenance local ownership", () => {
    requirePhrase("smallest irreducible semantic delta once at the layer that owns it");
    requirePhrase("A worker should never be asked to author a fact the harness can determine more reliably itself");
    requirePhrase("Federation/composition remains deliberately undecided");
    requirePhrase("composition must not implicitly transfer authority between owners");
  });

  it("retains falsification against raw-corpus model performance", () => {
    requirePhrase("raw-corpus model reconstruction");
    requirePhrase("cross-model consistency");
    requirePhrase("if models perform equally well from the raw corpus at comparable cost and reliability");
  });
});
