# v0.1 source mapping

Each row maps one schema field. Array element pointers use `/0` as an example index; they apply independently to every element. Trust is `self-reported` (driver/reviewer claim), `derived` (harness transformation), `external` (content-addressed artifact), or `constant` (predicate-version vocabulary). “Required” means required by the schema for the containing object. An optional field MUST be omitted for the listed absence reason; producers do not substitute prose or sentinel strings.

| Predicate field | Current source | Trust level | Required / optional | Absence reason |
| --- | --- | --- | --- | --- |
| `/deliveryDefinition/change/itemId` | `CycleLogEntry.item` | derived | Required | Cannot emit for an itemless cycle. |
| `/deliveryDefinition/change/roadmapUrl` | roadmap adapter | external | Optional | Adapter has no stable item URI. |
| `/deliveryDefinition/policy/id` | pipeline policy configuration | derived | Required | Cannot emit without selected policy. |
| `/deliveryDefinition/policy/version` | pipeline policy configuration | derived | Required | Cannot emit without versioned policy. |
| `/deliveryDefinition/policy/configDigest/sha256` | canonical `.pelaggio.yml` bytes | derived | Required | Cannot emit until canonicalization exists. |
| `/deliveryDefinition/standards/inTotoStatement` | v0.1 schema constant | constant | Required | Never absent. |
| `/deliveryDefinition/standards/slsaProvenance` | v0.1 schema constant | constant | Required | Never absent. |
| `/deliveryDefinition/standards/otelGenAI` | v0.1 schema constant | constant | Required | Never absent. |
| `/deliveryDefinition/standards/owaspAISVS/version` | v0.1 schema constant | constant | Required | Never absent. |
| `/deliveryDefinition/standards/owaspAISVS/controlIds` | v0.1 schema constant | constant | Required | Never absent. |
| `/runDetails/authorship/0/step` | `StepLog.name` | self-reported | Required | Cannot emit an authorship entry without a known pipeline step. |
| `/runDetails/authorship/0/attempt` | `StepLog.attempt` | derived | Required | Legacy absence is normalized to `1`. |
| `/runDetails/authorship/0/identity/provider` | `StepLog.provider` | self-reported | Required | Legacy entry without provider cannot be emitted. |
| `/runDetails/authorship/0/identity/model` | `StepLog.model` | self-reported | Required | Entry without model cannot be emitted. |
| `/runDetails/authorship/0/identity/sessionId` | provider result/session metadata | self-reported | Optional | Provider did not expose or policy redacted session identity. |
| `/runDetails/authorship/0/identity/seatId` | configured driver seat | derived | Optional | No stable non-personal seat identifier. |
| `/runDetails/authorship/0/gen_ai.system` | `StepLog.provider` | self-reported | Required | Legacy entry without provider cannot be emitted. |
| `/runDetails/authorship/0/gen_ai.request.model` | `StepLog.model` | self-reported | Required | Entry without requested model cannot be emitted. |
| `/runDetails/authorship/0/usage/gen_ai.usage.input_tokens` | `StepLog.tokens.input` | self-reported | Optional | Provider omitted usage. |
| `/runDetails/authorship/0/usage/gen_ai.usage.output_tokens` | `StepLog.tokens.output` | self-reported | Optional | Provider omitted usage. |
| `/runDetails/authorship/0/usage/pelaggio.usage.cache_creation_tokens` | `StepLog.tokens.cacheCreation` | self-reported | Optional | Provider omitted cache-creation usage. |
| `/runDetails/authorship/0/usage/pelaggio.usage.cache_read_tokens` | `StepLog.tokens.cacheRead` | self-reported | Optional | Provider omitted cache-read usage. |
| `/runDetails/authorship/0/costUsd` | `StepLog.cost` | self-reported | Optional | Provider omitted cost. |
| `/runDetails/authorship/0/costEstimated` | `StepLog.costEstimated` | self-reported | Optional | Cost was not reported. |
| `/runDetails/authorship/0/turns` | `StepLog.turns` | self-reported | Optional | Provider omitted turn count. |
| `/runDetails/authorship/0/status` | `StepLog.ok` | self-reported | Required | Never absent for an emitted attempt. |
| `/runDetails/authorship/0/subtype` | `StepLog.subtype` normalized to the closed `StepSubtype` classification | derived | Optional | Successful step omits a failure subtype. |
| `/runDetails/authorship/0/filesChanged` | `StepLog.filesChanged` | self-reported | Required | Use an empty array when no changed paths were reported. |
| `/runDetails/review/0/role` | review-loop seat (`reviewer` or `judge`) | derived | Required | Never absent for an emitted review. |
| `/runDetails/review/0/identity/provider` | `ReviewRecord.result.passes[].reviewers[].identity.provider` | self-reported | Required | Review without provider identity cannot be emitted. |
| `/runDetails/review/0/identity/model` | reviewer or judge `identity.model` | self-reported | Required | Review without model identity cannot be emitted. |
| `/runDetails/review/0/identity/sessionId` | reviewer or judge `identity.sessionId` | self-reported | Optional | Provider omitted or policy redacted session identity. |
| `/runDetails/review/0/identity/seatId` | reviewer or judge `identity.seatId` | derived | Optional | No stable non-personal seat identifier. |
| `/runDetails/review/0/reviewedDigest/sha256` | `ReviewEscalation.reviewedSha` plus content hashing | derived | Required | Existing Git SHA alone is insufficient; review cannot emit until content-bound. |
| `/runDetails/review/0/independence/provider` | author/reviewer provider comparison | self-reported | Required | Use `unknown` when either identity is absent. |
| `/runDetails/review/0/independence/model` | author/reviewer model comparison | self-reported | Required | Use `unknown` when either identity is absent. |
| `/runDetails/review/0/independence/session` | author/reviewer session comparison | self-reported | Required | Use `unknown` when either session is absent. |
| `/runDetails/review/0/independence/requirement` | `ReviewLoopResult.diversity` | self-reported | Required | Use `unknown` when configuration cannot be recovered. |
| `/runDetails/review/0/verdict` | reviewer/judge verdict | self-reported | Required | Review without verdict cannot be emitted. |
| `/runDetails/review/0/blockingThreshold` | `ReviewRecord.blockingBar` | derived | Required | v0.1 supports only `must-fix`. |
| `/runDetails/review/0/findingRefs` | candidates/survivors mapped to review evidence IDs | self-reported | Required | Use an empty array when no findings exist. |
| `/runDetails/review/0/resolution/disposition` | `ReviewResolution` | self-reported | Optional object | No escalation resolution occurred. |
| `/runDetails/review/0/resolution/actor` | resolution seat classification | derived | Required when resolution exists | Resolution actor cannot be classified as harness, judge, or operator. |
| `/runDetails/review/0/resolution/rationaleCode` | normalized `ReviewResolution` result | self-reported | Required when resolution exists | Resolution has no supported code. |
| `/runDetails/review/0/resolution/evidenceRefs` | digested verification/resolution records | external | Required when resolution exists | Resolution lacks content-addressed support. |
| `/runDetails/policy/assertions/0/name` | gate configuration | derived | Required | Never absent for an emitted assertion. |
| `/runDetails/policy/assertions/0/result` | pipeline/review/ship gate result | derived | Required | Use `unavailable`, never `pass`, when no durable gate result exists. |
| `/runDetails/policy/assertions/0/evidenceRefs` | digested gate outputs | external | Required | Use an empty array only for `fail` or `unavailable`. |
| `/runDetails/policy/assertions/0/reasonCode` | normalized gate failure/availability state | derived | Required for `fail`/`unavailable`; optional for `pass` | Omitted for a passing assertion. |
| `/runDetails/evidence/0/id` | emitter-local evidence registry | derived | Required | Evidence without a stable local ID cannot be emitted. |
| `/runDetails/evidence/0/kind` | artifact type | derived | Required | Unsupported type uses `other`. |
| `/runDetails/evidence/0/digest/sha256` | immutable artifact bytes | external | Required | Mutable locator alone is insufficient; evidence cannot be emitted. |
| `/runDetails/evidence/0/uri` | artifact locator | external | Optional | Artifact has no stable or disclosure-safe URI. |
| `/runDetails/outcome/state` | `shipwrecked`, `parked`, `completed`, `error`, `verdict` | derived | Required | Never absent. Precedence is shipwrecked, parked, blocked/error, then shipped/completed. |
| `/runDetails/outcome/reasonCode` | normalized terminal state | derived | Required for non-success; forbidden by convention for success | Omitted for shipped/completed. |
| `/runDetails/outcome/gateSummary` | aggregate deterministic gate results | derived | Required | Never absent; non-success accepts only `failed` or `unavailable`. |
| `/runDetails/metadata/runId` | `CycleProvenance.runId` | derived | Required | Cycle without provenance cannot emit. |
| `/runDetails/metadata/cycle` | `CycleLogEntry.cycle` | derived | Optional | Legacy cycle number absent. |
| `/runDetails/metadata/startedAt` | finish timestamp minus `CycleProvenance.durationMs` | derived | Required | Cannot emit when timestamp or duration is absent. |
| `/runDetails/metadata/finishedAt` | `CycleLogEntry.ts` | derived | Required | Cannot emit when completion timestamp is absent. |
| `/runDetails/metadata/versions/pelaggio` | `CycleProvenance.versions.pelaggio` | derived | Required | Cannot emit without runtime provenance. |
| `/runDetails/metadata/versions/node` | `CycleProvenance.versions.node` | derived | Required | Cannot emit without runtime provenance. |
| `/runDetails/metadata/versions/drivers` | `CycleProvenance.versions.drivers` | derived | Required | Use an empty object when no driver versions were captured. |
| `/runDetails/metadata/unavailable` | `CycleProvenance.unavailable` normalized to schema codes | derived | Required | Use an empty array when no recognized gap applies. |
| `/trustModel/independence` | v0.1 trust rule | constant | Required | Never absent; value is `self-reported`. |
| `/trustModel/reviewVerdict` | v0.1 trust rule | constant | Required | Never absent; value is `self-reported`. |
| `/trustModel/authorshipStatus` | v0.1 trust rule | constant | Required | Never absent; value is `self-reported`. |
| `/trustModel/outcome` | v0.1 trust rule | constant | Required | Never absent; value is `derived`. |

The Statement subject is outside the predicate. `CycleProvenance.git.headSha` is not automatically the landed merge-commit SHA-256: the future emitter must resolve the final artifact and apply its documented Git hashing procedure.

**Effects-manifest evidence (#188).** After successful dispatch, the harness writes a durable [execution receipt](./execution-receipt.schema.json) under `.dev/execution-receipts/` **before** deleting the effects manifest. An `effects-manifest` evidence entry SHOULD digest the **receipt file bytes** (`ExecutionReceiptDescriptor.sha256` / `StepLog.executionReceipt`); the receipt's `manifestDigest` is the domain-separated SHA-256 of the exact pre-delete manifest file bytes. Receipts record harness-observed handler completion and Git revision bindings (`preGit` / `postGit` as Git object-IDs, never as the in-toto subject SHA-256). They do not prove external system honor (e.g. remote plan publish), provider-authenticated identity, CI on a trusted runner, global replay protection, or an uncompromised host. `CycleProvenance.challengeDigest` and per-receipt `challengeDigest` bind to a process-memory-only per-cycle challenge; the raw challenge is never written to disk.
