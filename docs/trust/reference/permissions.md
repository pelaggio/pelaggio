---
title: Permissions reference
description: Compact capability matrix sourced from the trust manifest and runtime config.
status: draft
diataxis: reference
sidebar:
  order: 11
last_reviewed: 2026-07-08
---

# Permissions Reference

| Capability | Default | Scope / approval | Notes | Claim(s) |
|---|---|---|---|---|
| `repo.read` | Allowed | Local repo/config/roadmap read | Repo/issue/PR/tool-output text is untrusted input. | `TC-015` |
| `repo.write.worktree` | Allowed | Item worktree by convention/hooks | By default the audit fails on main or sibling changes; dirty-main mode uses Claude tool-window attribution or Codex workspace exclusion for main and retains siblings. Not an OS sandbox. | `TC-011`, `TC-015` |
| `shell.exec.worktree` | Allowed | Item worktree, budget/turn bounded | High-trust capability; child env allowlist is planned. | `TC-011`, `TC-014`, `TC-015` |
| `pr.open` | Allowed | Ship default | Opens PR in `pull-request` mode. | `TC-003`, `TC-012` |
| `git.push.default_branch` | Denied by default | Explicit `ship.target=direct-push` | Emits a warning banner when configured. | `TC-012` |
| `pr.automerge` | Denied by default | Explicit `ship.target=auto-merge-pr` | Requires external branch protection today; in-code verification planned. | `TC-013` |
| `control_plane.spawn_run` | Denied unless server is reachable/authenticated | Bearer token on every bind | Loopback development also requires a configured token. | `TC-010` |
| `notify_webhook` | Disabled | Set `notify.url` | Sends outcome metadata to operator endpoint. | `TC-002`, `TC-006` |

## Step Defaults

| Step/action | Reads | Writes | Remote egress/mutation | Claim(s) |
|---|---|---|---|---|
| `pick` | Roadmap, git/worktree state | Branch/worktree, claim state | Roadmap adapter when configured | `TC-006`, `TC-011`, `TC-015` |
| `plan` | Item context, repo docs/code | Plan file | May publish plan through adapter | `TC-006`, `TC-015` |
| `shakedown-plan` | Plan/source context | Plan revisions before implement | Model provider | `TC-006`, `TC-015` |
| `implement` | Approved plan, repo files | Target files in worktree | Model provider | `TC-006`, `TC-011`, `TC-015` |
| `shakedown-code` | Diff/source/tests | Worktree fixes | Model provider | `TC-006`, `TC-011`, `TC-015` |
| `ship` | Git state, config | Branch/PR/default branch by target | GitHub/git remote | `TC-003`, `TC-006`, `TC-012`, `TC-013` |
| `pr-review` | PR diff/changed files | PR comment/status only by CLI | GitHub, model provider | `TC-003`, `TC-006`, `TC-015` |
