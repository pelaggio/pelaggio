# Plan #586 — Quota strategy seam: registry, chain config, allocation evidence

Charter: issue #586. Final increment of `docs/agent-context/provider-quota.md` (tenets 3, 4, 5,
6) — the only item in the chain that touches selection behavior, and its terminal fallback
reproduces current behavior exactly. Chain position: #581 (telemetry, **planned** — branch
`feat/issue-581-claude-rate-limit-telemetry`) → #583 (projection + `pelaggio usage`, **planned**
— branch `feat/issue-583-per-pool-quota-projection`) → **#586 (this: strategy seam)** → per-pool
ledger → #246. Both upstream plans are binding contracts here — this plan consumes #583's
`UsageSnapshot`/`PoolState`/`QuotaWindow`/`PoolBalance` shapes and #581's flow-event plumbing
exactly as those plans fix them, re-deciding nothing — and this item's implementation lands
after theirs.

## Acceptance criteria (from the charter)

- **AC-1**: with no `quota.strategy` configured (or all telemetry absent/stale), selection is
  byte-identical to today (regression-tested against current driver-assignment behavior).
- **AC-2**: with fresh telemetry and a headroom-weighted chain, seat order follows the defined
  scalar; table-driven tests per kind.
- **AC-3**: every allocation in a live cycle produces a self-contained `allocation-decided`
  event reproducible from the event alone.
- **AC-4**: diversity floor, `providerDiversity: require`, and #578 quorum behavior are
  untouched (existing gates keep their tests).
- **AC-5**: the `docs/config.md` "no persisted quota state" non-goal paragraph is rewritten per
  the design doc.

## Binding invariants (restated; the plan must not drift from these)

- **Mechanism/policy spine (ADR-0014)**: a strategy is deterministic policy code over a typed
  snapshot — a pure function of its declared inputs, never a model call, never a prompt. The
  blocking gate stays deterministic harness mechanism; the seam only orders already-gate-valid
  candidates.
- **FlowPolicy discipline**: strategies see a snapshot, not storage. No strategy reads
  `.dev/flow-events/`, config files, the clock, or the environment; everything arrives through
  its role signature.
- **Strategy orders; gates decide; the harness parks** (tenet 4): a strategy structurally
  cannot mint candidates, weaken the diversity floor, bypass `providerDiversity: require`,
  touch the #578 quorum, or park. Constraint kinds cannot emit an ordering (role-specific
  signatures make shadowing impossible).
- **Absent telemetry degrades to today** (tenet 5): every chain ends in an always-applicable
  static rotation; monitoring failure can never stall work. Fail-open for ordering, fail-closed
  only at gates and at config parse.
- **Every decision is evidence** (tenet 6): fat, self-contained `pelaggio.allocation-decided`
  events, evidence recorded at emission, reproducible without joining mutable state.

## Current mechanism (audited at HEAD `01cbc8a` + the two upstream plan contracts)

- **The rotation site** (`driver-assignment.ts`, 59 lines, pure): `selectAuthor(state,
  candidates, isAvailable)` computes `offset = state.cycle + state.authoringOrdinal`,
  post-increments `authoringOrdinal`, and returns the first available driver of
  `rotated(candidates, offset)`. `selectReviewers(state, candidates, author, count,
  isAvailable)` filters `rotated(candidates, state.cycle)` by author-provider exclusion,
  distinct providers, and availability, then takes the first `count`. `resolveStaticAuthor` is
  an attribution-reconstruction fallback (#245), not an allocation — untouched here.
- **Call sites** (`pipeline.ts`): `driverCandidates(step)` (`:1360-1364`) maps
  `resolveDriverCandidates` → `DriverIdentity[]`; `available` (`:1365-1385`, test seam
  `providerAvailableForTests`) probes executables. Four demand sites: plan author (`:1423`),
  shakedown-plan reviewer (`:1466`), implement author (`:1498`), shakedown-code reviewer
  (`:1945`). All flow through the two `driver-assignment.ts` functions.
- **Pools and fixed seats stay out of scope by design**: `resolveDriverCandidates`
  (`config.ts:1028-1035`) defines what is allowed (unchanged); authoring-review seats
  (`provider-routing.ts` `resolveAuthoringReviewConfig`) are fixed configured seats with no
  pool draw (unchanged); `pr-review` pools are fan-out sets, not selection (unchanged).
- **Config parse style** (`config.ts`): hand-rolled fail-closed structural validation, dotted
  keys in messages (`` `${configPath}: expected \`review.taxonomy.owner\` …` ``), kebab-case
  keys, nested-block parse delegated to a sibling module when the logic is substantial
  (`review/taxonomy.ts` → `resolveTaxonomy`, imported by `config.ts`). Import-graph
  constraint: `helpers.ts` imports `config.ts`, so any module `config.ts` imports must not
  import `helpers.ts` (rules out reusing `parseWaitFlag`, whose silent 6h fallback is wrong
  for fail-closed config anyway).
- **What #583 will provide** (its plan is the contract): `UsageSnapshot { generatedAt, pools:
  PoolState[], foreignPools, diagnostics }`; `PoolState { provider, poolId, realmSource,
  windows: QuotaWindow[], balance?, burn, recentLimits, newestObservationAt? }`; `QuotaWindow
  { name, durationMs?, usedFraction?, status?, resetsAt?, channel, observedAt, attribution? }`
  (usedFraction only as provider-reported, never synthesized); `PoolBalance
  { remainingFraction?, exhausted, channel, observedAt }`. The projector applies **no TTL** —
  staleness thresholds are explicitly deferred to this item's chain keys. One pool per
  provider (current realms only). Exports: `projectPoolState`, `derivePoolRealm`,
  `configuredProviders` (`quota-projection.ts`); `QuotaChannel` from #581 in `types.ts`.
- **What #581 will provide**: run-scoped flow-event writer; `PipelineOpts.emitFlowEvent?:
  (input: FlowEventInput) => void` (fail-open contract, absent for dry runs and direct
  `runPipeline` callers); `appendTelemetryEvent` never-throws append in
  `provider-telemetry.ts`.
- **Flow-event substrate (live at HEAD)**: closed `PELAGGIO_EVENT_TYPES` registry with the
  `EVENT_TYPE_COVERAGE` lockstep guard, fail-closed `decodeV1` on append,
  `MAX_FLOW_EVENT_BYTES = 64 KiB`, tolerant-with-diagnostic reader. Adding a type =
  union member (`types.ts:264-284`) + registry entry + payload validator.
- **The operator posture being mechanized**: the live `.pelaggio.yml`'s hand-maintained
  conservation comments — hold opportunistic spend when a Claude window runs hot; prefer the
  pool with room. Today nothing reads or refreshes that judgment.

## Design decisions

1. **Chain semantics are charter-fixed: constraints all-apply, orderings first-applicable-wins.
   Not scored.** Two roles with role-specific signatures in a closed registry: **constraint**
   `(qualified snapshot, demand, now) → holds` — *every* applicable constraint applies and
   holds compose conjunctively — and **ordering** `(qualified snapshot, demand, candidates) →
   total order` — exactly the *first applicable* in chain order applies; the terminal entry is
   always applicable. Justification over a scored blend: (a) deterministic and explainable
   like a font stack — the evidence names the one entry that ordered and why the ones above it
   fell through, where a weighted score is a number with no reconstruction story; (b) scoring
   would invite arithmetic across the window/balance geometries that the design doc
   explicitly restricts to ordinal-only comparison; (c) role separation makes it structurally
   impossible for a constraint to shadow the ordering tier — a scored pipeline mixing both
   roles into one number cannot make that guarantee.
2. **Unconfigured = implicit `[static-rotation]` chain; configured chains must end in a
   terminal ordering, fail-closed.** Absent `quota:` (or absent `quota.strategy`) resolves to
   `strategy: null`, which the seam runs as the implicit default chain
   `[{ kind: "static-rotation" }]` with `chainSource: "default"` — no snapshot read (decision
   9), no holds possible, ordering identical to today's `rotated()` (AC-1), evidence still
   emitted (AC-3). A *configured* chain must have a terminal-capable ordering kind
   (`static-rotation`) as its **last entry** or config parse fails with a message naming the
   fix — no silent auto-append, because the committed config is the operator's honest record
   of the degradation path (tenet 5 should be visible in the file, not injected behind it).
   `requires`/`stale-after` are rejected on terminal kinds at parse (they would break the
   always-applicable contract). An empty `strategy: []` fails parse the same way.
3. **The engine evaluates over a `ConsultedSnapshot` — evidence reproducibility is structural,
   not aspirational.** `consultedFrom(snapshot: UsageSnapshot): ConsultedSnapshot` projects
   exactly the fields any registered kind may read (per-pool identity + windows
   `{name, usedFraction, status, resetsAt, durationMs, channel, observedAt}` + balance;
   never burn, recentLimits, foreignPools, diagnostics, or attribution) plus `generatedAt`
   and a domain-separated 12-char digest (`pelaggio.quota.consulted.v1`, Crockford — the
   `digestId` house pattern). `decideAllocation()` takes only `(chain, consulted, demand,
   candidates, now)` — it never sees a `UsageSnapshot` — and the evidence event embeds the
   `ConsultedSnapshot` verbatim. AC-3's "reproducible from the event alone" is then a type
   fact: re-running `decideAllocation` on the event's own fields must reproduce the recorded
   holds and ordering, and a test asserts it. Strategies see a snapshot, not storage — by
   construction.
4. **Applicability = engine-owned qualification + kind-owned precondition; fall-through on
   inapplicability only.** `requires` and `stale-after` are chain-generic keys valid on any
   non-terminal entry, evaluated by the engine against the observations the entry names —
   never a provider-level aggregate. Each registry kind declares `namedWindows(entry)` →
   `string[] | "all" | "none"`; the engine hands the kind a per-entry **qualified view**:
   windows filtered to the named set, channel rank ≥ `requires` (reported > probed >
   estimated; a better channel always satisfies a lesser requirement), and
   `now − observedAt ≤ staleAfterMs`; balance observations qualify under the same
   channel/staleness keys for `"all"`-scoped entries. The kind then decides applicability
   from the qualified view (reserve-headroom: the named window survives on ≥ 1 candidate
   pool; headroom-weighted: ≥ 1 candidate pool has any qualified observation;
   static-rotation: always). An entry is skipped on inapplicability **only** — never because
   it disliked its own output — and every skip records a typed reason string in the evidence
   (`no-snapshot`, `stale: …`, `channel below required: …`, `window not observed: …`).
   Defense in depth for tenet 5: an ordering kind returning a non-permutation (registry bug)
   is treated as inapplicable with reason `invalid ordering output` and falls through — the
   terminal entry cannot be malformed by construction, so ordering always resolves.
5. **The three kinds, spec'd exactly (all pure, table-tested):**
   - **`static-rotation`** (ordering, terminal, `needsSnapshot: false`): returns the index
     permutation of `rotated(candidates, demand.cycle + demand.ordinal)`. This is today's
     behavior verbatim: author demands carry `ordinal = state.authoringOrdinal` (read before
     the existing post-increment), reviewer demands carry `ordinal = 0` (today's reviewer
     offset is `state.cycle` alone, ≡ `cycle + 0`).
   - **`headroom-weighted`** (ordering, `needsSnapshot: true`; params: optional `windows:
     [names…]`): the defined cross-geometry scalar, ordinal-only. Per candidate pool
     (matched by provider; one pool per provider in the snapshot): window geometry —
     over qualified windows (the named subset when `windows` is set, else all), a window with
     `status: "rejected"` contributes `0`, else `1 − usedFraction` when `usedFraction` is
     present, else nothing; the pool's window scalar is the minimum contribution, `unknown`
     when no window contributes. Balance geometry — `exhausted ⇒ 0`, else
     `remainingFraction` when present, else `unknown`. A pool with both geometries takes the
     minimum of its known scalars (conservative); a pool with neither known — including a
     provider absent from the snapshot — is `unknown`. Order: start from the base order
     `rotated(candidates, cycle + ordinal)` (the same rotation the terminal would use), then
     stable-sort descending by scalar with all `unknown` pools after all known ones
     (known-before-unknown; a just-exhausted pool sorts behind every measured one but never
     behind an unknown one — it is `0`, not unknown). Ties and the all-known-equal case
     therefore preserve rotation fairness, and the all-unknown case degrades to exactly the
     terminal's order. Applicable only when ≥ 1 candidate pool has a qualified observation.
   - **`reserve-headroom`** (constraint, `needsSnapshot: true`; params: `window` (name,
     required), `gate-reserve` (required, in (0,1)), `soak-after` (optional, in (0,1]),
     `hold-classes` (default `["opportunistic"]`)): for each candidate pool whose qualified
     view retains the named window `w` — hot iff `w.status === "rejected"` or
     `w.usedFraction > 1 − gateReserve`; the soak clause releases a hot pool iff `soakAfter`,
     `w.resetsAt`, **and** `w.durationMs` are all present and
     `(now − (resetsAt − durationMs)) / durationMs ≥ soakAfter` (soak is a fraction of the
     window's **elapsed time**, never of usage — subscription windows are
     spend-it-or-lose-it; when `resetsAt` or `durationMs` is missing the soak clause is
     inapplicable and the hold stands). Output: one `QuotaHold` per `(holdClass × hot
     pool)`, `{ demandClass, pools: [that pool], reason: "<window> usedFraction <f> past
     reserve line <1−gateReserve>", until: w.resetsAt }` — scoped to the pools whose windows
     triggered it, so demand spending only on unheld pools is never named. No hot pools →
     applied with zero holds (a constraint that found nothing to hold still *applied*).
     A stale named observation is disqualified by `stale-after` and the entry skips —
     releasing rather than holding on data too old to trust is the deliberate direction
     (holds are advisory threshold policy, and the fail-open side of this seam).
6. **Wiring: ordering input only; holds are computed and recorded, not yet enforced.** The
   charter is explicit ("slot into existing selection sites as ordering input only"), and
   both wired sites carry demand class `pipeline` while `reserve-headroom` defaults to
   holding `opportunistic` — there is no opportunistic demand site in this item.
   `selectAuthor`/`selectReviewers` gain an optional `context?: { advisor:
   AllocationAdvisor; step: Step }` parameter: when present, the strategy ordering replaces
   `rotated(...)` and **everything else is unchanged** — `find(isAvailable)`,
   author-provider exclusion, distinct-provider filter, `count` slice, and the
   `authoringOrdinal` post-increment all stay mechanism, applied after ordering (AC-4:
   diversity and availability are gates/filters the strategy never touches). When the
   context is absent, the advisor returns `null` (any internal failure), or advisor
   construction itself failed, the legacy `rotated()` path runs byte-identically with one
   dim diagnostic. Holds land in the evidence event with `holdsEnforced: false`; wiring hold
   consumption into a defer/park demand site (the `budget-idle` generalization) is future
   work at those sites, named a non-goal. Parking stays harness mechanism.
7. **Demand classes are a closed vocabulary threaded at call sites.** `DemandClass =
   "gate-blocking" | "pipeline" | "opportunistic"` lands in `types.ts`; the demand
   descriptor (`AllocationDemand { demandClass, site, step, cycle, ordinal }`) is built
   inside `selectAuthor`/`selectReviewers` from assignment state plus the caller's step.
   Both wired sites emit `pipeline` (they are authoring steps of a claimed item). The
   gate-blocking and opportunistic classes ship as vocabulary only — their call sites
   (pr-review/verify/revise/land; doc-review drains) are not selection sites in this item
   and arrive with the work that wires them. No field is added to step invocations or logs.
8. **Evidence: `pelaggio.allocation-decided`, one per decision, fat and self-contained,
   fail-open.** New closed-registry member + `decodeV1` validator. Payload (schema below):
   site, step, the demand descriptor plus a top-level `decidedAt`, the candidate identities, `chainSource`
   (`configured | default`), the **resolved chain with parameter values** (never a config
   reference — historical decisions stay comparable across config changes), the embedded
   `ConsultedSnapshot` (or `null` when no entry needed one), the per-entry trace
   (`applied` with holds/ordering | `skipped` with reason | `not-reached` for orderings
   below the first applicable one), the composed holds, the resulting ordering (identities,
   in order), `orderedBy`, and `holdsEnforced: false`. Emitted by the advisor through
   `opts.emitFlowEvent` (#581's fail-open wrapper) wrapped in its own try/catch — a lost
   evidence record logs one dim diagnostic and never affects selection. Where there is no
   writer (dry runs, direct `runPipeline` callers, review CLIs) no event is written — AC-3
   is scoped to live cycles, which always run under the orchestrator's run-scoped writer.
   Record size is structurally small (≤ 4 pools × few windows); no bounding path needed
   beyond the writer's existing 64 KiB fail-closed check.
9. **Snapshot acquisition is harness-side, lazy, once per cycle, fail-open.** The pipeline
   constructs the advisor once per `runPipeline` invocation (beside `driverCandidates`).
   The consulted snapshot is produced only when the resolved chain contains a
   `needsSnapshot` kind (the implicit default chain never reads anything — unconfigured
   runs add zero I/O), via #583's exports (`readEventLog` → `derivePoolRealm` per
   configured provider → `projectPoolState` → `consultedFrom`), memoized for the cycle
   (panel-stability posture: strategy applies at cycle start; every decision in the cycle
   sees one consistent snapshot, and its `generatedAt`/digest in each event make that
   auditable). Any throw inside acquisition → `undefined` → every `needsSnapshot` entry
   skips with reason `no-snapshot` → terminal ordering (tenet 5). `now` is sampled per
   decision (`Date.now`, DI for tests) and recorded as `decidedAt`.
10. **`quota.telemetry` parses closed and validates the chain's expectations; mismatches
    warn, structure fails.** `quota.telemetry` is a map of registered provider name →
    `QuotaChannel`; unknown provider keys and non-channel values fail parse (the
    `providers` block precedent). Its *use* in this item is config validation only (probe
    scheduling is #584/#585): `validateQuotaStrategy(quota)` returns warning strings for
    any entry whose `requires` exceeds every declared provider expectation (a
    never-applicable entry — surfaced, per the design doc, not fatal, since realized
    provenance is per-observation and future providers may improve). Warnings are collected
    on the resolved config and logged once at advisor construction.
11. **Module placement respects the import graph and house boundaries.** New
    `quota-strategy.ts` (single-purpose; runtime imports are `types.ts` + `node:crypto`
    only — parseable by `config.ts` without a cycle, mirroring `review/taxonomy.ts`):
    registry, config parse,
    strict duration parse, `consultedFrom`, `decideAllocation`, advisor factory, evidence
    builder. Pure decision/pool types land in `types.ts` (type-only, beside #583's pool
    types); config-coupled entry types stay in `quota-strategy.ts`. `driver-assignment.ts`
    stays free of I/O — it only calls the injected advisor. One deliberate wrinkle:
    `quota-strategy.ts` references `DriverIdentity` (declared in `driver-assignment.ts`)
    and `driver-assignment.ts` references `AllocationAdvisor` — both cross-references are
    **`import type` only**, erased at compile time, so no runtime module cycle exists (and
    `config.ts`'s import of `quota-strategy.ts` stays acyclic); the implementer must not
    promote either to a value import.

## Schemas

### `.pelaggio.yml` (new top-level `quota:` block; every key optional, kebab-case)

```yaml
quota:
  telemetry:                     # expected channel per provider (config validation now;
    claude: reported             # probe scheduling arrives with #584/#585)
    codex: probed
    grok: estimated
  strategy:                      # constraints all apply; orderings: first applicable wins;
    - kind: reserve-headroom     #   the LAST entry must be a terminal ordering (static-rotation)
      window: seven_day_opus
      gate-reserve: 0.15         # hold named classes above (1 − 0.15) used
      soak-after: 0.9            # release once ≥ 90% of the window's TIME has elapsed
      hold-classes: [opportunistic]   # default
      requires: reported         # chain-generic applicability key
      stale-after: 2h            # chain-generic applicability key ("6h", "90m", "1h30m", bare minutes)
    - kind: headroom-weighted
      stale-after: 30m
      # windows: [five_hour, seven_day]   # optional: scope the scalar to named windows
    - kind: static-rotation      # terminal: ≡ today's rotation, always applicable
```

Parse rules (all fail-closed, `config.ts` style messages with dotted keys): `quota` and each
entry are maps; unknown keys inside `quota`, `quota.telemetry`, and each strategy entry fail;
`kind` must be in the closed registry (unknown kind → fail); per-kind params validated with
ranges as in decision 5; `requires` ∈ `reported|probed|estimated`; `stale-after` is a strict
duration (local parser; unparseable fails — no `parseWaitFlag` fallback); `requires`/
`stale-after` on a terminal kind fail; the last entry must be a terminal ordering kind;
`strategy: []` fails. Absent `quota` or absent `quota.strategy` → `strategy: null`.

### Types (`types.ts`, beside the #583 pool types; type-only)

```ts
export type QuotaStrategyKind = "reserve-headroom" | "headroom-weighted" | "static-rotation";
export type DemandClass = "gate-blocking" | "pipeline" | "opportunistic";
export type AllocationSite = "author-rotation" | "reviewer-rotation";

/** Deterministic context for one allocation decision, built at the call site. */
export interface AllocationDemand {
	demandClass: DemandClass;
	site: AllocationSite;
	step: Step;
	cycle: number;
	/** Rotation ordinal today's behavior consumes: authoringOrdinal (author) / 0 (reviewer). */
	ordinal: number;
}

/** One scoped constraint hold. Advisory in this item (recorded, not enforced). */
export interface QuotaHold {
	demandClass: DemandClass;
	pools: readonly { provider: ProviderName; poolId: string }[];
	reason: string;
	until?: number; // epoch ms; the triggering window's resetsAt when known
}

/** The exact snapshot slice strategies may consult — embedded verbatim in evidence. */
export interface ConsultedWindow {
	name: string;
	usedFraction?: number;
	status?: "allowed" | "allowed_warning" | "rejected";
	resetsAt?: number;
	durationMs?: number;
	channel: QuotaChannel;
	observedAt: number;
}
export interface ConsultedBalance {
	remainingFraction?: number;
	exhausted: boolean;
	channel: QuotaChannel;
	observedAt: number;
}
export interface ConsultedPool {
	provider: ProviderName;
	poolId: string;
	realmSource: PoolRealmSource;
	windows: readonly ConsultedWindow[];
	balance?: ConsultedBalance;
}
export interface ConsultedSnapshot {
	generatedAt: number;
	digest: string; // 12-char Crockford sha256, domain "pelaggio.quota.consulted.v1"
	pools: readonly ConsultedPool[];
}

export type StrategyEntryOutcome =
	| { kind: QuotaStrategyKind; outcome: "applied"; holds?: readonly QuotaHold[]; ordering?: readonly number[] }
	| { kind: QuotaStrategyKind; outcome: "skipped"; reason: string }
	| { kind: QuotaStrategyKind; outcome: "not-reached" };

export interface AllocationDecision {
	ordering: readonly number[];       // permutation of candidate indices
	orderedBy: QuotaStrategyKind;      // kind of the first applicable ordering entry
	holds: readonly QuotaHold[]; // conjunctive union across applied constraints
	entries: readonly StrategyEntryOutcome[]; // full per-entry trace, chain order
	consulted: ConsultedSnapshot | null;
	decidedAt: number;
}
```

`PelaggioEventType` gains `"pelaggio.allocation-decided"`.

### Registry and advisor (`quota-strategy.ts`)

```ts
export type ResolvedStrategyEntry =
	| { kind: "reserve-headroom"; window: string; gateReserve: number; soakAfter?: number;
	    holdClasses: readonly DemandClass[]; requires?: QuotaChannel; staleAfterMs?: number }
	| { kind: "headroom-weighted"; windows?: readonly string[]; requires?: QuotaChannel; staleAfterMs?: number }
	| { kind: "static-rotation" };

export interface QuotaConfig {
	telemetry: Partial<Record<ProviderName, QuotaChannel>>;
	/** null = unconfigured → the seam runs DEFAULT_QUOTA_STRATEGY (chainSource "default"). */
	strategy: readonly ResolvedStrategyEntry[] | null;
	warnings: readonly string[];
}

export const DEFAULT_QUOTA_STRATEGY: readonly ResolvedStrategyEntry[] = [{ kind: "static-rotation" }];

export function parseQuotaConfig(value: unknown, configPath: string): QuotaConfig;
export function consultedFrom(snapshot: UsageSnapshot): ConsultedSnapshot;
// `registry` defaults to the closed built-in table; overridable only so tests can inject a
// misbehaving kind def (non-permutation output, forced throw) without widening the closed set.
export function decideAllocation(chain: readonly ResolvedStrategyEntry[], consulted: ConsultedSnapshot | undefined,
	demand: AllocationDemand, candidates: readonly DriverIdentity[], now: number,
	registry?: Record<QuotaStrategyKind, StrategyKindDef>): AllocationDecision;

/** Harness-constructed closure the selection functions consult. Never throws; null = fall back. */
export interface AllocationAdvisor {
	order(demand: AllocationDemand, candidates: readonly DriverIdentity[]): readonly DriverIdentity[] | null;
}
export function createAllocationAdvisor(opts: {
	chain: readonly ResolvedStrategyEntry[];
	chainSource: "configured" | "default";
	getConsulted: () => ConsultedSnapshot | undefined; // lazy, memoized, fail-open (harness-side)
	emit?: (input: FlowEventInput) => void;            // #581's fail-open emitFlowEvent
	itemId: () => string | null;
	now?: () => number;
	log?: (line: string) => void;
}): AllocationAdvisor;
```

The registry is a closed `Record<QuotaStrategyKind, StrategyKindDef>` with an
`EVENT_TYPE_COVERAGE`-style mapped-type guard; `StrategyKindDef` is a role-discriminated union
(`role: "constraint"` defs return holds, `role: "ordering"` defs return an index permutation;
plus `terminal`, `needsSnapshot`, `namedWindows(entry)`, and `parseParams(raw, path)`), so a
constraint structurally cannot emit an ordering.

### `pelaggio.allocation-decided` (payload beside the standard envelope)

```jsonc
{
  "v": 1, "type": "pelaggio.allocation-decided", /* eventId/streamId/seq/ts/executionId… */
  "itemId": "586",
  "site": "author-rotation",            // "author-rotation" | "reviewer-rotation"
  "step": "implement",
  "demand": { "class": "pipeline", "cycle": 12, "ordinal": 1 },
  "decidedAt": 1774123456789,
  "candidates": [ { "provider": "claude", "model": "claude-opus-4-8" }, { "provider": "codex" }, { "provider": "grok" } ],
  "chainSource": "configured",          // "configured" | "default"
  "chain": [                            // resolved entries with parameter VALUES, config-independent
    { "kind": "reserve-headroom", "window": "seven_day_opus", "gateReserve": 0.15, "soakAfter": 0.9,
      "holdClasses": ["opportunistic"], "requires": "reported" },
    { "kind": "headroom-weighted", "staleAfterMs": 1800000 },
    { "kind": "static-rotation" }
  ],
  "consulted": { /* ConsultedSnapshot verbatim: generatedAt, digest, pools[] */ },   // null when no entry needed it
  "entries": [
    { "kind": "reserve-headroom", "outcome": "applied",
      "holds": [ { "demandClass": "opportunistic", "pools": [ { "provider": "claude", "poolId": "4F2K9QW1T8ZC" } ],
                   "reason": "seven_day_opus usedFraction 0.88 past reserve line 0.85", "until": 1774130000000 } ] },
    { "kind": "headroom-weighted", "outcome": "applied", "ordering": [1, 2, 0] },
    { "kind": "static-rotation", "outcome": "not-reached" }
  ],
  "holds": [ /* union of applied holds, as above */ ],
  "ordering": [ { "provider": "codex" }, { "provider": "grok" }, { "provider": "claude", "model": "claude-opus-4-8" } ],
  "orderedBy": "headroom-weighted",
  "holdsEnforced": false                // this item wires ordering only; defer/park consumption is future work
}
```

Fail-closed validation (`decodeV1`): `site`/`demand.class`/`chainSource` in closed sets;
`chain` and `entries` non-empty arrays with non-empty `kind` strings; entry `outcome` in the
closed set; `candidates`/`ordering` arrays of records with registered `provider`; numeric
fields finite; `decidedAt` a positive safe integer; `consulted` null or structurally a
`ConsultedSnapshot` (non-empty `digest`, per-window `channel` in the closed set).

## File-by-file changes

1. **`packages/pelaggio/scripts/pelaggio/types.ts`** — add the decision-3/7 types above
   (`QuotaStrategyKind`, `DemandClass`, `AllocationSite`, `AllocationDemand`, `QuotaHold`, `ConsultedWindow`,
   `ConsultedBalance`, `ConsultedPool`, `ConsultedSnapshot`, `StrategyEntryOutcome`,
   `AllocationDecision`) beside the #583 pool types; `PelaggioEventType` gains
   `"pelaggio.allocation-decided"`. No existing type changes.
2. **New `packages/pelaggio/scripts/pelaggio/quota-strategy.ts`** (runtime imports:
   `types.ts` + `node:crypto`; `DriverIdentity` arrives `import type`-only per decision 11;
   pure except the advisor's injected `emit`/`getConsulted`): the closed registry with the
   three kind defs; `parseQuotaConfig` (+ strict local duration parser) and
   `validateQuotaStrategy` warnings; `DEFAULT_QUOTA_STRATEGY`; `consultedFrom` (+ the
   domain-separated digest via `node:crypto`); `decideAllocation` (engine: per-entry
   qualification → role dispatch → permutation validation → trace assembly);
   `buildAllocationDecidedInput(decision, demand, candidates, chain, chainSource, itemId)` →
   `FlowEventInput`; `createAllocationAdvisor` (compose, emit fail-open, catch-all → null +
   one dim diagnostic).
3. **`packages/pelaggio/scripts/pelaggio/config.ts`** — import `parseQuotaConfig`/`QuotaConfig`
   from `quota-strategy.js` (the `review/taxonomy.ts` precedent); parse the top-level `quota`
   block in `loadConfig`; `ResolvedConfig` gains `quota: QuotaConfig`; default
   `{ telemetry: {}, strategy: null, warnings: [] }`. No other config change.
4. **`packages/pelaggio/scripts/pelaggio/flow-events.ts`** — registry entry
   `"pelaggio.allocation-decided"` (the `EVENT_TYPE_COVERAGE` mapped type keeps union and
   registry in lockstep) + `isAllocationDecidedFields` structural validator in `decodeV1`.
   Unknown-type rejection path untouched.
5. **`packages/pelaggio/scripts/pelaggio/driver-assignment.ts`** — `selectAuthor` and
   `selectReviewers` gain an optional trailing `context?: { advisor: AllocationAdvisor;
   step: Step }`. Each builds its `AllocationDemand` (`demandClass: "pipeline"`; site;
   `ordinal` = pre-increment `authoringOrdinal` / `0`), asks `context.advisor.order(demand,
   candidates)`, and uses the returned ordering in place of `rotated(...)`; `null`/absent →
   the exact current expressions. Availability find, author exclusion, distinct-provider
   filter, `count` slice, ordinal bookkeeping, and all return shapes unchanged.
   `resolveStaticAuthor` and `recordArtifactAuthor` untouched. The module keeps zero I/O
   imports (`AllocationAdvisor` is a type-only import).
6. **`packages/pelaggio/scripts/pelaggio/pipeline.ts`** — beside `driverCandidates`
   (`:1360`): resolve `chain = CONFIG.quota.strategy ?? DEFAULT_QUOTA_STRATEGY` +
   `chainSource`; log `CONFIG.quota.warnings` once (dim); build the memoized fail-open
   `getConsulted` (only reads when some entry `needsSnapshot`: `readEventLog` →
   `derivePoolRealm` per `configuredProviders(CONFIG)` → `projectPoolState` →
   `consultedFrom`; any throw → `undefined`); `createAllocationAdvisor({ …, emit:
   opts.emitFlowEvent, itemId: () => itemId ?? null })`. Pass `{ advisor, step }` at the
   four demand sites (`:1423` plan, `:1466` shakedown-plan, `:1498` implement, `:1945`
   shakedown-code). No other pipeline change; no new writer (evidence rides #581's
   run-scoped writer; single-writer-per-segment preserved).
7. **`packages/pelaggio/scripts/pelaggio/index.ts`** — export `parseQuotaConfig`,
   `decideAllocation`, `consultedFrom`, `createAllocationAdvisor`, `DEFAULT_QUOTA_STRATEGY`
   and the new types (flow-events export parity).
8. **`docs/config.md`** — new `## Quota strategy` section documenting the `quota:` block
   (the annotated example above; roles and fall-through semantics; the terminal-entry parse
   rule; the holds-recorded-not-enforced status; the `allocation-decided` evidence and where
   it lands; defaults = today). **AC-5**: rewrite the "no persisted quota, credential-seat,
   cooldown, or cross-worker fairness state" paragraph per the design doc — readiness stays
   a stateless pre-execution check *because* pool state lives in the derive-on-read
   projector (`npx pelaggio usage`) behind the `quota:` strategy seam, which only orders
   allocation; nothing is persisted, and cross-worker fairness/scheduling remain outside
   (the future per-pool ledger and #246). Also fold in #583's decision-9 one-clause
   amendment if #583 landed first (coordinate at implement time).

No changes to: `provider-routing.ts` (fixed authoring seats stay config-authoritative),
`resolveDriverCandidates` (pools still define what is allowed), review modules /
`pr-review` fan-out / #578 quorum (AC-4), `stats.ts`, skills, `.pelaggio.yml` (user work),
`STEPS` maps (no pipeline step), `helpers.ts`.

## Test plan

`node:test` throughout; `npx tsx --test <file>`; table-driven per kind (charter AC-2).

**`__tests__/quota-strategy.test.ts` (new)**
1. **Parse**: the annotated example parses to typed entries (kebab → camel, `stale-after` →
   ms); unknown `kind` fails; unknown key in `quota`/entry/telemetry fails; `gate-reserve`
   out of (0,1), `soak-after` out of (0,1], empty `window`, empty `hold-classes`, bad
   `requires`, unparseable `stale-after` all fail with dotted-key messages; last entry not
   terminal fails; `strategy: []` fails; `requires`/`stale-after` on `static-rotation`
   fails; absent block → `strategy: null`; telemetry with unknown provider or non-channel
   value fails. Strict duration parser: `"6h"`/`"90m"`/`"1h30m"`/`"45"` parse, `"soon"`/`""`
   fail.
2. **AC-1 equivalence (the regression test)**: table over cycles × ordinals × candidate-set
   sizes (1–4) × both sites — `decideAllocation(DEFAULT_QUOTA_STRATEGY, …)` ordering ===
   legacy `rotated(candidates, cycle + ordinal)`; with a full configured chain and **no**
   consulted snapshot, ordering is identical and the trace shows `no-snapshot` skips.
3. **`static-rotation`**: exact cycle-modulo permutation incl. negative-safe modulo and
   empty/singleton candidate lists; applicable with `consulted: undefined`.
4. **`headroom-weighted`** (AC-2): scalar table — min over windows of `1 − usedFraction`;
   `status: "rejected"` ⇒ 0 even without `usedFraction`; fresh window without
   `usedFraction` ⇒ unknown; balance `exhausted` ⇒ 0; `remainingFraction` ⇒ scalar; both
   geometries ⇒ min of known; unknown sorts last; exhausted (0) sorts after measured
   positives but before unknowns; ties keep the rotation base order (verified across two
   ordinals); named `windows` subset scopes the scalar; `stale-after` disqualifies old
   windows (pool → unknown); `requires: reported` disqualifies probed/estimated
   observations; no qualified observation anywhere → skipped (`window not observed` /
   `stale` / `channel below required` reasons), terminal orders.
5. **`reserve-headroom`**: below the line → applied, zero holds; above → one hold per
   holdClass × hot pool with `until` = the window's `resetsAt` and only triggering pools
   named (a hot Claude weekly never names the codex pool); `hold-classes` default
   `["opportunistic"]`; `status: "rejected"` ⇒ hot; soak release at elapsed-time ≥
   `soak-after` and **not** at high usage with low elapsed time (the spend-it-or-lose-it
   direction, asserted both ways); missing `resetsAt` or `durationMs` → soak inapplicable,
   hold stands; stale named observation → entry skipped.
6. **Chain composition**: two constraints → conjunctive union of holds, both traced
   `applied`; first applicable ordering wins and later orderings trace `not-reached`;
   constraint entries never influence ordering; a stub ordering def (injected via the
   engine's registry parameter) returning a non-permutation → skipped with
   `invalid ordering output`, terminal orders (fail-open, tenet 5).
7. **Evidence (AC-3)**: `buildAllocationDecidedInput` output appends through a real
   `createEventWriter` and reads back typed; **reproducibility** — for a populated decision
   event, `decideAllocation(event.chain, event.consulted, event.demand, event.candidates,
   event.decidedAt)` reproduces `holds`, `ordering`, `orderedBy`, and every entry outcome;
   `consulted` is `null` for the default chain; `consultedFrom` strips burn/recentLimits/
   foreignPools/diagnostics and digests deterministically (same snapshot → same digest,
   changed fraction → different digest).
8. **Advisor**: ordering path returns identities in decided order and emits exactly one
   event per `order()` call with the correct `itemId`/site/step; `emit` throwing → ordering
   still returned; `getConsulted` throwing → `null`-free fallback to terminal ordering with
   `no-snapshot` skips; an internal engine throw (forced via stub registry) → `order()`
   returns `null`, one dim diagnostic, no event with partial content.

**`__tests__/driver-assignment.test.ts` (extend; every existing test unchanged)**
9. `selectAuthor`/`selectReviewers` without `context` → byte-identical results and identical
   `authoringOrdinal` bookkeeping (existing tests already pin this; add an explicit
   assertion that the new parameter defaults to the legacy path).
10. With an advisor stub returning a reversed ordering: author = first *available* of the
    reversed list; reviewer selection applies author-exclusion + distinct-provider +
    `count` after the strategy order; demand passed to the stub carries
    `{ demandClass: "pipeline", ordinal: authoringOrdinal-before-increment }` for authors
    and `ordinal: 0` for reviewers; advisor returning `null` → legacy rotation.

**`__tests__/config.test.ts` (extend)**
11. `.pelaggio.yml` with the annotated `quota:` block loads into `ResolvedConfig.quota`;
    absent block → `{ telemetry: {}, strategy: null, warnings: [] }`; a bad block fails
    `loadConfig` loudly; `requires: reported` with telemetry declaring only
    `grok: estimated` → a warning naming the never-applicable entry (structure still
    loads).

**`__tests__/flow-events.test.ts` (extend)**
12. `allocation-decided` round-trips; fail-closed on append for: bad `site`, bad
    `demand.class`, empty `chain`, bad entry `outcome`, non-finite `decidedAt`, malformed
    `consulted`; hand-written malformed line → reader `malformed` diagnostic, other events
    intact; unknown-type rejection untouched.

**`__tests__/pipeline.test.ts` (extend)**
13. A stubbed full cycle (`providerAvailableForTests` seam) with `emitFlowEvent` wired and
    **no** quota config → selections identical to a pre-change baseline run (AC-1 at the
    integration level) and one `allocation-decided` event per demand site with
    `chainSource: "default"`, `consulted: null`; with `emitFlowEvent` absent → no events,
    no throw.

**Live verification (AC-2/AC-3, manual, post-implement, after #581+#583 land)**: one real
cycle with a `headroom-weighted` chain configured; confirm seat order follows the rendered
`pelaggio usage` fractions and that each `.dev/flow-events` `allocation-decided` record
replays to the same ordering.

## Migration / compatibility

- **Absent `quota:` config** → `strategy: null` → implicit default chain → selection
  byte-identical, zero new I/O; the only observable delta is evidence events in live
  orchestrated runs (additive; no consumer reads them yet).
- **No snapshot / stale snapshot / #581-#583 not yet emitting** → every `needsSnapshot`
  entry skips with a recorded reason → terminal ordering ≡ today (AC-1's second clause).
- **Direct `runPipeline` callers and review CLIs** → no advisor context → legacy code path
  untouched.
- **Event log** → one additive closed-registry type; tolerant reader unaffected;
  no schema version bumps; no data migration; no persisted strategy state (`PoolState`
  remains advisory and evaporates with `.dev/`).
- **Config** → new optional top-level block only; existing files parse unchanged.
- **Ordering coupling** → `implement` lands after #581 and #583; the freshness-merge rule
  applies if either upstream plan shifts a bound name (re-audit the two contracts at
  implement start).

## Non-goals (boundaries with sibling charters)

- **No hold enforcement, no defer/park wiring, no `budget-idle` generalization** — holds are
  computed and recorded (`holdsEnforced: false`); consumption belongs to the demand sites
  and stays harness mechanism (parking via `parkExit()` untouched).
- **No scheduler, no pool-parallel cycles** — #246 stays blocked on the future per-pool
  ledger; **no reservation handles, reserve/settle/refund** — #465/G2.
- **No telemetry emission or probes** — #582/#584/#585; this item only consumes what #583
  projects.
- **No intra-provider model shifting** (Opus→Sonnet) — a different seam (`MODEL_PROFILES` /
  step-model resolution), chartered separately.
- **No changes to pools (`resolveDriverCandidates`), fixed authoring seats, `pr-review`
  fan-out, `pr-verify`, diversity floors, or #578 quorum** (AC-4).
- **No new strategy kinds beyond the three**, no behavior constants in code (every threshold
  is a parameter), no model-driven policy of any kind.
- **No probe scheduling from `quota.telemetry`** — validation-only in this item.
- **No `pelaggio usage` rendering of holds/decisions** — operator surfacing of allocation
  history is a natural additive follow-up, operator-decidable later.

## Step-indexed maps / invariants check

- No pipeline step added → no `STEPS` map updates; no skill bodies, no model IDs, no
  frontmatter reliance.
- Mechanism/policy spine: kinds are pure functions of role-typed inputs; the engine, parse,
  and gates are deterministic; the model is never consulted; the blocking gates
  (availability, diversity, capability hard predicates, #578) are byte-identical.
- FlowPolicy: strategies see `ConsultedSnapshot`, not storage — enforced by
  `decideAllocation`'s signature; the advisor (harness) owns all I/O, fail-open.
- Flow invariants: closed `pelaggio.*` registry extended fail-closed; evidence fat and
  self-contained at emission; single-writer-per-segment untouched (rides #581's run writer);
  projection stays non-authoritative (a wrong snapshot can only mis-order, never gate).
- Worktree isolation, park/checkpoint semantics, `ship.target`, claims, secret hygiene
  (nothing secret enters `ConsultedSnapshot` — `poolId` is #583's non-secret digest):
  untouched. No new dependencies; no install scripts.
