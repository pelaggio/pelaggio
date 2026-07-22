---
title: "ADR-0020: Multi-driver provider seam and capability model"
status: proposed
date: 2026-07-21
claims: []
---

# ADR-0020 — Multi-driver provider seam and capability model

## Context
The `StepProvider` seam (`{ name, runStep }`) is a clean mechanism, but the harness behaves at a Claude-shaped lowest-common-denominator: it implicitly assumes an in-process semantic-deny gate, structured rate-limit events, billed USD, and streamed structured output. Codex (`codex exec`) and Grok (ACP over stdio) silently degrade against those assumptions, and #254 / #246 / #275 each patch one facet of the same missing abstraction. Shipped today: the seam and the three-provider registry. Chartered-not-built (#337, depends on #246 pool-metering and #254 containment): an explicit, provider-neutral capability model that moves the anchor off Claude **without emulation**.

## Decision
Add a **data-only `ProviderCapabilities` descriptor** to the provider seam. Its axes are **orthogonal predicates, not a total order** — isolation and deny-gate form a lattice (landlock, workspace-write, external-container, and in-process hook-policy enforce different authorities and are not linearly rankable). **`semanticDeny`** (per-call tool authority — today enforced only by Claude's narrow `PreToolUse` guards; `canUseTool` is unconditionally allow-all) is a distinct axis from **OS-confinement**. Routing **prefers a provider that has a required capability natively and fails closed when none qualifies**; it never emulates a missing capability up to Claude's shape. A **realized-capability record** (`native | degraded`) is emitted per step so degradation is auditable, never silent — a degrade of rigor, never a softening of a safety gate (see ADR-0017). Per-provider adapters stay inside provider modules; there is **no dispatcher-level polyfill registry**. Equalizing enforcement teeth across providers is a follow-on — noted as unbuilt in ADR-0021, explicitly not a commitment — and not part of this decision.

## Alternatives not taken
- **Polyfill-first negotiation** (emulate non-Claude drivers up to Claude's contract) — freezes the Claude anchor and hides the LCD behind emulation; also erodes the native-driver-disagreement signal that adversarial review depends on.
- **Container-as-deny-gate equivalence** — an FS/network jail cannot express per-call semantic denial; treating it as equivalent re-imports the soft-equivalence the spine (ADR-0014) forbids.
- **Total-order "strongest available"** — mis-ranks the isolation/deny-gate lattice and forces false polyfills.

## Consequences
- (+) One provider-neutral place to ask "what can this driver do, natively?"; a new driver (OpenCode/Gemini) declares a descriptor row without pipeline edits.
- (+) Degradation becomes an auditable fact rather than a silent Claude-assumption.
- (−) Fail-closed routing means some steps are simply ineligible on some drivers (e.g. `semanticDeny`-requiring steps off non-Claude) until containment/parity work lands.
- (−) The descriptor is data that must track real provider behavior; a drifting descriptor is a latent bug, so it needs a test binding it to code.

Specializes ADR-0014 (mechanism/policy spine); audit-record degrade semantics per ADR-0017.
