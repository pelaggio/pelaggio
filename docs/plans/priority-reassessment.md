# Priority reassessment: is reap the right next primitive?

Status: proposal, pre-decision. Written for provider-diverse review before acting.
Evidence gathered 2026-08-08 from this session's own gate logs and `pelaggio stats`.

## The question

The agreed order was G4 → #474 → #461 → G6b → G5. G4 and #474 have landed. #461 is
three gate passes deep. The question raised: **is reap-and-liveness the highest-value
remaining primitive, given that `/tidy` already does the job with a human in the loop?**

## What reap actually buys

`/tidy` is operator-invoked and never auto-deletes. Run manually earlier today it took
roughly ten minutes of tool calls and:

- reclaimed 7 of 13 worktrees,
- released 4 stranded claims (#277, #367, #435, #462),
- recovered unlanded work in `pelaggio-420` that a blind sweep would have destroyed.

That last point matters for the value calculation: the manual pass **found something an
automated reap would have deleted**. Automation's value here is saving a ten-minute
operator task; its risk is unrecoverable deletion, which is why it needs the entire
apparatus below.

The one observed production cost of *not* having reap is a single `pick:worktree-exists`
failure. Real, but one occurrence, and `/tidy` clears it.

## What the safety apparatus costs

Three rules are needed before reap can run at all, because the liveness reader cannot
answer for unregistered worktrees:

| Population | Precondition |
|---|---|
| Item worktree, session recorded | liveness reader says `dead` |
| Item worktree, no record | claim branch merged into `main`, **CAS-fenced to the verified SHA**, tree clean |
| `.dev/review-heads/<sha>` | owning review finished / SHA ancestor of `main` — a different rule |

Registration is skipped silently — no error — when `dryRun`, when
`worktree === mainRepo`, before `itemId` resolves, or when the branch is not `feat/*`
(which includes **detached HEAD**, and a failed `git branch --show-current` swallowed to
`""`). Of those, only dry-run and detached-HEAD produce a worktree reap would target, but
detached-HEAD is exactly the `.dev/review-heads/` population where the leak is observed.

Spend so far on this line of work: PR #449 accumulated **$87** in review before being
closed with 10 must-fix including a data-loss defect; #477 is at **$57** across three
passes and its corroboration strategy was shown unsound at the root (the controller never
chdirs into the worktree, so `/proc`-cwd scanning can prove presence but never absence).

## What G5 addresses — corrected after review

**The first draft of this section was causally wrong and its headline number should not be
reused.** It claimed G5 "addresses 93% of measured gate spend". All three reviewers
rejected it, correctly.

| Outcome | Runs | Spend | Share |
|---|---|---|---|
| `consensus-pass` | 2 | $23.82 | 6.7% |
| `disagreement` | 11 | $330.79 | 93.3% |
| **Total** | **13** | **$354.61** | |

Those figures are accurate. The inference was not. Every one of the 11 runs is
`agreement=disagreement` — **real findings split across drivers**, not infrastructure
faults. `computePrReviewAgreement` maps infra to `invalid`, not `disagreement`; G5
reclassifies only *unavailable* causes; and under ADR-0026's own aggregation rule 1 a
surviving blocker still resolves to `block`. So G5 would not have made this population
converge or avoided its first-pass spend. **93.3% is a bucket share, not G5's addressable
share.**

Worse, the draft revived the `max-passes`-inertness framing that `open-pr-collapse.md` and
`ticket-collapse.md` both explicitly **withdrew as a misdiagnosis** earlier in this same
session, without citing the withdrawal. `terminalSplit` makes disagreement terminal *by
design*; that was settled and should not have been re-litigated as headline evidence.

What G5 genuinely addresses is narrower and still real: **#428**, where two grok
infrastructure cells poisoned an otherwise-revisable matrix into `agreement: invalid` and
the PR could never be revised against. That is one measured PR, not 93% of spend.

## Prerequisites the first draft omitted

- **G2 (#465), settle-observed quota**, is a hard prerequisite of G5's minimum shippable
  unit per ADR-0026 decision 6 (*a retryable outcome is bounded and actionable*) and `ticket-collapse.md`. It is open, unstarted, and has no
  code in the tree. "Do G5 next" was not executable as written.
- **#461 is already on G5's critical path**, not merely G6b's. ADR-0026's *a time lease is not liveness* constraint requires
  every reconciler's crash-reclaim to be gated by a positive P6 liveness verdict, and G5
  ships the local queue reconciler as its retry actor. `ticket-collapse.md` states
  "Depends on #461 (liveness) too" and places it on the critical path in its diagram. The
  draft framed this as an open contingency when it was already settled *against* the
  recommendation.
- **A reader that never returns `dead` satisfies nobody.** The draft scoped #477 to
  "`live`/`unknown` when a record exists, `unknown` on absence", dropping `dead` entirely.
  Decisions 3 and 4 require a *positive* `dead` verdict before reclaim, so as written it
  would have had no consumer even under G6b. (The implementation does return `dead` for an
  expired record with no live process; the writeup lost it, which would have misled an
  implementer.)

## Corrected recommendation

1. **Finish #461 and land it, with `dead` reachable for recorded sessions.** It is not
   deferrable: it gates G5, not just G6b. Recorded-and-expired plus no live process inside
   → `dead` is achievable; only the *unregistered* population is unanswerable, and that is
   G6b's git-level rule, not this reader's job.
2. **G2 (#465)** — settle-observed quota. G5's stated prerequisite.
3. **G5 (#468)** — gate disposition, scoped honestly to what it fixes (#428's shape,
   infra-poisoned matrices), not to the whole disagreement bucket.
4. **G6b (reap) stays deferred.** That conclusion survives, but on different grounds than
   the draft gave: `/tidy` covers the need with operator judgment — it recovered unlanded
   work in `pelaggio-420` that an automated sweep would have destroyed — and reap needs a
   three-rule apparatus that has already consumed $144 without becoming sound.

## Three rules for reap, whenever G6b happens

| Population | Precondition |
|---|---|
| Item worktree, session recorded | liveness reader says `dead` |
| Item worktree, no record | claim branch merged into `main`, **CAS-fenced to the verified SHA**, tree clean |
| `.dev/review-heads/<sha>` | owning review finished / SHA ancestor of `main` — a different rule |

Registration is skipped silently — no error — when `dryRun`, when
`worktree === mainRepo`, before `itemId` resolves, or when the branch is not `feat/*`
(including **detached HEAD**, and a failed `git branch --show-current` swallowed to `""`).
Of those, only dry-run and detached-HEAD produce a worktree reap would target — and
detached-HEAD is exactly the `.dev/review-heads/` population where the leak is observed.
