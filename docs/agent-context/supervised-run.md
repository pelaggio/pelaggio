# Supervising an autopilot run (operator runbook)

This is the procedure for an **agent or human supervising an end-to-end Pelaggio run out-of-band** — starting a cycle, watching it to a PR, reviewing, landing, and cleaning up. It is distinct from the per-step pipeline skills (`pick`/`plan`/`shakedown`/`ship`), which run *inside* the autonomous cycle. This runbook runs *about* a cycle.

It owns only the **out-of-band delta**: driving a cycle by hand and landing it via an admin path. For the mechanics of each step, defer to `ship`, `pr-review`, and `roadmap-and-ship.md`.

> Many steps below are workarounds for a current gap, tagged **(until #N)**. As the CLI absorbs each one, delete that step — this runbook should shrink over time, not grow.

## Procedure

1. **Prune worktrees first.** `git worktree prune`. A stale review-head worktree makes the confinement audit fail. (until worktree GC is automatic — see `tidy`.)
2. **Run the cycle.** `pnpm pelaggio --item <N> --cycles 1`; watch it to a PR. Do **not** pass `--verbose` on supervised runs — supervise from the out-of-band station/logs instead. On a transient `529`/`Overloaded`, `pnpm pelaggio --resume <N>` (work is checkpointed via `parkExit`; resume re-enters fresh — [ADR-0019](../decisions/0019-checkpoint-restart-not-replay.md)).

When an adversarial-review escalation is resolved `proceed`, inspect the committed resolution and evidence, then resume with the exact fingerprint printed by the park message: `pnpm pelaggio --resume <N> --acknowledge-escalation <fingerprint>`. A missing or mismatched acknowledgement parks again, and `resolved-block` cannot be acknowledged through.
3. **Review from the worktree.** `cd` into the item worktree; confirm `git rev-parse HEAD` equals the PR head; `npx pelaggio pr-review --pr <N>`. Fix must-fix findings **directly** and add regression tests; re-review until `survivors=0`. (The `pr-review` skill is a read-only CI gate; the fix-and-re-review loop is the supervisor's, not the pipeline's.)
4. **Verify from the worktree.** `pnpm --filter pelaggio test` and `pnpm check`, **run from the worktree** — running from the main checkout tests the wrong code. `pnpm check` trips on stale `.dev/review-heads/*`; clear with `git worktree prune`. (until #131/#246.)
5. **Land.** With the unpinned-`review` + `ship.target: auto-merge-pr` posture (see `docs/pr-review.md#alternative-local-review-auto-merge-unpinned-review`), landing is automatic once `ci` and `review` are green — skip this step and step 6; supervision is retrospective. The admin path below applies only if the `review` app-pin is (re)enabled. `--admin` **bypasses branch protection**, so it is an out-of-band exception, not the standard path ([ADR-0003](../decisions/0003-pr-gated-by-default.md), ADR-0005). Use `npx pelaggio land --pr <N> --repo <owner/repo> --admin` rather than a raw `gh pr merge --admin`: it reads the PR's CI status directly and refuses to merge (exit 1, with a diagnostic) unless every check has completed green — deterministic, not operator discipline (issue #292). `--admin` is required only because a local-subscription review posts as `app=None` against a branch-protection pin (in this repo, GitHub app id `15368` — environment-specific, may change) — it bypasses the *review-pin*, **never** the CI-green requirement. Because the admin path also skips the pipeline's post-merge tail, you must run step 6 (mark-done) and confirm post-merge verify by hand. The guard degrades to CI-green-alone until the ADR-0018 attestation (#188) lands; it never fails open. (`--admin` bypassing the review-pin is why the path is temporary — until the review posts under the pinned app; see `roadmap-and-ship.md`.)
6. **Mark done.** After an admin merge, `npx pelaggio roadmap mark-done <N>` — an admin merge bypasses the pipeline's post-merge mark-done, so the issue otherwise stays open. (Admin PR merge never runs the direct-push bookkeeping tail; #205's claim-branch retention only covers direct-push mark-done failure, not this path.)
7. **Clean up.** Remove the worktree; sync main via a **rebase-pull that preserves any concurrent session's unpushed local commits** (`git pull --rebase`; never fast-forward-discard or reset).

## Concurrent human work

Don't inspect, fix up, or otherwise edit files inside the main checkout or a claimed item worktree while a cycle holds it. The confinement audit snapshots main plus every registered sibling worktree before, periodically during, and after each step (`pipeline.md`); a concurrent edit is indistinguishable from a real violation, and a mid-step trip now fails the cycle closed with an early abort rather than parking it (#388) — a park would checkpoint the now-contaminated tree, and `--resume` re-enters "fresh" onto it, re-burning spend against state already proven compromised (see [ADR-0019](../decisions/0019-checkpoint-restart-not-replay.md)). Do your own review or fixups from a **separate `git clone`**, not a second `git worktree add`: a worktree registers with `git worktree list` and becomes a new sibling the running cycle's audit tracks (so your own edits there would trip it), while a plain clone has its own independent `.git` the audit never enumerates. Only touch the live worktree once the cycle has exited (parked, completed, or errored).

## Escalation adjudication

When the driver pulls the Andon cord ([ADR-0011](../decisions/0011-andon-not-dor.md)) or a review does not converge, the supervisor adjudicates. The defaults:

- **A `blocked` outcome** → allow **one decorrelated retry** (a fresh attempt, on a *different seat/provider where available*). A **second, reproduced block escalates** to the human; do not retry a third time. If no alternate provider is configured the retry is **same-seat and correlated** — treat a second same-seat block as *weaker* evidence and prefer escalating rather than trusting the re-run. `missing-decision` / `external-dependency` kinds — which a retry cannot resolve — escalate on the first block.
- **A safety-class finding that survives** → never merge; park for the human. This is a deterministic gate, not a tolerance setting ([ADR-0016](../decisions/0016-severity-taxonomy-and-owner.md)).
- **A judgment-band dissent** → land or park per the project's tolerance policy ([ADR-0015](../decisions/0015-autonomy-by-default-configurable-tolerance.md)); either way, record the Judge's reasoning in the PR as the documented decision.
- **A transient rate-limit / outage** → `--resume`, do not abort.

Under [ADR-0015](../decisions/0015-autonomy-by-default-configurable-tolerance.md), a fully-automated supervisor may merge when the deterministic gates pass and the reasoned decision is recorded; the human is pulled in only by a deterministic-gate trip or a reproduced block.
