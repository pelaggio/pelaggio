# TOOL-2 — Dep graph visualization from roadmap files

## Scope

**Does:**
- Walk every `docs/roadmap-*.md`, parse the Progress summary table, and build an
  in-memory dep graph keyed by item ID.
- Classify each node as `open`, `blocked`, or `done`:
  - `done` — the roadmap row is strikethrough (`~~TOOL-X. …~~`).
  - `blocked` — the row is open AND either (a) its `Depends on` cell contains
    `blocked:` (explicit external block) OR (b) at least one of its parsed
    `TOOL-N` deps references an item that is not `done`.
  - `open` — the row is open and every parsed dep resolves to a `done` item (or
    there are no deps).
- Emit a Mermaid `flowchart LR` to stdout. Shape per status:
  - `open` → rectangle `TOOL-N["TOOL-N. Title"]`
  - `blocked` → rounded `TOOL-N("TOOL-N. Title")`
  - `done` → rectangle with `:::done` class; a single `classDef done
    stroke-dasharray: 5 5,opacity:0.6` rule styles them as dashed/faded.
- Emit edges `DEP --> ITEM` for every parsed dep token. Edge direction reads
  "DEP must finish before ITEM" — arrowhead points at the dependent.
- `pnpm graph:roadmap` writes the output to `docs/dep-graph.md`, wrapped in a
  fenced ` ```mermaid ` block plus a one-line "generated, do not edit" banner.
  `--stdout` flag prints to stdout instead (for piping / preview).
- Fail cleanly (exit 1, stderr) if a parsed `TOOL-N` dep references an ID that
  doesn't appear in any roadmap's Progress table. Message names the offender
  and the unknown ID.

**Does not:**
- Interactive graph, priority-weighted layout, or cross-repo deps (all called
  out as out-of-scope in the roadmap entry).
- Fix `blocked:` free-text prose — only the presence of the `blocked:` token
  triggers the blocked classification; the human-readable reason is ignored.
- Render items from `Recently completed` index sections or `### Detail`
  blocks. Source of truth is the Progress summary table, identical to
  `check-roadmap.ts`'s parse surface.
- Wire into CI or pre-commit — `pnpm graph:roadmap` is a manual refresh; the
  consumer decides when to regenerate. Matches TOOL-1's philosophy (the CLI
  exists, the hook is opt-in).

## Approach

One self-contained TypeScript module `scripts/roadmap-graph.ts`, runnable via
tsx. Sits as a sibling to `scripts/check-roadmap.ts` (not under
`scripts/autopilot/`) — same reasoning as TOOL-1: this is a repo-hygiene
utility, not pipeline business logic, and the autopilot module has strict
Well-factored boundaries.

**Reuse `check-roadmap.ts`'s parser.** It already exports `parseRoadmap`,
`RoadmapItem`, and `roadmapNameFromFile` — all with the exact data we need
(`id`, `title`, `deps` raw cell, `status: "open" | "done"`, `roadmap` name).
Re-implementing the regex pair here would be duplicative and drift-prone. The
module guards its CLI behind `import.meta.url === pathToFileURL(process.argv[1])`,
so importing it has no side effects.

**Why reuse over abstraction:** both scripts want the same parsed shape.
Extracting a third "roadmap-parse" module would be a premature abstraction (two
call sites) — per rubric Concise, prefer extending an existing function over
adding a helper. If a third consumer appears later, refactor then.

**Why not extend `MarkdownRoadmap` (the RoadmapSource adapter):** that
interface's `listOpenItems()` intentionally drops `done` rows. The graph needs
done items too (dashed). Extending the interface to return mixed-status items
would bloat the abstraction for one consumer. `check-roadmap.ts`'s parser
already returns both statuses — a perfect fit.

### Data model

```ts
type NodeStatus = "open" | "blocked" | "done";

interface GraphNode {
  id: string;           // "TOOL-2"
  title: string;        // "Dep graph visualization from roadmap files"
  status: NodeStatus;
  roadmap: string;      // "core"
}

interface GraphEdge {
  from: string;         // dep id
  to: string;           // dependent id
}

interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface UnknownDepError {
  item: string;         // the row that names the unknown dep
  unknown: string;      // the id that doesn't exist
  roadmap: string;
}
```

### Parsing deps

```ts
export function parseDeps(raw: string): { ids: string[]; blockedExternal: boolean };
```

Rules (pure, no I/O):
- Trim. Normalize so an em-dash `—` or ASCII dash `-` alone → empty ids, not
  blocked.
- If the trimmed value starts with `blocked:` (case-insensitive), return
  `{ ids: [], blockedExternal: true }`. The rest of the cell is human prose,
  ignored.
- Otherwise split on comma, trim tokens, keep only those matching
  `/^TOOL-\d+$/`. Non-matching tokens (e.g. `"—"`, empty strings, stray text)
  are silently dropped — not errors. This keeps the parser tolerant to
  formatting variance; validation of referenced IDs happens in `buildGraph`,
  not here.

### Building the graph

```ts
export function buildGraph(items: RoadmapItem[]): {
  graph: Graph;
  unknown: UnknownDepError[];
};
```

- First pass: build `Set<string>` of all known IDs (both open and done).
- Second pass: for each item, derive `NodeStatus`:
  - `item.status === "done"` → `done`.
  - Parse deps. If `blockedExternal` OR any parsed dep is in the known set and
    maps to a non-`done` item → `blocked`.
  - Else → `open`.
- Emit one edge per parsed dep token that resolves to a known ID. Unknown deps
  are NOT emitted as edges; instead they are pushed to `unknown[]` so the CLI
  can decide whether to fail.
- Edges from done rows are rare in practice: when an item ships, the roadmap
  convention rewrites its `Depends on` cell from `TOOL-N` references to a
  `**Done** — …` reason string (see `roadmap-core.md` for examples). Those
  cells contain no `TOOL-\d+` tokens, so `parseDeps` returns `ids: []` and no
  historical edges are emitted from done nodes. Edges from open nodes to done
  deps still render (e.g. `TOOL-15 → TOOL-9`) because it's the *open* row's
  deps cell that names `TOOL-9`. Don't try to reconstruct pre-completion
  edges — the data isn't there. If a done row ever *does* still carry
  `TOOL-N` tokens (manual edit), the edges emit as-is; done nodes are faded
  so the output stays readable.

**Duplicate-ID guard:** if the same ID appears in multiple roadmaps (open in
one, done in another, etc.), this is structural drift that TOOL-1's
`check:roadmap` already flags with `id-collision`. `buildGraph` keeps the
first occurrence and ignores later ones — deterministic and visibly wrong in
the output, which is the right failure mode for a utility downstream of a
dedicated consistency check.

### Emitting Mermaid

```ts
export function emitMermaid(graph: Graph): string;
```

Layout:

```
flowchart LR
  classDef done stroke-dasharray: 5 5,opacity:0.6

  TOOL-1["TOOL-1. Title"]:::done
  TOOL-2("TOOL-2. Title")
  TOOL-15["TOOL-15. Title"]

  TOOL-9 --> TOOL-15
```

Rules:
- Nodes emitted sorted by numeric suffix of the ID (stable output → clean diffs
  on regeneration).
- Edges emitted sorted by `(from, to)`.
- Title escaping: replace `"` with `&quot;`, `[` with `&#91;`, `]` with
  `&#93;`, and any newline with a space. No current roadmap title contains
  `[`/`]`, but closing the bracket prematurely would silently corrupt
  Mermaid syntax — cheap to guard against. IDs are `[A-Z]+-\d+`, safe as
  Mermaid node identifiers verbatim.
- Blank line between the classDef block and node declarations, and between
  nodes and edges. Purely cosmetic; keeps generated docs readable.

### CLI layer

```ts
function runCli(argv: string[]): number
```

- Resolve repo root from `import.meta.url` (same pattern as
  `check-roadmap.ts:findRepoRoot`).
- Load all `docs/roadmap-*.md`, parse via `parseRoadmap`, feed into
  `buildGraph`.
- If `unknown.length > 0`: print to stderr a one-line-per-error report:
  `TOOL-15 [core] references unknown dep TOOL-99`. Exit 1. Do not write the
  output file — stale output is worse than missing output.
- Emit Mermaid string.
- Default (no args, i.e. `pnpm graph:roadmap`): write to
  `{repoRoot}/docs/dep-graph.md` with the wrapper below. This matches the
  user-facing contract — the one-liner refreshes the generated artifact.
- If `--stdout` is passed: write the raw Mermaid body to stdout, no wrapper,
  no file write. (For piping / preview.)
- Unknown flags → exit 1 with a usage message; don't silently fall through.

Wrapper format when writing to the file:

  ```markdown
  # Roadmap Dependency Graph

  <!-- Generated by `pnpm graph:roadmap` — do not edit. -->

  ```mermaid
  {mermaid body}
  ```
  ```

  (Three-backtick fence; written with literal backticks in source.)

- Exit 0.

Guard CLI entry with `import.meta.url === pathToFileURL(process.argv[1] ??
"").href`, matching the existing idiom so unit tests can import the module
without triggering `process.exit`.

## Files to change

**New:**
- `scripts/roadmap-graph.ts` — parser glue, `parseDeps`, `buildGraph`,
  `emitMermaid`, CLI. ~150 lines.
- `scripts/autopilot/__tests__/roadmap-graph.test.ts` — unit tests via
  `node:test`. ~140 lines.

**Modified:**
- `package.json` — add `"graph:roadmap": "tsx scripts/roadmap-graph.ts"` to
  `scripts`.
- `CLAUDE.md` — one-line addition under "Running things" documenting
  `pnpm graph:roadmap`.

**Not touched:**
- `scripts/autopilot/**` — no coupling into the pipeline. `MarkdownRoadmap`,
  `RoadmapSource`, config, step-runner — all untouched.
- `.claude/skills/**` — this is not a pipeline step. No skill body needed;
  invocation is a one-line `pnpm` script that humans run.
- `docs/roadmap-*.md`, `docs/task-index.md` — read-only for this script.
- `docs/dep-graph.md` — generated artifact; first run of `pnpm graph:roadmap`
  creates it. Not committed in this change; let the first regeneration commit
  carry it to avoid landing stale output.

## Test strategy

`node:test` via `npx tsx --test`, test file under
`scripts/autopilot/__tests__/` so the existing `pnpm test` glob picks it up
without glob changes (same pattern TOOL-1 followed).

**`parseDeps` tests:**
- `"—"` (em-dash) → `{ ids: [], blockedExternal: false }`.
- `"-"` (ASCII dash) → same as above.
- `""` → same as above.
- `"TOOL-9"` → `{ ids: ["TOOL-9"], blockedExternal: false }`.
- `"TOOL-4, TOOL-8"` → two ids, order preserved.
- `"  TOOL-4 ,TOOL-8  "` → two ids (whitespace tolerance).
- `"blocked: waiting on legal review"` → `{ ids: [], blockedExternal: true }`.
- `"Blocked: X"` → case-insensitive prefix, same.
- `"TOOL-4, FOO-1"` → drops `FOO-1` silently (`buildGraph` is where unknown-ID
  errors surface, but `FOO-1` doesn't even match `TOOL-\d+`).

**`buildGraph` tests:**
- All deps satisfied by done items → node is `open`.
- Dep references an open item → node is `blocked`.
- `blocked: ...` in deps → node is `blocked`, no edges from it.
- Strikethrough row → node is `done` regardless of deps content.
- Unknown dep `TOOL-4 → TOOL-999` → `unknown` array has one entry with
  item=`TOOL-4`, unknown=`TOOL-999`, roadmap=`core`.
- Nodes sorted by numeric ID suffix.
- Edges emitted for every known-dep token; none for unknown ones.

**`emitMermaid` tests:**
- Open node → `TOOL-N["TOOL-N. Title"]` shape.
- Blocked node → `TOOL-N("TOOL-N. Title")` shape.
- Done node → `TOOL-N["TOOL-N. Title"]:::done` + single `classDef done …` line
  present in output.
- Title containing `"` → escaped to `&quot;` in the output.
- Title containing `[` / `]` → escaped to `&#91;` / `&#93;`.
- Title containing `\n` → collapsed to single space.
- Snapshot-style equality test on a small fixture (3 items, 1 edge, 1 done, 1
  blocked) to lock stable formatting.

**CLI-level integration test:**
- Exec `npx tsx scripts/roadmap-graph.ts --stdout` against the real repo via
  `execFileSync`. Assert exit 0, stdout starts with `flowchart LR`. Catches
  regressions where a roadmap edit introduces an unknown dep and nobody
  noticed.
- Negative: write a temp roadmap file with an unknown dep to a tmpdir repo,
  invoke the module's `runCli` directly (not shell), assert it returns 1 and
  writes the expected error line to stderr.

No tmpdir-based `docs/dep-graph.md` write tests — the write step is `writeFileSync`
of a string, not interesting. If it breaks, the integration test catches it.

## Rubric self-check

- **Correct** — No pipeline-invariant interaction. `STEPS`, frontmatter
  stripping, worktree isolation, parking, phantom ship guard — all untouched.
  The one invariant for this script: stale output is worse than missing
  output, so on unknown-dep error we exit before writing. Covered by tests.
  Reusing `parseRoadmap` means the open/done classification stays in lockstep
  with `check-roadmap.ts` by construction.
- **Well-typed** — Discriminated `NodeStatus`, explicit return types on every
  exported function, no `any`. `RoadmapItem` reused from `check-roadmap.ts`
  (already typed there). No casts.
- **Well-factored** — New file sits at `scripts/roadmap-graph.ts`, outside
  `scripts/autopilot/`, preserving autopilot's module boundary. Pure
  functions (`parseDeps`, `buildGraph`, `emitMermaid`) take strings/data and
  return data; only the CLI touches `fs`. That matches TOOL-1's layering.
- **Well-tested** — Regex-ish parsing in `parseDeps` is exactly the
  "failure-prone" category the rubric calls out. Unit tests cover every
  branch. `buildGraph` classification and unknown-dep detection are both
  tested. An integration smoke keeps the real repo honest.
- **Concise** — One new script + one test file + two single-line touches.
  No new dependencies, no new abstractions, no skill body. Title-escape
  logic is minimal (2 replacements, documented). No edge-filter knob for
  done-to-done edges — add it only if real use shows clutter.
- **Idiomatic** — Biome-clean tabs/quotes, `.js` extensions on relative
  imports (`./check-roadmap.js`), node builtins (`node:fs`, `node:path`,
  `node:url`), named exports, `process.exit(…)` from CLI entry. Matches
  `scripts/check-roadmap.ts` line for line.
- **Idioms** — Defer to `/shakedown`.

**No blockers or concerns identified. Ready to build.**
