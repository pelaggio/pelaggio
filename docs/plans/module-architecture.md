# Module architecture refactor

Status: in progress, revision 2. Measured 2026-08-29 at `6aa6661` (import
graph of `packages/pelaggio/scripts/pelaggio`, 87 non-test files) and the
provenance / graph surveys recorded in the drafting session. Revision 1 was
hard-blocked by `doc-review` (12 survivors, record
`.dev/doc-review-records/doc-313d5ec95337-mtelqfdt.json`) and an independent
maintainability review; both are folded in below.

This is a hand-driven, one-step-at-a-time migration run from the operator
workbench. Lane cycles are **paused** while it lands (§5).

## 1. Findings the plan answers

| Surface | Measured state |
|---|---|
| Lifecycle steps | `runPipeline` (`pipeline.ts:337-2605`, ~2,270 lines) is a **linear script**: four `if (shouldRun("<step>"))` blocks (`:1450` plan, `:1496` shakedown-plan, `:1530` implement, `:1725` shakedown-code) plus pick/ship prologue and epilogue, all sharing **75 top-scope `let`/`const` bindings**. It dispatches on `name ===` only 13 times, 9 of them on the ship target. `runOrchestrator` (`:2867-4360`, ~1,500 lines) shares the file. `STEPS` is a string tuple; per-step settings are resolved through `resolveStepSettings(config, profile, step)` over eight profile-first sparse maps. |
| Agent hand-off | `step-runner.ts` imports three providers (`codex`, `grok`, `opencode`; Claude is inline) and they import `StepProvider` back (type-only cycle). All four import six outcome-classification helpers from `helpers.ts`. |
| Integration | `ship/` exists; internal cycle `index ↔ auto-merge-pr ↔ decision ↔ pull-request`; `ship/pr-effects ↔ effects`. |
| Provenance | ~20 persisted `.dev/` formats, no shared envelope/reader/writer, 10 tmp+rename sites (one is `file-lock.ts`, not a register), 3 validator-failure conventions. Only 4 registers have `*_DIR` constants; `.dev/ship` (14 literals), `.dev/plans` (8), `.dev/review-records` (5), `.dev/doc-review-transcripts` (5) are hand-built strings. `BASH_DENIED_DEV_REGISTERS` names 5 registers; `effects`, `execution-receipts`, `attempts`, `flow-events` are not on it. |
| Control | `packages/server` already imports `readEventLog` for finished runs (`external-runs.ts:7`); `flow-event-tailer.ts:77,101` and `routes/repos.ts:50` still hand-build `.dev` paths and re-implement the `v:1` envelope check. |
| Graph | Zero coupling to product code (correct per ADR-0027). Shadow lane: 6 independent `JSON.parse` sites of `shadow-graph.json` with two competing TS types (`ci/assurance-views.ts:10` vs `ci/__tests__/shadow-assurance.test.ts:9`); `views.json` (0.2.0) parsed in 4 places, never version-bound to the graph (0.3.0). Corpus lane is a separate kernel (evidence vs realization) — its reconciliation is RFC Phase I, **not this plan**. |
| Cross-cutting | Entry modules are libraries: `pr-review-cli.ts` (1,455 lines) has 6 importers incl. `pipeline.ts:108` (`runPrReviewGate`); `roadmap-cli.ts` is imported at runtime by `continuous.ts`; `revise-cli.ts:30` imports `parseCli` from `cli.ts`. Upward edges: `config → notify`, `types → config`, `execution-receipt → effects`, `review/record → review/loop`, `effects/decisions/review-adjudication/stale-quarantine → helpers`, `step-runner + 3 providers → helpers`. 4 non-trivial SCCs (sizes 4, 8, 2, 7). |

## 2. Target module map

Layers, lowest first. **Rule: a module imports only its own layer or lower.**
Each layer has an admission question; if a module answers "yes" to a higher
layer's question it belongs there.

| Layer | Admission question | Members |
|---|---|---|
| L0 `foundation` | *Pure types/config/util? No I/O beyond config load, no `.dev` writes.* | `types.ts`, `steps.ts` (new — `STEPS`, `PipelineStep`, `Step`, `isPipelineStep`), `config.ts`, `cli.ts` (argv parsing), `tui.ts`, `secret-hygiene.ts`, `file-lock.ts`, `artifact-root.ts`, `attempt-identity.ts`, `text.ts` (new), `review/taxonomy.ts`, `review/document.ts`, `roadmap/types.ts` |
| L1 `infra` | *Reads/writes a register, runs git, or confines — but never decides policy?* | `git.ts` (new), `registers.ts` (new), `outcome-classify.ts` (new), `skills.ts` (new), `flow-events.ts`, `execution-receipt.ts`, `freshness-gate-record.ts`, `pr-review-gate-record.ts`, `review-findings-archive.ts`, `review/findings.ts`, `review/record.ts`, `review/seats.ts`, `github-posting.ts`, `confinement/*`, `roadmap/*` |
| L2 `domain` | *Decides something (policy, verdict, disposition) without spawning a provider?* | `effects.ts`, `decisions.ts`, `review/{loop,carry,adjudication,bench}.ts`, `ship/*`, `provider-routing.ts`, `driver-assignment.ts`, `flow-policy.ts`, `flow-snapshot.ts` (new), `continuous.ts`, `stats.ts`, `notify.ts`, `review-sweep.ts`, `revise-sweep.ts`, `review-request-queue.ts`, `worktree-deps.ts`, `run-lifecycle*.ts`, `pick-parse.ts` (new) |
| L3 `execution` | *Spawns or talks to a model/agent process?* | `providers/{types,claude,codex,grok,opencode,index}.ts` (new dir), `step-runner.ts`, `step-runner-shared.ts`, `claude-seat.ts`, `acp-client.ts`, `contained-execution.ts`, `egress-*.ts`, `grok-sandbox.ts` |
| L4 `orchestration` | *Sequences steps or seats end-to-end?* | `cycle.ts` (new; the current `runPipeline`), `orchestrator.ts` (new; `runOrchestrator`), `cycle-result.ts` (new), `steps/<step>.ts` (new), `pr-review-gate.ts` (new; the gate body now in `pr-review-cli.ts`), `pipeline.ts` (thin re-export until callers move) |
| L5 `entry` | *Parses argv and exits?* | `*-cli.ts`, `main.ts`, `index.ts` (package barrel), `init.ts`, `sync.ts`, `check-skills.ts` |

`helpers.ts` is **deleted** by the end of step 4; §3 names every destination.
Graph lane (`ci/`, `docs/assurance`) stays decoupled from `packages/`.

## 3. Sequencing

Every step is one PR, lands green on `pnpm -r test`, `pnpm typecheck`,
`pnpm test:ci`, and **shrinks the layering baseline (§4) monotonically**. The
only intended behaviour change in the whole plan is step 7a's deny-list
widening, called out there; every other step is a move.

Open-PR constraint (2026-08-29): #699 and #719 both edit `pipeline.ts`,
`helpers.ts`, the providers and `pipeline.test.ts`. Steps 2+ wait for them
(and #718) to land; step 1 is conflict-free by design.

| # | Step | Touches (source → tests) | Exit criterion | Gate on |
|---|---|---|---|---|
| 0 | **Run-lane hold.** No new lane cycles; in-flight `--resume 647` and `--resume 672` run to completion. | memory note | both exited; #699/#719/#718 landed or parked | — |
| 1 | **Layering test + baseline** (§4). | `__tests__/module-layering.test.ts`, `__tests__/fixtures/module-layering-baseline.json` | green on `main`; baseline lists every current violating edge | none |
| 2 | **Entry modules become leaves.** `pr-review-cli.ts` keeps only `main`/argv; everything else (`runPrReviewGate`, `PrReviewGateResult`, `persistLocalGateEvidence`, `setPrReviewDepsForTests`, `buildFailClosedComment`, `resolveCarryOptions`, `verificationPrompt`, `trustedLocalContext`, `executionOverrideFor`, `PR_REVIEW_MARKER`) moves to L4 `pr-review-gate.ts`; the `PrReviewAgreement` type moves to `types.ts` so L1/L2 (`pr-review-gate-record`, `review/carry`, `review/adjudication`, `review-sweep`) never import L4. `buildFlowSnapshot` → L2 `flow-snapshot.ts`. `cli.ts` is reclassified L0 (it only parses argv), so `revise-cli → cli` is legal. | `pr-review-cli.ts`, `pr-review-gate.ts`, `flow-snapshot.ts`, `types.ts`, 8 import sites → `pr-review-cli.test.ts` (2,374 lines) splits into `pr-review-gate.test.ts` + a small CLI test | no non-`index.ts`/`main.ts` importer of any L5 module | 1, #699, #719 |
| 3 | **Foundation de-cycle.** Break SCC `{types, config, notify, review/findings}`: `STEPS`/`Step`/`PipelineStep`/`isPipelineStep` → `steps.ts`; `NotifyConfig`/`NOTIFY_EVENTS`/`NOTIFY_FORMATS` → `types.ts` (`notify.ts` keeps behaviour); findings schema types `config.ts` needs → `types.ts`. **AGENTS.md invariant edit**: "`STEPS` in `steps.ts` is the source of truth". | `types.ts`, `steps.ts`, `config.ts`, `notify.ts`, `review/findings.ts`, `AGENTS.md` → `config.test.ts` unchanged | L0 acyclic; L0 imports nothing above L0 | 2 |
| 4 | **Dissolve `helpers.ts`** (85 exports → 0, file deleted). Destinations: `git.ts` L1 (`getHeadSha`, `getArtifactHeadSha`, `checkpoint`, `quarantineCheckpoint`, `ensureCheckpointed`, `mainWorktree`, `listWorktrees*`, `resolveWorktree`, `gitDiff*`, `filesChangedSince`, `hasDeliverableCommits`, `readGitBinding`, `createMutex`); `text.ts` L0 (`escapeMarkdown`, `escapeHtml`, `fmtWait`, `formatResumeHint`); `outcome-classify.ts` L1 (`classifyStepError`, `isTransientSdkError`, `isRefusal`, `looksLikeRefusal`, `looksLikeStalledAsk`, `parseBlockedReason`, `parseWaitFlag`, `parseResetTime`, `resolveParkReset`, `classifyOutcome`, `classifyParkReason`, `classifyCycleDisposition`, `canRetryWithinBudget`, `parseVerdict`) — this is what lets L3 stop importing L4; `skills.ts` L1 (`expandSkill`, `expandPackagedSkill`, `buildStepArgs`, `reviewFindingsPreamble`); `pick-parse.ts` L2 (`parsePickResult`, `parsePickItem`, `parseDeferredItems`, `pickDivergedFromPin`); `parseDecisions` → `decisions.ts`; ship-freshness/landing (`preparePrShipFreshness`, `verifyPrShipFreshness`, `verifyConflictRepairComplete`, `captureShipState`, `verifyShipLanded`, `parseShipMerged`, `ensureMainCheckoutOnBranch`) → `ship/freshness.ts`; `snapshotForbiddenRoot*`, `diffForbiddenRootSnapshots`, `snapshotRepoRefState`, `snapshotSiblingWorktree`, `createMainCheckoutDeltaObserver` → `confinement/roots.ts`; `appendLog`, `findLoggedArtifactAuthor` → `flow-events.ts`; `detectResumeStep`, `stepIndex`, `countPlanFiles`, `computeImplementTurns`, `formatChangesUnderReview`, `buildReviewDiffBlock`, `revertPlanPolish`, `classifySecurityReviewDiff`, `formatReviewMetrics`, `uniqueDriverProvenance`, `resolveClaudeSdkManifestPath`, `readRuntimeVersions` → `cycle-support.ts` L4. Also `execution-receipt → effects` (move `Effect` type to `types.ts`) and `review/record → review/loop` (move the loop-result type to `review/findings.ts`). | ~20 files → `helpers.test.ts` (2,114 lines) splits per destination | `helpers.ts` gone; no L1/L2/L3 module imports L4 | 3 |
| 5 | **Split `pipeline.ts`** (pure move, no signature change): `cycle.ts` (`runPipeline`), `orchestrator.ts` (`runOrchestrator`, `orchestrate`, park/reset waiting, hermetic defaults), `cycle-result.ts` (`resultIcon/Status/Detail`, `CycleResult` formatting). `pipeline.ts` re-exports for `main.ts`/`index.ts`/`revise-cli.ts`. | `pipeline.ts` + 3 new → `pipeline.test.ts` (4,834) splits into `cycle.test.ts` + `orchestrator.test.ts` (existing 3,297 moves) | no file in L4 > 2,500 lines | 4 |
| 6 | **Provider inversion.** `providers/types.ts` owns `StepProvider`, `RunStepOpts`; `providers/claude.ts` receives the inline `claudeProvider`; `providers/index.ts` is the registry; `step-runner.ts` consumes the registry and defines no provider. | `step-runner.ts`, 4 provider files, `providers/*` → `step-runner.test.ts`, `*-provider.test.ts` (paths only) | `step-runner` imports no provider file; providers import only `providers/types` | 4 |
| 7a | **Path registry.** `registers.ts` exports `REGISTERS: { name, dir, writer: "harness" \| "agent" }[]` and `registerDir(cwd, name)`; every `.dev/<x>` string literal in `packages/pelaggio` and `packages/server` is replaced. Two conformance tests: (i) `BASH_DENIED_DEV_REGISTERS` ≡ the `writer: "harness"` entries, **and** (ii) a source scan fails on any `".dev/` literal outside `registers.ts` — the recognize-by-invariant half that makes "all paths funnel through it" testable rather than declared. **Deliberate gate change** (the only one in this plan): the deny list widens to `effects`, `execution-receipts`, `attempts`, `flow-events`; ships with no-false-fire tests per `guarded-actions.md` §8.1 and a `pipeline.md` note. | `registers.ts`, `step-runner.ts`, ~20 literal sites in both packages → `step-runner.test.ts`, new `registers.test.ts` | zero `.dev/` literals outside `registers.ts`; deny list derived | 4 |
| 7b | **Shared record writer.** `writeRecord(cwd, register, key, value)` / `readRecord` / `listRecords` with one tmp+rename implementation and one `{ schemaVersion, … }` envelope; **validators keep their current failure conventions** (unifying `throw` vs `null` is a behaviour change, out of scope). Migrated one register per PR: freshness-gate → pr-review-gate → adjudication-sources → dispositions → review-records → doc-review-records → doc-review-transcripts → review-requests → effects → execution-receipts → sessions → stale-quarantine. **Excluded**: `attempt-identity` (its O_EXCL create-only allocator is the uniqueness primitive; tmp+rename cannot replace it), `file-lock` (a lock, not a record), `flow-events` (append-only JSONL, registers its dir only). | one module + its test per PR | one tmp+rename record writer for records; the two excluded primitives documented in `registers.ts` | 7a |
| 8 | **Control-plane reads via the package.** Add `eventStreamPath(cwd, streamId)` and a streaming `tailEventStream(path, fromOffset)` to `flow-events.ts` (the existing `readEventLog` is a whole-directory batch reader — wrong for a live tail) and `logPathFor(repoRoot)` (the existing `LOG_PATH` is CWD-bound — wrong for multi-repo stats). `flow-event-tailer.ts` and `routes/repos.ts` use them via `index.ts`. | `flow-events.ts`, `config.ts`, `index.ts`, 2 server files → `flow-events.test.ts`, server tests | server has no hand-built `.dev` path; envelope check exists once | 7a |
| 9 | **Steps as functions — one step per PR.** `steps/<step>.ts` exports `run<Step>(input: <Step>Input, deps): Promise<<Step>Outcome>` where `<Step>Input` lists **only** the closure bindings that block reads today (e.g. implement reads `assignment, available, worktree, profile, flags, roadmap, cost`). No hooks, no registry, no shared context bag; `Step`-keyed tables hold config, never behaviour. Extract in closure-dependency order: `shakedown-code` (last block, fewest downstream readers) → `implement` → `shakedown-plan` → `plan` → then the pick prologue and ship epilogue. Each PR carries its slice of `cycle.test.ts` into `steps/__tests__/<step>.test.ts`. Config-map collapse is **dropped**: `resolveStepSettings` already is the single step seam and the storage is profile-first by design. | `cycle.ts`, `steps/*` → `cycle.test.ts` slices | `cycle.ts` < 600 lines, contains no step body; each `steps/<step>.ts` has its own test file | 5, 6 |
| 10 | **Shadow-graph lane: one loader.** `ci/assurance-graph.ts` exports the single `AssuranceGraph`/`GraphNode` type, `loadShadowGraph()`, `loadViews()`; the 6 graph parse sites and 4 views parse sites use them; `shadow-assurance.test.ts` drops its local type; a test binds `views.json.schemaVersion` to the graph's `schemaVersion`. **Corpus lane untouched** — the evidence-vs-realization kernel and the Python checker are RFC Phase I's decision. | `ci/assurance-{graph,views,observations}.ts`, `ci/test-realization-mutation.sh`, 3 tests | one graph type in the tree; one views type; version-bound | none |

Steps 7a/7b/8 and 10 are independent of 5/6/9 and may interleave once 4 is in.

## 4. Layering test contract

`packages/pelaggio/scripts/pelaggio/__tests__/module-layering.test.ts`

- Scans every non-test `.ts` under `scripts/pelaggio`; resolves relative
  imports; **type-only imports count** (they shape the module graph).
- `LAYERS`: an explicit path→layer table (the §2 map, path-anchored — `ship/index.ts`
  is L2, package `index.ts` is L5). An unlisted module **fails the test**
  (no default layer; extract-and-require).
- **Layer rule**: for every edge `a → b`, `layer(a) ≥ layer(b)`.
- **Entry-leaf rule**: an L5 module may be imported only by `index.ts` or
  `main.ts` (path-anchored to the package root).
- **Baseline**: the exact set of violating edges (`"from -> to"`), not SCCs —
  so a new edge inside an existing cycle is caught. Every baseline edge must
  still exist (ratchet: a fixed violation is removed in the same PR);
  any violating edge not in the baseline fails.
- Cycles are not baselined separately: an acyclic-by-layer graph can only
  cycle within a layer, and intra-layer cycles (`ship/*`, `roadmap/stale-*`)
  are reported as a diagnostic, fixed opportunistically in steps 4/6.
- Regenerate with `MODULE_LAYERING_WRITE=1 npx tsx --test …/module-layering.test.ts`.
- Baseline fixture: `__tests__/fixtures/module-layering-baseline.json`.

## 5. Run-lane hold

While steps 2–9 are open, lane roots (`pelaggio-run-gate`,
`pelaggio-run-graph`, `pelaggio-run-ui`) launch **no new cycles**; any cycle
would author against modules mid-move and land conflicts on both sides.
In-flight resumes finish. Resume lanes after step 9 lands (step 10 and 7b's
tail are doc/infra-lane and do not block them).

## 6. Not in scope

- No pnpm package split. Boundaries are enforced by the layering test inside
  one package first; packages later, if the baseline stays at zero.
- No behaviour changes except step 7a's deny-list widening; no config-schema
  changes; validator failure conventions unchanged.
- The corpus-convergence RFC's phases I/II are not started here; step 10 is
  shadow-lane only and does not touch the corpus kernel.
