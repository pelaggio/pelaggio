# TOOL-44 — MarkdownRoadmap: read checkbox-format items (write/read parity)

## Problem

`MarkdownRoadmap.createItem` already detects the target file's format and writes checkbox rows (`- [ ] **ID. Title** — ...`) when the file is checkbox-formatted. But `listOpenItems` / `listItems` / `getItem` call `parseOpenTableRows`, which scans only for the `| Item | Depends on |` pipe-table shape. Any item chartered into a checkbox-format roadmap is invisible to `/pick`, which reports `pick-result: unknown-id`.

Two adjacent gaps observed in the wild:
- **Deps convention**: `blocked: <reason>` needs to flow through the checkbox path too, so `listItems` tags those rows as `status: "blocked"` identically to the table path.
- **Task-index filename**: `createItem`, `markDone`, and `isCharterPickRace` all hardcode `docs/task-index.md`. Fathom names the file `docs/roadmap-task-index.md`, so updates there silently no-op.

## Scope

**Touches**:
- `scripts/autopilot/roadmap/markdown.ts` — checkbox parser + write/read path parity + task-index filename resolver.
- `scripts/autopilot/__tests__/roadmap.test.ts` — regression fixtures for checkbox reads and the fathom-style index filename.

**Does not touch**:
- `RoadmapSource` interface in `roadmap/types.ts` — shape unchanged; callers see the same `RoadmapItem` / `RoadmapItemStatus`.
- `github-issues` and `linear` adapters — their sources of truth are APIs, not markdown.
- `.autopilot.yml` schema — task-index filename is auto-detected from disk, not configured.
- `scripts/check-roadmap.ts` — only consumes pipe-table roadmaps today; adding checkbox support there is a separate consistency-check concern and not in TOOL-44's deliverable list.
- The slightly-different ID regexes inside `listOpenItems` (`[\dA-Z-]*`) vs `listItems` (`[\dA-Z]*`) — pre-existing inconsistency, not load-bearing for this change.

## Approach

### 1. Add a checkbox-row parser, keep `RoadmapRow` shape unchanged

Rather than widen the internal `RoadmapRow` record (which would ripple through both list callers), synthesize the same `{ item: string; deps: string }` shape the pipe-table parser produces:

```ts
function parseCheckboxRows(body: string): RoadmapRow[] {
  const re = /^-\s+\[([ x])\]\s+\*\*([A-Z]+-?\d[\dA-Z-]*)\.\s*(.+?)\*\*(?:\s+—\s+.*?)?(?:\s+Depends on\s+(.+?)\.)?\s*$/gm;
  const rows: RoadmapRow[] = [];
  for (const m of body.matchAll(re)) {
    const [, mark, id, title, deps] = m;
    // Emulate table convention: wrap done rows in ~~...~~ so downstream
    // status detection (`row.item.startsWith("~~")`) continues to work
    // without a second code path.
    const item = mark === "x" ? `~~${id}. ${title.trim()}~~` : `${id}. ${title.trim()}`;
    rows.push({ item, deps: (deps ?? "—").trim() });
  }
  return rows;
}
```

Notes on the regex:
- The capture class `[A-Z]+-?\d[\dA-Z-]*` is taken verbatim from the deliverable — it matches flat IDs (`TOOL-44`), fathom-style (`A-54`), and hierarchical (`COMP-11C-II`).
- Both the em-dash preamble and the `Depends on X.` clause are optional, matching what `createItem` actually writes. No deps → `deps = "—"` (mirrors table convention).
- `blocked: waiting on X` lives inside the `Depends on ...` clause (`- [ ] **A-56. Thing** — ... Depends on blocked: waiting on upstream.`). The parser returns `"blocked: waiting on upstream"` as the `deps` string, which the downstream `^blocked:/i` check in `listItems` already handles.
- Uses `/gm` + `matchAll`; line-anchored so stray `- [ ] **Bold.**` prose paragraphs can't false-match (the `ID` capture requires at least one capital letter + digit shape).

### 2. Thread the new parser through the list/get path

Change `listOpenItems` and `listItems` from `for (const row of parseOpenTableRows(body))` to iterate both sources:

```ts
for (const row of [...parseOpenTableRows(body), ...parseCheckboxRows(body)]) {
  // existing logic (unchanged): isDone detection via "~~" prefix,
  // regex extract of id/title, blocked-reason parsing on deps.
}
```

`getItem` already delegates to `listItems({ includeDone: true })`, so it inherits the new coverage. Its "Recently completed" fallback remains for legacy `- TOOL-N ✓` list entries — those aren't checkbox rows and aren't changing semantics here.

### 3. Add a checkbox branch to `markDone`

`markDone` uses two helpers today that are table-only: `findRoadmapContainingItem` (ID lookup) and `strikethroughRoadmapRow` (mutation). Add checkbox branches to both:

- **`findRoadmapContainingItem`**: if the pipe-table regex `^\|\s*${id}\.` misses, fall back to `^-\s+\[[ x]\]\s+\*\*${id}\.` on the same file body. Return the file path on either hit.
- **Mutation dispatch**: inside `markDone`, after loading the roadmap body, check `detectFormat(body)`. Table → call existing `strikethroughRoadmapRow`. Checkbox → call new `markCheckboxRowDone(body, id, note)` that rewrites the matched line:

  ```
  - [ ] **TOOL-44. Title** — Desc. Depends on X.
  → - [x] **TOOL-44. Title** — Desc. Depends on X. **Done** — <note>
  ```

  (Suffix is ` **Done**` alone when `note` is empty, matching the table path's `| ~~...~~ | **Done** |` convention.) Idempotent: if the line already starts with `- [x]`, return the body untouched (same guard as `strikethroughRoadmapRow`'s `~~` check).

The existing "could not locate open row" error throws identically on either format.

### 4. Tolerate either `task-index.md` filename

Add a module-private helper:

```ts
function resolveTaskIndexPath(docsDir: string): string {
  const primary = resolve(docsDir, "task-index.md");
  const alt = resolve(docsDir, "roadmap-task-index.md");
  if (existsSync(alt) && !existsSync(primary)) return alt;
  return primary;  // default used for both "exists" and "neither exists" cases
}
```

Preference: `task-index.md` when both exist (current default, avoids surprising migration); `roadmap-task-index.md` when only the alt exists (fathom). "Neither exists" returns the default path — callers already gate on `existsSync(indexPath)` before reading.

Call sites in `markdown.ts` to update (6 locations):
- line 124: `file !== "task-index.md"` → accept either filename.
- line 153, 213, 239: build `indexPath` via the helper instead of hardcoding.
- line 160: `git add docs/task-index.md` — change to add the resolved path explicitly (avoids the glob missing the fathom case and avoids `git add` erroring on an absent pathspec by only adding it when the file exists).
- line 243: `git show HEAD:docs/task-index.md` — use the relative path derived from the resolved filename.

### 5. Tests

Extend `scripts/autopilot/__tests__/roadmap.test.ts`:

```ts
describe("MarkdownRoadmap — checkbox-format roadmap", () => {
  function seedCheckboxRoadmap(): string {
    const repo = seedRepo();
    seedFile(
      repo,
      "docs/roadmap-release.md",
      [
        "# Release",
        "",
        "- [ ] **A-54. First open** — First. Scope: M.",
        "- [ ] **A-55. Blocked one** — Blocked. Scope: S. Depends on blocked: waiting on upstream.",
        "- [x] **A-56. Done one** — Done. Scope: XS.",
        "",
      ].join("\n"),
    );
    execSync("git add -A && git commit -q -m seed", { cwd: repo });
    return repo;
  }

  it("listItems surfaces open and blocked checkbox rows, skips [x] by default", async () => { ... });
  it("listItems includeDone tags [x] rows as done", async () => { ... });
  it("getItem finds a checkbox row by ID", async () => { ... });
  it("markDone flips [ ] → [x] and appends note on a checkbox row", async () => {
    // assert the line now reads "- [x] **A-54. First open** — ... **Done** — <note>"
    // assert the commit landed with "docs: mark A-54 done — <note>"
  });
  it("listOpenItems filters out [x] rows", async () => { ... });
});

describe("MarkdownRoadmap — alt task-index filename (fathom)", () => {
  it("createItem updates docs/roadmap-task-index.md when that is the present file", async () => {
    // Seed docs/roadmap-release.md (checkbox) + docs/roadmap-task-index.md; NO docs/task-index.md.
    // Call createItem; assert the new row landed in docs/roadmap-task-index.md.
  });

  it("markDone commits index changes when only the alt filename exists", async () => {
    // Seed both files (checkbox roadmap + alt index). markDone. Assert the
    // commit includes docs/roadmap-task-index.md and the file was rewritten.
  });
});
```

All tests use the existing `seedRepo` / `seedFile` helpers and `node:test`.

## Files to change

| File | Change |
|------|--------|
| `scripts/autopilot/roadmap/markdown.ts` | Add `parseCheckboxRows`. Thread through `listOpenItems` / `listItems`. Add checkbox branches to `findRoadmapContainingItem` and `markDone` (via new `markCheckboxRowDone`). Add `resolveTaskIndexPath` helper; replace 6 hardcoded `task-index.md` sites. |
| `scripts/autopilot/__tests__/roadmap.test.ts` | Two new `describe` blocks — checkbox-format parity + fathom-style index filename. ~80 lines. |

No changes to `types.ts`, `roadmap-cli.ts`, `config.ts`, or any skill body.

## Test strategy

```bash
npx tsx --test --test-reporter=dot scripts/autopilot/__tests__/roadmap.test.ts
npx tsx --test --test-reporter=dot scripts/autopilot/__tests__/*.test.ts
pnpm check
```

Acceptance bar: new tests pass; the existing pipe-table tests keep passing unchanged (regression guard on the dual-parser iteration order).

Manual spot-check: on a fathom clone, `npx claude-autopilot roadmap get A-54 --json` returns the item instead of `null`, and `npx claude-autopilot roadmap list` surfaces all open checkbox rows.

## Rubric self-check

- **Correct**: No pipeline invariants touched. Adapter-local change; `RoadmapSource` contract unchanged. Step exhaustiveness, frontmatter stripping, worktree isolation, rate-limit parking, phantom ship guard — all untouched.
- **Well-typed**: `parseCheckboxRows` and `markCheckboxRowDone` get explicit signatures. No `any`. `RoadmapRow` shape preserved.
- **Well-factored**: All new logic stays inside `roadmap/markdown.ts`. One new internal parser, one new mutation helper, one new path resolver — no cross-module coupling.
- **Well-tested**: every new code path (open row, blocked row, done row, markDone mutation, alt index filename) has a dedicated assertion in `roadmap.test.ts`.
- **Concise**: ~60 lines of TS added to `markdown.ts`, ~80 lines of test. No new abstractions, no new config keys.
