---
title: Corpus convergence
description: A proposal to author governing project knowledge once and derive every representation that can be derived, and the corpus it is refined against.
status: draft
diataxis: explanation
---

# Corpus convergence (design)

**Status: RFC.** Nothing here is adopted. This document records a proposal, the corpus it is
refined against, and a recommendation about sequencing. Per RFC-before-ADR, the settled decision
— if one is reached — belongs in a re-founded ADR-0027, not here.

## 1. The complaint

Governing knowledge is authored independently in several places: ADRs, the `AGENTS.md` invariant
index, the trust registry, agent-context design docs, charter material, and `docs/assurance/` — the
machine-readable intent graph. Several are enforced in CI — `.github/workflows/ci.yml` is the list —
and enforcement has not made them one authority: each still restates the others by hand, and a check
that a lane is internally consistent says nothing about whether it agrees with its neighbours. The
count of Markdown files is not the problem; the count of **independently maintained statements of
project truth** is.

## 2. The proposal, in brief

A durable project corpus whose semantic kernel is **proposition, decision, evidence** — the three
kinds a record may be. Relations are a typed set over those kinds rather than a fourth kind: a
relation is checked against a declared domain, and carries provenance, authority, scope, status,
time and uncertainty only where those semantics are required. The corpus in §5 declares exactly
this kernel, and Phase I re-founds ADR-0027 on it.

Several concepts become **views rather than stores**: canon (currently applicable governing
knowledge), specification (a scoped projection of it), precedent (prior governing knowledge bearing
on a judgment), context (what is assembled for one operation), and indexes.

Two operations sit above it: **judgment** (a governed decision under explicit authority and
uncertainty) and **reconciliation** (investigating divergence between governing knowledge and the
realized project, where a valid outcome may be to change the implementation, change the corpus,
gather evidence, or escalate).

Graph structure is a *representation*, not part of the ontology or the product contract.

`Realization` must justify itself against that kernel rather than be preserved by assumption — and
that is a live conflict, not a tidy-up. `docs/assurance/` carries `Realization` as a node kind, pinned
by the `nodeKinds` assertion in `ci/__tests__/shadow-assurance.test.ts`. Dropping the primitive from
the kernel leaves the ADR and the lane it governs disagreeing, and that disagreement is what Phase I
adjudicates. The successor corpus does not settle it: a corpus describing a system that does not run
has nothing to realize, so it cannot test the primitive either way.

`Evidence` is unresolved in the same way and is easier to miss, because the corpus has no evidence
nodes at all. Its `evidences` relation runs from evidence directly to a proposition or a decision,
which collapses the separation ADR-0027 requires: *an observation cannot intrinsically support or
challenge architectural intent; any support or challenge is an assessment whose actor, method,
confidence and time can be represented.* A kernel term exercised by nothing has not been validated by
its own corpus, and Phase I adjudicates both primitives or it settles neither.

## 3. Phases, and their disposition here

| Phase | Content | Disposition |
|---|---|---|
| I | Re-found ADR-0027 on the reduced kernel, adjudicating every primitive §2 leaves unresolved — the phase settles all of them or none | **Recommended, and larger than it looks** — not one ADR rewrite. The ADR's text is not what CI pins, so rewriting it alone forks the disagreement in §2 rather than resolving it: the rewrite lands with a migration of `docs/assurance/`, or it should not land |
| II | Authoring cutover: a semantic change is authored as a corpus record rather than as prose, and the store it is written to is created by this phase | **Recommended, and first** — see §4 |
| III | Corpus conformance: source-first coverage, identity, provenance, competency fixtures | Deferred |
| IV | Projection engine | Deferred |
| V | `/reconcile` skill and legacy-authority inventory | Deferred |
| VI | First vertical migration (`AGENTS.md` Project Invariants) | Deferred |
| VII | Legacy-authority ratchet in CI | Deferred |
| VIII | Documentation burn-down | Deferred |
| IX | Reconcile pelaggio against itself | Deferred |
| X | Delete the migration scaffolding | Deferred |

Deferral here is a park with a trigger, not a rejection. The trigger for III–X and the condition
under which the programme stops are recorded in **#670**, which arms the stop condition at VI rather
than III — the legacy-authority inventory is a Phase V product, so nothing measurable exists before
then.

## 4. Why the cutover should come first

The proposal sequences the ADR rewrite (I) before the authoring cutover (II), while stating the
principle the other way round: *before migrating historical material, stop creating new
duplication.*

**The delta is the write target, not the classification.** `/document` already sorts an edit into
semantic, constraint and construction and routes it to a lane — that is the whole of its cut test, and
none of it is new work. What it cannot do is write a semantic change as a *record*, because there is
no store to write one to. So the cutover is the store plus the write path, and everything about
classifying is already spent.

**It is still not a ratchet**, and calling it one would break the guardrail two sections down. Which
lane a change belongs to stays a model's judgment, and by ADR-0014's spine that the model is a policy
input and never the gate, a phase resting on that judgment is a **precheck**. The §3 table places the
ratchet in CI at VII, and that claim belongs to whichever phase the table says carries it.

It should still come first, and the dependency runs the way the sequencing needs. Writing records
needs a store, not a re-founded ADR: an ADR documents a decision and does not gate one, so II does not
wait on I. It is the phase that stops new duplication accruing, which is the principle above stated
plainly, and it pays off even if nothing after it ships. It also tests `A-2` — *the authoring cutover
is separable from the ADR rewrite*, from #670's assumption ledger — by being the thing that either
works without the rewrite or does not.

A precheck that runs first still shapes authoring habits before the migration begins, and that is
worth having. It is simply not the same claim as a ratchet, and the difference is the one this repo
insists on everywhere else.

## 5. The experiment

A successor-scoped corpus was authored **as data** — nodes and edges in one file, with a domain
checker and two renderers that refuse to emit unless it passes. The protocol is that: one source,
checked at write time, with every representation derived from it.

The corpus and its per-pass snapshots are in [`docs/agent-context/data/corpus/`](./data/corpus/),
and its `README` states what the checker enforces. It is no longer offered as an experiment. **It is
the living artifact this RFC is refined against**, and the snapshots are its provenance rather than
its point.

Everything else about it — what the passes changed, what they cost against what the rules bought, the
disposition of `Realization`, and whether a loop of this kind is worth running again — is **recorded
in #670**. That is interpretation, and it belongs where it can be disagreed with without editing this
document. Restating any of it here would put a second copy of a moving fact in the one document
arguing against exactly that.

## 6. Guardrails carried forward

All but the last two came from the proposal. Those two were learned from the corpus, which broke
them.

- Do not create a graph product. *(In tension with a projection engine, a `/reconcile` skill and a
  CI ratchet — that tension is unresolved and should be named in any ADR that adopts them.)*
- Do not import a general knowledge-graph ontology.
- Do not model implementation topology unless a consequential question requires it.
- Do not make generated prose authoritative independently of its inputs.
- Do not allow model inference to acquire authority through repetition.
- Do not grow ontology to satisfy a renderer or a query implementation. *(The corpus grew under
  review pressure in every pass and the guardrail did not prevent it. What has been added since —
  a constraint's `binds`, and splitting an assumption's condition into a refutation or a revisit
  trigger — exists to let the checker refuse a node, which is the opposite trade and should be
  watched all the same.)*
- Do not delete historical rationale because current intent is represented structurally.
- Do not preserve migration machinery after the migration no longer needs it.
- Do not count diagnostics, ordering mechanisms or prechecks as load-bearing enforcement. *(Held as
  a corpus constraint until it was seen to be a rule about how to read a mechanism rather than a
  predicate on one. §4 is the first thing it caught.)*
- Do not restate anything that has another home — a derived value, a mechanism's behaviour, a phase
  the table above already places, or a fact this document defers to. Cite it. *(The drift the corpus
  was built to eliminate reappeared immediately in the prose describing it, and then every defect
  this document accumulated under review was the same shape: a paraphrase of CI configuration, of a
  test assertion, of the phase table, of #670. A citation cannot contradict its source. A paraphrase
  can, and each one did.)*
