---
title: Errors reference
description: HTTP error codes and pipeline step subtypes with remediation.
status: draft
diataxis: reference
sidebar:
  order: 12
last_reviewed: 2026-07-08
---

# Errors Reference

## Server HTTP Codes

| Code | Where | Meaning | Remediation | Claim(s) |
|---|---|---|---|---|
| `bad-request` | `POST /runs` | Invalid JSON/body fields, unknown repo on run start, invalid `shipTarget`. | Fix request body or registry slug. | `TC-010`, `TC-012` |
| `not-found` | Run/repo/trust routes | Unknown run, repo slug, or missing trust manifest. | Check ID/slug/path; configure manifest path for the daemon. | `TC-010`, `TC-006` |
| `unauthorized` | Bearer-protected routes | Missing or invalid bearer token. | Send `Authorization: Bearer <token>` or rotate/restart with the intended token. | `TC-010` |
| `invalid-state` | Run control | Pause/resume/stop action does not match current run status. | Poll run state and retry the valid action. | `TC-010`, `TC-015` |
| `no-process` | Run control | Run metadata exists but there is no live child process. | Inspect server state/logs and recover manually. | `TC-010`, `TC-014` |
| `unknown-repo` | Supervisor | Registry cannot resolve the requested slug. | Add/fix the slug in `repos.yml` and restart if needed. | `TC-006`, `TC-010` |
| `read-error` | Trust manifest endpoint | Manifest path exists in config but cannot be read. | Fix file permissions/path; do not assume a generated fallback. | `TC-010` |

## Pipeline Step Subtypes

| Subtype | Meaning | Remediation | Claim(s) |
|---|---|---|---|
| `success` | Step completed. | Continue; for PR review, success still needs a valid report without `must-fix` findings. | `TC-003` |
| `error_rate_limit` | Provider/rate/usage/quota limit or parked signal. | Let `parkExit()` checkpoint and resume after reset/window. | `TC-015` |
| `error_max_turns` | Step hit turn cap. | Pipeline may retry selected steps once within budget; otherwise raise budget/turns or narrow scope. | `TC-015` |
| `error_refusal` | Model refused/declined. | Treat as terminal for the step; revise input/task. | `TC-003`, `TC-015` |
| `error_confinement` | Confinement guard detected prohibited writes/diff shape. | Move work back into the item worktree and rerun. | `TC-011`, `TC-015` |
| `error_budget` | Budget limit was reached. | Raise configured budget or reduce scope. | `TC-015` |
| `error_abort` | Run was aborted/cancelled. | Resume/retry only after confirming state. | `TC-015` |
| `error_sdk` | Provider/SDK error not otherwise classified. | Check provider credentials/network; fatal auth/4xx errors need config fixes. | `TC-006`, `TC-015` |
| `blocked` | Agent reported an explicit blocker. | Resolve the named dependency/missing fact before retrying. | `TC-015` |
| `edit_loop` | Provider detected repeated edits to the same file. | Pipeline may retry implement with a fresh approach; otherwise simplify scope. | `TC-015` |
| `error` | Catch-all classification for other raw subtypes. | Inspect step text/logs; verbose logs are not scrubbed. | `TC-014`, `TC-015` |

For pull-request review, a `must-fix` or any missing/invalid report, refusal, SDK failure, max-turns, or rate-limit park blocks the compatibility `review` gate (`TC-003`).
