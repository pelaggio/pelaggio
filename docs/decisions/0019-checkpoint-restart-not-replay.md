---
title: "ADR-0019: Checkpoint-restart durability, not deterministic replay"
status: accepted
date: 2026-07-19
claims: []
---

# ADR-0019 — Checkpoint-restart, not deterministic replay

## Context
Durable-execution engines (Temporal-style) survive crashes by **replaying** recorded workflow code with recorded side effects — which demands deterministic workflow code. Pelaggio's "workflow" is a non-deterministic LLM whose re-run legitimately takes a different path (the "book a different flight on replay" problem).

## Decision
Adopt the **goal** of durable execution (survive crashes/rate-limits, resume) but **deviate from its mechanism**: **checkpoint-restart at step boundaries** — `parkExit` checkpoints the whole step, `--resume` re-enters fresh — not deterministic replay. Borrow only the **bracket-intent / confirm-then-reconcile** pattern for effects: record the intent, let ground truth win on resume, never replay the LLM and pretend it produced the same event.

## Alternatives not taken
- Temporal-style deterministic replay — would require freezing model outputs, killing the driver-neutral, model-upgradeable design.

## Consequences
- (+) Durable *and* model-upgradeable; resume is lossless because work is checkpointed at step boundaries.
- (−) No free-lunch deterministic replay of a whole cycle; re-entry is coarse (step-granular). Documents existing behavior (`parkExit`, `--resume`, flow-event intent/confirmation brackets).
