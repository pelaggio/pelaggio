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

## Follow-ups (not in this gate)

- **Close the loop on BLOCK** — on a red `review`, trigger
  `autopilot --resume <id> --from implement` with the findings as revision input
  (bounded to one pass). Named by the issue as a separate item.
- **Escalate to two-session finder→verifier** if single-session precision proves noisy.
- **Notifications** — surface a red gate as a park-for-attention alert (issue #34).
