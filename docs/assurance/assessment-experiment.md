# Assessment evidence experiment

Status: **experimental / shadow-only**.

This experiment tests whether Pelaggio should carry a small, attributable assessment artifact across probabilistic steps and deterministic hand-offs without turning model judgment into gate authority.

It extends the assurance direction established by ADR-0027 and the planned **Subject → Observation → Assessment** evidence slice, but it does not change the authoritative assurance graph, runtime behavior, gate semantics, or trust guarantees.

## Candidate semantic grammar

A worker emits only the semantic judgment:

```text
Assessment {
  proposition
  basis[]
  conclusion        { verdict: holds | violated | undetermined, rationale? }
  residual[]        { statement, resolvedBy? }
}
```

Two fields inside the four are typed because the harness consumes them and nothing else: `verdict` is
the only part of a conclusion a deterministic policy reads (rationale is prose for humans and is
never read), and `resolvedBy` names the observation whose arrival resolves a residual, which is what
lets recovery be a harness-observed transition rather than a model's `suggestedAction`. A residual
without `resolvedBy` can be cleared only by a principal.

The harness wraps it with custody data it already owns:

```text
AssessmentRecord {
  id
  binding
  provenance
  completeness
  assessment
}
```

The distinction is deliberate:

- **proposition** — the statement being assessed;
- **basis** — references to attributable observations/artifacts used by the assessor;
- **conclusion** — the assessor's probabilistic judgment about the proposition from that basis;
- **residual** — a material unresolved condition whose resolution could change the conclusion or the permissible downstream consequence;
- **binding** — the exact subject/state to which the record applies (for example SHA, finding fingerprint, attempt, worktree state); harness-owned;
- **provenance** — run/step/attempt/seat/provider/model generation context; harness-owned;
- **completeness** — whether the required evidence/assessment surface was covered; harness-owned and never inferred from model silence.

The candidate grammar is intentionally smaller than SACM/GSN-style argument models and does not attempt to encode warrants, confidence, applicability taxonomies, actor nodes, or full argument graphs. The experiment should earn any richer structure.

## Experiment constraints / proposed invariants

These are **constraints of the experiment**, not yet newly-promoted architectural propositions. They are written strongly so the experiment cannot accidentally validate a weaker system than the one Pelaggio intends to build.

1. **Assessment is judgment, never gate authority.** Structured model output remains probabilistic evidence/judgment. A reviewer, Judge, verifier model, planner, or adjudicator model is not itself a blocking gate.
2. **Blocking disposition remains deterministic.** Harness-observed facts, validated assessment records, explicit policy, typed causes, and independently computed completeness determine disposition. Delivery/landing consumes disposition, never raw model prose.
3. **Provenance, binding, and completeness are harness-owned.** A worker may not establish which SHA/state it actually assessed, who/what produced the record, or whether the required assessment surface was complete merely by asserting those facts.
4. **Absence of residual is not evidence of completeness.** `residual: []` means only that this assessor reported no material residual. Omission cannot manufacture positive authority or erase a carried blocker.
5. **Basis is referential, not a reasoning transcript.** Prefer stable references to attributable observations/artifacts over copied prose or hidden chain-of-thought. The assessment is a compact hand-off artifact, not a scratchpad dump.
6. **Residual is material and falsifiable.** Carry only unresolved conditions that could materially change the conclusion or downstream consequence; generic hedging is not ledger-worthy.
7. **Assessment and disposition are orthogonal.** The same assessment may permit reversible exploration while blocking a consequential effect. Policy determines the consequence threshold; the assessor does not.
8. **Probabilistic judgment may introduce or preserve caution but cannot manufacture required positive evidence.** A model finding may cause a reason to withhold authority; model confidence or persuasive wording cannot satisfy a deterministic positive-evidence requirement.
9. **Wording must not become mechanism.** Semantically equivalent normalized records must receive the same shadow disposition regardless of confidence language, verbosity, or rhetorical force.
10. **Cold independence remains selectable.** A downstream independent reviewer need not consume upstream assessments merely because they exist. Handoff policy decides which records cross each step boundary.
11. **Promotion is selective.** Steps may reason freely internally; only assessments relevant to a later handoff, gate, decision, finding, or audit question should become durable records.
12. **No new assurance relation is authoritative in this slice.** `supports`/`challenges` remain future assessment-mediated relations; this experiment must not allow raw observations or raw model conclusions to write authoritative assurance edges.
13. **Workers author only the irreducible semantic judgment.** An agent must not be asked to author identity, timestamps, run/attempt/provider metadata, state binding, completeness, authoritative execution outcome, or any other fact the harness can observe or derive more reliably itself.
14. **Durable handoff preserves semantic distinctions; presentation may be lossy.** Machine-to-machine records retain the proposition/basis/conclusion/residual and harness-owned custody facts needed for later reinterpretation. Human/model-facing summaries may compress them, but a summary must not replace the underlying record as a later trust/authority input.
15. **Unknown semantics cannot become positive evidence.** A consumer that does not understand an assessment extension or qualifier may display/retain it as unsupported, but ignoring it must not strengthen a conclusion, erase a residual, satisfy completeness, or grant authority.
16. **Question-driven retrieval does not promote model interpretation into fact.** A model may map natural language to candidate semantic questions and synthesize returned premises, but question interpretation, salience, and explanation remain probabilistic. Deterministic policy consumes validated semantic records and harness facts, not the model's paraphrase of them.

These constraints sharpen, rather than replace, ADR-0014's mechanism/policy spine and ADR-0026's separation of judgment, evidence completeness, and disposition.

## Semantic question interaction

The shadow question-contract experiment in the base assurance slice treats semantic questions as the stable seam between model/human interpretation and deterministic retrieval. Assessment participates in that seam without becoming a query engine or authority source.

Examples:

- `challenge(proposition)` may retrieve attributable challenging/unresolved assessments;
- `explain(..., epistemicPosture=...)` may include assessment conclusions while preserving their status as judgment;
- `recover(...)` may use a material residual to identify missing evidence, but the clearing transition/authorized actor remains runtime/control semantics rather than `suggestedAction` authored by the model;
- recursive explanation may expand an assumption into supporting/challenging assessments without collapsing competing branches into one root-cause story.

The question grammar remains shadow-only. Assessment should expose stable referential facts that multiple query implementations/agents can use, not bake one query vocabulary into the record format.

## Selective commitment lens

Selective prediction provides a useful evaluation frame without becoming another ontology primitive. Classical selective prediction separates the predictor from a selection rule and evaluates the tradeoff between **coverage** (how often the system commits) and **selective risk** (how often accepted predictions are wrong). Pelaggio's action space is richer than `predict | abstain`, so this experiment generalizes the idea to **selective commitment**:

```text
Assessment
    + harness-owned binding/completeness
    + explicit consequence policy
        ↓
continue | gather evidence | retry/escalate | withhold authority | commit
```

The assessment grammar does not depend on selective prediction and does not acquire a confidence score or threshold. Instead, selective commitment is a policy/evaluation problem above the assessment record: the same assessment can rationally receive different dispositions for reversible exploration and for a load-bearing effect.

This lens is especially direct at **adjudication and gates**, where Pelaggio must decide whether accumulated evidence is sufficient to clear, retain, retry, or escalate a finding. It can also apply at any earlier step that makes a consequential commitment: planning may continue reversible exploration while withholding a constitutional choice; implementation may seek another observation before an irreversible effect; review may preserve a possible blocker without claiming it is proven. The experiment should therefore measure selective commitment at consequence boundaries rather than force every internal model inference through a selection protocol.

The desired outcome is not "more abstention." It is an improved **risk–coverage frontier**: fewer unsupported consequential commitments at the same useful-work coverage, or greater useful-work coverage at the same acceptable unsupported-commitment risk. Evidence recovery matters because a residual may identify a missing observation that can be acquired rather than forcing immediate withholding.

For the experiment, record at least:

- **consequential commitment coverage** — fraction of eligible consequence points at which the system commits;
- **unsupported consequential commitment rate** — fraction of consequential commitments not justified by the required bound evidence/policy;
- **unnecessary withholding rate** — resolvable/adequately supported cases withheld despite sufficient evidence;
- **evidence-recovery rate** — material residuals for which obtainable resolving evidence is actually acquired and permits a justified reassessment;
- **post-commit residual discovery** — material gaps first recognized only after the relevant consequential commitment.

These are experiment metrics, not gate fields. In particular, no scalar model confidence is allowed to become the deterministic selector.

## What the experiment should compare

Use paired fixtures derived from real Pelaggio failure classes:

- current-head vs stale-head refutation evidence;
- carried finding whose anchoring context is untouched vs touched/unknown;
- apparent guard whose relevant execution path does vs does not traverse the chokepoint;
- required observation available vs unavailable;
- conflicting observations with a resolvable discriminator;
- ambiguous charter where reversible exploration remains safe but consequential commitment does not.

Compare at least:

1. ordinary free-form response;
2. `proposition + basis + conclusion`;
3. `proposition + basis + conclusion + residual`;
4. `proposition + basis + conclusion + residual` with an evidence-recovery opportunity before disposition.

The experiment should measure whether explicit residuals and evidence recovery improve the selective-commitment risk–coverage frontier rather than merely increasing refusal.

## Shadow disposition tests

The first implementation should stop before real gate behavior and compute a shadow disposition only. At minimum, fixtures/tests should demonstrate:

- **wording invariance** — rhetorical certainty cannot change deterministic interpretation;
- **missing-binding rejection** — stale/unbound basis cannot become current because the conclusion says it is;
- **residual-erasure resistance** — omitting a residual cannot satisfy an independently required completeness condition;
- **contradictory-assessment handling** — disagreement has an explicit deterministic policy state rather than implicit Judge sovereignty;
- **resolving-evidence transition** — adding valid, current resolving evidence can legitimately change the shadow outcome;
- **consequence sensitivity** — one assessment can permit reversible work while blocking a load-bearing effect;
- **cold-handoff control** — the experiment can omit upstream assessments from a cold reviewer while retaining them in the ledger for later adjudication/audit;
- **selection-policy separation** — changing consequence policy may change disposition without mutating the underlying assessment;
- **no confidence selector** — rhetorical or numeric self-confidence cannot satisfy a positive-evidence requirement;
- **summary non-authority** — a lossy human/model summary cannot substitute for the bound assessment record at a deterministic decision boundary;
- **unsupported-extension safety** — an unknown assessment extension cannot be ignored in a way that strengthens authority or erases unresolved state.

## First run: shadow dispositions over retrodicted episodes (2026-08-24)

`ci/assessment-shadow.ts` is the first implementation this document asks for: a pure function from
`(records, harness facts, policy)` to a disposition plus typed causes, touching no real gate. The
worker-authored part of a record is exactly the four fields above; binding, provenance and
completeness are the harness-owned envelope of each `AssessmentRecord`, and observation
availability, required surfaces and carried blockers are `HarnessFacts` the worker cannot write.
Rationale text, summaries and confidence fields are read nowhere in the module, which is how wording
invariance is established rather than tested for. Unknown extension keys are read only to be listed
as unsupported: they never contribute, and on evidence that would otherwise permit a consequential
commit they fail closed (`withhold`), because the harness cannot know whether the extension would
have weakened the record. A carried blocker is cleared only by a refutation that is itself current,
complete, and not awaiting reassessment.

`docs/assurance/assessment-fixtures.json` retrodicts seven episodes with known outcomes — the #625
stale grep, #495 carry with and without an explicit refutation, the #435 false chokepoint, the #555
GitHub 503, the #593 label-vs-split disagreement, and a mediated charter intake where the human
supplied preferences and explicitly left the optimization policy open (the case the stacked
charter-normalization slice carries as a fixture) — and
`ci/__tests__/assessment-shadow.test.ts` demonstrates each of the eleven shadow-disposition
properties against them. The risk–coverage table across the four conditions this document names:

| condition | commits | unsupported commits | unnecessary withholding |
|---|---|---|---|
| face-value (the last record's verdict taken at face value, standing in for a free-form read — not a free-form review) | 4/7 | 3 | 2 |
| proposition + basis + conclusion | 3/7 | 1 | 1 |
| + residual | 2/7 | 0 | 1 |
| + residual + evidence recovery | 4/7 | 0 | 0 |

What this does and does not show. The second row is the full envelope minus residuals — binding,
basis, completeness, carried blockers and contradiction handling. Binding rejection recovers the
justified landing that face-value withheld (#625: the stale charter was the last word); carried-blocker
survival refuses #495's silent re-push and completeness refuses #555's UNKNOWN mergeability — the two
face-value commits that had no current evidence. That row still commits on #435, whose unit tests
were green and whose gap was a path the guard never saw — exactly the shape only a residual carries —
and it already withholds #593 as a contradiction, so the residual row's one unnecessary withholding is
inherited, not introduced: residuals cost zero justified coverage in this corpus. Recovery then reaches
face-value coverage with zero unsupported commitments, and the #593 recovery is a reassessment
permitted by a resolved residual, not a residual clearing itself. Two caveats keep this an experiment rather than a result: the
fixtures were authored with hindsight, so a residual is present wherever history showed one was
needed — the open question is whether workers write material residuals *without* hindsight, which
only live records can answer; and seven episodes is a demonstration, not a measurement.

## Explicit omissions

Do not add in this experiment unless fixtures demonstrate a need:

- numeric confidence or confidence thresholds;
- an uncertainty-status taxonomy;
- first-class warrant/applicability objects;
- Actor as a new assurance-graph node kind;
- a universal `abstain` gate result;
- `suggestedAction` in the durable assessment grammar;
- full SACM/GSN argument graphs;
- real gate changes;
- authoritative `supports`/`challenges` edges.

## Developer-delight bar

The worker-facing interface should feel like supplying four semantic fields, not completing an assurance form. Empty/common cases should not require boilerplate such as `residual: []`, timestamps, SHA fields, provider names, or confidence values when the harness already owns or can infer them.

The harness should automatically provide record identity, binding, provenance, validation, correlation/fingerprinting where useful, serialization, and completeness bookkeeping. Stable opaque identities are preferred over IDs that encode changing semantic classifications.

The maintenance goal is **small authored core, rich derived capability**: models/humans author only semantic facts they uniquely know; the harness owns observable custody/state facts; question/projection layers derive useful views without creating duplicate authoring obligations.

## Success / falsification

This slice earns further plumbing only if structured assessments materially improve one or more of:

- correct identification of the proposition actually being assessed;
- traceable basis for the conclusion;
- detection of stale/scope-inapplicable evidence;
- explicit preservation of material residuals across hand-offs;
- acquisition of the right resolving evidence when obtainable;
- the selective-commitment risk–coverage frontier;
- reduction in unsupported consequential commitments without pathological withholding;
- auditability without transcript-scale verbosity;
- cross-agent reuse of the same bound semantic premises without requiring identical prose/synthesis;
- lower human/model bookkeeping by keeping harness-observable facts out of the authored payload.

It should be considered a failed or overfit abstraction if models mostly emit decorative caveats, residuals cannot be made material/falsifiable, the structure causes large unnecessary-refusal rates, evidence recovery does not improve useful coverage, deterministic policy still has to semantically parse prose to know whether authority exists, or later agents must trust summaries because the durable record failed to preserve the distinctions needed for reinterpretation.
