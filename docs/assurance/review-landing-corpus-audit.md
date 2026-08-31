# Review and landing corpus audit

Status: **experimental / non-authoritative migration work**.

This audit applies a stricter admission bar to the records selected by the shadow corpus's
`review` and `landing` views. It is deliberately bounded: the result is evidence for corpus
convergence, not a declaration that the remaining corpus is correct. IDs below refer to
`shadow-graph.json`; their statements and relationships remain authored there rather than being
copied into this ledger.

## Admission bar

The bar is about semantic responsibility, not how interesting a record sounds.

- **Invariant:** a consequential property an implementation replacement must preserve. It states
  an obligation, not a mechanism, preference, or observation.
- **Constraint:** a harness-binding boundary necessary to preserve governing intent. A violation
  can make a construction unacceptable; a repository convention, diagnostic, or preferred
  mechanism is insufficient.
- **Decision:** a controlling or historical choice by an authority among credible alternatives.
  It materially narrows strategy, policy, risk, or future construction and can be superseded
  without becoming truth.
- **Assumption:** a material uncertain premise with at least one dependent choice. It names either
  a counterexample that settles the claim or a trigger to revisit it; a finite sample is not called
  a universal refutation unless the proposition is scoped to that sample.
- **Realization:** a bounded statement about what exists now, linked to the decision or proposition
  it realizes. Code paths and passing observations establish freshness, not semantic proof; the
  relationship must not claim a property the mechanism itself says remains unbuilt.

For every retained record, deletion must either change a consequential competency answer or lose
necessary meaning, discrimination, history, or traceability. Presentation inconvenience does not
earn a record, relation, or node kind.

## Review dispositions

| Record | Disposition | Reason / action |
|---|---|---|
| `CLM-0008` | retain commitment | Review and delivery outputs require independently verifiable custody; current realization remains unresolved. |
| `CLM-0009` | retain commitment | Preserving established blockers across omission is mechanism-independent and consequential. |
| `CLM-0016` | retain commitment | Cold or independent evaluation must survive review-topology replacement. |
| `CLM-0019` | retain commitment | The deterministic safety floor governs review disposition independently of reviewer strategy. |
| `CON-0008` | retain constraint | It binds any review/carry implementation and supplies the negative conformance rule for `CLM-0009`. |
| `ASM-0002` | retain and refine assumption | `DEC-0014` depends on the diversity bet. Replace the over-strong `wrongIf` with a `revisitIf`: one controlled sample can force reconsideration without universally settling provider diversity. |
| `DEC-0012` | retain construction decision | Fixed steps and separate orchestrators are replaceable topology, correctly represented as a choice rather than durable intent. |
| `DEC-0014` | retain construction decision | Concurrent reviewers, Judge, and bounded revision are a selected strategy with a named assumption and alternatives. |
| `DEC-0003` | retain custody decision | It belongs under the custody commitment, not as a top-level review principle; current construction still names no realization. |
| `DEC-0008` | retain custody decision | The envelope format is a replaceable selected strategy; current construction still names no realization. |
| `DEC-0020` | retain proposed custody decision | Proposed delivery-packet strategy remains distinct from current review topology and must not be presented as built. |
| `CTR-0002` | retain realization with evidence caveat | Distinct authoring/cold paths are current topology. Their relation to independent evaluation rests on the cold-context construction; the named observation proves author exclusion, not the complete context-isolation claim. |
| `CTR-0003` | retain realization with evidence caveat | The multi-seat/Judge loop exists, but its observation establishes split handling rather than complete reviewer independence. |
| `CTR-0012` | retain realization | Typed fail-closed parsers are current machinery directly bearing on blocker preservation and deterministic disposition. |

The two evidence caveats are explicit residuals, not reasons to delete the relationships or to
invent stronger evidence. A later evidence slice may substantiate or challenge them.

## Landing dispositions

| Record | Disposition | Reason / action |
|---|---|---|
| `CLM-0006` | retain commitment | Independent authorization of consequential effects is the governing authority boundary. |
| `CLM-0007` | retain commitment | Candidate-bound, positively evidenced landing survives any particular landing mechanism. |
| `CLM-0013` | retain commitment | Reduced human involvement cannot lower the independent safety floor. |
| `CLM-0018` | retain commitment | Ownership/exclusivity must come from authoritative atomic state, not reconstructed indicators. |
| `CLM-0019` | retain commitment | Shared with Review; deterministic enforcement remains distinct from judgment. |
| `CON-0003` | retain constraint | Advisory checks and ordering cannot acquire enforcement authority through presentation or repetition. |
| `CON-0004` | retain and relate constraint | It is the landing-specific specialization of `CON-0003`: ordering cannot replace a fence or reconciler. Add the missing `specializes` relation while retaining its direct constraint on `CLM-0007`. |
| `CON-0009` | retain constraint | Landing requires positive completion evidence; absence cannot establish success. |
| `CON-0012` | retain constraint | Authorization must consume harness-observed facts rather than worker assertions. |
| `DEC-0002` | retain historical decision | Branch protection is decision archaeology and the construction from which `CTR-0013` derives; `DEC-0015` explicitly supersedes it. |
| `DEC-0015` | retain target decision | Candidate-bound CAS is the selected target strategy and is explicitly not current realization. |
| `DEC-0016` | retain construction decision | Fence-or-reconcile is the controlling guard strategy, not an assertion that every guard is already sound. |
| `CTR-0013` | correct overclaim | Keep the actual red-check reader and its historical derivation, but remove `implements CLM-0007`. The admin path bypasses branch protection and is not candidate-bound; the node cannot simultaneously say the CAS fence is unbuilt and claim the full landing invariant. |

Removing the `CTR-0013 → CLM-0007` implementation edge intentionally makes `CLM-0007` visible as
unrealized debt. This is an honest diagnostic change, not a regression in the implementation.

## Prospective-change competency checks

The audit bar must support developer and agent reasoning about a proposed semantic delta. These are
manual competency fixtures for the next projection pass; they do not add a query family or ontology
primitive.

| Proposed change | The corpus must preserve this answer |
|---|---|
| Replace the fixed six-step/two-orchestrator construction | `CLM-0016` survives; the replacement must preserve intended evaluation independence, while `DEC-0012`, `CTR-0002`, and related topology may be superseded or removed. |
| Reconsider provider-diverse review | `DEC-0014` is shown to depend on `ASM-0002`; #627 is live evidence-bearing work, not corpus authority; safety-floor and blocker-preservation commitments survive either strategy. |
| Replace branch-protection landing | `DEC-0002` remains history, `DEC-0015` is the target strategy, and `CLM-0007` plus `CON-0004`/`CON-0009` state what the replacement must preserve. |
| Remove `CON-0004` | The deletion loses the explicit fence-or-reconcile discriminator even though broader `CON-0003` remains; the specialization makes that loss visible rather than treating the records as duplicates. |
| Claim current landing safety from `CTR-0013` | The corpus must refuse the inference: green-check refusal is current machinery, while candidate-bound concurrency safety remains unrealized. |

For a real change, the answer should also join open issue/charter state at read time. Issues are
mutable records owned by the tracker and do not become durable corpus nodes merely so a projection
can display them.

## Result and next boundary

This slice does not justify a new node kind or wholesale reclassification. It does justify one
assumption-accountability refinement, one missing specialization, and one removal of overclaimed
realization. The larger corpus should be audited with the same deletion and prospective-change tests
before authority promotion or documentation burn-down.

