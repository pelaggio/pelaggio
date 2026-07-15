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

- `STEPS` in `packages/pelaggio/scripts/pelaggio/config.ts` is the source of truth for pipeline steps. Adding a step requires updating every step-indexed config map.
- `expandSkill()` strips skill frontmatter before sending skill bodies to the SDK. Do not rely on frontmatter inside pipeline prompts.
- Skill bodies must call `npx pelaggio ...`, never `pnpm pelaggio <subcommand>` (which re-enters the pipeline).
- Model IDs live in `MODEL_PROFILES` in `config.ts`; skill/template bodies must not pin Claude model IDs.
- Worktree isolation is load-bearing. Do not bypass guards that prevent writes to the main repo from sibling worktrees.
- During `implement`, plan documents under `docs/plans/` are read-only. The implement step executes the plan; it does not polish the plan.
- Rate-limit paths must park through `parkExit()` so uncommitted work is checkpointed.
- `ship.target` owns direct-push vs PR behavior. Do not hardcode merge behavior in TypeScript or skills.
- PR candidate blockers may be removed only by a complete, valid isolated verification report; verifier failure retains them.
- Claims are git-native (`feat/<id>` branch); roadmap mutations self-serialize on `.dev/roadmap-mutation.lock`. Don't add call-site locking or a claims registry.
- Access the roadmap via `npx pelaggio roadmap ...`; skills never read roadmap storage or issue trackers directly.
- `.agents/skills` must stay a symlink to the canonical `.claude/skills` tree so Codex sees the same skills without drift.
- No `preinstall`, `install`, or `postinstall` scripts in package manifests.
- (flow, planned) Flow projection is non-authoritative for current state (git + provider are ground truth for claim/done, never a claims registry); historical metrics are authoritative in the append-log via fat, self-contained events — never re-derived by joining mutable git/provider.
- (flow, planned) Flow-event identity is a unique `eventId` + writer-local `(streamId, seq)`; `seq` is never globally monotonic. Events emit harness-side by three producers — effect-confirmed (manifest-sourced), git-mutation (intent/confirmation bracket), and derived (readiness-diff) — never from "the step completed".
- (flow, planned) Flow events live under `.dev/flow-events/` as one append-only segment per writer process (single-writer-per-file, no shared-file concurrent append; separate from the cycle-log, shared envelope + reader); event `type` is namespaced (`pelaggio.*` closed/core-validated, consumer events vendor-prefixed + schema-registered); the reader is tolerant-with-diagnostic and back-compatibly reads untyped legacy cycle records.
- (flow, planned) `FlowPolicy` is provider-neutral — strategies see a snapshot, not storage. Storage leverages the provider; policy is pelaggio's.
- (flow, planned) An initiative is a projected swimlane/`group`, never a pelaggio-owned object.
- (flow, planned) Write-back is typed and item-scoped; agents never issue free-form tracker mutations, and it runs off the hot path.
- (flow, planned) Declared write-sets are enforced by the worktree write-guard; the scheduler will not co-schedule intersecting write-sets.
- (flow, planned) The landing queue is target-agnostic and defers to the provider's merge queue in PR mode; pelaggio owns integration ordering only for `direct-push`. On the Beads substrate it rides `bd merge-slot` (direct-push) / `bd gate` (PR mode); Beads owns the primitive, pelaggio owns ordering + waiter-hygiene + dead-holder reconcile; the slot lives in one shared `MAIN_REPO/.beads`.
- (flow, planned) Beads (`bd`) is the chosen work-store + landing substrate (see `coordination-spine.md`, #181): adopt it as a `RoadmapSource` and ride its `ready`/`merge-slot`/`gate` primitives. The `feat/<id>` git branch stays the authoritative claim token — `bd` status is write-back, never the claims registry.

Each invariant above is a one-line index; the full rationale lives in the routed detail docs below. Invariants tagged `(flow, planned)` are target-state — see `docs/agent-context/flow.md`; the tag drops when the implementing item ships.

## Agent Context Routing

Read only the detail docs needed for the task:

- `docs/agent-context/architecture.md`: package layout, data/state, publishing shape, supply-chain invariant.
- `docs/agent-context/pipeline.md`: pipeline steps, step-provider seam, worktree isolation + dep sharing, plan-polish and self-referential roadmap guards, hook reachability, phantom-ship guard, rate-limit parking.
- `docs/agent-context/roadmap-and-ship.md`: roadmap adapters + CLI bridge, claims, ship targets, direct-push bookkeeping, PR review and revise loops.
- `docs/agent-context/flow.md`: (design) flow-policy seam, projection + memory hierarchy, write-back, declared write-sets + landing queue, concurrency model.
- `docs/agent-context/coordination-spine.md`: (design) typed coordination-spine seam (agent-as-caller vs prose-scrape); the Beads-substrate decision — `bd` as work store + `merge-slot`/`gate` landing primitive; narrowed differentiator; MCP-deferred rationale.
- `docs/agent-context/flow-event-catalog.md`: (design) the `#170` spec — event envelope + identity/ordering contract, the fat-historical vs. derive-on-read split, separate-file storage + dual-format reader, effects-sourced emission, and the consumer extension seam.
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
