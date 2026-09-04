---
title: "ADR-0029: Local Autopilot Contract v0 — Run as the public durable object"
status: proposed
date: 2026-09-04
claims: []
construction: docs/agent-context/local-autopilot.md
---

# ADR-0029 — Local Autopilot Contract v0

## Context

Pelaggio's shipped CLI is a dogfood pipeline (`pick → … → ship`) aimed at this repository's own cycles. Issue #776 asks for a different public surface: an install-free, local-first preview that a foreign repository — or another agent — can invoke without adding Pelaggio as a dependency, and that returns a reviewable local result rather than shipping. Several choices on that surface are expensive to reverse: what the durable object is, when work is allowed to end, what counts as a structured result versus a transport fault, and whether the existing `run` entry point is stolen.

Without a freeze, the preview either clones the dogfood pipeline (and silently pushes/PRs) or invents an SDK-shaped contract that later MCP/CLI adapters cannot share.

## Decision

1. **The durable object is a `Run`**, addressed by an opaque `runId`. The transport-neutral operations are `startRun`, `getRun`, `continueRun`, and `cancelRun`. CLI verbs (`run`, `resume`, `show`, `doctor`) are projections over those operations, not a second lifecycle.
2. **A versioned `WorkContract`** is the only task payload the engine executes. Text, file, and stdin are CLI conveniences that normalize into one WorkContract before any repository mutation.
3. **Lifecycle splits three fields.** `state` is `queued | running | paused | completed`. `pauseReason` is present if and only if `state` is `paused`. `disposition` is present if and only if `state` is `completed`. Successful autonomous work ends `ready_for_review`. `accepted` and `shipped` are not valid dispositions.
4. **Readiness is configured verification plus the absence of an open blocking finding.** Review-factor taxonomies and scoring are not part of this contract.
5. **External effects are denied by default** and are not implied by a successful disposition. A preview run must not push, open a PR, merge, release, or deploy unless a later, explicit effects contract says otherwise.
6. **Domain pauses and dispositions are valid structured results.** Only Pelaggio/protocol faults (invalid input, unknown fields, I/O of the harness itself, `requestId` content conflict) are transport errors.
7. **The append-only event journal is authoritative for recovery.** Snapshots and metrics are derived. Resume continues the same `runId` and does not repeat acknowledged work (checkpoint-restart, not replay — ADR-0019).
8. **Share-safe metrics structurally cannot carry task content.** They omit repository names, paths, ticket text, prompts, diffs, commands, and model output. Usage and cost appear only when a harness reports them.
9. **The dogfood pipeline keeps its existing `pelaggio run` flag grammar.** Local autopilot is selected only when the invocation carries a WorkContract input (`--file`, `--text`, or `--stdin`). The two projections must not share resume identity: pipeline `--resume <item>` is not `continueRun`.

## Constraints on any implementation

- **Must not make the model the gate for readiness or effects.** Verification outcome and the effects allow-list are deterministic. (ADR-0014)
- **Must not treat a pause as a crash or a protocol fault as a domain disposition.** Callers have to distinguish "operator must decide" from "Pelaggio could not parse the request."
- **Must not require a checked-in integration** before a local run can start. Uncommitted `.pelaggio/pelaggio.yml` is a valid policy home.
- **Must not scrape unstructured harness prose** for the public result when a typed seam exists. Artifact references (kind, URI, media type, digest) are the extension point for later evidence and `#751` Case objects — not a new snapshot shape.
- **Must not encode repository or task content in metrics.** A metrics schema that admits arbitrary strings will leak; the schema is the control.
- **Must not collapse multiple concurrent runs into one repo-global slot.** Each run has its own lease and worktree.
- **Must reject unknown fields on inputs and configuration** and must tolerate additive fields on outputs, so a future MCP adapter can share the same object-root schemas.

## Alternatives not taken

- **Steal `pelaggio run` unconditionally** — would break `pnpm pelaggio` / `--item` / `--cycles` dogfood.
- **Rename the pipeline to `pelaggio cycle` in the same publish** — a breaking cut unrelated to the preview contract.
- **Public JavaScript SDK as the v0 surface** — the charter forbids it; CLI projections are enough and map to future MCP `inputSchema`/`outputSchema`.
- **End success as `shipped` / open a PR by default** — that is the dogfood pipeline, not a local reviewable result.
- **Replay the journal as Temporal-style workflow history** — rejected by ADR-0019; the worker is non-deterministic.
- **Carry `#751` Case/attestation objects in v0** — the snapshot's artifact reference is the seam; pulling the Case surface into the first publish couples two unproven products.

## Consequences

- (+) A foreign repo can invoke one prerelease command and get a typed, resumable result without joining this repository's pipeline.
- (+) Later MCP, evidence, and `#751` work attach to `Run` / artifact references instead of inventing a parallel object.
- (−) Two meanings of `run` exist, dispatched by flags. Operators and docs must keep them distinct.
- (−) v0 cannot ship, merge, or attest. Preview usefulness is the local handoff, not autonomy-to-main.

## Construction

`docs/agent-context/local-autopilot.md` — schemas, lifecycle validator, CLI dispatch, adapters, pack tests.

`packages/pelaggio/scripts/pelaggio/local-autopilot/` — normative schemas and executable invariants.
