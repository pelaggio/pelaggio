---
title: "ADR-0013: Reversibility-weighted gate sizing"
status: accepted
date: 2026-07-19
claims: []
---

# ADR-0013 — Reversibility-weighted gate sizing

## Context
Gate rigor can be sized by **lifecycle stage** (Boehm: defects caught earlier are exponentially cheaper, which justifies heavy upfront gates) or by **reversibility**. Boehm's curve is largely a Waterfall-era artifact; for a minutes-per-cycle system with automated tests and cheap re-runs it measures near-flat upstream — a bad plan is a cheap re-plan, a bad implement is a discarded worktree.

## Decision
Gate strength is a function of **reversibility, not lifecycle stage**. Heavy, deterministic gates only at **irreversible boundaries** — merge-to-main (phantom-ship guard, ship verification, fail-closed review-survival, CI green) and an escaped safety defect. **Light-and-escalating** gates everywhere reversible — item spec, plan, discarded worktree. Explicitly reject Boehm's cost-of-change curve as the justification for heavy upfront spec/grooming gates.

This is the meta-principle that unifies the heavy merge gate with the light-upstream posture of [ADR-0011](./0011-andon-not-dor.md)/[ADR-0012](./0012-readiness-computed-not-groomed.md), and it is what makes the throughput dial ([ADR-0015](./0015-autonomy-by-default-configurable-tolerance.md)/[ADR-0016](./0016-severity-taxonomy-and-owner.md)) safe to turn: reversible gates may be loosened freely; irreversible ones may not.

## Alternatives not taken
- Lifecycle-stage weighting — over-gates upstream where the ROI is not there for this system.
- Uniform max-rigor everywhere — too slow to be autonomous.

## Consequences
- (+) Concentrates rigor where a mistake is expensive; enables automating the reversible majority (the basis of [ADR-0015](./0015-autonomy-by-default-configurable-tolerance.md)).
- (−) Requires honesty about what is actually reversible: merge-to-main is mechanically revertable but poisons downstream cycles until reverted, so it is treated as the one heavy boundary rather than as "cheap because git-revert exists."
