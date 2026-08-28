---
title: Trust overview
description: Five evaluator questions about Pelaggio's current guarantees, defaults, and limits.
status: draft
diataxis: explanation
sidebar:
  order: 1
last_reviewed: 2026-08-19
threat_model_ref: ./threat-model.md
---

# Trust Overview

Pelaggio is an autonomous development orchestrator: it reads repo, issue, PR, and tool-output text, runs model-backed steps, writes code, and ships branches. The trust docs are a human projection of the [claim registry](./trust-claims.yml); every guarantee/default/limit below is scoped to claim IDs, and the machine projection lives in [`pelaggio.trust.json`](./pelaggio.trust.json).

## Five Questions

### 1. Can it push to my default branch?

By default, no. `ship.target` resolves to `pull-request`, so the shipped default opens a PR instead of pushing to the default branch (`TC-012`, [permission model](./permission-model.md), [`ADR-0003`](../decisions/0003-pr-gated-by-default.md)). `direct-push` and `auto-merge-pr` are explicit, warned opt-ins (`TC-012`). Auto-merge safety still depends on external branch protection today; in-code verification that the required review gate is enforceable is planned, not current (`TC-013`, [uninstall and rollback](./uninstall-and-rollback.md)).

### 2. What can it write?

Pelaggio is designed around item worktrees, and mutating steps receive hooks/conventions that steer writes into the claimed worktree; by default, a shipped post-step confinement audit then fails the step if any change lands in the main checkout or a sibling worktree (`TC-011`, [sandboxing](./sandboxing.md), [`ADR-0001`](../decisions/0001-worktree-write-confinement.md)). With `confinement.allow-dirty-main`, Claude attributes main Git-state deltas across mutating-tool windows, Codex excludes main through its workspace boundary, and siblings remain whole-step audited. On Linux, a Claude step also wraps the SDK CLI in a detached Bubblewrap PID + mount namespace so the seat cannot inherit the harness controlling terminal, read host `/proc/<harness-pid>`, or see configured harness-only socket directories; the child env is deny-by-default, and forge-denied roles lose GitHub token variables and existing GitHub CLI config directories (`TC-014`, `TC-018`). That wrap is not a full OS/container sandbox: the seat still has the host network, a bound host root outside those masks (including leftover host credential files), and Anthropic/CLI auth names because the child is the API client (`TC-011`, `TC-015`, `TC-018`).

### 3. What leaves my machine?

There is no analytics or telemetry channel at all (`TC-002`). Operational egress is limited by configuration to the selected model provider, enabled roadmap adapter, git remote, and optional notify webhook (`TC-006`, [egress matrix](./egress.md)). Selecting a provider sends it legitimate prompt and repository/read-file context under its retention policy. Driver children receive a deny-by-default environment and captured logs are credential-scrubbed (`TC-014`), but those controls do not hide task context from the selected provider. Grok's managed sandbox confines filesystem and child-network behavior where Linux Landlock is available; its observed in-process service hostname is a release-conformance lock, not an OS allowlist, and its unsandboxed fallback is supervised-only ([Grok setup](../grok.md), [sandboxing](./sandboxing.md)).

### 4. What blocks an unsafe merge?

In pull-request mode, the review gate fails closed: each successful review must emit a validated severity-tagged report, and any `must-fix` blocks. `nice` and `note` do not block; silence, malformed output, refusal, SDK failure, max-turns, or rate-limit park does (`TC-003`, [errors reference](./reference/errors.md), [PR review docs](../pr-review.md)). The compatibility gate remains the `review` commit status. The default PR target keeps a human gate in the loop (`TC-012`). For `auto-merge-pr`, enforcement depends on branch protection requiring that status today; in-code branch-protection verification is planned (`TC-013`).

### 5. Can I trust the package/install path?

Pelaggio's own published package and workspace manifests do not use `preinstall`, `install`, or `postinstall` lifecycle scripts, and the release gate checks that (`TC-004`, [reproducible install](./reproducible-install.md)). Signed tags plus npm provenance harden releases, but live downstream attestation verification is not a local guarantee (`TC-005`). Normal installs can still execute transitive dependency lifecycle scripts; that is documented rather than hidden (`TC-016`). The repo license is AGPL-3.0-or-later — OSI-approved free and open source software ([license](./license.md)).

## What Is Still Open

The defining threat is prompt injection through attacker-reachable repo, issue, PR, dependency, and tool-output text (`TC-015`, [threat model](./threat-model.md), [`ADR-0002`](../decisions/0002-untrusted-input-and-tool-scope.md)). Current bounds are worktree conventions/hooks with a shipped post-step confinement audit, PR gating, budget/turn caps, and explicit egress surfaces (`TC-003`, `TC-006`, `TC-011`, `TC-012`, `TC-015`). A designed injection defense with least-privilege tools, provenance-aware input handling, and harder output controls is not claimed yet (`TC-015`).

## Verify

Use the registry and manifest as the auditable surface (`TC-001` through `TC-018`):

```bash
pnpm check:trust
pnpm trust:generate
```

The daemon also serves the machine manifest at `/.well-known/pelaggio.trust.json` when configured (`TC-010`). See [self-host](./self-host.md) for the hosting posture and [README](./README.md) for the full doc map.
