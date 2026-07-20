---
title: "ADR-0014: Mechanism/policy separation is the harness spine"
status: accepted
date: 2026-07-19
claims: []
---

# ADR-0014 — Mechanism/policy separation (the spine)

## Context
The system's invariants are scattered across the codebase and docs — typed item-scoped effects, `FlowPolicy` sees a snapshot not storage, `STEPS` as the tabular source of truth, `ship.target` owns merge behavior, `MODEL_PROFILES` not pinned in skills, egress-broker mechanism vs. a versioned caps fixture. They share one organizing principle that is stated nowhere as a citable decision.

## Decision
Record the spine: **determinism lives in the harness (mechanism, fixed and audited); judgment lives in the worker (the LLM); they meet only at a typed, fail-closed, capability-denied seam. Policy is data, not code.** Corollary: the **blocking** gate is always deterministic (fingerprint-survival, parse-validity, `--network=none`, integer micro-USD caps, host-computed write-sets); the LLM is reserved for the judgment band and is never itself the gate. This is the correct response to the result that probabilistic supervision of a probabilistic black box furnishes no deterministic security lower bound — you cannot prompt-engineer a lower bound, so the teeth must be deterministic.

## Alternatives not taken
- Model-adjudicated blocking gates — no deterministic lower bound; launders model uncertainty into landed change.
- Policy hard-coded into mechanism — not swappable per provider or ship target; re-imports the drift the seam removes.

## Consequences
- (+) One citable principle for reviewing any new agent-facing seam: "is the blocking decision deterministic, and is policy expressed as data?"
- (+) Unifies the scattered invariants under a single decision.
- (−) Some choices that *feel* delegable to the model (readiness, dissent handling) must be kept as deterministic-or-configured policy, not model discretion.
