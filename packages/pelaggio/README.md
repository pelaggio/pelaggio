# Pelaggio

The published Pelaggio pipeline. See the [repo root README](../../README.md) for usage; this package directory holds the runtime entry points (`scripts/pelaggio.ts`, `bin/pelaggio.js`) and the pipeline modules under `scripts/pelaggio/`.

Skills (`.claude/skills/`) and consumer templates (`.claude-templates/`) live at the monorepo root for dogfooding, and are copied into this package by the `prepack` lifecycle script before publishing.

## Contained execution

On Linux, Pelaggio can run one explicit argv command in a credential-free, network-isolated jail:

```bash
npx pelaggio run-contained --worktree "$PWD" -- node script.js arg
npx pelaggio run-contained --worktree "$PWD" --self-test
```

This command requires Bubblewrap and a working user systemd manager. It fails closed when either is unavailable or when the required namespace and cgroup controls cannot be established; it never retries the command directly on the host. The jail mounts runtime files read-only, mounts the selected worktree read-write while masking its `.git` entry, clears the environment, and gives the process private home and temporary directories.

Successful command output is a JSON object containing the command status and a host-computed `writeSet`. Entries explicitly identify creates, modifications (with SHA-256 digests), and deletions among tracked or non-ignored untracked files. The contained process cannot supply this list.

Run `--self-test` on each host before relying on the boundary. It fails if any isolation probe is unavailable or unsuccessful. `--debug` prints/retains bounded, non-secret diagnostics under the gitignored `.dev/contained-runs/<run-id>/` directory after the jailed process has stopped; normal runs remove private runner state.
