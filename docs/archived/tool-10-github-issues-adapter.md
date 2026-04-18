# TOOL-10 — GitHubIssuesRoadmap adapter (via `gh` CLI)

**Branch:** `feat/tool-10-github-issues-adapter`
**Depends on:** TOOL-9 (RoadmapSource interface landed)

## Goal

Add a second `RoadmapSource` adapter that drives the pipeline from GitHub
Issues instead of `docs/roadmap-*.md`. Proof that the TOOL-9 abstraction holds
up against a non-filesystem backend; unlocks consumers that track work in
Issues rather than markdown.

## Scope

**In scope**
- `scripts/autopilot/roadmap/github-issues.ts` — `GitHubIssuesRoadmap` class
  implementing `RoadmapSource`.
- Widen `RoadmapSourceName` union to include `"github-issues"`; extend the
  factory in `roadmap/index.ts`.
- Extend `loadConfig()` to read `roadmap.github.{repo,label,plan-location}`
  and pass them through to the factory (`ResolvedConfig.roadmapGithub`).
- Unit tests at `scripts/autopilot/__tests__/roadmap-github.test.ts`, covering
  every adapter method with an in-memory `gh` stub (no network, no real `gh`).
- Config tests for the new YAML keys.
- Doc: update `docs/config.md` roadmap-source table and add a small
  `roadmap.github.*` example.

**Out of scope** (explicitly)
- Rewiring `/pick`, `/ship`, `/plan`, `/shakedown`, `/charter`, `/status`,
  `/pickup`, `/tidy` skill bodies — they remain markdown-aware for now.
  `CLAUDE.md` already calls this out as a follow-up for TOOL-10; we keep it
  follow-up because rewiring eight skill bodies would balloon scope and has
  nothing to do with whether the adapter itself works. Adapter correctness
  can be proven through unit tests without touching any skill.
- The `pr-description` plan-location mode. Validate it as a config value so
  consumers can declare intent, but `getItemPlan` only implements
  `issue-comment` for now (documented + tested). `pr-description` throws a
  clear "not yet implemented" at first call.
- Bidirectional sync, multi-repo issue sources, octokit — same as the
  roadmap spec.
- LinearRoadmap (TOOL-15 — deferred).

## Approach

### Why `gh` CLI over octokit

- No dependency delta — `gh` is already a declared prerequisite for the
  `pull-request` and `auto-merge-pr` ship targets, and the ShipTarget prompts
  already route through it. Importing octokit would add transitive deps and a
  separate auth path.
- Auth story is already handled: `gh auth status` / `GH_TOKEN`. We inherit
  that configuration for free.
- Same testing story as the existing shell-out callers — inject a runner
  function and the adapter is fully mockable.

Trade-off: we parse JSON from child-process stdout instead of typed SDK
returns. Mitigated by `gh ... --json <fields>` (stable, narrow shape) plus a
single `parseGhJson<T>()` helper that validates shape before return.

### Item ID scheme

GitHub Issues have no human-readable prefix like `TOOL-9`. Use the issue
**number** as the ID, rendered as `#<n>` in user-facing text and `<n>` bare
everywhere else. Branches: `feat/issue-<n>` (keeps the markdown adapter's
`feat/` convention, avoids colliding with `TOOL-*` slugs).

`parseItemId` accepts any of: `feat/issue-42-anything`, `feat/issue-42`,
`#42`, `issue 42`. Returns `"42"` (bare number, string for consistency with
`RoadmapItem.id: string`).

No conflict with the markdown adapter's regex — the two live behind the
factory and only one is active per repo.

### Plan storage — `issue-comment`

- `getItemPlan({ worktree, id })` resolution order:
  1. **Local disk first** — mirror the markdown adapter's `findPlanFile`
     pattern: look for `${this.repo}/docs/plans/issue-${n}*.md` then
     `${this.repo}/.dev/plans/${n}*.md` (prefix glob — `/plan` appends the
     branch slug after `issue-<n>-`, so exact-name lookup on `n` alone
     will miss). Return the first hit. Mirroring markdown's behavior here
     keeps the two adapters consistent; any in-cycle plan-discovery
     shortfall is a pre-existing TOOL-9 property, not a new TOOL-10
     regression.
  2. **Issue comment** — fetch via
     `gh issue view <n> --json comments`, find the most recent comment
     whose body starts with `<!-- autopilot-plan -->`, write the body
     (minus the marker line) to `${worktree ?? repo}/.dev/plans/${n}.md`
     (mkdir-p), and return that path.
  3. **Null** — no local file, no marker comment. Same contract as the
     markdown adapter's "plan doesn't exist yet" signal; the pipeline's
     existing branch handles null by invoking `/plan`.
- The `.dev/plans/` destination for comment-sourced plans (not
  `docs/plans/`) is deliberate: `docs/plans/` is `/plan`'s canonical
  output and gets committed to the feature branch; a plan streamed from
  an issue comment is ephemeral and belongs in `.dev/` (autopilot's
  scratch area, already `.gitignore`'d in consumer repos).
- **Leaky-abstraction note.** Returning a path rather than the body is the
  TOOL-9 contract today (`pipeline.ts` does
  `\`Read the plan at ${planPath}\``). Preserving it keeps this adapter a
  single-file change. If/when we rewire skills (see Out of scope), the
  interface can evolve to return `{ body, locationLabel }` — defer until
  there's a concrete need.

Ingest-only for now: the `/plan` skill still writes to
`docs/plans/<slug>.md` on disk. Within a single autopilot cycle the
local-disk first pass above picks that file up, so plan → implement flows
without any issue-comment roundtrip. The issue-comment path only activates
for plans that were posted externally (e.g. by a human via `gh issue
comment` with the marker) or that a future TOOL-10.x rewires `/plan` to
post back.

**Partial-deliverable disclosure in `docs/config.md`.** The roadmap-source
table update must make clear that `github-issues` is an *adapter-only*
landing. The `/pick`, `/ship`, `/plan`, `/charter`, `/status`, `/pickup`,
`/shakedown`, and `/tidy` skill bodies remain markdown-aware — selecting
`roadmap.source: github-issues` in `.autopilot.yml` does not produce a
working end-to-end cycle yet. Follow-up TOOL-10.x rewires skill bodies to
consume the adapter. Consumers who set the YAML today will see /pick fail
to find items. Documenting this is a correctness precondition, not a
nice-to-have — we don't want someone flipping the flag and filing a bug.

### `gh` as an injectable dependency

The adapter constructor accepts `ghRun?: (args: string[]) => { stdout: string; stderr: string; status: number }`.
Default implementation `spawnSync("gh", args, { encoding: "utf-8" })`. Tests
pass an in-memory stub; production code never touches the default from tests.
This pattern mirrors how the ShipTarget adapters handle `gh` — keep the seam
in the same style.

`gh` availability is probed **lazily** — on the first `listOpenItems()` /
`claimItem()` call, we exec `gh --version` (cached) and throw a clear
diagnostic (`"gh CLI not found — install https://cli.github.com/"`) if it
fails, or if a subsequent auth-required call returns `gh auth login`
guidance. Construction stays side-effect-free so tests can instantiate the
adapter with a stub `ghRun` without `gh` installed locally.

## Files to change / create

| Path | Change |
|------|--------|
| `scripts/autopilot/roadmap/github-issues.ts` | **NEW** — the adapter |
| `scripts/autopilot/roadmap/types.ts` | widen union + export `GithubRoadmapConfig` type |
| `scripts/autopilot/roadmap/index.ts` | extend factory, accept `github?: GithubRoadmapConfig` in opts |
| `scripts/autopilot/config.ts` | parse `roadmap.github.{repo,label,plan-location}`, validate, thread into `ResolvedConfig` |
| `scripts/autopilot/__tests__/roadmap-github.test.ts` | **NEW** — full adapter coverage with `gh` stub |
| `scripts/autopilot/__tests__/roadmap.test.ts` | fix the "throws on unknown name" factory test — it currently casts `"github-issues" as RoadmapSourceName` as its bogus value, which becomes a valid name after this change. Swap for e.g. `"linear" as unknown as RoadmapSourceName` (still unknown post-TOOL-10; replace again when TOOL-15 lands). |
| `scripts/autopilot/__tests__/config.test.ts` | add `roadmap.github.*` parsing + defaults tests |
| `scripts/autopilot/pipeline.ts` | pass through `github` config from `ResolvedConfig` to the factory call (one-line change) |
| `docs/config.md` | update roadmap-source table + add `roadmap.github.*` example |

No changes to: skill bodies, `helpers.ts`, `step-runner.ts`, ship adapters,
`main.ts`, TUI.

## Detailed design

### Config (types + parsing)

```ts
// roadmap/types.ts
export type RoadmapSourceName = "markdown" | "github-issues";
export const ROADMAP_SOURCE_NAMES: readonly RoadmapSourceName[] =
  ["markdown", "github-issues"];

export type GhPlanLocation = "issue-comment" | "pr-description";

export interface GithubRoadmapConfig {
  /**
   * `owner/repo`. Required for github-issues; surface a clear error if
   * missing. Named `ghRepo` (not `repo`) to avoid collision with the
   * factory's local-git `opts.repo` when threading config through.
   */
  ghRepo: string;
  /** Label filtering open issues. Default: `autopilot`. */
  label: string;
  /** Where to look for plan bodies. Default: `issue-comment`. */
  planLocation: GhPlanLocation;
}
```

`loadConfig()` additions (config.ts):
- Default `GithubRoadmapConfig` → `{ ghRepo: "", label: "autopilot", planLocation: "issue-comment" }`.
- YAML key `roadmap.github.repo` maps to `GithubRoadmapConfig.ghRepo`
  (renamed at the parse boundary — the YAML stays user-friendly, the
  runtime type avoids the factory collision described below).
- If `roadmap.source === "github-issues"` and `roadmap.github.repo` is empty
  → throw loudly: `${configPath}: \`roadmap.github.repo\` (owner/repo) is required when roadmap.source is github-issues`.
- Validate `plan-location` against `["issue-comment", "pr-description"]`.
- Add `roadmapGithub: GithubRoadmapConfig` to `ResolvedConfig`.
- Export `ROADMAP_GITHUB` alongside `ROADMAP_SOURCE`.

Reject unknown nested keys silently (consistent with the existing
"forward-compat" policy for `.autopilot.yml`).

### Factory signature

```ts
// roadmap/index.ts
export function getRoadmapSource(
  name: RoadmapSourceName,
  opts: { repo: string; github?: GithubRoadmapConfig },
): RoadmapSource {
  switch (name) {
    case "markdown":
      return new MarkdownRoadmap({ repo: opts.repo });
    case "github-issues":
      if (!opts.github) throw new Error("github-issues roadmap requires github config");
      return new GitHubIssuesRoadmap({
        repo: opts.repo,
        ghRepo: opts.github.ghRepo,
        label: opts.github.label,
        planLocation: opts.github.planLocation,
      });
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown roadmap source: ${JSON.stringify(exhaustive)}. Valid: ${ROADMAP_SOURCE_NAMES.join(", ")}`);
    }
  }
}
```

Pipeline call (`pipeline.ts`) becomes:
```ts
// imports: add ROADMAP_GITHUB alongside ROADMAP_SOURCE from "./config.js"
const roadmap = deps.roadmap ?? getRoadmapSource(ROADMAP_SOURCE, {
  repo: REPO,
  github: ROADMAP_GITHUB,
});
```
(Two-line change — import + factory call; does not touch any step logic.)

### Adapter class

```ts
export interface GitHubIssuesRoadmapOpts {
  repo: string;                // local git repo root (for worktree creation)
  ghRepo: string;              // "owner/name" for the API
  label: string;
  planLocation: GhPlanLocation;
  ghRun?: GhRunner;            // injectable for tests
}

type GhRunner = (args: string[]) => { stdout: string; stderr: string; status: number };

export class GitHubIssuesRoadmap implements RoadmapSource {
  readonly name = "github-issues" as const;
  // ... constructor stashes opts; `ghRun` defaults to spawnSync wrapper.
}
```

Method-by-method:

- **`parseItemId(text)`** — ordered patterns:
  1. `feat/issue-(\d+)` → capture 1 as ID.
  2. `#(\d+)` → capture 1.
  3. `\bissue[- ]?(\d+)\b` (case-insensitive) → capture 1.
  4. Fall through → `null`.

- **`isQuickScope(text)`** — reuse the markdown heuristic verbatim:
  `/scope:\s*x?s\b/i` or `/\bbug\b|\bfix:/i`. Scope is author-tagged in
  issue body/title, not a GH primitive — same heuristic applies.

- **`listOpenItems()`** →
  `gh issue list --repo <ghRepo> --label <label> --state open --json number,title,body,labels --limit 200`.
  Returns `[]` when the response is an empty array. Map each to
  `{ id: String(number), title, deps: extractDepsFromBody(body), sourceRef: \`${ghRepo}#${number}\` }`.
  `deps` heuristic: first line matching `^\s*Depends on:\s*(.+)$` in the
  body; `""` (not `"—"`) when absent, matching the markdown adapter's
  blank-when-absent convention in the table.

- **`claimItem(id)`** —
  1. Fetch title for slugging: `gh issue view <id> --repo <ghRepo> --json title`.
  2. `branch = \`feat/issue-${id}${slug ? \`-${slug}\` : ""}\`` where `slug =
     kebab(title).slice(0, 40)`.
  3. `worktree = <repo>/../${WORKTREE_PREFIX}${id}` — must match
     `resolveWorktree(itemId)` in `helpers.ts` byte-for-byte. That helper
     builds `${WORKTREE_PREFIX}${itemId.toLowerCase()}` and is used on the
     resume path (`pipeline.ts:513`, `pipeline.ts:715`). Do **not** insert
     an `issue-` segment — the fresh-cycle listWorktrees diff in
     `pipeline.ts:169-173` would paper over the divergence, but `--resume`
     would report "worktree missing". For GH the bare number (`42`) is
     already distinctive vs. markdown's `tool-9` so there's no collision
     risk.
  4. `gh issue edit <id> --repo <ghRepo> --add-label in-progress` (silent
     fail on 404 — label is advisory, not critical).
  5. `git worktree add -b <branch> <worktree> main` via `execSync` on
     `this.repo`.
  6. Return `{ branch, worktree }`.

- **`markDone(id, ctx)`** —
  1. Comment: `gh issue comment <id> --repo <ghRepo> --body "Shipped${ctx?.note ? \` — ${ctx.note}\` : ""}"`.
  2. Close: `gh issue close <id> --repo <ghRepo>`.
  3. Strip `in-progress` label (best-effort).
  4. No markdown file edits, no git commit (unlike the markdown adapter).

- **`getItemPlan({ worktree, id })`** —
  If `planLocation !== "issue-comment"` → `throw new Error("plan-location 'pr-description' not yet implemented for TOOL-10; track TOOL-10.1")`.
  Resolve `n` from `id` (required here — the markdown version tolerates
  missing, but GH needs an issue number). If `id` not provided but
  `worktree` is, derive from the current branch via
  `git -C <worktree> branch --show-current` → `parseItemId`.
  **First pass — local disk.** Mirror markdown's `findPlanFile`: read
  `${this.repo}/docs/plans/` and `${this.repo}/.dev/plans/`, return the
  first filename starting with `issue-${n}-` (or exactly `${n}.md` in
  `.dev/plans/`). No `gh` call.
  **Second pass — issue comments.** Fetch
  `gh issue view <n> --repo <ghRepo> --json comments`. Find the most
  recent comment whose body starts with `<!-- autopilot-plan -->\n`
  (case-sensitive, exact marker). Strip the marker line; write the
  remainder to `${worktree ?? this.repo}/.dev/plans/${n}.md` (mkdir-p);
  return that path.
  If no match at either stage → `null`.

### `gh` error surface

Wrapper `runGh(args)`:
- If `status !== 0` and `stderr` includes `"gh: command not found"` or the
  spawn `error.code === "ENOENT"` → throw
  `Error("gh CLI required — install https://cli.github.com/")`.
- If `stderr` matches `/gh auth login|authentication required/i` → throw
  `Error("gh CLI not authenticated — run 'gh auth login'")`.
- Otherwise throw `Error(\`gh ${args[0]} failed: ${stderr.trim() || status}\`)`.

All three diagnostics surfaced verbatim in tests.

### Imports / idioms

- Node builtins first, then external, then local `.js`-suffixed relatives.
- Named exports only.
- `spawnSync` from `node:child_process` for the default `ghRun`.
- `mkdirSync(path, { recursive: true })` for `.dev/plans/` creation.
- JSON parsing wrapped in `parseGhJson<T>(stdout, shape)` — `shape` is a
  lightweight structural validator (Array.isArray + field presence), not
  zod. Keeps the zero-dep stance of TOOL-9.

## Test strategy

New file: `scripts/autopilot/__tests__/roadmap-github.test.ts`.

Every test instantiates `GitHubIssuesRoadmap` with an in-memory `ghRun`
stub (router: args-pattern → canned `{ stdout, status }`). No real `gh`, no
network.

Coverage matrix:

| Area | Cases |
|------|-------|
| `parseItemId` | `feat/issue-42`, `feat/issue-42-fix-bug`, `#42`, `issue 42`, no match |
| `isQuickScope` | `scope: S`, `scope: XS`, `bug in parser`, `scope: M` (false) |
| `listOpenItems` | 3-issue response → 3 items, empty array → `[]`, label/state passed through in args |
| `listOpenItems` | body has `Depends on: A, B` → deps populated; missing → empty string |
| `claimItem` | calls issue edit with correct label + `git worktree add` with correct branch; slug derived from title |
| `claimItem` | tolerates `gh issue edit` non-zero (best-effort label) but still creates worktree |
| `markDone` | stubs see exactly one comment + one close; note interpolated |
| `getItemPlan` | local `${repo}/docs/plans/issue-<n>-foo.md` exists → returned without any `gh` call (stub asserts zero `gh` invocations) |
| `getItemPlan` | no local file, comment with `<!-- autopilot-plan -->\n# ...` → writes `.dev/plans/<n>.md` and returns path; file contents strip marker |
| `getItemPlan` | no local file, no matching comment → `null` |
| `getItemPlan` | `planLocation: pr-description` → clear "not yet implemented" throw |
| Error surface | `ghRun` returns `status: 127 + "command not found"` → "gh CLI required" |
| Error surface | stderr "authentication required" → "gh CLI not authenticated" |
| Factory | `getRoadmapSource("github-issues", { repo, github })` → instance of `GitHubIssuesRoadmap` |
| Factory | missing `github` opts → throws |

Extend `__tests__/config.test.ts`:
- `roadmap.source: github-issues` without `roadmap.github.repo` → throws
  with clear message.
- `roadmap.github.plan-location: invalid` → throws listing valid values.
- Defaults: `label: "autopilot"`, `plan-location: "issue-comment"`.
- `roadmap.source: github-issues` with repo set but source omitted elsewhere
  → still defaults source correctly.

Run locally:
```bash
npx tsx --test --test-reporter=dot scripts/autopilot/__tests__/*.test.ts
pnpm check
pnpm check:skills
pnpm check:roadmap
```

## Rubric self-check

- **Correct** — no pipeline-invariant risk: no new step added (so
  step-exhaustiveness tables untouched), no hooks changed (worktree
  isolation + plan-polish block intact), no ship-guard changes, no rate-limit
  parking paths altered. The one leaky-abstraction risk (`getItemPlan`
  returning a path) is accepted with a documented migration path.
- **Well-typed** — `RoadmapSourceName` stays a literal union; factory
  preserves exhaustiveness via `never`. No `any`. `GhRunner` is a typed
  alias. `parseGhJson<T>` narrows at the boundary.
- **Well-factored** — single new file for the adapter; `roadmap/` module
  stays self-contained; `config.ts` addition is a mirror of the existing
  `roadmap.source` pattern (validator → narrow type → merge into
  `ResolvedConfig`). No leakage into helpers/step-runner/pipeline beyond
  the one-line factory args change.
- **Well-tested** — every public method of the adapter has at least one
  happy-path and one failure/edge case; error-surface diagnostics tested
  explicitly; no tests require the real `gh` binary. Config changes covered
  symmetrically.
- **Concise** — no new helper module; existing shell-out pattern reused;
  `pr-description` explicitly deferred rather than sketched. ~200 LoC
  adapter + ~250 LoC tests estimate.
- **Idioms** — (defer to `/shakedown`). Spot-checks: `.js` relative
  imports, Biome-style formatting, no default exports, `spawnSync` default
  with `encoding: "utf-8"`.

## Shakedown revisions

After `/shakedown` review, applied the following in-place:

1. **Worktree path alignment (fix-now).** `claimItem` now returns
   `${WORKTREE_PREFIX}${id}`, matching `resolveWorktree()` byte-for-byte.
   The original `issue-${id}` suffix would have broken `--resume` because
   `pipeline.ts:513` calls `resolveWorktree` directly (no listWorktrees
   diff fallback there).
2. **Existing test update (fix-now).** `roadmap.test.ts:32-35` asserts
   that `getRoadmapSource("github-issues")` throws — but widening the
   union makes that a valid name. Added a row to "Files to change"
   covering the swap.
3. **Partial-deliverable disclosure (near-term).** Expanded the
   `docs/config.md` doc scope: must clearly state that `github-issues`
   ships as adapter-only, and that skill bodies remain markdown-aware
   until the follow-up.

## Revision notes (self-review)

After drafting, re-read once:

1. Initially considered requiring `gh --version` at adapter construction
   time. **Revised:** probe lazily inside `runGh` — keeps the factory
   side-effect-free and keeps tests that construct the adapter (with a
   stub) from needing `gh` installed.
2. Initially had `getItemPlan` write to `docs/plans/<n>.md` to match the
   markdown adapter. **Revised:** `.dev/plans/<n>.md`. Writing to
   `docs/plans/` would confuse a consumer who ever switched back to the
   markdown source (the file would appear to be a stale plan). `.dev/` is
   scratch and already `.gitignore`'d in consumer repos per the
   dogfooding convention.
3. Initially had `claimItem` use the issue title verbatim as the branch
   suffix. **Revised:** kebab + 40-char cap. Raw titles contain spaces,
   punctuation, and unbounded length — git branch names tolerate only a
   narrow set.
4. Initially had `markDone` write a markdown-style line to a `CHANGELOG` or
   similar. **Revised:** comment + close only. There is no shared "done
   list" surface in GH Issues mode; the closed-issue state is the signal.
5. Initially added a `roadmap.github.state-labels` config field for the
   in-progress label name. **Revised:** hardcode `in-progress` and ship.
   Configurability can be added later if a consumer asks; YAGNI.

---

Run `/shakedown` for an independent review, or say **go** to start building.
