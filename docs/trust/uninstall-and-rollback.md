---
title: Uninstall and rollback
description: Stop runs, remove local Pelaggio files, clean worktrees, and recover from ship modes.
status: draft
diataxis: tutorial
sidebar:
  order: 9
last_reviewed: 2026-07-08
---

# Uninstall and Rollback

There is no single automated rollback command. Recovery depends on what Pelaggio has already done: local worktree edits, PR branches, direct pushes, daemon state, or generated consumer files (`TC-011`, `TC-012`, `TC-013`, `TC-015`).

## Stop or Pause Runs

For server-managed runs, pause first when you want the pipeline to checkpoint at a step boundary; stop when you want the process abandoned and will recover manually (`TC-010`, `TC-011`, `TC-015`). CLI-only runs can be interrupted by the operator, but rate-limit/park paths are the ones designed to checkpoint work (`TC-015`).

## Remove Server Installation

If installed as a systemd user unit, stop and disable it, then remove local env/registry/state only after reviewing what you need to keep (`TC-010`, `TC-014`):

```bash
systemctl --user disable --now pelaggio-server
rm -f ~/.config/systemd/user/pelaggio-server.service
```

Review before deleting `~/.config/pelaggio-server.env`, `~/.config/pelaggio-server/repos.yml`, and `~/.local/state/pelaggio-server/`; logs may contain raw stdout/stderr and are not scrubbed today (`TC-014`).

## Remove Generated Consumer Files

Review and remove only files you intentionally want gone, such as `.pelaggio.yml`, installed `.claude/skills/`, `.agents/skills` aliases, or bootstrap docs (`TC-015`). Do not blindly remove unrelated repo files because Pelaggio runs inside normal git repos and worktrees (`TC-011`).

## Clean Branches and Worktrees

Each item normally uses a feature branch/worktree (`TC-011`, `TC-015`). After preserving any wanted diffs, remove stale worktrees and branches with normal git commands. The harness/ship step owns commit/merge bookkeeping; manual cleanup should avoid deleting active work (`TC-012`).

## Roll Back Shipped Work

If `ship.target=pull-request`, close the PR or revert commits in the PR branch; the default does not push to the default branch (`TC-012`). If `ship.target=direct-push`, rollback is normal git history management: revert the shipped commit(s) or reset only under your repo policy (`TC-012`). If `ship.target=auto-merge-pr`, remember current safety depends on external branch protection requiring the `review` status; in-code verification is planned (`TC-013`).
