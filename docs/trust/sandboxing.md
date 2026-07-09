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

Pelaggio's current isolation is worktree-oriented process discipline, not an OS/container sandbox (`TC-011`, `TC-015`). The item branch gets its own git worktree; mutating tool hooks and skills steer writes there; the review/ship gates limit what can land. The planned hard guarantee is a post-step assertion that no writes escaped the item worktree, but that guarantee is not shipped today (`TC-011`).

## Current Boundaries

| Boundary | Current behavior | Claim(s) |
|---|---|---|
| Item worktree | `pick` creates a feature branch and worktree unless `--no-worktree` is used. Mutating steps run from that worktree. | `TC-011`, `TC-015` |
| Main-repo direct path hooks | Step runner hooks block `Write`/`Edit` calls that target the main repo absolute path while running in a sibling worktree. | `TC-011` |
| Plan-polish guard | During `implement`, writes to `docs/plans/` are blocked so the agent executes the approved plan instead of editing it. | `TC-011`, `TC-015` |
| Worktree-side install guard | In-worktree `pnpm install`/similar commands are blocked because worktrees share main `node_modules` by symlink when lockfiles match. | `TC-011`, `TC-016` |
| Dependency sharing seam | `worktree-deps` symlinks `node_modules` to the main repo when safe, falls back to install on lockfile drift, and repairs known corruption shapes. | `TC-011`, `TC-016` |
| PR gate | Even if code changes are made in the worktree, default shipping opens a PR and the merge gate fails closed in PR mode. | `TC-003`, `TC-012` |

## Known Limits

| Limit | Why it matters | Claim(s) |
|---|---|---|
| No OS/container boundary | A shell command runs with the operator's local privileges and environment, subject to the process sandbox/harness in use. | `TC-011`, `TC-014`, `TC-015` |
| Sibling worktree writes are not fully guarded | Current guards focus on the main repo path; sibling paths are part of planned post-step confinement. | `TC-011` |
| Relative, `$HOME`, `cd`, and symlink escapes are not fully covered | Bash can address files without an obvious absolute main-repo prefix. | `TC-011`, `TC-015` |
| Child env allowlist is not shipped | Spawned children inherit the parent environment today. | `TC-014` |
| Verbose raw logs are not scrubbed | `--verbose` transcripts in `.dev/*.log` can capture raw stdout/stderr. | `TC-001`, `TC-014` |
| Prompt injection is bounded, not solved | The agent still consumes attacker-reachable text and runs broad tools inside the worktree. | `TC-015` |

## Practical Reading

Use this page as a scope statement: worktree isolation is a current guardrail and workflow invariant (`TC-011`), while hard confinement is the endpoint intent. The safe default remains PR-gated shipping (`TC-003`, `TC-012`), and the injection model assumes an attacker can influence text the agent sees (`TC-015`). For capability matrices, see [permissions reference](./reference/permissions.md); for files left behind by the boundary, see [artifacts and state](./reference/artifacts-and-state.md).
