import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const text = readFileSync(resolve(repo, "docs/assurance/activity-provenance-experiment.md"), "utf8");

function requirePhrase(phrase: string): void {
  assert.ok(text.includes(phrase), `activity-provenance experiment lost boundary: ${phrase}`);
}

describe("shadow activity provenance experiment", () => {
  it("does not promote skill invocation into ontology", () => {
    requirePhrase("Do not add a `SkillInvocation` ontology node");
    requirePhrase("Activity view");
    requirePhrase("projection, not a promoted schema");
  });

  it("keeps operation identity independent of carrier", () => {
    requirePhrase("`operation` is semantic");
    requirePhrase("not a tool/skill name");
    for (const carrier of ["`/charter` skill", "hosted form", "consumer implementation"]) requirePhrase(carrier);
    requirePhrase("Changing the carrier must not change semantic meaning or silently transfer authority");
  });

  it("covers human, autonomous, direct-service, and consumer invocation paths", () => {
    for (const mode of [
      "interactive human-mediated",
      "autonomous/harness-mediated",
      "direct semantic service",
      "consumer-owned implementation",
    ]) requirePhrase(mode);
    requirePhrase("cannot invent a human-value choice");
    requirePhrase("unresolved residual remains explicit");
  });

  it("requires reconstruction of input, activity, output, residual, and resolution provenance", () => {
    for (const phrase of [
      "what raw intent was supplied",
      "which normalization activity transformed it",
      "which implementation/version performed the activity",
      "which normalized assessment/output it produced",
      "which material residuals remained",
      "which principal, if any, resolved each residual",
    ]) requirePhrase(phrase);
  });

  it("prefers existing provenance ownership over model-authored duplication", () => {
    requirePhrase("must not be re-authored by a model");
    requirePhrase("raw-input binding");
    requirePhrase("normalized-output/assessment binding");
    requirePhrase("human mediation/residual resolution binding");
  });

  it("retains the direct invocation-node versus derived-activity falsification", () => {
    requirePhrase("new persisted `SkillInvocation`/`Invocation` node");
    requirePhrase("derived `ActivityView` over existing provenance plus the minimum missing bindings");
    requirePhrase("Promote a generic Activity primitive only if repeated real cases require durable identity/relations");
  });
});
