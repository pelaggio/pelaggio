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

## Runner modes

The required `review` context is **always a commit status** — posted by exactly one
runner. `review.runner` selects which:

- `ci` (default): `.github/workflows/pr-review.yml` runs the `pr-review` CLI in
  GitHub Actions and posts the `review` **commit status** (pending → success/failure)
  for the PR head SHA.
- `local`: a normal local pelaggio auto-pick run sweeps open PRs before revise,
  runs the same `pr-review` step from the trusted local tree, and posts the `review`
  **commit status**.

**Branch protection: require the `review` _status_ context, not a check named
`review`.** No workflow job is named `review` (the CI job is `pr-review-ci`) precisely
because GitHub scores a *skipped* required-check job as success — so a job named
`review` gated off in local mode would silently green the gate (fail-open). Keeping
`review` a status posted only by the active runner closes that: before the runner
posts, the context is absent and merge is blocked (fail-closed-by-absence). Verify with
`gh api repos/{owner}/{repo}/commits/{sha}/status` (the `review` status) and
`.../check-runs` (should contain no check-run named `review`).

Local mode is deliberately trusted-tree: the CLI, skill, parser, rubric, and status
posting code run from local `main`; the PR head is fetched only as diff/file data.
Set the repo variable `AUTOPILOT_REVIEW_RUNNER=local` so the CI workflow leaves only
a diagnostic comment and does not execute review tooling from the PR branch. The
local `gh` auth needs permission to write commit statuses (`statuses: write`) and PR
comments.

## CI runner flow

1. `.github/workflows/pr-review.yml` triggers on `pull_request`
   (`opened`, `synchronize`, `reopened`, `ready_for_review`) targeting `main`.
2. The job id is **`pr-review-ci`** (deliberately *not* `review`). It posts the
   `review` **commit status** for the head SHA: `pending` before the agent runs, then
   `success`/`failure` after. The required-check context is that status, so the gate
   reports green or red and is never left perpetual-pending. Fork or draft PRs skip the
   agent and post a green `review` status (secrets are unavailable to forks; forks
   can't be pelaggio PRs).
3. For a same-repo, non-draft PR the job checks out the head SHA with full history,
   installs deps, and runs `npx pelaggio pr-review --pr <n>`.
4. The CLI reads the changed file list and diff, then runs one bounded, fresh-session
   standard review through the same `runStep` machinery the pipeline uses (step
   `pr-review`: budget / turns / effort / model are first-class config, see below).
   If the deterministic classifier sees security-sensitive paths or diff keywords, the
   CLI runs a second fresh `pr-review --red-team` session before deciding the gate.
   The CLI posts both pass outputs as one idempotently-upserted PR comment and sets the
   exit code.
5. **Exit code = gate = posted `review` status.** The CLI exits `0` only on an explicit
   `Verdict: PASS` from every required pass; everything else — `Verdict: BLOCK`, a
   missing verdict, a refusal, an SDK error, max-turns, a rate-limit park, or inability
   to inspect the diff — exits `1`. The workflow's final step translates that exit code
   into the `review` commit status (`0` → success, else failure), and posts `failure`
   if the job is cancelled after starting. The gate **fails closed**: ambiguity blocks
   the merge, and a crash before the final step leaves the earlier `pending` status.

## The fail-closed contract

The load-bearing invariant is that the gate can never go green on a phantom sign-off.
Two layers enforce it:

- `runStep` downgrades a refusal / decline to `ok: false`.
- `parseReviewGate(text, ok)` (in `helpers.ts`) returns `block` on `!ok` and on any
  text that is not an explicit `Verdict: PASS`. Unlike `parseVerdict` — which keeps an
  "engaged review ⇒ APPROVE" fail-*safe* so a genuine review that omits the keyword
  still ships — a merge gate has no such fail-safe: a keyword-less-but-engaged review
  **blocks**.

A transient failure (rate limit, flaky SDK error) therefore shows red. If a security
diff triggers the red-team pass and that pass cannot complete, the whole gate blocks
even if the standard pass found no issues. Re-run the workflow once the cause clears —
the comment is upserted, not duplicated.

## The review itself

The standard review is one fresh session, structured as three internal phases (see
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

### Adversarial red-team pass

Security-sensitive diffs get a second independent pass. The classifier is deterministic
and conservative: it triggers on security-adjacent paths such as `.github/workflows/**`,
server auth/config/app files, pelaggio step runners, ship/roadmap tooling, and review /
ship / implement skills; it also triggers on diff text containing terms such as `auth`,
`token`, `secret`, `host`, `loopback`, `127.`, `localhost`, `fetch`, `exec`, `spawn`,
`shell`, `workflow`, `prompt injection`, `ANTHROPIC_API_KEY`, `GH_TOKEN`, or
`CONTROL_PLANE_TOKEN`.

The red-team mode assumes the change is wrong and tries concrete bypasses and fail-open
paths: hostname tricks like `127.example.com`, IPv6 loopback, wildcard binds, malformed
URLs, empty env vars, mixed-case headers, missing tokens, shell/path/cwd injection,
prompt-injection influence over commands, token exposure, workflow permission broadening,
fork/draft behavior, and checks that can report green without running. It still blocks
only on confirmed findings with `file:line` evidence; vague risk does not satisfy the
gate.

If the classifier does not trigger, the PR comment records that the red-team pass was
not run. If it does trigger, both the standard and red-team sections appear in the single
gate comment. Either pass can block, and both passes run even if the standard pass has
already blocked so the revise loop receives all confirmed findings. A triggered run costs
roughly twice a normal review because it spends a second `pr-review` session using the
same budget / turns / model profile.

### Evidence marker

**How to aggregate.** The gate job runs on ephemeral GitHub-hosted `ubuntu-latest` with a
`contents: read` token — it cannot write a log file that survives the runner, and it must
not commit. The durable, zero-write-permission sink is the **PR comment** the CLI already
upserts: each carries a machine-readable marker as its final line —

```html
<!-- pr-review-metrics gate=block ok=true subtype=success cost=1.23 turns=42 -->
```

Recording `ok`/`subtype` is the disambiguation `gh run list` **cannot** provide: a red
job conclusion conflates a real `Verdict: BLOCK` with a fail-closed transient (rate-limit
/ max-turns / refusal). Precision is only about the former, so filter to
`ok=true subtype=success` first. Enumerate the markers across recent PRs with:

```bash
# Pull the pr-review-metrics marker from every recent PR's gate comment.
gh pr list --state all --limit 50 --json number --jq '.[].number' |
  while read -r n; do
    gh pr view "$n" --json comments \
      --jq '.comments[].body | capture("(?<m><!-- pr-review-metrics [^>]*-->)").m // empty'
  done | grep 'ok=true subtype=success'   # clean runs only — the precision-relevant set
```

For multi-pass runs, the marker records aggregate `gate`, aggregate `ok`, summed cost /
turns, and a subtype that identifies the blocking pass (`standard:<subtype>`,
`red-team:<subtype>`, `multiple`, or `success`).

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

For local subscription review with Codex, configure the poster and provider separately:

```yaml
review:
  runner: local
  statusless-after: 2h

models:
  profiles:
    standard:
      providers:
        pr-review: codex
      codex:
        pr-review: gpt-5-codex
```

When a local-mode PR has no `review` status for longer than `statusless-after`, the
orchestrator posts the local-mode diagnostic comment and emits the
`review-stranded` notification event if notifications are enabled.

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

## Closing the loop on BLOCK (issue #60 / #76)

A red `review` gate no longer just parks forever — it triggers **one** automated revision that
re-implements from the findings and re-pushes so the gate re-runs. The direct human/external entry
point is:

```bash
pnpm pelaggio --resume <id> --review-findings path/to/findings.md
```

When `--review-findings` is present, `--resume` defaults to the `implement` step so the revision
cannot auto-detect a later restart point and skip the findings. An explicit valid `--from` still wins
for advanced recovery.

There are **two** automated paths that use this same seam, the same one-pass bound (the
`pelaggio:revised` PR label), and the same handoff marker (`<!-- pelaggio-revise-parked -->`):

| Path | Runs on | Funded by | Trigger | Status |
|---|---|---|---|---|
| **Local sweep** (issue #76) | your local runner, in-process | your Claude **subscription** | orchestrator, at the start of an auto-pick `--cycles` run | **active** (this repo) |
| **CI workflow** (issue #60) | GitHub-hosted `ubuntu-latest` | the metered `ANTHROPIC_API_KEY` | `pr-review-revise.yml` on `workflow_run: failure` | present but **disabled** repo-wide |

Only one should be active at a time to avoid both racing for the label. On this repo the CI workflow
is the documented API-funded *alternative* — it is turned off (`AUTOPILOT_AUTO_REVISE=false`, no
`GH_TOKEN` PAT) so the local sweep is the sole active reviser. A repo without a local runner enables
the CI workflow instead (set the variable + PAT) and leaves `revise.local` moot (its markdown /
non-PR-target case is a no-op anyway).

### Local sweep (issue #76) — active

Gated on `revise.local` (default `true`; see [docs/config.md](./config.md#local-revise-sweep)), the
orchestrator sweeps for revisable red-review PRs **before** the pick worker pool and revises each one
**in-process** on the local subscription — no metered API key, no CI VM. It is a hard no-op unless the
run is `roadmap.source: github-issues` + a PR ship target + pure auto-pick mode (`--cycles`, no
`--item` / `--resume` / `--no-worktree` / `--dry-run`).

- **Trigger** — start of a normal `--cycles` run. One `gh pr list` finds open, non-draft,
  `feat/issue-<n>` PRs whose `review` check-run concluded `FAILURE`.
- **One-pass bound** — the shared `pelaggio:revised` label, added **before** any work
  (`claimRevision`). Labeled-still-red PRs are filtered out of the candidate set and get one
  idempotent human-handoff comment instead. The label doubles as a manual kill switch and its
  absence gates the revise, exactly as in CI.
- **Reuses the resume plumbing** — each revision runs with a `--review-findings` file fetched from
  the PR-review comment. Findings imply `startFrom: "implement"` unless the caller explicitly passes
  `--from`, so parking, notifications, cost accounting, and the ship target all apply for free.
  Revisions don't consume `--cycles` but do count toward `--budget`.
- **Findings survive a park** — the findings file is written under `.dev/` (gitignored). If a revision
  parks and later auto-resumes, `resumeOne` re-injects the on-disk findings so the resumed implement
  still fixes the specific blockers.
- **Fail-soft** — any `gh`/git error in the sweep logs a warning and skips (that candidate or the whole
  sweep); the normal pick loop proceeds regardless.
- **Cross-process atomicity** (local vs a re-enabled CI) is out of scope: it is safe only because CI is
  disabled repo-wide, so local is the sole active reviser. Re-enabling CI while the local sweep runs is
  unsupported.

### CI workflow (issue #60) — API-funded alternative

A red `review` gate can instead be closed in CI: `.github/workflows/pr-review-revise.yml`
triggers on the review workflow's `workflow_run: completed` with `conclusion == failure` and,
**exactly once per PR**, re-implements from the findings and re-pushes so the gate re-runs.

- **Trigger** — `workflow_run` on `"PR review gate"` (the `pr-review.yml` job's `name:`), gated to
  same-repo, non-fork, `feat/issue-*` branches whose linked issue carries the `pelaggio` label.
- **One-pass bound** — the workflow adds an `pelaggio:revised` label to the PR **before** doing any
  work. On a second red review the label is already present, so the workflow posts a park-for-human
  comment and stops. A per-branch `concurrency` group (`cancel-in-progress: false`, which serializes
  rather than cancels) makes the label check effectively atomic. The label doubles as a **manual kill
  switch**: pre-apply `pelaggio:revised` to opt a PR out of auto-revision entirely.
- **Global off-switch** — set the repo Actions variable `AUTOPILOT_AUTO_REVISE` to `false` to disable
  the loop repo-wide (the workflow's job `if:` checks `vars.AUTOPILOT_AUTO_REVISE != 'false'`).
- **The revision seam** — the workflow writes the pr-review findings comment to
  `.dev/review-findings-<id>.md` and runs
  `pelaggio --resume <id> --no-worktree --target pull-request --review-findings <path>`.
  `--review-findings` is a **resume-only** flag: it reads the file best-effort and injects the findings
  into the implement step as revision input. With no explicit `--from`, it routes the resume to
  `implement`; an absent/unreadable file never crashes the resume. The `pull-request` ship is
  idempotent — it skips `gh pr create` when a PR is already open and just pushes to the existing
  branch.
- **PAT push is load-bearing** — commits pushed with the default `GITHUB_TOKEN` do **not** trigger
  `pull_request` workflows (GitHub anti-recursion). The re-review depends on a `synchronize` (push)
  event, so the workflow's `actions/checkout` uses `token: ${{ secrets.GH_TOKEN }}` (a PAT). Without
  it the ship pushes but the loop silently never re-reviews.

Every failure branch terminates: if the revision run itself crashes/parks before pushing, no
re-review fires, the label is already set, and the `if: failure()` step posts a park comment — no
second attempt.

## Follow-ups (not in this gate)

- **Notifications** — surface a red gate as a park-for-attention alert (issue #34).
