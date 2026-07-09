---
title: Safe quickstart
description: A five-minute dry-run path for evaluating Pelaggio without remote mutation.
status: draft
diataxis: tutorial
sidebar:
  order: 6
last_reviewed: 2026-07-08
---

# Safe Quickstart

This path is for evaluating generated files and pipeline shape before allowing live model/provider or remote mutation. Dry-run avoids SDK/network mutation in the pipeline and may still read local repo/config state (`TC-006`, `TC-012`, `TC-015`).

## 1. Preview Bootstrap Files

```bash
npx pelaggio init --dry-run
```

Inspect the planned `.claude/skills/`, `.pelaggio.yml`, and starter docs before writing them. The published package itself has no install lifecycle scripts (`TC-004`), but normal package-manager resolution can still involve transitive dependency behavior outside Pelaggio's own manifest (`TC-016`).

## 2. Run One Dry Cycle

In a consumer repo:

```bash
npx pelaggio run --dry-run --cycles 1
```

When dogfooding this monorepo:

```bash
pnpm pelaggio --dry-run --cycles 1
```

Dry-run step results are synthetic and do not call the SDK provider for step execution (`TC-006`). The pipeline still reads local config, resolves defaults, and exercises orchestration paths, so treat repo/issue/PR text as untrusted input in any real run that follows (`TC-015`).

## 3. Check the Default Posture

Read the generated/local trust docs and config:

```bash
pnpm check:trust
cat docs/trust/pelaggio.trust.json
```

The default ship target is `pull-request`, not direct default-branch push (`TC-012`). No telemetry exists to disable (`TC-002`). The notify webhook is off until `notify.url` is set (`TC-006`). For live runs, configure only the provider/roadmap endpoints you intend to use (`TC-006`).
