---
title: Review-gate landing-cost baseline
description: What the fleet gate actually costs, measured from persisted records, so a throughput claim can be tested instead of asserted.
status: draft
diataxis: explanation
---

# Review-gate baseline (instrumentation)

Reproduce with `npx tsx ci/review-metrics.ts --until 2026-08-25`. Source is
`.dev/pr-review-gate-records/` — one record per roll, written by the harness at gate time. This is
measurement, not a check: the script exits 0 and prints a table.

**Corpus is frozen and fingerprinted: `82:e7615e16408b`.** The live corpus grows while you work, so a
figure quoted without a cutoff stops matching its own reproduce command within hours — which happened
to the first version of this document. Pass `--until` to reproduce a published figure; omit it to
measure the live corpus.

Cost is the fleet's own reported spend and is **mostly notional** against a subscription pool. Read
*rolls* as the scarce resource. Cost is an imperfect proxy for it, and **wall-clock is not measured
here at all** — see the gap noted below before using this to judge anything latency-shaped.

## Baseline (82 rolls, 30 PRs, 2026-08-05 → 2026-08-24)

| Measure | Value |
|---|---|
| **re-review rolls per landing** | **1.64** (target: ≤1) |
| rolls per gated PR | 2.73 |
| single-roll / repeat-roll PRs | 14 / 16 |
| PRs that ever reached a pass | 11 of 30 |
| cost per roll | $37.25 |
| cost per passing PR | $277.65 |
| survivors per block | 2.94 |
| splits stamped `invalid-pass` | 57 of 82 |

**Re-review rolls per landing is the figure to compare against the campaign target**, and it is the
only one dimensionally equal to it: rolls beyond the first, counted over the 11 PRs that actually
passed. Rolls-per-gated-PR (2.73) is a different quantity — it includes first rolls and the 19 PRs
that never passed — and quoting it against a per-landing target overstates the miss. There are **zero
same-SHA retries** in this corpus, so every roll is a genuine re-push rather than an infra retry.

The cost is concentrated, and the median landing is fine: 5 of the 11 passing PRs landed on their
first roll. The mean is carried by #553 (5 re-reviews), #599 (4), #592 (3), and #576 (3). Separately,
#589 took 15 rolls and $784.79 — 26% of the corpus — and never passed at all.

## `consensus-block` has never occurred — and that is by design

| agreement | gate | rolls |
|---|---|---|
| `consensus-pass` | pass | 11 |
| `disagreement` | block | 57 |
| `invalid` | block | 14 |
| `consensus-block` | block | **0** |

Every pass was unanimous; every block was a split or a broken run.

**This is the designed behaviour, not a divergence from it.** ADR-0024: *"A genuine split between
successfully-parsed reviewer verdicts parks before the Judge, for all ship targets — a deterministic,
fail-closed gate."* `roadmap-and-ship.md` likewise makes disagreement terminal and red. A split block
is the contract working. An earlier draft of this document read the same table as evidence that the
operating regime had drifted from the architecture; that reading was wrong, and the two are also
different systems — these records come from the cold `pr-review` gate, while ADR-0024 governs the
pre-commit authoring loop.

What the table does support is narrower and still useful:

**1. The blocking decision is nearly always a minority one, and cost follows the most pessimistic
reviewer.** That is intended for a security gate; the observable consequence is that fan-out width
sets the block rate, which is what makes quorum-of-2 (#578) and seat parallelism (#547) worth
measuring rather than assuming.

**2. `ASM-0002` is now measurable, and it is under strain.** The shadow assurance graph records
*"provider-diverse review improves defect detection enough to justify its incremental cost, latency,
and failure surface"* as an assumption. 19 of 30 gated PRs never reached a pass, and the most
expensive never converged. This does **not** falsify it — the counterfactual (defects diversity
caught that one reviewer would have missed) is absent from this data, and #589's round 1 caught a real
bypassable parser. But the assumption now needs a `wrong-if:` this table can test.

**3. The label is stale, though the adjudicator is not.** 57 of 82 rolls are complete, structurally
valid splits (`ok=true`, `agreement=disagreement`) still stamped `breaker=invalid-pass` (#593). Since
#525/#592 landed, `isEligibleFleetGateRecord` **accepts** that shape, so adjudication is no longer
blocked by it. What remains is vocabulary: neither the record nor the graph can express *which*
reviewers split or *over what*, so the rationale reaches a human only as prose in the gate comment.

## Cycle-side view: what a gate outcome costs the pipeline (2026-08-26)

The baseline above measures the gate from its own records. The **cycle log** measures the same loop
from the other end, and `npx pelaggio stats` already reports it — park cause is a closed
classification (`ParkClass`, see `classifyParkReason`) persisted on the record and rendered by
cause. Read that command first; the figures below are one reading of it, frozen so this section's
claims stay checkable.

**Corpora frozen: cycle log `208:758e3652c593`, PR list `256:d5920706a550`.**

| Measure | Value |
|---|---|
| cycles (2026-07-13 → 2026-08-24) | 208 — completed 97, failed 60, parked 51 |
| parked by cause | `review-escalation` 13 · `review-blocked` 11 · `rate-limit` 5 · `unrecorded` 22 |
| distinct items that ever parked | 33 |
| parked items that completed a later cycle | 26 of 33 (median park → completion 0.9 h) |
| **parked items whose PR merged** | **0 of 33** |
| **cycles consumed by those 33 items** | **117 of 208** |

The `unrecorded` 22 predate park classification; `stats` shows them as unknown rather than folding
them into a real class, so they are not evidence for any cause. Their terminal step is
`pr-review` or `pr-verify` in all 22 cases, which is suggestive and not a classification.

Two reader's notes, because both produced wrong readings before they were found:

- `CycleResult.error` carries the literal string `parked` on a parked cycle (its docstring says so).
  A count of non-empty `error` therefore reports 111 failures where there are 60. `stats` already
  separates the two; a hand-rolled parser will not.
- Failure cause is **not stored** — `stats` derives "failed by cause" by prefixing the free-text
  `error`, so it is as coarse as those strings. Park cause, by contrast, is stored and closed. The
  asymmetry is the open half.

Genuine failure rate by week, parks excluded: 26%, 29%, 27%, 28%, 46%.

## Known gap: wall-clock is not instrumented

This document calls wall-clock the scarce resource and then does not measure it. That matters most
for exactly the interventions it names: **seat parallelism (#547) can improve landing latency without
moving rolls-per-landing, ever-pass, or cost-per-landing at all.** So "a change that moved none of
these did not improve throughput" is false as stated for latency-shaped changes. Gate records carry
`reviewedAt` and `turns` but no elapsed duration; adding one is the obvious next instrument.

## What this baseline is for

Claims that a process change improves landing throughput — the assurance/assessment stack,
`review.carry` (#605), seat parallelism (#547), quorum-of-2 (#578) — are testable against these
numbers. The values to beat: **1.64 re-review rolls per landing**, **11 of 30 ever-pass**,
**$277.65 per passing PR** — with the wall-clock caveat above.

## Encoding loss: the second instrument

Throughput is not the only question. A model of requirements and invariants can be valuable while
changing no metric above, so representational adequacy needs its own instrument — otherwise it is
graded by the same judgment it exists to discipline.

**Protocol.** Take a real episode with complete records and a known outcome. Encode it. Classify
what does not survive:

| bucket | meaning | verdict it supports |
|---|---|---|
| **semantic gap** | inexpressible without a new primitive | the ontology is missing something real |
| **lossy flattening** | expressible only by collapsing a distinction that mattered | a role or relation is too coarse |
| **authoring-cost gap** | expressible, but nobody would have written it at the time | the model is correct and will not be used |
| **no-value** | expressible, would have been authored, but the answer was already obvious | the model is decorative here |

The last bucket is what kills ontologies, and it is `#624`'s *"findings ordinary review or charter
work already discovers just as well"* made countable.

**Prefer retrodiction to reconciliation for the first run.** Encoding a finished episode is cheap,
has a control, and can fail. A sweep over current HEAD is expensive and, absent an instrument, grades
its own homework.

## First run: retrodicting #589 / #602 (2026-08-24)

Encoded against the graph on `docs/charter-normalization-experiment` (top of the #616 → #622 → #623
stack).

### Fixture A — withdrawn. The premise was wrong, and the instrument found that out

**#625 is closed as invalid.** `buildClaudeSeatEnv` *is* wired: `spawnClaudeSeat` narrows the env at
`claude-seat.ts:614` and passes `env: childEnv` to spawn, with a second call at `:671` for the
preflight probe — the seat-boundary placement #625 proposed as its own fix. The finding came from a
`git grep … | head` whose limit was filled by the test file's matches, hiding the production call
sites.

What is true, and is simply #589's job: **main** has no `buildClaudeSeatEnv`, so there is no
Claude-seat env narrowing on main today; **#589 introduces and wires it**. PR #602's gate finding —
*"#554 env denial is not on the Claude path"* — is correct against **main**, the merge base it
reviewed, and is a sequencing artifact rather than a permanent gap.

The salvageable result is not the intended one. The reachability predicate built for this fixture
(`ci/assurance-reachability.ts`), run against the #589 tree, reported the symbol **reachable** —
contradicting the charter, two rounds of reasoning, and a public issue. **The mechanized check was
right where the hand-read evidence was wrong.** That is evidence about grep-based reasoning being
unreliable, not about the assurance graph, which had no node for this mechanism either way.

Two caveats before trusting the predicate further:

- Its first run reported the symbol reachable because **the checker's own doc comment named it** as
  the worked example — the failure mode it exists to catch, reproduced by itself. Comments and string
  literals are now blanked before matching.
- `CLAUDE_SEAT_PASSTHROUGH_ENV_VARS` is genuinely defined-but-unreferenced and legitimately so, being
  documented as exported only for a conformance test. Deliberate test-only exports need an allowlist.

### Coverage — verified independently of Fixture A

- **5 realizations for 56 propositions**; only 14 propositions (25%) have any `implements` edge.
- **All 8 public `TC-*` claims have zero implementing realizations.** Six of those are
  `status: guarantee` (TC-003/004/010/011/012/014); TC-005 is `best_effort` and TC-013 is `planned`,
  and those two are honestly reporting an absent mechanism rather than a gap.
- The five realizations are **not** all topology and review orchestration, as an earlier draft
  claimed: CTR-0004 (worktree confinement) and CTR-0005 (the signed safety-taxonomy gate) are
  security mechanisms. Three of five cover pipeline and review shape.
- `shadow-assurance.test.ts` **Q10 points the wrong way**: it iterates realizations and asserts each
  has a purpose edge, so a proposition with *zero* realizations passes trivially.

**Since this run (2026-08-24, #616 head).** The coverage figures above describe the graph as it was
when the run happened. Reconciliation on the #616 branch since then: the trust registry is enumerated
from its source (15 records; 7 were absent from the graph, four of them guarantees), seven mechanisms
that already existed were named as realizations (`claude-seat.ts`, `secret-hygiene.ts`, the daemon
bearer auth, `check-publish.ts`, the pull-request ship default, the egress broker, the fail-closed
verdict parsers), so the Q14 unlinked-guarantee baseline is now **1** (TC-002, whose registry evidence command
is a denylist grep — evidence, not enforcement) over the full registry rather than 6 over the
represented subset, and the baseline is frozen so it can only shrink; realizations are 18 for 69
propositions, and three internal invariants honestly name none (verifiable custody, single-source
intent, no undeclared egress); `adrMap` is derived from node `sources` (they had
drifted for five ADRs); ADR-0028 and the AGENTS.md invariant index are
mapped (Q16); and the six debt checks the `debt` view declares are all implemented. `Q10 points the
wrong way` still holds and is complemented, not replaced, by Q14.

### Fixture B — the #589 construction lesson

The durable lesson: *"a guard must not depend on validating state the adversary can write."*

It had **no legal attachment point**. `constrains` ran `proposition → [proposition, decision]`, and
`realization` was never a legal target of any relation, so a rule governing how mechanisms are
*built* could only be encoded as one governing intent. **Bucket: lossy flattening.** This is #616's
own flagged "negative replacement constraint" conflation appearing as a concrete miss.

### Fixture C — the 3-vs-1 disagreement

The vote split is **not** recoverable from the gate record. `agreement=disagreement` proves only that
at least one reviewer passed and one blocked; it carries no counts and no rationale. The 3-vs-1 shape
came from the gate's prose output, not from persisted structured evidence — which is itself the
finding, and a sharper one than "the graph cannot hold it."

Unencodable in the graph by design: Q12 asserts observations cannot support or challenge intent
before Assessment exists. **Merging the stack does not close this** — #622 states *"Assurance graph
impact: None"*, adding no nodes or relations. **Bucket: semantic gap, deliberate.**

### What the run established, and what was done about it

Fixture A's premise collapsed. Fixtures B and C and the coverage numbers stand, and two changes
landed on the #616 branch in response:

1. **Q14 inverts the coverage direction** — does every published *guarantee* name a mechanism?
   Baseline 6, ratcheted so it may only shrink. Scoped to `guarantee` status so it cannot fire on
   claims honestly published as `planned` or `best_effort`, which would be an over-refusal under the
   `guarded-actions.md` §8.1 bar.
2. **`constrains` may target a realization**, and `CON-0027` is the first such rule. It binds
   `CTR-0004` as a live instance rather than an illustration: worktree confinement decides from
   observed Git porcelain/ref state, which the seat can write, and a `.git/config` rewrite produces
   no porcelain delta at all.

Reachability over `codeEvidence` is **not** proposed as a third change. Its instrument exists and is
cheap, but its motivating example evaporated and it has not been shown to catch anything the ordinary
process missed.

A methodological note outlasts all three fixtures: **the confirmed errors of this run were in the
analysis, not the system.** A truncated grep produced a false charter that survived two PR comments
and a written document; a baseline table drifted from its own reproduce command within hours; a
conclusion about architectural drift contradicted the ADR it cited. Each was caught by a mechanical
check or an adversarial reader, none by re-reading. Whatever else the assurance work is for, that is
the pattern it should be built to interrupt — including in documents like this one.
