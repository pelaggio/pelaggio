# Plan #583 — Project per-pool quota state and add the `pelaggio usage` command

Charter: issue #583. Third increment of `docs/agent-context/provider-quota.md` (tenets 2, 3, 5).
Read-only monitoring; no behavior change. Second link of the chain: #581 (telemetry emission,
**planned, not yet landed** — branch `feat/issue-581-claude-rate-limit-telemetry`, plan
`docs/plans/581-claude-rate-limit-telemetry.md`) → **#583 (this: projection + CLI)** → #586
(strategy seam) → #246. This plan binds to the event schemas #581's approved plan fixes and its
implementation lands after #581's does. Downstream: #586 consumes the snapshot; #582/#584/#585
emit into the same registry and this projector must tolerate their future events without change.

## Acceptance criteria (from the charter)

- **AC-1**: after a run with #581 landed, `npx pelaggio usage` shows live Claude 5h/weekly
  (+opus/sonnet) utilization with reset times and per-window freshness.
- **AC-2**: a one-window observation never refreshes sibling windows (unit-tested merge).
- **AC-3**: providers without telemetry render explicitly as estimated/unknown — absence is
  visible, never fabricated.

## Current mechanism (audited at HEAD `01cbc8a` + #581's approved plan)

- **What #581 will emit** (its plan is the contract; nothing here re-decides it):
  - `pelaggio.provider-usage` — an *observation*: `provider`, `step`, `observedAt`, `windows[]`
    of `{ name, channel, observedAt, status?, utilization?, resetsAt?, surpassedThreshold? }`,
    validated-optional `gen_ai.usage.*` token fields, bounded scrubbed `detail`. Never a
    projected `PoolState`.
  - `pelaggio.provider-limit` — typed fault: `provider`, `fault` (claude: `"rate-limit"`),
    `window: { name, resetsAt, resetSource }`, `disposition`
    (`parked | continued-on-overage | already-parked`), `utilization?`.
  - Cycle-log `parkWindow?: ParkWindowIdentity` — the identity tuple
    `(provider, windowName, resetsAt)` + `resetSource`, the **join key** across event stream ↔
    cycle log for the same park.
  - `StepLog.tokens` stays the authoritative token history (cycle log); `ReviewPassRecord`
    entries gain `tokens?: TokenUsage` (review records, a separate store).
  - Types #581 adds that this item reuses: `QuotaChannel` (`reported | probed | estimated`),
    `ParkResetSource`, `ParkWindowIdentity`.
  - **Deliberately absent from #581**: `poolId`. Its plan states "#583 owns pool identity;
    adding it later is an additive optional field." That addition is this item's decision 2.
- **Reader substrate** (`flow-events.ts`, live at HEAD): closed `PELAGGIO_EVENT_TYPES` registry,
  fail-closed `decodeV1` on append, tolerant-with-diagnostic `readEventLog()` that globs
  `.dev/flow-events/*.jsonl` segments **and** promotes untyped legacy cycle-log lines to
  `pelaggio.cycle-completed` (dual-format reader) with deterministic presentation sort + eventId
  dedup + per-stream sequence diagnostics. `foldEvents()` is the pure reduce entry point.
- **Cycle log today** (`types.ts` `CycleLogEntry`): `parked` + free-form `parkReason` + closed
  `parkClass`; `steps[]` with `provider?: ProviderName`, `tokens?: TokenUsage`, `cost`,
  `costEstimated?`. Pre-#581 records are the only park/burn history that exists.
- **CLI registration**: subcommands are routed in `bin/pelaggio.js` (`routes` map + `HELP`
  text) to standalone `scripts/pelaggio/<name>-cli.ts` entries run through tsx (`roadmap-cli.ts`,
  `land-cli.ts` pattern). The pipeline entry (`cli.ts`) rejects positionals other than `stats`
  and points at the CLI — `usage` follows the bin-route pattern, not the `stats` special case.
- **Config**: `loadConfig({ repo?, configPath? })` → `ResolvedConfig` with
  `profileProviders` (per-profile per-step `ProviderSelection`) and
  `review.authoring.reviewers/judge` slots — enough to enumerate which providers the operator
  actually runs. No `quota:` block exists (that is #586).
- **Auth-realm material on disk** (for pool identity; non-secret discriminators only):
  Claude Code keeps account identity (`oauthAccount` UUIDs) in `~/.claude.json` and tokens in
  `~/.claude/.credentials.json`; codex keeps `~/.codex/auth.json`; grok keeps
  `~/.grok/auth.json` (paths already named by `secret-hygiene.ts`). Exact identity-field
  availability is audited at implement time; the fallback ladder below never depends on it.
- **The operator view being replaced**: hand-maintained conservation comments in the live
  `.pelaggio.yml` ("grok currently has the most subscription room", dated 2026-08-05). They are
  replaced *functionally* by `pelaggio usage`; the file itself is not touched (host-config test
  seam; preserve user config).

## Design decisions

1. **A pool is one provider subscription/billing realm.** The shared quota reservoir every seat
   on that provider draws down against — Claude Max, Codex/ChatGPT, SuperGrok Build — i.e. the
   unit the fleet's economics already reason about. Identity is the typed pair
   `(provider, poolId)` where `poolId` is a **non-secret auth-realm discriminator** derived by a
   deterministic ladder (trust order mirrors the channel hierarchy):
   - `account-identity`: 12-char Crockford SHA-256 digest (domain-separated, like the
     `digestId` house pattern) over allowlisted **non-secret** identity fields the provider's
     local config exposes — claude: `oauthAccount` account/organization UUIDs from
     `~/.claude.json`; codex: plain identity fields in `~/.codex/auth.json` *if the audited
     shape has them* (never decoded out of token JWTs). Stable across token refreshes.
   - `auth-config-epoch`: digest over `(canonical path, mtimeMs, size)` of the provider's
     credential file — bumps on credential change **without ever reading secret bytes**.
   - `default`: the literal `"default"` when no auth material is locatable.
   Each rung fails open to the next (unreadable/absent file → next rung; derivation never
   throws). OpenCode is a per-backend realm: its `poolId` digests the configured backend
   identity when one is exposed, else takes the epoch/default rungs — fixing identity semantics
   now even though no opencode telemetry exists yet. The seam is provider-neutral: `poolId` is
   an opaque string everywhere outside `derivePoolRealm`. **Known epoch-rung behavior, accepted
   deliberately**: providers rewrite their auth file on routine token refresh, so an
   epoch-sourced realm can bump without a real account change. The error direction is the safe
   one — over-invalidation shows *less* (and surfaces visibly under `foreignPools`), never a
   blended pool — and the preferred `account-identity` rung, which token refreshes do not move,
   is expected to be available for the two providers that emit stamped events soonest (claude
   `oauthAccount` UUIDs; codex `auth.json` plain account-id field — availability audited at
   implement).
2. **`poolId` is stamped at emission, not inferred at read time.** Realm membership is an
   observation-time fact — a read-time re-derivation cannot know which realm was active when a
   historical event was captured. So this item adds the additive **optional** `poolId` field to
   `pelaggio.provider-usage` / `pelaggio.provider-limit` payloads (exactly the extension #581's
   plan reserved) and stamps it in the pipeline's telemetry wrapper via a per-process memoized
   `derivePoolRealm(provider)` (fail-open: derivation failure → field absent). Zero behavior
   change; one new field on emitted events. The projector then partitions by stamp. The
   provider's *current realm* is the `derivePoolRealm` result — except when derivation bottoms
   out at `"default"` while stamped observations exist (credentials removed or moved since the
   run): then the **newest stamp is adopted** as the current realm (`realmSource: "observed"`),
   so a machine that lost its auth material still renders the one real pool instead of
   invalidating everything. Adoption picks exactly one poolId (the newest); other stamps stay
   foreign — no blending. Partition rules:
   - **Stamped, matching** the provider's current realm → merged into that pool.
   - **Stamped, mismatched** → **invalidated**: excluded from `pools[]`, summarized under
     `foreignPools` (provider, poolId, event count, newest ts) so a credential change is
     *visible*, never blended. This is the charter's "invalidates rather than blends".
   - **Unstamped** (every pre-#583 event and every cycle-log-derived observation) → attributed
     to the current realm with the per-observation marker `attribution: "assumed"` — the
     assumption itself is provenance, honest instead of either discarding pre-stamp history or
     laundering it as certain.
3. **The projector is pure derive-on-read; nothing is persisted.** `projectPoolState()` is a
   pure function `(ReadEventLogResult, { now, realms, providers }) → UsageSnapshot` folding the
   reader's output — flow-event segments **plus** the promoted cycle-log records the dual-format
   reader already yields. No snapshot cache file, no writes anywhere on the read path, no model
   calls, no network. Projection-is-cache stays trivially true (the cache has zero bytes of
   state); the append-log remains the only authority on history and is never rewritten.
   Sources are **flow events + cycle log only**, charter-literal; review records are a named
   non-goal below.
4. **Merge is by window name; reported state is exposed as reported.** Within one pool, an
   observation updates only the window (or balance) it names — newest `observedAt` per name
   wins; sibling windows keep their own `channel`/`observedAt` (AC-2). `usedFraction` is
   **never synthesized**: it appears only when a provider reported it. Local accumulation
   between reports is exposed *alongside* as `burn` (token totals from `StepLog.tokens`/`cost`
   grouped by `StepLog.provider`): `spentSince` (the charter's name — burn since the pool's
   newest reported/probed observation, when one exists) and `last24h` (always computable, so
   estimated-tier pools still show real burn). Both are **cycle-granular approximations**,
   stated as such: `StepLog` carries no per-step timestamp, so a cycle's burn attributes to its
   entry `ts` (cycle completion) — good enough for an operator view, never fed back into any
   window fraction. A `provider-limit` event folds twice: into the named window as
   `status: "rejected"` (+ `resetsAt`, + `utilization` only when the event carried it) and into
   the pool's bounded `recentLimits` history.
5. **Two geometries, forward-tolerant to the rest of the chain.** `PoolState` carries rolling
   `windows[]` (Claude/Codex) and an optional spend-down `balance` (Grok). To give #585's
   emitter a contract and keep append validation fail-closed, the usage-event payload gains a
   validated-**optional** `balance` observation
   (`{ remainingFraction?, exhausted?, channel, observedAt }`) beside `windows` — no emitter in
   this item. A `provider-limit` whose `fault` is `"balance-exhausted"` (#582's chartered slug,
   a named constant here) folds to `balance.exhausted = true` (headroom-0 semantics per the
   design doc) instead of a window. Future probed-channel events (#584) validate already —
   `probed` is in `QuotaChannel` and channel is per-observation; vendor-prefixed consumer
   events keep falling into the reader's `unknownType` diagnostic, untouched.
6. **Staleness is exposed, never filtered; absence is explicit.** Every window/balance keeps its
   own `observedAt`; the snapshot carries `generatedAt` and per-pool `newestObservationAt`. The
   projector applies **no TTL** — stale-after thresholds are policy (#586's chain keys), not
   mechanism. A window whose `resetsAt` has passed is *retained* and rendered as "data predates
   reset" (a derivation from the observation's own fields), never cleared or extrapolated.
   Pools for every configured-but-silent provider render with `windows: []` and an explicit
   "no observations — estimated tier" line (AC-3). The pool list is the union of providers
   named anywhere in `profileProviders` or the authoring review slots, always including
   `claude`, plus any provider that has observations.
7. **Park/limit history is deduplicated on the #581 identity tuple.** A #581-era park produces
   both a `provider-limit` event and a cycle-log `parkWindow`; `recentLimits` joins them on
   `(provider, windowName, resetsAt)` — exactly the join #581 designed the tuple for — keeping
   both `sources`. Pre-#581 park history comes from legacy cycle-log entries
   (`parked && parkClass === "rate-limit"`): `windowName` is tolerantly parsed from
   `parkReason` against the closed SDK window-id set (`five_hour`, `seven_day`,
   `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`; a trailing
   `" (estimated)"` suffix → `resetSource: "estimated"`), else `"unknown"`; provider comes from
   the entry's last step's `provider`, else the fact is skipped (unattributed legacy park —
   an honest gap, mirroring the `stats.ts` `unrecorded` posture). Legacy-derived facts carry
   `channel: "estimated"`. Legacy parsing is confined to one function
   (`parseLegacyParkReason`, substring match over the closed id set; exact live `parkReason`
   formats audited at implement) applied only to pre-`parkWindow` records — regex over prose is
   back-compat reading under the dual-format-reader rule, never the forward path.
   `pelaggio.suspended` events (which #581 additively enriches with window fields in continuous
   mode) are deliberately **not** a third source: every signal-driven park already reaches
   `recentLimits` through the two primary sources, and the tuple join would only re-dedupe what
   it already deduped.
8. **`pelaggio usage` is a thin, read-only renderer.** New `usage-cli.ts` routed from
   `bin/pelaggio.js` (house pattern). Flags: `--json` only. Exit codes: `0` = report rendered
   (a fully-empty store is a *successful* "no data" report, AC-3), `2` = CLI usage error,
   `1` = unexpected crash (default). No writes, no network, no probes (#584/#585 own probing),
   no model calls. Reader diagnostics render as one dim summary line (tolerant is not silent);
   `--json` emits the full `UsageSnapshot` including `diagnostics`.
9. **`docs/config.md` gets the minimal truth-preserving amendment only.** The
   "no persisted quota … state" sentence stays true — this item persists nothing — so it gains
   one clause: pool-state *monitoring* now exists as a read-only derive-on-read projection
   (`npx pelaggio usage`), still outside the cycle-local readiness policy. The full rewrite
   relocating pool state behind the strategy seam is #586's AC-5 (the design doc's
   "same change that ships the projector" sentence predates the #586 charter, which now owns
   that AC; noted here so the boundary is deliberate, not missed).

## Schemas

### Normal-form types (in `types.ts`, beside `TokenUsage`/`CostMeter`; per the charter)

```ts
/** How a pool's poolId was established. The first two are `derivePoolRealm` rungs;
 *  "observed" marks a newest-stamp adoption (decision 2) when derivation bottomed out
 *  at "default" while stamped observations existed. */
export type PoolRealmSource = "account-identity" | "auth-config-epoch" | "observed" | "default";

/** One provider subscription/billing realm — the shared reservoir all seats on that
 *  provider draw down against. poolId is a non-secret auth-realm discriminator
 *  (decision 1); a realm change invalidates, never blends (decision 2). */
export interface PoolIdentity {
	provider: ProviderName;
	poolId: string;
	realmSource: PoolRealmSource;
}

/** One named rolling window as last observed. Reported state only — usedFraction is
 *  never synthesized locally (provider-quota.md normal form). */
export interface QuotaWindow {
	name: string;                 // provider-native id ("five_hour", "seven_day_opus", "unknown")
	durationMs?: number;
	usedFraction?: number;        // only as provider-reported
	status?: "allowed" | "allowed_warning" | "rejected";
	resetsAt?: number;            // epoch ms
	channel: QuotaChannel;        // provenance of THIS observation (#581's type)
	observedAt: number;           // epoch ms of the newest observation naming this window
	/** Present when the source observation carried no poolId and was attributed to the
	 *  current realm (pre-stamp history, cycle-log-derived facts). Absent = stamped. */
	attribution?: "assumed";
}

/** Spend-down geometry (grok Build). */
export interface PoolBalance {
	remainingFraction?: number;
	exhausted: boolean;
	channel: QuotaChannel;
	observedAt: number;
	attribution?: "assumed";
}

/** One park/limit fact, deduplicated on the #581 identity tuple (provider, windowName,
 *  resetsAt) across event stream and cycle log. */
export interface PoolLimitFact {
	windowName: string;
	resetsAt: number;
	resetSource?: ParkResetSource;
	disposition?: "parked" | "continued-on-overage" | "already-parked";
	fault?: string;               // "rate-limit" today; #582 slugs later
	observedAt: number;
	channel: QuotaChannel;        // "reported" (event) vs "estimated" (legacy cycle-log parse)
	sources: ("event" | "cycle-log")[];
	attribution?: "assumed";
}

export interface TokenTotals {
	tokens: TokenUsage;
	costUsd: number;
	costEstimated: boolean;       // true when any summed step cost was an estimate
	steps: number;
}

/** Local accumulation exposed BESIDE reported windows, never folded into them.
 *  Cycle-granular: a cycle's burn attributes to its completion ts (decision 4). */
export interface PoolBurn {
	/** Newest reported/probed observedAt for the pool; absent → spentSince absent. */
	anchor?: number;
	spentSince?: TokenTotals;
	last24h: TokenTotals;
}

export interface PoolState {
	provider: ProviderName;
	poolId: string;
	realmSource: PoolRealmSource;
	windows: QuotaWindow[];       // sorted by name; [] = nothing observed (AC-3)
	balance?: PoolBalance;
	burn: PoolBurn;
	recentLimits: PoolLimitFact[]; // newest-first, capped at 10
	newestObservationAt?: number;
}

export interface UsageSnapshot {
	generatedAt: number;
	pools: PoolState[];           // current realms only, one per provider
	/** Observations invalidated by a realm change — counted and identified, never blended. */
	foreignPools: { provider: ProviderName; poolId: string; events: number; newestObservationAt: number }[];
	diagnostics: EventLogDiagnostics;
}
```

### Event-payload additions (additive-optional; append validation extended fail-closed)

- `pelaggio.provider-usage` and `pelaggio.provider-limit` gain optional `poolId` (non-empty
  string when present; wrong type fails `decodeV1` → append throws, read diagnoses).
- `pelaggio.provider-usage` gains a validated-optional `balance` observation:
  `{ remainingFraction?: finite 0..1, exhausted?: boolean, channel: QuotaChannel,
  observedAt: positive safe integer }`. No emitter in this item (#585's contract).
- Envelope, registry membership, unknown-type rejection: untouched.

### `pelaggio usage` output

Human (shape, not a golden byte contract — `A`-styled like `stats.ts`, ages via `fmtWait`):

```
Provider pools (.dev/flow-events + pelaggio-log)        generated 2026-08-22 14:03

claude   pool 4F2K9QW1T8ZC (account-identity)           last observed 12m ago
  five_hour        63%  allowed   resets in 2h 13m   reported   12m ago
  seven_day        41%  allowed   resets in 3d 4h    reported   1h 2m ago
  seven_day_opus   88%  warning   resets in 3d 4h    reported   12m ago
  burn since last report: 1.2M in / 89K out (4 steps, ~$6.10)
  recent limits: 08-21 17:42  seven_day_opus  parked  reset 08-24 09:00 (reported)

codex    pool 7QDXM2VK01BH (auth-config-epoch)          no window telemetry — estimated tier
  burn last 24h: 640K in / 51K out (3 steps, ~$3.80)

grok     pool default                                    no observations — estimated tier

reader diagnostics: 1 malformed, 2 unknown-type (--json for detail)
```

`--json`: `JSON.stringify(snapshot, null, 2)` — the `UsageSnapshot` above, schema stable.
Stale rendering: age always shown per window; `resetsAt < now` renders the reset column as
`reset passed <age> ago (data predates reset)` with the observation retained. Unknown values
render as `—`, never as a number.

## File-by-file changes

1. **`packages/pelaggio/scripts/pelaggio/types.ts`** — add the normal-form types above
   (`PoolRealmSource`, `PoolIdentity`, `QuotaWindow`, `PoolBalance`, `PoolLimitFact`,
   `TokenTotals`, `PoolBurn`, `PoolState`, `UsageSnapshot`) beside `CostMeter`, reusing #581's
   `QuotaChannel`/`ParkResetSource`. No existing type changes.
2. **`packages/pelaggio/scripts/pelaggio/flow-events.ts`** — extend #581's
   `isProviderUsageFields` / `isProviderLimitFields` with optional `poolId` and the optional
   `balance` observation validation (decision 5). Registry, envelope, unknown-type path
   untouched.
3. **`packages/pelaggio/scripts/pelaggio/provider-telemetry.ts`** (#581's module) —
   `buildProviderUsageInput` / `buildProviderLimitInput` accept optional `poolId` and attach it
   to the payload. Pure, provider-neutral.
4. **New `packages/pelaggio/scripts/pelaggio/quota-projection.ts`** (single-purpose module,
   `flow-events.ts` house pattern; no SDK imports, no I/O in the fold):
   - `derivePoolRealm(provider: ProviderName, opts?: { home?: string }): PoolIdentity` — the
     decision-1 ladder; only function that touches the filesystem (stat/read of the named
     non-secret config surfaces), never throws, never reads secret bytes into a digest.
   - `configuredProviders(config: ResolvedConfig): ProviderName[]` — union of
     `profileProviders` selections + `review.authoring` slot providers, always including
     `"claude"`, in `ProviderName`-declaration order.
   - `parseLegacyParkReason(reason: string): { windowName: string; resetSource?: "estimated" }`
     — decision-7 closed-set parse, `"unknown"` fallback.
   - `projectPoolState(result: ReadEventLogResult, opts: { now: number; realms:
     ReadonlyMap<ProviderName, PoolIdentity>; providers: readonly ProviderName[] }):
     UsageSnapshot` — the pure fold (decisions 2–7). Narrow local type guards over the
     already-decoded event payloads; `BALANCE_EXHAUSTED_FAULT = "balance-exhausted"` constant.
5. **New `packages/pelaggio/scripts/pelaggio/usage-cli.ts`** —
   `runUsageCommand(opts: { json: boolean; root?: string; configPath?: string; home?: string;
   now?: () => number }): number` (returns exit code; full DI so tests never touch the host
   repo/config — the roadmap-cli seam lesson) + pure `renderUsage(snapshot, now): string` +
   thin `main()` arg parse (`--json`; unknown flag/positional → message + exit 2). Wires
   `loadConfig` → `readEventLog` → `derivePoolRealm` per configured provider →
   `projectPoolState` → render.
6. **`packages/pelaggio/bin/pelaggio.js`** — `usage: ["scripts/pelaggio/usage-cli.ts"]` route +
   HELP line: `usage   Per-provider pool state: windows/balance with channel, freshness,
   resets, recent limit events (--json).`
7. **`packages/pelaggio/scripts/pelaggio/pipeline.ts`** — in the #581 `onProviderTelemetry`
   wrapper: per-process memoized `realmFor(provider)` (try `derivePoolRealm`, catch →
   `undefined`) passed as `poolId` to the builders. Fail-open; no other pipeline change.
8. **`packages/pelaggio/scripts/pelaggio/index.ts`** — export `projectPoolState`,
   `derivePoolRealm`, `configuredProviders` and the new types (flow-events export parity).
9. **`docs/config.md`** — the decision-9 one-clause amendment to the "no persisted quota …"
   paragraph.

No changes to: `stats.ts`, `config.ts` (no config surface), `cli.ts`/`main.ts` (bin-route
only), skills, `.pelaggio.yml`, `STEPS` maps (no pipeline step), review modules.

## Test plan

`node:test` throughout; `npx tsx --test <file>`. Fixtures are tmp-dir stores built with
`createEventWriter` + hand-written lines, mirroring `flow-events.test.ts` conventions
(`readEventLog({ root })`, never the host repo).

**`__tests__/quota-projection.test.ts` (new)**
1. `derivePoolRealm` ladder: identity fields present → stable `account-identity` digest
   (same input → same poolId; different account → different poolId; an mtime-only touch does
   **not** move it); identity absent but credential file present → `auth-config-epoch` digest
   that changes when mtime/size change (the decision-1 accepted churn, asserted as the
   documented direction); nothing present → `"default"`; unreadable file → falls through,
   never throws; digests are 12-char Crockford and contain no source bytes.
2. **Merge by window (AC-2)**: fresh `five_hour` observation after older
   `seven_day`/`seven_day_opus` observations → only `five_hour.observedAt`/fields refresh;
   siblings keep their exact prior `channel`/`observedAt`/`usedFraction`.
3. Newest-wins per window name; equal-name observations across two segments resolve by
   `observedAt`, deterministic on re-read.
4. `usedFraction` never synthesized: burn present + no reported fraction → window has no
   `usedFraction`; `burn.spentSince`/`last24h` populated instead (tenet: accumulation beside,
   never folded in); no anchor (no reported/probed observation) → `spentSince` absent,
   `last24h` still present.
5. Limit folding: `provider-limit` (disposition `parked`) → named window `status: "rejected"`
   + `resetsAt`; `utilization` present only when the event carried it; fact lands in
   `recentLimits` with `resetSource`.
6. **Realm invalidation**: events stamped poolId A, then realm B current → A-observations
   excluded from `pools`, summarized in `foreignPools`; nothing blended. Adoption: current
   realm derives to `"default"` while stamps A (older) and B (newer) exist → pool renders as B
   with `realmSource: "observed"`, A stays foreign.
7. Unstamped attribution: pre-stamp events and cycle-log facts → current pool with
   `attribution: "assumed"` on each derived observation.
8. Legacy cycle-log only (pre-#581 store): parked entry with `parkReason
   "seven_day_opus (estimated)"` → estimated-channel `PoolLimitFact`
   (`windowName: "seven_day_opus"`, `resetSource: "estimated"`); unparsable reason →
   `"unknown"`; no-provider legacy park skipped (honest gap); per-provider burn summed from
   `steps[].tokens` + `cost`, `costEstimated` propagated, provider-less steps excluded.
9. Tuple dedupe: `provider-limit` event + cycle-log `parkWindow` with the same
   `(provider, windowName, resetsAt)` → one `recentLimits` entry, `sources:
   ["event", "cycle-log"]`; differing `resetsAt` → two entries.
10. **Empty store (AC-3)**: no `.dev/flow-events/`, no cycle log → snapshot with one no-data
    pool per configured provider (`windows: []`, no balance, zero burn), no throw.
11. Multi-writer segments: two segments with interleaved `ts` → identical snapshot regardless
    of segment file order (reader's deterministic sort + eventId dedupe exercised end-to-end).
12. Malformed tolerance: a malformed line and a vendor-prefixed unknown type among valid events
    → both counted in `snapshot.diagnostics`, valid events still projected
    (tolerant-with-diagnostic surfaced, not swallowed).
13. Balance geometry: usage event carrying a `balance` observation → `PoolState.balance`
    populated with its own channel/observedAt; `provider-limit` with fault
    `"balance-exhausted"` → `balance.exhausted: true`, no window fabricated.
14. Staleness: `newestObservationAt` = max `observedAt`; a window whose `resetsAt < now` is
    retained unchanged (no TTL, no clearing); `generatedAt` = injected now.
15. `configuredProviders`: union over profiles + authoring slots, always includes `claude`,
    stable order; providers with observations but no config still get a pool.

**`__tests__/usage-cli.test.ts` (new)**
16. `renderUsage`: window rows show fraction/status/reset/channel/age; `—` for unknowns;
    no-data pools render the explicit "no observations — estimated tier" line (AC-3);
    passed-reset rendering; diagnostics summary line appears only when counts are nonzero
    (assert on `stripAnsi` output).
17. `runUsageCommand`: `--json` on an empty tmp store → exit 0 + parseable `UsageSnapshot`
    with configured no-data pools; populated store → exit 0, windows present (AC-1 shape,
    hermetic); unknown flag via `main` parse → exit 2. All via injected
    `root`/`configPath`/`home`/`now` (host `.pelaggio.yml` and real `.dev/` never read).

**`__tests__/flow-events.test.ts` (extend)**
18. `poolId` round-trips on both new event types; non-string `poolId` fails append fail-closed;
    valid `balance` observation round-trips; bad `balance.channel` fails append; both remain
    readable by the tolerant reader when hand-written malformed.

**Live verification (AC-1, manual, post-implement, after #581 lands)**: one real
`pnpm pelaggio --cycles 1`, then `npx pelaggio usage` — Claude 5h/weekly(+opus/sonnet) rows
with utilization, reset times, per-window ages.

## Migration / compatibility

- **No events at all** → `usage` reports configured pools as explicit no-data, exit 0 (test 10).
- **Pre-#581 history** (cycle log only) → estimated-tier park facts + burn via the dual-format
  reader; nothing fabricated (test 8).
- **#581-era events without `poolId`** → assumed-current attribution, marked (test 7).
- **Future #582/#584/#585 events** → validate under the same payload validators (probed channel,
  balance observation, new fault slugs are opaque strings); consumer-prefixed types keep landing
  in `unknownType` diagnostics. #586 consumes `UsageSnapshot` as its strategy snapshot seam.
- **Realm change** → old-pool observations excluded and summarized, never merged (test 6).
- Additive-optional event fields only; no schema version bumps; no data migration; no config
  surface; `usage` writes nothing.

## Non-goals (boundaries with sibling charters)

- **No strategy**: no kinds, holds, ordering, `quota:` config, `stale-after` thresholds, no
  `headroom(pool)` scalar — #586. (The projector deliberately exposes raw
  fractions/ages and lets policy judge them.)
- **No scheduling or ordering change, no pool-parallel cycles** — #246 (blocked on the future
  per-pool ledger, not this item). No reservation/settle ledger — #465/G2.
- **No Codex/Grok emission or fault typing** — #582; **no probes, no network** — #584/#585.
  This item only defines the shapes their observations will fold into.
- **No absolute-cap configuration** and no locally computed `usedFraction` — charter-forbidden.
- **No review-record ingestion**: the charter fixes the source set as flow events + cycle log.
  Review-seat burn (in `.dev/review-records/` per #581) is a natural additive follow-up source
  for `burn`, operator-decidable later; excluded here to keep the source contract
  charter-literal.
- **No persisted snapshot**, no `.pelaggio.yml` edits (conservation comments are superseded
  functionally; the live config is user work and a host-test seam), no `stats.ts` changes,
  no README restructure (bin HELP is the canonical command list).
- **No full `docs/config.md` non-goal rewrite** — #586 AC-5 (decision 9's minimal amendment
  only).

## Step-indexed maps / invariants check

- No pipeline step added → no `STEPS` map updates; no skill bodies, no model IDs, no
  frontmatter reliance.
- Mechanism/policy spine: the projector and CLI are deterministic harness mechanism — pure
  functions over local files; the model is never invoked; nothing here gates anything.
- Flow invariants: projection non-authoritative (zero persisted state); historical facts stay
  authoritative in the append-log; the projector derives and never rewrites; reader stays
  tolerant-with-diagnostic; `pelaggio.*` registry stays closed; single-writer-per-segment
  untouched (this item adds no writer).
- Secret hygiene: `poolId` digests never include secret bytes (identity UUIDs or file-stat
  epochs only); event payloads keep #581's scrub/bounding path.
- Worktree isolation, park/checkpoint semantics, `ship.target`, claims: untouched.
- No `preinstall`/`install`/`postinstall` scripts; no new dependencies.
