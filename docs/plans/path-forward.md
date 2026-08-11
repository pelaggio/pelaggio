# Path forward: refactor — and not the refactor the prior session proposed

Status: proposal, pre-decision. Measured 2026-08-08 at `54fc61e`.
Supersedes the *conclusions* of `rebuild-plan.md`; its guard audit and transfer list survive
and are carried forward in Part 5.
Revision 2 — nine must-fix findings from `npx pelaggio doc-review` are applied; the
substantive ones changed Part 6's recommendation, not just its numbers.

## Summary

The prior session asked for two measurements before anyone proposed anything. Both are done.
Neither needed the campaign that was budgeted for them, and **both change the answer**:

1. **Park causes were recoverable from data already on disk** — no campaign, $0. All 22 August
   parks are located, and 10 of 22 carry a verbatim recorded reason. They are not
   unattributable, and they are **not in the code a rebuild would discard**.
2. **All three drivers are calibrated on root invariants** — $1.02. The three-driver fan-out is
   three calibrated reviewers, not one plus two guessing. But **no driver knows any routed-doc
   fact**, which is exactly the narrower mechanism `coherence-audit.md` corrected itself into.

Together they knock out two of the rebuild case's three pillars. The third — 87% of
`pipeline.ts` in two functions — is verified, real, and is a **refactor** argument. So:
**refactor.** The highest-value work, however, is not the decomposition; it is a small typed-
disposition gap in the review loop where a fail-closed hard gate is currently laundered into a
recoverable park.

---

## Part 1 — Measurement 1: park causes, recovered for $0

The instruction was to run a campaign until 20+ parks accrued with causes. At August's rate
(22 parks / 84 cycles, $13.6/cycle) that is ~77 cycles and **~$1,050**. It was not necessary.
Cause is recoverable three ways from artifacts already in the tree:

1. **Step position.** Every cycle record carries `steps[]` with per-step `name`, `ok` and
   `subtype`. The `parkReason` field is null on all 22 — but the step the cycle died in is not.
2. **Retained console logs.** `.dev/supervised-run-*.log` (14 files, 2,156 lines) contain the
   park banner *with its reason string*, printed at park time.
3. **Call-site enumeration.** Every `parkExit()` call site that passes a reason
   (`pipeline.ts:1524-1755`) is inside one block.

### What they say

**All 22 August parks occurred in the adversarial authoring-review loop.** Not one occurred in
`pick`, `plan`, `shakedown-plan`, `implement`, `shakedown-code` or `ship`. The loop's reviewer
seats are logged under the step name `pr-review` and its Judge under `pr-verify`
(`pipeline.ts:1615`), so these are ADR-0024 *authoring* seats inside `shakedown-code` — not the
merge gate.

**Of the 22, 10 have their reason recovered verbatim. All ten read the same string:**

```
⏸ parked (adversarial review hard-block)
```

The other 12 are from campaigns whose console logs were not retained; their record shape is
identical (last step `pr-review`/`pr-verify`, `error: "parked"`). Every reasoned `parkExit()`
call site is in that same block, so the *class* is established for all 22 by construction,
independently of log retention.

### The breakdown that matters

The table below partitions the 22 exactly; spend is each cycle's `total_cost`. The dividing
evidence is **how far the review got**, read from the step sequence — did any seat complete, and
did a Judge (`pr-verify`) return a verdict.

| | How far the review got | Cycles | Spend | Detail |
|---|---|---|---|---|
| **A** | **No reviewer seat completed** — 365, 387, 435 | 3 | $43.90 | `review/loop.ts:276` returns `hard-block` when no seat is `ok`. Two `error_confinement`, one Codex 400 (`'gpt-5-codex'` unsupported on a ChatGPT account) |
| **B** | **A seat ran, panel crashed before a verdict** — 43, 389 | 2 | $15.56 | `error_confinement` in the second seat (43) and in the Judge itself (389) |
| **C** | **No Judge step: pre-Judge split, or parse-invalid** — 82, 386, 277, 437 | 4 | $103.35 | Three are a genuine reviewer split, which ADR-0024 parks **before** the Judge by design; one (437) emitted unfinished prose with no findings block — parse-invalid, which ADR-0004 blocks by design |
| **D** | **Judge returned a verdict, findings survived** | 13 | $238.28 | The loop working as designed. Includes 403 and 421, whose `pr-review` cell died with `error_sdk` but whose Judge still ran and ruled |
| | **Total** | **22** | **$401.09** | |

**A + B — 5 parks, $59.46, 15% of park spend — are a crash reported as a review verdict.**
**C + D — 17 parks, 85% of park spend — are the gate working as specified**: real must-fix
findings (D), ADR-0024's deterministic pre-Judge split gate (three of C), and ADR-0004's
parse-invalid block (one of C). Most parks are not a defect.

Two earlier drafts got this partition wrong in both directions, so the evidence rule is stated
above and applied uniformly. Draft 2 put 403/421 in a "degraded panel, causation not provable"
row — wrong: both records end `pr-review!error_sdk → pr-review(ok) → pr-verify(ok)`, so the
Judge ruled. Draft 3 then folded all of C into the completed-review row — also wrong: none of
those four has a `pr-verify` step at all. They are their own category, and it is a *designed*
one, not a crash.

### The parks are expensive delay, not lost work

Parks cost **$401 — 35% of August spend**. Of the 17 distinct items that parked:

- **12 completed a later cycle after their last park**, inside the measured window.
- **4 more (386, 387, 437, 444) end the window parked but are now closed issues** — the work
  landed after 2026-08-05, outside the log.
- **1 (#435) is still open.**

Five items parked twice, costing $75 in repeat cycles. So the cost is re-run spend and operator
latency; no deliverable was lost. That is materially less alarming than "the system stopped a
quarter of the time".

### Correction to `rebuild-plan.md`

> "22 of 22 parks have no recorded cause … we cannot say why the system stopped a quarter of
> the time." — and, in Part 5, "run a campaign and let 20+ parks accrue with causes … Without
> this the largest failure category stays unmeasurable."

**Withdrawn.** `parkReason` is null on all 22; the *cause* is not. The document inferred from
one missing field that the category was unmeasurable, without checking `steps[]` — which is in
the same JSON object — or `.dev/supervised-run-*.log`, which is in the same directory. The
proposed remedy was a ~$1,050 campaign for information already on disk.

### The throughput picture, restated

| Window | Cycles | Done | Parked | Spend | $/shipped | Authoring loop |
|---|---|---|---|---|---|---|
| Jul 14–17 | 31 | 23 (74%) | 0 | $267 | $12 | **absent** — `shakedown-code` step, $79 |
| Aug 3–5 | 84 | 38 (45%) | 22 | $1,145 | $30 | **every cycle that got that far** — $304 |

The loop landed in `a6904c5` on **2026-07-19**, between the two campaigns. `shakedown-code` last
appears as a step on 2026-07-17; the first `pr-review` step is 2026-08-03T05:29Z. So the
July/August boundary is exactly the loop's on/off boundary.

**This is a correlation with a mechanism, not an isolated cause, and it must not be read as
more.** 94 commits landed between the two campaigns, and August's work is intrinsically harder.
Within August, cycles that reached the loop completed at 50% versus 38% for those that did
not — which is survivorship, not evidence the loop helps: cycles that fail in `implement` never
reach it. What *is* mechanistic and certain is the park attribution: parks were structurally
impossible in July because no reasoned `parkExit()` call site existed on the path.

---

## Part 2 — Measurement 2: the calibration probe

Run through the harness's own `runStep` seam (`executionOverride` per driver, `cwd` = repo
root, real `.pelaggio.yml`), so this measures the production path, not a CLI approximation.
Two rounds, four questions each, "answer from context, use no tools", plus a canary naming an
invariant that does not exist. Total cost **$1.02**.

### Round 1 — root invariants (`AGENTS.md`)

| Driver | Declared context | Q1 verbatim | Q2 `STEPS` | Q3 `docs/plans/` | Q4 canary | Tool calls |
|---|---|---|---|---|---|---|
| claude | CLAUDE.md, AGENTS.md, MEMORY.md | ✅ | ✅ | ✅ | ✅ `NONE` | **0** |
| codex | AGENTS.md | ✅ | ✅ | ✅ | ✅ `NONE` | **0** |
| grok | CLAUDE.md, AGENTS.md | ✅ | ✅ | ✅ | ✅ `NONE` | **0** |

**3/3 drivers, 12/12 answers, zero tool calls, zero confabulation.** Grok — listed as
"**Unverified**" and suspected of reading nothing — loads both files.

### Round 2 — routed docs (`docs/agent-context/pipeline.md`)

Three facts that live only in a routed doc: session-record field names, the
`CONFINEMENT_PROBE_INTERVAL_MS` default, and the worktree `node_modules` layout rule.

| Driver | R1 | R2 | R3 | Canary |
|---|---|---|---|---|
| claude | UNKNOWN | UNKNOWN | UNKNOWN | `NONE` ✅ |
| codex | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| grok | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

**0/3 drivers, 0/9 answers — and every driver said UNKNOWN rather than inventing one.** The
failure is clean: routed content does not arrive, and the drivers know it does not.

### Round 3 — the same questions, with the doc path named in the prompt

Round 2 forbade tools, so its UNKNOWNs prove only that routed content is *not already in
context* — not that naming a path would fix it. Round 3 tests the remedy directly: identical
questions, one added line — `Before answering, read this routed document:
docs/agent-context/pipeline.md` — and tools allowed.

| Driver | R1 | R2 | R3 | Canary | Tool calls | Cost |
|---|---|---|---|---|---|---|
| claude | ✅ all six fields | ✅ 15s | ✅ | `NONE` ✅ | 1 `Read` | $0.21 |
| codex | ✅ all six fields | ✅ 15s | ✅ | `NONE` ✅ | 1 `Bash` | $0.14 |
| grok | ✅ all six fields | ✅ 15s | ✅ | `NONE` ✅ | 1 `Read` | $0.73 |

**3/3 drivers, 12/12 answers, one file read each.** Naming the path is sufficient; no content
assembly is required. Total across all three rounds: **$2.10**.

### What this settles

- **P-CTX1 (explicit root-context assembly): not needed.** Native loading already delivers
  `AGENTS.md` to all three drivers. Building a per-provider injection primitive would replace
  a working mechanism with a new one.
- **P-CTX3 (calibration probe as an admission gate): not needed as a primitive.** It was
  proposed to settle a question that had never been asked; asked, it costs $1.02 and every
  seat passes. Keep it as an occasional operator check, not as a seat-admission gate with a
  new `ineligible` disposition. (The ADR-0020 `degraded`-vs-ineligible correction in
  `rebuild-plan.md` is right about ADR-0020, and now moot.)
- **P-CTX2 (step→context routing): confirmed, and now precisely scoped.** The gap is exactly
  and only the routed docs. This is `coherence-audit.md`'s corrected mechanism — "present-state
  documentation is not FOUND" — measured, on all three drivers, rather than inferred from one
  session's mistakes.

  **It needs a delivery mechanism, and `rebuild-plan.md` put that in P-CTX1, which this
  document rejects.** Round 3 supplies one and measures it: the routing table drives a **short
  prompt preamble naming the routed docs that step must read**, emitted by the existing
  per-step prompt builder. Every driver then opens the file and answers correctly, at one tool
  call and ~$0.36 average. Not P-CTX1's per-provider content assembly — that would inline
  content the drivers demonstrably fetch for themselves once told where to look.

One fragility worth recording: Claude's native `CLAUDE.md` load depends on
`@anthropic-ai/claude-agent-sdk` defaulting `settingSources` to all sources. `step-runner.ts`
never sets it, and `packages/pelaggio/package.json` declares the caret range `^0.3.220`, so the
resolved version can move without a lockfile change being reviewed as a behaviour change. At
0.3.220 the default loads `project` (verified in `sdk.d.ts`: *"When omitted, all sources are
loaded … Must include `'project'` to load CLAUDE.md files"*), but earlier SDK majors defaulted
to `[]`. **Set it explicitly to `["user", "project", "local"]`** — the full set, matching
today's omitted default. Pinning to `["project"]` alone would silently drop
`~/.claude/settings.json` and `.claude/settings.local.json` and is *not* behaviour-preserving.

---

## Part 3 — What is left of the rebuild case

| Pillar | Status after measurement |
|---|---|
| Parks are 26% of cycles and unattributable | **Falsified.** Attributed; located outside the code a rebuild discards; 17 of 22 (85% of park spend) are the gate working as specified; no deliverable was lost |
| The review fan-out may be 1 calibrated driver + 2 guessing | **Falsified.** 3/3 calibrated, 0 tool calls |
| 87% of `pipeline.ts` is two functions with no phase choreography | **Confirmed.** `runPipeline` 219–2033 = 1,815; `runOrchestrator` 2254–3467 = 1,214; 3,029/3,498 = **86.6%** |

The surviving pillar is a **refactor** argument. It says the code is badly shaped; it does not
say the code is wrong. And the rebuild plan's own transfer list, across two rounds of review,
grew to include `parkExit`/checkpoint-restart, `resume`/`detectResumeStep`, attempt identity,
the session-record registry, effects dispatch, the ADR-0022 authoring-loop wiring, and the
direct-push landing handoff — that is most of what `runPipeline`'s 1,815 lines *are*. A
discard whose transfer list keeps growing until it covers the discarded thing is a refactor
wearing a rebuild's clothes, with the rewrite trap's risk and none of its clean slate.

**Verdict: refactor.** A rebuild would need evidence that the choreography is causing failures.
The measured failures are 22 parks in the review loop and, from the same log, `implement
failed` ×6, `implement` confinement ×4, `ship failed` ×3, `pick:worktree-exists` ×2 — every one
of them inside a module the rebuild plan already transfers.

---

## Part 4 — The refactor target, corrected

`system-map.md` proposes `pipeline/phases/*.ts`, one per `STEPS` entry. That is the right
destination and the wrong first move, because it is not the expensive part.

`runPipeline` is not "1,815 lines of phases". It is:

| Region | Lines | What it is |
|---|---|---|
| 219–336 | 118 | 25 `PipelineDeps` resolutions + cycle-scoped mutable state (`cost`, `steps`, `assignment`, `executionReceipts`, `itemRunId`) |
| **337–808** | **~470** | **`step()` — the cycle-level step envelope**: budget gate, confinement snapshot/probe/diff, effects manifest + dispatch, execution receipts, logging, park |
| 809–903 | ~95 | `finish()` (`:815`) and the cycle-termination state it closes over |
| **904–2033** | **1,130** | the six phase banners (`:904`, `:1084`, `:1226`, `:1357`, `:1509`, `:1806`) — **and `parkExit()` at `:1100`, defined *inside* this span** |

**The phases are at most 62% of the function, and they are not what makes it hard to change.**
Everything above line 904 is closure-captured state the phases read and write — and `parkExit`,
the cycle's other termination path, is defined between the *second* and *third* phase banners
(`:1084` Detect quick mode, `:1226` Plan + Shakedown-plan) rather than beside `finish`. That interleaving is the finding: it is why attempt identity
(#467) had to define `itemRunId` at `:282`, hundreds of lines before `itemId` is assigned at
`:906`, and why its first patch missed `appendDecisions`.

So the extraction order is forced, and it is the inverse of the proposed one:

1. **`CycleContext`** — the DI block and cycle-scoped state as an explicit object rather than
   a closure scope. Mechanical; no behaviour change; makes everything after it possible.
   (`system-map.md` correctly withdrew the claim that this "realizes ADR-0026 P4". It does
   not — P4 needs an agent-inaccessible authority. It is a refactor, and that is all.)
2. **The step envelope** — `step()` into its own module over `CycleContext`. This is the single
   largest unit, the most defect-dense, and the one with no unit tests today.
   **It is not the ADR-0020 provider seam** — `StepProvider`/`runStep` already is that, and
   `system-map.md` was right to withdraw a second module under that name. This is the *cycle*
   envelope around the provider call: budget, confinement, effects, receipts, park.
3. **Cycle termination — `finish()` (`:815`) and `parkExit()` (`:1100`) together.** These are
   two non-adjacent regions today; co-locating them is part of the extraction, not a
   precondition of it.
4. **The six phases**, per `STEPS` — not per the comment banners, which are a different
   partition (`Detect quick mode` is not a step; `Plan + Shakedown-plan` is two).
5. **`runOrchestrator`** — last, or not at all. `system-map.md`'s "least certain" note stands:
   several of its responsibilities are ADR-0026 P5 reconcilers that do not exist yet (#470),
   so extracting it now may mean extracting code that reconciler work rewrites.

**Precondition, not a parallel track:** #478 (vacuous-test audit) and #420 (hermetic guard) come
*before* step 2. Extracting the step envelope against a suite with five known-vacuous cases and
fixtures that diverge from production is how a refactor silently changes behaviour. This is
`system-map.md`'s own sequencing conclusion and it survives review.

---

## Part 5 — Guards: ADR-0026's four classes, all four

`rebuild-plan.md`'s corrected selection criterion is right and is adopted unchanged. Restating
it because "keep fenced only" was the error it had to correct twice:

| Class | Rule | Members |
|---|---|---|
| **fenced** | keep | red-merge guard; effects manifest (provenance + `preSha`, content-bound); execution receipts (content-bound); `feat/<id>` claim creation (git ref atomicity); landing CAS (ADR-0025, unbuilt) |
| **derived-exclusive** | keep — the ADR-0001 isolation spine | worktree confinement via the **whole-step Git porcelain audit**, which ADR-0001 (**accepted**) names the hard gate; `blockForeignRootWrite` retained as the advisory early layer ADR-0001 says it is |
| **reconciled** | keep, **with mandatory corrections** | `review-request-queue` drain — must adopt ADR-0026 decision 3's two fixes (liveness-gated reclaim replacing the heartbeat-less four-hour lease; idempotent-or-fenced terminal effects). Copying its current shape is adopting its bug |
| **hint** | not load-bearing for correctness | `withFileLock` / `withMutationLock` (16 call sites) |

Two things this audit does **not** license:

- **Do not drop the confinement audit.** It is the accepted ADR-0001 hard gate; path extraction
  from tool args as the hard gate is the recorded **failed PR #112 approach**; the audit's one
  protective catch (#435) is precisely the case `blockForeignRootWrite` missed, because `pick`
  runs with `cwd=MAIN_REPO` and `foreignRoots.delete(cwdAbs)` exempts it; Bash is outside the
  semantic hook entirely; and OpenCode declares `isolation: []`, so dropping the audit leaves
  that provider with no enforced isolation at all.
- **Do not treat "no recorded save" as "no value."** A guard that prevents an incident leaves no
  log line. The red-merge guard has zero recorded firings and is unambiguously correct.

**One measured cost the prior audit did not have — and it does not survive inspection.** Four
parks (43, 365, 389, 387 — $47.07) are an `error_confinement` in a *review seat*. Seats run
read-only in an ephemeral `prepareAuthoringReviewSeat` checkout, and `forbiddenRootsForStep`
already excludes peer seats and review heads via `isEphemeralReviewWorktree`
(`pipeline.ts:329`). An earlier draft read all four as one peer/ad-hoc false-positive class and
proposed widening the seat root-set. The recorded diagnostics say otherwise — they are four
different things:

| Park | Changed root | Reading |
|---|---|---|
| 43 (08-03 05:52), 365 (08-03 06:08) | peer **item** worktrees `pelaggio-365`, `pelaggio-82` | **Already fixed.** `4565f3c` — *"exempt concurrent peer worktrees from confinement snapshots (#369)"* — landed 08-03 13:16Z, **after both parks**. This class is closed |
| 389 (08-03 21:55) | **main**, `.pelaggio.yml` dirty | An operator edit to the main checkout. The existing lever is `confinement.allow-dirty-main` (ADR-0001's amendment), which this repo leaves off. Not a registry miss |
| 387 (08-04 00:08) | ad-hoc sibling `pelaggio-codexparse` | Not an item worktree, so no `activeWorktrees` entry or session record covers it. ADR-0001 audits foreign roots **deliberately**; the detection is arguably correct |

**So there is no review-seat root-set widening to build, and the earlier draft's "G5a-1" is
withdrawn.** Two of the four are already closed by a commit that landed the same day; one is an
operator-config lever that exists; one is the audit doing its job. Exempting main for seats
would contradict the ADR-0001 / #435 warning three paragraphs above.

What remains from this population is a **disposition** problem, not a detection problem: a
read-only seat is failed by a *peer's* write, and the cycle then takes a recoverable park. That
is Part 6.

---

## Part 6 — The gap ADR-0026 left open

ADR-0026's Context names the conflation exactly — *"cannot evaluate is not evaluated as
bad"*. The re-cut ADR carries no scope sentence for it (the pre-re-cut Context's *"decisions
5-8 are scoped to the merge gate"* was deleted in the re-cut, not moved), so scope must be
read off the surviving text — and it is still the merge gate: decision 5 names *"the
merge/delivery path"* as the disposition consumer, and the construction home builds only that
instance. `guarded-actions.md` §7's `Disposition` is *"the only thing the merge path reads"*,
§7.3 scopes shippability to the merge gate's two runners, and §2.3 catalogs
`doc-review-cli.ts`'s starker form of the conflation without assigning it a remedy.

The authoring-review loop is neither the merge gate nor read-only. It **parks live cycles**.
And it carries the identical conflation, at `review/loop.ts:276`:

```ts
if (!reviewerRecords.some((record) => record.ok)) {
    …
    return withFloor({ outcome: options.parkSignal.parked ? "budget" : "hard-block", … });
}
```

Zero seats completed — for any reason — resolves to `hard-block`, and `pipeline.ts:1755` parks
the cycle on it. `loop.ts:215` (diversity misconfiguration), `:219` (pass-entry budget cap) and
`:303` (Judge seat throws) reach terminal outcomes the same way, without a typed cause.

G5 (#468) does not close this. Its body scopes the disposition function to `pr-review-cli.ts`
and treats `review/loop.ts` as the *source* to plumb `DiversityStatus.softened` **from**, not
as a path needing its own disposition — the same posture as `guarded-actions.md` §7.1, which
names `review/loop.ts` only as "the authoring/doc-review path" the merge gate must import
from. Nothing in the re-cut ADR or its construction home assigns the authoring loop's
disposition to anything. **So this defect has no owner.**

### The defect, stated no larger than it is

Three drafts of this section proposed a fix and each one was wrong. What survives review is the
defect statement, not a design:

1. **`error_confinement` is routed through a recoverable park.** `parkExit()` sets
   `error: "parked"`, which is in `RECOVERABLE_ERRORS` (`types.ts:368`), so the campaign
   continues and `--resume` re-enters. `pipeline.md` requires the opposite in terms — *"a
   mid-step trip is a fail-closed **early abort**, never `parkExit()` … a park's checkpoint
   would durably commit a tree already proven contaminated"*. The authoring loop routes around
   that invariant by converting the trip into an untyped `hard-block` first. Measured twice
   (365, 387) plus twice more mid-panel (43, 389).
2. **There is no typed cause at any seat or Judge exit**, so no disposition rule can be written
   over them. `ReviewPassRecord.reviewers[].diagnostic` (`loop.ts:258`) is not a carrier: it
   holds a subtype only for a *resolved, parseable, non-ok* seat, arbitrary text for rejections
   and parse failures, and nothing at all on the thrown-Judge path (`loop.ts:303`), which
   returns without pushing a pass record.
3. **A deterministic provider-configuration fault is treated as a retryable park.** 435's Codex
   400 (`'gpt-5-codex'` unsupported on this account) cannot be fixed by resuming.

**What this defect is *not*: a fail-open.** Draft 3 claimed the loop could ship an unreviewed
cycle. It cannot — every path above returns `hard-block` and `pipeline.ts:1755` parks it. The
fail-open was in *my* proposed disposition table, which ended `otherwise → proceed`; the
codebase's behaviour is fail-closed and over-conservative, not fail-open. The priority argument
must rest on (1) and (3) — a hard gate laundered into an auto-resume, and unattributable
terminal outcomes — not on a path that does not exist.

**Live measured population: 3 parks, $22.30** — 387 and 389 (confinement; 43 and 365 predate
`4565f3c` and are already closed, per Part 5) and 435 (Codex 400).

### Constraints any fix must satisfy — and why this needs a charter, not a plan paragraph

Every draft failed on a constraint it had not enumerated. They are enumerated here so the
charter starts from them rather than rediscovering them at review prices:

- **`ReviewOutcome` is closed and shared.** Six values (`types.ts:446`), mirrored in
  `REVIEW_OUTCOMES` and validated in the `review.Verdict` effects manifest (`effects.ts:449`).
- **`ReviewLoopResult` is shared beyond the authoring loop.** `review/record.ts`,
  `review/document.ts` (doc-review) and `review/bench.ts` all consume it, and the record
  payloads are versioned. Adding fields is a schema-evolution question across every caller —
  "the record keeps its shape" was false in draft 3. A distinct authoring-scoped result type
  may be the cheaper answer.
- **Dissent is `ship.target`-conditioned and must stay so.** `pipeline.ts:1752-1755` parks
  Judge-ruled `dissent` only for `direct-push`; in PR mode it ships with the dissent recorded,
  the PR being the veto (#244, ADR-0024). Any disposition that parks "every retained ≥-bar
  survivor" silently changes this repo's live `auto-merge-pr` policy.
- **ADR-0024's safety floor is fixed.** A safety-class survivor is `hard-block → parkExit()`,
  never Dissent, and `hasUnclearableSurvivor` already forbids harness revision.
- **The pre-Judge split gate is fixed.** A genuine reviewer split parks before the Judge for
  *all* ship targets — three of category C. Not a fault to reclassify.
- **Ship no `indeterminate`.** Decision-7-allowlisted causes (transport/boot, 402, rate-limit,
  SDK outage) must keep today's recoverable park: default-deny without `indeterminate` would
  turn them into non-recoverable blocks, a regression. `indeterminate` for that population is
  G5's, and ADR-0026 decision 8 binds it to the decision-9 quota primitive (G2/#465). A fix
  that ships no `indeterminate` inherits none of that — which is the property that makes this
  separable from G5.
- **Default-deny means the fallthrough blocks.** `proceed` must require a *positive* verdict.

**Recommendation: charter G5a to produce the disposition design**, against the constraint list
above, with the documentation amendment as part of the deliverable, targeted at where the
re-cut put each piece. ADR-0026's decisions stay untouched — decisions 4, 5 and 7 already
state the rules this design must satisfy — and the amendment lands in `guarded-actions.md`:
extend §7's merge-path-only scope to name the authoring loop's park path as a second
disposition consumer, add the loop's typed seat/Judge causes to the §7.2 cause table, and give
its absorbing states their clearing rows (transition + actor, per ADR-0026 decision 4) in §6's
lifecycles. Do **not** treat the sketches in this document's earlier revisions as
the spec; they are in the git history as worked examples of how the constraint list was
discovered, and each of them was wrong.

**Honest sizing.** $22.30 of live re-routed spend does not justify the work on its own. The
argument is the ADR-0001/`pipeline.md` invariant violation in (1) and the absence of typed
causes in (2), which is what makes every future disposition rule in this loop unwritable. If
the charter comes back larger than a couple of days, that trade should be re-examined rather
than assumed.

### The 17 completed-or-designed parks are a policy question, not a defect

A findings-block ends the cycle. The operator resumes; the item completes. That is ADR-0026
decision 4's rule working as specified — `parked` clears by `resume`, the row now tabulated in
`guarded-actions.md` §6's attempt lifecycle. The cost is a re-run: $75 measured in
repeat parks, plus operator latency. Whether a findings-block should instead consume a bounded
in-cycle revision entitlement is a **P3 token** question (decision 9) and belongs with
G5/#453's work, on evidence about revision success rates that does not exist yet. **Do not
bundle it into G5a.**

---

## Part 7 — Sequencing

| # | Work | Size | Why here |
|---|---|---|---|
| 1 | **Charter G5a** — authoring-loop disposition + typed seat causes, against Part 6's constraint list (+ the `guarded-actions.md` §6/§7 amendment) | S to charter | Closes a violated hard-gate invariant and makes the loop's terminal outcomes attributable; ships no `indeterminate`, so no G2 dependency |
| 2 | **Set `settingSources: ["user","project","local"]`** in `step-runner.ts` | XS | One line. Makes the measured calibration result durable under a caret-ranged SDK |
| 3 | **P-CTX2** — routing table + step-prompt doc preamble | M | The only context gap that measured non-zero, and round 3 measured the remedy working |
| 4 | **#478 + #420** — vacuous-test audit and hermetic guard | M | Precondition for any extraction, per `system-map.md` |
| 5 | **`coherence-audit.md` moves A–C + D0** | S | Cheap, and D0 (`ship/SKILL.md:78`) is a live wrong statement agents execute against |
| 6 | **Extract `CycleContext`, then the step envelope** | L | The actual refactor; gated on 4 |
| 7 | Cycle termination (`finish` + `parkExit`); then phases per `STEPS` | L | After 6 |
| 8 | **#461 → G2 (#465) → G5 (#468) → G6b (#470)** | XL | Unchanged from `priority-reassessment.md`'s corrected order — **#461 first**: ADR-0026 decision 3 puts liveness on G5's critical path, not just G6b's |

Items 2, 3 and 5 are days, not an epic. Item 8 is the existing roadmap and this document does
not re-litigate it — `priority-reassessment.md`'s corrected recommendation (finish #461, then
G2, then G5, defer G6b) stands, with the single amendment that **G5a is separable from and
cheaper than G5, and should precede it.**

Two state changes since those documents were written, both verified today: **there are zero
open PRs** (ADR-0026's "4/4 open PRs blocked, $136.29 held" no longer holds), and **#428 and
#455 are closed.** The stranding that motivated ADR-0026's urgency has cleared; the
classification it establishes has not become less correct, but the pressure to ship decisions
5–8 *for the merge gate* is lower than when it was written — a further argument for doing the
authoring-loop half first.

---

## Part 8 — Where this could be wrong

- **The July/August comparison is confounded and I have leaned on it.** 94 commits separate the
  campaigns; August's work is harder; the two windows are 31 and 84 cycles at 2.5 weeks apart.
  The *park* attribution does not depend on it — that is mechanistic — but "$304 of review
  spend and a 74%→45% completion drop" is correlation, and the loop being present in 100% of
  one window and 0% of the other means this dataset **cannot** separate its cost from the
  period's. A within-campaign A/B (`authoring.enabled` off for N cycles) is the only clean test,
  and I am not proposing one: at $13.6/cycle it costs more than the fix.
- **10 of 22 park reasons are recovered, not 22.** The other 12 are attributed by call-site
  enumeration and step shape. That is strong, but it is inference; a park reason string from a
  campaign log is not.
- **Category C's split into "designed" versus "fault" rests on four output tails**, not on
  re-running the loop. Three read as reviewer disagreement and one as unfinished prose. If that
  reading is wrong, up to $103.35 moves between the "gate working" and "crash" columns and the
  85/15 headline moves with it.
- **Item completion is measured across two sources.** 12 of 17 completed inside the log window;
  4 more are inferred landed from issue-closure timestamps after it; #435 is still open. The
  issue-closure inference is weaker evidence than a cycle record.
- **G5a's dollar case does not stand alone** — $22.30 of live re-routed spend. Part 6 says so.
- **The 387 case may not want `abort` at all.** An ad-hoc sibling worktree changing under a
  read-only seat is a foreign root ADR-0001 audits deliberately, but the *seat* did nothing
  wrong. The alternative — treating a proven-read-only seat's foreign-root delta as a peer
  event — is a change to ADR-0001's boundary and should be decided there, not smuggled in via
  disposition. The charter must name which it is choosing.
- **I have not read `runOrchestrator`.** Part 4 defers it on `system-map.md`'s reasoning, which
  I did not independently verify.
- **Auditability is uneven between the two measurements.** Part 1 re-derives entirely from
  `.dev/pelaggio-log.jsonl`, `.dev/supervised-run-*.log` and `git log`. Part 2 does not: it
  comes from `.dev/calibration-probe{,2,3}.ts`, costs $2.10 to reproduce, and is
  **nondeterministic**. Three conclusions (dropping P-CTX1 and P-CTX3, and the shape of
  P-CTX2) rest on that weaker evidence. The probe scripts are retained in `.dev/`.

### The review series did not converge, and I stopped it deliberately

Four `doc-review` passes on this document returned **9, 6, 8 and 8** must-fix findings, at
**$73.63** total. Every round found real defects — draft 1 would have proposed retrying a
confinement violation; draft 2 specified a disposition with no wire; draft 3 ended its own
default-deny table with `otherwise → proceed`; draft 4 mis-partitioned four parks and would
have regressed `dissent@direct-push`. None of that is the reviewers being wrong.

But a flat finding count across four passes is the signal that re-reviewing is not the right
next move. Round 4's findings are almost entirely against **Part 6's design sketch**, not
against the measurements — which is what a review says when it is being handed a specification
that was never chartered as one. So Part 6 is now scoped to the defect and its constraints,
and the design is chartered rather than drafted here.

**Read the two measurements as the deliverable.** They are cheap, re-derivable, and they
overturn two of the three pillars the rebuild case rested on. The rest of this document is a
recommendation, and it has needed correction at every pass.
