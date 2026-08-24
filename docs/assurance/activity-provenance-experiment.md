# Activity provenance experiment

Status: **experimental / shadow-only**.

This experiment tests whether charter normalization and other semantic operations need a new assurance-graph primitive for "skill invocation context", or whether the required facts are already expressible as execution/provenance activity plus Actor/Assessment/binding metadata.

## Hypothesis

Do not add a `SkillInvocation` ontology node. Treat invocation as a generic **Activity view** over existing provenance whenever possible. Skills, CLI commands, hosted UI actions, MCP/tool calls, pipeline steps, and consumer-owned implementations are replaceable carriers for the same semantic operation.

A new primitive is earned only if a consequential provenance question cannot be answered correctly, traceably, and economically by composing existing execution identity, causation, actor/seat identity, input/output bindings, versions, and assessment/resolution records.

## Competency question

For an admitted charter, can we determine:

1. what raw intent was supplied;
2. which normalization activity transformed it;
3. which implementation/version performed the activity;
4. which actor/principal initiated or mediated it;
5. what repository/item/run/attempt context applied;
6. which normalized assessment/output it produced;
7. which material residuals remained;
8. which principal, if any, resolved each residual; and
9. whether a later consumer can reconstruct the same chain without knowing that a Claude-style "skill" existed?

If those answers are recoverable from existing provenance and future Actor/Assessment records, no new ontology primitive is justified.

## Candidate derived Activity view

This is a projection, not a promoted schema:

```text
ActivityView {
  operation                       # semantic, harness-recorded at the chokepoint that performs it
  executionId / runId / attempt?  # absent for an operator-invoked /charter outside a cycle today
  causationId?
  actorOrSeat?
  implementationIdentity?
  implementationVersionOrDigest?
  repositoryBinding?
  itemBinding?
  inputRefs[]
  outputRefs[]
  residualRefs[]
  resolutionRefs[]
}
```

Fields should be derived from owned records where possible. In particular, harness-observed execution identity, run/attempt context, git binding, provider/model/version, and durable receipt/evidence identity must not be re-authored by a model.

`operation` is semantic (for example `charter.normalize`), not a tool/skill name. A `/charter` skill, a hosted form, or a consumer implementation may all perform the same operation. Today **no record owns `operation`**: every existing artifact identifies a step, provider, model, run, or flow transition, so projecting `charter.normalize` from them would mean inferring it from the carrier — the coupling this experiment exists to remove. There is no chokepoint every carrier passes through: a consumer-owned implementation uses its own storage, a direct caller can create items without normalizing, and the first run below normalized existing issues without creating anything. For the pipeline carrier the harness can record the operation, the implementation identity/version, and the execution identity; for an operator-invoked `/charter` the harness's only touchpoint today is `create-item`, which does not perform the normalization and so cannot honestly stamp it; for consumer-owned carriers the contract can only require that *some* harness-equivalent records those bindings — the semantic-not-carrier requirement restated.

## Invocation-mode test cases

The experiment must cover the same normalization semantics under at least these paths:

- **interactive human-mediated** — model proposes a normalization, asks a material question, and an authorized human response may resolve, narrow, or add preferences while leaving a residual;
- **autonomous/harness-mediated** — model proposes a normalization but cannot invent a human-value choice; unresolved residual remains explicit;
- **direct semantic service** — an implementation invokes the normalization operation without a skill abstraction;
- **consumer-owned implementation** — a consumer project records equivalent provenance using its own storage/tooling.

Changing the carrier must not change semantic meaning or silently transfer authority.

## Existing provenance, and what it does not reach

Current Pelaggio records carry context, but almost none of it attaches to a normalization performed at charter intake:

- `CycleProvenance.runId`, git binding, Pelaggio/driver versions, and execution receipts — exist for pipeline cycles only. `charter.normalize` is not a `STEPS` member; an interactive `/charter`, a direct `create-item`, or a consumer implementation emits no `CycleProvenance`, `StepLog`, or receipt.
- `StepLog` step/provider/model/attempt/result provenance — same limit: step-scoped, in-cycle.
- `FlowEventEnvelope.executionId`, `causationId`, item/claim identity, and attempt — the envelope and a ULID `executionId` **ship** (`types.ts`, `createEventWriter` in `flow-events.ts`), so a model-independent execution identity does exist for anything the writer emits; but today's production emitters write item-less lifecycle events with `itemId: null` and never set `claimId`, `causationId`, or `attempt`, and nothing emits for a charter intake — the identity exists, the attachment does not.
- review seat identity and `ReviewResolution.actor` — review-escalation only; no charter-intake analogue.
- ai-delivery source mapping for authorship, run metadata, policy, evidence, and resolution — delivery-scoped, downstream of intake.

The experiment therefore treats **raw-input binding**, **normalized-output/assessment binding**, and **human mediation/residual resolution binding** as candidate gaps to measure, not evidence that a new node already exists — and adds three the first inventory missed: **execution identity for out-of-cycle invocations** (there is none the model did not author), **semantic-operation identity** (no record owns `operation`), and **implementation/version binding** (the model name is known; the skill or service revision that ran is not). Representation B must be measured against all six before it can answer the competency question traceably.

## Falsification

Fixtures and procedure: the corpus is the eight blind normalization runs recorded in
`charter-normalization-run-2026-08-24.json` (four issues × two models), plus any later intake that
leaves persisted artifacts. For each run, attempt the nine competency questions **from persisted
artifacts only** — no re-reading of transcripts, no asking the model — and record per question
`answerable`, `answerable-but-model-authored`, or `unanswerable`, with the artifact that answered it.
A binding gap is confirmed when a question is unanswerable across every carrier; it is a
carrier-specific gap when one mode answers it and another does not.

Compare two representations:

A. a new persisted `SkillInvocation`/`Invocation` node authored for every operation;

B. a derived `ActivityView` over existing provenance plus the minimum missing bindings.

Prefer B unless A answers a consequential question that B cannot answer without ambiguity or hidden prose reconstruction.

Reject or narrow the Activity view if it requires independently re-authoring facts already owned by execution provenance, if operation identity cannot remain stable across carriers, or if human mediation cannot be represented without inventing invocation-specific authority semantics.

Promote a generic Activity primitive only if repeated real cases require durable identity/relations that cannot be represented as an execution/provenance projection. Never promote `SkillInvocation` merely because current clients happen to use skills.

## Runs

The eight blind normalization runs in `charter-normalization-run-2026-08-24.json` are the first
corpus for the procedure above (one carrier: direct service). Scoring them against the nine
questions, and what that says about the candidate gaps, is argued in the reconciliation campaign
(#624), not here.
