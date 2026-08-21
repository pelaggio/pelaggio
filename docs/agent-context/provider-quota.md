# Provider Quota Telemetry & Seat Strategy (design)

**Status: design; chartered as #581–#586** (see Sequencing for the mapping). The nearest
pre-existing charters are #246
(pool-aware scheduling), #465/G2 (quota reserve/settle/refund ledger, ADR-0026 decision 9), #578
(quorum-of-2 degrade on typed infra fault), and #356 (per-step realized capabilities to flow
events). Related design docs: [`guarded-actions.md`](./guarded-actions.md) (P2 quota primitive),
[`flow-event-catalog.md`](./flow-event-catalog.md) (event envelope this rides),
[`adversarial-review-loop.md`](./adversarial-review-loop.md) (throughput-vs-diversity rationale).
Provider observations below are pinned: Claude Agent SDK 0.3.220, codex-cli 0.146.0, grok 0.2.103.

## The proposal in one sentence

Meter each provider's own quota grammar into typed events, project it into a per-pool headroom
snapshot, and let a configured strategy chain order seat allocation — gates unchanged.

Six tenets; everything below elaborates them, and where a detail and a tenet conflict, the tenet
wins:

1. **The provider knows its own pool.** Listen — reported > probed > estimated — never guess or
   configure absolute caps.
2. **Provenance sticks to the observation.** Channel and freshness live on each window/balance
   observation; no provider-level aggregate.
3. **Headroom is the currency.** Dollar budgets stay guardrails; allocation reasons in
   window/balance fractions.
4. **Strategy orders; gates decide; the harness parks.** Policy can only order candidates or hold
   demand classes — it can never mint, degrade, or park.
5. **Absent telemetry degrades to today.** Every chain ends in static rotation; monitoring
   failure can never stall work.
6. **Every decision is evidence.** Usage and allocation are fat, self-contained flow events.

## Problem

Pelaggio drains three subscription pools at once (Claude Max, Codex/ChatGPT, SuperGrok). Today:

- **The strategy layer exists only as prose.** The live `.pelaggio.yml` carries hand-maintained
  comments ("Claude-conservation posture", "grok currently has the most subscription room") that
  encode real allocation judgment nothing mechanizes or refreshes.
- **Budget tracking is dollar-denominated and provider-blind** (`DayBudgetTracker`,
  `sumDaySpendFromLog` in `continuous.ts`). Logged dollars are ~90% notional under subscriptions;
  the scarce resource is per-pool window headroom, which nothing measures.
- **Rate-limit parking is provider-anonymous.** `ParkSignal` (`types.ts`) has no provider field,
  Codex/Grok limit detection is regex over prose, `classifyParkReason` collapses window identity
  (5h vs weekly) to `"rate-limit"`, and non-Claude resets are synthesized from
  `park.unknownResetWait`. #578 names typed-at-emission fault classes as the blocking defect.
- **Concentration risk:** an exhausted grok Build balance 402s as opaque "Internal error"
  (`error_sdk`, not even parked — #428/#455) and blocks every PR.

## What the providers actually report (audited 2026-08-20)

The central finding: **each provider already knows its own pool, but through three different
grammars on three different surfaces.** Verdicts:

| Provider | Verdict | The grammar | What the harness does today |
| --- | --- | --- | --- |
| Claude | **Reported** (in-band, continuous) | SDK `rate_limit_event` carries `utilization`, `resetsAt`, window discriminant (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, …), `surpassedThreshold`, full overage state. Emitted whenever rate-limit info changes (rebuilt from per-response `anthropic-ratelimit-unified-*` headers), not only at rejection. A control method (`usage_EXPERIMENTAL…`) returns all windows + ISO resets in one call. | `step-runner.ts` drops every event unless `status === "rejected"`; keeps only `resetsAt` + `rateLimitType` at park time. The control method is never called. |
| Codex | **Partial** (grammar exists, wrong surface) | The `codex exec --json` stream the harness consumes has **no** rate-limit events. The same binary's `codex app-server` protocol exposes `account/rateLimits/read` / `account/rateLimits/updated` with `RateLimitSnapshot` (primary/secondary windows: `used_percent`, `window_minutes`, `resets_at`), credits, spend controls. The 429 body (`UsageErrorBody`) itself carries `resets_at` + `rate_limits`. | Prose regex on stderr/`turn.failed`; reset always synthesized (`resolveParkReset(0, …)`). The 429 body's typed reset is discarded with the rest of the prose. |
| Grok | **Absent in-band** | ACP usage is spend-so-far only (`costUsdTicks`, tokens, `modelCalls`) — no remaining, no reset. The billing grammar exists out-of-band (TUI `/usage`: `creditUsagePercent`, `monthlyLimit`, `prepaidBalance`, `billingPeriodStart`, `billingCycle`) but no billing RPC is in the ACP extension-method table. Candidate probes for a conformance spike: `x.ai/build/overview`, `x.ai/auth/check_subscription`. | 402 arrives as opaque text; `AcpRpcError.data` — the only place a structured body could survive — is dropped at `grok-provider.ts`. |

Claude window identity is **per model family** (`seven_day_opus` vs `seven_day_sonnet`), so the
meter must preserve window names end-to-end. Exploiting that intra-provider axis (shifting heavy
steps Opus→Sonnet when the Opus weekly is hot) is a **different seam** from seat ordering: today
`resolveDriverCandidates` resolves one model per provider and seat diversity forbids duplicate
providers, so model shifting would land at the step-model resolution seam (`MODEL_PROFILES` /
per-step model selection). It is out of scope for the strategy chain below and is chartered
separately (see Sequencing).

## Design: meter → projector → policy

Three pieces on the mechanism/policy spine (ADR-0014): deterministic typed telemetry and gates in
the harness; allocation preference as configured policy over a snapshot; they meet at a typed seam.

### Normal form — borrow the IETF RateLimit grammar, not a framework

One normalized quota grammar at the seam; provider adapters translate their native grammar into it
and strategies never see provider-native fields. The shape is borrowed from the IETF httpapi
*RateLimit header fields* draft — a **policy** (named windows with durations) plus **current
state** (used, reset) — with RFC 9110 `Retry-After` semantics for parks:

```ts
type QuotaChannel = "reported" | "probed" | "estimated";  // the quotaMeter axis (see below)

interface QuotaWindow {
  name: string;              // "five_hour" | "seven_day_opus" | provider-native id
  durationMs?: number;       // window length when known
  usedFraction?: number;     // subscription caps are opaque: fractions, not absolute counts
  resetsAt?: number;         // epoch ms
  channel: QuotaChannel;     // provenance is PER OBSERVATION, never per provider
  observedAt: number;        // freshness is per observation too
}
interface PoolState {
  provider: ProviderName;
  windows: QuotaWindow[];    // Claude/Codex geometry
  balance?: { remainingFraction?: number; exhausted: boolean;
              channel: QuotaChannel; observedAt: number };  // Grok geometry (spend-down)
}
```

Two geometries are deliberate: rolling **windows** (Claude, Codex) and a spend-down **balance**
(Grok Build). Both live in `PoolState`; a strategy that only understands one treats the other as
inapplicable.

Provenance and freshness live **on each window/balance observation, not on the provider**,
because providers update windows independently — a Claude `rate_limit_event` refreshes one window
at a time, and a projected pool routinely mixes reported, probed, and estimated observations of
different ages. Strategy predicates (`requires:`, `stale-after`) evaluate against the specific
windows a strategy names, never a provider-level aggregate: a fresh 5h report must not launder a
stale weekly estimate.

Pool identity is `(provider, poolId)`, where `poolId` is a **non-secret auth-realm
discriminator** — a digest of the provider's account/subscription identity when one is exposed,
else an auth-config epoch that bumps on credential change. Observations from different realms
never merge, and a realm change invalidates the provider's projection: a subscription or API-key
switch must not blend old-pool observations into the new pool. OpenCode pools are per-backend
realms.

Adjacent borrows, all vocabulary and zero dependencies (supply-chain posture: no install scripts):

- **RFC 9457 problem-details shape** for the typed fault classes #578 requires: a stable `type`
  slug assigned in the provider adapter (the one place that knows the provider), provider-native
  detail carried opaquely. A codex usage-limit 429 and a grok balance 402 become distinct typed
  facts at emission, never regex matches downstream.
- **OpenTelemetry `gen_ai` semantic conventions** for usage-event payload field naming
  (`gen_ai.usage.input_tokens`, …) so a future OTel export is a projection, not a migration.

### Channel hierarchy — reported > probed > estimated

The meter uses the best channel available for each observation and stamps it on that observation
(the `quota.telemetry` config below declares the *expected* channel per provider — it drives probe
scheduling and config validation; realized provenance is always the per-observation stamp):

- **reported** — in-band on the work stream. Claude today: stop discarding non-rejected
  `rate_limit_event`s; each becomes a `pelaggio.provider-usage` flow event.
- **probed** — out-of-band sidecar at cycle/seat boundaries. Codex: `codex app-server`
  `account/rateLimits/read` (experimental — lives behind the adapter, degrades to `estimated`).
  Grok: pending the conformance spike above.
- **estimated** — learned from park/limit events plus local token deltas. Terminal fallback for
  any provider; primary for Grok until a probe surface is evidenced.

A `quotaMeter` capability axis joins `costMeter` (ADR-0020), but it carries only the **static
fact** of which channels a provider *supports* (claude: reported; codex: probed; grok: estimated
until a probe surface is evidenced; opencode: estimated per configured backend, its observations
simply never fresh until a backend exposes metering — which config validation surfaces when a
chain entry `requires` better) — consumed by routing and config validation. Trust in any
particular headroom number comes from the per-observation `channel`/`observedAt` stamp, never
from the axis: capability axes are closed static facts and must not smuggle back the
provider-level aggregate the normal form forbids.

### Meter (mechanism): typed emission

- New closed-registry flow-event types: `pelaggio.provider-usage` — an **observation**, carrying
  only the windows/balance the provider actually reported in that observation plus `gen_ai.*`
  token fields, never a projected `PoolState` (emitting the projection would refresh sibling
  `observedAt` on merge and launder stale data; `PoolState` is projector *output* only) — and
  `pelaggio.provider-limit` (typed fault slug, window name, `resetsAt`, park linkage). Fat and
  self-contained per the catalog's historical rule.
- Provider-native fault detail survives as a **bounded, secret-scrubbed projection**: allowlisted
  fields plus a size cap under the writer's 64 KiB record limit, scrubbed recursively like the
  existing diagnostic bounding. Emission never throws on oversize — it truncates with a
  diagnostic; the limit/park path must not be taken down by its own telemetry.
- `ParkSignal` gains `provider` and window identity; `classifyParkReason` stops collapsing
  5h-vs-weekly (a weekly exhaustion is a categorically worse fact than a 5h one).
- Codex: parse the 429 `UsageErrorBody` (`resets_at`, `rate_limits`) at the adapter — real resets
  replace the synthesized `unknownResetWait` estimate.
- Grok: retain `AcpRpcError.data` end-to-end; type the 402 as `balance-exhausted` (#455/#428).
- Review-seat path stops discarding tokens (`ReviewPassRecord` currently keeps only cost/turns).

### Projector: the monitoring surface

A projection over flow events + cycle log, in `.dev/`, **non-authoritative** (flow invariant:
projections are caches; the provider's own limit response is ground truth). The projector merges
**by window name**: an observation updates only the window (or balance) it names, and sibling
windows keep their own `channel`/`observedAt` — a one-window Claude event can never clobber or
refresh the weekly windows it did not report. A reported/probed window is exposed **as the
provider reported it** — `usedFraction` is never synthesized locally, because converting a token
delta into a fraction needs a cap estimate, and stamping that onto a reported window would
launder estimated data under reported provenance. Accumulation between reports is exposed
alongside, as `spentSince: TokenUsage` per pool; learned calibration lives only in the
`estimated` tier. Surfaced as `npx pelaggio usage`
(per-provider windows/balance, channel, freshness, resets, recent parks) — replacing the
hand-maintained YAML comments as the operator's view of pool state.

### Policy: a configured strategy chain at the filter-then-order latitude

The strategy layer is **not** a scheduler or framework. It lands at the latitude the repo already
has — ADR-0020's two tiers: hard predicates filter fail-closed, soft predicates order. Quota
strategy is a config-driven source of *soft ordering* plus *defer*, slotted into the existing
selection sites:

- `driver-assignment.ts` rotation: cycle-modulo becomes the terminal fallback ordering; an
  applicable strategy supplies the ordering instead.
- `resolveDriverCandidates` pools: unchanged — pools still define what is allowed; strategy only
  orders within them.
- Fixed authoring seats (`provider-routing.ts`): stay config-authoritative; quota pressure
  influences only degrade/defer, which #578's quorum mechanism owns.
- Defer ("don't spend opportunistic work now") generalizes the existing dollar
  `budget-idle`/`budget-wake` machinery to per-pool headroom. No new scheduler.

**Gates stay gates.** The strategy function receives already-gate-valid candidates and returns an
ordering or holds. It structurally cannot mint candidates, weaken the diversity floor, bypass
`providerDiversity: require`, or touch the #578 quorum. When quota pressure would push below a
floor, the strategy's only output is a hold; parking stays harness mechanism — a hold that stalls
non-deferrable demand resolves at the demand site as the harness parking through `parkExit()`
with its checkpoint semantics, never as a policy-kind output. Any degrade below a floor is owned
solely by the #578 gate mechanism under its own typed-infra-fault conditions and recorded in the
gate record — never a strategy output, and never silent (the #384 lesson). Fail-open for
*ordering*, fail-closed only at *gates*.

Strategies are data in `.pelaggio.yml`, drawn from a **closed registry of kinds** (unknown kind
fails config parse, like the flow-event type registry). Every threshold is a parameter; no
behavior constant lives in code. Each kind has one of two **roles**, fixed by the registry, with
**role-specific signatures** — a constraint cannot emit an ordering, so it structurally cannot
shadow the ordering tier:

- **constraint** kinds (`reserve-headroom`): `(snapshot, demand) → holds`, a set of scoped
  per-class holds (`{demandClass, pools, reason, until}`). A hold is **scoped to the pools whose
  windows triggered it**: demand that would spend only on unheld pools proceeds — a hot Claude
  weekly must not stall codex/grok-only opportunistic work. *Every applicable* constraint
  applies; holds compose conjunctively. Constraints answer only "spend on this class, on these
  pools, now?", never "in what order".
- **ordering** kinds (`headroom-weighted`, `static-rotation`): `(snapshot, candidates, demand) →
  ordering`, a total order over the candidate seats. Exactly one applies — the *first applicable*
  in chain order; the terminal entry must be always-applicable.

```yaml
quota:
  telemetry:                     # expected channel per provider; realized provenance is per observation
    claude: reported
    codex: probed
    grok: estimated
  strategy:                      # constraints all apply; orderings: first applicable wins
    - kind: reserve-headroom     # constraint: hold opportunistic work when a window runs hot
      window: seven_day_opus
      gate-reserve: 0.15         # defer opportunistic demand above (1 − 0.15) used
      soak-after: 0.9            # release the hold once ≥90% of the window's TIME has elapsed
      requires: reported
    - kind: headroom-weighted    # ordering: order seats by named-window headroom
      stale-after: 30m           # named windows older than this → inapplicable
    - kind: static-rotation      # ordering, terminal: ≡ today's behavior, always applicable
```

Fall-through semantics: an entry is skipped on **inapplicability only** (required channel absent
on the windows it names, observation staler than `stale-after`, precondition unmet) — never
because it disliked its own output. `requires` and `stale-after` are chain-generic applicability
keys valid on any entry, not kind parameters. Deterministic, like a font stack, per role. The
terminal ordering reproduces current static behavior, so absent or stale telemetry degrades
exactly to today. Initial vocabulary is three kinds, a few parameters each; widen only when a
real posture (like the Claude-conservation comments) can't be expressed.

`headroom-weighted` must order a mixed candidate set — window pools and balance pools together;
the production authoring pool is grok + codex — so its comparable scalar is defined, not implied:
`headroom(pool)` is `min(1 − usedFraction)` over the windows the entry names (all fresh windows
when unnamed) for window geometry, and `remainingFraction` (`exhausted` ⇒ 0) for balance
geometry. Both mean "share of the period's capacity still unspent"; the cross-geometry comparison
is an explicit ordinal-only modeling choice — used to order, never for arithmetic across pools.
Pools with no fresh observation sort last (known before unknown); a fresh window that carries no
`usedFraction` is likewise *unknown* — except that an observation recording rejection or
exhaustion is `headroom 0`, not unknown, so a just-exhausted pool can never sort ahead of a
measured one. The entry is inapplicable only when *no* candidate pool has a fresh observation.
One consequence is accepted deliberately: until grok gains a probed/reported surface (Sequencing
item 4), its balance has no computable `remainingFraction` — learning one would need the absolute
cap the non-goals forbid guessing; a typed 402 sets `exhausted` ⇒ 0 and otherwise the pool is
unknown — so today's grok+codex authoring pool drives `headroom-weighted` toward its unknown-last
rule or falls through to `static-rotation`. That is the designed degradation; the ordering payoff
for grok arrives with the probe spike.

Demand carries a **priority class assigned at the call site**: `gate-blocking` (the
pr-review/pr-verify/revise/land path of a claimed item), `pipeline` (the authoring steps of a
claimed item — pick/plan/implement/shakedown/ship, including the rotation site in
`driver-assignment.ts`), or `opportunistic` (doc-review drains, background quality passes).
`reserve-headroom` is **advisory threshold policy, nothing more**: it holds the classes named by
its `hold-classes` parameter (default `[opportunistic]`) while a named window's `usedFraction` is
past the reserve line, and releases the hold near reset. `soak-after` is a fraction of the
window's **elapsed time** — not of `usedFraction`, whose units its neighbour `gate-reserve` uses —
computed from `resetsAt` and `durationMs`; when either is missing, the soak clause is
inapplicable and the hold stands. (Subscription windows are spend-it-or-lose-it, so end-of-window
headroom is free throughput; releasing on *usage* instead of *time* would invert the conservation
posture by dropping the hold at peak spend.) Note the division of labor
that mechanizes the Claude-conservation posture: *whether* to spend now is a constraint hold, per
class; *where* pipeline work spends is ordering — `headroom-weighted` pushes a hot Claude to the
back of the authoring rotation without stalling the cycle while codex/grok have room. A
constraint holds no resource: there is no reservation handle, and nothing settles or refunds
against the remote pool — the provider is the sole authority on its own quota, and an opaque
`usedFraction` is not a divisible unit that could be reserved (guarded-actions P2 requires
divisible, attributable units). A real per-pool ledger in the G2/#465 shape —
reserve/settle-observed/refund-unused over **locally metered tokens**, which are divisible and
attributable to a cycle — is separate, deferred work, and a **prerequisite for #246's
pool-parallel cycles**. Its honest scope: it coordinates *local* concurrent spenders against a
locally estimated capacity (calibrated from observed fraction-per-token deltas), so it reduces
overcommit rather than preventing it — the provider remains the sole authority on its pool, and
the fence against actual exhaustion stays typed limit signals + parking.

Each strategy kind is a pure function of its role signature, deterministic given its inputs, with
table-driven tests — the adapter-tiers-plus-conformance-suite discipline. The demand descriptor
carries the deterministic context this requires, including the rotation inputs today's behavior
consumes (`cycle`, `authoringOrdinal`), so `static-rotation` reproduces the current cycle-modulo
rotation exactly from its declared inputs. Every decision emits `pelaggio.allocation-decided`, **fat and self-contained** per the
catalog's historical rule: the resolved chain (every entry's kind and resolved parameter values,
not a config reference), the material inputs consulted (per-window fractions, channels, and
freshness as of the decision), the demand descriptor (priority class, artifact class, candidate
seats), applied holds, skipped entries with reasons, and the resulting ordering or defer.
Historical decisions stay reproducible and comparable after any config change — evidence at
emission, so chains are debuggable from the log alone.

## Invariants this design must respect

- Mechanism/policy spine: telemetry, gates, and park behavior are deterministic harness mechanism;
  strategy is configured policy over a typed snapshot; the model is never the gate.
- FlowPolicy discipline: strategies see a snapshot, not storage.
- Projection non-authoritative; the provider's own limit signal is ground truth; historical usage
  is authoritative in the append-log as fat events.
- Panel stability: no provider switch mid-artifact or mid-review-series (`docs/config.md` already
  states this); strategy applies at series/cycle start.
- Diversity is a floor per artifact class, never a score the strategy trades against.
- Borrow grammars, never dependencies.

## Non-goals

- No client-side rate limiting or token-bucket enforcement — the meter models *remote* pool state.
- No absolute-cap config knobs pretending to know unpublished subscription limits; fractions and
  provider-reported resets only.
- No persistent scheduler/claims-registry-like authority; `PoolState` is advisory input to
  ordering and defer, and evaporates with `.dev/`.
- Dollar day-budgets remain as an overall guardrail; they are not the allocation currency.

## Sequencing

1. (#581) **Claude telemetry retention + typed park windows** — emit non-rejected `rate_limit_event`s as
   `pelaggio.provider-usage`; `provider` + window identity on `ParkSignal` and the park log. Near-
   zero code; live 5h/weekly/opus/sonnet utilization for the biggest pool.
2. (#582) **Typed limit emission for Codex/Grok** — parse codex `UsageErrorBody` (real resets), retain
   `AcpRpcError.data`, type the grok 402. This is #578's stated prerequisite. #455 is closed; the
   402 *disposition* belongs to G5/#468's default-deny unavailable-allowlist — this step supplies
   that gate its typed input rather than duplicating the charter.
3. (#584) **Codex app-server probe** (`account/rateLimits/read`) behind the adapter.
4. (#585) **Grok conformance spike** — probe `x.ai/build/overview` / `x.ai/auth/check_subscription` for
   balance state; pinned-conformance work per `acp-grok-protocol.md` discipline.
5. (#583) **Projector + `pelaggio usage`** — read-only monitoring; no behavior change.
6. (#586) **Strategy seam** — registry with constraint/ordering roles + chain config + fat
   `allocation-decided` evidence. Single-writer only; no cross-cycle contention yet.
7. **Per-pool ledger, then #246** — a G2/#465-shaped reserve/settle-observed/refund-unused ledger
   over locally metered tokens per pool; #246's pool-parallel cycles land only on top of it.
   Intra-provider model shifting (Opus→Sonnet at the `MODEL_PROFILES` seam) is chartered
   separately if wanted; it is not part of the strategy chain.

Landing this rewrites the `docs/config.md` "no persisted quota, credential-seat, cooldown, or
cross-worker fairness state" non-goal: the cycle-local readiness policy stays stateless *because*
pool state lives in the projector behind the strategy seam — same principle, relocated. The
paragraph must be updated in the same change that ships the projector.
