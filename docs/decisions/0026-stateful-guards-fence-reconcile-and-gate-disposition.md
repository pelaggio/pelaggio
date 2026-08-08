---
title: "ADR-0026: Stateful guards — fence-or-reconcile classification and gate disposition"
status: proposed
date: 2026-08-07
claims: ["TC-003", "TC-013"]
construction: docs/agent-context/guarded-actions.md
---

# ADR-0026 — Stateful guards: fence-or-reconcile classification and gate disposition

This **amends [ADR-0004](./0004-review-gate-fails-closed-shakedown-fails-safe.md)**: the review gate still fails closed, but decisions 5–8 change *what it fails closed on*. Causes on the decision-7 allowlist stop producing a blocking verdict and become bounded, retryable `indeterminate`. ADR-0004's fail-closed posture for every other cause — including parse-invalid, which that ADR's two-parser rule governs — is unchanged.

## Context

Locking and fail-closed gating are not converging. Measured at `4a6ac3c`: 74 of the last 400 commits are `fix:`, and the lock/gate/race/claim/land cluster is the largest theme among them. "fail-closed" appears at 57 sites across 24 non-test source files with **no shared type, no shared disposition, and no shared clearing contract** behind any of them. Each new failure mode produces a bespoke guard; each bespoke guard adds a blocking edge; the blocked population grows faster than the hazard population shrinks.

The cost is measured. #453 records ~$260 of stranded work-in-progress created by a fail-closed edge with no release edge. At the time of writing all four open PRs are blocked, holding $136.29 of review spend, and one (#428) is blocked in part by **infrastructure failure misreported as a review verdict**.

The defects are three conflations — modeling errors, not coding errors: **a check is not a hold** (#402, #401); **an attempt marker is not an outcome marker** (#453, #451); **"cannot evaluate" is not "evaluated as bad"** (#428, #455). [ADR-0025](./0025-landing-serialization-cas-fence-optional-ordering.md) solved exactly one instance of the first — landing — well; nothing generalized, because the class of thing landing *is* was never named.

This decision deliberately bundles ten sub-decisions rather than splitting them: the classification rule (1–3) is what makes any single primitive justified, and the gate work (5–8) depends on 9 and 10. The implementing items are split; the decision is one.

## Decision

1. **Every guarded action is fenced, reconciled, or a hint.** *Fenced* — the authority owning the state rejects a stale actor. *Reconciled* — the effect is idempotent and a converging observer repairs drift. Anything else is a **hint**: it may reduce contention, but it is never load-bearing for correctness.
2. **Derived exclusivity satisfies the rule transitively, not as an exception.** An action whose target is uniquely owned by a *fenced* claim is load-bearing only while three conditions hold: the deriving claim is fenced, the target is a total function of that claim, and liveness is verified before reuse or destruction. When the reduction fails, the action is a hint, whatever it looks like locally.
3. **Reconcilers share one contract:** an idempotency key, claim-with-crash-reclaim, a rollback edge, and a **positive** terminal check. Absence from a listing is never evidence of completion.
4. **Absorbing states are typed, and blocking ones carry their exit.** A state is absorbing *with* progress or *without* it. **Every absorbing-without-progress state must name its clearing transition and the actor authorized to fire it.** Completion states are exempt — the earlier "no terminal state without a recovery edge" formulation was incoherent and is rejected.
5. **Judgment is separated from disposition** ([ADR-0014](./0014-mechanism-policy-separation-spine.md) applied to the gate). The model emits a judgment — a *policy input*. The harness computes the disposition deterministically from judgments, evidence, configured policy, typed per-cell causes, the carried candidate-blocker set, and the isolated-verification result. The merge path reads only the disposition, never raw model output.
6. **Evidence is completeness, not diversity.** Evidence describes how much of the required (driver × label) matrix returned a valid result. Provider diversity is *policy*, and enters the deterministic function as configuration.
7. **Evidence and disposition are computed separately, and disposition is default-deny over typed causes.** Evidence is arithmetic over the matrix, computed independently of cause. Disposition is then applied from an enumerated allowlist; anything unlisted blocks. **Aggregation over a mixed matrix is ordered, and the order is normative** — retained blockers resolve before the availability allowlist, and a partial matrix never merges.
8. **`indeterminate` requires a retry actor as a precondition, and is bounded.** It never posts success, and leaves a status pending only where a retry actor exists. Where none exists the disposition is a block naming a human clearer — "retry" with no retry actor is the exit-less state decision 4 forbids. On exhaustion it becomes a block cleared by human review.
9. **Quota and token are two primitives, not one.** Quota (spend) is divisible and refundable: reserve, settle observed, refund unused (#402). A revision token is indivisible and one-shot, with *opposite* failure semantics — a pre-work abort releases it, a post-work failure consumes it (#453).
10. **Attempt identity is an authority, not a naming convention.** A monotonic `(itemId, attemptSeq)` requires atomic allocation and a **harness-owned, agent-denied register**, with current-attempt fencing at every effect consumer.

## Constraints on any implementation

- **A time lease is not liveness.** A fixed expiry with no heartbeat reclaims a job that is genuinely still running, duplicating it; where the terminal effect is last-writer-wins, the duplicate corrupts the outcome. Reclaim must gate on a positive liveness verdict, and terminal effects must be idempotent or fenced. The current queue exemplar carries this defect — adopting its shape unchanged would propagate it.
- **Omission is never refutation.** A disposition keyed only on the current pass would let a later reviewer's silence clear a blocker that was never refuted. "Retained" spans prior passes *and* the current one; an unavailable cell never clears a blocker.
- **Low evidence must never imply `indeterminate`.** An all-parse-invalid matrix and an all-transport-failure matrix have identical evidence — zero valid cells — and must resolve differently. This is only representable if the disposition input carries per-cell causes.
- **Unavailability is an allowlist, never a default.** Reclassifying infrastructure-flavoured failure wholesale reopens genuine fail-closed paths: parse-invalid and a pre-matrix diff-read failure are infra-flavoured but are real signals, and retrying cannot make an unreadable diff readable.
- **A non-actionable block must not consume a revision entitlement.** Treating any gate failure as revisable spends a one-shot token on work no revision can fix (#453, second location).
- **The clearing actor must ride on the state, not on one variant of it.** Otherwise a demotion from retryable to blocking produces a blocking state with nobody named to clear it.
- **Attempt-register authority must be agent-inaccessible by construction.** A writer that *consults* a register the agent can rewrite is validating against forgeable state. Command-string denial cannot carry the authority — it is bypassable by shell indirection, and is defence-in-depth only. Absolute resolved-path write denial is stronger but still insufficient alone.
- **Authentication without anti-rollback freshness is replayable.** A signed attempt token that was valid before supersession is still validly signed afterwards. Freshness — a monotonic counter, epoch, or nonce the agent cannot reach or rewind — must live outside the agent's reach regardless, which is why agent-inaccessible storage is the primary form and authentication only a fallback.
- **Self-validation is not fencing.** An old attempt passes its own check, a newer sequence is allocated, and the old actor still posts (#451, #450). Consumers whose authority offers no conditional write must route through a single harness-owned writer, not an unspecified compare-and-swap.

## Alternatives not taken

- **A bigger/better lock.** The existing file lock is fail-open by construction and sound only as a contention reducer. The problem is that it is the *only* mutual-exclusion noun available, so it gets reached for where a fence or reconciler is required — across sixteen call sites. No change inside it fixes that.
- **One FSM over "the cycle".** Re-encodes `STEPS`, which config already owns, and touches none of the three conflations.
- **Reclassifying infra failure wholesale to `indeterminate`.** See the allowlist constraint above.
- **Shipping `indeterminate` before its retry actor.** Recreates stranding in a new cell: either still a block, or an indefinitely pending PR.
- **Continuing to point-fix.** #401, #402, #435, #439, #444, #450, #451, #453, #455, #460 and #461 are eleven instances of six primitives — eleven point-fixes buy six primitives' worth of leverage at eleven times the cost.

## Consequences

- (+) The audit is finite and mechanical: every guard sorts into one of four classes, each with a known remedy. New guards get a checklist instead of a precedent search.
- (+) Decision 4 converts "fail-closed" from a terminal verdict into a state with an exit; it would have prevented #453 and #460 from existing.
- (+) Decisions 5–8 unstrand PRs blocked by provider incidents rather than findings. #428 becomes revisable — not merged, and its carried blocker must still be fixed or validly refuted.
- (−) Decision 6 requires plumbing realized diversity onto the merge-gate path, which does not exist today.
- (−) Decision 8 requires durable retry state and constrains the local runner first; the CI runner keeps today's behavior until a durable CI-side retry actor exists.
- (−) Decision 10's consumer-side fencing touches every effect consumer. The smallest useful subset is an open question, tracked with the implementing item.
- (−) This is target-state, not a description of current code. It binds new guard work; it does not attest existing behavior. #445 and #458 are in the defect cluster but are **not** subsumed.

## Construction

`docs/agent-context/guarded-actions.md` — the full guard audit and its evidence. § 2 the three conflations with call-site detail; § 4 the classification map over existing guards; § 5 the missing primitives and the reconciler template's own defects; § 6 the lifecycle tables naming each state's clearing transition and actor; § 7.1–7.3 the gate's evidence/disposition split, the default-deny cause table and normative aggregation order, and the retry-actor precondition; § 8 the new-guard checklist this decision delegates to; § 10 sequencing.
