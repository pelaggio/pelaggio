---
title: Self-host
description: Control-plane setup and trust posture for the Pelaggio daemon.
status: draft
diataxis: tutorial
sidebar:
  order: 7
last_reviewed: 2026-07-08
---

# Self-Host

The control-plane server is a Hono daemon that supervises local `pnpm pelaggio` processes. It is intended to run on the operator's machine or tailnet host, with a registry of allowed repo paths and a bearer token for routable binds (`TC-010`, `TC-006`).

## Registry and State

The daemon reads repo slugs from `$XDG_CONFIG_HOME/pelaggio-server/repos.yml` or `AUTOPILOT_SERVER_REGISTRY` (`TC-006`). State defaults to `$XDG_STATE_HOME/pelaggio-server/state.json`, logs to `$XDG_STATE_HOME/pelaggio-server/logs/`, and both can be overridden by env vars (`TC-014`, [artifacts reference](./reference/artifacts-and-state.md)).

```yaml
repos:
  pelaggio: /home/USER/workspace/pelaggio
```

Unknown slugs are rejected by the API instead of spawning a process in an arbitrary path (`TC-010`, `TC-006`).

## Auth and Bind Rules

`AUTOPILOT_SERVER_HOST=0.0.0.0` is rejected. If the configured host is non-loopback, startup fails unless `CONTROL_PLANE_TOKEN` is set (`TC-010`). Loopback binds (`127.0.0.1`, `localhost`, `::1`) can run tokenless for local development and emit a warning (`TC-010`). With a token set, all run/repo routes require `Authorization: Bearer <token>`; `/healthz` and `/.well-known/pelaggio.trust.json` are intentionally outside the bearer chain (`TC-010`).

## Trust Manifest Endpoint

The daemon serves the configured manifest at:

```text
/.well-known/pelaggio.trust.json
```

That endpoint returns the checked-in generated manifest so a UI or external controller can inspect capabilities, egress, and hard "never" statements before starting a run (`TC-006`, `TC-010`, `TC-012`). If the file is missing or unreadable, the server returns `not-found` or `read-error` rather than inventing a posture (`TC-010`).

## Run Control

`POST /runs` starts a supervised run for a registry slug; `pause`, `resume`, and `stop` operate on existing run IDs (`TC-010`). Pause uses the same park/checkpoint path as rate-limit parking at a step boundary; stop abandons the process while leaving worktree diffs for manual recovery (`TC-011`, `TC-015`). Logs are plain text and not scrubbed today, so keep only necessary secrets in the server environment (`TC-014`).
