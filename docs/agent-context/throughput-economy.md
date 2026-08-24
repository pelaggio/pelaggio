# Throughput economy: a refuted ratchet, and what the data actually shows

Status: investigation, complete. **Records a negative result.** Verified against the tree
at `2639dd1`. Companion evidence: `charter-contract.md` §12 (the measured spend data this
builds on), `guarded-actions.md` §1 (the guard-accretion complaint this tested),
[ADR-0013](../decisions/0013-reversibility-weighted-gate-sizing.md),
[ADR-0016](../decisions/0016-severity-taxonomy-and-owner.md),
[ADR-0017](../decisions/0017-graceful-degradation-rigor-only.md),
[ADR-0024](../decisions/0024-adversarial-authoring-review-loop.md).

## 0. Why this document exists

An external argument — Matt Whetton, *"Trust is the Most Effective Control in Engineering,
and It Does Not Transfer to Agents"* (Medium, 2026; read via reader proxy, not the
original) — predicts that agent fleets accumulate checks monotonically, because an agent
proposes a defense without bearing its cost and cannot retain the lesson across sessions,
so every lesson becomes permanent structure.

The prediction was tested against this repo, and it splits in two:

- **By volume — a large *citation-edge* effect is ruled out.** Guard landings do not spawn
  more citing follow-ups than capability landings (ratio 0.92–1.15 across specifications,
  §1.2). **This bounds the proxy, not the world:** citation edges are the only outcome
  measured, and §1.3 concedes that spawned work which never cites its parent is invisible.
  Nothing here bounds a large *uncited* spawn effect.
- **By composition — null.** The follow-up question (do guard landings spawn guard-flavoured
  work?) does not reach significance under the specification this document designates as
  best (p = 0.31, §1.2.1).

The stagnation is real. §2.1 measures where the backlog grows, but does **not** settle
*why* — see §6. This document records the result because the supporting anecdote is vivid,
re-derivable from the same data, and wrong on both halves — and because four successive
drafts were blocked by `doc-review`: the first for two fabricated evidence claims, the
second for a classifier defect that flipped the sign of its own headline number, the third
for leaving the *secondary* statistics computed with the classifier the second fix had
discarded, the fourth for reporting a composition result under the one specification of
four that yielded it. The recurring defect was never arithmetic. It was stating conclusions
stronger than the measurement supported, four times, in a document about over-claiming.

## 1. The refutation

### 1.1 The anecdote, and why it fails

The motivating observation: **#557** (worker-seat isolation — a guard) landed, and #558–#575
followed within 36 hours: 16 items, ~12 of them further guard-hardening. Against it,
**#580** (escalation legibility — operator UX) landed and spawned nothing.

Both halves are artifacts.

- `ef8b70f` (#557) merged at **2026-08-19T04:24Z**. #558 was filed 2026-08-18T12:57Z and
  #559–#562 at 2026-08-18T14:13Z — **14–15 hours before the merge**. Five of sixteen
  items (31%) predate the landing they supposedly caused; they were filed *during* the
  work, which is ordinary discovery, not ratcheting.
- #580 closed at 2026-08-21T04:37:**32**Z. The tree measured against, `2639dd1`, was
  committed at 2026-08-21T04:37:**31**Z. The control arm had a **~0-hour observation
  window** against #557's 36. It was empty by construction.

### 1.2 The proper measurement

Time windows cannot separate spawn from coincidence when several items land per day. The
defensible edge is a **citation edge**: a child filed *after* a parent landed that
references it. Parents matured ≥7 days (closed before 2026-08-14), so recent landings —
including #557 — are correctly excluded rather than counted at partial maturity.

The result is sensitive to two specification choices, so all three variants are reported
rather than the most convenient one. The classifier variant matters because an earlier
draft anchored the regex as `\b(...)\b`, which silently prevents the prefix patterns
(`verif`, `confin`, `isolat`, `authoriz`, `adjudicat`) from matching anything — `\bverif\b`
does not match "verification". The window variant matters because parents closed months
ago have accumulated citations for longer than parents closed a week ago.

| Variant | Guard | Capability | Ratio |
|---|---|---|---|
| `\b`-anchored classifier, unbounded window | n=62, mean 0.565 | n=132, mean 0.614 | 0.92 |
| §8 classifier, unbounded window | n=80, mean 0.613 | n=114, mean 0.588 | 1.04 |
| §8 classifier, fixed 30-day window, full-exposure parents only | n=46, mean 0.717 | n=74, mean 0.622 | **1.15** |

**The point estimate ranges 0.92–1.15 depending on choices that should not matter to a
real effect.** The best-specified variant — a fixed follow-up window with exposure
equalised — puts guard landings 15% above capability, in the direction the hypothesis
predicts, at a magnitude that cannot explain anything. The motivating anecdote implied a
ratio on the order of 16-to-0.

The honest reading is not "refuted, direction reversed" but **"no effect large enough to
matter, and the measurement cannot resolve a difference this small."** Among parents with
≥3 citation edges, both classes appear: #76 (5, capability), #259 (4, capability), #80 (4,
capability), #28 (4, capability), #455 (3, capability), #170 (3, capability), #82 (3,
capability), #21 (3, capability), **#272 (3, guard)**, **#142 (3, guard)**, **#60 (3,
guard)**. An earlier draft listed only the capability members of this tie, which was
selection, not evidence.

The obvious alternative — that *large* items spawn follow-ups regardless of kind — also
fails. Joining to the cycle log (n=66 parents with per-item cycle data):

```
corr(edges, cycles)  =  0.093
corr(edges, spend)   =  0.074
corr(edges, isGuard) = +0.089
```

All three are noise. Spawn *volume* is not predicted by the kind of work, the cycles it
took, or what it cost.

### 1.2.1 Composition: a null result, reported because an earlier draft claimed otherwise

The obvious follow-up to volume-at-parity is whether guard landings spawn work that is
itself guard-flavoured. Under both windows:

| Variant | Guard-parent children | Capability-parent children | Fisher exact, 2-tailed |
|---|---|---|---|
| Unbounded window | 18/49 (37%) | 12/67 (18%) | p = 0.031 |
| **Fixed 30-day window** (§1.2's designated best) | 11/33 (33%) | 10/46 (22%) | **p = 0.31** |

**The signal does not survive the specification this document itself designates as best.**
It also would not survive correction for the ~6 tests run here (Bonferroni at 0.05/6 ≈
0.008), and it was never a pre-registered hypothesis — it surfaced while checking something
else.

A third draft reported only the unbounded row, called it significant, and §0 and §7 told
readers it was the one signal that survived. That was selection: reporting the one variant
of four that yields significance, and specifically not the designated one. **There is no
composition finding here.**

Independently of the arithmetic, a confound would undercut the result even if it had held:
the classifier keys on subject-matter words, and an item's follow-ups are about its subject
matter. #557's children are titled with isolation vocabulary because they concern
isolation, not necessarily because guarding begets guarding. §7 names the hand-classification
that would separate the two; it has not been run.

### 1.3 Honest limits of the refutation

- A citation edge is a proxy. Work spawned by a landing that never cites it is invisible.
- Guard-vs-capability is a title-keyword heuristic (§8), crude at the boundary. On the
  194-parent set the two classifier variants disagree on **18 items** — roughly 9%, and
  enough on its own to move the ratio from 0.92 to 1.04.
- The maturity control excludes #557, the case that motivated the hypothesis. This is
  correct method and worth stating plainly: **the thesis was built on the one data point
  too recent to measure.**
- The zero-inflation is high (61–66% of landings spawn nothing), so means are fragile and
  a handful of reclassified items moves them.
- n is small once exposure is equalised (46 guard / 74 capability). A 1.15 ratio at that n
  is not distinguishable from 1.0.

What this does and does not establish: a guard-spawn effect **of the size the anecdote
implied** is ruled out. A small residual effect — plausibly the 1.15 — is **not** ruled
out, and this data cannot rule it in either. Anyone reviving the hypothesis needs a
measure that does not depend on citation edges (§7).

### 1.4 What the first draft asserted, and how it failed

Recorded because it is the strongest available argument for the `doc-review` gate this
repo already runs. A first draft (`gate-economy.md`, deleted) proposed a standing-gate
budget growing as `sqrt` of the irreversible-effect surface. A single-pass, three-seat
`doc-review` at **$6.68** returned **13 surviving findings** and a hard-block, including:

- The two evidence defects in §1.1 above, both fabricated by careless timestamp handling.
- The budget denominator was wrong. `dispatchStepEffects` implements **5** effect kinds
  (`checkpoint`, `plan.publish`, `ship.ShipDecision`, `review.Verdict`,
  `review.Escalation`); the parser accepts two more that throw `unknown_effect_kind` at
  dispatch. The draft asserted 6 — missing `checkpoint`, **the only kind that writes a git
  commit**, because a regex matched dotted literals only. An "irreversible-effect
  registry" that omitted the irreversible effect.
- Irreversible capabilities (`land`, `pr-adjudicate`, direct-push) live entirely outside
  `effects.ts`, so that denominator never tracked what it claimed to.
- A claimed "16 → 11 standing gates retired" that no row of its own trim table delivered.

The lesson is not that review is cheap. It is that **cheap review caught fabricated
evidence that confident prose concealed** — which is the reverse of the draft's own thesis
that gate cost and gate value are inversely correlated.

## 2. What the data does support

### 2.1 Intake exceeds closure, uniformly

Roadmap census at `2639dd1` (351 items ever; 139 open, 212 closed):

| Month | Created | Closed | Net |
|---|---|---|---|
| 2026-04 | 7 | 5 | +2 |
| 2026-07 | 195 | 124 | +71 |
| 2026-08 (to 08-21) | 149 | 83 | +66 |

Closure is **stable** at ~100–125 items/month across both full months. The backlog grows
because the system files ~1.7 items for every one it closes. Whether that closure rate is
*healthy* is not something these counts can say — there is no baseline to compare against.

Whether that excess is guard-shaped is a separate question from §1.2 — which measures
citation-spawn from matured landings, not intake composition — so it is measured directly
here, as created-over-closed within each class per month:

| Month | Created (G/C) | Closed (G/C) | Ratio, guard | Ratio, capability |
|---|---|---|---|---|
| 2026-07 | 81 / 114 | 51 / 73 | **1.59** | **1.56** |
| 2026-08 (to 08-21) | 73 / 76 | 40 / 43 | **1.82** | **1.77** |

The two classes track each other to within 0.05 in both months, and the corpus is 44%
guard / 56% capability overall. **The intake excess is uniform across work types** — it is
a property of how much work the system files, not of what kind.

**What this does not establish.** Created-over-closed shows the backlog growing and shows
the growth is class-neutral. It does **not** show that closure is healthy, nor that the
cause is intake rather than gate-constrained closure. Both readings fit these counts:

- *Intake-driven* — the system files more than any closure rate could absorb.
- *Gate-constrained* — closure is suppressed by the cost and block rate of the merge gate,
  and the backlog grows because throughput is capped below demand.

§2.2's 37% review share and 59%-in-≥3-cycle concentration are consistent with the second,
and this document does not resolve the fork. Calling ~100–125 items/month "healthy" is a
comparison against nothing. §6 treats the fork as open.

### 2.2 Landing cost concentrates in two places

From `charter-contract.md` §12 (188 cycles, 90 items, ~$3,595, 2026-07-14 → 08-20):

| Metric | Value |
|---|---|
| Review spend | **37% of all spend** (~$1,320) |
| Spend in the 21 items taking ≥3 cycles | **59%** |
| Cycles parking on review class | **11%** |
| Human adjudications | ~3–4/week |
| Confirmed frame-grind incidents | 1 in 5 weeks |

### 2.3 The gate blocks on infrastructure, not findings

`.pelaggio.yml` records the cost of the all-pass fail-closed fan-out in the operator's own
comment: *"an exhausted grok Build balance blocks every PR — a 402 surfaces as
`block (infra)`, not a real finding."* A third-party billing state is a merge blocker on
every change. The comment cites #455 as the pending fix; **#455 closed 2026-08-07 without
resolving it**, and the live successor is #582.

### 2.4 `deferred` is a park mechanism, not a graveyard

Stated because a first reading of the roadmap gets it backwards. The `deferred` label
marks items **excluded from automatic pickup pending operator promotion** —
`charter-contract.md` §7: *"created `deferred: true`, labelled not-eligible-for-pickup and
excluded by FlowPolicy — a human must promote each child."* #522 calls them *parked*.

The parked set holds the strategic backbone: #297 (tolerance policy), EPICs #295/#296/#306,
the Flow track (#172/#173/#174/#177/#178), contained execution (#261–#266), dashboard
(#40–#42), doc standard (#57–#59), OSS readiness (#150–#152). **Parked items are the
system working as designed.** Bulk-closing them would delete the roadmap's spine, and #522
asks for them to be *rendered distinctly*, not removed.

## 3. What is not actionable, and why

Content-based gate tiering — cheap review for docs, full rigor for authority code — is the
intuitive response to §2.2. Four ADRs bear on it, and **their statuses differ in a way that
matters**: ADR-0013 and ADR-0024 are `accepted`; **ADR-0016 and ADR-0017 are `proposed`**.
So one constraint below is decided and two are the repo's stated-but-undecided direction —
this section overstated that in an earlier draft, and the distinction changes what is
actually barred versus merely unratified:

- **ADR-0013 (`accepted`)** sizes gates by the *boundary's* reversibility and names
  merge-to-main as the one heavy boundary, explicitly including **"fail-closed
  review-survival."** It closes: *"reversible gates may be loosened freely; irreversible
  ones may not."* Tiering loosens gates **at** that boundary, keyed on change content — an
  amendment to a decided ADR, requiring supersede discipline, not an implementation gap.
  **This is the one hard bar.**
- **ADR-0024 (`accepted`)** decided the adversarial loop and its safety floor. A tier whose
  findings "never block" violates that floor for safety-class must-fixes.
- **ADR-0017 (`proposed`)** authorizes degradation *on rigor*, but as bounded relief under
  **availability duress** (a wedged pin), with a staleness ceiling and a re-verification
  trigger. It is not standing content-based relief — but since it is unratified, calling a
  change "ADR-0017-legal" asserts conformance to a direction the repo has not decided.
  Treat it as the intended posture, not as authority.
- **ADR-0016 (`proposed`)** carries the severity taxonomy and owner. Same caveat.

There is also a mechanical blocker: tiering needs a **declared write-set**, which does not
exist. Write-sets are `(flow, planned)`; #173 and #575 are open. What exists is
`blockForeignRootWrite` (`packages/pelaggio/scripts/pelaggio/step-runner.ts:193`), which
blocks writes to `MAIN_REPO` **and every registered foreign worktree root** — real
confinement, but a fixed boundary, not a per-item declared write-set — while
`contained-execution.ts` computes an *observed* set post-hoc. Tiering rigor off an
unenforced self-declaration would let a change declaring a presentational write-set touch
authority files under one advisory seat.

**The legal move is to cut review *cost at constant rigor*** — remove infra-driven
blocking and redundant passes — not to lower rigor by change content.

## 4. The three tickets

| # | Ticket | Evidence it rests on |
|---|---|---|
| **#571** | Pipeline cannot bring a stale branch forward (implement can't merge; freshness can't handle content-without-ancestry) | §2.2: 59% of spend in ≥3-cycle items. This is not a gate — it is a defect that forces changes back through every gate repeatedly, worsening on each retry. Removes gate *executions*, not gates. |
| **#578** | Review fleet degrades to a quorum of 2 on quota/infra seat loss, never to 1 | §2.3. Availability degradation, bounded and recorded — the posture ADR-0017 proposes, though that ADR is `proposed`, not `accepted`, so this conforms to intent rather than to a decided rule. Does not touch rigor by content. |
| **#582** | Type Codex and Grok limit faults at emission | §2.3. Supplies the **typed input only** — it makes balance-exhaustion distinguishable at emission. It does not by itself make a 402 non-blocking: `provider-quota.md` assigns disposition to #578 (quorum) and G5/#468, and `guarded-actions.md` §7 holds that an indeterminate fault is never itself a pass. Live successor to the closed #455, and a prerequisite for the other two rather than a fix on its own. |

All three are labelled `priority:high`. None depends on the refuted mechanism.

## 5. The trim, as executed

**Executed:** 14 open items parked (`deferred` label added) — #518, #517, #529, #530,
#531, #367, #423, #277, #481, #354, #329, #565, #567, #572. Rationale: #367/#423/#277 add
review passes while review is 37% of spend (§2.2); #517/#518/#529/#530/#531 add standing
checks; #565/#567/#572 are #557-cluster hardening better decided as one question. Parking
is reversible and uses the existing FlowPolicy exclusion.

**Deliberately not executed:** the bulk close of the 42 pre-existing `deferred` items,
proposed in the first draft. Two independent reasons — the semantics are wrong (§2.4), and
`npx pelaggio roadmap` exposes no close subcommand at all, only `mark-done`, which asserts
completion. Typed closure reasons are #519; roadmap update/link is #473.

**Not attempted:** relocating the nine `(flow, planned)` invariants out of `AGENTS.md`.
Still worth doing — every cycle reads nine binding rules governing unbuilt code — but it is
an edit to the agent contract, not backlog hygiene, and belongs with #489's doc-honesty pass.

## 6. The open problem: intake discipline

The 1.7× ratio (§2.1) is where the backlog grows, and **it has no designed answer** — but
the prior sentence of every earlier draft called it "the stagnation driver," which asserts
a cause this document has not established.

What is measured: the excess is class-neutral (1.59/1.56, then 1.82/1.77); closure is
stable at ~100–125/month; parking absorbs some of it (56 parked of 139 open).

What is not measured, and blocks any design:

1. **Intake-driven vs gate-constrained** (§2.1). If closure is capped by gate cost and
   block rate, intake discipline is the wrong lever entirely and §4 is the whole answer.
   §2.2's numbers lean this way and are not decisive.
2. **Broad filing vs a few decomposing EPICs.** The snapshot's `cites` field can answer
   this; it has not been run.

**No mechanism is proposed here.** Proposing one before those two measurements is the error
all four drafts made, in four different forms.

## 7. What would falsify this document

- **The volume refutation.** A spawn measure that does not depend on citation edges — for
  example hand-classifying the true parent of every item filed in a month — showing guard
  landings out-spawning capability landings by a clear margin. §1.3 names the proxy's blind
  spot, and the 1.15 fixed-window estimate is the residual this document cannot resolve.
- **The proxy itself (§0, §1.3).** Citation edges are the only outcome measured. Hand-trace
  the true parent of every item filed in one month and compare against the citation graph:
  if uncited spawn is common, the volume result bounds nothing and §1.2 should be struck.
  Until that runs, §0's ruling-out claim is scoped to citation edges by construction.
- **The composition null (§1.2.1).** Hand-classify the 116 children by whether they add a
  standing check, ignoring title vocabulary. A split that reappears under the fixed window
  after de-confounding would revive the question; one that does not confirms the null.
  Cheap — 116 items, one pass.
- **The intake-vs-gate fork (§6).** The single highest-value open measurement, because §4's
  entire justification depends on which way it resolves.
- **§2.1's framing.** The by-class ratios (1.59/1.56, 1.82/1.77) establish that the excess
  is not guard-shaped; they do **not** establish that it is broad rather than concentrated.
  If the 1.7× is dominated by a small number of decomposing EPICs in both classes, it is
  decomposition working, not an intake problem, and §6 dissolves. The snapshot's `cites`
  field is enough to test this and it has not been tested.
- **§3.** If the measured cost of the merge gate is dominated by seats rather than passes,
  then #578 alone captures most of §2.2 and no further work on review cost is warranted.

## 8. Method

**The observation is pinned, not live.** `gh issue list` reads mutable titles, bodies,
labels, and state, so re-running it later would not reproduce these numbers. The snapshot
the figures were computed from is committed at
[`data/roadmap-snapshot-2026-08-21.json`](./data/roadmap-snapshot-2026-08-21.json) — 351
items, each with `number`, `title`, `createdAt`, `closedAt`, `labels`, and `cites` (the
de-duplicated set of `#<n>` references found in title + body, resolved against the issue
number set). Bodies are not retained; `cites` is the only derived field, and it is what
every edge count is computed from. Regenerate with
`gh issue list --state all --limit 400 --json number,title,body,createdAt,closedAt,state,labels`,
noting that the result will differ from the pinned snapshot.

**Citation edges.** For each parent with a `closedAt`, count items whose `cites` contains
the parent and whose `createdAt` postdates the parent's `closedAt`; self-references and
non-issue numbers excluded. Two window variants: *unbounded* (parents closed before
`2026-08-14`, a ≥7-day maturity floor, n=194) and *fixed 30-day* (parents closed ≥30 days
before `2026-08-21T04:37:31Z`, counting only children filed within 30 days of the close,
n=120).

**Guard classification.** Case-insensitive title match on `gate|guard|enforce|verif|attest|
evidence|conformance|fail-closed|jail|confin|isolat|sandbox|egress|detector|audit|assert|
ratchet|authoriz|entitle|countersign|adjudicat|harden|invariant|scan|secret|trust|
regression test` — **unanchored**. The `\b`-anchored variant reported in §1.2's first row
is the earlier draft's defect, retained there only to show the sensitivity.

**Per-item cycles and spend.** Group `.dev/pelaggio-log.jsonl` records by `item`. Spend
figures in §2.2 are quoted from `charter-contract.md` §12, not re-derived here.
