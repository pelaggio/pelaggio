---
title: Artifacts and state
description: Files, branches, worktrees, logs, comments, endpoints, retention, and cleanup.
status: draft
diataxis: reference
sidebar:
  order: 13
last_reviewed: 2026-07-08
---

# Artifacts and State

| Artifact/state | Location / owner | Contents | Retention / cleanup | Claim(s) |
|---|---|---|---|---|
| Structured run log | `.dev/pelaggio-log.jsonl` in the repo | Cycle metadata, step outcomes, bounded output tails. | Repo-local; operator cleans. Known secret env vars are not interpolated here. | `TC-001`, `TC-014`, `TC-015` |
| Verbose raw logs | `.dev/*.log` when verbose/trace paths are used | Raw child stdout/stderr/transcripts. | Gitignored/local; not scrubbed today. | `TC-001`, `TC-014` |
| Plans for GitHub/Linear materialization | `.dev/plans/<id>.md` | Adapter-fetched or written plan bodies. | Local working state; implement treats approved plans as read-only. | `TC-011`, `TC-015` |
| Markdown-roadmap plans | `docs/plans/` | Tracked plan files for markdown roadmap mode. | Implement must not polish these; ship/bookkeeping owns lifecycle. | `TC-011`, `TC-015` |
| Worktrees | Sibling worktree paths chosen by roadmap adapter/prefix | Item branch checkout, edits, test output, local diffs. | Remove after preserving needed work. The audit always gates siblings and, by default, main; `confinement.allow-dirty-main` explicitly excludes main. | `TC-011`, `TC-015` |
| Feature branches | `feat/<id...>` | Item commits and pushed PR branch. | Delete after merge/close per repo policy. | `TC-012`, `TC-015` |
| PR comments/status | GitHub PR | Review gate output, metrics marker, plan/comment updates. | Retained by GitHub; used for audit and gate state. | `TC-003`, `TC-006`, `TC-013` |
| Roadmap adapter state | GitHub issues, Linear, or markdown files | Claims, item state, plan publication, done/archive operations. | Owned by configured adapter/source. | `TC-006`, `TC-015` |
| Server registry | `$XDG_CONFIG_HOME/pelaggio-server/repos.yml` or override | Slug to repo path mapping. | Operator-managed; restart after edits. | `TC-006`, `TC-010` |
| Server state | `$XDG_STATE_HOME/pelaggio-server/state.json` or override | Persisted run metadata. | Operator-managed; atomic writes by daemon. | `TC-010`, `TC-014` |
| Server logs | `$XDG_STATE_HOME/pelaggio-server/logs/<id>.log` or override | Plain child output and SSE replay source. | Operator-managed; not scrubbed today. | `TC-010`, `TC-014` |
| Public trust manifest | `/.well-known/pelaggio.trust.json` | Generated capabilities, egress, defaults, hard nevers. | Served from checked-in/configured file; `not-found`/`read-error` on failure. | `TC-006`, `TC-010`, `TC-012` |

## Cleanup Notes

Cleanup is intentionally git/operator-owned (`TC-011`, `TC-012`). Close PRs, remove branches/worktrees, and delete local `.dev`/server state only after preserving evidence or diffs you still need. Avoid assuming logs are secret-safe until child env allowlisting and log redaction move out of `planned` (`TC-014`). For rollback sequencing, see [uninstall and rollback](../uninstall-and-rollback.md).
