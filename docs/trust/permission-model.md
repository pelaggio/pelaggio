---
title: Permission model
description: Permission tiers, pipeline steps, and explicit remote-mutation gates.
status: draft
diataxis: explanation
sidebar:
  order: 3
last_reviewed: 2026-08-19
---

# Permission Model

Pelaggio's permission model is a manifest-backed description of current capabilities, not an interactive approval system. The machine projection defines `local_read`, `worktree_write`, and `remote_mutation` tiers in [`pelaggio.trust.json`](./pelaggio.trust.json); this page explains how those tiers map to pipeline steps (`TC-003`, `TC-010`, `TC-011`, `TC-012`, `TC-013`, `TC-015`).

## Tiers

| Tier | Default | What it covers | Limits | Claim(s) |
|---|---|---|---|---|
| `local_read` | Allowed | Read repository files, config, roadmap material, diffs, logs, and plans needed to select, plan, review, or verify work. | Repo/issue/PR text is treated as untrusted input. | `TC-015` |
| `worktree_write` | Allowed for mutating steps | Edit files and run commands in the item worktree. | By default, a post-step audit fails on main-checkout or sibling changes. Dirty-main mode uses Claude tool-window attribution or Codex workspace exclusion for main and retains sibling auditing. | `TC-011`, `TC-015` |
| `remote_mutation` | PR open allowed; default-branch push and auto-merge denied by default | Open PRs, push branches, optionally direct-push or auto-merge with explicit `ship.target`. | Auto-merge gate verification is planned; external branch protection owns enforcement today. | `TC-003`, `TC-012`, `TC-013` |
| `control_plane.spawn_run` | Denied unless server is intentionally reachable and authenticated | Start/pause/resume/stop supervised runs through HTTP. | Every host, including loopback, refuses to start without `CONTROL_PLANE_TOKEN`. | `TC-010` |

## Pipeline Steps

| Step | Main capability | Remote mutation | Current limits | Claim(s) |
|---|---|---|---|---|
| `pick` | Reads roadmap, claims an item, creates branch/worktree. | Roadmap adapter mutation when configured. | Roadmap source is the configured adapter. | `TC-006`, `TC-015` |
| `plan` | Reads item context and writes a plan. | May publish plan through the configured adapter. | Plan text can contain untrusted issue/PR content. | `TC-006`, `TC-015` |
| `shakedown-plan` | Reads the plan/source context and may revise the plan before implement. | None by default. | Same untrusted-input model as other review steps. | `TC-015` |
| `implement` | Writes target files and runs commands in the worktree. | None by default. | `docs/plans/` is read-only; confinement audits main plus siblings by default and applies provider-specific main protection in dirty-main mode. | `TC-011`, `TC-015` |
| `shakedown-code` | Reviews and fixes code in the worktree. | None by default. | Same worktree and injection limits as implement. | `TC-011`, `TC-015` |
| `ship` | Pushes branch or lands work according to `ship.target`. | Opens PR by default; direct push/auto-merge only by explicit opt-in. | Auto-merge relies on external branch protection today. | `TC-003`, `TC-012`, `TC-013` |

## Non-Pipeline Actions

| Action | Main capability | Claim(s) |
|---|---|---|
| `pr-review` | Fresh, out-of-context PR review that validates severity-tagged reports; `must-fix` or transport/validation failure exits non-zero through the `review` status. | `TC-003`, `TC-015` |
| `shipwreck` | Recovery path after ship failure; may inspect and repair local ship state. | `TC-011`, `TC-012`, `TC-015` |
| `roadmap` CLI | Adapter-backed list/get/claim/plan/mark-done/archive commands used by skills and harness. | `TC-006`, `TC-015` |
| `worktree-deps` | Symlink/install dependencies for a worktree and repair shared dependency layout. | `TC-011`, `TC-016` |

## Claude seat forge authority

The Claude child is an untrusted seat. Forge/remote credentials are an exhaustive internal `Step` policy, not operator configuration (`TC-014`, `TC-018`):

| Role | Forge / remote recovery credentials | Why |
|---|---|---|
| `pick`, `ship`, `shipwreck` | Retained (GitHub token vars, `LINEAR_API_KEY`, `SSH_AUTH_SOCK`, GitHub CLI config location) | Source-proven roadmap claim, landing, and recovery commands run inside those seats. |
| `plan`, `shakedown-plan`, `implement`, `shakedown-code`, `pr-review`, `pr-verify` | Denied: token env vars stripped; existing GitHub CLI config directories (`GH_CONFIG_DIR`, `$XDG_CONFIG_HOME/gh`, `$HOME/.config/gh`) **mount-masked** (a tmpfs over the mount namespace — not capability denial; a seat that nests its own user+mount namespace could unmount to re-expose them via the bound host root, the same userns residual as the socket mask) | Authoring and review/verify seats must not be able to post a forge status or mutate the tracker with harness-provided credentials. Leftover host credential files (`~/.git-credentials`, `~/.netrc`, `~/.ssh`) remain readable through the bound host root until `#572`, so the denial covers what the harness hands the seat, not every credential on the host. |
| Outer harness (`pr-review-cli`, `pr-adjudicate-cli`, workflow status steps) | Retains `GH_TOKEN` / `gh` | Deterministic comment and `review` status effects run after the untrusted seat exits. |

Every Claude child still receives the SDK-listed Anthropic/CLI auth names so the CLI can authenticate. Residual model-key exfil is bounded on both report shapes: MALFORMED reports surface only the invariant parse-failure sink (`#536`), and VALID reports are secret-scrubbed at render time — every model-authored field is run through the harness-env scrubber (literal secret values and their base64 forms) before the CI stdout and PR-comment sinks (`#554`). That the seat holds the key at all remains `#572` work, not a reason to give the seat forge authority. The same `#572` residual scopes the denied rows above: the seat keeps the host network and a bound host root outside the masked directories, so credentials in leftover host files (`~/.git-credentials`, `~/.netrc`, `~/.ssh`) are denied by convention, not by the mask (see [sandboxing](./sandboxing.md) and [threat model](./threat-model.md)).

## Configuration Gates

`ship.target` defaults to `pull-request`; `direct-push` and `auto-merge-pr` are explicit values in `.pelaggio.yml` or `--target` and emit a warning banner (`TC-012`). The notify webhook is disabled until `notify.url` is set (`TC-002`, `TC-006`). The server requires bearer auth on every bind — startup fails without `CONTROL_PLANE_TOKEN`, including on loopback — and exposes only `/healthz`, `/.well-known/pelaggio.trust.json`, and the static UI shell (`/` and `/ui/*`, which carries no run authority) outside the bearer chain (`TC-010`).
