# CI Integration

This repository's GitHub Actions do **not** run the pelaggio pipeline. CI on
`ubuntu-latest` tests, typechecks, and optionally deploys the marketing site.
Publishing the npm package is a GitHub Release, documented in
[`releasing.md`](./releasing.md).

Supervised end-to-end runs stay on an operator machine — see
[`agent-context/supervised-run.md`](./agent-context/supervised-run.md). A
label-to-agent workflow on a public repo was removed: it required a persistent
self-hosted runner holding provider keys.

The CLI still auto-detects CI for *consumers* who run pelaggio in their own
Actions:

- `CI=true` (standard in GitHub Actions) activates no-worktree mode
- `PELAGGIO_SINGLE_SHOT=1` is an explicit opt-in for non-standard CI

No-worktree mode still requires `--item <ID>`, and `--parallel > 1` is not
supported in that mode.
