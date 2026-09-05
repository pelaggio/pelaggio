# Local Autopilot Contract v0

Construction home for [ADR-0029](../decisions/0029-local-autopilot-contract.md) (issue #776). The schemas and executable invariants under `packages/pelaggio/scripts/pelaggio/local-autopilot/` are normative; this file points at them.

## Public object

A `Run` is the durable object. Operations: `startRun`, `getRun`, `continueRun`, `cancelRun`. CLI `run | resume | show | cancel | doctor` are projections. JSON Schema 2020-12 lives in `local-autopilot/schemas/v0.schema.json`. Runtime parsing is fail-closed TypeScript (`parse.ts`); Ajv agreement is a CI test, not a published dependency.

## Lifecycle

`state`: `queued | running | paused | completed`. `pauseReason` iff paused. `disposition` iff completed. Success is `ready_for_review`. `accepted` and `shipped` are invalid. `lifecycle.ts` is the state machine.

## Dispatch

`pelaggio run --file|--text|--stdin …` starts a local-autopilot Run. `pelaggio run` with pipeline flags (`--item`, `--cycles`, `--parallel`, …) remains the dogfood pipeline. `resume` / `show` / `cancel` / `doctor` are local-autopilot only. Operators should run `doctor` before the first run; it checks repository, config, execution consent, verification, and harness availability without mutating a Run.

## Authority

The run journal is authoritative. Snapshots and metrics are derived. Resume is checkpoint-restart (ADR-0019). `ready_for_review` requires configured verification evidence. Pelaggio performs no push/PR/merge/release/deploy effect. Uncontained host harness execution requires explicit CLI or uncommitted-policy consent and reports `effectsEnforced: false`.

## Adapters

v0: `fake` (deterministic, packed-tarball suite), `grok`, and `codex`. Codex auto mode uses its `--approve-for-me` review path with the `workspace-write` sandbox; Pelaggio still reports host execution because that provider-owned sandbox is not the v0 containment boundary. Pelaggio does not scrape harness prose for the public result.

## CLI dispatch

`bin/pelaggio.js` routes `run --file|--text|--stdin` plus `resume` / `show` / `cancel` / `doctor` to `local-autopilot-cli.ts`. Other `run` flags remain the dogfood pipeline. Prerelease publishes use a signed `v*-next*` tag and `npm publish --tag next --provenance`.
