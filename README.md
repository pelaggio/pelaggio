# Pelaggio

**Extend how much one developer can ship.**

Pelaggio moves every work item through the same fixed, auditable pipeline — plan, implement,
review, ship — at whatever level of supervision you're comfortable with. Sit in a verbose
session steering the roadmap by hand, hand off the whole project and let it run end to end,
or dial in anywhere between. You choose the involvement and the token budget; the pipeline
runs with the same discipline either way. Self-hosted, bring your own agent (Claude Code,
Codex, Grok Build, or OpenCode), every change behind a bounded blast radius.

> **The name.** *Pelaggio* plays two notes at once. **Arpeggio**: a chord rolled note by
> note — the way every work item moves through the pipeline in legible, interruptible
> sequence. A chord struck all at once is a black box; rolled as an arpeggio, every note
> can be heard. And *pelagos*, the open sea: its agents work **pelagic** — out in open
> water, far from the shore of direct control. Say it *peh-LAH-joh*. The orchestrator
> answers to **Joe**.

## Why Pelaggio

Autonomous coding agents can write a lot of code. Few are built for the solo developer (or
small team) who has to live with the result — where there's no one else to catch a bad merge
and a runaway agent is nobody's problem but yours. Pelaggio is built to extend your reach
without taking away your control:

- **Supervision on your terms.** Watch every session and steer the roadmap by hand, run it
  entirely unattended, or anywhere between — the same pipeline and the same guardrails at
  whatever involvement (and token budget) you choose.
- **Bring your own agent.** Claude Code, Codex, Grok Build, and OpenCode, driven through one
  provider seam — it's designed for choice, not lock-in.
- **Bounded blast radius.** Every item runs in its own git worktree, isolated from `main`
  and from your other work. Shipping defaults to a **pull request**; autonomous direct-push
  to `main` is an explicit, informed opt-in — never the silent default.
- **Fail-closed, not fail-open.** The review gate validates severity-tagged findings and
  blocks on any `must-fix`, malformed report, error, or parked run.
- **Self-hosted.** Runs on your machine or your infra. No telemetry. Your code and prompts
  don't touch our servers, because there are none.
- **Trust is the product.** For a tool that writes to your repo, the security posture *is*
  the feature — documented, versioned, and falsifiable. See [`docs/trust/`](./docs/trust/).

## What it does

Given a roadmap of work items, Pelaggio runs a fixed pipeline per item:

```
pick → plan → shakedown-plan → implement → shakedown-code → ship
```

- **pick** — select the next available item; create a feature branch + worktree
- **plan** — generate an implementation plan, write it to `docs/plans/`, self-review, commit
- **shakedown-plan** — independent review of the plan against *your* rubric → APPROVE / REVISE / RETHINK
- **implement** — execute the plan incrementally, committing as it goes
- **shakedown-code** — review the diff against your rubric, fix issues, run verification
  (typecheck / lint / tests), file deferred work back to the roadmap
- **ship** — open a PR (or, opt-in, merge), update docs, clean up the worktree

Each step runs in a fresh agent session with its own context, model, budget, and turn
limit. A rate-limit rejection triggers a `wip:` checkpoint commit and parks the cycle for
resume — no work is lost.

## Bring your own agent

Pelaggio drives the harness; you choose it. The provider seam is real, not aspirational:

- **Claude Code** (Claude Agent SDK) — the original driver.
- **Codex** — a first-class second driver.
- **Grok Build** — an ACP driver with a pinned, managed sandbox setup; see the
  [Grok operator guide](./docs/grok.md).
- **OpenCode** — a headless driver fronting 75+ model backends through one CLI; see the
  [OpenCode operator guide](./docs/opencode.md).

Model IDs, per-step budgets, and effort are configuration, not code — see `.pelaggio.yml`.

## Trust is the product

Pelaggio's guarantees are documented and verifiable, not marketing:

- **Worktree isolation** — each item works only inside its own git worktree.
- **PR-gated by default** — human review is the shipped default; direct-push is opt-in.
- **Fail-closed review gate** — only a valid report without `must-fix` findings passes.
- **Authenticated control plane** — the daemon refuses to start unauthenticated on
  any host, including loopback; no silent open port.
- **No surprise egress** — self-hosted, no telemetry, and secrets are never interpolated
  into prompts or logs.

The threat model and the full trust posture live under [`docs/trust/`](./docs/trust/).

## Install

### Prerequisites

- **Node ≥ 20.6** and a **git repository** to run in.
- **At least one agent CLI**, installed and logged in: Claude Code (`claude`), Codex
  (`codex`), Grok (`grok` — a version-pinned, managed setup with extra sandbox
  requirements; follow the [operator guide](./docs/grok.md)), or OpenCode (`opencode`).
- **`gh` (GitHub CLI), authenticated** — required to ship pull requests. The GitHub-issues
  roadmap source additionally requires `roadmap.github.repo` (`owner/repo`) in
  `.pelaggio.yml`; the roadmap label defaults to `autopilot`.
- **Windows:** run the pipeline inside WSL — see [Platform support](#platform-support).

### Quickstart

```bash
npx pelaggio init
```

`init` scaffolds `.claude/skills/`, a `_rubric.md` template, a roadmap example, and an
`.pelaggio.yml` stub into your repo. Invoke the pipeline with `npx pelaggio run`.
Re-running is a no-op unless you pass `--force`; use `--dry-run` to preview the file plan.

Then:

1. **Author `.claude/skills/_rubric.md` for your project** — the highest-leverage task. It's
   how Pelaggio learns *your* definition of done.
2. Replace the roadmap example with your real backlog.
3. Run `pelaggio run --cycles 1 --verbose`.

`pelaggio pr-review --pr <number>` is the automated PR merge-gate entry point,
not a general-purpose interactive review command. It inspects the named pull request,
upserts the gate comment, posts the `review` commit status on the PR head, and returns
a non-zero exit code when the gate blocks. The default CI runner invokes it from
`.github/workflows/pr-review.yml`; see the [PR review gate guide](./docs/pr-review.md)
for runner setup and required credentials.

`pelaggio revise --pr <number>` is the operator fix command for a currently red
Pelaggio-managed PR: it fetches the marked review findings and re-enters the
findings-driven resume pipeline. `--allow-repeat` bypasses only the one-pass
`autopilot:revised` label — it does not skip review, confinement, or the ship
target. Invoke it from the main checkout, the same station as `land` / `pr-review`.

`pelaggio pr-adjudicate --pr <number>` is the local-operator “go” after a *narrow*
fix on a findings-terminal review: it re-verifies only the recorded repair hunks
and posts `review=success` to the pinned head. Broad churn, missing source
evidence, or a surviving safety finding refuses and sends you back to a full
`pr-review` / `revise`. Same main-checkout station as `pr-review` / `land`.

### Platform support

Pelaggio runs on macOS, Linux, and **Windows via [WSL](https://learn.microsoft.com/windows/wsl/)**. The
pipeline leans on POSIX filesystem semantics — worktrees share `node_modules`
through symlinks, and skill bodies run as `bash` — so on Windows, run the
pipeline (`pelaggio run`) inside a WSL distribution rather than native
PowerShell/cmd, where directory symlinks require elevation and bash is absent.
The non-pipeline CLI commands (`pelaggio roadmap …`, `stats`, `init`, `sync`) work
natively on Windows.

## Using it on itself

Pelaggio develops itself: open work lives in GitHub issues under the `autopilot` label
(configured via `.pelaggio.yml` → `roadmap.source`). Running it on its own backlog is where
the guarantees get tested — if it can't ship real work unattended, it doesn't ship.

## Stats

`pelaggio stats` streams the append-only cycle log and prints an aggregate dashboard — token
totals, cost per step, cache-hit ratio, retry and rethink rates, and recent items. There's
no separate state file; the reducer runs over the log on each invocation.

## Where it came from

Pelaggio started as scaffolding for another project of mine. Every roadmap item ran the same
loop — plan it, build it, review it, ship it — so I was
copying the same prompts into parallel agent sessions by hand. They kept colliding, stepping
on each other's files, so I isolated them into separate worktrees. I wanted to check in on
them less, so I added remote supervision and per-step budgets. When I ran out of Claude tokens
mid-run, I taught the pipeline to fall back to Codex — so it stopped mattering which agent was
driving. When I moved on to the next project, I pulled that core out, generalized it, and
shaped it into the engine you're reading about.

Every feature here is scar tissue from that: worktree isolation because sessions collided, the
supervision and budget dials because I wanted my evenings back, bring-your-own-agent because I
ran out of tokens and needed a substitute, the fixed pipeline because I was already running it
by hand.

## License

Copyright © 2026 Chris Horne.

Licensed under the **GNU Affero General Public License, version 3 or later**
(`AGPL-3.0-or-later`) — see [`LICENSE`](./LICENSE). You may use, modify, self-host, and
redistribute Pelaggio under the AGPL's terms — there is no field-of-use or competing-use
restriction. Because Pelaggio includes a network-facing control plane, the AGPL's section 13
applies: if you run a modified version and let others interact with it over a network, you
must offer those users the corresponding source of your modified version. Pelaggio is
genuinely open source (OSI-approved).

Contributions are accepted under the [Developer Certificate of Origin](./DCO); see
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for the required `Signed-off-by` sign-off.
