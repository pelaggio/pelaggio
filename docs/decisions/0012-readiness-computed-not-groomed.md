---
title: "ADR-0012: Readiness is computed and escalated, not human-groomed"
status: proposed
date: 2026-07-19
claims: []
---

# ADR-0012 — Readiness computed, not groomed

## Context
Orthodox agile has humans groom the backlog to a Definition of Ready. An unattended loop has no human at pull time, and [ADR-0011](./0011-andon-not-dor.md) rejects a rigid human-authored gate. But "readiness" is still a useful signal for scheduling and for catching malformed-at-birth items.

## Decision
Definition-of-Ready is a **soft, machine-checkable readiness verdict** computed by `FlowPolicy` over a snapshot (self-contained body, deps done, testable outcome, scope set) that can route to escalation — **not** a human-authored checklist that blocks the queue. Take INVEST's **Independent / Testable / Small / Estimable** as the machine-checkable inputs (Independent → the non-intersecting-write-set scheduling precondition; Testable → the shakedown gate; Small/Estimable → the sticky, plan-time job-size). **Valuable / Negotiable** stay chartering-time human concerns. Replace "humans groom the backlog" with "the harness computes readiness on-read and refines by escalation." The verdict's *action* (park vs. proceed-and-note) is a tolerance-dial setting ([ADR-0015](./0015-autonomy-by-default-configurable-tolerance.md)), not a hard gate.

## Alternatives not taken
- A standing human grooming ritual — does not scale to unattended operation and weaponizes the backlog.
- A rigid DoR gate — rejected in [ADR-0011](./0011-andon-not-dor.md).
- Recomputing job-size at pick time — the flow invariant warns this thrashes the ranking; job-size is sticky and computed at plan time.

## Consequences
- (+) Readiness scales without a human and without rubric drift (one plan-time signal, not a second pick-time one).
- (−) "Is this worth doing" (Valuable/Negotiable) still needs a human at charter — accepted; that is genuinely a human judgment.
- (−) Depends on the #170 projection for the snapshot the verdict reads.
