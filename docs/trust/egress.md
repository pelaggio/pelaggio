---
title: Egress
description: Sub-processor and user-controlled endpoint matrix from the trust manifest.
status: draft
diataxis: explanation
sidebar:
  order: 5
last_reviewed: 2026-07-19
---

# Egress

Pelaggio has no analytics or telemetry channel at all (`TC-002`). Operational egress is limited to the model provider and integrations/endpoints the operator configures (`TC-006`). The matrix below mirrors [`pelaggio.trust.json`](./pelaggio.trust.json).

| Destination | Required/default | Data classes | Retention owner | Opt-out / control | Role | Claim(s) |
|---|---|---|---|---|---|---|
| `anthropic` | Required for Claude-provider runs | Prompts, repo paths, source context, diffs, issue text | Model provider policy | Configure a different model provider for the step | Sub-processor | `TC-006`, `TC-014` |
| `openai` | Optional for contained Codex key-mode runs | Request bodies/prompts and provider usage | Model provider policy | Omit the `--egress` selection | Sub-processor | `TC-006`, `TC-017` |
| `cli-chat-proxy.grok.com` | Required when the brokered Grok subscription provider is selected | Prompts, source context, read-file context, provider usage | Model provider policy | Configure a different model provider for the step | Sub-processor | `TC-006`, `TC-014`, `TC-019` |
| `github` | Optional, when roadmap/ship/review uses GitHub | Issues, pull requests, plan bodies, diffs, comments | Your GitHub organization/repo | Use another roadmap source or avoid PR/review modes that call GitHub | User-controlled endpoint | `TC-006`, `TC-003`, `TC-012`, `TC-013` |
| `linear` | Optional, when roadmap source is Linear | Issues, comments, state | Your Linear workspace | Use another roadmap source | User-controlled endpoint | `TC-006` |
| `git_remote` | Optional by ship mode | Commits, branches | Your git remote | Default PR mode still pushes feature branches; direct default-branch push requires explicit opt-in | User-controlled endpoint | `TC-006`, `TC-012` |
| `notify_webhook` | Disabled by default | Outcome metadata | Your endpoint | Leave `notify.url` unset | User-controlled endpoint | `TC-002`, `TC-006` |

## Controller/Processor Framing

In a self-hosted deployment, the operator runs the controller and chooses the processors/endpoints (`TC-006`, `TC-010`). Pelaggio itself does not add a hidden hosted processor or analytics backend (`TC-002`). The model provider remains a processor for prompts/source/diffs/issue text, governed by that provider's retention policy (`TC-006`). GitHub, Linear, git remotes, and notify webhooks are user-controlled endpoints rather than Pelaggio-operated services (`TC-006`).

## Secret and Log Limits

Known secret environment variables are not interpolated into prompts or structured run logs
(`TC-001`). Driver children receive a deny-by-default environment and captured logs are scrubbed
(`TC-014`). In a contained key-mode run, the host broker reads the named key, replaces inbound auth
only on the fixed upstream request, and gives the jail only a Unix-socket locator (`TC-017`). The
broker retains no bodies, auth values, upstream URL, or query strings in its decisions.

Contained execution does not make prompts confidential from the selected provider: legitimate model
traffic may contain worktree data. Unattended, CI, and shared execution require a metered/org key.
Grok transparent subscription auth uses the official base-URL seam for local, single-developer
runs (`TC-019`). Only an ephemeral copy of `auth.json` enters the jail; the broker forwards its
Bearer header solely to `cli-chat-proxy.grok.com`. There are no dummy auth files, broker-side
refresh-token handling, or direct-network fallback. An expired token that needs `auth.x.ai` refresh
requires host-side re-login. Containment also does not establish contractual permission to use a
provider service.

Every Grok step runs in a private network namespace whose only provider path is a mounted Unix
broker socket reached through the trusted PID-1 loopback shim (`TC-019`). The broker enforces the
fixed HTTPS origin, exact reviewed routes, `grok-4.5`, `stream:true`, bounded SSE terminal usage,
and request/rate/token/spend caps. Malformed or changed provider traffic fails availability closed.
The provider remains an allowed sink for legitimate prompts and read-file context. The
Landlock-less fallback removes only the nested native sandbox, never this outer boundary, and
subscription use remains local single-developer only.
