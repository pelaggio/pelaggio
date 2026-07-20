---
title: "ADR-0017: Graceful degradation on rigor only; last-verified-pin fallback allowed, uncontained fallback never"
status: proposed
date: 2026-07-19
claims: [TC-001, TC-010]
---

# ADR-0017 — Degrade on rigor, never on the security boundary

## Context
Fail-closed is the house style ([ADR-0008](./0008-control-plane-fail-closed.md), [ADR-0014](./0014-mechanism-policy-separation-spine.md)) but carries an availability cost: a wedged upstream-CLI or egress pin can park the **entire fleet** — an availability failure, not a safety one. A counterweight is needed that does not erode the security boundary the autonomy model ([ADR-0015](./0015-autonomy-by-default-configurable-tolerance.md)) rests on.

## Decision
Degrade gracefully **on rigor** — fewer reviewers, same-provider with a visibly weaker attestation, best-effort `plan.publish` — always with recorded provenance and `ship.target` gating. **Never degrade on the security / credential boundary.**

Specific resolution of the wedged-pin case: falling back to the **last verified pin** is permitted — it is still inside the deterministic gate (it *was* verified), so this is a staleness/rigor degradation, recorded and `ship.target`-gated. An **uncontained or unverified** fallback is never permitted, even at total availability loss. The dividing line is safety-class vs. judgment-band — the same line the review loop already draws.

## Alternatives not taken
- Fail-closed with no degradation — one upstream CLI/image bump parks the whole fleet.
- Uncontained fallback for availability — breaches the deterministic security gate the autonomy model depends on.

## Consequences
- (+) Fleet availability is recoverable without a human when a pin wedges.
- (+) The security lower bound is preserved (a verified pin is not an uncontained run).
- (−) A stale-but-verified pin runs briefly on an older trusted surface — bounded, recorded, and `ship.target`-gated.
