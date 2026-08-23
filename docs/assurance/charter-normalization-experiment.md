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

## Goal-vs-proposition falsification

This experiment is also the admission filter for the candidate `Goal` concept. A normalized outcome does **not** automatically become a Goal.

After normalization, ask whether the outcome can be represented correctly and economically using existing propositions/decisions/realizations. A Goal is only plausibly earned when the desired outcome survives mechanism replacement, recurs across materially different decisions/workstreams, and enables a consequential `why`, `what remains`, or `what conflicts` question that proposition-only representation cannot answer without distortion or duplication.

Tiny repairs and maintenance work should normally resolve to existing semantics without manufacturing local goals.

## Historical fixtures

`charter-normalization-fixtures.json` captures historical Pelaggio cases selected because later project history supplies strong counterexamples, plus a partial-mediation case where a human adds useful preferences without closing the optimization policy.

These fixtures ratchet semantic expectations, not natural-language generation. CI does not claim it can derive the normalized statement from the raw issue text. Model interpretation remains probabilistic and should be evaluated separately across agents.

## Falsification

Compare at least:

1. raw charter -> plan/review;
2. raw charter -> normalization -> current proposition/decision/realization graph -> plan/review;
3. the same normalized charter plus a candidate Goal layer.

Evaluate whether early normalization avoids historically known false commitments, preserves stated constraints and user intent, reduces downstream review churn, avoids needless abstraction for small work, allows partial human mediation without forced closure, and whether Goal materially improves durable explanations beyond proposition-only semantics.

Reject or narrow this experiment if normalization mostly restates the request, increases friction on bounded work, strips meaningful user constraints, causes independent models to invent incompatible objectives, coerces humans into false closure, or if a Goal layer adds no consequential answerability after normalization.
