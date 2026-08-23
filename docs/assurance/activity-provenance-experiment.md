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
  operation
  executionId / runId / attempt
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

`operation` is semantic (for example `charter.normalize`), not a tool/skill name. A `/charter` skill, a hosted form, or a consumer implementation may all perform the same operation.

## Invocation-mode test cases

The experiment must cover the same normalization semantics under at least these paths:

- **interactive human-mediated** — model proposes a normalization, asks a material question, and an authorized human response resolves a residual;
- **autonomous/harness-mediated** — model proposes a normalization but cannot invent a human-value choice; unresolved residual remains explicit;
- **direct semantic service** — an implementation invokes the normalization operation without a skill abstraction;
- **consumer-owned implementation** — a consumer project records equivalent provenance using its own storage/tooling.

Changing the carrier must not change semantic meaning or silently transfer authority.

## Existing provenance expected to compose

Current Pelaggio records already carry much of the needed context:

- `CycleProvenance.runId`, git binding, Pelaggio/driver versions, and execution receipts;
- `StepLog` step/provider/model/attempt/result provenance;
- `FlowEventEnvelope.executionId`, `causationId`, item/claim identity, and attempt;
- review seat identity and `ReviewResolution.actor`;
- ai-delivery source mapping for authorship, run metadata, policy, evidence, and resolution.

The experiment therefore treats **raw-input binding**, **normalized-output/assessment binding**, and **human mediation/residual resolution binding** as candidate gaps to measure, not evidence that a new node already exists.

## Falsification

Compare two representations:

A. a new persisted `SkillInvocation`/`Invocation` node authored for every operation;

B. a derived `ActivityView` over existing provenance plus the minimum missing bindings.

Prefer B unless A answers a consequential question that B cannot answer without ambiguity or hidden prose reconstruction.

Reject or narrow the Activity view if it requires independently re-authoring facts already owned by execution provenance, if operation identity cannot remain stable across carriers, or if human mediation cannot be represented without inventing invocation-specific authority semantics.

Promote a generic Activity primitive only if repeated real cases require durable identity/relations that cannot be represented as an execution/provenance projection. Never promote `SkillInvocation` merely because current clients happen to use skills.
