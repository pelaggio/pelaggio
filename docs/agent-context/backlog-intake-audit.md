# Backlog intake audit (2026-08-27)

**(instrumentation, complete — nothing here is a gate)**

An audit of the 198 open roadmap items against the repo's own intake criteria: the `/charter`
normalization probes (`.claude/skills/charter/SKILL.md`), the acceptance-anchor and
assumption-ledger grammar in [`charter-contract.md`](./charter-contract.md), and the one
structural precondition neither of those states — that an item carry the roadmap pickup label
`.pelaggio.yml` configures, or no scheduler will ever see it.

**This audit proposes no intake gate.** [ADR-0011](../decisions/0011-andon-not-dor.md) decided
against a Definition-of-Ready gate, and [`throughput-economy.md`](./throughput-economy.md)
refuted the check-ratchet for this repo. Every signal below is report-only: `ci/backlog-audit.ts`
exits 0 and prints a table. An empty charter is a refinement candidate, never a closure warrant.

## 1. Method and pin

The tracker is mutable — titles, bodies, labels and state all move — so a live re-run reproduces
none of these numbers. Following [`review-gate-baseline.md`](./review-gate-baseline.md), the
committed evidence is the **derived signal set plus a corpus fingerprint**, not the charter
bodies it came from:
[`data/backlog-signals-2026-08-27.json`](./data/backlog-signals-2026-08-27.json), corpus
**`423:ced7d044cf7a`** (423 issues, PRs excluded; 198 open, 225 closed).

```bash
node --import tsx ci/backlog-audit.ts                        # report the pinned snapshot
node --import tsx ci/backlog-audit.ts --issues <dump.json>   # recompute live, report drift vs the pin
```

Five signals, each a deterministic property of the item's own text or of the tracker's own state.
None reads a model's judgment.

| Signal | Definition | Open items |
|---|---|---|
| **empty charter** | body minus the `Depends on:` / `Scope:` preamble is under 120 chars — the title is the whole spec | **38 (19%)** |
| **no acceptance evidence** | no Acceptance/Evidence heading, unchecked box, `AC-n` anchor, or `verify:` binding | **138 (70%)** |
| **unpickable** | open but missing the `autopilot` pickup label | **6 (3%)** |
| **unblocked, still parked** | declares dependencies and every one is now closed | **34 (17%)** |
| **legacy vocabulary** | cites an identifier that did not survive the autopilot → pelaggio rename | **6 (3%)** |

## 2. The dead-letter queue: six items no scheduler can see

`.pelaggio.yml` sets `roadmap.github.label: autopilot`. Six open items lack it, so `/pick` has
never been able to surface them and never will:

| # | Labels | Age | Status |
|---|---|---|---|
| #64 | `autopilot:fix` | 51d | live defect, verified below |
| #70 | `autopilot:fix` | 51d | live gap, verified below |
| #153 | `enhancement` | 49d | epic over #154/#155/#157 |
| #154 | `enhancement` | 49d | live gap, verified below |
| #155 | `enhancement` | 49d | live gap, verified below |
| #624 | *(none)* | 4d | active campaign, 8 comments |

This is not the "three unlabelled issues" #521 chartered. Those three (#345, #354, #359) have
since been labelled — **#521 item 1 is complete**. The population that remains is a different
failure: not *missing* labels but the *wrong* ones. `autopilot:fix` and `enhancement` look like
real labels, and both name real work; neither is the configured pickup label. An item can be
well-chartered, correct, and permanently invisible.

**Three of the six describe gaps that are still live in today's code.** Each was checked against
the tree at `c05603a`, not taken from the charter's own claim:

- **#70 — "run the judge from the base ref, not the PR tree."**
  `.github/workflows/pr-review.yml:63` still checks out `github.event.pull_request.head.sha`, and
  line 109 runs `npx pelaggio pr-review` from that tree. A same-repo PR still supplies the CLI,
  the skill body and the rubric that judge it. **Dormant in this repo** — `pr-review-ci` is gated
  off by `if: vars.AUTOPILOT_REVIEW_RUNNER != 'local'` and the local sweep posts the status
  instead — but the workflow ships, and CI-mode review is the documented, unactivated path
  (`docs/pr-review.md`). Flipping that repo variable arms the gap.
- **#154 — TC-017 protected-path lock.** `classifySecurityReviewDiff`
  (`packages/pelaggio/scripts/pelaggio/helpers.ts:743`) carries `SECURITY_PATHS`, but its own
  doc comment is explicit: *"This is not a scanner; it only decides whether the diff is
  security-sensitive enough to spend a second model session."* #154 asks for exactly the
  opposite — a protected-path change as a **blocker**, not a review trigger. No
  `protectedPath` / crown-jewel implementation exists anywhere in the tree.
- **#155 — TC-018 per-step capability profiles.** `step-runner.ts:479` is still
  `canUseTool: async (_tool, input) => ({ behavior: "allow" })`. The capability seam that landed
  (#337, ADR-0020) is a *provider* capability descriptor — what a driver can natively do — not a
  per-step tool profile. Different mechanism, same word.
- **#64** — `markDoneUnlocked` (`roadmap/markdown.ts:156`) still throws for an item that exists
  only in the task index, exactly as filed. `/pick` still serves those items. The markdown
  adapter is not this repo's configured source, so the defect is a consumer-facing one.

### 2.1 Both trust-claim ids are now double-booked

#521 flagged that TC-017 named two live things. Since then it has become two collisions, not one:

| id | `docs/trust/trust-claims.yml` | open issue |
|---|---|---|
| TC-017 | contained egress broker — `status: guarantee`, `last_verified: 2026-07-19` | #154 "TC-017: protected-path lock" — never built |
| TC-018 | Claude-seat Bubblewrap isolation — `status: guarantee`, `last_verified: 2026-08-18` | #155 "TC-018: per-step capability profiles" — never built |

Under trust-by-falsifiability this is the worst available failure mode: the registry reads
`guarantee` on both ids while the controls the issues name are unbuilt, and `ci/verify-doc-claims.ts`
scans only `docs/trust/`, so it cannot see the collision. #521 recorded that blind spot
deliberately and put extending the scanner to issue bodies explicitly out of scope. That still
holds — the fix is renumbering the issues, not widening the scanner.

## 3. Empty charters are a legacy stock, not a live intake defect

38 open items (19%) have no charter body at all. But the open set is a survivorship sample —
closure removes the well-specified items faster — so the signal has to be read against **every
item ever filed**:

| period | filed | empty | empty % | acceptance % |
|---|---|---|---|---|
| 2026-07-H1 | 123 | 25 | 20% | 17% |
| 2026-07-H2 | 72 | 25 | **35%** | 17% |
| 2026-08-H1 | 110 | 21 | 19% | 15% |
| 2026-08-H2 | 111 | 10 | **9%** | **46%** |

Intake quality is improving sharply and recently: empty charters fell from 35% to 9%, and the
acceptance-evidence rate roughly tripled in the last two weeks — the period in which the
charter-contract and shadow-graph work landed. **The 38 empty charters are a stock accumulated
mostly in July, not a rate the system is still producing.**

That distinction decides the response. A live defect would argue for changing how items are
filed; a stock argues for refining what is already filed, which is what §5 does. It also means
the 70% no-acceptance-evidence figure is a **baseline, not a violation count**: the `AC-n` /
`verify:` grammar is design (`charter-contract.md`), lint-not-gate by its own terms, and not
shipped. Nothing filed before it existed was required to carry it.

## 4. Null and negative results

Recorded because they bear on three open detector items, and a null is cheaper to publish than
to rediscover:

- **No lexical near-duplicates.** Pairwise Jaccard over open-item title tokens returns **zero**
  pairs at ≥0.45. The one true duplicate pair found by hand — #261 and #265, both
  "wire run-contained into the verify step", filed 26 minutes apart, both with empty bodies — is
  *semantic*, not lexical: the titles share almost no vocabulary. This is direct evidence about
  **#531** (duplicate-claim detector, exact tier): the exact tier would have caught nothing in
  this corpus. That is not an argument to build a fuzzier tier; it is an argument that the tier
  #531 proposes is not where this backlog's duplication lives.
- **Path-citation drift needs two distinctions before it is usable.** A naive "does this cited
  path exist" check fires on 33 open items; resolving repo-relative suffixes drops that to 18,
  and of those the large majority are **forward citations** — paths the item proposes to *create*
  (`ci/verify-adr-shape.ts`, `ci/reap-test-tmp.ts`, `docs/agent-context/revision-loop.md`) — or
  gitignored runtime state (`.dev/*`). The genuine-drift residue is the 6 legacy-vocabulary items.
  **#530** (citation-drift detector) has to separate created-path from cited-path and tracked from
  runtime, or it ships as a ~70%-false-positive check. That is the finding, and it is why this
  audit does not ship a path-drift signal.
- **34 items are unblocked and nobody recomputed it.** Every declared `Depends on:` target has
  closed — #559–#562, #565, #567, #572 all waiting on #557 (closed); #379–#381 on #188; the
  contained-execution cluster #261–#266 and #273 on #257/#260. 21 of the 34 are also `deferred`.
  Nothing in the harness recomputes readiness when a dependency closes, so a parked item stays
  parked on a reason that expired. This is the concrete, already-earned case for **#296**
  (readiness as a computed FlowPolicy verdict) — it does not need the full INVEST projection to
  pay for itself, only the closed-dependency sweep.

## 5. What was executed

- `ci/backlog-audit.ts` + `ci/__tests__/backlog-audit.test.ts` — the report-only instrument, with
  no-false-fire tests on the two signals most likely to over-fire: `autopilot` as live vocabulary
  (the label and the run mode are current, only renamed package/path ids are drift), and prose
  that discusses acceptance without offering an acceptance surface.
- `data/backlog-signals-2026-08-27.json` — the pinned derived snapshot at `423:ced7d044cf7a`.
- This document.

## 6. What was deliberately not executed

- **No bulk close.** `throughput-economy.md` §5 already refused this once, on two grounds that
  both still hold: `deferred` is a park mechanism and not a graveyard, and `npx pelaggio roadmap`
  exposes no close subcommand — only `mark-done`, which asserts completion. Closing 38 empty
  charters as `not_planned` would assert a judgment this audit has not made about any of them.
  Typed closure reasons are **#519**.
- **No relabelling of the six unpickable items.** Adding `autopilot` to #154 or #155 does not
  merely make them visible — it makes them *claimable by an unattended cycle*, and #154 is a
  security control whose own charter says it will block legitimate self-modification work. That
  is an operator decision about queue contents, not a hygiene edit. #521 chartered this exact
  class as OPERATOR-EXECUTED for the same reason.
- **No intake gate, of any kind.** See §0.
- **No detector for the six-item unpickable population.** #521's reasoning applies unchanged: the
  population is small and finite, so fix the data, not the tooling.

## 7. What would falsify this

- **§3's stock-not-flow reading.** It rests on two half-months. If 2026-09 returns to a
  20%+ empty rate, the improvement was the charter-contract work being *written*, not a durable
  change in how items are filed, and the response should shift from refinement back to intake.
- **§2's live-gap verifications.** Each is a point-in-time grep against `c05603a`. If #154's
  control turns out to exist under a name this audit did not search for, that finding collapses —
  the search was `protectedPath`, `protected_path`, `crown.?jewel`, and a read of every
  `SECURITY_PATHS` caller.
- **The empty-charter threshold.** 120 characters is a judgment, not a measurement. A charter of
  119 characters that names an outcome would be miscounted; the signal was checked by reading all
  38 hits, and every one is either a bare `Depends on:` / `Scope:` pair or an empty body, so the
  threshold is not currently load-bearing. It would become load-bearing on a corpus with more
  terse-but-real charters.
- **§4's duplicate null.** Title-token Jaccard is one similarity measure over one field. A body-text
  or embedding measure could find duplication this did not. The null is scoped to the exact tier
  #531 proposes, by construction.
