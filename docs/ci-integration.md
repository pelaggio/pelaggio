# CI Integration — Autopilot Fix Workflow

Autopilot can run headlessly in CI to automatically fix bugs filed as GitHub Issues.
When an issue is labeled `autopilot:fix`, the workflow checks out the repo, runs the
full pipeline in **no-worktree mode**, and opens a PR for human review.

## How it works

1. Developer files a GitHub Issue describing the bug.
2. Developer (or automation) applies the `autopilot:fix` label.
3. `.github/workflows/autopilot-fix.yml` triggers on the `issues.labeled` event.
4. The workflow runs:
   ```
   pnpm autopilot --item <issue-number> --no-worktree --target pull-request --verbose
   ```
5. Autopilot creates a feature branch in-place (no sibling worktree), runs the full
   pick → plan → shakedown-plan → implement → shakedown-code → ship pipeline,
   and opens a PR via `gh pr create`.
6. If the run fails, the workflow posts a failure comment on the issue with a link
   to the workflow logs.
7. Human reviews and merges the PR.

## Required secrets

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Authenticates SDK calls to the Anthropic API |
| `GH_TOKEN` | Allows `gh pr create`, issue comments, and pushing the feature branch |

Add these under **Settings → Secrets and variables → Actions** in your repo.

## Required label

Create an `autopilot:fix` label in your repo (e.g. via `gh label create 'autopilot:fix' --color '#e4e669'`).

## Runner requirements

The workflow uses `runs-on: self-hosted`. The runner needs:
- Node.js 24+
- pnpm
- `git` configured with push access to the repo
- `gh` CLI authenticated (or `GH_TOKEN` set in the environment)
- `ANTHROPIC_API_KEY` available

For cloud runners (`ubuntu-latest`), replace `self-hosted` in the workflow and ensure
the runner has enough time — the default 6h job timeout covers most cycles.

## Configuration

The workflow passes `--target pull-request`, which overrides any `ship.target` in
`.autopilot.yml` for this run. To change the target globally, edit the workflow's
`run` step.

The issue number is used as the item ID. The pipeline uses the `github-issues`
roadmap adapter to fetch the issue title and body as the work item description.
Set `roadmap.source: github-issues` and `roadmap.github.repo: owner/repo` in
`.autopilot.yml` for this to work correctly.

## No-worktree mode constraints

- Only valid with a single explicit item (`--item <ID>`). Auto-pick from the queue is
  not supported — the CI runner is already isolated, so fan-out happens at the workflow
  job level, not inside a single autopilot run.
- `--parallel > 1` is not supported in no-worktree mode.
- Rate-limit park-and-resume is technically supported but not optimized for CI — the
  workflow will block waiting for the rate limit to clear. For ephemeral runners with
  short timeouts, consider splitting into multiple workflow runs instead.

## Auto-detect

No-worktree mode also activates automatically when either of these env vars is set:
- `CI=true` (standard in GitHub Actions and most CI providers)
- `CLAUDE_AUTOPILOT_SINGLE_SHOT=1` (explicit opt-in for non-standard CI)

When auto-detected, `--item` is still required. The `--no-worktree` flag is not needed
if your workflow already sets `CI=true`.

## Known limits

- Post-merge cleanup (closing the issue, archiving the plan) relies on GitHub's
  linked-PR auto-close behavior. The PR description should reference `Closes #<N>`.
- The ship step creates a PR (`--target pull-request`) and does not directly merge.
  Human review is required before merge.
- Linear and custom webhook triggers are out of scope for this POC.
