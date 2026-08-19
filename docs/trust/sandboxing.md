---
title: Sandboxing
description: Worktree isolation, dependency sharing, hooks, and known confinement limits.
status: draft
diataxis: explanation
sidebar:
  order: 4
last_reviewed: 2026-08-18
---

# Sandboxing

Pelaggio's current isolation is worktree-oriented process discipline plus a narrow Claude PID/mount seat, not a general OS/container sandbox (`TC-011`, `TC-015`, `TC-018`). By default, its post-step confinement audit diffs main and sibling Git state across the whole step. With `confinement.allow-dirty-main: true`, Claude instead diffs main around each mutating tool, Codex excludes main through its workspace boundary, and siblings remain hard-gated. Attribution failures and tool-window deltas fail closed; unchanged main dirtiness between windows is tolerated. On Linux, every Claude SDK child additionally starts under Bubblewrap in a detached terminal session so it cannot use the harness controlling terminal, see host procfs, or reach configured harness-only socket directories (`TC-018`).
Grok separately uses a shipped Linux systemd/bubblewrap boundary with a private network namespace and broker-only egress (`TC-019`).

## Current Boundaries

| Boundary | Current behavior | Claim(s) |
|---|---|---|
| Item worktree | `pick` creates a feature branch and worktree unless `--no-worktree` is used. Mutating steps run from that worktree. | `TC-011`, `TC-015` |
| Main-repo direct path hooks | Step runner hooks block `Write`/`Edit` calls that target the main repo absolute path while running in a sibling worktree. | `TC-011` |
| Confinement audit | By default, a whole-step Git-state diff gates main and siblings. Dirty-main mode retains sibling diffs and uses Claude tool-window attribution or Codex workspace exclusion for main. | `TC-011` |
| Plan-polish guard | During `implement`, writes to `docs/plans/` are blocked so the agent executes the approved plan instead of editing it. | `TC-011`, `TC-015` |
| Worktree-side install guard | In-worktree `pnpm install`/similar commands are blocked because worktrees share main `node_modules` by symlink when lockfiles match. | `TC-011`, `TC-016` |
| Dependency sharing seam | `worktree-deps` symlinks `node_modules` to the main repo when safe, falls back to install on lockfile drift, and repairs known corruption shapes. | `TC-011`, `TC-016` |
| Brokered Grok boundary | Grok runs under systemd/bubblewrap with `--unshare-all`, masked Git metadata, an ephemeral home, exact read-only dependency targets, and one Unix broker socket. | `TC-019` |
| PR gate | Even if code changes are made in the worktree, default shipping opens a PR and the merge gate fails closed in PR mode. | `TC-003`, `TC-012` |
| Claude seat PID/mount wrap | Every Claude SDK CLI child starts through Bubblewrap (`--unshare-pid`, fresh `/proc`, `--new-session`, device-capable host-root bind, `--tmpfs` on each dedicated harness-only socket parent). The detached terminal session closes the controlling-terminal command-injection path. Missing Bubblewrap or a non-Linux host fails the step closed. | `TC-018` |

## Known Limits

Grok's managed custom profile requires `bubblewrap` and Landlock on Linux. Install
`bubblewrap`, then require `grep landlock /sys/kernel/security/lsm` to succeed before an
unattended run. Missing Landlock (notably on default WSL2) or profile-install failure refuses
the step by default. The `providers.grok.allow-unsandboxed-fallback: true` escape hatch removes
only the nested Grok sandbox and is suitable solely for local, actively supervised use. The outer
systemd/bubblewrap boundary and broker remain mandatory. See the [Grok operator guide](../grok.md).

| Limit | Why it matters | Claim(s) |
|---|---|---|
| Provider-dependent OS boundary | Claude's seat hides host procfs and configured private socket directories only (`TC-018`); it still has the host network and a bound host root outside those masks. Codex uses its workspace boundary. Grok requires the Linux systemd/bubblewrap jail (`TC-019`) and adds its native Landlock profile when available. | `TC-011`, `TC-014`, `TC-015`, `TC-018`, `TC-019` |
| Attribution is windowed and Git-scoped | Paths outside audited Git roots and detached/background writes after a tool post hook are not caught. Simultaneous changes inside a Claude tool window are conservatively attributed. | `TC-011`, `TC-015` |
| Grok provider remains an allowed sink | The L7 broker prevents alternate destinations but cannot stop legitimate model requests from carrying mounted worktree context. | `TC-006`, `TC-019` |
| Grok pin changes can fail availability | An unreviewed bootstrap route, model, or terminal SSE shape is denied or seals the broker; recovery is a reviewed fixture/policy update, never direct networking. | `TC-019` |
| Prompt injection is bounded, not solved | The agent still consumes attacker-reachable text and runs broad tools inside the worktree. | `TC-015` |

## Practical Reading

Use this page as a scope statement: default worktree isolation audits main plus siblings; dirty-main mode retains sibling auditing and provider-specific main protection (`TC-011`). The Claude seat adds host-proc and private-socket isolation on Linux (`TC-018`) without becoming a general filesystem, network, or write-set sandbox. Grok's separate boundary provides broker-only network access and host-validated writes (`TC-019`). Paths outside audited roots for other providers remain bounded by tool/egress scoping (`TC-015`). The safe default remains PR-gated shipping (`TC-003`, `TC-012`).
