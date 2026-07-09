---
title: Reproducible install
description: Pinned install guidance and honest supply-chain limits.
status: draft
diataxis: tutorial
sidebar:
  order: 8
last_reviewed: 2026-07-08
---

# Reproducible Install

Pelaggio's own package is checked to ship no `preinstall`, `install`, or `postinstall` lifecycle scripts (`TC-004`). That guarantee does not cover every transitive dependency in a normal package-manager install (`TC-016`). Signed tags and npm provenance harden releases, but live downstream attestation verification is not a local guarantee (`TC-005`).

## Pin What You Run

Use your package manager's lockfile and pin the Pelaggio version in the consuming repo (`TC-004`, `TC-016`):

```bash
npm install --save-dev pelaggio@<version>
npm ci
```

or with pnpm:

```bash
pnpm add -D pelaggio@<version>
pnpm install --frozen-lockfile
```

The lockfile is the reproducibility boundary for dependency resolution (`TC-016`). Avoid treating `npx pelaggio@latest ...` as reproducible; it is useful for trials, not pinned operations (`TC-005`, `TC-016`).

## Bootstrap and Sync

Preview bootstrap files before writing them:

```bash
npx pelaggio init --dry-run
```

After pinning/updating the package, compare installed skills with:

```bash
npx pelaggio sync --dry-run
```

These commands manage Pelaggio's local files and skill substrate; they do not change the fact that live pipeline runs may send prompts/source/diffs to the configured provider and integrations (`TC-006`).

## Release Hardening

The release workflow requires signed tags and `npm publish --provenance` (`TC-005`). The local guarantee is narrower: the checked package manifests have no install lifecycle scripts (`TC-004`), and the docs disclose that transitive dependencies can still run lifecycle scripts during a normal install (`TC-016`).
