# Roadmap And Ship Context

## Roadmap Sources

Roadmap + task-index access goes through the `RoadmapSource` interface (`packages/pelaggio/scripts/pelaggio/roadmap/index.ts`).

Adapters today:

- `markdown`: parses `docs/roadmap-*.md` + `docs/task-index.md`.
- `github-issues`: GitHub issues via `gh`.
- `linear`: Linear issues via `@linear/sdk`.
- `beads`: Beads issues via the `bd --json` CLI (Beads 1.1.x). Authoritative store is `MAIN_REPO/.beads/`; `bd` always runs with that main-worktree cwd. IDs are source-assigned lowercase `bd-<hash>` (e.g. `bd-a1b2`), optionally db-prefixed (`bd-main-a1b2c3`) and/or hierarchical for epics (`bd-a3f8.1.1`). Plans stay committed under `docs/plans/` and are linked with `bd update --spec-id`. The git `feat/<id>` branch is the **authoritative claim**; `bd update --claim` is best-effort write-back. Because bd `--claim` sets `in_progress` (which drops the item from `bd ready`), availability is computed from `bd ready` ∪ bd-`in_progress` and claimed-status is derived **only** from live `feat/<id>` branches (`claimedIds`) — so a bd `in_progress` item whose branch is gone re-enters availability (dead-holder reconcile), never letting bd status become the claims registry. Claim branches are slug-free (`feat/<id>`) because bd ids contain hyphens/dots. No Beads-specific `.pelaggio.yml` keys — `roadmap: { source: beads }` is enough.

`getRoadmapSource(name, { repo })` is the factory; the resolved name comes from `roadmap.source` in `.pelaggio.yml` (default `"markdown"`). Adding an adapter means a new file under `roadmap/`, widening the `RoadmapSourceName` union in `roadmap/types.ts`, and extending the factory `switch`. No skill edits are needed.

### Skill → adapter bridge

Skill bodies never read roadmap files or issue trackers directly — they shell out to the `roadmap` CLI (`roadmap-cli.ts`), which dispatches to the configured source:

```bash
npx pelaggio roadmap <subcommand>
```

Subcommands: `list`, `next`, `get`, `claim`, `plan-path`, `publish-plan`, `mark-done`, `create-item`, `archive-plan`, `backfill-priority-labels`, `source`. Same idiom as `worktree-deps`. Do not duplicate adapter logic inside skills.

Always use the **scoped** name `pelaggio`, never bare `pelaggio`. The bare name collides with an unrelated public npm package cached under `~/.npm/_npx/`; a cached hit caused an observed pipeline recursion (TOOL-50) where the agent substituted `pnpm pelaggio <subcommand>` and re-entered the pipeline. The root `package.json` carries `pelaggio: workspace:*` so pnpm exposes it at the workspace root; `check-skills` enforces this (`skill.npx-bare-pelaggio`, `skill.pnpm-pelaggio-subcommand`), and the pipeline entry (`cli.ts`) rejects unknown positional args as defense in depth.

## Claims

Claims are git-native (#12). "Claimed" means the `feat/<id>` branch exists — git's ref locking is the arbiter (a losing `roadmap claim` exits **3**, `pick-result: already-claimed`, recoverable). There is no claims file, owner pid, or staleness lifecycle; release is branch deletion (owned by ship bookkeeping / `/tidy`). The markdown and beads adapters surface claims as `in-progress` by scanning `feat/*` branches (`claimedIds`); github/linear surface server-side markers (beads also best-effort writes `bd update --claim` after a successful git claim).

Shared-file writers — `markDone`/`createItem`/`archivePlan` and `commitStrayBookkeeping`'s `git add -A` sweep — take `.dev/roadmap-mutation.lock` **internally** (O_EXCL token lockfile, expiry-in-content, atomic rename-verify steal/release — `roadmap/mutation-lock.ts`). Callers never manage the lock. Do not add call-site locking or a parallel claim registry. Claim worktree naming uses `WORKTREE_PREFIX` from config (env > yml > basename) in all adapters.

## Ship Targets

`ship.target` in `.pelaggio.yml` selects the behavior, dispatched via adapters under `ship/`:

- `direct-push`
- `pull-request`
- `auto-merge-pr`

Skill bodies branch on the `--target` argument; don't hardcode merge logic in TS. `/shipwreck` recovery only runs for `direct-push` — PR modes never merge in-session, so a ship failure there is reported as-is.

## Direct-Push Bookkeeping

For `direct-push`, the agent-owned `ship` step ends at the merge (squash → merge into local `main` → post-merge verify → STOP, emitting `ship-merged: <id>`). Everything after — recovering stray `MAIN_REPO` changes as a commit (**never discard**), `roadmap.markDone`, `roadmap.archivePlan`, the single `git push origin main`, worktree cleanup, and claim-branch delete — runs in `pipeline.ts` via `runShipBookkeeping()` (`ship/bookkeeping.ts`) as **zero-turn, idempotent, best-effort** deterministic tail work. It is not a pipeline `STEP` (no `STEPS`/`BUDGETS`/… entry — deterministic tail work like `/shipwreck` recovery).

The boundary is the merge because the observed failure (#28) was budget exhaustion *after* merging; pipeline-owned tail guarantees bookkeeping even if the agent overshoots or undershoots.

- The tail runs only on a **verified** merge — `merged && ship.ok && reportedShipMerged(ship)` — because `ship.ok` means post-merge verification ran and the `ship-merged: <itemId>` marker (parsed by `parseShipMerged`, matched case-insensitively) proves it reached the hand-off gate (#37).
- A merge that landed but then hit `error_max_turns` or hard-failed is **not** blindly pushed — it routes to `/shipwreck`, which re-runs verification with its own budget and can roll the merge back. On a **verified recovery** (`wreck.ok && reportedShipMerged(wreck) && verifyShipLanded()`) the pipeline runs the same `runShipBookkeeping()` tail, so the tail is guaranteed on both paths (#30).
- `markDone` and `archivePlan` are independent best-effort mutations after the verified merge. Their failures are accumulated as actionable warnings, without caller-level locking or discarded work, and the single push is attempted regardless. A successful push permits **worktree** cleanup and completes the cycle as "shipped — bookkeeping incomplete" when metadata remains. **Claim-branch delete (local + remote) is gated on mark-done success** (#205): when mark-done fails, the `feat/<id>` claim is retained so the still-open tracker item cannot be re-picked until the operator runs `npx pelaggio roadmap mark-done <id>` and then deletes the branch (or `/tidy`). Archive-only failure does not retain the claim. Push failure or a `git pull` conflict (aborted via `git merge --abort`) remains fatal and leaves the branch intact, recoverable on local `main`.
- `verifyShipLanded()` fails **closed** (git error → not-landed → `/shipwreck`). Pre-ship `captureShipState()` fails closed too: a `null` capture makes the pipeline refuse to invoke `/ship` at all (#36). A pre-ship `commitStrayBookkeeping()` guard commits any dirty `MAIN_REPO` tree before the merge, so the agent never has cause to discard uncommitted work. `MarkdownRoadmap.createItem`/`markDone`/`archivePlan` commit their own pathspec with `--no-verify`.
- There is no consumer-agnostic verification command the tail can run itself; verification is agent-delegated via `_rubric.md`, so the tail delegates it to the agent path.

## PR Review Loop

`pr-review` is a non-pipeline step used by the CI merge gate. The gate (`.github/workflows/pr-review.yml` → `pr-review-cli.ts` → `parseReviewFindings`) fails **closed**: each successful pass must emit a valid versioned, severity-tagged report. A `must-fix` finding blocks; `nice` and `note` do not. A missing or malformed report, refusal, SDK error, max-turns, or rate-limit park also blocks. The aggregate still posts the compatibility `review` commit status, so existing branch protection and local review callers are unchanged.

Security-sensitive diffs run two independent `pr-review` sessions: the ordinary standard review and a triggered `--red-team` pass selected by deterministic path/diff signals in `classifySecurityReviewDiff()`. Either pass can block, and a triggered red-team pass that cannot complete blocks the whole required `review` check. Do not add a new pipeline `Step` for this; both sessions intentionally reuse the non-pipeline `pr-review` step key and aggregate into one PR comment / status result.

Local review mode (`review.runner: local`) runs before the local revise sweep. It must execute trusted tooling from local `main` and treat the PR head only as diff/file data, then post the `review` commit status and findings comment that the existing revise sweep consumes.

Convergence is deterministic and bounded. Validated blocker fingerprints survive across independent iterations until a complete verifier explicitly refutes them; omission is never refutation. PASS requires a complete valid iteration with an empty carried-survivor set. Max-pass, aggregate-budget, diminishing-return, invalid-pass, and provider-diversity breakers all stay red. That red gate feeds the existing label-bounded revise/human handoff; the read-only review CLI does not call `parkExit()`. Rate-limit work preservation remains owned by the separate revision pipeline and its existing `parkExit()` path.

### Revise loops (one pass, label-bounded)

Only local **or** CI should be active — both race for the `autopilot:revised` label, added *before* any work. CI stays disabled repo-wide (`vars.AUTOPILOT_AUTO_REVISE = false`), so the local sweep is the sole reviser.

- **CI (#60, disabled):** `pr-review-revise.yml` fires on the review workflow's `workflow_run: failure` and, exactly once per PR, re-implements from findings and re-pushes so the gate re-runs. The seam is `--review-findings <path>`, a resume-only CLI flag read best-effort in `pipeline.ts`. **Load-bearing:** the revision push must be PAT-authed (`token: secrets.GH_TOKEN`) — commits pushed with the default `GITHUB_TOKEN` don't trigger `pull_request` workflows.
- **Local sweep (#76, default on):** at the start of a pure auto-pick run, `runOrchestrator` sweeps red-review PRs and revises each **in-process** on the local subscription — reusing `runPipeline` with `startFrom: "implement"` + a fetched `--review-findings` file, so parking/notifications/cost/shipTarget all apply for free. Hard no-op unless `revise.local` (config, default true — opt-out) **and** `roadmap.source: github-issues` **and** a PR ship target **and** `!noWorktree && !dryRun && items.length === 0`. The git/gh primitives live in `revise-sweep.ts` (pure, fail-soft, injected `GhRunner`/exec — any error skips, never throws). No new pipeline `STEP`; revisions don't consume `--cycles` but do count toward `--budget`, pushed into `results`/`totalSpent` before the worker pool. Parking is preserved with zero new exit paths (delegates to `runPipeline`'s `parkExit()`).

See `docs/pr-review.md` for the full loop.
