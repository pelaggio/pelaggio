# Self-hosted subscription PR-review spike

## Decision

**NO-GO — 2026-07-16.** Phase 1 could not be completed because this execution
environment has neither access to the intended labelled self-hosted runner nor
an operator subscription credential, and network access is disabled. Lack of
that evidence is not evidence of safety. No runtime configuration, workflow,
runner, or review-mode vocabulary was changed.

The selected fallback is the existing `local` subscription review plus human
merge. The existing API-funded CI path remains available under its current
configuration; renaming it to `metered-ci` is deferred with all other post-gate
work.

| Decision field | Recorded value |
| --- | --- |
| Date | 2026-07-16 (America/Edmonton) |
| Reviewer | Not assigned; an independent operator review was unavailable |
| Intended runner | Unavailable; no labelled runner identifier could be observed |
| Intended image | Unavailable; no image or digest was provisioned |
| Repository baseline | `54e8300cdf0dc84a7c2be0dbb0f1caa5cb7099cc` |
| SDK baseline | `@anthropic-ai/claude-agent-sdk` `^0.3.177` (`0.3.177` in the lockfile) |
| Successful command shape | None; no subscription-authenticated command was executed |
| Credential lifecycle | Unknown and therefore unsafe to deploy |

## Evidence boundary

Only secret-free repository evidence was available. The current implementation
imports `query()` from `@anthropic-ai/claude-agent-sdk` in
`packages/pelaggio/scripts/pelaggio/step-runner.ts`; `.pelaggio.yml` selects
`review.runner: local`; and `.github/workflows/pr-review.yml` runs the optional
CI review on `ubuntu-latest` with a spend-capped `ANTHROPIC_API_KEY`. These facts
describe the baseline but do not validate subscription authentication on a
self-hosted runner.

No credential files, environment values, token contents, process snapshots,
runner logs, caches, artifacts, or image layers were inspected or captured.
Consequently there are no credential-derived hashes, timestamps, sanitized log
excerpts, or exit codes to retain. Recording fabricated observations would turn
the hard gate into a paper approval.

## Gate results

| Required demonstration | Result | Evidence / failure |
| --- | --- | --- |
| Credential discovery, ownership, and modes | Not tested | No intended runner or operator credential |
| Non-interactive `query()` without `ANTHROPIC_API_KEY` | Not tested | Subscription authentication unavailable |
| Expiry, refresh destination, persistence, and single-writer behavior | Not tested | Credential lifecycle unavailable |
| Cold start and container restart | Not tested | No review container or runner |
| Cancellation and non-zero fail-closed behavior | Not tested | No live job dispatch |
| Missing/invalid credential and rate limiting | Not tested | No live subscription execution |
| Log, argv, environment, artifact, cache, and image redaction | Not tested | No credential-bearing execution |
| Trusted-base/untrusted-head execution boundary | Not tested | No adversarial same-repository PR or isolated runner |
| Agent-tool isolation from reusable auth state | Failed by absence of proof | No supported broker/helper plus tool and network confinement was demonstrated |
| Provider-policy compatibility | Not tested | Current first-party terms could not be consulted without network access |
| GitHub Actions status identity (`app_id 15368`) | Not tested | No live workflow/status API evidence |

The decisive failure is agent-tool isolation. A container path, file mode,
prompt instruction, or log mask would not prevent an SDK-spawned Bash/file tool
from reading reusable auth state that the SDK can itself read, nor would it
prevent arbitrary network exfiltration. A future `GO` requires a supported
authentication boundary that supplies authentication to the SDK while denying
review tools raw reusable credentials and arbitrary exfiltration channels.

## Threat boundary

The required, but not yet demonstrated, boundary is:

```text
GitHub PR head (untrusted data: base SHA ... head SHA)
                         |
                         v
trusted base checkout -> review engine + constrained agent tools
                         |                 |
                         |                 +-- no host home / Docker socket /
                         |                     runner token / unrelated workspace
                         |                 +-- no arbitrary credential read or
                         |                     exfiltration network path
                         v
supported auth broker/helper (raw reusable state inaccessible to tools)
                         |
                         v
provider authentication
```

The PR head must only be materialized as the diff context. Trusted workflow
scripts, pelaggio code, dependencies, skills, rubric, and status-posting logic
must come from the pinned base commit or an immutable reviewed image. Changes in
the PR to package lifecycle scripts, workflows, pelaggio sources, or prompt
fixtures must never execute with access to subscription authentication.

## Provider-policy assessment

No provider-policy approval is recorded. Network restrictions prevented a
dated review of current first-party subscription terms and authentication
documentation, and no provider representative or approved internal policy was
available. The proposed GitHub-triggered container use therefore cannot be
shown to be no broader than the repository's existing unattended local SDK/CLI
subscription automation.

A renewed spike must record the consultation date and direct first-party
sources, identify the supported subscription login and refresh mechanism, and
compare credential sharing, concurrency, machine ownership, and service use
against the existing local flow. Third-party summaries are insufficient.

## Required rerun evidence

Run the spike on the actual allowlisted runner, as its non-root job account and
inside the proposed pinned review image. Retain only hashes, timestamps, exit
codes, image/runner identifiers, and sanitized excerpts. The rerun must cover:

1. A minimal SDK `query()` using the same package version and call path as
   `runStep`, with `ANTHROPIC_API_KEY` absent.
2. Expired and near-expiry credentials, safe refresh persistence, serialization
   of concurrent jobs, restart, cancellation, invalid credentials, and forced
   rate limiting.
3. Inspection of logs, arguments, environment exposure, cache/artifact config,
   filesystem mounts, and image history without revealing credential contents.
4. An adversarial PR changing `package.json`, lifecycle scripts, the review
   workflow, pelaggio sources, and prompt-injection fixtures.
5. Proof that agent-spawned tools cannot read reusable auth state or reach an
   arbitrary exfiltration endpoint while the SDK can still authenticate.
6. Current first-party policy citations and an explicit comparison with local
   unattended subscription use.

Any failed or missing item remains `NO-GO`. A successful rerun must add its exact
argv-safe command shape, immutable image digest, runner labels/identifier,
credential mount or broker details, refresh ownership and serialization, and an
independent reviewer sign-off before phases 2–4 begin.

## Cleanup and rotation

No subscription credential, runner registration, container, cache, artifact,
temporary ref, or worktree was created during this spike, so there is nothing
to rotate or revoke from this attempt.

After any future live attempt, whether successful or failed, the operator must
cancel remaining jobs, remove ephemeral workspaces and writable auth copies,
verify that no cache/artifact/image layer contains auth material, revoke and
rotate every credential exposed outside its proven boundary, remove temporary
runner registration when applicable, and record sanitized confirmation. A
partially refreshed credential must be treated as exposed until rotation is
confirmed.

## Rollout checklist (deferred until `GO`)

No rollout was attempted. After a future `GO`, use a controlled same-repository
PR to verify `pending` then `success`, commit-status context `review`, creator
`app_id 15368`, the separate `ci` requirement, and ordinary/auto merge without
`--admin`. Repeat with a blocking finding, invalid credential, forced rate
limit, cancellation, malicious dependency/workflow changes, and credential
refresh; every negative case must remain merge-blocking. Disable the old local
poster only after exactly one `review` owner is proven, and retain the explicit
metered hosted mode as fallback.
