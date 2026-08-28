# The delivery packet: claim-scoped provenance, one artifact, many renders

Status: design exploration, pre-decision (candidate ADR). Verified against the tree at
`b050746`. **Review state (2026-08-22):** fifteen provider-diverse `doc-review` passes
deep (records in `.dev/doc-review-records/`). Every architecture-level finding was
closed by revision or re-scope — the passes forced this design's best decisions
(carrying the shipped `ai-delivery` predicate instead of a bespoke schema; gating
direct-push carriage on the ADR-0025 executor; fail-toward-fission identity) — but the
panel's finding floor (~5 mechanics-grade findings per pass) did not converge to zero,
and §12 records the five open pass-15 findings verbatim rather than laundering them.
Like `charter-contract.md`, the mechanism depth here is *input* to the plan + shakedown
gates each slice re-enters when built, not a contract frozen at this document's bar. Companion evidence: `flow-event-catalog.md` (identity vocabulary, the
fat-historical rule), `charter-contract.md` §8 (the criteria table this packet carries
when it ships), `roadmap-and-ship.md` (ship targets, bookkeeping tail, Assisted-by),
[ADR-0018](../decisions/0018-in-toto-attestation-envelope.md) + `docs/ai-delivery/v0.1`
(the attestation layer this design feeds and never duplicates),
[ADR-0025](../decisions/0025-landing-serialization-cas-fence-optional-ordering.md)
(Decision 8's write-back split, which this design stays clear of).

The seam discipline for this document: everything here is pelaggio-owned. A downstream
consumer — a hosted plane, a CI system, an auditor's tooling — may retain, countersign,
anchor, or re-render packets, and this document deliberately knows nothing about any
particular consumer.

## 0. The contract on one page

A **delivery packet** is one delivery's human dossier plus a binding manifest, carried
on the surface where the delivery lands; the machine truth it points at lives in the
records and attestations that already own it.

1. **The unit of delivery is the claim, not the cycle and not the item** (§2). `claimId`
   is already "delivery identity" in the flow-event catalog; the packet is claim-scoped,
   and the identity keys ship first because they cannot be backfilled (§7).
2. **Two artifacts, two jobs — never conflated** (§4.1). The **attestation** is an
   `ai-delivery` v0.1 statement: per-cycle, terminal-outcome, produced by the #186–189
   cluster on that cluster's own timing and subject rules, with ADR-0018's
   (target-state) fail-closed merge semantics. The **carried packet** is a human
   dossier plus a **manifest** — a typed table of contents binding identity keys and
   evidence digests. The manifest asserts nothing beyond identity and reference; it is
   not an attestation, never enters ADR-0018's cluster, and its best-effort carriage
   therefore cannot dilute the attestation's failure semantics.
3. **A carried artifact freezes at compose; carrier-determined and later facts are
   joined, never embedded** (§4.3). The carried half is additionally **intent-only by
   policy**: it carries frame and reference, and no evaluative content (findings,
   verdicts, statuses, outcomes) on either carrier — one rule regardless of when a
   carrier composes. It cannot contain the carrying commit's SHA or message, the
   squash's `Assisted-by:` trailers, terminal spend or outcome, attestation
   references, or the landing — which is exactly why it is a dossier-plus-manifest
   and not a statement: a conforming v0.1 statement *requires* a terminal outcome, so
   a compose-time statement would have to fabricate one. Each later fact stays
   authoritative where it is born — the carrying commit, the review records, the gate
   record and pinned status, the cycle log, emitted attestations, the ADR-0025
   landing receipt, git ancestry — and renders join the halves.
4. **Compose, don't author** (§4). Packet composition is deterministic harness work at
   boundaries where its constituents already exist — zero model turns, zero new review
   passes. Dossier carriage is bookkeeping, never a gate: on any failure the packet is
   omitted with a warning; it never fails a ship effect or blocks a merge. (The
   attestation's gate role, when ADR-0018's gate-assertion binding ships, is that
   ADR's — untouched here.)
5. **Bound, attributable — never "verified"** (§5). The manifest's digests are
   checkable references; the attestation, unsigned, is in its spec's own words a
   signable fixture. The packet states its tier; a consumer may raise the tier (sign,
   countersign, anchor), never the claim.
6. **Campaigns and releases are folds over packets, never objects** (§6) — the same
   discipline as "an initiative is a projected swimlane, never a pelaggio-owned object."

## 1. The complaint, stated precisely

The system's delivery evidence is inverted: everything rigorous is invisible, and the one
thing a reader sees is the one thing with no structure.

- **The rigorous records never reach a reader — and most do not even survive the
  delivery.** The merge-gate record (`.dev/pr-review-gate-records/{prNumber}-{headSha}.json`),
  the operator-adjudication source record with its `fleetRecordDigest` chain, the
  per-step execution receipts (domain-separated sha256 — `execution-receipt.ts`), and
  the cycle's `CycleProvenance` (`types.ts:187`) all live in gitignored `.dev/`,
  per-machine, unpushed. Worse, review records and execution receipts are rooted in the
  *claim worktree's* `.dev/`, and the direct-push bookkeeping tail removes that worktree
  — the evidence of a delivery is destroyed by the act of completing it.
- **The attestation format exists; per-delivery emission does not.** `docs/ai-delivery/v0.1`
  ships the statement schema, DSSE fixtures, and the execution-receipt evidence
  linkage, and its spec says plainly that signing, upload, and emission "remain
  separate work." The format answers *what* a machine delivery record is; nothing yet
  produces one per delivery or puts anything in front of a reader.
- **The artifact a human reads is free-form.** The PR body is model-authored markdown,
  capped at 512 KiB (`MAX_PR_BODY_BYTES`, `ship/decision.ts:9`), with exactly two
  harness-composed additions: the appended authoring-review record render
  (`pipeline.ts:2344`) and `Assisted-by:` trailers on the squash commit. Nothing binds
  its prose claims to the typed records that could back them.
- **Direct-push emits no structured artifact at all.** The `direct-push` ship dispatches
  no effect (`flow-event-catalog.md`); the commit message is skill-templated prose the
  pipeline never inspects. A direct-push delivery leaves *less* durable evidence than a
  PR delivery.

Four audiences ask questions of a delivery, and today each is served by accident or not
at all (§3). The gap is not a missing format and not missing evidence — it is missing
**preservation**, a missing **carrier**, a missing **join**, and missing **keys**.

## 2. The unit ladder (identity keys already exist)

| Unit | Key | Today | Status |
|---|---|---|---|
| Attempt (cycle) | `runId` / `executionId` | `CycleProvenance` + execution receipts; the v0.1 statement is scoped here (one `runId`, terminal outcome) | built, gitignored |
| **Delivery (claim)** | `claimId` | named "delivery identity" in the flow envelope (`types.ts:294`); nothing joins on it | **the gap** |
| Item (charter) | `itemId` | charter contract: `AC-n`/`A-n` anchors, criteria table | designed (§8 there) |
| Campaign (lineage) | `rootId` projection | `(rootId, depth)` on lineage children | designed (charter §7) |
| Release | version/tag | trust manifest binds product posture to a release version; signed tags (ADR-0007) | built |

The delivery packet is **claim-scoped**; the attestation stays **cycle-scoped**, as its
schema demands. That is a composition, not a conflict: a delivery is one claim's
attempt-series, so the packet's manifest lists the claim's attempts and renders fold
their per-cycle records and (once #187 emits them) per-cycle attestations, joined on
`claimId`. A cycle is too small to be the delivery unit — a delivery can span several
cycles, resumes, and revise passes. An item is too large — a re-picked item is two
deliveries with two attempt histories, and the flow catalog already refuses to merge
their timings for exactly this reason. The charter is the *frame* a delivery executed
against, referenced by the packet, never owned by it.

Claim-scoping is why identity ships first (§7, §8): `claimId` is minted by flow-event
emission and recorded nowhere in the cycle log today, so packet work that preceded the
key would be forced onto `itemId` — precisely the conflation this section rejects.

Campaign and release are **not** packet-bearing units: each is a fold over delivery
packets (§6). Giving them stored representations would recreate the claims-registry
mistake one level up.

## 3. The audience contract

The delight criterion generalizes the charter-contract handoff rule (every handoff
artifact carries a recommended default plus a paste-ready command): **a rendered
delivery answers each reader in one step.** The *render* is join-free for the reader;
the fold performs the joins (carried half + joined facts, §4.3), because copying a
verdict into the packet would make the copy compete with the gate's own authoritative
record.

| Audience | Question | Answering layer | Render |
|---|---|---|---|
| Stakeholder | did the intent land, at what cost, under what assurance? | criteria table — declared `AC-n` → `verify:` bindings carried; statuses, `executed`/`attested` modes, and gate outcome all joined — + spend (`costEstimated` honest) | summary block; downstream dashboard card |
| Developer | what changed, why, what did review find, what's residual? | narrative (host surface) + findings-with-dispositions (joined from review records) + plan ref | `delivery show` over PR body / committed dossier |
| Agent | typed state to act on | the manifest: identity keys, digests, refs | fail-closed parse |
| Archeologist | why does this exist; what frame; what was superseded? | charter anchor snapshot + assumption ledger + supersede links in the dossier; evidence by digest in the manifest | the committed file + git ancestry |

Two of these change the priority of existing planned work:

- The **criteria table** (charter-contract §8) is not review machinery — it is the
  stakeholder layer of the packet, the only artifact that closes intent → evidence.
  The packet is the surface that makes slice 2 worth building.
- The **assumption ledger + supersede provenance** is the archeologist layer. Today it
  would live only in mutable tracker bodies; the dossier's snapshot is what makes it
  durable.

The division of content follows the freeze rule (§0.3): the **dossier** carries the
delivery's *frame* — charter anchors verbatim, the declared criteria bindings
(`AC-n` → `verify:`, without statuses), plan reference, grouping, supersede context —
while every *evaluative* fact (finding, disposition, status, verdict, outcome) is
joined by the render from the record that owns it. Narrative proper lives on the
**host surface** — the PR body or the carrying squash commit's message — adjacent by
construction, never quoted into the packet (§4.3). This is also the predicate's own
discipline applied one layer up: "no narrative claim fields; explanatory material
belongs in content-addressed evidence."

## 4. The packet: format, accretion, carriers

### 4.1 Format: dossier + manifest, feeding — never duplicating — the attestation

The carried form follows the decision-log idiom: an HTML-comment base64url marker holds
the authoritative payload; a rendered presentation follows, produced with the same
untrusted-text hardening `decisions.ts` already ships (`inlineUntrusted` /
`fenceUntrusted` / dynamic fence sizing). Marker is authority; render is presentation;
parse is fail-closed.

The marker payload is the **delivery manifest** — deliberately *below* attestation
class, in the same local typed-marker family as the decision-log's own markers:

```jsonc
{ "v": 1, "itemId": "557", "claimId": "01J...", "asOf": "pre-ship",
  "target": "direct-push",
  "attempts": [ { "runId": "..." } ],                                    // this claim's cycles so far
  "evidence": [ { "path": "...", "sha256": "..." } ],                    // records existing at compose, by digest
  "dossier": { "sha256": "..." },                                        // digest of the composed dossier render
                                                                          //   it travels with — whatever pins the
                                                                          //   marker pins the prose transitively
  "grouping": { "rootId": null, "initiative": null, "supersedes": null } }
```

A manifest asserts identity and reference, nothing else — no outcomes, no verdicts, no
subjects, and **no attestation references**: statements are emitted after the carried
manifest freezes, so they are joined facts like verdicts and landings, never carried
refs. The join runs the other direction — a statement's producer reads the delivery
keys from `CycleProvenance` (and a future predicate version may carry them natively,
§11). The manifest is not an in-toto statement, so it neither violates ADR-0018 (which
governs the attestation cluster, #186–189) nor pretends to its semantics.

Two records, two names, two contracts — the carried **manifest** is not the store's
**ledger**: the manifest is frozen at compose, schema-locked (§7.4), and
identity-and-reference only, forever; the ledger (§4.2) is the store-local accreting
view that *may* gain terminal facts, attestation refs, and superseded-attempt
history, lives in gitignored `.dev/`, and carries no compatibility promise. The
ledger is **never authority for anything**: identity recovery grounds in the cycle
log and git (§7.1) with the ledger as an operational cache, and the integrity
digests it holds are accident diagnostics, not tamper controls (§4.3) — a
rebuildable store cannot referee its own replacement, and this design does not
pretend it can. An implementer who finds themselves adding an outcome field to the
manifest is building the ledger in the wrong file.

The **attestation** stays exactly what `docs/ai-delivery/v0.1` defines: a per-cycle
statement with a terminal outcome and evidence by digest — which is precisely why it
*cannot* be the carried artifact: a statement composed before ship would have to
fabricate its own terminal outcome, and one carried inside the candidate would have to
contain the digest of the artifact it is part of. When, with what subject, and for
which outcomes a producer emits statements is the cluster's design space, not this
document's — and that space has a real constraint this design does not paper over:
v0.1's normative subject rule requires exactly one subject naming the **landed**
change artifact with its real digest (the checked-in fixture's synthetic digest is
labeled synthetic, not an escape), so PR-open, parked, and blocked cycles cannot
yield a conforming v0.1 statement at all. The producer either narrows emission to
landed deliveries or the cluster revises the predicate; ADR-0018's pre-merge
precondition ambition sits in the same tension, and resolving it is the cluster's
call. This design's obligation to that producer is singular: the preserved store
(§4.2) keeps every input available whenever it runs.

### 4.2 Assembly store and accretion (the timing correction)

The constituents are not all born at any single moment — review records land at their
step boundaries, `CycleProvenance` at cycle end, the merge-gate record only after a PR
exists (and in CI-review mode never locally). So the packet's inputs **accrete**:

- **Store:** `MAIN_REPO/.dev/delivery-packets/<itemId>-<claimId>/` — main-repo
  rooted through the shared `mainWorktree()` redirect (the stale-quarantine
  precedent), written only by harness code, `0o600`. Its internal shape borrows the
  flow-events append discipline wholesale, because the same hazard applies:
  concurrent harness processes (a resume and a revise sweep) can touch one claim,
  and a single mutable record file would lose updates, not just tear them. So the
  store holds **append-only per-writer segment files** (`<executionId>.jsonl`,
  single-writer-per-file, one bounded write per record) plus **content-addressed
  preserved bytes** — digest-named, **published atomically** (tmp + rename to the
  digest name, so a crashing writer can never leave a half-written blob *at* a
  digest name), and **verified on trust**: the cleanup sweep re-hashes a blob
  against its filename before treating the record as preserved, and a mismatch
  counts as missing and re-copies — digest naming alone makes concurrent writers
  collide harmlessly only when both of those hold; the **ledger** (§4.1) is the
  *fold* of the segments, never a shared mutable file. Modes distinguish kind: `0o700` directories (traversal needs
  the execute bit), `0o600` files. Never worktree-rooted: worktree `.dev/` dies
  with the worktree.
- **Preservation is per-record, at the step boundary that produced it** — not at cycle
  end. The harness copies each worktree-rooted record (review record, execution
  receipt) into the store as it is written. Cycle end is too late: on the direct-push
  path `runShipBookkeeping()` removes the worktree *before* the cycle-log append, so a
  cycle-end copy would miss exactly the path this design exists to fix.
- **Preservation failure is not carriage omission — it has its own contract.** A
  failed copy is retried once at write time and recorded as `unpreserved` where the
  store can still take the write. But a marker in the possibly-failing store cannot
  be the sweep's only input — a destination failure can lose the marker along with
  the copy — so the final sweep is **source-enumerated**: before removing the tree,
  the cleanup boundary lists the worktree's record paths directly (`.dev/`
  review-record and receipt locations are enumerable), diffs against the store's
  preserved set, re-attempts every missing copy, and proceeds regardless afterward,
  recording what was permanently lost. This is the gate-quality bar's *preserving*
  posture applied to tail work: nothing blocks, and nothing is silently destroyed
  while a cheap retry remained.
- **Finalization happens beside the cycle-log append** (a main-store write, safe after
  worktree removal because the bytes were preserved as they were born): the ledger
  gains the cycle's terminal facts as observed — outcome, spend, and note that
  `CycleProvenance.git.headSha` is the feature head, not a landed SHA; landing
  observation belongs to the ADR-0025 receipt and git itself. The *carried* manifest
  froze earlier, at its carrier's compose moment (§4.3), and says so via `asOf`.
- **On revise:** the local revise sweep re-enters the pipeline and produces a new head
  for the same claim. The same `(itemId, claimId)` ledger is updated — prior heads are
  recorded as superseded attempts, never as a second delivery. Keying by
  `(itemId, headSha)` — the obvious wrong design — would mint one "delivery" per
  revise pass.

Accretion is pure composition — no model turns, no network, no new review.

### 4.3 Carriers (how a packet reaches a durable surface)

- **Direct-push — in-candidate carriage is target-state, gated on ADR-0025's
  landing executor.** Twelve review passes over this design converged on one
  structural fact: a harness file composed onto an agent-writable branch, excluded
  from the reviewed SHA, and landed by an agent-owned squash cannot be given honest
  integrity semantics *by any bolt-on* — every defense either re-opens Decision 8
  (a post-merge corrective commit), fails open (a per-machine store as tamper
  reference), or over-claims (path guards opaque Bash can evade). The capability
  the carrier actually needs is the one ADR-0025 already commits to: a
  **harness-built candidate, verified as a whole inside the landing fence**. So the
  carried file for direct-push ships *with that executor*, as part of the candidate
  it stages and verifies — where "the packet is exactly as trustworthy as the
  candidate" is simply true, no exclusion pathspec, denial set, or revocation
  protocol required. Until then, a direct-push delivery's packet half lives in the
  store (§4.2) — fully functional for `delivery show` and the folds on the machine
  that shipped it — and the committed `docs/deliveries/<itemId>.md` is absent, a
  stated gap, not a degraded imitation. The executor-slice spec, in brief: the
  executor composes dossier + manifest into the candidate it builds (upserting the
  claim's own entry; appending only for a new `claimId`), verification covers the
  packet like every other candidate byte, and the phantom-ship/deliverable checks
  learn the `docs/deliveries/` exclusion in the same change. Compose failure omits
  the packet and lands the delivery packetless — unchanged posture.
- **PR / auto-merge-pr — forge carriage.** The manifest marker + dossier summary is
  **appended to the PR body** inside the existing ship effect — the exact mechanism
  that already appends the authoring-review record (`pipeline.ts:2344`) — so it adds
  no new effect class and does not touch the head SHA the gate pinned. Because
  `ship.ShipDecision` is a blocking effect, the append is **bounded and
  omission-safe** against the ceiling that actually fails the effect: the forge
  rejects bodies over its 65,536-character limit server-side, and nothing in
  `upsertPr` (`pr-effects.ts`) pre-checks length today — `MAX_PR_BODY_BYTES` only
  caps the parse-time file read and is eight times larger, so a naive append can
  pass every local check and then fail the blocking effect at the API. Slice 2
  therefore adds the missing harness pre-flight: append only if the resulting body
  stays within the forge ceiling (with a fixed packet budget below that), and on
  any size or compose failure ship the body *without* the marker and record a
  warning — a missing packet is always preferable to a failed PR effect. Stated
  honestly: a *source* body already over the forge ceiling fails the effect today
  with or without a packet — the guard guarantees the append never *causes* that
  failure; it does not repair the pre-existing input-contract gap, which belongs to
  the ship effect's own validation, not this design. Forge bodies are
  editable, so the marker alone cannot prove its own integrity; the effect therefore
  **pins it in git**: the marker bytes — whose manifest embeds the dossier render's
  digest, so the pin covers the prose transitively — are composed *before* the
  harness squash
  inside the same effect, and the squash commit message carries a
  `Delivery-Manifest-Digest: sha256:<...>` trailer beside the `Assisted-by:`
  trailers it already stamps. The digest travels in the immutable commit; a later
  body edit is mechanically detectable, and a marker matching the trailer is exactly
  as trustworthy as the commit that names it. (The trailer points commit → marker;
  the freeze rule only forbids the reverse.) The merge-gate fleet comment, pinned
  `review` status, and any adjudication comment complete the joined facts on the same
  PR; `delivery show` composes them and reports the digest check.
- **No PR-mode git committal.** A post-merge commit to main would be an unverified
  second push of exactly the kind Decision 8 forbids, `land` is a pure `gh pr merge`
  wrapper with no working-tree writes, and an unpushed local-main commit leaks into
  every subsequent cycle's PR diff (the observed config-leak failure mode). A future
  git-committed form for PR deliveries belongs to the typed write-back seam (flow,
  planned — off the hot path) and is out of scope here. Until then, the PR *is* the
  durable carrier for PR-mode deliveries.

**The freeze rule, uniformly applied (§0.3):** the carried manifest and dossier are an
as-of-compose snapshot, and say so. They cannot and do not contain: the carrying
commit's SHA or message (git ancestry and the host surface own them — for direct-push
the squash message *is* the narrative, adjacent in the same commit; for PR mode the
body is the host), the squash's `Assisted-by:` trailers (the commit owns them;
per-attempt drivers are in the preserved cycle records), terminal spend or outcome
(the cycle log and the finalized store are authoritative), the merge-gate verdict, or
the landing. Renders join those from their authoritative records; the join keys are
git ancestry (in-candidate) and `(prNumber, gated headSha)` (forge).

**No automated repair commit:** if composition fails, the delivery lands without a
carried packet, the gap is a bookkeeping warning, and the assembly store remains
readable locally (`delivery show` falls back to it). Committing a missed packet later
would be the post-landing write this design forbids; if a human wants it in git, that
is ordinary human work on an ordinary branch, outside this mechanism.

## 5. The honesty ladder ("signed and bound," said precisely)

Signing exists in this tree at exactly one granularity: the **release**. ADR-0007's
publish flow verifies SSH-signed tags against `.github/allowed_signers`, npm provenance
is on, and the trust manifest records `signed_tag: true` — while
`provenance.sigstore_bundle: "planned"` keeps the manifest's posture at `intent`.
**Per-delivery** signing does not exist — the ai-delivery spec is explicit that
"signing, upload, and merge-gate enforcement remain separate work" — and three
renderers already print "This is an unbound review record, not a cryptographic
attestation." The packet must not inflate that. The ladder, per delivery:

1. **Bound** — digests and identity keys, with assurance stated **per evidence
   kind, never generically**: the manifest itself asserts identity and reference
   only (§4.1's contract); an execution receipt it names attests what the local
   harness accepted and dispatched at one typed boundary (that module's own scope
   statement — the only evidence kind carrying dispatch semantics, per the v0.1
   spec); a review record attests its recorded verdict; the attestation, once
   emitted, is an unsigned DSSE envelope — the spec's "signable fixture." None of
   it proves a model did the work, nor that the host is uncompromised.
2. **Attributable** — `Assisted-by:` trailers and forge actor identity. Forensic,
   git-native, explicitly not a merge gate (#189).
3. **Tamper-evident** — a signature over the attestation envelope, countersignature,
   log anchoring by a consumer that retains packets. Downstream, and the spec already
   defines the consumer's obligations (verify signature, identity, subject,
   freshness). The packet enables it; pelaggio does not perform it.
4. **"Verified"** — does not exist on this ladder. No tier may claim correctness; the
   criteria table's `executed`/`attested` mode column is as far as honesty goes, and
   the predicate's own `trustModel` labels (self-reported / derived) describe
   provenance of a claim, not verification of its truth.

The dossier states the ceiling in words, the way `renderDocReviewRecord`
self-deprecates. A consumer raising the tier re-states it in *its* surfaces; the
carried packet never changes. The release fold (§6) is where per-delivery `bound`
meets the release's genuinely signed provenance, and the two must not be conflated in
a render.

## 6. Folds, not objects: campaign and release renders

- `pelaggio delivery show <id>` — render one item's deliveries, composing the carried
  half (committed file, PR body marker, or local assembly store) with the joined facts
  (gate record / status / adjudication / landing evidence / terminal cycle log /
  emitted attestations) and saying which carrier and which joins produced the view.
- `pelaggio deliveries render --root <id>` — the campaign view: packets sharing a
  lineage `rootId` (or an operator `initiative` tag), showing anchors covered across
  the lineage, total spend, the supersede chain, and open remainder. Computed from
  carried packets + live items; never stored.
- `pelaggio deliveries render --range <ref>..<ref>` — the release view: packets whose
  carrying commit lies in the range (in-candidate: the packet file's own ancestry;
  forge: the merge commit of the packet's PR), joined with the trust manifest at that
  release version. "Product posture at this release, plus the deliveries in it" is the
  release-notes shape; the manifest and the signed tag are already bound to a release.

All three are non-authoritative projections, rebuildable, deletable. A consumer may
build prettier equivalents from the same packets; these CLI renders are the reference
implementations and the self-host parity floor.

## 7. What must be locked now (cannot be backfilled)

The flow-event lesson applies verbatim: identity and grouping are stamped at emission or
lost. Everything else here is deferrable; these are not:

1. **`claimId` is minted durably at claim time, then reaches the cycle log.** Nothing
   mints `claimId` at `b050746` — the flow catalog *defines* it as minted at pick, but
   #177 emission is unbuilt and the substrate persists null — so slice 1 is a mint
   plus two records, not a copy: at claim time the harness mints the id and persists
   it immediately by creating the delivery store entry
   (`.dev/delivery-packets/<itemId>-<claimId>/` with `state: open` — the mint *is*
   the ledger's birth); each cycle then copies it into `CycleProvenance`. This is
   #177's pick-time mint, pulled forward and coordinated — there is one mint, never
   two. Because pick runs in `MAIN_REPO`, the store path is seat-writable unless
   protected; it joins the **agent-denied register set** on the same footing as
   session records (the #482 §K3 placement rule the charter design also follows) —
   and because that register's gaps (main-cwd, opaque Bash, heterogeneous drivers)
   are themselves unbuilt, the store is *defended*, never *trusted*. The entry's
   lifecycle is explicit at both ends, keyed to the claim-release **observable**
   (the `feat/<id>` branch ceasing to exist), never to "ship" — a PR-mode ship
   leaves the claim live through revise passes, and closing there would split one
   delivery's identity. Where a local process performs the release (the direct-push
   bookkeeping tail's branch delete, `/tidy`, post-`land` cleanup) it closes the
   entry eagerly; where nothing local witnesses the release (an auto-merge or
   forge-side merge), closure is **lazy reconciliation**: any later mint or
   recovery that observes an open entry whose branch no longer exists closes it
   `released-observed` before proceeding — the dead-holder posture again, so
   shipped PR deliveries cannot strand `state: open` entries that unsound the
   single-open-entry corroboration below.
   Recovery — a resume, or a crash-restart — follows **one rule, fail toward
   fission**, because branch *names* recur (`feat/<id>` is recreated by every
   re-pick) and nothing on a git branch carries delivery identity, so no check
   against live git can distinguish "my claim, resumed" from "a new claim with the
   same name." The mint records an **epoch token** (mint ULID + observed main SHA)
   in its store entry and in every `CycleProvenance` row, and recovery **adopts an
   identity only on positive corroboration**: the store's single open entry and the
   item's latest cycle-log row carry the same epoch. *Every* other state — store
   lost, no open entry, entries disagreeing, no cycle logged yet under an open
   entry that a fresh mint would contradict — mints fresh with
   `continuity: degraded`, and a mint that finds a stale open entry closes it
   `abandoned-stale` first (its own just-succeeded branch creation is proof no
   live claim owns it — git ground truth, the dead-holder idiom), so minting never
   blocks a claim. The bias is deliberate and the residual is stated rather than
   denied: a wrongly-*split* delivery is visible in the record and mergeable by
   later analysis, while a wrongly-*merged* one silently fuses two attempt
   histories and cannot be unfused — so ambiguity always splits, and a collapse
   requires the two independent records to be wrong together. Identity continuity
   here is per-machine best-effort telemetry until #172, not a guarantee, and the
   design claims no more. The join from cycles to a delivery must be recorded
   while the claim is live, not reconstructed from deleted branches. Deliveries
   completed before this lands get no packet — `itemId` is never substituted as
   delivery identity.
2. **Grouping keys in the flow envelope correlations and `CycleProvenance`**: lineage
   `rootId`, optional operator `initiative` tag, `supersedes`/`supersededBy` (the
   vocabulary charter §5 defines). Whether they later enter the predicate is the
   predicate owners' call (§11); their capture cannot wait for it.
3. **Per-record constituent preservation** (§4.2): worktree-rooted evidence copied to
   the main-repo store at the step boundary that produced it. Every delivery that
   completes before this lands has already destroyed the bytes its digests would have
   referenced.
4. **The marker-authoritative manifest form** (typed payload, fail-closed parse) —
   retrofitting it invalidates every packet carried before it.

## 8. Sequencing (each slice independently valuable)

1. **Identity and grouping** (§7): mint `claimId` at claim time **with its durable
   store entry** (`.dev/delivery-packets/<itemId>-<claimId>/`, `state: open` — the
   §7.1 mint record is slice-1 work, because without it the id cannot survive a
   resume) and record it in `CycleProvenance`; grouping fields into the flow
   envelope correlations; supersede vocabulary reserved. Small, first, and valuable
   on its own as telemetry keys even if no packet ever ships. Slice 2's store adds
   the *contents* (preserved records, segments, manifest); slice 1's entry is only
   the identity shell.
2. **Accretion store + the forge carrier**: per-record preservation into the
   `(itemId, claimId)` store, the manifest and ledger, and the bounded
   omission-safe PR-body append with its squash-trailer digest pin. After this
   slice every new PR-mode delivery has a durable carried half, and every
   direct-push delivery has its store half — the direct-push *carried* file waits
   for the landing executor (§4.3), a stated gap, not a shortcut taken.
3. **Renders**: `delivery show` (the carried+joined composition), then the campaign and
   release folds — built only if packets are being read (§10).
3b. **Direct-push in-candidate carriage**, as part of ADR-0025's landing-executor
   work when that ships (§4.3): the executor composes the packet into the candidate
   it builds and verifies, and the deliverable/phantom-ship exclusions land in the
   same change.
4. **Adjacent work lands on its own tracks and slots in**: declared criteria bindings
   enter the dossier when charter-contract slice 2 ships; per-cycle attestations enter
   the store's ledger when the #187 emitter ships (fed by this design's preserved
   records); a `claimId`-bearing predicate version is the cluster's decision. The
   packet carries or joins each; it builds none of them.

Downstream consumption (retention, signing, countersigning, hosted rendering) is not a
slice of this design; it happens behind the manifest and statement contracts,
elsewhere, on its own schedule.

## 9. Non-goals

- No bespoke attestation schema, and no attestation semantics in the manifest — the
  attestation layer is ADR-0018's cluster; the manifest binds identity and digests,
  full stop.
- No campaign/initiative/release objects, stores, or lifecycle — folds only.
- No narrative authored by the packet: prose lives on host surfaces and in preserved
  evidence; the dossier snapshots and cross-references, it does not compose claims.
- No gate anywhere in carriage: composition and carriage are best-effort bookkeeping;
  omission with a warning always beats a failed effect or a blocked ship. The
  attestation's target-state gate role (ADR-0018) is unchanged by this design.
- No verdict copies: merge-gate and landing facts are joined from their authoritative
  records, never duplicated into the carried packet (§0.3).
- No post-landing commits to main, no second push, no packet mutation after carriage,
  no automated repair commits.
- No per-delivery signing in pelaggio; no claim above `bound` in any pelaggio render.
- No new review passes, model turns, or standing prompt tokens on the ship path.

## 10. The counter-case, and what would falsify this

- **A second unread artifact class.** The decision log earned its place by being the
  thing an operator must read to resume; nothing forces anyone to read a delivery
  packet. If, after slice 2 has run for a few weeks of supervised operation, packets
  are not being opened (no reads in supervised sessions, no fold usage, no downstream
  consumer), the right move is to demote the carried dossier to render-on-demand and
  keep only slice 1's key-stamping and §7's preservation — cheap, and they preserve
  the option.
- **Repo growth.** One markdown file per direct-push-shipped item, forever, in a repo
  whose intake runs ~1.7× closure (`throughput-economy.md` §2.1). Real but slow; the
  archive discipline that governs plans applies. If size becomes the complaint, the
  same demotion applies.
- **The join could be wrong.** `claimId` is null for everything shipped before slice 1;
  the joined facts are only as available as the stores they live in (a CI-reviewed PR
  has forge status but no local gate record; a pruned forge loses the PR-mode carrier
  entirely); and the carried manifest is as-of-compose while the finalized store and
  cycle log stay authoritative for terminal facts. All three are stated by renders
  rather than papered over — the packet's value is exactly that it never claims more
  than a record supports.
- **The dossier is intent-only.** By §0.3 policy the carried dossier holds frame and
  context — anchors, plan ref, grouping, evidence-so-far — and *none* of the
  delivery's evaluative story; a reader wanting findings or outcomes always crosses
  one join. This is chosen, not forced (a post-gate compose on the forge carrier
  could embed findings): one carried shape across both carriers and every compose
  moment beats a richer artifact whose content depends on where it rode. If field use shows readers overwhelmingly want the evaluative half
  in the carried artifact, that is evidence for the write-back seam route (§11), not
  for a per-carrier content fork.
- **Beads adjacency.** When `bd` lands as a `RoadmapSource`, item bodies and hierarchy
  move stores, but nothing here keys on tracker internals: the packet binds git SHAs,
  digests, and adapter-published anchors, so the design is adapter-neutral by
  construction. If a future work-store natively produces a better delivery record, the
  packet folds it in as a constituent, not a competitor.

The falsifiability bar: slices 1–2 are justified by the direct-push evidence hole, the
evidence-dies-with-the-worktree defect, and the unbackfillable keys alone. Slice 3 is
justified only if packets are read — measure that before building the folds.

## 11. Open questions

1. **File placement:** `docs/deliveries/<itemId>.md` as proposed, or one more entry
   class in the existing `docs/decision-log/<itemId>.md`? One file per concern is
   cleaner; one dossier per item is more discoverable. Leaning: separate directory,
   cross-linked from the decision log when both exist.
2. **Superseded deliveries:** does a superseded item get a terminal packet recording
   "closed superseded by `<newId>`" (archeologist-friendly), or does the supersede link
   on the successor's packet suffice?
3. **The predicate revision:** should a future `ai-delivery` version carry `claimId`
   (and grouping) natively, making per-cycle statements self-joining into deliveries —
   or does the join stay packet-local? The predicate's owners decide; this design only
   requires that the keys be *captured* now (§7).
4. **`initiative` authority:** operator-supplied tag at charter time, or only ever the
   lineage `rootId`? A free tag invites taxonomy sprawl; a lineage-only key cannot
   express cross-lineage campaigns.
5. **PR-mode git committal, eventually:** when the typed write-back seam lands, should
   PR-mode packets gain a committed form (batched, off the hot path, through the same
   fence discipline), or is the forge carrier permanently sufficient for PR-mode
   deliveries?

## 12. Open review findings (pass 15, unresolved — slice-level input)

Recorded verbatim in substance so the document carries its own defect ledger; each is
mechanics-grade, owned by the slice that builds the mechanism it names.

1. **Corroboration independence** (slice 1): §4.1 grounds recovery in cycle-log+git
   while §7.1's rule requires store+cycle-log epoch match — and since
   `CycleProvenance` *copies* the store's mint, the two records are not independent
   witnesses; an implementer re-reading the store at cycle end, or recovering from
   cycle-log+git on a store miss, can still fuse re-picked deliveries. The epoch must
   be captured into the cycle log by a path that does not re-read the store at
   finish().
2. **Attempt identity under resume** (slice 1): `CycleProvenance.runId` deliberately
   repeats on `--resume` at the pinned tree, so manifest `attempts` keyed by `runId`
   alone cannot distinguish resumed cycle records; the manifest needs the
   per-process `executionId` beside it.
3. **Forge-pin survival** (slice 2): GitHub's squash-merge does not preserve the
   harness squash or its `Delivery-Manifest-Digest:` trailer, and revise passes
   re-pin a new gated head above the trailer-bearing commit — so `delivery show`'s
   pin check must walk the PR's commit ancestry (where the trailer commit persists
   pre-merge) rather than the merge commit or the latest gated head, and must state
   the post-merge reality: after a forge squash-merge the pin survives only in the
   PR's (mutable, forge-retained) commit history, a weaker anchor than a landed
   trailer, to be claimed as such.
4. **Terminal-state distinguishability** (slice 1): `abandoned-stale` (mint-time
   reconcile) and `released-observed` (lazy release reconcile) currently share the
   same observable trigger (branch absent at observation); either merge them into
   one `reconciled-closed` state carrying the observing context, or bind
   `abandoned-stale` to the mint's own branch-creation proof explicitly.
5. **False-tamper on revised PRs** (slice 3): the digest-check join keyed on
   `(prNumber, gated headSha)` reports a spurious tamper signal for every revised
   PR (the trailer rides an earlier commit); same ancestry-walk fix as (3).
