# TOOL-1 — Consistency check: task-index ↔ roadmap drift

## Scope

**Does:**
- Parse every `docs/roadmap-*.md` for its canonical list of items (open vs. done), extracted from the `## Progress` summary table.
- Parse `docs/task-index.md` for its open-items table.
- Report three classes of structural drift:
  1. **Missing from task-index** — item is open in a roadmap but absent from task-index open rows.
  2. **Missing from roadmap** — item is in task-index but not in any roadmap's open set (either unknown ID, or the roadmap lists it as done).
  3. **ID collision** — same `TOOL-N` appears open in more than one roadmap.
- Exit 0 when consistent, exit 1 with an actionable diff otherwise.
- `--fix` flag: additively insert missing task-index rows using roadmap as source of truth. Never removes or rewrites existing rows.
- `pnpm check:roadmap` script entry.

**Does not:**
- Bidirectional sync (task-index is derived; only roadmap→index propagation is automatic).
- Semantic drift (title mismatch, deps mismatch) — only structural presence/absence of IDs.
- Auto-wire a pre-commit hook. The script exits nonzero on drift, so users can add it to `lefthook.yml` in one line if they want; leaving that to the user keeps scope minimal and avoids imposing a hook on every commit.

## Approach

One self-contained TypeScript module `scripts/check-roadmap.ts` runnable via `tsx`. Exports pure parser and diff functions so unit tests can cover the regex-driven parsing edge cases (a Well-tested priority per the rubric). The CLI entry block sits at the bottom behind the `import.meta.url === pathToFileURL(process.argv[1]).href` idiom.

**Why one file, not a new module under `scripts/autopilot/`:** this is not autopilot pipeline business logic; it's a repo-hygiene script. `scripts/autopilot/` has strict module boundaries (rubric, Well-factored) and `helpers.ts` is specifically the autopilot's helpers. A sibling script avoids polluting that module graph and keeps the check usable without pulling in SDK/config imports.

**Why parse the `## Progress` summary table, not the `### TOOL-N.` detail sections:** the summary uses strikethrough (`~~TOOL-X. Title~~` + `**Done** — ...`) as the canonical open/done signal across the whole repo. Detail sections lack that signal. Parsing one source is simpler than reconciling two; if detail and summary diverge within a roadmap, that's out-of-scope semantic drift for TOOL-5 (skill/doc linter) to catch later.

### Data model

```ts
type RoadmapItem = {
  id: string;          // "TOOL-1"
  title: string;       // "Consistency check: task-index ↔ roadmap drift"
  deps: string;        // raw "Depends on" cell contents, e.g. "TOOL-9" or "—"
  status: "open" | "done";
  roadmap: string;     // "core" (derived from filename)
};

type TaskIndexItem = {
  id: string;
  title: string;
  deps: string;
  roadmap: string;     // value from the Roadmap column
};

type Drift =
  | { kind: "missing-from-index"; item: RoadmapItem }
  | { kind: "missing-from-roadmap"; item: TaskIndexItem }
  | { kind: "id-collision"; id: string; roadmaps: string[] };
```

### Parsing rules

**Roadmap summary row regex** (matches a single row under `## Progress` → `**Open items:**`). Padding around pipes is `\s*` throughout so minor whitespace drift doesn't break parsing:
- Open: `^\|\s*(TOOL-\d+)\.\s+(.+?)\s*\|\s*(.+?)\s*\|\s*$`
- Done: `^\|\s*~~(TOOL-\d+)\.\s+(.+?)~~\s*\|\s*(.+?)\s*\|\s*$`

Scoped: start capturing after `| Item | Depends on |` header (skipping the `|---|---|` separator row); stop at the next blank line or `---` separator. This avoids matching unrelated tables.

**Task-index row regex** (matches a row under `## Open items`):
- `^\|\s*(TOOL-\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\w+)\s*\|\s*$`

Scoped: capture between `| ID | Title | Deps | Plan | Roadmap |` header and the next `##` heading. The `|---|...|` separator row naturally fails the regex (no `TOOL-N`) and is skipped.

Both parsers accept the file body as a string and return arrays — no filesystem inside the parsers themselves; the CLI does I/O and passes bodies in. That keeps parsers trivially testable without tmpdirs.

### Diff

```ts
function findDrift(roadmap: RoadmapItem[], taskIndex: TaskIndexItem[]): Drift[];
```

Pure function. O(n) via two `Map<string, ...>` lookups. Open items only — done items are intentionally ignored (task-index's "Recently completed" section is freeform and not structurally validated in this pass).

### Output format

On drift, print to stderr:

```
task-index ↔ roadmap drift detected:

Missing from task-index (add these rows):
  TOOL-7  [core]  Doc-only refactor
  TOOL-8  [core]  Example item

Missing from any roadmap:
  TOOL-99  (task-index row has no open roadmap counterpart)

ID collisions:
  TOOL-1: appears in core, experiments

Run 'pnpm check:roadmap --fix' to add missing task-index rows.
```

Exit 1. On clean state, print `task-index and roadmap-*.md are consistent.` to stdout and exit 0.

### `--fix` behavior

Locate the `## Open items` table in `task-index.md`, append new rows (one per `missing-from-index` drift) immediately before the next heading or blank-line+heading boundary, preserving the existing column format. Deps column is derived by filtering the roadmap's deps cell to drop already-done IDs (pure transformation over already-parsed data). Plan column always `—` on insertion (no plan exists at charter time — matches what `/charter` does today).

Does not fix `missing-from-roadmap` (could be user's in-progress manual edit) nor collisions (requires human decision about which roadmap owns the ID). Those still print and the command still exits 1 until the user resolves them.

## Files to change

**New:**
- `scripts/check-roadmap.ts` — parser, diff, formatter, `--fix` writer, CLI entry. ~150–200 lines.
- `scripts/autopilot/__tests__/check-roadmap.test.ts` — unit tests. ~120 lines.

**Modified:**
- `package.json` — add `"check:roadmap": "tsx scripts/check-roadmap.ts"` to `scripts`.
- `CLAUDE.md` — one-line addition to the "Running things" block documenting `pnpm check:roadmap`.

**Not touched:**
- `.claude/skills/*` — this is a repo-hygiene tool, not a pipeline step. Skill authoring unchanged.
- `lefthook.yml` — opt-in wiring left to the user (see Scope).
- `scripts/autopilot/**` — no coupling into the pipeline.

## Test strategy

`node:test` via `npx tsx --test` (matches existing convention, already globbed by `pnpm test`). Tests live at `scripts/autopilot/__tests__/check-roadmap.test.ts` so the existing test runner glob picks them up without changes.

**Parser tests** (all pure, no tmpdir — just string fixtures):
- Roadmap parser extracts open items from a summary table, ignoring prose before/after.
- Roadmap parser marks `~~TOOL-X. Title~~ | **Done** — ...` rows as `status: "done"`.
- Roadmap parser handles the tilde-suffix correctly when a title itself contains `~~` (defensive; unlikely but the regex should anchor to the pipe delimiters).
- Roadmap parser extracts the `Depends on` cell verbatim (e.g. `"TOOL-9"`, `"—"`).
- Roadmap parser returns an empty list for a file with no `## Progress` table.
- Task-index parser extracts rows only from the `## Open items` table, not the `## Recently completed` list.
- Task-index parser tolerates extra whitespace / trailing spaces in cells.

**Diff tests:**
- Identical sets → `[]`.
- Roadmap has TOOL-99 open, task-index missing → one `missing-from-index`.
- Task-index has TOOL-77, no roadmap has it open → one `missing-from-roadmap`.
- Task-index has TOOL-77, roadmap has it marked done → one `missing-from-roadmap` (not silent — the row should be moved to `## Recently completed`).
- Two roadmaps both list TOOL-1 open → one `id-collision` with both roadmap names.

**`--fix` tests** (tmpdir, minimal I/O):
- Write a roadmap + task-index where one item is missing from the index, run the fix function, re-parse the task-index, assert the row is present with the expected Deps/Plan/Roadmap cells.
- Run the fix on a clean file: assert the file content is byte-identical (no spurious writes).
- Fix skips `missing-from-roadmap` and `id-collision` drifts (still exits 1 afterward; fix is additive only).

**Integration smoke test:**
- Invoke the CLI via `execFileSync(process.execPath, ["--import", "tsx", "scripts/check-roadmap.ts"], { cwd: repoRoot })` (or `execFileSync("npx", ["tsx", ...])` — pick whichever matches existing test conventions; avoid bare `"tsx"` in case it's not on PATH). Asserts exit 0. This is a single test case that catches the most common regression: future roadmap edits that break the check.

## Rubric self-check

- **Correct** — No interaction with the pipeline invariants (STEPS, frontmatter stripping, worktree isolation, parking, phantom ship guard). The only fresh invariant is that the parsers and diff function must be deterministic and pure; covered by tests. `--fix` reads source of truth (roadmap) and writes a derived file (task-index), matching the CLAUDE.md assertion "task-index is derived."
- **Well-typed** — Discriminated union for `Drift`. Explicit return types on all exported functions. No `any`. `status: "open" | "done"` is a literal union.
- **Well-factored** — New file sits at `scripts/check-roadmap.ts`, outside `scripts/autopilot/`, respecting the autopilot module's boundaries. Parsers accept strings and return data — no filesystem inside them. CLI I/O is isolated to the bottom of the file.
- **Well-tested** — Regex-driven parsing is exactly the "failure-prone" category the rubric calls out. Parser + diff tests cover the edge cases. `--fix` has a targeted tmpdir test. Integration smoke test asserts the check is green against the real repo today (fails loudly if a roadmap edit slips past review).
- **Concise** — One new script file, one test file, two existing-file touches. No new dependencies. No abstraction for "roadmap providers" (TOOL-9 may introduce one, but this feature doesn't need it). `--fix` only adds, doesn't remove — the mirror-image case is out of scope and noted.
- **Idiomatic** — Biome-clean tabs/quotes. `.js` extension on relative imports (none needed here — the file has no local imports). Node builtins only (`node:fs`, `node:path`, `node:url`). Named exports; no defaults. Exits via `process.exit(1)`. Matches existing `scripts/autopilot.ts` style.
- **Idioms** — Defer to `/shakedown`.

**No blockers or concerns identified. Ready to build.**
