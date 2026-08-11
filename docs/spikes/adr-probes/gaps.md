# Gap ledger — findings to charter

Defects and unmet claims surfaced by the probe campaign that are **independent of whether A–K ever
ship**. Collected here rather than chartered one at a time; the campaign proposes, it does not file.

Each entry records what is wrong, how it was found, and why it is not merely an ADR-text problem.

---

## G1 — `TC-014` is a `guarantee` that does not hold on the default driver

**Severity:** trust-claim failure. **Found by:** P2.

`TC-014` claims spawned driver subprocesses receive a deny-by-default allowlisted env — *"PATH/HOME
plus explicitly configured vars only, never the full parent `process.env`"* — at status
**`guarantee`**. The claude child returned the exact literal value of a canary set only in the parent
environment and absent from the allowlist. Disk/output confirmed, not self-reported.

`buildAgentEnv` is correct and unit-tested. It is called by `codex-provider.ts`, `grok-provider.ts`,
`opencode-provider.ts` and `contained-execution.ts`. The claude path forwards `spawnOpts.env` as the
SDK constructed it.

**Why it survived:** `TC-014`'s `evidence_command` runs `secret-hygiene.test.ts`, which tests
`buildAgentEnv` in isolation plus log scrubbing. No test asserts that a driver path *calls* it — a
verified mechanism with unverified application.

**Charter shape:** route the claude adapter through `buildAgentEnv`; add a per-driver conformance
test asserting every registered adapter applies it; re-evidence `TC-014` at the call sites or
downgrade it from `guarantee` until it holds.

---

## G2 — no per-driver authority conformance test exists

**Severity:** structural. **Found by:** P2.

The gap in G1 is one instance of a missing class of test. Nothing asserts that a new Agent Driver
adapter applies the harness's authority construction, so the next adapter can omit it exactly as the
claude path does, and every existing test will still pass.

**Charter shape:** a driver-conformance suite parameterized over the registered adapters, asserting
the harness-owned controls that must hold regardless of driver-native behavior.

---

## G3 — `StepResult` text fields carry unresolved provider variance

**Severity:** correctness hazard. **Found by:** P1.

`text`, `fullText` and `assistantText?` have semantics that differ **by provider**: `text` is the
final chunk on some and truncates a block split across parts; `fullText` carries repository-controlled
tool data on others; `assistantText` is documented as "the only field safe to parse structured model
output from" yet is optional, with cross-provider conformance still chartered (#418).

Any code parsing structured output from the wrong field is provider-conditionally wrong. This is
adjacent to the repeated parse-invalid review failures observed during the #480 review passes, though
this campaign has not established that link.

**Charter shape:** finish #418 — make `assistantText` required and assert it cross-provider.

---

## G4 — `RunStepOpts.onChildSpawn` is driver-specific on the driver-neutral contract

**Severity:** design. **Found by:** P1.

Documented as *"register the Claude SDK child PID"*. Optional, so no other adapter fails a type check
by ignoring it — which is how a driver-specific concern persists inside a shared seam indefinitely.

**Charter shape:** express the PID-observation concern through the claude adapter rather than the
shared step contract, or generalize it to an adapter-supplied capability.
