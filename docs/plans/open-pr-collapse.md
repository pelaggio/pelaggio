# Open-PR collapse: dispositions under ADR-0026

Status: **executed 2026-08-07**; retained as the record of what was decided and why.
The forge state below is the snapshot as read *before* execution, at `4a6ac3c` — read the
measurement table as history, not as current state. Execution outcomes are noted inline.

## The measurement

Four PRs are open. **All four are blocked. None is blocked by CI alone.** Every one of
them terminated its review loop at `iterations=1` with breaker `invalid-pass`, and
together they hold **$136.29** of review spend on top of their implementation cost.

| PR | Item | Mergeable | CI | `review` | Agreement | Survivors | Review $ | `autopilot:revised` |
|---|---|---|---|---|---|---|---|---|
| #428 | #277 plan-stage authoring loop | **CONFLICTING** | pass | fail | `invalid` | 1 | 12.00 | **burned** |
| #448 | #367 charter-review gate | mergeable | **fail** | fail | `disagreement` | 14 | 71.06 | available |
| #449 | #444 post-merge reap reconciler | mergeable | pass | fail | `disagreement` | 7 | 44.33 | **burned** |
| #452 | #435 pick-step confinement audit | mergeable | **fail** | pending | `disagreement` | 2 | 8.90 | available |

## The systemic finding: single-iteration termination is by design, and that is the problem

All four PRs terminated at `iterations=1`. An earlier draft of this document blamed
ordering in `evaluateReviewConvergence` and proposed fixing it. **That diagnosis was
wrong**, and the correct one changes the remedy.

Multi-pass convergence is reachable — but only for `consensus-block`. Disagreement and
invalid are *deliberately* terminal, in two independent places in `pr-review-cli.ts`:

```
// :675  Disagreement and invalid are terminal fail-closed (no further iterations).
const terminalSplit = agreement === "disagreement" || agreement === "invalid";
// :685  valid is FORCED false by terminalSplit, which is what makes findings.ts
//       report breaker=invalid-pass
summary: { valid: structuralOk && actualCost <= policy.budgetCap && !terminalSplit, ... }
// :696  and the loop breaks on terminalSplit independently of the convergence verdict
if (decision.state !== "continue" || terminalSplit) break;
```

Reordering `findings.ts` would therefore not run a second pass for any of these four PRs,
and blindly retrying every `invalid-pass` would retry parse-invalid and genuine
disagreement — the cases ADR-0004 and ADR-0026 decision 5 (*omission is never refutation*) require to stay blocked.

The real defect is upstream of the loop: **an infrastructure fault produces
`agreement: invalid`, and `invalid` is deliberately terminal.** #428 is the proof — two
grok infra cells poisoned an otherwise-revisable matrix into a terminal state. ADR-0026
decisions 7-8 fix this at the source by never letting an `unavailable` cause become a
review verdict in the first place; no change to the convergence loop is required or
wanted.

`review.max-passes: 2` is therefore not broken, but it is **inert for the observed PR
population** (3 disagreement, 1 invalid), while `.pelaggio.yml` budgets $120 on the
assumption of two iterations. That budget/behavior mismatch is worth a note, not a ticket.

## Dispositions

### #428 — unstrand. Blocked by infrastructure, not by findings.

The clearest case in the repo for ADR-0026 decisions 7–8. Its six review cells:

```
claude/standard  pass          claude/red-team  pass
codex/standard   pass          codex/red-team   block (findings)
grok/standard    block (infra) grok/red-team    block (infra)
```

Two of six cells are **grok infra faults** — the #434 boot race or #455 balance
exhaustion. They poisoned the matrix to `agreement=invalid`, which forced
`breaker=invalid-pass` at iteration 1 and a `review=FAILURE` status. Under ADR-0026 the
grok cells are `unavailable → indeterminate → retry`, and the surviving signal is one
real codex red-team finding.

It cannot retry: `autopilot:revised` is already burned (#453), so `findRevisablePrs`
partitions it into `labeledStillRed` permanently. **This PR is stranded by precisely the
two defects ADR-0026 names**, which makes it the natural first validation of the fix.

*Disposition:* **rebase, release the entitlement, revise against the real finding, then
re-review.** Reclassifying the grok cells is necessary but not sufficient: the codex
red-team cell carries one genuine surviving finding, and ADR-0026 decision 4 (*judgment, evidence completeness and disposition are distinct*) requires it
to be fixed or validly refuted by an isolated verification — omission is never refutation.
The label release is a one-off human `grant-additional-entitlement`, the clearing
transition decision 9 names. Do not close: the underlying #277 work is wanted.

*Caveat, stated rather than hidden:* #428 is +1009/−293 across 22 files and conflicting
against a main that has moved since 08-04. Rebase cost is real and the re-review is
another ~$12. If the rebase is non-trivial, re-scoping #277 is the better call.

### #449 — land after revision. Blocked by real findings; entitlement wrongly burned.

CI is green, mergeable, 7 real survivors from a genuine `disagreement` (grok passed;
claude and codex blocked). This is the review gate working correctly. But
`autopilot:revised` is burned, so the revision that would clear it cannot run.

*Disposition:* **release the entitlement, revise, re-review — but do not land it armed
before #461.** This PR implements #444, ADR-0026's P5 reconciler template applied. But it
is not merely a reconciler: it calls `git worktree remove`, `branch -D`, and a remote
branch delete, gated on landing-confirmation plus a dirty-tree check and **never on
liveness**. #461's own `## Blocks` section is explicit: *"reap can currently remove a clean
worktree with a live session. Do not land reap armed until this exists; `reap: { enabled:
true }` is the config default (`config.ts:226`), so landing it turns the sweep on for every
run."*

An earlier draft of this document sequenced #449 second and claimed it unblocked #461.
That was backwards and unsafe — it is precisely the "liveness before anything destructive"
rule of ADR-0026 decision 2 (*derived exclusivity is valid only while its authoritative claim remains valid*). Two admissible paths: land #449 with `reap.enabled` defaulted
**off** and arm it only after #461, or hold #449 until #461 lands. The first is preferable
— it banks the reviewed work without arming the hazard — but it is a change to the PR, not
just a merge decision.

### #452 — fix CI, then re-review. Smallest, and it is the derived-exclusivity fix.

Implements #435, which ADR-0026 decision 2 (*derived exclusivity*) names as the canonical broken-derived-
exclusivity case. +231/−32 across 9 files. Only 2 survivors, and only two providers
participated (`claude+codex` — grok absent from the pairing entirely). `review` is
**pending**, not failed: no terminal status was ever posted, so this PR is in the
indefinitely-pending state decision 8 exists to bound.

*Disposition:* **fix the red CI, re-review, land.** Cheapest path to a merged instance of
the model. Its pending-status limbo should be captured as evidence on the #460/#387 drain
work, not treated as a one-off.

### #448 — re-scope, do not revise. Too large to converge.

+2236/−36 across 33 files, red CI, and **14 surviving findings** from a full
`disagreement` at a cost of $71.06 — more than half the total review spend across all
four PRs, for the PR least likely to converge. Its `autopilot:revised` entitlement is
still available, but spending it on a 33-file PR with 14 survivors is the pattern that
produces non-converging series.

*Disposition:* **close the PR, release the claim, keep #367 open, re-charter it smaller.**

The claim release is not optional bookkeeping and is easy to miss: #448's head branch is
`feat/issue-367-add-charter-review-gate-config-driven-ad`, and per `roadmap/git-claim.ts`
**that branch *is* the claim**. Release is branch deletion, owned by ship bookkeeping (which
runs only on landing) or `/tidy` — and closing a PR triggers neither. Close it without
deleting the branch and worktree and #367 reads `already claimed` (CLI exit 3) forever,
with a live worktree: exactly the exit-less state ADR-0026 decision 3 (*blocking state is typed and recoverable*) forbids. So the
disposition is four acts, and **the order matters in two places**:

1. Close the PR.
2. **Remove the worktree first.** Git refuses to delete a branch a worktree has checked
   out (`cannot delete branch used by worktree`). `ship/bookkeeping.ts` and its ordering
   test get this right; an earlier draft of this document had it backwards.
3. Delete the local and remote `feat/issue-367-…` branch.
4. **Remove the `in-progress` label.** Deleting the claim branch does *not* clear it, and
   `github-issues.ts` projects an open issue carrying that label as status `in-progress`,
   which `flow-policy.ts` excludes from `roadmap next`. Only `markDone` removes it, and
   this plan deliberately keeps #367 open — so the issue ends up open, unclaimed, and
   permanently unpickable. There is no sanctioned CLI path for this (no
   `roadmap update-item`; see #473); it currently requires
   `gh issue edit --remove-label in-progress`.

Act 4 is the one that actually strands the issue, and deleting the branch looks like a
complete release without it. **This was missed in execution:** #367 was left `in-progress`
and unpickable until the #463 review gate caught it.

Closing here is a scope decision, not a rejection of the work, and it is the one
disposition that discards completed effort — flagged explicitly for a human call rather
than assumed.

## Sequencing

Safety ordering dominates cost ordering: nothing destructive lands before its liveness
primitive.

1. **#452** — fix CI, re-review, land. Cheapest, no destructive surface, and it lands the
   derived-exclusivity fix (#435).
2. **#449** — release entitlement, revise, re-review, and land **only** with `reap.enabled`
   defaulted off. Banks the reconciler without arming the sweep.
3. **#461** — the liveness *reader*. Not a PR yet.
4. **Wire the reader into every deletion path, then arm.** Flipping `reap.enabled` after
   #461 lands is **not sufficient** and an earlier draft was wrong to imply it was:
   #449's `reapItem` gates only on landing-confirmation plus a dirty-porcelain check, with
   **no liveness call site at all** on `git worktree remove`, `branch -D`, or the
   `--force-with-lease` remote delete. Providing a reader does not gate anything. Arming
   requires a positive P6 verdict wired into candidate reap *and* forced review-worktree
   cleanup first — that wiring is its own work item, not a config flip.
5. **#428** — rebase, release entitlement, revise against the codex finding, re-review.
6. **#448** — human decision on closing and re-chartering #367.

Steps 1–2 land two of ADR-0026's six primitives as working code before any new guard work
starts, without taking on the stale-actor deletion hazard.

## What this does not claim

- Releasing `autopilot:revised` by hand is a **workaround**, not decision 9 implemented.
  It is safe here only because each release is a deliberate human act on a named PR.
  Automating it without the pre-work/post-work split reintroduces the double-revision
  hazard `claimRevision` exists to prevent.
- No disposition above depends on ADR-0026 having landed. All four are executable today;
  the ADR explains *why* they cluster, and #428 is the one whose recurrence the ADR
  prevents.
- Step 2's "default `reap.enabled` off" was a proposed change to PR #449 when this was
  written. It has since been **made**: head `4531520` sets `reap: { enabled: false }`
  citing ADR-0026 decision 2 (*derived exclusivity*), so no author agreement is outstanding.
