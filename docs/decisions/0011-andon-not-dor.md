---
title: "ADR-0011: Spec quality is runtime Andon, not upstream Definition-of-Ready"
status: proposed
date: 2026-07-19
claims: []
---

# ADR-0011 — Andon-not-DoR

## Context
An underspecified item reaching an unattended overnight queue has no human to disambiguate at pull time. The orthodox fix is a Definition-of-Ready gate at intake. But a rigid DoR gate blocks the queue and is the local optimization the DoR literature warns against, and Boehm's cost-of-change curve (the usual justification for heavy upfront gates) is near-flat for a minutes-per-cycle, discard-the-worktree system: a bad plan is a cheap re-plan, a bad implement is a discarded worktree (see [ADR-0013](./0013-reversibility-weighted-gate-sizing.md)).

## Decision
Enforce spec quality at **runtime by produce-or-escalate (Andon)**, not by an upstream DoR gate. The driver attempts the spec and escalates — routed through the `blocked` step subtype — only when it detects it cannot produce a correct result (IEEE-830 Conflict / Omission / Ambiguity map to the escalation triggers). This is fail-closed applied to specs; the default biases **escalate-and-park over ship-on-doubt** for spec defects (the inverse of the review loop's ship-and-record default, because a spec defect makes the work genuinely undoable, not merely document-and-proceed). *Target-state:* the `blocked` marker sentinel exists today; the typed payload, the cross-seat retry, and the set-status write-back are the seam this ADR commits to completing (see Consequences).

**Escalation policy.** A block triggers **one decorrelated retry** — a fresh attempt, on a *different seat/provider where available*, so the retry tests the spec rather than one model's bias. A second, **reproduced** block escalates to a human. Reproducibility across independent attempts is the deterministic, un-gameable honesty gate — it replaces an evidence-adjudication gate. Where no alternate provider is configured the retry is **same-seat and therefore correlated**: it is recorded as a *weaker* signal, and a single-provider deployment may prefer to escalate on the first block rather than trust a correlated re-run. `missing-decision` / `external-dependency` blocks (which a retry cannot resolve) escalate on the first block.

## Alternatives not taken
- Rigid human-authored DoR checklist at intake — stalls the unattended queue; optimizes the intake team's throughput at the expense of end-to-end flow.
- An evidence-bar honesty gate ("does the block cite good enough evidence?") — a judgment call and gameable; reproducibility is stronger and deterministic.

## Consequences
- (+) The unattended queue never stalls on an upstream human gate; blocks are rare (most self-resolve on the retry) and therefore high-signal.
- (+) Block reasons become telemetry on where chartering is weak — feedback into charter, not a gate.
- (−) Occasionally burns a cheap cycle discovering a defect mid-flight that a heavy upfront gate might have caught — acceptable under reversibility-weighting ([ADR-0013](./0013-reversibility-weighted-gate-sizing.md)).
- (−) Depends on completing the `blocked` seam (typed payload + set-status write-back + not-a-failure reclassification). Pairs with [ADR-0012](./0012-readiness-computed-not-groomed.md).
