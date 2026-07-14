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

Pelaggio's current isolation is worktree-oriented process discipline, not an OS/container sandbox (`TC-011`, `TC-015`). By default, its post-step confinement audit diffs the git state of the main checkout and sibling worktrees and fails on any committed or uncommitted change. With `confinement.allow-dirty-main: true`, main-checkout writes are deliberately not audited, while sibling worktrees remain hard-gated and audit errors fail closed. This reduced mode exists because Git state cannot identify whether an operator or provider made a concurrent edit. Use a separate Pelaggio clone when concurrent editing and full main-checkout detection are both required.

## Current Boundaries

| Boundary | Current behavior | Claim(s) |
|---|---|---|
| Item worktree | `pick` creates a feature branch and worktree unless `--no-worktree` is used. Mutating steps run from that worktree. | `TC-011`, `TC-015` |
| Main-repo direct path hooks | Step runner hooks block `Write`/`Edit` calls that target the main repo absolute path while running in a sibling worktree. | `TC-011` |
| Post-step confinement audit | By default, a git-state diff over main and siblings fails on changes. The explicit dirty-main mode excludes only main and warns once per run. | `TC-011` |
| Plan-polish guard | During `implement`, writes to `docs/plans/` are blocked so the agent executes the approved plan instead of editing it. | `TC-011`, `TC-015` |
| Worktree-side install guard | In-worktree `pnpm install`/similar commands are blocked because worktrees share main `node_modules` by symlink when lockfiles match. | `TC-011`, `TC-016` |
| Dependency sharing seam | `worktree-deps` symlinks `node_modules` to the main repo when safe, falls back to install on lockfile drift, and repairs known corruption shapes. | `TC-011`, `TC-016` |
| PR gate | Even if code changes are made in the worktree, default shipping opens a PR and the merge gate fails closed in PR mode. | `TC-003`, `TC-012` |

## Known Limits

| Limit | Why it matters | Claim(s) |
|---|---|---|
| No OS/container boundary | A shell command runs with the operator's local privileges and environment, subject to the process sandbox/harness in use. | `TC-011`, `TC-014`, `TC-015` |
| Writes outside audited roots are not caught | Paths outside tracked roots are never detected; main is also outside the audit when the explicit dirty-main mode is active. | `TC-011`, `TC-015` |
| Child env allowlist is not shipped | Spawned children inherit the parent environment today. | `TC-014` |
| Verbose raw logs are not scrubbed | `--verbose` transcripts in `.dev/*.log` can capture raw stdout/stderr. | `TC-001`, `TC-014` |
| Prompt injection is bounded, not solved | The agent still consumes attacker-reachable text and runs broad tools inside the worktree. | `TC-015` |

## Practical Reading

Use this page as a scope statement: default worktree isolation audits main plus siblings; the dirty-main opt-out audits siblings only (`TC-011`). Neither mode is an OS sandbox, and paths outside audited roots remain bounded by tool/egress scoping (`TC-015`). The safe default remains PR-gated shipping (`TC-003`, `TC-012`).
