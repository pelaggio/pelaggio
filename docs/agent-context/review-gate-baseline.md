---
title: Review-gate landing-cost baseline
description: What the fleet gate actually costs, measured from persisted records, so a throughput claim can be tested instead of asserted.
status: draft
diataxis: explanation
---

# Review-gate baseline (instrumentation)

Reproduce with `npx tsx ci/review-metrics.ts`. Source is `.dev/pr-review-gate-records/` — one
record per roll, written by the harness at gate time. This is measurement, not a check: the script
exits 0 and prints a table.

Cost is the fleet's own reported spend and is **mostly notional** against a subscription pool. Read
*rolls* and *wall-clock* as the scarce resources; cost is their proxy.

## Baseline as of 2026-08-24 (81 rolls, 29 PRs, 2026-08-05 → 2026-08-24)

| Measure | Value |
|---|---|
| rolls per PR | **2.79** |
| single-roll / repeat-roll PRs | 13 / 16 |
| PRs that ever reached a pass | **11 of 29 (38%)** |
| cost per roll | $37.47 |
| cost per passing PR | **$275.92** |
| survivors per block | 2.94 |
| splits stamped `invalid-pass` | **56 of 81 (69%)** |

Against the campaign target of *≤1 re-review pass per landing*, actual is 2.79 rolls per PR. Against
the ~$20/shipped-cycle budget heuristic, actual is $275.92 per passing PR.

One PR dominates: #589 (#554) took **15 rolls and $784.79 — 26% of the entire corpus — and never
passed**. Any median-based reading of this table understates the tail risk; the distribution is what
matters, not the average.

## The finding that matters: `consensus-block` has never occurred

| agreement | gate | rolls |
|---|---|---|
| `consensus-pass` | pass | 11 |
| `disagreement` | block | 56 |
| `invalid` | block | 14 |
| `consensus-block` | block | **0** |

Every pass was unanimous. **Every block was a split or a broken run.** In 81 rolls the fleet has
never once agreed that something was broken.

Three consequences follow, and they are the reason this baseline exists.

**1. The operating regime is a one-vote veto, not convergence.** ADR-0024 describes review as a
panel that resolves to convergence. What the records show is that a single reviewer blocks, the
others pass, and the gate blocks. That may well be the correct fail-closed posture for a security
gate — the point is that it is not what the architecture says it is, and cost therefore scales with
the most pessimistic reviewer in the pool rather than with the defect rate.

**2. `ASM-0002` is now measurable, and it is under strain.** The shadow assurance graph records
*"provider-diverse review improves defect detection enough to justify its incremental cost, latency,
and failure surface"* as an assumption. This table is the first evidence against it: 62% of gated
PRs never reached a pass, and the single most expensive PR never converged at all. That does not
falsify it — the counterfactual (defects that diversity caught and a single reviewer would have
missed) is not in this data, and #589's round-1 gate did catch a real bypassable parser. But the
assumption can no longer be held without a `wrong-if:` that this table can test.

**3. The dominant epistemic state has no representation.** 69% of rolls are a complete, structurally
valid split — `ok=true`, `agreement=disagreement` — stamped `breaker=invalid-pass` (#593). The
adjudicator receives "invalid" for what is actually *"three reviewers say yes, one says no, and the
disagreement is about a falsifiable question nobody settled."* This is not an edge case to be
relabelled; it is the system's normal state, and the gate has no vocabulary for it.

## What this baseline is for

Any claim that a process change improves landing throughput — the assurance/assessment stack,
`review.carry` (#605), seat parallelism (#547), quorum-of-2 (#578) — is testable against these
numbers. The pre-change values to beat are **2.79 rolls/PR**, **38% ever-pass**, and
**$275.92/passing PR**.

Re-run after the change and compare. A change that moves none of them did not improve throughput,
whatever else it improved.

## Encoding loss: the second instrument

Throughput is not the only question. A model of requirements and invariants can be valuable while
changing no metric above, so representational adequacy needs its own instrument — otherwise it is
graded by the same judgment it exists to discipline.

**Protocol.** Take a real episode with complete records and a known outcome. Encode it. Classify
everything that does not survive the encoding:

| bucket | meaning | verdict it supports |
|---|---|---|
| **semantic gap** | inexpressible without a new primitive | the ontology is missing something real |
| **lossy flattening** | expressible only by collapsing a distinction that mattered | a role or relation is too coarse |
| **authoring-cost gap** | expressible, but nobody would have written it at the time | the model is correct and will not be used |
| **no-value** | expressible, would have been authored, but the answer was already obvious | the model is decorative here |

The last bucket is the one that kills ontologies, and it is `#624`'s *"findings that ordinary review
or charter work already discovers just as well"* made countable.

**Prefer retrodiction to reconciliation for the first run.** Encoding a finished episode is cheap,
has a control, and can fail. A broad reconciliation sweep over current HEAD is expensive and, absent
an instrument, grades its own homework. If the model cannot losslessly hold an episode we already
watched happen, a sweep will not produce a more trustworthy answer.

**First fixture: #589 / #554.** Complete records across 15 rolls, and three known encoding
challenges already visible:

- a false *operational* assumption recorded as settled fact (#617 stated the token-leak half was
  closed; it was not) — the graph holds 56 propositions of which only **3** are assumptions, and all
  three are architectural, so this class currently has nowhere to live. `charter-contract.md`'s
  `A-n` + `wrong-if:` ledger models the same thing and the two do not reference each other;
- a durable lesson that is neither invariant nor constraint — *a guard must not depend on validating
  state the adversary can write* — a rule about how guards may be **built**, which is the
  "negative replacement constraint" conflation `#616` itself flags;
- a live 3-vs-1 disagreement on a falsifiable question (git config scope precedence for URL-specific
  keys) that no current node or edge can carry.

## First run: retrodicting #589 / #602 / #625 (2026-08-24)

Encoded against the graph as it stands on `docs/charter-normalization-experiment` (the top of the
#616 → #622 → #623 stack, which carries all three slices). Three fixtures, all with complete records
and known outcomes.

**Headline: the graph as drafted would not have caught any of the three.** In every case the failure
is *coverage and attachment*, not semantics — which is the useful result, because it names what has
to change rather than whether to continue.

### Fixture A — #625, the unwired seat env denial

The proposition **exists and is correctly stated**: `TC-014` — *"driver child environments are
minimized and captured logs are scrubbed"* — plus `CLM-0003` (*"workers receive only necessary
credentials"*). Both are sourced from ADR-0010.

Both have **zero implementing realizations**. So would the reachability query — *"does every
realization implementing P appear on a live call path?"* — have fired? **No. It would have found
nothing to check and passed vacuously.**

| | |
|---|---|
| bucket | **authoring-cost gap** (not semantic) |
| expressible? | yes — a `CTR-*` node with `codeEvidence` is exactly the shape |
| authored? | no, and nothing forces it |

Coverage is the whole story:

- **5 realizations for 56 propositions**; only 14 propositions (25%) have any `implements` edge.
- **All 8 public `TC-*` trust claims have zero implementing realizations** — TC-003, 004, 005, 010,
  011, 012, 013, 014. These are the guarantees the public trust manifest *publishes*.
- The 5 realizations that exist cover pipeline topology and review orchestration — the areas #616
  set out to demote from durable intent — not the security mechanisms.

**The test that should have caught this points the wrong way.** `shadow-assurance.test.ts` Q10 is
*"every realization exists to implement or derive from a decision/proposition"* — it iterates
realizations and asserts each has a purpose edge. A proposition with **zero** realizations passes
trivially. The direction that matters for #625 is the inverse: which propositions — especially
published `TC-*` ones — claim a guarantee with no mechanism linked, and does that mechanism appear on
a live path?

### Fixture B — the #589 construction lesson

The durable lesson was *"a guard must not depend on validating state the adversary can write."*

It has **no legal attachment point**. `constrains` runs `proposition → [proposition, decision]`, and
across the whole relation vocabulary **`realization` is never a legal target of any relation**.
Realizations can only point outward. So a rule governing how mechanisms may be *built* can only be
encoded as a proposition constraining decisions, which loses its actual force — it applies to any
future construction, including ones with no decision node.

| | |
|---|---|
| bucket | **lossy flattening**, shading into semantic gap |
| what is lost | that the rule binds construction, not intent |

This is `#616`'s own flagged conflation — "negative replacement constraint" — showing up as a
concrete miss rather than a stylistic worry.

### Fixture C — the 3-vs-1 disagreement

Unencodable, **by design**: Q12 asserts that observations cannot support or challenge intent before
Assessment exists, and `supports`/`challenges` are deliberately absent.

The part worth flagging is that **merging the full stack does not close this.** #622 defines the
Assessment grammar but states *"Assurance graph impact: None"* — it adds no nodes, edges, or
relations. So after #616 + #622 + #623 all land, the dominant epistemic state of this system (69% of
rolls; see the baseline above) still has nowhere to live in the graph.

| | |
|---|---|
| bucket | **semantic gap, deliberate** |
| closed by the stack? | **no** — #622 is a grammar and a ratchet, not graph nodes |

### What would have to change for the graph to earn its keep

Three specific, cheap, testable changes — each falsifiable against these fixtures:

1. **Invert the coverage test.** Assert proposition → realization, not realization → purpose. Start
   by requiring every published `TC-*` claim to name a mechanism. Today that check fails 8 for 8,
   which is the point: it would have been a standing red flag rather than a silent pass.
2. **Make `realization` a legal relation target** so construction rules can bind mechanisms. Without
   it, the single most transferable lesson of the day cannot be written down.
3. **Add a reachability predicate over `codeEvidence`** — a named symbol must appear on a live call
   path, not merely exist. `buildClaudeSeatEnv` has a file, a definition, and thorough tests; what it
   lacks is a caller. Existence checks pass; reachability checks fail. That distinction is the whole
   finding.

### Correction to the earlier reading

On first seeing #625 I said it was "hard evidence for the graph" because per-PR review inspects a
diff and cannot see reachability. The first half holds — #589's own 15 rolls missed it and #602's
roll found it by accident of which diff was under review. The second half does not: **the graph in
its current form would have missed it too**, for a different reason. The class of query is right; the
instance has no data to run on.

That is a better outcome than a confirmation would have been. It converts "should we invest in this?"
into three concrete changes with a pass/fail fixture attached to each.
