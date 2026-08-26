---
title: Corpus convergence
description: A proposal to author governing project knowledge once and derive every representation that can be derived, and the four-pass experiment that tests it.
status: draft
diataxis: explanation
---

# Corpus convergence (design)

**Status: RFC.** Nothing here is adopted. This document records a proposal, an experiment that
tests part of it, and a recommendation about sequencing. Per RFC-before-ADR, the settled decision
— if one is reached — belongs in a re-founded ADR-0027, not here.

## 1. The complaint

Governing knowledge is authored independently in several places: ADRs, the `AGENTS.md` invariant
index, the trust registry, agent-context design docs, charter material. Each must be kept in sync
by hand to preserve the same semantic truth. The count of Markdown files is not the problem; the
count of **independently maintained statements of project truth** is.

## 2. The proposal, in brief

A durable project corpus whose semantic kernel is **proposition, decision, evidence, relationship**,
with records and relationships carrying provenance, authority, scope, status, time and uncertainty
only where those semantics are required.

Several concepts become **views rather than stores**: canon (currently applicable governing
knowledge), specification (a scoped projection of it), precedent (prior governing knowledge bearing
on a judgment), context (what is assembled for one operation), and indexes.

Two operations sit above it: **judgment** (a governed decision under explicit authority and
uncertainty) and **reconciliation** (investigating divergence between governing knowledge and the
realized project, where a valid outcome may be to change the implementation, change the corpus,
gather evidence, or escalate).

Graph structure is a *representation*, not part of the ontology or the product contract.

`Realization` must justify itself against that kernel rather than be preserved by assumption.

## 3. Phases, and their disposition here

| Phase | Content | Disposition |
|---|---|---|
| I | Re-found ADR-0027 on the reduced kernel; falsify Realization | **Recommended** — one ADR rewrite, and §5 supplies a falsification fixture |
| II | Authoring cutover: `/document` distinguishes semantic / narrative / construction change | **Recommended, and first** — see §4 |
| III | Corpus conformance: source-first coverage, identity, provenance, competency fixtures | Deferred |
| IV | Projection engine | Deferred |
| V | `/reconcile` skill and legacy-authority inventory | Deferred |
| VI | First vertical migration (`AGENTS.md` Project Invariants) | Deferred |
| VII | Legacy-authority ratchet in CI | Deferred |
| VIII | Documentation burn-down | Deferred |
| IX | Reconcile pelaggio against itself | Deferred |
| X | Delete the migration scaffolding | Deferred |

Deferral here is a park with a trigger, not a rejection. The trigger for III–X is stated in §6.

## 4. Why the cutover should come first

The proposal sequences the ADR rewrite (I) before the authoring cutover (II), while stating the
principle the other way round: *before migrating historical material, stop creating new
duplication.*

The cutover is a **ratchet**. It stops new duplication accruing, and it pays off even if no other
phase ever ships. The ADR rewrite is valuable but inert on its own. Sequencing II first also tests
A-2 cheaply: if `/document` cannot distinguish semantic from narrative change without the
re-founded kernel to reference, that is discovered for the cost of one skill edit.

## 5. The experiment

A successor-scoped corpus was authored **as data** — nodes and edges in one file, with a domain
checker and a renderer — and put through four provider-diverse review passes. Artifacts and
per-pass snapshots are in [`data/corpus-experiment/`](./data/corpus-experiment/).

### 5.1 What it does not show

**It did not converge.** Findings by pass: **17 → 15 → 13 → 17**. Node count rose 39 → 47 and
nothing was ever removed. Per-node churn shows 20 nodes stable across all four passes and 21
edited, with the five most-edited all belonging to one idea.

The experiment is recorded as a result, not as a proposal. Its corpus is not offered for adoption.

### 5.2 What it does show

**Derivation eliminates a real defect class.** Before generation, three encodings of the same 35
edges — node annotations, an edge table, a coverage table — disagreed *inside one document
authored in one sitting*. Three findings of one pass were that drift. Generating all three from
one source made the class structurally impossible, and it did not recur in any later pass. This is
the proposal's central claim, demonstrated on an artifact rather than argued.

**Realization was never wanted.** The corpus reached 47 nodes with zero realization records. An
antecedent mechanism is not a realization of a graph that describes a different system, and
recording one would repeat the path-existence weakness ADR-0027 decision 4 already concedes. This
is evidence for the kernel reduction, and it would dissolve the #629 / #635 / #636 cluster rather
than shipping it.

**A checker at write time catches what review otherwise bills for.** Enforcing relation domains,
requiring a falsifier on every assumption, rejecting an edge whose endpoint is not a corpus node,
and refusing causal-outcome language outside an assumption each removed a class that a prior review
pass had charged for. The last rule also **over-fired on the author's own sentence** — recorded
here because a blunt rule that occasionally refuses good prose is a different thing from a rule
that lets a thesis back in, and the trade should be made knowingly.

### 5.3 The honest reading of non-convergence

Three explanations are live and this document does not choose between them:

1. The corpus was over-specified — 19 constraints where perhaps five general rules would do. One
   pass found the corpus enumerating site-by-site what its own construction rule says to hoist.
2. The most-churned idea was the newest and least settled, and was carrying the others down.
3. A document of this kind cannot be settled by this loop, and the method rather than the artifact
   is at fault.

A-3 in the charter names the observable that distinguishes them.

## 6. Program falsifier

The proposal carries discipline within each phase and none for the program. It should carry one,
by its own rule that uncertainty must not become certainty through repeated inference:

> **Wrong-if.** If registered legacy-authority surfaces do not monotonically decrease across
> successive landings once III begins, the migration is not converging and parks. Deferred phases
> III–X activate only when landing capacity supports a multi-PR program; the trigger is a
> sustained landing rate, not a decision to begin.

## 7. Guardrails carried forward

Stated in the proposal and worth keeping visible, because §5's experiment strained two of them:

- Do not create a graph product. *(In tension with a projection engine, a `/reconcile` skill and a
  CI ratchet — that tension is unresolved and should be named in any ADR that adopts them.)*
- Do not import a general knowledge-graph ontology.
- Do not model implementation topology unless a consequential question requires it.
- Do not make generated prose authoritative independently of its inputs.
- Do not allow model inference to acquire authority through repetition.
- Do not grow ontology to satisfy a renderer or a query implementation. *(§5's node count rose in
  every pass under review pressure; the guardrail was not sufficient to prevent it.)*
- Do not delete historical rationale because current intent is represented structurally.
- Do not preserve migration machinery after the migration needs it.
