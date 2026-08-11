# P1 — Step-contract conformance

**Targets:** A (typed steps in an ordered pipeline), B (one lifecycle contract), and incidentally E.

**Hypothesis.** Heterogeneous Pelaggio work can share a useful typed `Step` lifecycle contract
without the contract becoming a god-object.

**Falsification condition (from the plan).** The abstraction requires an untyped options bag,
proliferating optional fields, special kinds, or lifecycle branching that merely hides today's
orchestrators inside `Step`.

**Method.** `npx tsx docs/spikes/adr-probes/p1-conformance.ts` extracts the shape of the *production*
contract — no draft type was written and no production code was refactored to make the probe pass.
The probe reads source text rather than the TS compiler API on purpose: it measures what a
maintainer sees.

## Observations

**The contract is not hypothetical — it already carries nine heterogeneous activities.**

```
RunStepFn = (name: Step, prompt: string, opts: RunStepOpts, emit: StepEmit) => Promise<StepResult>
Step      = pick | plan | shakedown-plan | implement | shakedown-code | ship
          | shipwreck | pr-review | pr-verify
```

That sample spans charter/pick, planning, implementation, authoring review, **cold evaluation**
(`pr-review`, `pr-verify`), and recovery (`shipwreck`). Landing (`land-cli.ts`) and semantic
reconciliation sit **outside** it. So B is largely a description of the status quo, not a proposal.

**The named falsification signal is absent.** `RunStepOpts` contains no `Record<string, unknown>`
and no index signature. The probe checks for this mechanically.

**But optionality is carrying the heterogeneity.** 7 of 11 `RunStepOpts` fields are optional, and
the optional set is where activity- and driver-specificity has accumulated:

| Field | What its optionality encodes |
|---|---|
| `itemId?` | absent for `pr-review` / `doc-review` — activities with no roadmap item |
| `maxTurnsOverride?` | **`implement` only** — budget sized from the plan's file count |
| `mainCheckoutObserver?` | dirty-main delta attribution, a subset of steps |
| `foreignRootDenial?` | present so hooks install "even for main-cwd steps (`shipwreck`)" |
| `executionOverride?` | review seats selecting a provider per invocation |
| `onChildSpawn?` | **"register the Claude SDK child PID"** |

**`onChildSpawn` is the sharpest result.** E claims Agent Drivers are interchangeable intelligence
adapters behind a common contract. The common contract carries a field shaped by one specific
driver's SDK. It is optional, so other drivers simply do not supply it — which is exactly how a
driver-specific concern survives inside a driver-neutral seam without ever failing a type check.

**`StepResult` has unresolved provider variance in its core.** Three text fields coexist —
`text`, `fullText`, and `assistantText?` — and the source comment states their semantics *differ by
provider*: `text` is the final chunk on some providers and truncates a block split across parts;
`fullText` carries repository-controlled tool data on others; `assistantText` is "the only field
safe to parse structured model output from", yet is optional, with cross-provider conformance still
chartered (#418). `costEstimated?` marks the same class of divergence for spend.

**Coupling is real but bounded.** 16 step-indexed config maps and 13 per-step branches in
`pipeline.ts`. Adding an activity touches all 16 — already an `AGENTS.md` invariant.

**What B claims that the contract does not carry.** B declares a step has identity, skill, inputs,
context, *authority profile*, execution profile, provider requirements, budgets, *exit criteria*,
*outputs*, *provenance contribution*, and *recovery/escalation semantics*. The production contract
carries identity, prompt, budgets, execution profile and provider selection. Authority lives in
`pipeline.ts` confinement and the env allowlist; outputs and provenance live in `effects.ts`;
recovery lives in `RECOVERABLE_ERRORS` and `parkExit()`. **Today's `Step` is an execution contract,
not a lifecycle contract.**

## Verdict

**B is not falsified, and it is overstated.** The specific failure the plan predicted — an untyped
bag — is absent, and nine genuinely heterogeneous activities do share one typed seam. But half of
what B declares is not in that seam, and the half that is has absorbed one driver-specific field
and three provider-divergent result fields.

**E is falsified in a narrow, concrete way** by `onChildSpawn`.

## Architectural consequences

1. **Split B.** An *execution* contract exists, works, and carries nine activities. A *lifecycle*
   contract — authority, exit criteria, outputs, provenance, recovery — does not exist; it is
   distributed across the orchestrator. Recording both as one invariant hides that half of B ships
   and half is aspirational, which is the precise overclaim the reconciliation exists to remove.
   This is also the sharpest available support for the plan's thesis that the structural pressure
   is in the **envelope**, not the phase list.
2. **E needs a constraint, not just a philosophy.** "Drivers are interchangeable" must be paired
   with *no driver-specific field may appear on the shared step contract; a driver-specific concern
   is expressed through the driver's own adapter*. Without that, optional fields will keep carrying
   driver shape past the type checker.
3. **A survives unchanged.** Ordering and typed boundaries are real. Nothing here argues for the
   step *count*, and nothing here argues against it.
4. **Do not treat 16 step-indexed maps as a B problem.** It is config-fanout, orthogonal to the
   lifecycle contract, and fixing it is not evidence for or against B.

## Escape hatches recorded

Per the campaign rules, every activity-specific escape hatch the contract required:
`maxTurnsOverride` (implement), `foreignRootDenial` (main-cwd steps), `mainCheckoutObserver`
(dirty-main mode), `itemId` absence (item-less evaluation), `executionOverride` (per-seat provider
selection), `onChildSpawn` (Claude SDK). No production code was changed to reduce this list.
