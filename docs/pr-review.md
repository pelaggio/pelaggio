# PR review gate — `review` required status check

An automated, **out-of-context** agentic review that runs on every same-repo pull
request and reports a `review` status check. Wired into branch protection alongside
`ci`, it is the enforced second opinion the autonomous recipe
(`ship.target: auto-merge-pr` + branch protection) needs so an unattended run can
never merge on CI-green alone.

It is deliberately **not** the in-pipeline `shakedown-code` review: that pass reviews
the pipeline's own work *in-context*, before ship. This gate is a fresh SDK session
that reads the PR diff cold — the same shape that has caught things the in-context
review missed.

## How it works

1. `.github/workflows/pr-review.yml` triggers on `pull_request`
   (`opened`, `synchronize`, `reopened`, `ready_for_review`) targeting `main`.
2. The single job's id is **`review`** — that string is the required-check context.
   The job **always runs to completion** so the check always reports green or red,
   never perpetual-pending. Fork or draft PRs skip the agent *inside* the job and
   report green (secrets are unavailable to forks; forks can't be autopilot PRs).
3. For a same-repo, non-draft PR the job checks out the head SHA with full history,
   installs deps, and runs `npx @cdhorne/claude-autopilot pr-review --pr <n>`.
4. The CLI runs one bounded, fresh-session review through the same `runStep`
   machinery the pipeline uses (step `pr-review`: budget / turns / effort / model are
   first-class config, see below). The agent's final message is the review; the CLI
   posts it as a single, idempotently-upserted PR comment and sets the exit code.
5. **Exit code = gate = check color.** The CLI exits `0` only on an explicit
   `Verdict: PASS` from a successful run; everything else — `Verdict: BLOCK`, a
   missing verdict, a refusal, an SDK error, max-turns, or a rate-limit park — exits
   `1`. The gate **fails closed**: ambiguity blocks the merge.

## The fail-closed contract

The load-bearing invariant is that the gate can never go green on a phantom sign-off.
Two layers enforce it:

- `runStep` downgrades a refusal / decline to `ok: false`.
- `parseReviewGate(text, ok)` (in `helpers.ts`) returns `block` on `!ok` and on any
  text that is not an explicit `Verdict: PASS`. Unlike `parseVerdict` — which keeps an
  "engaged review ⇒ APPROVE" fail-*safe* so a genuine review that omits the keyword
  still ships — a merge gate has no such fail-safe: a keyword-less-but-engaged review
  **blocks**.

A transient failure (rate limit, flaky SDK error) therefore shows red. Re-run the
workflow once the cause clears — the comment is upserted, not duplicated.

## The review itself

One fresh session, structured as three internal phases (see
`.claude/skills/pr-review/SKILL.md`):

- **Find** — read the diff cold; read every changed file in full at head; over-collect
  candidate findings against the rubric + `CLAUDE.md` invariants.
- **Verify (adversarial)** — switch to a skeptic stance and refute each candidate
  against the actual code; keep only findings that are both **real** and **blocking**
  (ships a bug, breaks a load-bearing invariant, or merges broken code). Style nits and
  speculation are dropped.
- **Report** — the final message is the comment body: short summary, confirmed blockers
  (`file:line` + why + fix), then `Verdict: PASS` or `Verdict: BLOCK`.

The review is **read-only by convention** — the CI checkout is ephemeral, so edits would
never be pushed. The CLI, not the agent, owns comment posting.

### Cost & precision

One session keeps the run inside a small, budget-capped envelope (default `pr-review`
budget `$5`). Precision is the single-session tradeoff: finder and verifier share one
context. If that proves noisy in practice, the escalation is two separate `runStep`
calls (independent finder + independent verifier) — genuinely out-of-context per phase,
but ~2× the cost and needs finding hand-off plumbing. That is deferred until single-session
precision is shown inadequate; this is a v1 gate, not a deep audit.

## Configuration

`pr-review` is a first-class (non-pipeline) step, so its budget / turns / effort / model
are set the same way as any step (see [`config.md`](./config.md)):

```yaml
budgets:      { pr-review: 5 }        # dollars (default 5)
turn-limits:  { pr-review: 60 }       # SDK turn cap (default 60)
effort:       { pr-review: xhigh }    # default xhigh
models:
  profiles:
    standard: { pr-review: claude-opus-4-8 }
    quick:    { pr-review: claude-sonnet-5 }
```

Select the profile with `--profile <name>` (default `standard`).

## Runner & secrets (repo-admin, one-time)

The job runs on **GitHub-hosted `ubuntu-latest`** — deliberately not self-hosted. The
review agent executes PR-influenced code (the CLI runs from the checked-out tree), so
it must run on an ephemeral VM where a malicious PR's blast radius is one comment-scoped
token plus the API key — never on a machine holding real credentials. Hosted runners
are free on public repos.

The workflow needs one secret: `ANTHROPIC_API_KEY`. Use a **dedicated, spend-capped
key** (its own Anthropic Console workspace with a monthly budget), not a personal key —
the cap bounds the worst case if a reviewed PR ever exfiltrates it. Set it with
`gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>` (or an org-level secret to
share one key across repos). Until the secret exists, the gate fails closed: every
same-repo PR reports a red `review` check.

## Branch-protection setup (repo-admin, one-time)

Configuration of branch protection is a **repo-admin action** — it is documented here,
not automated. To make the gate enforced on `main`:

1. Settings → Branches → add / edit the protection rule for `main`.
2. Enable **Require status checks to pass before merging**.
3. Add **`review`** to the required checks (alongside **`ci`**).

With `review` required, `gh pr merge --auto` (the `auto-merge-pr` ship target) waits for
both `ci` and `review` to pass before merging — the enforced out-of-context gate the
autonomous recipe needs.

> A required check must always report. That is why the workflow has **no path filter**
> and skips fork/draft PRs *inside* the job rather than via a job-level `if:` — either
> would leave `review` stuck pending and block every PR forever.

## Closing the loop on BLOCK (issue #60)

A red `review` gate no longer just parks forever. `.github/workflows/pr-review-revise.yml`
triggers on the review workflow's `workflow_run: completed` with `conclusion == failure` and,
**exactly once per PR**, re-implements from the findings and re-pushes so the gate re-runs.

- **Trigger** — `workflow_run` on `"PR review gate"` (the `pr-review.yml` job's `name:`), gated to
  same-repo, non-fork, `feat/issue-*` branches whose linked issue carries the `autopilot` label.
- **One-pass bound** — the workflow adds an `autopilot:revised` label to the PR **before** doing any
  work. On a second red review the label is already present, so the workflow posts a park-for-human
  comment and stops. A per-branch `concurrency` group (`cancel-in-progress: false`, which serializes
  rather than cancels) makes the label check effectively atomic. The label doubles as a **manual kill
  switch**: pre-apply `autopilot:revised` to opt a PR out of auto-revision entirely.
- **Global off-switch** — set the repo Actions variable `AUTOPILOT_AUTO_REVISE` to `false` to disable
  the loop repo-wide (the workflow's job `if:` checks `vars.AUTOPILOT_AUTO_REVISE != 'false'`).
- **The revision seam** — the workflow writes the pr-review findings comment to
  `.dev/review-findings-<id>.md` and runs
  `autopilot --resume <id> --from implement --no-worktree --target pull-request --review-findings <path>`.
  `--review-findings` is a **resume-only** flag: it reads the file best-effort and injects the findings
  into the implement step as revision input (mirroring the plan-shakedown feedback injection). An
  absent/unreadable file never crashes the resume. The `pull-request` ship is idempotent — it skips
  `gh pr create` when a PR is already open and just pushes to the existing branch.
- **PAT push is load-bearing** — commits pushed with the default `GITHUB_TOKEN` do **not** trigger
  `pull_request` workflows (GitHub anti-recursion). The re-review depends on a `synchronize` (push)
  event, so the workflow's `actions/checkout` uses `token: ${{ secrets.GH_TOKEN }}` (a PAT). Without
  it the ship pushes but the loop silently never re-reviews.

Every failure branch terminates: if the revision run itself crashes/parks before pushing, no
re-review fires, the label is already set, and the `if: failure()` step posts a park comment — no
second attempt.

## Follow-ups (not in this gate)

- **Escalate to two-session finder→verifier** if single-session precision proves noisy.
- **Notifications** — surface a red gate as a park-for-attention alert (issue #34).
