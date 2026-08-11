---
title: "ADR-0026: Stateful guards — fence-or-reconcile classification and gate disposition"
status: proposed
date: 2026-08-07
claims: ["TC-003", "TC-013"]
construction: docs/agent-context/guarded-actions.md
---

# ADR-0026 — Stateful guards: fence-or-reconcile classification and gate disposition

This **amends [ADR-0004](./0004-review-gate-fails-closed-shakedown-fails-safe.md)**. ADR-0004's fail-closed posture remains; this decision distinguishes a real blocking judgment from a bounded inability to evaluate, without allowing unavailable evidence to clear a blocker.

## Context

The recurring guard failures are three modeling conflations: **a check is not a hold**; **an attempt marker is not an outcome marker**; and **cannot evaluate is not evaluated as bad**. Point fixes repeatedly added blocking edges without giving those states authoritative ownership or a recovery transition.

The durable decision is the semantic rule replacements must preserve. The concrete primitives, cause tables, quota/token machinery, attempt register, retry implementation, and current guard audit live in [`guarded-actions.md`](../agent-context/guarded-actions.md).

## Decision

Numbering is **stable**: these are the original ten decision slots. Four were absorbed into
surviving decisions or demoted to construction by the 2026-08 re-cut and are marked *withdrawn* in
place, with a pointer to what carries their rule. They are not renumbered, because a citation that
carries only a number does not dangle when numbering moves — it mis-resolves onto a different rule,
silently. See [`README.md`](./README.md#citing-a-decision).

1. **Every load-bearing guarded action is fenced or reconciled.** A fence is enforced by the authority that owns the state; a reconciled effect is idempotent and converges under an observer. Anything else is a hint and may not carry correctness.
2. **Derived exclusivity is valid only while its authoritative claim remains valid.** A derived target does not create authority of its own; if the derivation or liveness premise fails, the action loses the exclusivity guarantee.
3. *(withdrawn — construction.)* The reconciler **contract** (idempotency key, claim-with-crash-recovery, liveness-gated reclaim) is construction and lives in [`guarded-actions.md`](../agent-context/guarded-actions.md). Its durable half is the constraint *a time lease is not liveness*, below.
4. **Blocking state is typed and recoverable.** Every absorbing state without progress names the transition that can clear it and the actor authorized to perform that transition. Completion is not required to have a recovery edge.
5. **Judgment, evidence completeness, and disposition are distinct.** Agent/model output is evidence or judgment. Harness authority resolves the resulting disposition under explicit policy and typed causes. The merge/delivery path consumes the disposition, not raw model output.
6. *(withdrawn — absorbed into 5.)* "Evidence is completeness, not diversity" — `complete | partial | unavailable` describes how much of the required matrix ran, never how varied it was. Carried by decision 5 and by the evidence/cause matrix in `guarded-actions.md`.
7. **Unavailable evidence cannot erase an unresolved blocker.** Disposition is default-deny over typed causes; omission is not refutation. A blocker survives until complete, valid verification explicitly removes it.
8. **A retryable/indeterminate outcome is bounded and actionable.** It exists only where a retry actor is actually available; it never represents success, and exhaustion becomes a blocking state with a named clearer.
9. *(withdrawn — construction.)* Quota and token are two primitives, not one: quota (dollars) is divisible and refundable, a token is not. Carried by the quota/token primitives in `guarded-actions.md` §7.3.
10. *(withdrawn — promoted to a constraint.)* "Attempt identity is an authority, not a naming convention" is now the constraint *attempt freshness must be unforgeable by the agent*, below, because it binds any implementation rather than describing one.

## Constraints on any implementation

- **A time lease is not liveness.** Fixed expiry alone can reclaim live work. Destructive reuse/reap requires a positive liveness basis, and terminal effects must remain fenced or idempotently reconcilable.
- **Self-validation is not fencing.** A stale actor cannot establish its own freshness. The authority consuming an effect must reject superseded attempts, or the effect must route through a harness-owned authority that can do so.
- **Attempt freshness must be unforgeable by the agent.** Any attempt identity used for authority must be allocated from harness-owned state the agent cannot rewrite or roll back. Authentication without anti-rollback freshness is replayable.
- **Omission is never refutation.** A later reviewer's silence, an unavailable cell, or a partial matrix cannot clear a carried blocker that was never explicitly refuted by valid isolated verification.
- **Evidence completeness and failure cause must remain separate.** Equal amounts of missing evidence can arise from materially different causes and must not automatically receive the same disposition.
- **Unavailability is an allowlist, never a default.** Infrastructure-flavoured failure cannot be wholesale reclassified as retryable; some such failures are themselves safety signals.
- **A non-actionable block must not consume a one-shot revision entitlement.** Work that no revision can fix cannot burn the authority to perform the future revision that may actually be required.
- **The clearing actor belongs to the blocking state.** Changing a retryable condition into a block must not create an exit-less state.
- **Positive completion beats absence.** Reconciliation cannot infer success merely because work disappeared from a listing; terminal completion requires positive evidence.
- **Ordering cannot substitute for authority.** Locks, queues, serialized orchestration, or pre-checks may reduce contention but cannot replace a fence/reconciler at the state-owning authority.

## Alternatives not taken

- **A bigger/better lock.** A local ordering mechanism cannot repair authority it does not own.
- **One FSM over the whole pipeline.** Re-encoding lifecycle topology does not solve the ownership, attempt, or evidence/disposition conflations.
- **Reclassifying infrastructure failure wholesale to `indeterminate`.** That erases safety-relevant distinctions between causes.
- **Retry without a retry actor.** That merely renames a permanent block as an indefinitely pending state.
- **Continuing to point-fix.** The repeated failures are instances of shared semantic classes; preserving only individual fixes guarantees the class will recur.

## Consequences

- (+) New guards can be reviewed against a finite semantic test: identify the state-owning authority, fence or reconciler, terminal evidence, and recovery actor.
- (+) Fail-closed states remain safe without becoming necessarily permanent.
- (+) Provider/runtime incidents can be represented separately from genuine blocking findings without allowing partial evidence to merge.
- (+) Attempt lineage can reject superseded actors instead of merely naming their artifacts differently.
- (−) Existing guard call sites must be audited; many current locks and predicates remain hints rather than correctness boundaries.
- (−) Durable retry and authoritative attempt identity require construction work before the corresponding dispositions can safely become active.

## Construction

[`docs/agent-context/guarded-actions.md`](../agent-context/guarded-actions.md) is the canonical construction/evidence home: the guard audit and classification map, concrete fence/quota/token/attempt/reconciler/liveness primitives, lifecycle tables, evidence/cause matrix, normative aggregation order, retry mechanics, implementation checklist, and sequencing.
