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

Pelaggio's current isolation is worktree-oriented process discipline, not an OS/container sandbox (`TC-011`, `TC-015`). By default, its post-step confinement audit diffs main and sibling Git state across the whole step. With `confinement.allow-dirty-main: true`, Claude instead diffs main around each mutating tool, Codex excludes main through its workspace boundary, and siblings remain hard-gated. Attribution failures and tool-window deltas fail closed; unchanged main dirtiness between windows is tolerated.

## Current Boundaries

| Boundary | Current behavior | Claim(s) |
|---|---|---|
| Item worktree | `pick` creates a feature branch and worktree unless `--no-worktree` is used. Mutating steps run from that worktree. | `TC-011`, `TC-015` |
| Main-repo direct path hooks | Step runner hooks block `Write`/`Edit` calls that target the main repo absolute path while running in a sibling worktree. | `TC-011` |
| Confinement audit | By default, a whole-step Git-state diff gates main and siblings. Dirty-main mode retains sibling diffs and uses Claude tool-window attribution or Codex workspace exclusion for main. | `TC-011` |
| Plan-polish guard | During `implement`, writes to `docs/plans/` are blocked so the agent executes the approved plan instead of editing it. | `TC-011`, `TC-015` |
| Worktree-side install guard | In-worktree `pnpm install`/similar commands are blocked because worktrees share main `node_modules` by symlink when lockfiles match. | `TC-011`, `TC-016` |
| Dependency sharing seam | `worktree-deps` symlinks `node_modules` to the main repo when safe, falls back to install on lockfile drift, and repairs known corruption shapes. | `TC-011`, `TC-016` |
| PR gate | Even if code changes are made in the worktree, default shipping opens a PR and the merge gate fails closed in PR mode. | `TC-003`, `TC-012` |

## Known Limits

| Limit | Why it matters | Claim(s) |
|---|---|---|
| Provider-dependent OS boundary | Claude remains worktree-discipline based; Codex uses its workspace boundary; Grok explicitly selects a custom profile extending `strict` (Linux `bubblewrap`, macOS Seatbelt). Grok child-network restriction is Linux-only. | `TC-011`, `TC-014`, `TC-015` |
| Attribution is windowed and Git-scoped | Paths outside audited Git roots and detached/background writes after a tool post hook are not caught. Simultaneous changes inside a Claude tool window are conservatively attributed. | `TC-011`, `TC-015` |
| OS sandbox exceptions remain | Grok needs system runtime paths and its own auth/session/sandbox-event state under `~/.grok`; `strict` confines project access to CWD, not every runtime read/write literally. | `TC-011`, `TC-014`, `TC-015` |
| In-process Grok model egress is not hostname-filtered | Grok 0.2.103 blocks child networking and Pelaggio disables web tools, but the model client is exempt and the CLI exposes no hostname allowlist. | `TC-006`, `TC-014` |
| Prompt injection is bounded, not solved | The agent still consumes attacker-reachable text and runs broad tools inside the worktree. | `TC-015` |

## Practical Reading

Use this page as a scope statement: default worktree isolation audits main plus siblings; dirty-main mode retains sibling auditing and provider-specific main protection (`TC-011`). Neither mode is an OS sandbox or process-lifetime provenance, and paths outside audited roots remain bounded by tool/egress scoping (`TC-015`). The safe default remains PR-gated shipping (`TC-003`, `TC-012`).
