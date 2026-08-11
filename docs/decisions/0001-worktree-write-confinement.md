---
title: "ADR-0001: Writes confined to the item's worktree"
status: accepted
date: 2026-07-08
claims: [TC-011]
construction: docs/agent-context/pipeline.md#effects-manifests
---

# ADR-0001 — Writes confined to the item's worktree

## Context

Runs are unattended and the agent has allow-all tools. It must not corrupt the main checkout or a sibling worktree — and, under injection ([ADR-0002](./0002-untrusted-input-and-tool-scope.md)), a "write to `../main`" instruction must not succeed.

Confinement began as an advisory pre-tool check on the paths an agent *asked* to write. That layer is best-effort by construction: it sees the request, not the effect, so sibling writes and `cd ../` / `$HOME` / symlink escapes could slip through it.

## Decision

Confinement is a **hard gate on observed effect**, not on requested intent. After each step the harness asserts that the working tree touched only the item's own worktree, and **fails the step** on violation. Enumerated main and sibling roots are in scope; relative and symlink escapes are covered because the gate observes the tree rather than the request.

An operator may relax the gate for *main* only — never for siblings — on item-worktree steps. Under that relaxation, unchanged pre-tool dirtiness is operator-owned, and any delta the harness cannot attribute to the operator is a confinement failure.

## Constraints on any implementation

- **Enforcement must not depend on parsing tool inputs.** Path extraction from tool arguments was tried and rejected (failed PR #112): it is bypassable through shell indirection (`OUT=…; printf x > "$OUT"`). Independence from tool-input path parsing is the load-bearing property, and any replacement mechanism must retain it.
- **Ambiguity resolves to violation.** A change the gate cannot attribute fails the step. Failure to *execute* the check may be retried a bounded number of times as confirmation of transient interference, but an observed violation is never re-polled away as "maybe transient".
- **Advisory layers must not be counted as the gate.** Pre-tool path blocks are permitted as an early diagnostic and must never be load-bearing for `TC-011`.
- **A confinement failure must not be treated as recoverable.** Checkpointing a tree already proven contaminated, then resuming onto it, re-burns spend against state known to be compromised ([ADR-0019](./0019-checkpoint-restart-not-replay.md)).
- **The guarantee is scoped to observed tree effects, and claims must not outrun it.** This is not an OS sandbox, a command allowlist, or process-lifetime provenance. Writes outside the observation window — detached or background writes after the step, non-Git paths, a main-cwd step's own working directory — are out of scope and must be stated as such.

## Alternatives not taken

- **OS sandbox / containers per step** — stronger, but heavy and less portable across harnesses. Revisited by [ADR-0023](./0023-contained-execution-boundary.md), which adds containment *around* this gate rather than replacing it.
- **Tool allowlist** — does not stop in-worktree Bash reaching out.
- **Path extraction from tool args as the hard gate** — failed PR #112; see the first constraint.

## Consequences

- (+) Turns the audit's "load-bearing but advisory" boundary into a verifiable guarantee (`TC-011` → `guarantee`).
- (−) A post-step assertion adds a check per step; escapes must be enumerated and tested.
- (−) The relaxed-main mode narrows the gate to a per-tool window, so its guarantee there is provider-dependent and strictly weaker than the default. It is an operator opt-in, not a default.

## Construction

`docs/agent-context/pipeline.md` § Effects Manifests — the snapshot/diff mechanism and its `error_confinement` outcome, the two confinement tiers and the provider-specific main protection each uses, bounded snapshot-execution retries, absent-root sentinels, and mid-step probe timing and cancellation. (§ Worktree Isolation in the same file documents only the advisory PreToolUse layer, which this ADR's third constraint forbids counting as the gate.)
