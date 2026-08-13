# Pelaggio Agent Guide

This repo contains the tooling for running autonomous development cycles, not consumer product code. It currently supports Claude Code and is being expanded to support Codex as a second development driver.

Keep this file short. Put always-needed rules here; put detailed architecture, workflow, and historical context in `docs/agent-context/`.

## Orientation

- Workspace: pnpm monorepo with three packages.
- `packages/pelaggio/`: published CLI package `pelaggio`. TypeScript runs through `tsx`; there is no build step.
- `packages/server/`: private Hono control-plane daemon for supervised pelaggio runs.
- `packages/web/`: private Astro/React static UI served by the daemon under `/ui/`.
- Root `.claude/skills/`: canonical workflow skills. They are copied into the published package during `prepack`.
- Root `.agents/skills`: Codex-visible alias for the same skills.
- Root `.claude-templates/`: consumer bootstrap templates.

## Commands

```bash
pnpm install
pnpm pelaggio --dry-run --cycles 1
pnpm pelaggio --cycles 1 --verbose
pnpm pelaggio --item 80 --verbose
pnpm pelaggio --resume 80
pnpm -r test
pnpm check
pnpm check:skills
pnpm check:publish
```

Run targeted tests with `npx tsx --test <test-file>`. Tests use `node:test`, not Jest or Vitest.

## Project Invariants

The invariants below share one spine: **determinism lives in the harness (mechanism), judgment lives in the worker (the LLM), and they meet only at a typed, fail-closed, capability-denied seam** — the blocking gate is always deterministic; the model is a policy input, never the gate (see `docs/decisions/0014-mechanism-policy-separation-spine.md`).

- `STEPS` in `packages/pelaggio/scripts/pelaggio/config.ts` is the source of truth for pipeline steps. Adding a step requires updating every step-indexed config map.
- `expandSkill()` strips skill frontmatter before sending skill bodies to the SDK. Do not rely on frontmatter inside pipeline prompts.
- Skill bodies must call `npx pelaggio ...`, never `pnpm pelaggio <subcommand>` (which re-enters the pipeline).
- Model IDs live in `MODEL_PROFILES` in `config.ts`; skill/template bodies must not pin Claude model IDs.
- Worktree isolation is load-bearing. Do not bypass guards that prevent writes to the main repo from sibling worktrees.
- During `implement`, plan documents under `docs/plans/` are read-only. The implement step executes the plan; it does not polish the plan.
- Rate-limit paths must park through `parkExit()` so uncommitted work is checkpointed.
- `ship.target` owns direct-push vs PR behavior. Do not hardcode merge behavior in TypeScript or skills.
- PR candidate blockers may be removed only by a complete, valid isolated verification report; verifier failure retains them.
- The daemon is an authenticated authority boundary: `CONTROL_PLANE_TOKEN` is required on every bind, including loopback; only non-authority surfaces (health, the public trust manifest, and the static UI shell) bypass bearer auth.
- Claims are git-native (`feat/<id>` branch); roadmap mutations self-serialize on `.dev/roadmap-mutation.lock`. Don't add call-site locking or a claims registry.
- Access the roadmap via `npx pelaggio roadmap ...`; skills never read roadmap storage or issue trackers directly.
- Review artifacts through the harness, never by shelling out to a provider CLI (`codex exec`, `grok -p`) for an ordinary review: the harness owns provider plumbing (ACP permission auto-approval, subprocess stdin) and bypassing it degrades *silently* — grok exits 0 with an empty review, codex hangs on stdin. Direct CLI use stays legitimate for provider development and pinned conformance work (`docs/agent-context/acp-grok-protocol.md`).
- `npx pelaggio doc-review <path>` is the read-only review path (provider-diverse, report bound to the document sha256). `npx pelaggio pr-review --pr <n>` is **effectful** — it upserts a PR comment and posts the required commit status, which CI normally owns — `npx pelaggio pr-adjudicate --pr <n>` is the same class of effect (required comment + pinned `review=success`) after a narrow local-operator fix, and `npx pelaggio land --pr <n>` **merges** (squash + branch delete behind the red-merge guard). All three need authorization separate from a request to review; an agent asked only to review must use `doc-review` and must not post statuses, adjudicate, or land.
- `.agents/skills` must stay a symlink to the canonical `.claude/skills` tree so Codex sees the same skills without drift.
- No `preinstall`, `install`, or `postinstall` scripts in package manifests.
- (flow, planned) Flow projection is non-authoritative for current state (git + provider are ground truth for claim/done, never a claims registry); historical metrics are authoritative in the append-log via fat, self-contained events — never re-derived by joining mutable git/provider.
- (flow, planned) Flow-event identity is a unique `eventId` + writer-local `(streamId, seq)`; `seq` is never globally monotonic. Events emit harness-side by three producers — effect-confirmed (manifest-sourced), git-mutation (intent/confirmation bracket), and derived (readiness-diff) — never from "the step completed".
- (flow, planned) Flow events live under `.dev/flow-events/` as one append-only segment per writer process (single-writer-per-file, no shared-file concurrent append; separate from the cycle-log, shared envelope + reader); event `type` is namespaced (`pelaggio.*` closed/core-validated, consumer events vendor-prefixed + schema-registered); the reader is tolerant-with-diagnostic and back-compatibly reads untyped legacy cycle records.
- (flow, planned) `FlowPolicy` is provider-neutral — strategies see a snapshot, not storage. Storage leverages the provider; policy is pelaggio's.
- (flow, planned) An initiative is a projected swimlane/`group`, never a pelaggio-owned object.
- (flow, planned) Write-back is typed and item-scoped; agents never issue free-form tracker mutations, and it runs off the hot path.
- (flow, planned) Declared write-sets are enforced by the worktree write-guard; the scheduler will not co-schedule intersecting write-sets.
- (flow, planned) The landing queue is target-agnostic and defers to the provider's merge queue in PR mode; pelaggio owns integration ordering only for `direct-push`, where the exclusive-access primitive is **git ref compare-and-swap** in the harness (verification bound to the candidate SHA; ancestry checked independently, then an explicit `--force-with-lease=main:<observed-sha>` — never the implicit form). `bd merge-slot` is an **optional ordering layer above** that fence, never a replacement, gated on a positive typed-output probe; when used, the slot lives in one shared `MAIN_REPO/.beads` and pelaggio owns ordering + waiter-hygiene + dead-holder reconcile. See ADR-0025.
- (flow, planned) Beads (`bd`) is the chosen work-store (see `coordination-spine.md`, #181): adopt it as a `RoadmapSource` and ride its `ready` primitive. For landing it is only the optional ordering layer above the CAS fence (previous bullet; ADR-0025) — `merge-slot`/`gate` never replace the harness fence. The `feat/<id>` git branch stays the authoritative claim token — `bd` status is write-back, never the claims registry.

Each invariant above is a one-line index; the full rationale lives in the routed detail docs below. Invariants tagged `(flow, planned)` are target-state — see `docs/agent-context/flow.md`; the tag drops when the implementing item ships.

## Agent Context Routing

Read only the detail docs needed for the task:

- `docs/agent-context/architecture.md`: package layout, data/state, publishing shape, supply-chain invariant.
- `docs/agent-context/pipeline.md`: pipeline steps, step-provider seam, worktree isolation + dep sharing, plan-polish and self-referential roadmap guards, hook reachability, phantom-ship guard, rate-limit parking.
- `docs/agent-context/roadmap-and-ship.md`: roadmap adapters + CLI bridge, claims, ship targets, direct-push bookkeeping, PR review and revise loops.
- `docs/agent-context/flow.md`: (design) flow-policy seam, projection + memory hierarchy, write-back, declared write-sets + landing queue, concurrency model.
- `docs/agent-context/coordination-spine.md`: (design) typed coordination-spine seam (agent-as-caller vs prose-scrape); the Beads-substrate decision — `bd` as work store, with `merge-slot`/`gate` demoted to optional ordering above the ADR-0025 CAS landing fence; narrowed differentiator; MCP-deferred rationale.
- `docs/agent-context/contained-execution.md`: (design; decision → ADR-0023) SCOPED confinement for autonomous agent code — light execution jail + a constrained egress broker; keys-for-unattended / local-sub-transparent-only / termination-is-lab-non-product; the ToS "containment ≠ permission" reframe, provider matrix, change-management, and liability of wrapping.
- `docs/agent-context/adversarial-review-loop.md`: (design; decision → ADR-0024) pre-commit multi-driver adversarial convergence loop (N reviewers + a config-set Judge + M passes) that resolves-to-convergence and ships PRs as auditable provenance; outcome levers, prefer-diversity, cost via the subscription pool; precedent (Sakana Fugu / FuguNano / debate / MoA) + the single-agent caution.
- `docs/agent-context/guarded-actions.md`: (design → ADR-0026) the guard audit — fenced / derived-exclusive / reconciled / hint, the three conflations behind the lock-and-gate defect cluster, the six primitives, and the new-guard checklist.
- `docs/agent-context/flow-event-catalog.md`: (design) the `#170` spec — event envelope + identity/ordering contract, the fat-historical vs. derive-on-read split, separate-file storage + dual-format reader, effects-sourced emission, and the consumer extension seam.
- `docs/agent-context/acp-grok-protocol.md`: (design) ACP-over-stdio wire-protocol reference for `grok agent stdio` (grok 0.2.103 conformance target) — framing, lifecycle, `session/update` shapes, usage/cost, permissions; feeds the #239 client + #136 grok-provider.
- `docs/agent-context/supervised-run.md`: operator runbook for supervising an end-to-end run out-of-band (start → watch → review-from-worktree → admin-land → mark-done → cleanup) + the escalation-adjudication defaults; distinct from the in-cycle pipeline skills.
- `docs/agent-context/skills.md`: skill layout, canonical tree, bilingual substrate, frontmatter, includes, project-context extension point.
- `docs/agent-context/testing-and-quality.md`: test commands, lint rules, rubric, review-shape rationale.
- `docs/config.md`: `.pelaggio.yml` schema.
- `docs/server.md`: daemon and web UI setup.
- `docs/pr-review.md`: PR review and revise behavior.

## Coding Conventions

- Prefer existing local helpers and patterns over new abstractions.
- Keep changes scoped to the requested behavior; avoid opportunistic refactors.
- Use relative imports with `.js` extensions in TypeScript ESM files.
- Keep comments sparse and useful; explain non-obvious invariants, not syntax.
- Preserve user work in dirty trees. Do not revert unrelated changes.

## Chartering Work

- The configured roadmap source is GitHub issues via `.pelaggio.yml`.
- Use `npx pelaggio roadmap ...` rather than reading/writing roadmap storage directly.
- Ambiguous work should be scoped at least `M` so it receives a plan step.
- For issue `#80` and later Codex work, treat context-substrate changes as a prerequisite: the provider implementation should not depend on a 28 KiB startup document.
