# Supervising an autopilot run (operator runbook)

This is the procedure for an **agent or human supervising an end-to-end Pelaggio run out-of-band** — starting a cycle, watching it to a PR, reviewing, landing, and cleaning up. It is distinct from the per-step pipeline skills (`pick`/`plan`/`shakedown`/`ship`), which run *inside* the autonomous cycle. This runbook runs *about* a cycle.

It owns only the **out-of-band delta**: driving a cycle by hand and landing it via an admin path. For the mechanics of each step, defer to `ship`, `pr-review`, and `roadmap-and-ship.md`.

> Many steps below are workarounds for a current gap, tagged **(until #N)**. As the CLI absorbs each one, delete that step — this runbook should shrink over time, not grow.

## Procedure

1. **Prune worktrees first.** `git worktree prune`. A stale review-head worktree makes the confinement audit fail. (until worktree GC is automatic — see `tidy`.)
2. **Run the cycle.** `pnpm pelaggio --item <N> --cycles 1`; watch it to a PR. On a transient `529`/`Overloaded`, `pnpm pelaggio --resume <N>` (work is checkpointed via `parkExit`; resume re-enters fresh — [ADR-0019](../decisions/0019-checkpoint-restart-not-replay.md)).
3. **Review from the worktree.** `cd` into the item worktree; confirm `git rev-parse HEAD` equals the PR head; `npx pelaggio pr-review --pr <N>`. Fix must-fix findings **directly** and add regression tests; re-review until `survivors=0`. (The `pr-review` skill is a read-only CI gate; the fix-and-re-review loop is the supervisor's, not the pipeline's.)
4. **Verify from the worktree.** `pnpm --filter pelaggio test` and `pnpm check`, **run from the worktree** — running from the main checkout tests the wrong code. `pnpm check` trips on stale `.dev/review-heads/*`; clear with `git worktree prune`. (until #131/#246.)
5. **Land.** Wait for CI green first, then `gh pr merge <N> --repo <owner/repo> --squash --admin --delete-branch`. `--admin` is required only because a local-subscription review posts as `app=None` against the app-15368 branch-protection pin — it bypasses the *review-pin*, **not** CI. (until the review posts under the pinned app — see `roadmap-and-ship.md`.)
6. **Mark done.** After an admin merge, `npx pelaggio roadmap mark-done <N>` — an admin merge bypasses the pipeline's post-merge mark-done, so the issue otherwise stays open. (until #205.)
7. **Clean up.** Remove the worktree; sync main via a **rebase-pull that preserves any concurrent session's unpushed local commits** (`git pull --rebase`; never fast-forward-discard or reset).

## Escalation adjudication

When the driver pulls the Andon cord ([ADR-0011](../decisions/0011-andon-not-dor.md)) or a review does not converge, the supervisor adjudicates. The defaults:

- **A `blocked` outcome** → allow **one decorrelated retry** (a fresh attempt, on a *different seat/provider where available*). A **second, reproduced block escalates** to the human; do not retry a third time. `missing-decision` / `external-dependency` kinds — which a retry cannot resolve — escalate on the first block.
- **A safety-class finding that survives** → never merge; park for the human. This is a deterministic gate, not a tolerance setting ([ADR-0016](../decisions/0016-severity-taxonomy-and-owner.md)).
- **A judgment-band dissent** → land or park per the project's tolerance policy ([ADR-0015](../decisions/0015-autonomy-by-default-configurable-tolerance.md)); either way, record the Judge's reasoning in the PR as the documented decision.
- **A transient rate-limit / outage** → `--resume`, do not abort.

Under [ADR-0015](../decisions/0015-autonomy-by-default-configurable-tolerance.md), a fully-automated supervisor may merge when the deterministic gates pass and the reasoned decision is recorded; the human is pulled in only by a deterministic-gate trip or a reproduced block.
