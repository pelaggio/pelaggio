---
title: "ADR-0007: Publish = GitHub Release + provenance on a GitHub-hosted runner"
status: accepted
date: 2026-07-07
amended: 2026-09-07
claims: ["TC-005"]
construction: docs/releasing.md
---

# ADR-0007 — Publish = GitHub Release + provenance on a GitHub-hosted runner

## Context

A published package's provenance must be verifiable. The 2026-07-07 form of this decision required an SSH-signed tag and a self-hosted runner as the "trusted builder." Two facts reversed that builder choice for a public repository:

- npm provenance and trusted publishing require a **cloud-hosted** GitHub Actions runner. Self-hosted jobs fail provenance verification (`Unsupported GitHub Actions runner environment: "self-hosted"`).
- GitHub's hardening guide: self-hosted runners on public repos are a persistence hazard. A job that runs on your hardware can leave a backdoor. GitHub-hosted jobs are throwaway VMs.

The human-facing pause is a **draft GitHub Release**, not a signed tag. Publishing the draft is the only trigger that may talk to npm.

## Decision

1. **Publish only from a published GitHub Release** whose tag is `v` + the version in the published package manifest, and whose commit is an ancestor of `main`.
2. **The build that talks to npm runs on a GitHub-hosted runner**, authenticates with npm Trusted Publishing (OIDC), and publishes with provenance. No long-lived npm write token.
3. **A GitHub prerelease and a hyphenated semver are the same event** (npm dist-tag `next`). A stable semver is dist-tag `latest`. Mixed pairings are refused.

## Constraints on any implementation

- **Must not publish from a tag push, a draft, a laptop `npm publish`, or a self-hosted runner.** Tag-push workflows take their YAML from the tagged commit; a write-access tag on a malicious commit can rewrite the job. Drafts exist so notes can be edited without contacting npm.
- **Must refuse a version/tag mismatch and a tag that is not on `main`'s history.** Otherwise a UI click can ship the wrong tree.
- **Must not treat a self-hosted machine as the public provenance identity.** Consumers verify GitHub-hosted OIDC, not an unnamed box.
- **Must not use a long-lived npm write token for CI publish.** Trusted Publishing is the auth; a bypass-2FA token is the thing npm warns against.

## Alternatives not taken

- **SSH-signed tags as the gate** — extra key ceremony; the draft release is the review step consumers and the operator both see. npm provenance is the consumer-verifiable attestation.
- **Self-hosted runner as "trusted builder"** — inverted relative to npm provenance, and unsafe on a public repo.
- **semantic-release / release-please** — auto-publish from main fights the draft-and-click pause.
- **Scoped `@pelaggio/pelaggio`** — would break `npx pelaggio`. Keep the unscoped name.

## Consequences

- (+) One irreversible human action (Publish release), with notes attached, provenance on the tarball, and a refuse-closed mismatch check.
- (−) Relies on GitHub-hosted OIDC and the trusted-publisher binding on npmjs.com. Live attestation lookup remains network-only.

## Construction

`docs/releasing.md` — operator path (`pnpm release:draft`, then Publish). `.github/workflows/publish.yml` — the npm job. `docs/publish-audit.md` — one-time first-publish checklist.
