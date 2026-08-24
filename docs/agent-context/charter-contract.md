# The charter contract: acceptance anchors, assumption ledger, and the reframe gate

Status: design exploration, pre-decision (candidate ADR). Verified against the tree at
`ca08faf`. Companion evidence: `guarded-actions.md` (§6 invariant, decision-log precedent),
[ADR-0011](../decisions/0011-andon-not-dor.md) (the seam this design completes),
[ADR-0024](../decisions/0024-adversarial-authoring-review-loop.md) (the loop it gives an
exit to).

## 0. The contract on one page

A **charter** is the human's statement of intent that machine work executes against.
The contract holds it to three disciplines and nothing more: everything it demands is
**anchored** (a stable ID a finding can cite), everything anchored is **checkable** (a
named verification), and everything it presumes is **falsifiable** (a named `wrong-if`).
The machine executes the charter, may extend it additively, and may never bend it.

The tenets — each expanded in one section below, in the AGENTS.md invariant idiom so
they can graduate to that index as their slices ship:

1. **The charter is the only human-owned artifact in the loop** (§6). Handoffs exist
   only at charter boundaries — an edit at intake, a packet at adjudication — and
   immutability binds machines, never the owner.
2. **Anchored, bound, falsifiable — never linguistically policed** (§3). `AC-n` +
   `verify:`, `A-n` + `wrong-if:`; template shape is a lint. The anchors are the
   contract; the prose is the human's.
3. **Andon, not DoR** (§3, ADR-0011). Structure is drafted as work, additively, never
   demanded at intake; the queue never waits on a human.
4. **Charter text is untrusted input** (§3, ADR-0002). A charter is data; execution
   reaches only harness-owned registry ids, never charter-supplied commands.
5. **Broken frames escape through a typed route, not revision grinding** (§4–§5). A
   reproduced `charter-defect` — anchor-identity reproduction, or a deterministic
   non-convergence trigger — parks to one adjudication packet: evidence, candidate
   reframes, recommended default, one command.
6. **Reframing is supersede, never mutation** (§5). A frame change under a live claim
   is a new item; the old closes superseded; provenance stays whole.
7. **Decomposition is recursive and fenced** (§7). Children are ordinary items; fences
   convert sprawl into adjudication; lineage state is a projection, never stored.

Sections 1–11 are the evidence base and per-slice design depth behind these seven
lines — four provider-diverse review passes deep, and deliberately *heavier* than the
decision itself. Each §10 slice re-enters the pipeline's own plan + shakedown gates
when built, so the depth below is input to those gates, not a contract frozen here.

## 1. The complaint, stated precisely

A human-described need enters the system as free prose plus a keyword-inferred scope
(`/charter`'s trigger table). Every downstream gate then reviews an artifact against its
*upstream* artifact — code against plan, plan against charter — and no gate anywhere
evaluates the charter itself. When the charter carries a broken framing assumption, the
system has no vocabulary to say so and no route to act on it:

- The defect manifests as **non-convergence**: findings that revision cannot close because
  the disagreement is about the frame, not the diff. Each re-review pass is an
  operator-observed ~$40–80; the review loop's convergence rule (fingerprint survival,
  omission ≠ refutation) is working exactly as designed and cannot help, because the
  finding is *true* — the artifact really doesn't satisfy a charter that cannot be
  satisfied as framed.
- The escape today is out-of-band operator judgment. The operator playbook already knows
  the moves — "a non-converging series means re-scope, not re-review"; "when gate findings
  contain a design decision, split the decision out as its own charter" — but both are
  tribal procedure, invoked after spend, with no deterministic trigger and no typed
  artifact to adjudicate.
- ADR-0011 committed to the right seam and left it unbuilt: *"the `blocked` marker
  sentinel exists today; the typed payload, the cross-seat retry, and the set-status
  write-back are the seam this ADR commits to completing."* Its consequences section
  predicted this design: *"Block reasons become telemetry on where chartering is weak —
  feedback into charter, not a gate."*

The gap is therefore not a missing review mechanism (ADR-0024 has plenty) and must not be
a new intake gate (ADR-0011 explicitly rejects DoR). It is a missing **contract**: the
charter has no machine-addressable anchors for a finding to point at, so "this assumption
is wrong" is inexpressible, unroutable, and unadjudicable.

## 2. What already exists (compose, don't invent)

| Piece | Where | State |
|---|---|---|
| Produce-or-escalate, `blocked` subtype, decorrelated retry | ADR-0011 | decided; typed payload unbuilt |
| Escalation adjudication defaults (retry → reproduce → human) | `supervised-run.md` | operating procedure |
| `deferred-item:` markers, harness-created follow-ups (#115) | `pipeline.ts` at plan **and** shakedown-code time | built |
| Reserved effect vocabulary for review-time deferral | `shakedown.deferredItems` manifest kind | reserved, fail-closed, no handler |
| Per-item decision log, agent-denied, evidence-bound | `docs/decision-log/<itemId>.md` | built (reviewer-split escalation) |
| Absorbing-state invariant (clearing transition + actor) | guarded-actions §6 / ADR-0026 | decided |
| Evidence-not-class emission, harness-owned classification | #293 / ADR-0016 | built for severity |
| Supersede vocabulary understood by staleness quarantine | `superseded-marker` heuristic (#217) | built |
| Declared write-sets as an independence predicate | flow invariants (planned) | design |

Everything below is wiring between these. The two genuinely new nouns are the **charter
anchor** (`AC-n` / `A-n`) and the **`charter-defect` blocked kind**.

## 3. The charter contract (the grammar)

A charter gains two structured blocks, living where the charter lives (item body for
github-issues / linear / beads; for markdown roadmaps, a `charter-path` file resolved by
the adapter exactly as `plan-path` is):

```markdown
## Acceptance
- AC-1: When <trigger>, <system> shall <response>. verify: test:<path>::<name>
- AC-2: While <state>, <system> shall <response>. verify: check:<registered-check-id>
- AC-3: <Given/When/Then form is equally valid>. verify: obs:<observable a reviewer attests>

## Assumes
- A-1: <assumption the framing rests on>. wrong-if: <observable that falsifies it>
```

**What the parser enforces (deterministic, harness-owned):** IDs are unique and
monotonic; every `AC-` entry carries exactly one `verify:` binding of a known type; every
`A-` entry carries a `wrong-if:`. **What it does not enforce:** template conformance
(EARS/GWT shape) is a lint *warning*, never a gate. Be honest about where the leverage
is — the deterministic value of the grammar is **anchors** (stable IDs findings can
reference), **bindings** (each criterion names its check), and **falsifiability** (each
assumption names its own refutation), not linguistics. Borrow EARS/Given-When-Then as
drafting templates because they reliably produce single-behavior, testable sentences;
do not build a shall-statement parser.

**Binding types, and the execution boundary (ADR-0002 governs).** Charter bodies are
untrusted text — issue bodies can be authored or edited by parties outside the trust
boundary, and `/charter` drafts land under ratify-by-exception, so **nothing in a charter
is ever shell-interpreted**. The three binding types are sized accordingly: `test:` names
a test the recorded run must contain green; `check:` names an id in a closed, repo-config
registry (`charter.checks` in `.pelaggio.yml` — argv-form commands the *harness* owns,
resolved by id, never concatenated with charter text, executed inside the same
containment every step already runs under); `obs:` is a reviewer-attested observable and
executes nothing. A `verify:` value that is not one of these three shapes fails the
parse. Because execution can only ever reach registry ids, a drafted-and-unvetoed
charter cannot introduce a new executable — veto-by-silence gates *content*, never
*capability*.

**Not a DoR gate — ADR-0011 governs.** Absence of the blocks never blocks `pick` and
never stalls the queue. Produce-or-escalate applies to the contract itself: when `plan`
finds an M+ item without contract blocks, drafting them from the prose charter is its
first deliverable — drafted **inside the plan document** (a machine artifact the step
already owns and may write), defaults chosen via the existing `DECISION:` sentinel
idiom. The harness then publishes the drafted blocks to the charter through a new typed
manifest kind, **`charter.publishContract`** (fail-closed schema, same seam and timing
discipline as `plan.publish`, which publishes the *plan* artifact and is not overloaded
for this). Its handler calls a new typed adapter surface,
**`RoadmapSource.publishContract(id, blocks)`** — github-issues appends the sections to
the item body, markdown writes the `charter-path` file, linear/beads analogous. No
adapter exposes an item-body write today, so this surface is named slice-1 work, for the
same reason §5 names `supersedeItem` rather than assuming a close primitive exists. S/XS items (the
`isQuickScope` path) are exempt end-to-end — a typo fix does not need an assumption
ledger, and gate sizing follows reversibility (ADR-0013).

**Immutability binds machines, not the owner.** While a claim exists, charter blocks
are read-only **to agents and the harness** — the same shape as the plan-polish guard,
for the same reason: the cycle executes the charter; it does not bend the charter to
fit the diff. The one machine write permitted is the `charter.publishContract`
publication above, and it is **additive-only**: it may fill absent contract sections,
never alter or delete an existing anchor — the handler rejects a publication whose
result does not preserve every pre-existing anchor line verbatim. The **human is not
bound**: the charter is their artifact, and a human edit is legal at any time,
taking effect at the next step-start parse (a running step finishes against its
snapshot). This is also the whole veto mechanic, and it needs no ratification marker:
a human who rejects machine-published scaffolding edits or deletes it; deleted
sections make the item "without contract blocks" again, so the next plan entry
re-drafts honoring whatever the human left behind. Re-draft vs supersede therefore
needs no persisted ratification state to disambiguate — **re-draft** is triggered
mechanically by absent sections, **supersede** (§5) is triggered only by the reframe
gate's adjudication, and "ratified" remains a social fact with no load-bearing
mechanical role. Frame changes mid-cycle route through supersede, never through a
machine edit. A human who edits *anchors* mid-claim is exercising ownership, and the
consequence is deterministic, not left to judgment: the plan records the anchor set it
was written against, and a step-start parse that detects an anchor delta versus that
snapshot **routes the cycle back through `plan`** — one more cheap re-plan under
ADR-0013 — so `implement` never executes, and provenance never records, against
acceptance criteria the plan never addressed.

## 4. The reframe gate

A new blocked kind, `charter-defect`, riding the ADR-0011 seam. Typed payload:

```
{ kind: "charter-defect",
  anchor: "A-2" | "AC-3" | "scope",          // must resolve, see below
  evidence: <what was observed>,              // the wrong-if trigger, or the un-satisfiable pair
  proposals?: [<candidate reframings, recommended default first>] }
```

- **Anchor resolution is the deterministic admission check.** A model-emitted payload
  must name a concrete `A-n`/`AC-n` that resolves against the parsed charter; a payload
  whose anchor does not resolve — including a model-emitted `scope` — is demoted to an
  ordinary `blocked` and never reaches the reframe route. The literal `scope` anchor is
  **reserved for harness-synthesized packets** (the non-convergence backstop below and
  the §7 fence trips), whose triggers are deterministic observations, not allegations.
  The division of labor echoes #293 — the model supplies evidence, the harness performs
  the deterministic check — but be precise about what this is: the routing authority is
  ADR-0011 blocked-admission with an anchor-resolution predicate, not the ADR-0016
  classification table, and `charter-defect` never enters severity classification at
  all.
- **The honesty gate is ADR-0011's decorrelated retry, with a deterministic match
  predicate.** One fresh attempt on a different seat/provider where available.
  **"Reproduced" is anchor identity, nothing softer:** the independent attempt emits
  `charter-defect` resolving to the *same anchor*. Free-text evidence is never
  string-matched, similarity-scored, or judged — two seats independently pointing at
  `A-2` is the whole predicate. Reproduced → escalate to §5. Not reproduced *and the
  retry proceeded* → resume; the allegation dies (the git `feat/<id>` claim is
  untouched — the cycle continues on it) and the signal is retained as chartering
  telemetry. **Divergent blocks are still two blocks:** when the retry emits
  `charter-defect` on a *different* resolving anchor, no anchor reproduced but ADR-0011's
  second-reproduced-block rule still applies — the item blocked twice independently, so
  the packet escalates carrying **both** allegations, marked `divergent-unreproduced`
  (weaker per-anchor evidence, same honest labelling as `correlated-unverified`); there
  is no "resume" dead-end in which both attempts are blocked yet nothing escalates. **Where no alternate provider
  is configured**, ADR-0011's own carve-out applies: a same-seat retry is correlated and
  proves little, so the packet escalates on the first emission instead, marked
  `correlated-unverified` — the human sees the weaker evidence status rather than the
  system burning a retry that cannot strengthen it. Reproducibility replaces evidence
  adjudication precisely because it is deterministic and un-gameable — this is also the
  complete answer to the lazy-escape hazard (an agent crying "bad charter" to dodge
  work): the cry costs a reproduction attempt and dies if unreproduced. No new
  entitlement token is needed. Harness-synthesized packets skip the retry entirely —
  a deterministic trigger has nothing to reproduce.
- **Emission windows — and the pre-contract boundary.** The reframe gate presupposes a
  **published** contract: anchors acquire identity at publication, so `charter-defect`
  is emittable from any window of an item whose contract blocks exist — the sole
  mechanical key is **published** (blocks present in the charter, whether
  human-authored or `charter.publishContract`-dispatched; ratification has no
  mechanical role here or anywhere, §3). That includes `plan` re-entries after a first
  publication, `implement`, and the authoring/review loops. §7 children are **not**
  born with contracts — today's `deferred-item` markers carry only title/scope/deps
  and `createItem` writes no contract body — so a child starts pre-contract like any
  prose item and gains anchors through its own plan step's draft-if-missing (slice 4
  may optionally let the marker carry drafted `acceptance` entries, an option not a
  dependency). An item still in its pre-contract state —
  the first plan pass of a prose intake, before `charter.publishContract` has
  dispatched — routes spec defects through **ordinary ADR-0011 `blocked`**, which
  already escalates to a human on that ADR's terms. This is scoping, not a gap: with no
  published anchors there is nothing deterministic to point at, two seats'
  independently-drafted `A-2`s need not denote the same statement, and a blocked plan
  step exits before its effects (publication included) ever dispatch — so the packet
  machinery could add nothing but ambiguity there, and the human is already the next
  hop for an under-specified prose item. Skill bodies get one added sentence per
  window: *if you cannot proceed because a specific published `A-n`/`AC-n` is false or
  unsatisfiable, emit `blocked` with kind `charter-defect` naming it; do not polish
  around it.*
- **The synthesized backstop (fires when no model names the assumption).** On the
  red-gate non-convergence exits — revise-loop exhaustion, breaker trips — the harness
  checks one deterministic predicate: *does any surviving ≥-bar fingerprint predate K
  revise passes that each touched its cited paths?* If yes, it synthesizes a
  `charter-defect` packet with `anchor: "scope"` listing those fingerprints. This is the
  gate the complaint asks for: the escape fires on the *shape* of non-convergence, with
  no judgment in the trigger. K is config (`charter.reframe-after-passes`, default 2 —
  matching the supervised-run default of one deliberate repeat then park).
- **Severity is untouched.** `charter-defect` is a parallel channel, never a
  reclassification: a safety-class finding retains its hard-block park regardless of any
  reframe claim (fingerprint retention already guarantees survival; omission ≠
  refutation). A reframe can therefore never launder a real defect — worst case it adds a
  human packet on top of a park that was already happening.

## 5. Lifecycle and adjudication

The item lifecycle gains one absorbing-without-progress state, compliant with the
guarded-actions §6 invariant:

> `charter-blocked(anchor)` — clearing transition **`re-charter`**, actor **`human`**.

- **The packet** goes to `docs/decision-log/<itemId>.md` — the existing agent-denied,
  evidence-bound escalation path — containing: the anchor and its charter text, both
  attempts' evidence (seat identities, reproduced observation), spend so far, the
  candidate reframings with a recommended default, and the paste-ready resolution
  command. Notification reuses the existing best-effort `decision` channel; notification
  failure never changes the gate (the reviewer-split precedent).
- **Resolution is one human act:** accept a candidate (or edit one). The harness then
  executes **supersede** — and supersede is a guarded action, specified against the
  ADR-0026 fence-or-reconcile rule rather than left as a hopeful three-step script:
  - *Typed adapter surface (no free-form tracker mutations).* `RoadmapSource` gains
    `supersedeItem(oldId, newId, reason)`, owning the **tracker side** of release: close
    of the old item carrying the superseded-marker vocabulary the staleness quarantine
    already recognizes, plus the claim-label release that today requires a raw
    `gh issue edit` (the four-act release's unsanctioned act 4). The **git side** —
    worktree removal and `feat/<id>` branch deletion — stays harness-owned and is a
    separate, later step (see Ordering). Neither harness nor agents ever issue
    free-form tracker writes; §9's rule applies to this design's own executor first.
    A failed close is retried by the executor against its own positive check; be honest
    about the window — until the close lands, the old item stays pickable, and the #217
    `superseded-marker` heuristic does **not** cover it (`stale-scan.ts` requires the
    referenced sibling to be *done*, and the reframed item is newly created and open).
    If field data shows the window matters, the cheap hardening is an open-reframe
    stale-scan variant keyed on the embedded supersede key — an option, not an assumed
    protection.
  - *Fence, not a pre-check.* A lookup-then-create bracket would be exactly the
    §2.1-of-guarded-actions check-not-hold defect — two executors both observe absence
    and both create. The executor therefore follows the review-request-queue template
    (the repo's one real reconciler contract — "the shape is the template, not the
    implementation," and specifically **not** its fixed-TTL leases): entry is an
    **O_EXCL claim record** keyed by **`oldItemId` alone** — an item is superseded at
    most once, and keying by packet bytes would mint a second reframe whenever
    ADR-0019 resume or evidence-text drift changes the hash; the packet's sha256 is
    recorded *inside* the record for audit, never as key material. Atomic create wins;
    a loser reads the record and adopts. The key is also embedded in the created
    item's body, which is what makes the crash window repairable by **positive
    terminal check**: a re-entrant first searches for an item carrying the key
    (found → adopt and fill the record; absent → create). **Reclaim requires a negative P6 liveness verdict on the
    holder — expiry is only the trigger to check, never the authorization** (ADR-0026:
    a slow-but-alive original and its reclaimer must not both create). Two placement
    requirements, not residuals: the register joins the **agent-denied set** on the
    same footing as session records and the attempt-identity register (P4 property 2 —
    an O_EXCL file in generic `.dev/` has atomicity but no authority; per #482 §K3 it
    inherits protection from the authority-profile work), and cross-host resolution of
    one packet remains out of scope.
  - *Inert until release completes — not merely until the tracker close.* `deps:
    [oldId]` alone would leak a window: the dependency satisfies the moment
    `supersedeItem` closes the old item, while the git-side claim (worktree, `feat/`
    branches) is deliberately released later — a parallel picker could claim the
    reframe with the old claim's remains still live. So the reframe is created with
    the mechanism the deferred-item path already ships: **`deferred: true`** (excluded
    from automatic pickup by FlowPolicy) plus `deps: [oldId]`, and the executor's
    **final act — after** the liveness-gated git release — is the typed, item-scoped
    activation write that clears the deferral. Eligibility therefore begins only when
    nothing of the old frame remains claimable, by existing primitives end to end.
  - *Ordering.* Claim record → `createItem` with `deferred: true` + `deps: [oldId]`
    (or adopt-by-key) → record `newId` → `supersedeItem(old, new)` (tracker close +
    label release) → git-side claim release → **activation write last of all**. The git side is destructive (worktree removal,
    local and remote `feat/<id>` deletion), so the recorded close is a necessary but
    not sufficient gate: release additionally requires the **P6 liveness verdict** that
    #461 scopes for every destructive reap — record state alone never authorizes
    deletion. Every step is retryable against its own positive check; no step's
    success is inferred from another's.

  The next cycle picks up the reframed item cold — checkpoint-restart, not replay
  (ADR-0019).
- **Supersede, never mid-cycle mutation.** A reframed charter is a new item because the
  old attempt's artifacts, receipts, and review records were produced against the old
  frame; attempt identity (P4) and provenance stay honest, and nothing has to reconcile
  a charter that changed under a live claim.
- **Tolerance posture:** re-charter is human-only by default. ADR-0015 leaves room for a
  configured auto-accept of the recommended default in the judgment band; that is a
  policy knob for later, and it must never apply when the packet's evidence includes a
  safety-class finding.

## 6. The human surface (handoff points, and why back-and-forth strictly decreases)

Proposed invariant, the ownership rule everything above serves:

> **The charter is the only human-owned artifact in the loop. Plans, diffs, findings,
> and review records are machine-owned. Human↔machine handoff happens only at charter
> boundaries — intake, ratify-by-exception, and re-charter adjudication — and every
> handoff artifact carries a recommended default plus a paste-ready command.**

Exactly two handoff artifacts, both asynchronous, both single-decision:

1. **The charter at intake.** `/charter` (or plan, for items that arrive as prose) drafts
   the structured blocks; defaults are chosen and flagged with `DECISION:` sentinels;
   the human **vetoes rather than approves** — silence lets the queue run (ADR-0011).
   The veto is always the same act, because immutability binds machines and never the
   owner (§3): the human edits or deletes the blocks whenever they object, pre-claim or
   mid-claim, effective at the next step-start parse. Deleting machine-drafted
   scaffolding re-triggers draft-if-missing on the next plan entry — one cheap re-plan,
   the ADR-0013 posture — while a reframe of work already produced routes through the
   §5 supersede path. Zero synchronous steps added either way.
2. **The adjudication packet.** Arrives only after independent reproduction, batched in
   the decision log, one decision per packet, answerable in one command.

The minimization argument is structural, not aspirational: today each red re-review pass
in a non-converging series *is* a human handoff — un-typed, unbatched, ~$40–80 each, with
the operator reverse-engineering "is this a frame problem?" from raw findings. The design
adds **no** synchronous gate anywhere and converts that open-ended series into: K bounded
passes → reproduction → one packet. Back-and-forth per broken-assumption incident goes
from unbounded to at most one round trip, and chartering quality gets a telemetry stream
(which anchors break, at which step) instead of anecdotes.

## 7. Recursive decomposition, fenced

Recursion is the intended mechanism, not a workaround — and most of it exists:

- **Activation is slice-4 work, not an inherited freebie.** The shipped path creates
  children `deferred: true`, labelled not-eligible-for-pickup and excluded by
  FlowPolicy — today a human must promote each child, so any "runs unattended" claim
  is false until that changes. Slice 4 therefore includes the **activation seam**: a
  deferred lineage child whose `deps` are all terminal becomes eligible, computed —
  ADR-0012's readiness posture, and the exact shape of the beads `ready` primitive the
  repo already plans to ride. Deferral stays the conservative default for non-lineage
  deferred items.
- **Emission windows.** Plan-time and shakedown-time `deferred-item:` markers are built
  (#115). Add implement-time emission through the effects-manifest seam (an
  `implement.deferredItems` kind beside the reserved `shakedown.deferredItems`
  vocabulary, fail-closed schema, handler creates items) — an implement step that
  discovers under-scoping narrows to the honest slice and defers the rest, rather than
  sprawling or grinding.
- **Lineage.** Children carry `(rootId, depth)`. Two harness-enforced fences:
  `decompose.max-depth` (default 2) and `decompose.max-lineage-items` (default 12).
  Crossing a fence converts the emission to a **harness-synthesized** `charter-defect`
  packet with `anchor: "scope"` — the fence trip is a deterministic observation, so per
  §4 no reproduction retry applies. Nothing is dropped: the over-fence `deferred-item`
  markers are **withheld from creation and preserved verbatim in the packet**, so the
  human adjudicates the whole proposed tree — because a lineage that wants to be a tree
  is the charter telling us it was an epic, and that is the human's call.
- **Acceptance conjunction.** A child may cite `covers: AC-3(parent)`. The harness check
  is arithmetic only, and it counts **two** sources of cover: the parent's own §8
  criteria table (the honest slice the parent itself shipped verifies its own anchors
  directly) and shipped children's `covers:` citations. The *mapping* is authored
  (policy); the *coverage arithmetic and existence checks* are mechanism. **No new item
  state exists anywhere in this.** The parent ships and closes exactly as today —
  `markDone` in its own ship tail, unchanged `ItemStatus`, unchanged pick mapping.
  "Lineage open" is a **projection**, computed from live items carrying the `rootId` —
  the same discipline as "an initiative is a projected swimlane, never a
  pelaggio-owned object." The conjunction runs at two moments with two jobs:
  - *Prevention, pre-merge.* When a candidate's ship would close the lineage, the §8
    criteria-coverage lens at that child's review gate evaluates **lineage** coverage
    (parent table + shipped siblings + the candidate). An uncovered remainder is a
    must-fix finding through the existing channel — so in the ordinary serial case the
    gap **blocks before the irreversible merge**, and the thing withheld is that
    child's merge. This is what makes §8's "uncovered `AC` blocks at ship time" true
    at the lineage level, through the same no-new-gate mechanism.
  - *Reconciliation, post-close.* A bare "was I the last open item?" observation is a
    check-not-hold — two concurrently-closing children can each see the other open and
    neither fires. The deterministic backstop therefore runs in ship-tail bookkeeping
    **under the roadmap mutation lock that already serializes `markDone`**: exactly one
    closer observes the projection's transition to all-terminal and, if no coverage
    verdict is recorded, runs the conjunction. An uncovered remainder here produces
    the **`coverage-gap(AC-list)` adjudication packet** — honestly post-hoc in this
    corner (the merges have landed; what the open packet withholds is lineage
    completion in the projection and flow metrics, plus the anchors' standing), which
    is the §6-invariant artifact with clearing transition **`waive | re-charter`**
    (waive the listed anchors, or charter a covering child), actor **`human`**.

  A successful decomposition — every anchor covered by the parent's slice or a shipped
  child — passes both moments with **no human touch at all**, preserving §6's handoff
  economy, without any item-lifecycle surface changing. A **waiver is
  not a mid-cycle mutation** and does not collide with supersede-only: at lineage
  close-out no live claim exists anywhere in the lineage, so no attempt's artifacts can
  be contaminated by the amendment; the waived anchor is retained, marked
  `waived(packet-ref)` — never deleted — and the decision-log packet is its provenance.
  Supersede governs frame changes while a claim is live; waiver is the charter owner's
  recorded close-out amendment when none is.
- **Independence is checkable, later.** INVEST's "independent" stops being judgment once
  declared write-sets land (flow, planned): two children whose declared write-sets
  intersect are not independent, by the same predicate the scheduler already plans to
  use for co-scheduling. Decomposition quality inherits a deterministic test for free.

## 8. Verification binding at ship time

The provenance record (ADR-0024's structured review record) gains a criteria table:
each `AC` → its `verify:` binding → status, with the record explicit about *how* each
status was obtained.

- `test:` status comes from a **structured test-evidence receipt**, not from prose:
  per-test identity + outcome bound to the run's SHA. Today's step and review records
  retain no per-test identity, so this producer is real work, owned by slice 2 — the
  table cannot be described as a pure record addition without it.
- `check:` bindings resolve through the `charter.checks` registry (§3) — charter text
  supplies only the id, never argv — and execute in a **detached, data-only checkout of
  the reviewed SHA** (the #269 cold-seat precedent), never the live claim worktree.
  Mutation detection is the full #269 bracket, not porcelain alone: a **HEAD
  `rev-parse` compare** around execution *and* a clean post-execution porcelain — a
  check that commits is porcelain-clean but has moved HEAD, and exit 0 from a tree
  that no longer is the reviewed SHA verifies nothing. Either delta records the row
  `invalid`, never a pass. Execution is additionally **fail-closed on confinement**:
  ADR-0023's jail is not wired to ordinary steps today, so the runner executes a
  registered check only under an available isolation wrapper (the seat-spawn
  precedent) and records `invalid` where none is — an empty registry keeps the slice
  shippable while that precondition and the §11 registry-authority question are
  settled.
- `obs:` bindings are reviewer-attested and execute nothing.

The table marks each row `executed` (test/check) or `attested` (obs), so the record
never implies a stronger verification tier than actually ran — the same honesty
discipline the review-loop provenance applies to "reviewed by K models."

**Coverage's blocking authority, stated precisely so slice 2 stays gate-neutral:** the
criteria *table* is provenance only. An uncovered `AC` blocks by being raised as an
ordinary must-fix finding **through the existing reviewer findings channel** — a
criteria-coverage lens instruction to reviewer seats, adjudicated by the existing
`pr-review` contract like any other finding. No new deterministic gate, gate class, or
blocking edge is introduced; a harness-*emitted* completeness finding (deterministic
uncovered-anchor arithmetic feeding the same channel) is optional later hardening,
noted so an implementer does not smuggle it into slice 2. Honest residual: the binding is authored, so a trivial test can nominally satisfy
a criterion; the mitigation is a criteria-coverage reviewer lens plus Judge materiality,
and the residual should be stated in the record rather than laundered — the same
discipline the provenance section of the review-loop design applies to "reviewed by K
models."

## 9. What this subsumes, and non-goals

- **Completes** ADR-0011's committed seam (typed `blocked` payload, cross-seat retry
  routing, write-back), and realizes its telemetry consequence.
- **Gives ADR-0024's loop an exit** it currently lacks; touches none of its convergence
  mechanics, severity taxonomy, or safety floor.
- **Extends #115** to implement time and fences it; builds the reserved
  `shakedown.deferredItems` handler shape.
- **Non-goals:** no Definition-of-Ready intake gate (ADR-0011 governs); no
  natural-language validation of charter prose; no auto-re-charter without a human in the
  default posture; no new claims registry, locks, or free-form tracker mutations —
  supersede is typed `create-item` + close via the adapter.

If most of the non-convergence incident class does not route through §4/§5, this is the
wrong model — the same falsifiability bar guarded-actions §9 sets for itself.

## 10. Sequencing (each slice independently valuable)

1. **Grammar + parser + drafting.** `/charter` and plan-time draft-if-missing with the
   `charter.publishContract` manifest kind, its additive-only handler, and the
   `RoadmapSource.publishContract` adapter surface; the `charter.checks` registry
   schema (may ship empty). Lint-only — anchors exist and reviewers can start citing
   them immediately. No routing yet.
2. **Anchored review lens + criteria table in provenance** (§8), including the
   test-evidence receipt producer and the detached-checkout `check:` runner. Additive
   to the record — no gate changes — but not free: the evidence producers are the bulk
   of this slice.
3. **`charter-defect` kind + decorrelated-retry route + adjudication packet + supersede
   executor** (§4–§5), including `RoadmapSource.supersedeItem` and the executor's
   fence/reconcile bracket. The gate itself. Requires slice 1 only.
4. **Implement-time deferred-items + the lineage activation seam + lineage fences** (§7).
5. **The synthesized non-convergence backstop** (§4, last bullet) — after slice 3 has
   field evidence to calibrate K.

## 11. Open questions

1. Should `A-n` assumptions be inheritable down a lineage by reference, so one broken
   anchor can park siblings that share it — or is cross-item parking an over-coupling
   that the adjudication packet should merely *suggest*?
2. Does the `charter.checks` registry belong in ordinary `.pelaggio.yml` config, or does
   adding a check id deserve the same owner-signed discipline ADR-0016 applies to
   taxonomy contractions? Repo config is agent-editable in a PR, so a registry entry is
   only as trustworthy as the review that lands it — the merge gate reviews the diff,
   which may be enough, but the boundary should be decided, not assumed.
3. Where exactly does the markdown adapter's `charter-path` live — `docs/charters/<id>.md`
   committed like plans, or `.dev/` like gh/linear plan mirrors?
4. What is the strongest argument for building none of this? Candidate: ADR-0011's bet
   that blocks are rare and cheap re-plans absorb most spec defects — if the
   non-convergence incident rate is genuinely low, slices 3–5 may not pay for themselves,
   and slice 1–2's anchors alone (better findings, better telemetry) may be the whole
   value. The cycle log can answer this before slice 3 is built. §12 develops this into
   the full counter-case.

## 12. The counter-case: where this fights the goals

Recorded with the same seriousness as the proposal, because most of it is measurable
before most of it is built.

- **Guard accretion, re-enacted.** `guarded-actions.md` §1's complaint is that bespoke
  guards multiply faster than hazards shrink. This design adds ~ten mechanisms (parser,
  publication handler + adapter surface, checks registry + jailed runner, blocked kind +
  retry routing, packets, supersede executor + register + liveness + reconciler,
  activation seam, lineage projection + two-moment coverage, anchor-delta re-plan,
  test-evidence receipts) against a failure mode whose frequency is **unmeasured**. The
  four review passes behind this document are the caution in miniature: every pass found
  real defects *in the new machinery itself*.
- **Supersede churns load-bearing identity.** `deps` satisfaction treats closed as done,
  so a dependent naming the superseded `oldId` activates against work that was reframed,
  not finished — inbound deps must be rewritten to `newId`, and branches, plan paths,
  logs, and receipts all key on ids. This is the sharpest unresolved correctness hole.
- **Correlated reproduction is weaker than it reads.** Anchor-identity is deterministic
  to check, but two same-lineage models agreeing "A-2 is broken" are not independent
  witnesses (the review-loop doc's own MoA point). The honesty gate thins exactly when
  diversity softens — and the correlated fallback then escalates on *first* emission,
  converting speculative frame-doubt into human interrupts precisely when seat diversity
  is already down.
- **The happy path pays for the rare path.** Drafting turns, standing prompt tokens
  (against the #80 context-shrinking goal), reviewer attention on coverage arithmetic
  (zero-sum with bug-finding), a ship-time table — on every M+ item, to serve incidents
  that may be rare. The deterministic layer mostly checks punctuation; binding
  *relevance* remains judgment.
- **A new park class is a new stranded-WIP factory**, and the synthesized backstop
  reverses ADR-0024's decided ship-with-flags bias for ceiling exits.
- **§7 re-implements the Beads direction.** Hierarchy, deps, `ready` are what `bd`
  provides natively (#181); pelaggio-side lineage machinery is migration debt, and the
  build budget competes with the flow-metrics work this repo treats as its actual
  differentiator.

**The inversion that survives:** measure the non-convergence incident rate from the
cycle log first (free, now); ship the typed `blocked` payload + adjudication-packet UX
(completes ADR-0011, no new lifecycle); hold the grammar at lint-only — possibly
requiring anchors only at *escalation* time, where they earn their keep; and defer
supersede + lineage until `bd` lands and the incident data justifies them.

**Measured (2026-08-20, 188 cycles / 90 items / ~$3,595 since 2026-07-14).** The query
was run; the counter-case largely holds, with one precise exception:

- **True frame-grind is rare: one confirmed instance in ~5 weeks.** #548 is the
  textbook case — a charter carrying a contradictory instruction ("keep exactly" vs. a
  loadable branch) plus an ambiguous dominance clause drove the *same* cross-model
  dispute across three review passes (claude blocking on one reading of the spec, grok
  passing on the other, at SHAs a2/a7/a10), 6 review parks, 9 cycles, ~$126. #497/#498
  were underspecification-heavy (5–9 `DECISION` forks each, $174/$118 single-cycle
  escalations) but bounded by Andon. Four `plan needs rethink` exits caught frames
  early at ~$3–4 each — the cheap path working. #279's grind was stale-branch
  conflict-repair mechanics, not frame. One #548 split was an infra false-block (a
  seat self-flagging its own workspace symlinks). Slices 3–5 are **not** justified by
  this rate.
- **The escalation-adjudication *load* is the measured pain: 17 cross-model splits +
  21 review-class parks (11% of all cycles), every split resolved "default-taken:
  Human adjudication required," evidence stored as base64 blobs in decision-log
  comments.** Roughly 3–4 human adjudications/week with illegible evidence. The
  packet UX + typed payload slice attacks precisely this, with no new lifecycle.
- Context for priorities: review spend is 37% of everything (~$1,320); 59% of all
  spend sits in the 21 items that took ≥3 cycles (though the two biggest,
  #557/#511, were legitimately large). The biggest $/shipped-item levers in the data
  are review cost and the conflict-repair failure class — not frame defects.
