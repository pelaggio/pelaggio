---
title: "ADR-0022: Pipeline shape — fixed steps, policy-triggered review, distinct cold/authoring orchestrators"
status: proposed
date: 2026-07-21
claims: []
---

# ADR-0022 — Pipeline shape and review orchestrators

## Context
The pipeline is a fixed `STEPS` sequence; review appears twice **outside** `STEPS` (an in-cycle authoring loop and a post-ship CI gate). A proposal to unify all work under one "node graph" was considered and rejected. This ADR records why the shape is what it is, and what the first uniformity slice is, so future changes neither relitigate the shape nor over-abstract it. Parts of this decision already ship; parts are chartered — each clause below is labeled.

## Decision
- **`STEPS` stays the fixed six** (`pick → plan → shakedown-plan → implement → shakedown-code → ship`). **Shipped.** `implement` is **not** split — its codegen↔verify interleave is load-bearing.
- **Review is policy-triggered, not a pipeline step**, via two **distinct orchestrators**: the authoring review loop (`runReviewLoop`, per-pass, inside `shakedown-code`) and the CI gate (`runPrReviewGate`, a bare `runStep` entrypoint). **Shipped** (both exist; `STEPS` length is 6).
- **The CI gate stays cold / out-of-context** — a bare `runStep`, outside the mutable `step()` checkpoint/effects lifecycle. Its isolation is a **product guarantee, not debt**. **Shipped.**
- **First uniformity slice — chartered-not-built (#337 first slice / #268):** review-seat provider-selection routes through the same `resolveDriverCandidates` + capability path as steps, with `author ≠ reviewer` and provider-diversity kept in a thin policy overlay. The review-seat seating types exist; the provider-neutral resolution is not yet wired.
- **Review provenance — chartered-not-built:** typed `review.Verdict` / `review.Escalation` effects on the **authoring path only** — **not yet present in `effects.ts`, even as reserved kinds** (its reserved vocabulary is currently only `pick.explainSelection` and `shakedown.deferredItems`); reserving these kinds and adding authoring-path handlers is chartered-not-built, and the cold CI gate is not required to emit them.

## Alternatives not taken
- **A uniform `Node` interface + `trigger` attribute** (`in-sequence | per-pass | gate`) — a rename, not a collapse: the three orchestrators (sequential `STEPS`, `runReviewLoop`, `runPrReviewGate`) still exist behind it; the attribute buys documentation, not consolidation.
- **Splitting `implement` into codegen + verify nodes** — reintroduces the cascading-error failure mode the interleave exists to prevent.
- **Folding the CI gate into the `step()` wrapper** for uniformity — would risk the cold/fresh-session guarantee for no benefit on a read-only gate.
- **A general DAG scheduler / capability-DAG constraint DSL** — hand-rolls Kubernetes taints/tolerations + Bazel platform constraints; unneeded, and rejected in prior review.

## Consequences
- (+) The pipeline stays a small, auditable, fixed cycle; uniformity is achieved at the selection and provenance seams (ADR-0020 / ADR-0021), not by a node-graph rewrite.
- (+) The CI gate's cold isolation is explicitly protected against future "unify everything" pressure.
- (−) Review orchestration remains two code paths; the uniformity lives in selection/provenance, not a single orchestrator.
- (−) Until #268 wires provider-neutral seat resolution, non-Claude reviewer seats are not first-class.

Builds on ADR-0021 (review is an `agentic-loop` node; verdict provenance as effects); specializes ADR-0014.
