# TOOL-31 — Rewire skill bodies through `RoadmapSource`

**Branch:** `feat/tool-31-rewire-skill-bodies`
**Scope:** L
**Deps:** TOOL-10 (GitHub adapter), TOOL-15 (Linear adapter)

## 1. Problem

Both `GitHubIssuesRoadmap` and `LinearRoadmap` ship as "adapter-only." The
factory and config plumbing work — `getRoadmapSource()` resolves them and
`pipeline.ts` uses them for `claimItem`, `parseItemId`, `getItemPlan`,
`isQuickScope`, and `markDone` — but every skill body still reaches directly
into `docs/task-index.md` and `docs/roadmap-*.md`. Setting
`roadmap.source: github-issues` or `linear` today means the pipeline's
TypeScript layer talks to the adapter while the skill prompts (run inside the
SDK session as bash/Claude) keep reading markdown that doesn't exist for
those sources.

Result: end-to-end cycles only work under `markdown`. The roadmap abstraction
is half-wired.

## 2. Goal

Thread `RoadmapSource` through the eight skills the pipeline drives or that a
human invokes during a cycle (`pick`, `plan`, `ship`, `charter`, `status`,
`pickup`, `shakedown`, `tidy`). After this ticket, a consumer can set
`roadmap.source: github-issues` (or `linear`), run `pnpm autopilot`, and see
pick → plan → implement → shakedown → ship run to completion with issue
comments / `gh` calls / Linear SDK calls instead of markdown edits — with **no
behavior change for markdown consumers**.

## 3. Approach

### 3a. Bridge: a `claude-autopilot roadmap` CLI

Skills run inside the SDK as a bash + Claude mixture. They cannot hold a
TypeScript `RoadmapSource` instance, and we don't want to duplicate adapter
logic in prose. The bridge is an adapter-dispatching CLI subcommand, already
the established idiom in this repo (`worktree-deps`). Skills call it via the
`Bash(npx:*)` permission they all already have.

Add subcommand router in `bin/claude-autopilot.js`:

```
claude-autopilot roadmap <subcommand> [args]
```

Implemented by a new `scripts/autopilot/roadmap-cli.ts` that:

1. Parses the subcommand and args.
2. Calls `loadConfig(REPO)` to pick up the configured source.
3. Builds the same adapter `pipeline.ts` builds via `getRoadmapSource(...)`.
4. Dispatches to adapter methods and prints results on stdout.

Subcommands:

| Subcommand | Args | Output | Used by |
|---|---|---|---|
| `list` | `[--json] [--include-done]` | table (default) or JSON array of `{id,title,deps,sourceRef,status}` | pick, pickup, status, tidy, shakedown |
| `get` | `<id> [--json]` | one row (or exit 2); includes `status` = `open` \| `done` \| `unknown` \| `blocked` | pick, ship, pickup, status, shakedown |
| `claim` | `<id>` | two lines: `branch=<b>\nworktree=<w>` | pick |
| `plan-path` | `--id <id> [--worktree <path>]` | one line: the path at which the plan should live (whether or not it exists yet) + exit code 0 if the file exists, 2 if not | plan, status, pickup, shakedown, ship |
| `publish-plan` | `--id <id> --file <path>` | none | plan (markdown: no-op; gh/linear: post issue comment with marker) |
| `mark-done` | `<id> [--note <text>]` | none (adapter commits internally when applicable) | ship |
| `create-item` | `--title <t> [--deps <csv>] [--scope <x>] [--to <roadmap>] [--after <id>] [--priority high\|normal] [--deferred] [--json]` | one row or JSON; `id` is adapter-assigned | charter, shakedown (code-review uses `--deferred`) |
| `archive-plan` | `<id>` | none (no-op on remote adapters; markdown: `git mv` + commit) | ship |
| `source` | `[--json]` | one line (`name`) or `{name, ...}` | tidy (markdown-grooming gate) |

Conventions:
- Default output is human-readable; `--json` toggles machine-readable output. JSON for `list`/`get`/`create-item`/`source` is what the skills will use (Claude parses directly, no `jq`).
- Exit codes: `0` success, `2` "not found" (distinguishable from crashes), non-zero >2 for error. `plan-path` uses exit 0/2 as a file-existence signal — that's the intended double-duty.
- All subcommands are **read-the-config-each-time** — stateless. No daemon.
- `--deferred` on `create-item` is a shakedown-only flag the adapter can honor however it likes (markdown ignores; future labels on gh/linear could mark these for triage). Avoids needing a separate `add-deferred` subcommand whose schema would duplicate `create-item`.

### 3b. Extend `RoadmapSource` for operations that don't exist today

Three capabilities are presently inline in skill prose but need adapter
ownership. Add to the interface (`scripts/autopilot/roadmap/types.ts`):

```ts
interface RoadmapSource {
  // existing methods unchanged ...

  /**
   * Get a single item. Reports `unknown` when the ID can't be found in
   * either open or done lists — lets /pick distinguish typos from
   * already-completed items.
   */
  getItem(id: string): Promise<RoadmapItemStatus | null>;

  /**
   * List items including done ones. `listOpenItems()` is unchanged (still
   * returns the open subset) — callers that want the superset call this.
   */
  listItems(opts?: { includeDone?: boolean }): Promise<RoadmapItemStatus[]>;

  /** Resolve the path where `/plan` should write, whether or not the file exists yet. */
  resolvePlanPath(ctx: { id: string; worktree: string }): string;

  /**
   * Publish a written plan to the adapter's upstream. Markdown: no-op (the
   * plan lives on disk; `/plan` commits it in the skill). Gh/Linear: post
   * an issue comment with the `<!-- autopilot-plan -->` marker.
   */
  publishPlan(body: string, ctx: { id: string; worktree: string }): Promise<void>;

  /** Create a new backlog item. Returns the item in the RoadmapItem shape (id is source-assigned for gh/linear). */
  createItem(opts: CreateItemOpts): Promise<RoadmapItem>;

  /** Archive a shipped plan. Markdown: `git mv` docs/plans/<slug>.md → docs/archived/ and commit. No-op elsewhere. */
  archivePlan(id: string): Promise<void>;

  /**
   * True when the item exists in uncommitted working-tree state of this
   * source but not yet in HEAD — e.g. markdown /charter edited
   * task-index.md without committing. Always false on gh/linear (issue
   * creation is atomic). Replaces `helpers.ts:isCharterPickRace`.
   */
  isCharterPickRace(id: string): boolean;
}

type ItemStatus = "open" | "done" | "blocked" | "unknown" | "in-progress";

interface RoadmapItemStatus extends RoadmapItem {
  status: ItemStatus;
  /** Parsed "blocked: waiting on X" reason; present only when status is blocked */
  blockedReason?: string;
}

interface CreateItemOpts {
  title: string;
  deps?: string[];
  scope?: "XS" | "S" | "M" | "L" | "XL";
  /** Markdown: target roadmap file (partial match). Gh/Linear: no-op (issue goes to configured repo/team). */
  roadmap?: string;
  /** Markdown-only. Gh/Linear ignore. */
  after?: string;
  priority?: "high" | "normal";
  /** Shakedown-origin flag. Adapters may use it for triage labeling; markdown ignores. */
  deferred?: boolean;
}
```

Blocked semantics per adapter:
- **Markdown**: `status === "blocked"` when the deps column starts with `blocked:`. `blockedReason` is the trailing text.
- **GitHub**: `blocked` when the issue carries a `blocked` label (convention; consumers can set it). Otherwise never emits `blocked` — GitHub tracking-issue relationships aren't exposed via `gh issue view --json` in a standard way, and introducing that dependency is out of scope for TOOL-31.
- **Linear**: `blocked` when a `blocked_by` relation points to an open issue. Linear's SDK exposes relations directly (already used in `listOpenItems`'s `formatDeps`); reuse that.

Rationale for splitting `writePlan` into `resolvePlanPath` + `publishPlan`: /plan still uses the `Write` tool to author the plan (so worktree-isolation hooks cover it), then publishes. For markdown, publish is a no-op — the commit step in /plan already makes the plan discoverable. For gh/linear, publish posts the comment. Keeps the skill's existing Write-then-commit shape; no `/tmp/` tempfile indirection.

### 3c. Adapter implementations

**MarkdownRoadmap** — port the logic currently in the skill bodies:
- `getItem(id)`: scan roadmap files (open table rows + "Recently completed"
  list + strike-through rows); set `status` accordingly. Uses the existing
  `findRoadmapContainingItem()` and `parseOpenTableRows()` helpers.
- `listItems({includeDone})`: thin extension of `listOpenItems()` that also
  includes strike-through / Recently-completed rows and tags `status`.
- `resolvePlanPath({id, worktree})`: return `<worktree>/docs/plans/<slug>.md`
  (slug is `id.toLowerCase()`), matching existing `findPlanFile()` convention.
- `publishPlan(...)`: no-op — plan already lives on disk after /plan writes it.
- `createItem(opts)`: choose next ID in the target roadmap's prefix
  (e.g. `COMP-N+1`), insert a table row (or checkbox, matching existing
  format via `detectFormat()`), append to `task-index.md`, and commit.
- `archivePlan(id)`: `git mv` from `docs/plans/` to `docs/archived/` + commit.
- `isCharterPickRace(id)`: port the existing `helpers.ts:isCharterPickRace`
  body verbatim — compares working-tree `task-index.md` against HEAD.

**GitHubIssuesRoadmap**:
- `getItem(id)`: `gh issue view <n> --repo ... --json number,title,state,body,labels`.
  `status` from `state` + labels: `closed` → `done`; `blocked` label → `blocked`;
  else `open`. `unknown` when gh returns 404 (exit distinguishable).
- `listItems({includeDone})`: `gh issue list --state all` when includeDone;
  otherwise delegates to the existing `listOpenItems()` logic.
- `resolvePlanPath({id, worktree})`: return `<worktree>/.dev/plans/<n>.md`
  (matches today's `getItemPlan` write-target for mirrored reads).
- `publishPlan(body, {id})`: post a comment with the `<!-- autopilot-plan -->`
  marker via `gh issue comment`. The worktree-local file already exists; no
  need to mirror again.
- `createItem(opts)`: `gh issue create --repo ... --title ... --label
  autopilot [--label deferred?] --body "<deps block>"`. Returns id = new issue number.
- `archivePlan(id)`: no-op (plan lives on the issue; closure already moves it
  out of the open set).
- `isCharterPickRace(id)`: always `false` — issue creation is atomic.

**LinearRoadmap**: mirror the github-issues shape using the existing
`LinearApi` façade. `createItem` needs one new façade method
(`createIssue(input: { teamId, title, description, labelIds? })`); `getItem`
extends `api.getIssue(identifier)` to return state type + relations so we can
emit `done` / `blocked`. `isCharterPickRace` returns `false`.

### 3d. Skill rewrites

For each skill, the rule is: **no more `cat docs/task-index.md`, no more
`grep docs/roadmap-*.md`, no more hardcoded `feat/tool-<id>` assumptions
about branch slugs**. Lookups go through `npx claude-autopilot roadmap …`;
branch/worktree names come from `claim` (for /pick) or from
`git branch --show-current` + `roadmap get --json` (for everyone else).

Specific changes (not exhaustive — see §5 for the file list):

- **`/pick`** (biggest rewrite):
  - Drop the task-index read. Run `npx claude-autopilot roadmap list --json` to get
    the open set.
  - `/pick <ID>`: replace the task-index / recently-completed disambiguation
    logic with `roadmap get <ID> --json`, branching on its
    `status` field (`open`/`done`/`blocked`/`unknown`) to emit the
    matching `pick-result:` tag. The five tag values stay — they're a pipeline contract.
  - `/pick next`: sort the JSON list the same way the prose sorts today
    (unblocked → urgency → unblocks-others → no overlap-with-claimed), then
    call `roadmap claim <top>`.
  - Drop the inline branch/worktree construction. `roadmap claim` returns
    both, and they're adapter-correct (`feat/issue-123` for gh, etc.).
  - **Charter→pick race guard**: moves entirely off the skill onto the
    adapter via `roadmap.isCharterPickRace(id)`. The pipeline's existing
    pre-/pick call (`pipeline.ts:162 isCharterPickRace(itemId, REPO)`)
    switches from the helper import to `roadmap.isCharterPickRace(itemId)`.
    Gh/linear trivially return false. The skill drops the inline
    `git show HEAD:docs/task-index.md` block entirely — the pipeline's
    adapter-driven pre-check covers it.

- **`/plan`**:
  - Drop the task-index read. `roadmap get <ID> --json` returns the
    full item (title, deps, source ref). For markdown sources, follow the
    `sourceRef` path to read the full spec; for gh, issue `body` already
    has it in the JSON; for linear, `description` does.
  - Resolve target path via `roadmap plan-path --id <ID> --worktree $PWD`
    (prints the absolute path regardless of whether the file exists; exit
    0/2 signals existence). Use `Write` to author the plan at that path —
    the worktree-isolation hook covers it, and markdown lands in
    `<worktree>/docs/plans/`, gh/linear in `<worktree>/.dev/plans/`.
  - After Write, run `git add … && git commit -m "docs: add implementation
    plan for <ID>"` (unchanged for markdown). Then call `roadmap
    publish-plan --id <ID> --file <path>` — no-op for markdown, posts the
    issue comment for gh/linear. The publish step is adapter-agnostic from
    the skill's perspective; no tempfile indirection.

- **`/ship`**:
  - Step 2 (Identify): replace roadmap-file grep with `roadmap get <ID> --json`.
  - Step 6 (Mark done): replace the in-place markdown rewrite (strike
    row, collapse spec, update task-index) with a single
    `roadmap mark-done <ID> --note "<description>"`. This is the biggest
    loss of inline detail in the skill body — the adapter owns it, which
    is the whole point.
  - Step 7 (Archive plan docs): `roadmap archive-plan <ID>`. No-op for
    gh/linear; `git mv` + commit for markdown.
  - Step 8 (Commit doc updates): **deleted**. Both `mark-done` and
    `archive-plan` commit internally on markdown (today's `markDone`
    already does this); gh/linear have nothing to commit on main. No
    `config --json` branching needed in the skill.

- **`/charter`**:
  - Replace the file-detection block (checkbox vs table, prefix scan,
    next-available-ID) with a call to `roadmap create-item --title "..."
    --scope ... [--to ...] --json`. Adapter owns all format logic.
  - Drop the task-index update prose (adapter does it).
  - Result confirmation reads the CLI's JSON return value.

- **`/status`** and **`/pickup`**:
  - `git branch --show-current` → extract slug → `roadmap get <ID> --json`
    → report title, roadmap (markdown) / issue URL (gh) / Linear URL (linear).
  - Plan path: `roadmap plan-path --worktree "$PWD"`.

- **`/shakedown`** (plan-review and code-review modes):
  - Plan-review mode: drop task-index read, use `roadmap get --json`.
  - Code-review mode, deferred-items step: replace the roadmap-append +
    task-index-append block with `roadmap create-item --deferred --title "..." --to ...`
    (reuses the single creation subcommand; `--deferred` is the only
    shakedown-specific opt).

- **`/tidy`**:
  - §1 (Roadmap audit) becomes markdown-specific. Gate the "collapse
    done specs / archive fully-complete roadmaps / collapse tracks"
    section on `roadmap source --json` reporting `name == markdown`.
    For gh/linear, `/tidy` prints a short "audit via upstream (gh/linear
    UI)" line and skips. The abstraction-leak here is deliberate: §1 is
    grooming the markdown *files themselves*, not roadmap state that has
    an upstream analogue.
  - §1b (Task index sync) — markdown-only, same gating.
  - §2–5 (worktree/branch cleanup, autopilot log, health checks) are
    source-agnostic; no change.

### 3e. Non-goals

- **No new adapters.** Wiring only.
- **No changes to the pipeline's verdict/turn contracts** — the
  `pick-result:`, `Verdict:`, and checkpointing flow stays byte-identical.
- **No changes to `check-roadmap.ts` / `check-skills.ts` / `sync.ts`** — these
  are maintainer tooling that specifically consume the markdown format. They
  remain markdown-specific and opt-in (only run when `roadmap.source ==
  markdown`, or unconditionally as today; they already fail gracefully if
  files are missing). Leave them alone.
- **No live Linear or GitHub smoke run in CI.** The deliverable asks for an
  end-to-end smoke test — that's a manual one-off (documented in §6), not a
  PR-blocking CI gate. A live call would need stored credentials which this
  repo doesn't have.

## 4. Why this over alternatives

1. **Why a CLI bridge instead of calling the TS `RoadmapSource` in-process
   from the skill?** Skills run inside the SDK's `query()` session where only
   the `allowed-tools` list is executable. The pipeline can't hand a
   TypeScript object into that session. A CLI subcommand is the established
   pattern in this repo (`worktree-deps`) and keeps skill prose short.

2. **Why extend the interface (`getItem`, `publishPlan`, `createItem`,
   `archivePlan`, etc.) instead of keeping this logic in the CLI?** The CLI
   would otherwise have three big switches on `roadmap.name`,
   re-implementing what adapters know about themselves. Putting the logic
   on the adapter keeps the substitutability guarantee of the abstraction
   honest and makes a future fourth adapter (Jira, etc.) a pure `implements`
   exercise.

3. **Why `resolvePlanPath` + `publishPlan` instead of a single
   `writePlan`?** A single method would either force the skill to hand the
   body through a tempfile (awkward, and colliding across parallel
   worktrees if placed in `/tmp`) or bypass the `Write`-tool-covered
   worktree-isolation hook. Splitting path-resolution from publication
   lets /plan use the existing `Write` tool on the adapter-resolved path
   and publish in a separate step. For markdown, publish is a no-op — the
   committed file on disk is already the source of truth. For gh/linear,
   publish posts the issue comment. The path already lines up with
   `pipeline.ts:224`'s `getItemPlan` read (`.dev/plans/<n>.md` for gh/linear).

4. **Why not drop `--include-done` from `list` and just use `get`?**
   `/tidy` and `/status` benefit from a single "everything" pass for
   counting. Cheaper and simpler than N `get` calls.

5. **Why leave tidy partly markdown-specific?** Roadmap collapse /
   archival / task-index sync *is* markdown-specific by nature — it's
   grooming the markdown files themselves. For gh/linear, the analogous
   grooming is upstream UI work (issue triage) that autopilot shouldn't
   reach into. Gating the markdown section rather than trying to mirror it
   is the honest design.

## 5. Files to change

### New

- `scripts/autopilot/roadmap-cli.ts` — subcommand dispatcher (~150–200 LOC).
  Parses args, builds adapter via existing `getRoadmapSource(...)`, prints
  results as text or JSON. No new deps.
- `scripts/autopilot/__tests__/roadmap-cli.test.ts` — dispatch tests with
  stub adapters (one per subcommand, happy path + `not-found` exit 2).

### Modified (TypeScript)

- `bin/claude-autopilot.js` — add `roadmap` to `routes` map.
- `scripts/autopilot/roadmap/types.ts` — extend interface: add
  `getItem`, `listItems`, `resolvePlanPath`, `publishPlan`, `createItem`,
  `archivePlan`, `isCharterPickRace`; add `ItemStatus`,
  `RoadmapItemStatus`, `CreateItemOpts` types. Leave `listOpenItems()`
  signature unchanged (still returns `RoadmapItem[]`) — `listItems` is
  the include-done superset; old callers keep their narrower shape.
- `scripts/autopilot/roadmap/markdown.ts` — implement the four new
  methods. Extract today's format-detection / ID-allocation / task-index
  logic from the skill prose (primarily the charter and ship skills) into
  adapter helpers. Reuse existing `parseOpenTableRows`,
  `strikethroughRoadmapRow`, `moveToCompleted` helpers.
- `scripts/autopilot/roadmap/github-issues.ts` — implement the four new
  methods. `getItem` is a new `gh issue view` call; `writePlan` is
  `gh issue comment` + a local mirror write (reusing the existing
  `.dev/plans/<n>.md` convention from `getItemPlan`); `createItem` is
  `gh issue create`; `archivePlan` is `() => {}`.
- `scripts/autopilot/roadmap/linear.ts` — implement the four new
  methods. Add `createIssue(input)` to the `LinearApi` façade and the
  lazy-SDK default implementation.
- `scripts/autopilot/roadmap/__tests__/*.test.ts` — extend the three
  existing per-adapter test files with cases for the four new methods.
  The markdown-adapter test gets the biggest addition (it holds the
  format logic now).
- `scripts/autopilot/pipeline.ts` — line 162's `isCharterPickRace(itemId, REPO)`
  import from `./helpers.js` switches to `roadmap.isCharterPickRace(itemId)`.
  This lifts the pipeline out of assuming markdown task-index.md exists.
- `scripts/autopilot/helpers.ts` — `isCharterPickRace` moves onto the
  MarkdownRoadmap adapter (same regex + `git show HEAD` logic). Helper
  deleted. The helper's `helpers.test.ts` case moves to the adapter test.

### Modified (skills)

- `.claude/skills/pick/SKILL.md` — biggest rewrite; see §3d.
- `.claude/skills/plan/SKILL.md` — `/plan` write-plan rewrite + drop task-index read.
- `.claude/skills/ship/SKILL.md` — mark-done / archive-plan dispatch.
- `.claude/skills/charter/SKILL.md` — drop all format-detection prose, call `create-item`.
- `.claude/skills/status/SKILL.md` — replace task-index read with `roadmap get`.
- `.claude/skills/pickup/SKILL.md` — same.
- `.claude/skills/shakedown/SKILL.md` — replace task-index read; replace deferred-items append.
- `.claude/skills/tidy/SKILL.md` — gate §1 and §1b on source==markdown.
- `.claude/skills/_review-logic.md` — update §3 target-detection to use
  `roadmap plan-path --worktree` + the diff check instead of hardcoding
  `docs/plans/{branch-slug}.md`.

### Modified (docs)

- `docs/config.md` — remove the "adapter-only" caveat blocks for
  `github-issues` and `linear` (deliverable asks for this).
- `CLAUDE.md` — add a one-line note under "Non-obvious conventions" about
  the `roadmap` CLI subcommand being the skill→adapter bridge.
- `docs/task-index.md` + `docs/roadmap-core.md` — on ship, mark TOOL-31 done
  (handled by the ship skill itself — no manual edit in this cycle).

## 6. Test strategy

### Unit tests (CI-gated)

- `roadmap-cli.test.ts`: for each subcommand, inject a stub adapter and
  assert stdout / exit code. Covers happy path, `not-found` (exit 2),
  JSON output shape, and arg parsing (e.g. `--scope` validation,
  `--deps csv` splitting).
- Adapter method tests: extend each of `markdown.test.ts`,
  `github-issues.test.ts`, `linear.test.ts` with coverage for the four
  new methods. `github-issues.test.ts` uses the existing injectable
  `ghRun`; `linear.test.ts` uses the existing injectable `api`;
  `markdown.test.ts` uses the filesystem (as it already does).

### Skill-body sanity (maintainer checks)

- `pnpm check:skills` (`scripts/autopilot/check-skills.ts`) already
  validates include directives and frontmatter. Rerun after the skill
  rewrites; adjust its regex if any new include patterns surface
  (unlikely).
- `pnpm check:roadmap` still runs on the markdown state (it's a
  markdown-specific tool); TOOL-31 doesn't change its behavior.

### Dry-run pipeline test

- `pnpm autopilot --dry-run --cycles 1` — exercises the pipeline's
  step-dispatch layer without calling the SDK. Should still pass; the
  `expandSkill()` outputs are text-only changes from the pipeline's
  perspective.

### Manual end-to-end smoke

Documented in the PR description but not automated:

1. **Markdown source (regression)**: run `pnpm autopilot --item TOOL-35`
   (or any pending TOOL-*) against this repo. Expectation: cycle
   completes identically to today — no behavior change.
2. **GitHub issues**: in a scratch repo with `roadmap.source:
   github-issues`, create a labeled issue via `gh issue create`, run
   `pnpm autopilot --cycles 1`. Verify pick claims, plan gets posted as
   a comment with the marker, ship closes the issue. Post results in
   the PR thread.
3. **Linear**: optional — requires `LINEAR_API_KEY`. Run the same
   sequence against a scratch team. If credentials aren't available,
   rely on the unit tests covering the adapter methods and defer the
   live smoke to a follow-up.

### Rollback safety

Every skill rewrite keeps the old behavior on `markdown` because the
MarkdownRoadmap implementations of the new methods are a faithful port
of the current skill prose. The `pnpm autopilot --dry-run` + unit test
pass is the gate; if either the dry-run or the markdown-source
end-to-end smoke regresses, revert.

## 7. Rubric self-check (Correct / Well-typed / Well-factored / Well-tested / Concise)

- **Correct — step exhaustiveness**: not touching `STEPS` /
  `BUDGETS` / `TURN_LIMITS` / `MODEL_PROFILES`. ✅
- **Correct — frontmatter stripping**: no new frontmatter emitted; skill
  frontmatter unchanged. ✅
- **Correct — worktree isolation**: all new CLI work runs in the caller's
  cwd. `MarkdownRoadmap.writePlan` writes to `{worktree}/docs/plans/`, not
  MAIN_REPO; the markdown `markDone` already writes to MAIN_REPO but runs
  from the ship step which switches to MAIN_REPO first. No new
  cross-worktree writes. ✅
- **Correct — rate-limit parking**: no new pipeline exit paths added. ✅
- **Correct — plan-polish block**: no new `Write/Edit` targets under
  `docs/plans/` during implement — `/implement` doesn't call
  `resolvePlanPath` / `publishPlan`; only `/plan` does, and the
  implement step's PreToolUse hook still fires on any attempt to edit
  a resolved plan path. ✅
- **Correct — phantom ship guard**: the guard is a `git diff` check, not
  roadmap-specific. ✅
- **Correct — hardcoded model strings**: N/A; no model wiring touched. ✅
- **Correct — no install-script hooks**: adding a subcommand to
  `bin/claude-autopilot.js`; not touching package lifecycle. ✅
- **Well-typed**: seven new interface methods with explicit types,
  discriminated `ItemStatus` union (including `"unknown"`). `createItem`
  takes a typed opts record, not positional `any`. `listItems` returns the
  same superset type that `getItem` does, so skills only deal with one shape. ✅
- **Well-factored**: adapter-owned behavior replaces prose duplicated
  three times (today markdown logic is re-written in each skill that
  touches a roadmap file). Net reduction in skill prose size. ✅
- **Well-tested**: each new method has unit coverage; CLI dispatch is
  table-driven. Manual smoke is called out as manual, not faked. ✅
- **Concise**: one new CLI file, four interface methods, ≤3 adapter
  methods per source. No abstraction for a hypothetical fourth adapter
  beyond the existing `RoadmapSource` interface (which already exists).
  Skill bodies shrink, not grow. ✅
- **Idioms**: deferred to `/shakedown`.

### Self-review notes (revisions during this pass)

- First draft had `/plan` write through a new `roadmap plan-write
  --stdin` or `--body-file` variant. Dropped — the indirection forces a
  tempfile (worktree-local to avoid cross-worktree collisions) that the
  skill writes and the CLI then re-reads. Split into `plan-path` (query)
  + `publish-plan` (effect) and let the skill use `Write` directly on
  the resolved path. Skill stays under worktree-isolation hooks, no
  tempfile, no indirection.
- First draft treated `/tidy` as a fully adapter-agnostic rewrite.
  Reversed: the collapse/archive/sync work *is* markdown-specific (it
  grooms the files themselves); gating with a source check and
  printing an "N/A for gh/linear" line is the honest choice.
- First draft wanted `roadmap config --json` for two gates: /tidy
  markdown-specific grooming AND /ship step 8 commit. Simplified: /ship
  step 8 is deleted outright (adapter methods commit internally),
  leaving only /tidy needing the source check. Renamed the subcommand
  from `config` to `source` since that's its only real use today.
- First draft added `add-deferred` as a dedicated subcommand for
  shakedown's code-review mode. Collapsed into `create-item --deferred`
  since the schemas were identical.
- First draft had `isCharterPickRace` gated per-skill. Moved onto the
  `RoadmapSource` interface (gh/linear: always false); the pipeline's
  pre-/pick call switches to the adapter. Removes a markdown-leak from
  the pick skill body and from `helpers.ts`.
