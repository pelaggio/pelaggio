# Charter intent normalization experiment

Status: **experimental / shadow-only**.

This experiment tests whether charter intake should separate durable intent from proposed mechanism before planning, while preserving the raw request as attributable source material. It does **not** make normalized intent authoritative, add a `Goal` node to the assurance graph, or require every work item to undergo heavyweight review.

## Hypothesis

A charter should not merely clean up the requested solution into professional prose. Before planning, intake should ask whether the requested deliverable can be completed exactly as stated while the apparent desired outcome still fails.

If the answer is **no** and the work is already bounded, normalization may exit with no material delta. If the answer is **yes or uncertain**, intake should separate the desired outcome from mechanisms, constraints, evidence, assumptions, and residual uncertainty before a planner becomes anchored on the proposed solution.

The raw request remains preserved. Model-produced normalization is an interpretation and carries no authority merely because it was generated earlier in the pipeline.

## Minimal shadow procedure

The candidate intake procedure is intentionally small:

1. **Decompose** the request into candidate desired outcome, stated constraints, proposed mechanisms, acceptance/evidence, assumptions, and unresolved ambiguity.
2. **Attack** the candidate intent with four probes:
   - **mechanism substitution** — if the requested mechanism vanished tomorrow, what outcome would still be wanted?
   - **false success** — can the requested deliverable be completed exactly while the apparent outcome still fails?
   - **alternative success** — can the apparent outcome be satisfied without the requested mechanism?
   - **boundary counterexample** — what plausible edge condition defeats the obvious interpretation?
3. **Normalize** only the smallest outcome statement that survives the probes. Do not turn mechanism into intent merely because it was explicit in the request.
4. **Resolve semantically** against represented propositions, decisions, realizations, and any future admitted goals. Prefer an existing semantic identity; absence of a goal mapping is healthy for repair, preservation, and bounded implementation work.
5. **Preserve residuals** rather than inventing purpose when the interpretation remains ambiguous.

## Early exit

Normalization is not a mandatory essay-producing stage. A bounded request may exit cheaply when no material intent/mechanism confusion is exposed.

The primary early-exit question is:

> Can the requested deliverable be completed exactly as stated while the apparent desired outcome still fails?

A confidently negative answer does not prove the charter correct; it only says this intake-specific falsification found no material normalization delta. Planning, implementation review, and reconciliation retain their own distinct falsification responsibilities.

## Human mediation without forced closure

Human mediation is allowed to **add preference context without eliminating every residual**. The interaction is not a requirements interview that must continue until the model can claim the objective is complete.

When normalization exposes a material human-value distinction, an interactive caller may ask one focused question. The response may:

- resolve the distinction;
- narrow it;
- add operator preferences or trade-off levers;
- explicitly leave the right policy uncertain.

The normalized Assessment must preserve whichever residuals remain. A human saying "I am not sure, but I prefer X over Y in these circumstances" is additional attributable context, not authority to invent a closed objective function.

An autonomous caller follows the same semantic procedure but cannot manufacture the missing human-value choice. It may preserve the residual and continue only to the degree permitted by downstream consequence policy.

## Separation of responsibilities

- **Intake** attacks intent/solution confusion.
- **Planning** attacks whether the proposed design can satisfy normalized intent under the actual architecture.
- **Review** attacks whether the implementation can satisfy its plan while violating intent, governing propositions, or required evidence.
- **Reconciliation** attacks drift between admitted intent and realized consequence.

Moving cheap counterexamples left must not collapse those later responsibilities into intake.

## Derived review-contract projection

Once planning has selected an admitted change, Pelaggio should be able to derive a compact reviewer-facing projection when a non-obvious preservation obligation exists:

```text
ReviewContract {
  change
  invariant?
  evidence[]
}
```

This is a **projection, not a new assurance ontology and not another independently-authored form**.

- **change** comes from the admitted plan/realization delta, not from a mechanism hypothesis at intake;
- **invariant** is the most consequential property the change must preserve, resolved from task-local constraints and/or an existing durable proposition when one applies;
- **evidence** identifies the observations or checks expected to establish that the invariant survived.

The projection therefore depends on **normalized charter + admitted plan**, not charter intake alone. Intake must not prematurely turn a proposed mechanism into `change` merely to fill this view.

A task-local invariant does not automatically become a durable architectural proposition. Conversely, when a durable proposition already expresses the preservation obligation, the review projection should reference/derive from that semantic identity rather than duplicate its wording as a second source of truth.

`Evidence` in this projection is an evidence requirement or expected observation surface. It is not an Assessment conclusion and does not become positive authority merely because a reviewer or model says the check passed. Observation, attributable Assessment, completeness, and deterministic disposition retain the boundaries exercised by the stacked assessment experiment.

The projection is optional. A small bounded change may legitimately have **no non-obvious invariant** beyond ordinary correctness. In that case Pelaggio should not manufacture one for symmetry or ceremony.

### Review-contract falsification examples

The projection should survive at least these shapes without requiring new ontology primitives:

| Change | Invariant | Evidence |
| --- | --- | --- |
| Replace a cache implementation | Concurrent misses for one key still cause only one upstream fetch | Concurrency-focused test/observation at the single-flight boundary |
| Replace retry machinery | Retries must not duplicate externally visible side effects | Failure/retry fixture observing the external effect count |
| Refactor authorization middleware | Untrusted callers cannot gain authority through an alternate path | Boundary tests across every privileged entry path |
| Replace a persistence adapter | Committed state remains reconstructable across interruption/restart | Crash/restart recovery fixture over committed state |
| Rework landing/commit coordination | The exact verified candidate is still the candidate made authoritative | Competing-actor/CAS fixture binding verification to authoritative commit |
| Bump an ordinary dependency with no semantic contract change | _none beyond ordinary correctness_ | Existing tests/build plus dependency-specific checks when warranted |

The last row is a negative control: **material review does not require inventing an invariant for every diff**.

## Goal-vs-proposition falsification

This experiment is also the admission filter for the candidate `Goal` concept. A normalized outcome does **not** automatically become a Goal.

After normalization, ask whether the outcome can be represented correctly and economically using existing propositions/decisions/realizations. A Goal is only plausibly earned when the desired outcome survives mechanism replacement, recurs across materially different decisions/workstreams, and enables a consequential `why`, `what remains`, or `what conflicts` question that proposition-only representation cannot answer without distortion or duplication.

Tiny repairs and maintenance work should normally resolve to existing semantics without manufacturing local goals.

## Historical fixtures

`charter-normalization-fixtures.json` captures historical Pelaggio cases selected because later project history supplies strong counterexamples, plus a partial-mediation case where a human adds useful preferences without closing the optimization policy.

These fixtures ratchet semantic expectations, not natural-language generation. CI does not claim it can derive the normalized statement from the raw issue text. Model interpretation remains probabilistic and should be evaluated separately across agents.

## First run: blind normalization of four fresh issues (2026-08-24)

Record: `charter-normalization-run-2026-08-24.json`. Four open issues not in the fixture corpus
(#611, #613, #615, #617) were normalized blind by two models each (claude sonnet, claude opus)
following the procedure above, with read access to decisions and agent-context only. Arm 1 (raw
charter straight to planning) and arm 3 (a candidate Goal layer) were not run; this isolates the
normalization step.

| measure | result |
|---|---|
| runs / early exits | 8 / 0 — including both runs on the S-scoped #613 |
| requested mechanism leaked into the normalized outcome | 0 / 8 |
| cross-model outcome compatibility | 4 / 4 issues |
| mean cost per normalization | 44k tokens, 12 files read, 149 s |
| stale citation caught (`guarded-actions.md §8.2`, which is on unlanded PR #614) | 4 / 4 runs on the two issues that cite it |
| dependency on a parked item caught (#572 is `deferred`) | 2 / 4 runs on the two issues that depend on it |

What held: every outcome was a property, not the requested mechanism, and the two models' outcomes
were compatible on every issue — the incompatible-objectives failure this document names did not
appear. The counterexamples were the real value, and several are material to the issues as written:
#613's fail-closed clause covers prune *failure*, but a *successful* FIFO prune can evict the record
holding a retained, never-refuted blocker, so the next run carries warm with a truncated history
(CON-0008 violated by the deliverable as specified); #611's binding credential on a
subscription-authenticated seat is an OAuth token in `HOME`, not `ANTHROPIC_API_KEY`, so the charter
as phrased is satisfiable while the seat still holds a reusable credential; #617 has a check-then-act
window between verifying the PR head and preparing the checkout, and once the checkout is
unimpeachable the integrity half migrates to the report the seat still authors.

What did not hold: the early exit never fired. #613 is S-scoped and the request is written as an
implementation directive, yet both runs found a legitimate false-success — so the scope label is not
the bounded-work signal this document assumed, and the friction cost is real: ~44k tokens and two
and a half minutes per intake, comparable to a review seat. The reduction trigger "mostly restates
the request" is not met; "increases friction on bounded work" is met on cost and not on value, and
the document cannot yet say which of those the next run should optimize.

Caveats: one provider, one judge (the session author), four issues, no human mediation exercised, no
downstream comparison of plan/review churn — which is the effect the hypothesis actually predicts.

## Falsification

Compare at least:

1. raw charter -> plan/review;
2. raw charter -> normalization -> current proposition/decision/realization graph -> plan/review;
3. the same normalized charter plus a candidate Goal layer.

Evaluate whether early normalization avoids historically known false commitments, preserves stated constraints and user intent, reduces downstream review churn, avoids needless abstraction for small work, allows partial human mediation without forced closure, and whether Goal materially improves durable explanations beyond proposition-only semantics.

For the derived review contract, compare review with the ordinary plan/diff alone against review with the compact `Change → Invariant → Evidence` projection. Reject or narrow the projection if it duplicates authored semantics, encourages mechanism hypotheses to masquerade as admitted changes, promotes task-local invariants unnecessarily, confuses requested evidence with Assessment authority, or causes negative-control changes to acquire decorative invariants.

Reject or narrow this experiment if normalization mostly restates the request, increases friction on bounded work, strips meaningful user constraints, causes independent models to invent incompatible objectives, coerces humans into false closure, or if a Goal layer adds no consequential answerability after normalization.
