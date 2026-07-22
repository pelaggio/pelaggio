---
title: "ADR-0005: Auto-merge safety delegated to branch protection"
status: accepted (to verify)
date: 2026-07-07
claims: ["TC-013"]
---

# ADR-0005 — Auto-merge safety delegated to branch protection

## Context
When autopilot uses auto-merge, the safety of what actually lands on the default branch must be gated by something deterministic and **external to the agent** — an agent-adjacent merge decision is a weak gate.

## Decision
Delegate auto-merge safety to **GitHub branch protection** (required status checks + the platform-enforced merge), not to harness-side merge logic. The agent may push a branch and request merge; the platform gate decides whether it lands.

## Alternatives not taken
- Harness-side merge gating — re-implements what branch protection already enforces, and an agent-adjacent gate is weaker than a platform-enforced one.

## Consequences
- (+) The landing gate is external and deterministic; the agent cannot merge around it.
- (−) Correctness depends on branch protection being configured as expected — hence status *accepted (to verify)*; a deterministic red-merge guard (#292 / #326) adds a harness-side backstop for the `--admin` / auto-merge paths.
