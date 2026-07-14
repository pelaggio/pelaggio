---
title: "ADR-0001: Writes confined to the item's worktree"
status: proposed
date: 2026-07-08
claims: [TC-011]
---

# ADR-0001 — Writes confined to the item's worktree

## Context
Runs are unattended and the agent has allow-all tools. It must not corrupt the main checkout or a sibling worktree — and, under injection (`ADR-0002`), a "write to `../main`" instruction must not succeed. Today the boundary is an advisory `PreToolUse` string-prefix check on `Write/Edit/Bash` (best-effort, untested; sibling writes and `cd ../`/`$HOME`/symlink Bash escapes slip through — audit S1).

## Decision
Make confinement a **hard gate**: after each step, assert the working tree touched only the item's own worktree, and **fail the step** on violation. Cover sibling worktrees and relative/symlink escapes. Add tests exercising the block branches (currently none).

## Alternatives not taken
- OS sandbox / containers per step — stronger, but heavy and less portable across harnesses.
- Tool allowlist — doesn't stop in-worktree Bash reaching out.

## Consequences
- (+) Turns the audit's "load-bearing but advisory" boundary into a verifiable guarantee (`TC-011` → `guarantee`).
- (−) A post-step assertion adds a check per step; escapes must be enumerated and tested.

## Amendment: concurrent operator edits

Git snapshots identify changed state, not the writer, so an operator editing the main checkout during a step is indistinguishable from an escaped agent write. The default therefore remains a fail-closed audit of main plus sibling worktrees. Operators may explicitly set `confinement.allow-dirty-main: true`; for item-worktree steps this removes only the main checkout from the audit, keeps sibling worktrees hard-gated, warns once per run, and still fails closed if sibling roots cannot be enumerated. This mode is a reduced boundary, not equivalent security. A separate clone is the recommended setup when concurrent main-checkout editing and full confinement are both required.
