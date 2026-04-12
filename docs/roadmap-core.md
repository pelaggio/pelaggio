# Core Roadmap — claude-autopilot self-improvements

Real backlog for the autopilot tooling. These are items we've identified during the design + extraction but haven't implemented yet. Dogfooding target: run `pnpm autopilot --cycles N` against this list and let the pipeline work on its own codebase.

**Related:** [task-index.md](task-index.md)

> **Sequencing:** Items are mostly independent. TOOL-6 (Biome) is a good first cycle — it's small, touches config files only, and validates the full pipeline works end-to-end on a trivial change before we throw harder items at it.

## Progress

**Open items:**

| Item | Depends on |
|------|-----------|
| TOOL-1. Consistency check: task-index ↔ roadmap drift | — |
| TOOL-2. Dep graph visualization from roadmap files | — |
| TOOL-3. Scope suggestion in /charter from description | — |
| TOOL-4. pipeline.ts integration tests via SDK query mock | — |
| TOOL-5. Skill body linter (frontmatter validity, rubric references) | — |
| TOOL-6. Biome config for scripts/ + pre-commit hook | — |

---

## Items

### TOOL-1. Consistency check: task-index ↔ roadmap drift

| What | Scope | Deps |
|------|-------|------|
| Script that verifies every open item in a `roadmap-*.md` has a matching row in `task-index.md`, and vice versa. Flags missing/extra rows and ID collisions. Run as a standalone command or as a pre-commit hook. | S | — |

**Deliverables:**
- `scripts/check-roadmap.ts` — reads all `docs/roadmap-*.md`, extracts open items, cross-checks against `docs/task-index.md`
- Exit 0 when consistent, exit 1 with actionable diff when not
- Optional `--fix` flag that adds missing task-index rows from roadmaps (roadmaps are source of truth)
- Wire into `pnpm` scripts as `pnpm check:roadmap`
- Unit tests for the parser

**Out of scope:**
- Bidirectional sync (roadmaps are source of truth, task-index is derived)
- Detecting semantic drift (title changed in one file but not the other) — only structural presence/absence

---

### TOOL-2. Dep graph visualization from roadmap files

| What | Scope | Deps |
|------|-------|------|
| Parse `Depends on` columns across all roadmaps and emit a Mermaid flowchart that can be dropped into docs. | S | — |

**Deliverables:**
- `scripts/roadmap-graph.ts` — walks all `docs/roadmap-*.md`, builds a dep graph, emits Mermaid `flowchart LR` syntax to stdout
- `pnpm graph:roadmap` script that writes the output to `docs/dep-graph.md`
- Distinguishes open (box) vs blocked (rounded) vs completed (dashed) items
- Fails cleanly if a dep references an unknown ID

**Out of scope:**
- Interactive graph (Mermaid is enough)
- Priority-weighted layout
- Cross-repo deps (one repo at a time)

---

### TOOL-3. Scope suggestion in /charter from description

| What | Scope | Deps |
|------|-------|------|
| When `/charter` is called without `--scope`, infer XS/S/M/L/XL from the description using keyword heuristics. Report the inferred scope + a one-line rationale. | S | — |

**Deliverables:**
- Update `.claude/skills/charter/SKILL.md` with a "Scope inference" section listing the heuristics
- Heuristics: "fix" / "typo" / "rename" → XS; "add X" / "one file" → S; "new screen" / "new hook" → M; "new system" / "new engine" → L; "migration" / "rewrite" / "schema change" → XL
- The skill already has `--scope` override — don't break that path
- Report: `"Inferred scope: M (new screen/component)"`

**Out of scope:**
- ML-based scope estimation — keyword heuristics are fine
- Changing the XS/S/M/L/XL taxonomy

---

### TOOL-4. pipeline.ts integration tests via SDK query mock

| What | Scope | Deps |
|------|-------|------|
| Add integration tests for `pipeline.ts` that mock the `claude-agent-sdk` `query()` generator to simulate step outcomes without real API calls. | M | — |

**Deliverables:**
- `scripts/autopilot/__tests__/pipeline.test.ts` with at least 4 scenarios:
  - Happy path: pick → plan → shakedown-plan (APPROVE) → implement → shakedown-code → ship all succeed
  - RETHINK verdict on plan review aborts the cycle cleanly
  - Implement turn exhaustion retries once, then commits a checkpoint
  - Rate limit parking preserves state for resume
- Mock infrastructure for `query()` — a generator factory that yields configured `SDKAssistantMessage` / `SDKResultMessage` events
- Tests run via `npx tsx --test`
- No real SDK calls, no real git operations (use a temp directory)

**Out of scope:**
- E2E tests with real SDK (too expensive)
- UI testing for `tui.ts`

---

### TOOL-5. Skill body linter (frontmatter validity, rubric references)

| What | Scope | Deps |
|------|-------|------|
| Lint all `.claude/skills/*/SKILL.md` files for: valid frontmatter, required fields, consistent `!cat` includes, no dangling references to removed skills or files. | S | — |

**Deliverables:**
- `scripts/check-skills.ts` — reads all SKILL.md files, parses frontmatter, validates against a schema
- Required fields: `name`, `description`, `allowed-tools`
- Optional fields: `argument-hint`, `context`, `agent`, `effort`, `disable-model-invocation`
- Flags unknown frontmatter fields
- Validates `!cat .claude/skills/X.md` references point at real files
- Flags `$ARGUMENTS` usage where `argument-hint` is missing
- Wire into `pnpm` as `pnpm check:skills`

**Out of scope:**
- Validating skill prose content (too subjective)
- Markdown linting (defer until/if biome supports MD)

---

### TOOL-6. Biome config for scripts/ + pre-commit hook

| What | Scope | Deps |
|------|-------|------|
| Add Biome config scoped to `scripts/`, install the dependency, wire a lefthook pre-commit hook that runs biome on staged TypeScript files. | XS | — |

**Deliverables:**
- `biome.json` at repo root, `files.include: ["scripts/**/*.ts"]`, formatting style matches Fathom's conventions (tabs, double quotes, trailing commas)
- `pnpm add -D -w @biomejs/biome`
- `pnpm check` script that runs `biome check scripts/`
- `lefthook.yml` with a pre-commit hook running biome on staged `scripts/**/*.ts` files
- `pnpm add -D -w lefthook`

**Out of scope:**
- Linting `.claude-templates/` (markdown)
- Linting `.claude/skills/` (markdown)
- Strict type-checking (the rubric says tsx runtime is good enough for now)

---

## Scope legend

- **XS** — 1-2 files, <1 hour of work
- **S** — 2-4 files, 1-3 hours
- **M** — 4-10 files, half day to full day
- **L** — 10+ files, multi-day, probably needs a plan
- **XL** — major feature, definitely needs a plan + shakedown-plan pass

Autopilot detects scope from the `scope: X` hint in the item text. XS/S items skip the planning step and go straight to implementation.
