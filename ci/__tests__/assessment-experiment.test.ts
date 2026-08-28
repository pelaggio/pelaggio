import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const text = readFileSync(resolve(repo, "docs/assurance/assessment-experiment.md"), "utf8");

function requirePhrase(phrase: string): void {
	assert.ok(text.includes(phrase), `assessment experiment lost invariant: ${phrase}`);
}

describe("assessment experiment boundary", () => {
	it("keeps the worker-authored semantic payload minimal", () => {
		for (const field of ["proposition", "basis[]", "conclusion", "residual[]"]) requirePhrase(field);
		for (const forbidden of ["confidence thresholds", "an uncertainty-status taxonomy", "suggestedAction"]) requirePhrase(forbidden);
		requirePhrase("Workers author only the irreducible semantic judgment.");
		requirePhrase("An agent must not be asked to author identity, timestamps, run/attempt/provider metadata, state binding, completeness, authoritative execution outcome");
	});

	it("keeps custody and completeness harness-owned", () => {
		requirePhrase("Provenance, binding, and completeness are harness-owned.");
		requirePhrase("Absence of residual is not evidence of completeness.");
		requirePhrase("Omission cannot manufacture positive authority");
	});

	it("preserves the deterministic/probabilistic seam", () => {
		requirePhrase("Assessment is judgment, never gate authority.");
		requirePhrase("Blocking disposition remains deterministic.");
		requirePhrase("Delivery/landing consumes disposition, never raw model prose.");
		requirePhrase("Wording must not become mechanism.");
		requirePhrase("Question-driven retrieval does not promote model interpretation into fact.");
	});

	it("keeps assessment separate from consequence and selection policy", () => {
		requirePhrase("Assessment and disposition are orthogonal.");
		requirePhrase("The same assessment may permit reversible exploration while blocking a consequential effect.");
		requirePhrase("model confidence or persuasive wording cannot satisfy a deterministic positive-evidence requirement");
		requirePhrase("selective commitment");
		requirePhrase("selection-policy separation");
		requirePhrase("changing consequence policy may change disposition without mutating the underlying assessment");
	});

	it("evaluates risk and coverage rather than rewarding abstention", () => {
		requirePhrase("risk–coverage frontier");
		requirePhrase("consequential commitment coverage");
		requirePhrase("unsupported consequential commitment rate");
		requirePhrase("unnecessary withholding rate");
		requirePhrase("evidence-recovery rate");
		requirePhrase("post-commit residual discovery");
		requirePhrase('The desired outcome is not "more abstention."');
	});

	it("keeps selective commitment at consequence boundaries rather than every inference", () => {
		requirePhrase("especially direct at **adjudication and gates**");
		requirePhrase("any earlier step that makes a consequential commitment");
		requirePhrase("rather than force every internal model inference through a selection protocol");
	});

	it("preserves selective promotion and cold review", () => {
		requirePhrase("Cold independence remains selectable.");
		requirePhrase("Promotion is selective.");
		requirePhrase("not a scratchpad dump");
	});

	it("keeps durable semantic handoff richer than presentation", () => {
		requirePhrase("Durable handoff preserves semantic distinctions; presentation may be lossy.");
		requirePhrase("a summary must not replace the underlying record as a later trust/authority input");
		requirePhrase("summary non-authority");
	});

	it("fails safe on unsupported assessment semantics", () => {
		requirePhrase("Unknown semantics cannot become positive evidence.");
		requirePhrase("ignoring it must not strengthen a conclusion, erase a residual, satisfy completeness, or grant authority");
		requirePhrase("unsupported-extension safety");
	});

	it("does not prematurely create authoritative assurance edges or real gate behavior", () => {
		requirePhrase("No new assurance relation is authoritative in this slice.");
		requirePhrase("real gate changes");
		requirePhrase("authoritative `supports`/`challenges` edges");
	});

	it("keeps question grammar out of the assessment record", () => {
		requirePhrase("The question grammar remains shadow-only.");
		requirePhrase("not bake one query vocabulary into the record format");
		requirePhrase("the clearing transition/authorized actor remains runtime/control semantics rather than `suggestedAction` authored by the model");
	});

	it("names falsification conditions rather than only success criteria", () => {
		requirePhrase("failed or overfit abstraction");
		requirePhrase("decorative caveats");
		requirePhrase("deterministic policy still has to semantically parse prose");
		requirePhrase("later agents must trust summaries because the durable record failed to preserve the distinctions needed for reinterpretation");
	});
});
