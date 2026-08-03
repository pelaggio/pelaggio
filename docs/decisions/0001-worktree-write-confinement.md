---
title: "ADR-0001: Writes confined to the item's worktree"
status: accepted
date: 2026-07-08
claims: [TC-011]
---

# ADR-0001 — Writes confined to the item's worktree

## Context

Runs are unattended and the agent has allow-all tools. It must not corrupt the main checkout or a sibling worktree — and, under injection (`ADR-0002`), a "write to `../main`" instruction must not succeed.

**Before the gate:** confinement was only an advisory `PreToolUse` string-prefix check on `Write`/`Edit`/`Bash` (best-effort, untested). Sibling writes and `cd ../` / `$HOME` / symlink Bash escapes could slip through. That layer remains as an early diagnostic block in `step-runner.ts`; it is not the hard gate.

## Decision

Make confinement a **hard gate**: after each step, assert the working tree touched only the item's own worktree, and **fail the step** on violation. Cover sibling worktrees and relative/symlink escapes. Boundary strength is **before/after Git porcelain deltas for enumerated main and sibling worktrees** — not an OS sandbox, command allowlist, or process-lifetime provenance.

## Alternatives not taken

- OS sandbox / containers per step — stronger, but heavy and less portable across harnesses.
- Tool allowlist — doesn't stop in-worktree Bash reaching out.
- Path extraction from tool args as the hard gate (failed PR #112 approach) — bypassable via shell indirection (`OUT=…; printf x > "$OUT"`). Independence from tool-input path parsing is the load-bearing property.

## Consequences

- (+) Turns the audit's "load-bearing but advisory" boundary into a verifiable guarantee (`TC-011` → `guarantee`).
- (−) A post-step assertion adds a check per step; escapes must be enumerated and tested.

**Implemented as:** the hard gate is the pipeline whole-step Git porcelain audit in `pipeline.ts` (`snapshotForbiddenRoots` / `diffForbiddenRootSnapshots` → `error_confinement`; `#105`, with #111's independence-from-path-parsing intent satisfied by the same mechanism). The advisory PreToolUse path blocks remain an early diagnostic layer only.

## Amendment: concurrent operator edits

The default remains a fail-closed whole-step audit of main plus sibling worktrees. With `confinement.allow-dirty-main: true`, sibling worktrees remain hard-gated, while main uses provider-specific protection for item-worktree steps: Claude compares Git state immediately before and after each mutating tool, and Codex excludes main through its workspace boundary. Unchanged pre-tool dirtiness is operator-owned; a delta or attribution failure is `error_confinement`. A simultaneous operator change inside a tool window is conservatively attributed to the tool. Detached/background changes after the post hook, non-Git paths, and main-cwd steps are outside this attribution mechanism, so it is not process-lifetime provenance or an OS sandbox.

## Amendment: bounded snapshot-execution retries

Snapshot **execution** failures (Git throws, e.g. shared `index.lock` under parallel cycles) may be retried a small fixed number of times inside the snapshot helper before the audit fails closed. This is a mechanism-level confirmation of transient interference, not a policy change to the hard gate: a successful dirty porcelain is never rechecked away, and exhausted attempts still terminate the step as `error_confinement` with the last concrete Git diagnostic. The retry is provider-neutral and shared by the whole-step audit and the main-checkout tool-window observer.
