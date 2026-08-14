# Pelaggio

**Extend how much one developer can ship.**

Pelaggio moves every work item through the same fixed, auditable pipeline — plan, implement,
review, ship — at whatever level of supervision you're comfortable with. Sit in a verbose
session steering the roadmap by hand, hand off the whole backlog and let it run end to end,
or dial in anywhere between. Self-hosted, bring your own agent (Claude Code, Codex, Grok
Build, or OpenCode), every change behind a bounded blast radius.

```
pick → plan → shakedown-plan → implement → shakedown-code → ship
```

Each item runs on its own branch in its own git worktree, isolated from `main` and from your
other work. Each step runs in a fresh agent session with its own model, budget, and turn
limit. Shipping defaults to a **pull request** — autonomous direct-push is an explicit,
informed opt-in — and the optional
[PR review gate](https://github.com/pelaggio/pelaggio/blob/main/docs/pr-review.md) is
**fail-closed**: only a valid, severity-tagged report with no `must-fix` findings posts a
passing status. (The gate needs one-time runner setup in your repo — `init` does not
install it.)

Full story, docs, and source: **<https://github.com/pelaggio/pelaggio>**

## Install

### Prerequisites

- **Node ≥ 20.6** and a **git repository** to run in.
- **At least one agent CLI**, installed and logged in: Claude Code (`claude`), Codex
  (`codex`), Grok (`grok` — a version-pinned, managed setup with extra sandbox
  requirements; follow the
  [operator guide](https://github.com/pelaggio/pelaggio/blob/main/docs/grok.md)), or
  OpenCode (`opencode`).
- **`gh` (GitHub CLI), authenticated** — required to ship pull requests. The GitHub-issues
  roadmap source additionally requires `roadmap.github.repo` (`owner/repo`) in
  `.pelaggio.yml`; the roadmap label defaults to `autopilot`.
- **Windows:** run the pipeline inside [WSL](https://learn.microsoft.com/windows/wsl/); the
  non-pipeline CLI commands (`roadmap`, `stats`, `init`, `sync`) run natively.

### Quickstart

```bash
npx pelaggio init
```

`init` scaffolds `.claude/skills/`, a `_rubric.md` template, a roadmap example, and a
`.pelaggio.yml` stub into your repo (`--dry-run` previews the file plan). Then:

1. **Author `.claude/skills/_rubric.md` for your project** — the highest-leverage task.
   It's how Pelaggio learns *your* definition of done.
2. Replace the roadmap example with your real backlog.
3. Run `npx pelaggio run --cycles 1 --verbose`.

## Bring your own agent

Pelaggio drives the harness; you choose it. Claude Code, Codex, Grok Build
([operator guide](https://github.com/pelaggio/pelaggio/blob/main/docs/grok.md)), and
OpenCode ([operator guide](https://github.com/pelaggio/pelaggio/blob/main/docs/opencode.md))
run through one provider seam. Model IDs, per-step budgets, and effort are configuration,
not code — see the
[configuration reference](https://github.com/pelaggio/pelaggio/blob/main/docs/config.md).

## Trust is the product

For a tool that writes to your repo, the security posture *is* the feature — documented,
versioned, and falsifiable:

- **Worktree isolation** — each item runs on its own branch in its own git worktree;
  agent writes to the main checkout or sibling worktrees are blocked and audited.
  (Full-host confinement is the separate, opt-in jail below.)
- **PR-gated by default** — human review is the shipped default.
- **Fail-closed review gate** — a malformed report, an error, or a parked run blocks.
- **Authenticated control plane** — the daemon refuses to start unauthenticated on any
  host, including loopback.
- **No surprise egress** — self-hosted, no telemetry; known secret environment variables
  are scrubbed from prompts and structured logs (best-effort defense-in-depth — scope and
  limits are documented in the trust registry).

The threat model and the versioned trust-claims registry live in
[`docs/trust/`](https://github.com/pelaggio/pelaggio/tree/main/docs/trust).

## Contained execution (Linux)

Pelaggio can run one explicit argv command in a credential-free, network-isolated jail:

```bash
npx pelaggio run-contained --worktree "$PWD" -- node script.js arg
npx pelaggio run-contained --worktree "$PWD" --self-test
```

This requires Bubblewrap and a working user systemd manager. It fails closed when either is
unavailable or when the required namespace and cgroup controls cannot be established; it
never retries the command directly on the host. The jail mounts runtime files read-only,
mounts the selected worktree read-write while masking its `.git` entry, clears the
environment, and gives the process private home and temporary directories.

Successful command output is a JSON object containing the command status and a
host-computed `writeSet`. Entries explicitly identify creates, modifications (with SHA-256
digests), and deletions among tracked or non-ignored untracked files. The contained process
cannot supply this list.

Run `--self-test` on each host before relying on the boundary. It fails if any isolation
probe is unavailable or unsuccessful. `--debug` prints and retains bounded, non-secret
diagnostics under the gitignored `.dev/contained-runs/<run-id>/` directory after the jailed
process has stopped; normal runs remove private runner state.

## Learn more

- [Repository and full README](https://github.com/pelaggio/pelaggio)
- [Configuration reference](https://github.com/pelaggio/pelaggio/blob/main/docs/config.md)
- [PR review gate](https://github.com/pelaggio/pelaggio/blob/main/docs/pr-review.md)
- [Daemon and web UI](https://github.com/pelaggio/pelaggio/blob/main/docs/server.md)
- [Issues](https://github.com/pelaggio/pelaggio/issues)

## License

Copyright © 2026 Chris Horne. Licensed under the **GNU Affero General Public License,
version 3 or later** (`AGPL-3.0-or-later`). Because the Pelaggio project includes a
network-facing control plane (the daemon lives in the source repository, not in this
package), AGPL section 13 applies: if you run a modified version and let others interact
with it over a network, you must offer those users the corresponding source.
