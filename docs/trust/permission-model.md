---
title: Permission model
description: Permission tiers, pipeline steps, and explicit remote-mutation gates.
status: draft
diataxis: explanation
sidebar:
  order: 3
last_reviewed: 2026-07-08
---

# Permission Model

Pelaggio's permission model is a manifest-backed description of current capabilities, not an interactive approval system. The machine projection defines `local_read`, `worktree_write`, and `remote_mutation` tiers in [`pelaggio.trust.json`](./pelaggio.trust.json); this page explains how those tiers map to pipeline steps (`TC-003`, `TC-010`, `TC-011`, `TC-012`, `TC-013`, `TC-015`).

## Tiers

| Tier | Default | What it covers | Limits | Claim(s) |
|---|---|---|---|---|
| `local_read` | Allowed | Read repository files, config, roadmap material, diffs, logs, and plans needed to select, plan, review, or verify work. | Repo/issue/PR text is treated as untrusted input. | `TC-015` |
| `worktree_write` | Allowed for mutating steps | Edit files and run commands in the item worktree. | A shipped post-step confinement audit fails the step on any change to the main checkout or a sibling worktree; still not an OS sandbox, so writes outside any tracked git root are bounded by tool/egress scoping. | `TC-011`, `TC-015` |
| `remote_mutation` | PR open allowed; default-branch push and auto-merge denied by default | Open PRs, push branches, optionally direct-push or auto-merge with explicit `ship.target`. | Auto-merge gate verification is planned; external branch protection owns enforcement today. | `TC-003`, `TC-012`, `TC-013` |
| `control_plane.spawn_run` | Denied unless server is intentionally reachable and authenticated | Start/pause/resume/stop supervised runs through HTTP. | Non-loopback host refuses to start without `CONTROL_PLANE_TOKEN`; loopback dev can run tokenless with warning. | `TC-010` |

## Pipeline Steps

| Step | Main capability | Remote mutation | Current limits | Claim(s) |
|---|---|---|---|---|
| `pick` | Reads roadmap, claims an item, creates branch/worktree. | Roadmap adapter mutation when configured. | Roadmap source is the configured adapter. | `TC-006`, `TC-015` |
| `plan` | Reads item context and writes a plan. | May publish plan through the configured adapter. | Plan text can contain untrusted issue/PR content. | `TC-006`, `TC-015` |
| `shakedown-plan` | Reads the plan/source context and may revise the plan before implement. | None by default. | Same untrusted-input model as other review steps. | `TC-015` |
| `implement` | Writes target files and runs commands in the worktree. | None by default. | `docs/plans/` is read-only during implement; a post-step confinement audit fails the step on any change to the main checkout or a sibling worktree. | `TC-011`, `TC-015` |
| `shakedown-code` | Reviews and fixes code in the worktree. | None by default. | Same worktree and injection limits as implement. | `TC-011`, `TC-015` |
| `ship` | Pushes branch or lands work according to `ship.target`. | Opens PR by default; direct push/auto-merge only by explicit opt-in. | Auto-merge relies on external branch protection today. | `TC-003`, `TC-012`, `TC-013` |

## Non-Pipeline Actions

| Action | Main capability | Claim(s) |
|---|---|---|
| `pr-review` | Fresh, out-of-context PR review that exits non-zero unless every required pass returns explicit `Verdict: PASS`. | `TC-003`, `TC-015` |
| `shipwreck` | Recovery path after ship failure; may inspect and repair local ship state. | `TC-011`, `TC-012`, `TC-015` |
| `roadmap` CLI | Adapter-backed list/get/claim/plan/mark-done/archive commands used by skills and harness. | `TC-006`, `TC-015` |
| `worktree-deps` | Symlink/install dependencies for a worktree and repair shared dependency layout. | `TC-011`, `TC-016` |

## Configuration Gates

`ship.target` defaults to `pull-request`; `direct-push` and `auto-merge-pr` are explicit values in `.pelaggio.yml` or `--target` and emit a warning banner (`TC-012`). The notify webhook is disabled until `notify.url` is set (`TC-002`, `TC-006`). The server requires bearer auth on non-loopback binds and exposes only `/healthz` and `/.well-known/pelaggio.trust.json` outside the bearer chain (`TC-010`).
