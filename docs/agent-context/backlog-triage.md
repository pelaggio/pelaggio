---
title: Backlog triage pass
description: Whether the 135-item active backlog can be collapsed by consolidation, deferral, or closure — tested, and largely refuted.
status: draft
diataxis: explanation
---

# Backlog triage: a mostly-refuted collapse hypothesis

Status: investigation, complete. **Records a largely negative result.** Date: 2026-08-29.
Verified against the tree at `fb8cf94`. Companion evidence:
[`throughput-economy.md`](./throughput-economy.md) (the intake-exceeds-closure measurement
this starts from), [`review-gate-baseline.md`](./review-gate-baseline.md) (the fingerprinting
protocol this reuses), `AGENTS.md` §8.2 (the construction rule §4 leans on).

This document proposes dispositions. **It applies none of them.** No issue was created,
closed, edited, labelled, or commented on in the course of this pass. Applying a row is an
operator action — see §7.

## 0. Corpus and reproduction

```bash
# 195 open issues (2 pages), 244 closed issues (6 pages), 510 commits on main
curl -sS -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/pelaggio/pelaggio/issues?state=open&per_page=100&page=N"
```

The live backlog moves while you read this, so the corpus is frozen and fingerprinted the
way `review-gate-baseline.md` freezes its own:

| Artifact | n | sha256 (first 16) |
| --- | --- | --- |
| open issues, canonicalized to `{number,title,labels,created_at,updated_at}` sorted by number | 195 | `0167df41b7e5b826` |
| `main` commit log, `<sha9> <subject>` | 510 | `c75697c7dac0aa72` |
| closed issues (done-set for stale-scan) | 244 | — |

`gh` is not installed in this session and `RoadmapSource.listItems` caps at 200 (#528), so
the corpus was read from the REST API directly — the same instrumentation route
`throughput-economy.md` and `review-gate-baseline.md` took.

**The operator-supplied baseline reproduces exactly**, which is why it is safe to build on:
195 open · 67 ≤7d · 84 8–30d · 44 31–90d · **0 older than 90 days** (oldest 52d) · 12
untouched >30d · 60 `deferred` → **135 active**.

## 1. The hypothesis, and the verdict

The operator's hypothesis was that the backlog contains (a) items groupable into a future
feature and consolidatable or deferrable, (b) items that are disjoint sides of one
underlying issue, (c) items needing clarification, rescoping, or closing — alongside a valid
cohort.

| Limb | Verdict | Basis |
| --- | --- | --- |
| (a) groupable / consolidatable / deferrable | **Refuted** | The one real feature-group is already chartered as one plan with declared deps, and its deferral precondition is already met (§3). |
| (b) disjoint sides of one underlying issue | **Confirmed — but consolidation is the wrong response** | The 6-item credential cluster is 6 distinct channels of one root cause, and the items themselves document their disjointness (§4). One true overlap found repo-wide (§5). |
| (c) clarification / rescoping / closing | **Confirmed, small, and already self-limiting** | 16 title-only items, all inside a closed 2026-08-03..08-18 filing window; the practice stopped on its own (§6). |

**Headline: the backlog is healthy and no collapse is warranted.** The net proposal is
**−1 of 195**. The intake/closure ratio is intake-shaped, not rot-shaped: nothing over 90
days, 12 untouched, a third deliberately parked, and — see §2 — not one open item is
already-shipped or duplicated at the title level.

This is the outcome `#624`'s falsification list anticipates. A pass that manufactured 30
dispositions here would be producing exactly the *"architecture bookkeeping with little
decision value"* that list names as evidence the approach is wrong.

## 2. Prior art run first: both existing detectors return zero

### 2.1 `stale-scan` — 0 hits on 195 open items

The repo already implements three done-ness heuristics (`shipped-by-commit`,
`superseded-marker`, `title-match-done`). It was run as the real
`scanStaleItems()` — the shipped implementation, with the API-sourced corpus injected
through its own `gitLogMain` seam — not re-derived:

```
items=439 (195 open + 244 done)   commits=510   hits=0
```

**Zero. And the harness is not silently no-opping** — an all-zero result from a broken
scanner would be worthless, so it was checked against a positive control. Three *closed*
items whose completing commit is in the log (`#711`, `#593`, `#40`) were flipped to `open`:

```
control hits: 3
 #711 shipped-by-commit :: fb8cf94ac fix: stop roadmap-cli test's stdout capture… (#711) (#714)
 #593 shipped-by-commit :: f2a4fce68 fix: relabel genuine verdict-split exhaustion… (#593) (#710)
 #40  shipped-by-commit :: b27495844 feat: surface externally-launched pelaggio runs… (#40) (#709)
```

3/3. The detector fires when it should; the open backlog genuinely contains nothing it
recognizes as already-shipped.

### 2.2 Duplicate sweep (hand-run of #531) — 0 true duplicates

Token-Jaccard over all 195 titles, threshold 0.28, pairs with at least one active side:
**2 pairs, both sibling slices of the same parent** (`#643`/`#645` under #579;
`#619`/`#620` under the delivery-packet plan). Deliberate decomposition, not duplication.

**This is also a finding about #531's design.** The one genuine overlap in this backlog
(§5, `#491`/`#703`) scores **0.167** — well under threshold — because the two titles share
only `durable`, `records`, `review`. The overlap is at the body-and-call-site level, not
the title level. An exact/title-tier duplicate detector would not have found the single
real duplicate here. Worth carrying into #531 before it is built.

### 2.3 Citation-drift (hand-run of #530) — 14 hits, ~2 real

Body-cited repo paths that do not resolve at `fb8cf94`: 14 active items. But the dominant
class is **prospective paths — files the item proposes to create** (`ci/reap-test-tmp.ts`
for #645, `__tests__/tmp-fixture.test.ts` for #643, `docs/agent-context/revision-loop.md`
which #657 says "this item authors", `docs/decisions/0026` which is pending). Those are
correct citations to future state, not drift.

**The finding for #530: as specced, the detector cannot distinguish a citation-to-existing
from a citation-to-be-created, and in this corpus that false-positive class is ~86% of its
output.** It needs a tense signal (an Acceptance-evidence section lists outputs; a Why/Root-cause
section cites inputs) or it will be noise. Only two hits are true drift, and neither
changes the item's validity: `#70` cites the pre-rename `packages/autopilot/...` path, and
`#521` cites a `backlog-intake-audit.md` that was never written.

## 3. Limb (a): the one real feature-group is already correctly shaped

`#537`–`#541` (README inversion, dry-run flight plan, cost receipts, brand palette, hero
GIF) are the only non-infrastructure items in the backlog and are visibly one feature. They
are also **already chartered as one**: all five cite `docs/plans/positioning-tier1.md`
sections T1-1..T1-5 (the file exists, 15.8 KB), and `#541` already carries
`Depends on: 537, 538, 539`. There is nothing to consolidate — the grouping the hypothesis
asks for is already expressed, in the mechanism the repo uses to express it.

Deferral was then tested and **failed on its own precondition**. `#537`'s body gates a CI
badge on "when repo is public" — but the repo *is* public (`visibility: public`,
created 2026-04-12). The cluster is actionable now. Proposing `defer` here would have been
manufacturing a disposition against the evidence.

The same holds for the other slice families — `#579`→`643/644/645`, `#617`→`632/633`,
`#627`→`638/639/640`, `#657`→`660`–`664`, `#606`–`610`, `#581`–`586`. Each is a parent
carrying diagnosis or design plus dependency-ordered slices with distinct acceptance
evidence. The baseline already counts these 23 as healthy decomposition; reading the bodies
confirms it. **No merges proposed.**

## 4. Limb (b): six items, one root cause — and merging them would be a mistake

`#590`, `#591`, `#611`, `#612`, `#658`, `#688` all reduce to *"a review/verify seat can
reach a credential it was denied."* From titles alone this is the hypothesis's strongest
consolidation candidate. On inspection it is six **non-overlapping channels**:

| Item | Channel | Why it is not the others |
| --- | --- | --- |
| #611 | Anthropic key held in seat env | The seat is the API client; scrubbing cannot remove it |
| #591 | `~/.config/gh` on disk, via inherited `HOME` | Claude-seat env denial covers one of three providers |
| #612 | `node_modules/.bin` hijack of post-seat `gh` | Not a credential at all — a binary on `PATH` |
| #658 | `.git/config` extraheader from `actions/checkout` | "credential is on DISK, not in the environment" (its own words) |
| #688 | repo-controlled hooks run inside `git push` credential scope | Execution context, not credential storage |
| #590 | `SECURITY_PATHS` omits the modules implementing all of the above | A detection gap, one level up |

The authors already did the disjointness analysis — `#658` explicitly states that seat-env
denial "cannot reach this." Merging these would collapse six distinct fixes into one
unshippable item. **All six: `keep`.**

The decision value here is not a merge. It is that **this cluster is precisely the
recurrence signal `AGENTS.md` §8.2 describes**: "recurrence of *one more* instance of the
*same class* … is the signal to hoist." Six instances of one class is that signal, and the
hoist has already started — `#688` is literally titled *"Funnel harness git network
operations through one chokepoint."* The operator-facing conclusion: **the seventh such
finding should be chartered as a chokepoint hoist, not filed as `#7`.** That is a rule for
intake, and it does not reduce the current count.

## 5. Limb (b), the one true overlap: #491 / #703

Filed 17 days apart, and the only genuine content overlap found repo-wide:

- **#491** (08-11) "Durable evidence home" — scope item 1 writes *"receipts, review records
  and gate records"* to `MAIN_REPO/.dev/evidence/<attemptRunId>/` at emission.
- **#703** (08-28) "Authoring review records die with their worktree" — `pipeline.ts:1810`
  `writeReviewRecord(worktree!, record)`.

Review-record durability sits inside both. Both halves verified live in the tree:
`pipeline.ts:1812` still passes `worktree!`, and `execution-receipt.ts:164` still resolves
receipts worktree-relative via `join(cwd, ".dev", …)`.

But `#703` also observes that *every* sibling artifact already resolves against
`mainWorktree(REPO)` — so `#491`'s broad claim has been overtaken by incremental progress,
and the residue is narrower than its body says. Rather than merge, the cheaper correction
is to let the precise item do the precise work: **`#703` `keep`** (one call site, shippable),
**`#491` `rescope`** to its still-live residual — receipts durability plus the
`attemptRunId` join key — noting review-records are delegated to `#703`.

These two also have an intersecting write-set, which under the planned flow invariants means
they should not be co-scheduled.

## 6. Limb (c): a closed cohort, not an ongoing defect

Body length across the 135 active items is sharply **bimodal**, not a gradient: median 1673
characters, but **16 items carry a body of exactly `Scope: S` or `Scope: M`** — the entire
specification is the title. Next-shortest body after those 16 is 159 characters.

The decisive fact is the date range. All 16 were filed **2026-08-03 to 2026-08-18, and none
since**; every item filed after 08-18 carries a structured `## Outcome` / `## Acceptance
evidence` / `## Constraints` body. **This was a filing-mode era that has already ended.**
The disposition is therefore *not* a process fix — the process already corrected itself —
and most of these titles are dense enough to stand alone (`#524`, `#527`, `#551`, `#555`
each name the mechanism and the call site in the title). They are legacy residue, and they
are being worked: 8 of the 16 have been touched since filing.

Only one of the 16 is genuinely spent (§7, `#558`).

## 7. Proposed dispositions

Five rows. Everything not listed is **`keep`** — 130 of 135 active items, plus the 60
`deferred` which were out of scope and read only where an active item appeared to duplicate
one.

| Item | Disposition | Reason | Evidence |
| --- | --- | --- | --- |
| #558 | `close:completed` | The correction it asks for is already in the tree; body is title-only, so nothing else is being closed with it | `AGENTS.md:42` ("Bubblewrap PID + mount namespace… do not conflate it with Landlock"); `docs/trust/sandboxing.md:13,26`, `overview.md:24`, `threat-model.md:36,56` |
| #491 | `rescope` | Overlaps #703 on review-record durability; residual is receipts + the `attemptRunId` join key | `execution-receipt.ts:164` worktree-relative (live); `pipeline.ts:1812` (delegated to #703); §5 |
| #703 | `keep` | Narrow, verified live, one call site — the actionable half of the #491 overlap | `pipeline.ts:1812` `writeReviewRecord(worktree!, …)` |
| #521 | `rescope` | Two-part item, one part done: **0 unlabelled open issues remain**. The registry collision is live | Corpus scan: every open issue carries ≥1 label. `TC-017`/`TC-018` are live trust-registry ids (`docs/trust/egress.md:18,34`, `sandboxing.md:13,26`) colliding with the titles of #154/#155 |
| #154, #155 | **no vocabulary fits — see §8** | Correct items, but unreachable: they lack the `autopilot` pickup label | The only 2 of 195 open issues without `autopilot`; `.pelaggio.yml` sets `roadmap.github.label: autopilot` |

### Arithmetic for guard 2 (net-non-increasing)

```
open before          195   (135 active + 60 deferred)
  close:completed     −1   (#558)
  new items            0   (no split, no hoist proposed)
open after           194
                  net −1   ✔ non-increasing
```

No 1→many move is proposed, so no closure needs to pay for one.

## 8. A finding about the vocabulary, not a new verb

`#154` and `#155` fit none of the six permitted dispositions. They are not `keep` (a `keep`
implies the item is workable as it stands; these cannot be picked at all), not
`close:*` (the work is wanted — TC-017 is a protected-path lock, TC-018 is per-step
capability profiles), not `defer` (that is a *deliberate* park with a revisit trigger; this
is an accident of labelling), not `merge-into`, and not `rescope` — because **nothing about
their bodies is wrong. Their metadata is.**

The gap: the vocabulary has verbs for *content* dispositions and no verb for a *metadata*
disposition. Something like `relabel` is the obvious shape. Per the brief this is reported
rather than coined — it belongs to **#519**, which owns the typed-disposition vocabulary,
and it is a second independent falsifier of the kind #660's A-1 fired.

The underlying condition is worth the operator's attention regardless of the verb: two
items have been invisible to `roadmap next` since 2026-07-09 (52 days) and neither the
backlog count nor the age histogram shows it, because both instruments count issues, not
reachable issues.

## 9. What this pass could not determine

- **Which items burned cycles.** Out of scope by construction: cycle logs and gate records
  live in `.dev/` on the operator's host and the control-plane daemon is tailnet-only.
  Nothing here infers cost from issue text, and **no conclusion is drawn from the absence
  of this data** — in particular, "no collapse warranted" is a claim about duplication and
  staleness, *not* a claim that the backlog is cheap.
- **Whether an item is worth doing.** Every disposition above is about redundancy,
  reachability, or spentness. Value and priority are operator judgment and were not touched;
  no item was proposed for closure on the ground that it seemed unimportant.
- **Whether `in-progress` items are progressing.** `#42`, `#574`, `#647`, `#668` carry the
  label; without cycle logs, liveness is unobservable from here.
- **The 60 `deferred` items.** Read only where an active item appeared to duplicate one, per
  scope. Their revisit triggers were **not** audited — `throughput-economy.md` warns
  `deferred` is a park and not a graveyard, and testing that for this cohort is a separate
  pass.
- **Bodies of the 130 `keep` items.** Method was titles-and-labels first, bodies only for
  cluster candidates and closure candidates (~35 bodies read of 135). A body-level overlap
  between two items that share no title tokens and neither of which was a cluster candidate
  would have been missed — §2.2 shows that class is real.

## 10. Consumer and end state

**Consumer:** the operator, as step 3 of `#624` ("adjudicate before creating work"). No
agent consumes this document and no harness reads it; it has no authority and is cited by
no gate.

**Done when** each of the five rows in §7 has been applied or explicitly rejected, and the
three method findings are carried to the items that own them:

1. §2.2 → **#531** — a title-tier duplicate detector would miss this backlog's only real duplicate.
2. §2.3 → **#530** — prospective-path citations are ~86% of the detector's raw output; it needs a tense signal.
3. §8 → **#519** — the closure vocabulary has no metadata disposition.

**Then this document is spent.** It is a dated snapshot against a frozen corpus, not a
living register — §0's fingerprints exist so a future reader can tell that it has expired
rather than trusting it. If a second pass is wanted, the honest trigger is not a calendar
date but §4's rule: **when a seventh instance of the credential-reachability class is
filed.** Re-running this same pass on a backlog whose two mechanical detectors both return
zero would produce the bookkeeping-without-decision-value that `#624` names as the signal
to stop.
