---
title: "ADR-0021: Capability enforcement and placement — ocap tool-mediation and effects-as-handlers"
status: proposed
date: 2026-07-21
claims: []
---

# ADR-0021 — Capability enforcement and placement

## Context
Given the capability model (ADR-0020), two questions remain: how is a tool action **authorized** (enforcement), and how is work that must cross a trust or substrate boundary **placed** (placement)? Today Claude's `PreToolUse` guards are the only per-call semantic-deny mechanism — `canUseTool` is allow-all — and `effects.ts` is a partial typed-effect seam (`checkpoint`, `plan.publish`, `ship.ShipDecision` implemented; other kinds reserved). The enforcement and placement primitives should be **inherited from established practice**, not hand-rolled per step, so new work does not reinvent a bespoke scheduler.

## Decision
Adopt two distinct primitives.

**(1) Enforcement = object-capability (ocap) tool-mediation** at the tool seam: per-call authority grant/deny against a typed capability set. Claude's `PreToolUse` guard is today's **narrow, Claude-only** instance of this hook; `canUseTool` is allow-all and is **not** a deny gate. The settled routing decision is **fail-closed on a missing required capability** (e.g. `semanticDeny`) with native-prefer selection (ADR-0020). Generalizing ocap teeth to Codex/Grok for cross-provider parity is an **explicit follow-on, not a commitment of this ADR**.

**(2) Placement = capability-constrained effect handlers** (algebraic effects; `effects.ts` is the partial implementation): deterministic, boundary-crossing work is expressed as a **typed effect with a harness-owned handler**. Per-call capability is an **enforcement** primitive only; it is **not** a cross-driver **placement** primitive — a stateful agentic loop's context cannot be transplanted to another driver mid-call. Therefore only **two handler kinds are fundamental**: `agentic-loop` (provider-owned) and `deterministic` (harness-owned effect). `contained.verify` (#254) is placement guidance — it lands as a deterministic effect handler, **chartered-not-built**; it is not a shipped effect kind and not a pipeline node.

## Alternatives not taken
- **Cross-driver mid-loop placement** (route one tool call's execution to a different LLM driver inside one loop) — the reasoning lives in one provider's stateful session; you can deny or broker a call, not transplant an agentic decision coherently.
- **Per-call capability as a placement primitive** — conflates enforcement granularity with driver placement; correct for deny/broker, wrong for routing execution.
- **A third `judgment` handler kind** for review/verify — review is an `agentic-loop` with a read-only capability profile, not a distinct execution substrate.

## Consequences
- (+) Enforcement and placement are inherited from established primitives (ocap; algebraic effects ≈ durable activities), not reinvented as a bespoke scheduler.
- (+) The effects manifest carries provenance for boundary-crossing work uniformly.
- (−) True per-call cross-provider ocap parity is real, unbuilt work; until it lands, semantic-deny enforcement stays Claude-only and routing fails closed elsewhere.
- (−) The `deterministic` vs `agentic-loop` line is hard; work that is "mostly deterministic but needs one judgment call" must pick a side.

Specializes ADR-0014 — the fail-closed, capability-denied seam is the spine's, applied here at the tool boundary. Whether a given `semanticDeny` guard is safety-tier is classified per ADR-0016; the realized-capability audit degrades rigor, never softens security, per ADR-0017.
