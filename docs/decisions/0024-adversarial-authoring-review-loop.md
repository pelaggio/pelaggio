---
title: "ADR-0024: Adversarial authoring-review loop"
status: accepted
date: 2026-07-22
claims: []
---

# ADR-0024 — Adversarial authoring-review loop

## Context
Review was historically a post-hoc gate on a raw first draft. The decision is to move review **upstream into the authoring cycle**: an internal multi-driver adversarial loop that resolves findings as it goes, converges, and ships a PR that is already reviewed and clean, with the converged review record attached as **provenance**. The mechanism (N reviewers + an independent Judge + a bounded review-fix loop) is **precedented, not novel** (Sakana Fugu, FuguNano, multi-agent debate-to-convergence, Mixture-of-Agents); pelaggio's differentiation is the **integration + the provenance record**, not the loop. The core is shipped and dogfooded (`review.authoring` enabled in this repo, driven from `shakedown-code`); detail lives in `docs/agent-context/adversarial-review-loop.md`.

## Decision
`shakedown-code` runs an internal loop: fresh reviewers run **concurrently, one per available driver** (no authoring context) → a **config-set Judge** verifies findings (real/reproducible/material), consolidates across reviewers, and rules the terminal outcome **each pass** → author revises the ≥-bar findings → re-review, to convergence or a terminal outcome. Load-bearing rules:
- **Roles separate** (`author ≠ reviewer ≠ judge`); v1 is one fixed strong Judge.
- **Convergence reuses the deterministic `pr-review` fingerprint-survival rule** (validated ≥-bar fingerprints survive until explicitly **refuted** — omission is never refutation); only **non-regressing** revisions are promoted. Statistical stability is a deferred, optional lever for the below-bar *note* distribution only — never the gate on the blocking set.
- **Safety floor:** any finding whose harness-computed effective class is one of the six ADR-0016 safety tokens is **hard-block → `parkExit()`**, never Dissent; a lone Judge cannot downgrade a safety class (#272), and emission-time class comes from a harness rule table, not model authority (#293).
- **A genuine split between successfully-parsed reviewer verdicts parks before the Judge, for all ship targets** — a deterministic, fail-closed gate; the participating verdicts, rationales, and evidence fingerprint are recorded and a matching human `proceed` releases judgment-only splits on resume.
- **Judge-ruled dissent is conditioned on `ship.target`** (direct-push → park) and permitted for the **judgment band only** — the seed of the ADR-0015 tolerance policy. (This is distinct from the reviewer-split gate above: the split parks pre-Judge regardless of target; only the Judge's judgment-band ruling is target-conditioned.)
- **Provider diversity is `prefer`, not `require`:** it degrades gracefully to same-provider and **records the softened guarantee**; a degraded (same-provider) run must emit a **visibly weaker** record, never the same badge.
- The loop emits a **structured review record**; it becomes an **attestation** only when a separate layer binds it to SHA + config + tool results + trusted identity (#188) — the loop is a producer/consumer of the attestation charters (#186–189), not a reinvention.

`status: accepted` covers this shipped core (concurrent multi-driver reviewers + Judge + deterministic convergence + safety floor + graceful-degraded diversity). Chartered extensions stay target-state: cross-driver consensus/veto aggregation (#243), plan-stage convergence (#277), the optional **Defender** role (challenges findings pre-Judge — not yet built), and the single-strong-agent benchmark (#270/#291).

## Alternatives not taken
- **Post-hoc review-comment gate** — triages a raw draft; the loop instead ships an already-resolved PR + provenance.
- **Majority vote across reviewers** — the literature is explicit that Judge-synthesis beats vote-tally.
- **Statistical stability (KS/adaptive) as the blocking gate** — weaker than the existing deterministic fingerprint-survival rule; kept only for below-bar notes.
- **Reading "reviewed by K models" as K independent chances** — shared training lineage yields *correlated* errors; provenance attests what was *run*, not what was *covered*, and same-provider degrades toward zero.
- **A fleet as a free lunch** — a single strong agent can win at equal token budget; the fleet is paid for only where diversity demonstrably helps (benchmark, #270/#291).

## Consequences
- (+) The PR arrives converged and carries an auditable review record — the human audits evidence, not a raw draft.
- (+) Mostly composition of existing seams (`shakedown-code` controller, per-step budget/turn caps, the `pr-review` convergence contract, ADR-0016 taxonomy, ADR-0015 tolerance, the #186–189 attestation charters); the genuinely new parts are the **Judge role** and the **convergence-loop controller + terminal-outcome taxonomy**.
- (−) The fleet is not a free lunch; its value must be benchmarked, not assumed.
- (−) Degraded same-provider mode **voids the blind-spot guarantee** — integrity then rests on the Judge + reviewer independence, both degrading toward zero; it must emit a weaker attestation, never the same badge.
- (−) Provenance is a *record*, not a full attestation: #188 shipped effects-boundary receipts, but gate-assertion binding + trusted-runner identity remain residual — do not let the record become the "laundering" it warns against.

Imports the taxonomy + safety floor from ADR-0016; conditions Dissent on the ADR-0015 tolerance policy; provenance rides the ADR-0018 / #186–189 attestation charters; review orchestration boundary is ADR-0022's; no model may launder uncertainty into a landed change per ADR-0014.

- (−) **Wrong-if for the diversity assumption (added 2026-08-24, #624):** the fleet's incremental cost stops being justified if a single strong reviewer at equal token budget reproduces its must-fix set on a sampled set of gated PRs (#270/#291) and cross-provider disagreement contributes no landed fixes over that sample — measured through #627 before any gate change. The baseline to beat is 1.64 re-review rolls per landing (`review-gate-baseline.md`).
