# Flow Event Catalog (#170)

**Status: #170 substrate implemented; #177 emission and #178 subscription remain planned.** This is the precise `#170` spec that the
`## Signals and the projection` section of [`flow.md`](./flow.md) points at. Where the two
disagree, this file wins for the event catalog; `flow.md` remains the home for the wider flow
rationale (policy seam, write-back, concurrency). Written before the first implement cycle so the
cycle building #170 consumes it as context — the identity contract and the fat/derive split below
are load-bearing and cannot be backfilled once data exists.

This spec is the product of an adversarial review pass (four independent reviewers + Codex). It
supersedes three earlier assumptions that the review falsified: that the projection folds "the
event log pelaggio already writes" (it writes a *cycle-outcome summary*, not an event log), that
events should be *thin* by default, and that a single `seq` could be globally monotonic.

### Implemented substrate API (#170)

`packages/pelaggio/scripts/pelaggio/flow-events.ts` now publishes the closed
`PELAGGIO_EVENT_TYPES` registry, `createEventWriter()`, `readEventLog()`, `foldEvents()`, and
`projectEvents()` through the package entry point. Each writer owns one immutable
`.dev/flow-events/<streamId>.jsonl` segment and rejects records above
`MAX_FLOW_EVENT_BYTES` (64 KiB, including the newline). Diagnostics retain bounded structured
details (`MAX_EVENT_DIAGNOSTIC_DETAILS`) alongside unbounded counts.

Legacy cycle records are normalized in memory without changing their source bytes. Their stable,
ULID-shaped compatibility IDs are domain-separated SHA-256/Crockford encodings of the canonical
absolute source path, source line, and exact record bytes; the legacy stream identity is derived
separately from the source path. The `legacy: true` discriminator prevents these compatibility IDs
from being mistaken for timestamp-bearing ULIDs. Combined output is presentation-sorted by
`(ts, streamId, seq, eventId)` and does not establish cross-stream causality. The initial projection
contains historical accepted-event totals/by-type and diagnostics only; it intentionally exposes no
readiness or live-WIP fields.

### Cycle-log provenance receipt

New non-dry-run `.dev/pelaggio-log.jsonl` records include an additive `provenance` object. It records
the cycle `runId`, integer wall-clock `durationMs`, stable first-seen realized `drivers` (provider and
resolved model), a Git binding (`branch`, portable `worktree` label, `mainShaAtStart`, and last valid
feature `headSha`), Pelaggio/Node/realized-driver `versions`, and the ship target's optional `prUrl`.
Best-effort probe failures leave nullable observations or stable keys in `unavailable`; they never
change the cycle outcome.

The receipt is local forensic telemetry, not a signed attestation. Legacy records without it remain
valid, and the dual-format reader preserves the object when projecting an untyped cycle-log line to
`pelaggio.cycle-completed`; stats continue to use the legacy outcome and step fields.

## The reframe: two field populations, opposite storage rules

The projection has two kinds of field, and conflating them is the design's central hazard:

- **Current-state** (`is-ready`, live WIP, `lifecycleState`) — **non-authoritative, reconciled
  from ground truth on read.** git (a `feat/<id>` branch exists ⇒ claimed) and the provider (issue
  closed ⇒ done) are ground truth; the projection is a cache. Much of this is derivable *today*
  with no events at all: WIP from `claimedIds()` over `feat/*` branches (`roadmap/git-claim.ts`),
  readiness from `listItems()` + `deps`. The event log is **not** needed to answer "what is claimed
  right now."
- **Historical / time-series** (lead/cycle time, flow efficiency, WIP-over-time, aging
  accumulation, per-attempt outcome counts) — **the append-log *is* their ground truth.** They are
  NOT rebuildable by joining live git/provider, because the transition being measured destroys or
  mutates its own join target: ship deletes the `feat/<id>` branch
  (`ship/bookkeeping.ts`), so "claimed-at" is unrecoverable a week later; edited `deps` silently
  move a re-derived `firstReadyAt`. Events carrying these fields must be **fat and self-contained**.

The rule that follows: **log the transition fat for history; answer liveness by reconciling git/
provider.** "Rebuildable from log + git + provider" holds for *current state*, not for historical
metrics — those are authoritative in the log or they do not exist.

## The envelope (identity + ordering contract) — LOCK THIS

Every line, in both the flow-event log and (as `pelaggio.cycle-completed`) the reader's view of the
cycle-log, carries:

```jsonc
{
  "v": 1,                       // single envelope version. Per-event-type versioning is DEFERRED
                                //   (add on first real divergence — the tolerant reader makes it
                                //   non-breaking). One envelope version is enough today.
  "type": "pelaggio.claimed",   // namespaced. `pelaggio.*` is reserved/closed/core-validated.
  "eventId": "01J...",          // immutable ULID. The unique key. NOT `seq`.
  "streamId": "01J...",         // per-writer-process identity. The ORDERING SCOPE.
  "seq": 42,                    // monotonic WITHIN `streamId` only. NEVER globally monotonic.
  "ts": "2026-07-13T...Z",      // wall clock = occurredAt.
  "itemId": "170",              // may be null (a park before pick).
  "claimId": "01J...",          // lifecycle/episode identity, minted at pick. Groups a delivery
                                //   across resumes/retries. null before a claim exists.
  "readinessEpisodeId": "01J", // readiness-episode identity, minted when an item flips false→true
                                //   ready. `became-ready` carries it; `claimed`/`shipped` copy it
                                //   forward so lead time (which precedes the claim) joins on it
                                //   rather than a not-yet-minted `claimId`. null if never ready.
  "executionId": "01J...",      // one process/run. A `--resume` is a NEW executionId.
  "causationId": "01J...",      // links intent→confirmation and resume→parent event. null if root.
  "attempt": 2,                 // step attempt, where relevant. Absent ⇒ 1.
  "...payload": {}              // FAT for historical events: fromState, the pre-join facts the
                                //   transition will erase, decision inputs. See per-metric table.
}
```

- **Ordering key is `(streamId, seq)`.** `seq` resets per writer process. Cross-stream order is
  best-effort `(ts, streamId, seq)` and is explicitly **not** a total order. The server spawns an
  independent child process per run (`packages/server/src/supervisor.ts`) against the same repo's
  flow storage (each writing its own segment), so a global counter is unachievable without a
  broker/transactional store — the deferred multi-orchestrator upgrade, not a #170 concern. Do not
  ship a `seq` you would call repo-global.
- **Unique key is `eventId`.** Cursors, snapshot watermarks, and dedup key on `eventId`, never `seq`.
- **Correlation:** `claimId` groups one delivery across resumes/retries; `readinessEpisodeId`
  groups the *pre-claim* readiness window with the delivery it leads to (lead time spans the
  claim boundary, so it cannot key on the later-minted `claimId`); `itemId` groups claims across
  re-picks of the same item; `executionId` identifies one process. Metrics that mean "this
  delivery" key on `claimId` (not `itemId` — a re-picked item shares `itemId` with an abandoned
  prior attempt and would otherwise merge their timings); ready→shipped lead time keys on
  `readinessEpisodeId` carried forward into `claimed`/`shipped`.

## Storage: per-writer segment files, separate from the cycle-log

Flow events live under **`.dev/flow-events/`** as **one append-only segment file per writer
process** (`<streamId>.jsonl`), *not* interleaved into `.dev/pelaggio-log.jsonl`. The logical "flow
log" is the set of segments; the reader globs and folds them. The common CLI run is a single writer
= a single segment.

- **Why separate from the cycle-log.** `computeStats` (`packages/pelaggio/scripts/pelaggio/stats.ts`)
  is a *published cross-package API* — `packages/server` serves it at `/repos/:slug/stats`. Rewriting
  it to dispatch on `type` is a change to a shipped contract, keeps the legacy duck-type forever as a
  shim anyway, and couples a 1-per-cycle cadence with an N-per-cycle cadence in one file. Separate
  storage is `rm`-able if the flow experiment is revised, and leaves the stats contract untouched.
- **Shared envelope + a shared reader library, not a shared file.** A new `readEventLog()` /
  `foldEvents()` library reads the segments and the cycle-log under one envelope, and can present the
  cycle-log as a stream of `pelaggio.cycle-completed` events (an in-memory reframing — the cycle-log
  bytes are never rewritten). `computeStats` keeps its own inline parser for now; migrating it onto
  the shared decoder is optional cleanup, so "stats is a projection too" is a *reader-layer*
  aspiration, not a claim that the two readers are already one.
- **Append integrity by single-writer-per-file — no shared-file concurrent append.** Each writer
  *process* mints one `streamId` and appends only to **its own** segment (`<streamId>.jsonl`), with a
  per-process atomic `seq` allocator (in-process `--parallel` workers share it via the single event
  loop). Because no two processes ever write the same file, there is no cross-process interleaving to
  prove and **no reliance on `PIPE_BUF`** (a pipe/FIFO guarantee that does not hold for `O_APPEND` on
  a regular file, and does not apply on Windows at all). A per-record size cap still applies so a
  crash mid-write truncates at most the tail record (the reader drops a malformed trailing line with
  a diagnostic). `streamId` is the segment identity the #178 cursor resumes on; a total cross-writer
  order is explicitly never claimed. Multi-writer coordination (a broker / SQLite) stays a deferred
  `packages/server` concern and never drives the core primitive.
- **Local-only, single-machine, current-window.** `.dev/` is gitignored, so segments are invisible to
  the git-state confinement audit (harness-side appends never trip TC-011) and are per-machine. This
  is **not** durable or portable observability — durable memory is write-back (#172). #170's charter
  delivers single-machine, current-window metrics only; do not review it as if it ships durable
  history.

### Minimal vocabulary (the closed `pelaggio.*` set #170 ships)

#170 ships the registry and these core type constants (a closed set; growth beyond it is deferred
and non-breaking under the tolerant reader). Emission of most of them is wired in #177 — #170 only
needs the registry, the `cycle-completed` legacy bridge, and enough of the set to exercise the
reader/projection:

`pelaggio.cycle-completed` (legacy-bridge, emitted by the decoder), `pelaggio.became-ready`,
`pelaggio.claimed`, `pelaggio.plan-published`, `pelaggio.plan-rejected`, `pelaggio.shakedown-fail`,
`pelaggio.suspended`, `pelaggio.resumed`, `pelaggio.in-review`, `pelaggio.blocked-discovered`,
`pelaggio.claim-released`, `pelaggio.shipped`, plus the observation types `pelaggio.effect-failed`,
`pelaggio.state-observed`, and `pelaggio.state-corrected`.

## The reader: a dual-format decoder (prevents silent history erasure)

The reader must never make existing `/stats` history vanish. Decode order:

1. **Legacy compat:** a line with **no `type` and a valid `steps[]` array** → normalize to
   `pelaggio.cycle-completed` (a `@legacy` variant). Never skip it. Every pre-#170 line is untyped;
   a naive `type`-only dispatch would zero out all historical cost/failure/retry stats on both the
   CLI and the server route.
2. **Known envelope** → validate and normalize by envelope `v`.
3. **Unknown `type`** → tolerantly skip, but **increment a diagnostic counter** and surface it.
   Tolerant does not mean silent.

Keep the existing cycle fields **top-level** on `cycle-completed` (envelope adds keys, never
relocates `steps`/`total_cost`/`completed`), or the whole `stats.ts` reducer breaks even for new
lines. Ship golden-file tests for: legacy-only, new-only, mixed, malformed, truncated-tail, and
unknown-type logs.

## Emission: three producers, harness-side, never from "the step completed"

A flow event asserts "this happened." It must never assert a state change that did not happen.
There is **no single emission trigger** — transitions fall into three classes, each with its own
producer. An implementer must not assume "the effects manifest emits everything" (it can source at
most two of ~11 event types).

1. **Effect-confirmed transitions** (`plan-published`; PR-mode `shipped`) — **sourced by the
   effects manifest.** `effects.ts` is already a typed, versioned, provenance-checked record of what
   a step did; it is *ephemeral* (deleted after dispatch) so it cannot be the durable log, but it is
   the correct *source*. Emit the durable event as the final side effect of a **confirmed** outcome.
   This needs a handler-contract refactor: handlers today return `EffectsDispatchResult | undefined`
   (append-text only) and `plan.publish` swallows a provider failure indistinguishably from a no-op
   (`effects.ts`). They must instead return `{ kind, status: "applied" | "noop" | "failed",
   details }` — one persisted outcome **per manifest effect, in manifest order**, including a thrown
   failure and any already-applied effects. Emit the success transition only from `applied`; on
   `failed` emit `pelaggio.effect-failed`, never a false success. Note only three kinds dispatch
   today (`checkpoint`, `plan.publish`, `ship.ShipDecision`); `pick.explainSelection` and
   `shakedown.deferredItems` are reserved-but-throwing, and **`direct-push` ship dispatches no
   effect at all** — so effect-confirmed emission covers a *minority* of the vocabulary.
2. **Git-mutation transitions** (`claimed`, `claim-released`) — **bracketed** by an `intent` event
   before the git mutation and a `confirmation` after, joined by `causationId`. A mid-transition
   death then leaves a durable trace instead of an invisible gap (a `feat/<id>` branch created and
   deleted between folds is otherwise undetectable). Direct-push completion, which dispatches no
   effect, emits its `claim-released` here.
3. **Derived transitions** (`became-ready`, and readiness flips generally) — emitted by an
   **orchestrator readiness-diff**: these have no effect and no git mutation of their own. When an
   upstream dependency closes/ships, the orchestrator recomputes readiness and emits `became-ready`
   for each item that flipped `false → true`, stamping `ts` at that recompute (owned by the
   ship-tail/reconcile boundary that observed the dep close — **never** a later backfill).
   `plan-rejected`, `shakedown-fail`, `in-review`, and `blocked-discovered` are harness
   *observations*, emitted at the step boundary where the harness observes them — same class.

Rules common to all three: **harness-side only** (emitted from orchestrator/pipeline code, never
inside an agent step — preserves per-writer serialization and confinement invisibility), and
**identity aligned with `effects.ts`** (one meaning for `executionId`, one `schemaVersion` lineage,
one kind namespace, so `pick.explainSelection` is one concept, not two).

## Reconciliation: repairs current state, never fabricates history

On startup the projection reconciles against ground truth — but ground truth can only repair
*current* state, not lost *transitions*.

- git/provider fix `lifecycleState`; ground truth wins. A cycle that dies after creating `feat/170`
  but before its `claimed` event is reconciled to "claimed" — but the *when*, the selecting policy,
  and the candidate set are gone.
- **Never synthesize a historical `occurredAt`.** Emit `pelaggio.state-observed` /
  `pelaggio.state-corrected` with `{ confidence, source, observedAt }`. Metrics expose the gap
  (uncertainty) rather than treating "no event" as "did not happen."
- **For important mutations, bracket them:** append an `intent` event before the git mutation and a
  `confirmation` after, joined by `causationId`. A mid-transition death then leaves a durable trace
  instead of an invisible gap (a branch created and deleted between folds is otherwise undetectable).

## Suspensions and the flow clock

Flow efficiency and aging need *closed intervals* and a typed reason — the starting taxonomy had
open events (`parked`, `blocked-discovered`) but no closes.

- **Model every pause as a paired interval:** `pelaggio.suspended { suspensionId, reason }` …
  `pelaggio.resumed { suspensionId }`. Every transition event also carries `fromState` and
  `enteredPriorStateAt` so an interval closes inline without fragile cross-process open/close
  matching.
- **Typed `reason`:** `rate-limit | deps-blocked | review-wait | budget | operator-pause |
  sdk-outage`. `rate-limit`, `operator-pause`, and `sdk-outage` are **infrastructure time** —
  excluded from the item's flow-efficiency denominator and from aging, matching flow.md's rule that
  a rate-limit park must not age an item.
- **Aging runs on active/logical time.** Each transition carries `activeMsDelta` (active =
  wall-clock minus suspension intervals). `seq` is not an aging clock (it advances on *other* items'
  events, coupling one item's age to another's churn); `ts` is not either (it includes parks). The
  aging tick is defined from `activeMsDelta` (or the count of the item's own advancing transitions),
  never from `seq`/`ts`.
- **Close every claim.** Emit `pelaggio.claim-released { outcome: "shipped" | "shipwrecked" |
  "abandoned" | "failed" }` on *every* claim close, so WIP-over-time has a real close boundary for
  non-ship outcomes (not just `shipped`).

### Per-metric requirements (normative)

This table is **normative**: an event type a metric lists must carry the named immutable fields, and
the projection computes the metric by the stated formula from those fields alone — no join against
mutable git/provider.

| Metric | Events (immutable fields) | Formula |
|---|---|---|
| Throughput | `shipped { ts }` | count of `shipped` per time bucket |
| Lead time | `became-ready { ts, readinessEpisodeId }` + `shipped { ts, readinessEpisodeId }` | `shipped.ts − became-ready.ts`, joined on `readinessEpisodeId` |
| Cycle time | `claimed { ts, claimId }` + `shipped { ts, claimId }` | `shipped.ts − claimed.ts`, joined on `claimId` |
| Active time | every transition carries `activeMsDelta` | Σ `activeMsDelta` over the claim's events |
| Flow efficiency | paired `suspended { suspensionId, reason }` / `resumed { suspensionId }` | active ÷ (active + Σ *non-infra* suspension durations); `reason ∈ {rate-limit, operator-pause, sdk-outage}` excluded from the denominator |
| WIP-over-time | `claimed` + `claim-released { outcome }` for **every** close | running count of open claims (claimed − released) at each T |
| Aging | `became-ready { ts }` + `activeMsDelta` per transition | Σ active time since `became-ready`, excluding infra suspensions; never `seq`/`ts` |

## Extension seam (consumer-facing) — designed in, not deferred

pelaggio is published; consumers install it on their own repos. Every existing "pluggable" seam
(`RoadmapSource`, `StepProvider`, `notify.events`, effect kinds) is a **closed registry a consumer
selects from, never registers into** — extensible by us, not by them. The event catalog must not
repeat that ceiling silently.

- **Namespaced types.** `pelaggio.*` is reserved, closed, core-validated. Consumer/plugin events use
  a vendor/reverse-DNS prefix (`acme.security-scan`) and register a schema validator. Envelope
  validation is always core-owned; payload validation belongs to the registrant. This forecloses the
  core-vs-consumer `type` collision that a bare `shipped` would guarantee.
- **Publish a real contract (in #178), designed for by #170's envelope:** `EventReader` /
  `EventSink` / a reducer interface, plus an **opaque cursor** = segment identity + byte
  offset/watermark (`eventId` is for dedup and `(streamId, seq)` for gap diagnostics — neither is a
  resumable file position across concurrent streams or archived segments). The cursor protocol
  defines snapshot boundary, rotation behavior, backpressure, unknown-event delivery, and what an
  SSE subscriber does when its cursor has rotated out. A consumer builds a custom projection or a
  #171 `FlowPolicy` against *this* contract — one more reason the envelope (#170) is the thing to
  lock first, even though the contract itself ships in #178.
- **Read/subscribe seams:** `pelaggio events --follow` (CLI tail) and a server
  `/repos/:slug/events` SSE endpoint — distinct from the per-run stdout `log-broker`, which streams
  human logs, not structured events.
- **D-G corrected.** "Local-only" means *no raw event fan-out to the tracker* (the poisoned-issue
  blast-radius bound, which stays). It does **not** mean the consumer can't read their own stream:
  safe local subscribers and an explicitly-configured webhook are allowed. Write-back (#172) remains
  a whitelisted, typed *subset* projected to the tracker, never the raw stream.
- **Provider-neutral.** No Claude/Codex/OpenCode-specific fields. Cost-bearing events carry
  `costEstimated` (a Codex subscription reports estimates, not billed USD); failure and park reasons
  are the normalized enum above, never a raw runner subtype.

## Retention / rotation

Two distinct retention concerns the design previously conflated:

- **Live-projection snapshot** — a disposable cache keyed by a checksummed watermark; overwrite
  freely; never truth.
- **Historical event retention** — must survive rotation. Rotation is **archival (move, don't
  delete)** for any repo promising historical metrics; a snapshot never authorizes deleting the raw
  events a trend query needs. Cap encoded event size, assign a type-level retention class, keep the
  parser bounded, and emit corrupt-line diagnostics.

## Scope: split #170 into substrate / emission / subscription

The full catalog is too large for one `L` item (both final reviewers flagged it). Split into three
separately schedulable items; only the substrate is on the "lock now" rung.

- **#170 — substrate (lock-now).** The envelope + writer-local identity/ordering contract, append
  integrity + `streamId`/`seq` allocation, the dual-format legacy decoder + `readEventLog()` /
  `foldEvents()` reader library, the minimal lifecycle vocabulary, and golden-file compatibility
  tests. The "cannot be backfilled" core.
- **#177 (Flow 1b) — emission + metrics.** The three-producer emission wiring (effect-confirmed
  handler-outcome refactor; git-mutation intent/confirmation brackets; `became-ready`
  readiness-diff), fat per-metric payloads, paired suspensions, reconciliation (`state-observed` /
  `state-corrected`), and the normative metric projections.
- **#178 (Flow 1c) — subscription + extension.** The consumer registry + namespaced-type
  validation, the opaque cursor protocol, `pelaggio events --follow`, the server
  `/repos/:slug/events` SSE endpoint, and archival rotation.

## What #170 (substrate) locks vs. defers

**Lock before #170's implement cycle (cannot be backfilled):**
1. The identity/ordering contract (`eventId`, `streamId`, writer-local `seq`, `claimId`,
   `readinessEpisodeId`, `executionId`, `causationId`).
2. The fat-vs-derive split by storage rule, and the normative per-metric field requirements the
   envelope must carry (historical events self-contained; current-state derived on read).
3. Namespaced `type` (`pelaggio.*` closed; consumer prefixes registered).
4. The append protocol (one bounded write per record; per-process `streamId` + `seq` allocator).
5. The dual-format legacy decoder (untyped + `steps[]` → `pelaggio.cycle-completed`).

The three-producer emission model, per-metric payloads, and the subscription/extension seam are
*designed here* so the locked envelope serves them, but they are **built in #177/#178, not locked
into the substrate item.**

**Deferred (the tolerant reader absorbs these non-breakingly):**
- Per-event-type `schemaVersion` (add on first divergence).
- A broker / SQLite for cross-process global ordering (multi-orchestrator, a `packages/server`
  concern — must not drive the core primitive).
- Growing the event vocabulary beyond the minimal set.
- `WsjfPolicy` and class-of-service inputs (#171).

## Invariants (mirrored to AGENTS.md)

- Flow events are the immutable historical system-of-record; the live projection reconciles current
  state from git + provider (ground truth wins) and is authoritative only for derived metrics.
- Event identity is a unique `eventId` plus writer-local `(streamId, seq)`; `seq` is never globally
  monotonic. `claimId` is delivery identity, `readinessEpisodeId` correlates the pre-claim readiness
  window, `executionId` is per-process.
- Historical/time-series events are fat and self-contained; current-state is derived on read. Never
  re-derive a historical metric by joining mutable git/provider.
- Flow events are emitted harness-side by three producers — effect-confirmed (manifest-sourced),
  git-mutation (intent/confirmation bracket), and derived (orchestrator readiness-diff) — never from
  "the step completed."
- `type` is namespaced: `pelaggio.*` is closed/core-validated; consumer events carry a vendor prefix
  and register a schema. The reader is tolerant-with-diagnostic, never silent, and back-compatibly
  reads untyped legacy cycle records.
- Flow events live under `.dev/flow-events/` as one append-only segment per writer process
  (`<streamId>.jsonl`, single-writer-per-file — no shared-file concurrent append), separate from the
  cycle-log, sharing one envelope + reader library; they are local-only telemetry; durable/portable
  memory is write-back (#172), and raw events are never fanned into the tracker.
