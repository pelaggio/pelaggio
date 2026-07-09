# Trust surface

This directory is Pelaggio's trust surface: what the orchestrator can touch, what leaves your machine, what is only a default, and what is not yet a guarantee. The source of truth is [`trust-claims.yml`](./trust-claims.yml). Human docs cite claim IDs from that registry; the checked-in [`pelaggio.trust.json`](./pelaggio.trust.json) is the machine-readable projection with the same IDs.

## Start Here

| Doc | What it answers | Claim center |
|---|---|---|
| [`overview.md`](./overview.md) | The top five evaluator questions. | `TC-001` through `TC-016` |
| [`threat-model.md`](./threat-model.md) | Prompt injection, STRIDE, LINDDUN, and residual risk. | `TC-015`, `TC-006`, `TC-014` |
| [`permission-model.md`](./permission-model.md) | Permission tiers and step capabilities. | `TC-003`, `TC-011`, `TC-012`, `TC-013` |
| [`sandboxing.md`](./sandboxing.md) | Worktrees, hooks, dependency sharing, and current limits. | `TC-011`, `TC-015` |
| [`egress.md`](./egress.md) | Provider, roadmap, git remote, and notify destinations. | `TC-002`, `TC-006`, `TC-014` |
| [`quickstart.md`](./quickstart.md) | A safe dry-run path for first evaluation. | `TC-002`, `TC-006`, `TC-012` |
| [`self-host.md`](./self-host.md) | Control-plane hosting, bearer auth, and manifest serving. | `TC-010`, `TC-006` |
| [`reproducible-install.md`](./reproducible-install.md) | Pinned installs, release hardening, and dependency honesty. | `TC-004`, `TC-005`, `TC-016` |
| [`uninstall-and-rollback.md`](./uninstall-and-rollback.md) | Stop runs, remove generated files, clean branches/worktrees, rollback pushes. | `TC-003`, `TC-012`, `TC-013` |
| [`license.md`](./license.md) | Plain-English FSL-1.1-ALv2 terms. | `TC-005`, `TC-016` |

## Reference

| Doc | What it contains | Claim center |
|---|---|---|
| [`reference/permissions.md`](./reference/permissions.md) | Capability and step matrix from the manifest/config. | `TC-003`, `TC-010`, `TC-011`, `TC-012`, `TC-013`, `TC-015` |
| [`reference/errors.md`](./reference/errors.md) | Server HTTP codes and pipeline step subtypes. | `TC-003`, `TC-010`, `TC-011`, `TC-014`, `TC-015` |
| [`reference/artifacts-and-state.md`](./reference/artifacts-and-state.md) | Files, logs, plans, worktrees, branches, PR comments, and server state. | `TC-001`, `TC-006`, `TC-011`, `TC-014`, `TC-015` |

## Registry, Manifest, Verifier

[`trust-claims.yml`](./trust-claims.yml) is the registry. A claim's `status` is normative: `guarantee` means a tested local mechanism fails the operation if violated; `default` means the shipped default can be changed; `best_effort` means partial/advisory; `planned` means not shipped as a guarantee yet.

[`pelaggio.trust.json`](./pelaggio.trust.json) is generated from the registry for tools that need to inspect Pelaggio before running it (`TC-006`, `TC-010`, `TC-012`). The control-plane daemon serves that checked-in manifest publicly at `/.well-known/pelaggio.trust.json`, before bearer auth, and reports `not-found` or `read-error` if it cannot serve the file (`TC-010`).

Regenerate the manifest with `pnpm trust:generate`. Verify the registry, schema, generated JSON, and every `guarantee` evidence command with `pnpm check:trust`. The full project verification still runs through `pnpm check`, `pnpm check:skills`, and the targeted `tsx --test` commands in `.claude/skills/_rubric.md`.
