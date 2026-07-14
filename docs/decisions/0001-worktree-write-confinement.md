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

The default remains a fail-closed whole-step audit of main plus sibling worktrees. With `confinement.allow-dirty-main: true`, sibling worktrees remain hard-gated, while main uses provider-specific protection for item-worktree steps: Claude compares Git state immediately before and after each mutating tool, and Codex excludes main through its workspace boundary. Unchanged pre-tool dirtiness is operator-owned; a delta or attribution failure is `error_confinement`. A simultaneous operator change inside a tool window is conservatively attributed to the tool. Detached/background changes after the post hook, non-Git paths, and main-cwd steps are outside this attribution mechanism, so it is not process-lifetime provenance or an OS sandbox.
