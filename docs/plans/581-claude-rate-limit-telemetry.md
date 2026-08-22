# Plan #581 — Retain Claude rate-limit telemetry and type park window identity

Charter: issue #581. First increment of `docs/agent-context/provider-quota.md` (tenets 1, 2, 6).
Pure mechanism; no behavior change. Design context is settled in the routed doc; this plan
implements #581's slice only. Downstream consumers: #582 (Codex/Grok typed faults reuse the event
types), #583 (projector + `pelaggio usage` reads these events), #584 (probed channel), #586
(strategy). Nothing in this plan depends on those items.

## Acceptance criteria (from the charter)

- **AC-1**: a normal Claude step in a live run produces `pelaggio.provider-usage` events carrying
  utilization + window name + resetsAt, verifiable by reading `.dev/flow-events/`.
- **AC-2**: a Claude rate-limit park records provider and window identity in the cycle log;
  existing park/resume behavior unchanged.
- **AC-3**: registry addition validates fail-closed (unknown-type rejection untouched); event
  records stay under `MAX_FLOW_EVENT_BYTES` with a truncation diagnostic on oversize.

## Current mechanism (audited at HEAD `01cbc8a`)

- **Signal arrival**: `step-runner.ts:521-537`. The Claude Agent SDK (0.3.220) emits
  `rate_limit_event` whenever rate-limit info changes. `SDKRateLimitInfo` carries
  `status` (`allowed | allowed_warning | rejected`), `resetsAt?`, `rateLimitType?`
  (`five_hour | seven_day | seven_day_opus | seven_day_sonnet | seven_day_overage_included |
  overage`), `utilization?`, `surpassedThreshold?`, and full overage state. Today every event is
  dropped unless `status === "rejected"`; the rejected branch keeps only `resetsAt` + `limitType`
  on the shared `ParkSignal`. One event = one window observation (the SDK reports the binding
  window per event, not all windows).
- **Park identity**: `ParkSignal` (`types.ts:549-554`) is `{ parked, resetsAt, limitType,
  triggerWorker }` — no provider, no typed window. `classifyParkReason` (`helpers.ts:670-682`)
  collapses every non-`paused`/non-`sdk-outage` limitType to `"rate-limit"`. The cycle log entry
  (`pipeline.ts:1006-1008`) records free-form `parkReason` plus closed `parkClass`.
- **Reset resolution**: `resolveParkReset` (`helpers.ts:1731-1737`) resolves event reset →
  text-parsed reset → `now + estimate` (suffixing `limitType` with `" (estimated)"`), applied at
  `step-runner.ts:660-664`. Provenance of the reset is only recoverable by string-matching the
  suffix.
- **Flow events**: `flow-events.ts` is live — closed registry `PELAGGIO_EVENT_TYPES`, ULID
  envelope, `decodeV1` fail-closed validation on append, `MAX_FLOW_EVENT_BYTES = 64 KiB`
  (append **throws** on oversize), tolerant-with-diagnostic reader, legacy cycle-log promotion.
  A writer exists only for continuous runs (`continuousWriter`, `pipeline.ts:3013-3019`, env-pinnable
  via `PELAGGIO_EVENT_STREAM_ID` / `PELAGGIO_EXECUTION_ID`); its emit wrapper
  (`pipeline.ts:3020-3027`) is the house fail-open pattern.
- **Review seats**: `ReviewPassRecord` (`review/loop.ts:42-48`) keeps `{cost, turns}` per
  reviewer/judge entry and discards `StepResult.tokens`, which the Claude runner already returns
  (`step-runner.ts:612-620, 685`). Records persist via `review/record.ts` (atomic tmp+rename,
  0o600, `.dev/review-records/`).
- **Known defects planned around, not into**: #458 (the sdk-outage relabel at
  `pipeline.ts:3260-3266` happens after `finish()` has appended — this plan emits telemetry at the
  step effect site, *before* `finish()`, and adds no post-append relabels) and #454
  (`StepLog.model: "default"` — this plan binds nothing to `StepLog.model`; window identity
  carries model family natively via `seven_day_opus` / `seven_day_sonnet`).

## Design decisions

1. **Park-window identity is the tuple `(provider, windowName, resetsAt)`**, qualified by
   `resetSource`. `resetsAt` (epoch ms, the value `awaitParkReset` already sleeps on)
   discriminates *this* window instance from the next instance of the same named window, and the
   provider re-reports the same reset across retries — so the tuple is stable across in-process
   resume and cross-restart `--resume`, with no locally minted ID to persist or reconcile. The
   same tuple appears on the `pelaggio.provider-limit` event and the cycle-log `parkWindow`
   field, making it the join key across event stream ↔ cycle log ↔ resume. When `resetSource` is
   `"estimated"` the identity is approximate (locally synthesized reset); consumers can see that
   from the field rather than from the `" (estimated)"` string suffix. `poolId` (auth-realm
   discriminator) is deliberately absent — #583 owns pool identity; adding it later is an
   additive optional field.
2. **`ParkClass` stays closed and unchanged.** AC-2 requires "existing park/resume behavior
   unchanged" and `parksByClass` keys feed `stats.ts` (`stats.ts:156-173, 290, 391`) and its
   tests. The design doc's "stop collapsing 5h-vs-weekly" is satisfied by carrying typed window
   identity *beside* the class (`parkWindow` on the log entry, `window` on the event), not by
   forking the class union and silently re-keying dashboards. #583's rendering can subdivide.
3. **Telemetry capture is a typed harness-side callback, fail-open end to end.** The runner
   invokes an optional `onProviderTelemetry` callback (new `RunStepOpts` field) with a typed
   observation at the effect site; the pipeline binds envelope context (itemId, step) and appends
   via the run writer. Every layer guards: the runner wraps the callback in try/catch, the append
   helper never throws (bound → scrub → append; on failure retry once with `detail` stripped +
   `detailTruncated: true`; on second failure one dim console diagnostic). Losing a telemetry
   record can never fail a step or cycle. The model is never involved — no prompt, no skill, no
   judgment.
4. **The flow-event writer becomes run-scoped instead of continuous-only.** `createEventWriter`
   does no I/O until first append, so promoting `continuousWriter` to an unconditional run writer
   is free for runs that emit nothing. Continuous-lifecycle events stay gated on `continuous`;
   usage/limit events use the same writer (one writer per orchestrator process — parallel workers
   share it, preserving single-writer-per-segment). Dry runs get no writer (they write nothing
   today; keep it that way).
5. **Event payloads are observations, charter-literal.** Non-rejected `rate_limit_event`s →
   `pelaggio.provider-usage` (per-window `channel: "reported"` + `observedAt` stamps; only the
   window actually reported — never a projected `PoolState`). Rejected events →
   `pelaggio.provider-limit` with a `disposition` (`parked` | `continued-on-overage` |
   `already-parked`). The parked-case limit event is finalized after `resolveParkReset` so it
   carries the resolved reset + typed `resetSource`; the other two emit inline. Raw
   `rate_limit_info` rides as a bounded, secret-scrubbed `detail` projection (fat,
   self-contained), and the `gen_ai.*` token fields are validated-optional in the payload schema
   — the Claude `rate_limit_event` carries no token counts, so #581's emitter never populates
   them; #582/#584 emitters will. Token *history* remains authoritative where it already lives:
   `StepLog.tokens` in the cycle log (which `readEventLog` already ingests) and — new in this
   item — `ReviewPassRecord` entries. No duplicate token events, no double counting.
6. **`resolveParkReset` grows a typed `resetSource` return field** (`"reported" | "text-parse" |
   "estimated" | "none"`, one per existing branch). The `" (estimated)"` limitType suffix is
   preserved byte-for-byte (park banner / notify / jsonl compatibility); the typed field simply
   stops downstream consumers from parsing it.
7. **Non-Claude providers: stale-window hygiene only.** Codex/Grok/OpenCode park sites gain one
   line each clearing `provider`/`windowName`/`resetSource` when they apply a `parkUpdate`, so a
   non-Claude park can never inherit a stale Claude window from the shared signal. Typing their
   faults (slugs, real resets, 402) is #582 and is not touched here.

## Schemas

### Types (in `types.ts`)

```ts
export type QuotaChannel = "reported" | "probed" | "estimated";
export type ParkResetSource = "reported" | "text-parse" | "estimated" | "none";

/** Typed identity of a rate-limit park window. Identity = (provider, windowName, resetsAt);
 *  resetSource qualifies trust in resetsAt (an "estimated" reset makes identity approximate).
 *  resetsAt units follow the existing ParkSignal semantics (epoch ms as consumed by
 *  awaitParkReset) — #581 records what the harness already acts on, no reinterpretation. */
export interface ParkWindowIdentity {
	provider: ProviderName;
	windowName: string; // SDK rateLimitType (e.g. "five_hour", "seven_day_opus"); "unknown" when absent
	resetsAt: number;   // final resolved epoch ms — the window-instance discriminator
	resetSource: ParkResetSource;
}

/** One provider-reported window state, stamped with provenance at the observation. */
export interface ProviderWindowObservation {
	name: string;
	channel: QuotaChannel;   // "reported" for every #581 emission
	observedAt: number;      // epoch ms capture instant at the effect site
	status?: "allowed" | "allowed_warning" | "rejected";
	utilization?: number;
	resetsAt?: number;
	surpassedThreshold?: number;
}

/** Typed observation handed from a step runner to the harness telemetry sink. */
export type ProviderTelemetryObservation =
	| { kind: "usage"; provider: ProviderName; observedAt: number; windows: ProviderWindowObservation[]; detail?: unknown }
	| {
			kind: "limit";
			provider: ProviderName;
			fault: string; // stable slug assigned in the provider adapter; claude: "rate-limit"
			observedAt: number;
			window: { name: string; resetsAt: number; resetSource: ParkResetSource };
			disposition: "parked" | "continued-on-overage" | "already-parked";
			utilization?: number;
			detail?: unknown;
	  };
```

`ParkSignal` gains three optional fields (flat, per the charter wording; absent = untyped/manual):

```ts
export interface ParkSignal {
	parked: boolean;
	resetsAt: number;
	limitType: string;
	triggerWorker: string;
	/** Typed park provenance (#581). Set only by provider adapters that type their limits
	 *  (claude today); manual pause / sdk-outage / untyped providers leave them unset. */
	provider?: ProviderName;
	windowName?: string;
	resetSource?: ParkResetSource;
}
```

`CycleLogEntry` gains `parkWindow?: ParkWindowIdentity` (written only for signal-driven parks
whose adapter typed the window — i.e. `parked && parkSignal.parked && parkSignal.provider`).
`PelaggioEventType` gains the two new members.

### `pelaggio.provider-usage` (event payload beside the standard envelope)

```jsonc
{
  "v": 1, "type": "pelaggio.provider-usage", /* eventId/streamId/seq/ts/executionId… */
  "itemId": "581",                    // envelope correlation; null for unclaimed steps
  "provider": "claude",
  "step": "implement",                // seat context (pipeline Step name)
  "observedAt": 1774123456789,
  "windows": [
    { "name": "five_hour", "channel": "reported", "observedAt": 1774123456789,
      "status": "allowed", "utilization": 0.63, "resetsAt": 1774130000000 }
  ],
  // gen_ai.* token fields: validated-optional, never emitted by the #581 Claude capture
  // ("gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens",
  //  "gen_ai.usage.cache_creation_input_tokens", "gen_ai.usage.cache_read_input_tokens")
  "detail": { /* full raw SDKRateLimitInfo, secret-scrubbed, bounded */ },
  "detailTruncated": true             // present only when bounding dropped `detail`
}
```

Fail-closed validation (in `decodeV1`): `provider` non-empty string; `windows` a non-empty array
(or at least one `gen_ai.usage.*` field present) of records with non-empty `name`, `channel` in
the closed set, `observedAt` a positive safe integer; numeric fields finite where present.

### `pelaggio.provider-limit`

```jsonc
{
  "v": 1, "type": "pelaggio.provider-limit", /* envelope */
  "itemId": "581",
  "provider": "claude",
  "fault": "rate-limit",              // closed per-provider slug; codex/grok slugs arrive in #582
  "step": "implement",
  "observedAt": 1774123456789,
  "window": { "name": "seven_day_opus", "resetsAt": 1774130000000, "resetSource": "reported" },
  "utilization": 1.0,
  "disposition": "parked",            // "parked" | "continued-on-overage" | "already-parked"
  "detail": { /* raw SDKRateLimitInfo, scrubbed, bounded */ }
}
```

Fail-closed validation: `provider`/`fault` non-empty strings; `window` record with non-empty
`name`, `resetsAt` a non-negative safe integer, `resetSource` in the closed set; `disposition` in
the closed set.

The park linkage is by construction: the event's `(provider, window.name, window.resetsAt)`
equals the cycle-log `parkWindow` tuple for the same park, plus shared `itemId`.

### Bounding + scrubbing (the writer's 64 KiB limit, AC-3)

`createEventWriter().append` keeps its fail-closed throw (it protects the log). The *emission
helper* owns never-throwing: serialize `detail`; scrub with `makeSecretScrubber()`
(`secret-hygiene.ts:147`); if the serialized detail exceeds `MAX_TELEMETRY_DETAIL_BYTES`
(8 KiB — comfortably under the 64 KiB record limit with envelope headroom), drop `detail` and set
`detailTruncated: true`; if `append` still throws (defense in depth), retry once without `detail`,
then swallow with a dim console diagnostic. For Claude the detail is a ~300-byte enum/number
record — the bounding path exists for the contract (#582's error bodies), verified by test here.

## File-by-file changes

1. **`packages/pelaggio/scripts/pelaggio/types.ts`**
   - `PelaggioEventType` union (`:264-284`): add `"pelaggio.provider-usage"`,
     `"pelaggio.provider-limit"`.
   - Add `QuotaChannel`, `ParkResetSource`, `ParkWindowIdentity`, `ProviderWindowObservation`,
     `ProviderTelemetryObservation` (near the flow-event section).
   - `ParkSignal` (`:549-554`): add optional `provider` / `windowName` / `resetSource`.
   - `CycleLogEntry` (`:233-260`): add `parkWindow?: ParkWindowIdentity` beside `parkClass` with
     a doc comment naming the identity tuple.
   - `PipelineOpts` (`:492+`): add `emitFlowEvent?: (input: FlowEventInput) => void` (fail-open
     contract documented: the supplied function must never throw; the orchestrator's wrapper owns
     that).

2. **`packages/pelaggio/scripts/pelaggio/flow-events.ts`**
   - `PELAGGIO_EVENT_TYPES` (`:8-28`): add the two types (the `EVENT_TYPE_COVERAGE` mapped type
     forces the union/registry to stay in lockstep — compile error if either side drifts).
   - `decodeV1` (`:70-88`): add `isProviderUsageFields` / `isProviderLimitFields` structural
     validators, applied like the existing `isCycleFields` branch. Unknown-type rejection path
     (`:223-226`) is untouched.

3. **New `packages/pelaggio/scripts/pelaggio/provider-telemetry.ts`** (single-purpose,
   provider-neutral module, mirroring the small-module house pattern of `review/record.ts` /
   `freshness-gate-record.ts`; no SDK imports — #582's codex/grok emitters reuse it as-is)
   - `boundTelemetryDetail(detail: unknown, scrub: (s: string) => string)` — serialize, scrub,
     cap at `MAX_TELEMETRY_DETAIL_BYTES = 8 * 1024`; returns `{ detail?: unknown;
     detailTruncated?: true }`.
   - `buildProviderUsageInput(...)` / `buildProviderLimitInput(...)` — pure observation →
     `FlowEventInput` builders (attach `step`, correlations, bounded detail).
   - `appendTelemetryEvent(writer: EventWriter, input: FlowEventInput): void` — the
     never-throws append (retry-sans-detail, then diagnostic-and-swallow).

4. **`packages/pelaggio/scripts/pelaggio/step-runner.ts`** (the Claude adapter — provider
   knowledge stays here, per the design doc's slugs-are-assigned-in-the-adapter rule)
   - `RunStepOpts` (`:45-78`): add
     `onProviderTelemetry?: (obs: ProviderTelemetryObservation) => void`.
   - New exported pure helper `projectClaudeRateLimitEvent(info: SDKRateLimitInfo,
     alreadyParked: boolean, observedAt: number)` — maps one SDK event to a
     `ProviderTelemetryObservation` (usage for non-rejected; limit with the correct disposition
     for rejected) including window fields, the `"rate-limit"` fault slug, and the raw-info
     detail. Exported for direct unit testing: the #420 dispatcher guard blocks live provider
     runs under `node --test`, so branch coverage comes from extraction — the same precedent as
     the codex `parkUpdate` builders.
   - Rate-limit handler (`:521-537`), all inside the existing `for await` — every branch wraps
     the callback in try/catch (fail-open at the capture site):
     - non-rejected (`status !== "rejected"`): invoke callback with the projected **usage**
       observation. No behavioral change to the stream loop.
     - rejected + park branch (`:525-533`): additionally set `parkSignal.provider = "claude"`,
       `parkSignal.windowName = info.rateLimitType ?? "unknown"`; stash the pending **limit**
       observation (disposition `"parked"`) for finalization after reset resolution.
     - rejected + overage-continue (`:534-535`): invoke callback with a **limit** observation,
       disposition `"continued-on-overage"`.
     - rejected while `parkSignal.parked` already true: invoke callback with a **limit**
       observation, disposition `"already-parked"` (observation only; no signal mutation —
       today's behavior).
   - Reset resolution (`:658-664`): consume the widened `resolveParkReset` return; set
     `parkSignal.resetSource`; finalize + emit the stashed parked-limit observation with the
     resolved `resetsAt`/`resetSource` (only when `rateLimitPark` — a manual pause or foreign
     park emits nothing).

5. **`packages/pelaggio/scripts/pelaggio/helpers.ts`**
   - `resolveParkReset` (`:1731-1737`): return type widens to
     `{ resetsAt: number; limitType: string; resetSource: ParkResetSource }` — `"reported"` /
     `"text-parse"` / `"estimated"` / `"none"` per existing branch; string outputs unchanged.
   - `classifyParkReason` (`:670-682`): **no change** (decision 2).

6. **`packages/pelaggio/scripts/pelaggio/pipeline.ts`**
   - `finish()` log append (`:1006-1008` vicinity): add
     `...(parked && parkSignal.parked && parkSignal.provider ? { parkWindow: { provider: parkSignal.provider, windowName: parkSignal.windowName ?? "unknown", resetsAt: parkSignal.resetsAt, resetSource: parkSignal.resetSource ?? "none" } } : {})`.
     Same append, same timing — no new post-append relabel (#458 planned around).
   - `step()` runStep invocation (`:675-692`): when `opts.emitFlowEvent` is present, pass
     `onProviderTelemetry` mapping the observation through the `provider-telemetry.ts` builders
     with `itemId` + step name, calling `opts.emitFlowEvent`.
   - `runOrchestrator` (`:3013-3027`): promote `continuousWriter` to an unconditional run-scoped
     `eventWriter` (same env pinning); keep lifecycle emissions (`suspended`/`resumed`/watch/
     budget) gated on `continuous` exactly as today; build the fail-open
     `emitFlowEvent = (input) => appendTelemetryEvent(eventWriter, input)` and thread it into
     every `runPipeline` call's opts **except dry runs**.
   - `emitSuspendedIfParked` (`:3034-3044`): additively include
     `provider`/`windowName`/`resetSource` on the `pelaggio.suspended` payload when present on
     the signal (optional fields; reader-compatible).
   - Park-signal hygiene: clear `provider`/`windowName`/`resetSource` at the `awaitParkReset`
     resume reset (`:2738-2741`) and the SIGUSR2 pause site (`:2773-2777`); the sdk-outage
     relabel (`:3260-3266`) also clears them (an outage is not a window). No other logic there
     changes.

7. **`packages/pelaggio/scripts/pelaggio/codex-provider.ts` (`:513-516`),
   `grok-provider.ts` (`:446-449`), `opencode-provider.ts` (`:498-501`)**
   - When applying a `parkUpdate` that sets `parked`, clear
     `provider`/`windowName`/`resetSource` on the shared signal (decision 7 — hygiene only, no
     fault typing).

8. **`packages/pelaggio/scripts/pelaggio/review/loop.ts`**
   - `ReviewPassRecord` (`:42-48`): reviewer entries and the judge entry gain
     `tokens?: TokenUsage`.
   - Populate from `StepResult.tokens` at the reviewer record sites (`:251-259` and the catch
     path `:261`) and the completed-judge site (`:364`). The rejected-promise (`:231`) and
     skipped-judge (`:278`, `:290`) records have no result and stay token-less. Persistence is
     free: `ReviewRecord`/`DocReviewRecord` embed `ReviewLoopResult.passes` and
     `validateReviewRecord`/`validateDocReviewRecord` are structural on top-level fields —
     verify in tests that the added optional nested field round-trips.

9. **`packages/pelaggio/scripts/pelaggio/index.ts`**
   - Export the new `provider-telemetry.ts` pure builders alongside the existing flow-events
     exports (`:20`) for parity with the module-export house style.

No changes to: `stats.ts` (entries without `parkWindow` render exactly as today; rendering window
identity is #583's `usage` surface), `config.ts` / `.pelaggio.yml` (no config surface in #581),
skills, `docs/config.md`.

## Capture points (signal → artifact)

| Signal | Code point (today) | Captured as |
| --- | --- | --- |
| `rate_limit_event`, status allowed/warning | dropped at `step-runner.ts:521` | `pelaggio.provider-usage`, channel `reported`, emitted inline at the handler |
| `rate_limit_event`, rejected → park | `step-runner.ts:525-533` (keeps resetsAt/limitType only) | `parkSignal.{provider,windowName}` at `:528-531`; `pelaggio.provider-limit` disposition `parked` emitted after `resolveParkReset` at `:660-664` with resolved reset + `resetSource` |
| `rate_limit_event`, rejected → overage continue | `step-runner.ts:534-535` (console emit only) | `pelaggio.provider-limit`, disposition `continued-on-overage`, inline |
| `rate_limit_event`, rejected, already parked | falls through at `step-runner.ts:525` | `pelaggio.provider-limit`, disposition `already-parked`, inline |
| Park persisted to cycle log | `pipeline.ts:1006-1008` (free-form `parkReason` + `parkClass`) | + `parkWindow: ParkWindowIdentity` in the same append |
| Continuous suspension | `pipeline.ts:3034-3044` (`reason` + `resumeAt`) | + optional `provider`/`windowName`/`resetSource` fields |
| Review-seat token usage | discarded at `review/loop.ts:251-261, 364` | `tokens?: TokenUsage` on `ReviewPassRecord` entries |

All capture is deterministic harness mechanism at the effect site; the model neither produces nor
gates any of it, and every capture path is fail-open (a lost record logs a diagnostic and the
step/cycle proceeds unchanged).

## Test plan

`node:test` throughout; run with `npx tsx --test <file>`.

**`__tests__/provider-telemetry.test.ts` (new)**
1. `boundTelemetryDetail`: small detail passes through scrubbed; a detail containing a
   secret-env value comes back `[REDACTED]`; an oversize detail (> 8 KiB) → `detail` dropped,
   `detailTruncated: true`; result always yields an appendable record under
   `MAX_FLOW_EVENT_BYTES` (AC-3).
2. `appendTelemetryEvent`: writer stub whose `append` throws once (oversize) → retried without
   `detail`, second input has `detailTruncated: true`; writer that always throws → no throw to
   the caller (fail-open capture).

**`__tests__/flow-events.test.ts` (extend)**
3. Round-trip: valid `provider-usage` and `provider-limit` inputs append and read back typed.
4. Fail-closed on append: missing `provider`, empty `windows` with no token fields, bad
   `channel`, bad `disposition`, bad `resetSource` → `append` throws "Invalid flow event".
5. Reader tolerance: a hand-written malformed `provider-usage` line (unknown channel) →
   `malformed` diagnostic, other events still read; an unrelated unknown type still lands in
   `unknownType` (AC-3's "unknown-type rejection untouched"); a legacy cycle log with no
   telemetry files reads exactly as before (absent telemetry changes nothing).

**`__tests__/step-runner.test.ts` (extend)**
6. `projectClaudeRateLimitEvent`: table-driven over `SDKRateLimitInfo` fixtures — allowed
   (utilization + reset → usage observation with per-window `channel`/`observedAt`),
   allowed_warning, rejected + not-parked (limit, disposition `parked` skeleton), rejected +
   overage-available (limit, `continued-on-overage`), rejected + `alreadyParked` (limit,
   `already-parked`), missing `rateLimitType` → `"unknown"`, missing `utilization`/`resetsAt` →
   fields absent (never fabricated — tenet 1).

**`__tests__/helpers.test.ts` (extend)**
7. `resolveParkReset` returns `resetSource` `"reported"` / `"text-parse"` / `"estimated"` /
   `"none"` per branch; existing `resetsAt`/`limitType` assertions byte-identical (the
   `" (estimated)"` suffix still applied).

**`__tests__/pipeline.test.ts` (extend)**
8. A cycle whose stubbed `runStep` parks with
   `{ parked: true, resetsAt, limitType: "seven_day_opus", provider: "claude", windowName:
   "seven_day_opus", resetSource: "reported" }` → log entry has
   `parkWindow: { provider: "claude", windowName: "seven_day_opus", resetsAt, resetSource:
   "reported" }` and `parkClass: "rate-limit"` (unchanged class — AC-2).
9. A manual-pause park (`limitType: "paused"`, no provider) and a review-loop reason park →
   **no** `parkWindow`; existing parked/resume assertions untouched.
10. A stubbed step invoking `opts.onProviderTelemetry` with a usage observation while
    `opts.emitFlowEvent` is wired → one `pelaggio.provider-usage` event in the run's segment
    with the step's `itemId` (AC-1 shape, hermetic); with `emitFlowEvent` absent (direct
    `runPipeline` callers, review CLIs) → no throw, no file.
11. Stale-window hygiene: signal pre-loaded with claude window fields, then a codex-style
    `parkUpdate` application → fields cleared, no `parkWindow` misattribution (unit-level at
    the provider apply site if reachable, else via the pipeline stub).

**`__tests__/review-loop.test.ts` / `__tests__/review-record.test.ts` (extend)**
12. A completed reviewer/judge seat whose `StepResult` carries `tokens` → `ReviewPassRecord`
    entries carry the same `TokenUsage`; a failed/rejected seat entry has no `tokens`; a
    record containing `tokens` survives `writeReviewRecord` → read-back (validators tolerate
    the addition).

**Live verification (AC-1, manual, post-implement)**: one real `pnpm pelaggio --cycles 1` cycle;
inspect `.dev/flow-events/<streamId>.jsonl` for `pelaggio.provider-usage` events carrying
utilization + window name + resetsAt.

## Migration / compatibility

- **Absent telemetry files change nothing**: the reader already tolerates a missing
  `.dev/flow-events/` dir; no consumer in this item reads the new events (that is #583).
- **Cycle log**: `parkWindow` is additive-optional. `decodeV1`'s `isCycleFields` checks required
  fields only; `stats.ts` touches only known fields; legacy entries (no `parkWindow`) are
  "unrecorded", same as the existing `parkClass` posture.
- **Review records**: additive-optional nested field; `schemaVersion` stays 1 (validators are
  top-level structural; verified by test 12).
- **`resolveParkReset` callers**: only `step-runner.ts:661`; the widened return is
  backward-compatible at every other consumer (none destructure a closed shape).
- **`ParkSignal`**: optional fields; `Object.assign` child→parent propagation in the review loop
  (`review/loop.ts:224`) carries them automatically.
- No config, no CLI surface, no schema version bumps, no data migration.

## Non-goals (boundaries with sibling charters)

- **No projector, no `PoolState`/`QuotaWindow` normal-form types, no merge-by-window, no
  `poolId`, no `pelaggio usage` CLI** — #583.
- **No Codex/Grok fault typing** (429 `UsageErrorBody` parsing, `AcpRpcError.data` retention,
  fault slugs beyond claude's `"rate-limit"`) — #582. The hygiene lines in decision 7 clear
  state; they type nothing.
- **No probe sidecars, no `codex app-server`** — #584.
- **No strategy kinds, no `quota:` config, no demand classes, no allocation events** — #586.
- **No fix for #458** (sdk-outage tripping-cycle persistence) or **#454** (`model:"default"`) —
  planned around per the Current-mechanism section.
- **No event throttling/aggregation**: the SDK already coalesces (emits on change only); if a
  live run shows unacceptable volume, revisit with data (operator-decidable later, not here).
- **No `ParkClass` widening**, no `stats.ts` rendering changes.
- **No flow-event emission from the standalone review CLIs** (`pr-review`, `doc-review`): their
  Claude seats simply pass no `onProviderTelemetry`; their token retention lands via
  `ReviewPassRecord`. Wiring their processes into the event stream is future work if #583 wants
  it.

## Step-indexed maps / invariants check

- No pipeline step is added → no `STEPS` map updates.
- No skill bodies change; no model IDs touched; no frontmatter reliance.
- Worktree isolation untouched — the event writer appends to the main repo's `.dev/` from the
  harness process (existing continuous-writer behavior; `.dev/` is confinement-exempt scratch).
- Rate-limit paths still park through `parkExit()`; nothing changes checkpoint semantics.
