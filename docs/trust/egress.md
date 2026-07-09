---
title: Egress
description: Sub-processor and user-controlled endpoint matrix from the trust manifest.
status: draft
diataxis: explanation
sidebar:
  order: 5
last_reviewed: 2026-07-08
---

# Egress

Pelaggio has no analytics or telemetry channel at all (`TC-002`). Operational egress is limited to the model provider and integrations/endpoints the operator configures (`TC-006`). The matrix below mirrors [`pelaggio.trust.json`](./pelaggio.trust.json).

| Destination | Required/default | Data classes | Retention owner | Opt-out / control | Role | Claim(s) |
|---|---|---|---|---|---|---|
| `anthropic` | Required for Claude-provider runs today | Prompts, repo paths, source context, diffs, issue text | Model provider policy | Configure a different model provider when one is supported for the step | Sub-processor | `TC-006`, `TC-014` |
| `github` | Optional, when roadmap/ship/review uses GitHub | Issues, pull requests, plan bodies, diffs, comments | Your GitHub organization/repo | Use another roadmap source or avoid PR/review modes that call GitHub | User-controlled endpoint | `TC-006`, `TC-003`, `TC-012`, `TC-013` |
| `linear` | Optional, when roadmap source is Linear | Issues, comments, state | Your Linear workspace | Use another roadmap source | User-controlled endpoint | `TC-006` |
| `git_remote` | Optional by ship mode | Commits, branches | Your git remote | Default PR mode still pushes feature branches; direct default-branch push requires explicit opt-in | User-controlled endpoint | `TC-006`, `TC-012` |
| `notify_webhook` | Disabled by default | Outcome metadata | Your endpoint | Leave `notify.url` unset | User-controlled endpoint | `TC-002`, `TC-006` |

## Controller/Processor Framing

In a self-hosted deployment, the operator runs the controller and chooses the processors/endpoints (`TC-006`, `TC-010`). Pelaggio itself does not add a hidden hosted processor or analytics backend (`TC-002`). The model provider remains a processor for prompts/source/diffs/issue text, governed by that provider's retention policy (`TC-006`). GitHub, Linear, git remotes, and notify webhooks are user-controlled endpoints rather than Pelaggio-operated services (`TC-006`).

## Secret and Log Limits

Known secret environment variables are not interpolated into prompts or structured run logs (`TC-001`). That does not mean all process output is scrubbed: child processes inherit the parent environment today, and raw verbose logs are not redacted (`TC-014`). Avoid running verbose sessions with unnecessary secrets in the parent environment until the planned env allowlist/log scrubber ships (`TC-014`).
