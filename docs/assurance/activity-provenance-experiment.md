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

`operation` is semantic (for example `charter.normalize`), not a tool/skill name. A `/charter` skill, a hosted form, or a consumer implementation may all perform the same operation. Today **no record owns `operation`**: every existing artifact identifies a step, provider, model, run, or flow transition, so projecting `charter.normalize` from them would mean inferring it from the carrier — the coupling this experiment exists to remove. The candidate binding point is the one chokepoint every carrier already passes through, `npx pelaggio roadmap create-item`, which the harness owns and which can record the operation, the implementation identity/version, and — for an out-of-cycle invocation — mint the execution identity the model must not author.

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
- `FlowEventEnvelope.executionId`, `causationId`, item/claim identity, and attempt — **planned**, not existing (`AGENTS.md` still tags flow `(flow, planned)`); today's production emitters write item-less lifecycle events with `itemId: null` and never set `claimId`, `causationId`, or `attempt`.
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

## First run: the eight blind normalization runs, from persisted artifacts only (2026-08-24)

The runs were direct-service invocations (read-only agents, no skill, no pipeline cycle). Answering
the nine questions from the run record alone:

| # | question | answerable? | from |
|---|---|---|---|
| 1 | what raw intent was supplied | yes | the issue body snapshot the run record points at |
| 2 | which normalization activity transformed it | **unanswerable** | no record owns `operation`; the record's `design` prose says so, which is a model/author-authored statement, not a binding |
| 3 | which implementation/version performed it | model-authored only | model name in the record; no skill/service revision, no harness stamp |
| 4 | which actor/principal initiated or mediated it | model-authored only | the session author, written by the session author |
| 5 | what repository/item/run/attempt context applied | partial | repository and issue number yes; no run or attempt exists to bind |
| 6 | which normalized assessment/output it produced | yes | the JSON block per run |
| 7 | which material residuals remained | yes | `residuals` per run |
| 8 | which principal resolved each residual | unanswerable | none were resolved; no resolution record shape exists |
| 9 | reconstructable without knowing a skill existed | yes, trivially | no skill was involved — which is why this mode cannot test carrier independence |

Three of nine answerable from harness-owned facts, three more only because the author wrote them
down, three not at all. The three confirmed gaps are exactly the three the inventory above added:
execution identity, operation identity, implementation/version binding. Nothing here argues for a
`SkillInvocation` node — the missing facts are bindings a chokepoint can record, not a new kind of
thing — but representation B is not yet answerable either, and the interactive human-mediated mode
(the one that exercises questions 4 and 8) has not been run.
