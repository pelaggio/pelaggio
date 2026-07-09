---
title: Sandboxing
description: Worktree isolation, dependency sharing, hooks, and known confinement limits.
status: draft
diataxis: explanation
sidebar:
  order: 4
last_reviewed: 2026-07-08
---

# Sandboxing

Pelaggio's current isolation is worktree-oriented process discipline, not an OS/container sandbox (`TC-011`, `TC-015`). The item branch gets its own git worktree; mutating tool hooks and skills steer writes there; the review/ship gates limit what can land. On top of that, a shipped post-step confinement audit diffs the git state of the main checkout and sibling worktrees before and after each step and fails the step on any committed or uncommitted change, catching the sibling/relative/`$HOME`/`cd`/symlink Bash escapes that a plain hook string-check misses (`TC-011`). This is not an OS sandbox, so writes to paths outside any tracked git root (e.g. `$HOME`, `/tmp`, arbitrary absolute paths) are not caught by this audit and remain bounded by tool/egress scoping (`TC-011`, `TC-015`).

## Current Boundaries

| Boundary | Current behavior | Claim(s) |
|---|---|---|
| Item worktree | `pick` creates a feature branch and worktree unless `--no-worktree` is used. Mutating steps run from that worktree. | `TC-011`, `TC-015` |
| Main-repo direct path hooks | Step runner hooks block `Write`/`Edit` calls that target the main repo absolute path while running in a sibling worktree. | `TC-011` |
| Post-step confinement audit | After each step, a git-state diff over the main checkout and sibling worktrees fails the step on any committed or uncommitted change, covering sibling/relative/`$HOME`/`cd`/symlink Bash escapes. | `TC-011` |
| Plan-polish guard | During `implement`, writes to `docs/plans/` are blocked so the agent executes the approved plan instead of editing it. | `TC-011`, `TC-015` |
| Worktree-side install guard | In-worktree `pnpm install`/similar commands are blocked because worktrees share main `node_modules` by symlink when lockfiles match. | `TC-011`, `TC-016` |
| Dependency sharing seam | `worktree-deps` symlinks `node_modules` to the main repo when safe, falls back to install on lockfile drift, and repairs known corruption shapes. | `TC-011`, `TC-016` |
| PR gate | Even if code changes are made in the worktree, default shipping opens a PR and the merge gate fails closed in PR mode. | `TC-003`, `TC-012` |

## Known Limits

| Limit | Why it matters | Claim(s) |
|---|---|---|
| No OS/container boundary | A shell command runs with the operator's local privileges and environment, subject to the process sandbox/harness in use. | `TC-011`, `TC-014`, `TC-015` |
| Writes outside any tracked git root are not caught | The post-step audit diffs git state for the main checkout and sibling worktrees, so writes to paths outside every tracked git root (e.g. `$HOME`, `/tmp`, arbitrary absolute paths) are not detected and are bounded only by tool/egress scoping. | `TC-011`, `TC-015` |
| Child env allowlist is not shipped | Spawned children inherit the parent environment today. | `TC-014` |
| Verbose raw logs are not scrubbed | `--verbose` transcripts in `.dev/*.log` can capture raw stdout/stderr. | `TC-001`, `TC-014` |
| Prompt injection is bounded, not solved | The agent still consumes attacker-reachable text and runs broad tools inside the worktree. | `TC-015` |

## Practical Reading

Use this page as a scope statement: worktree isolation is a current guardrail and workflow invariant, backed by a shipped post-step confinement audit that fails the step on any change to the main checkout or a sibling worktree (`TC-011`); the remaining gap is writes to paths outside any tracked git root, which are not an OS sandbox concern and are bounded by tool/egress scoping (`TC-015`). The safe default remains PR-gated shipping (`TC-003`, `TC-012`), and the injection model assumes an attacker can influence text the agent sees (`TC-015`). For capability matrices, see [permissions reference](./reference/permissions.md); for files left behind by the boundary, see [artifacts and state](./reference/artifacts-and-state.md).
