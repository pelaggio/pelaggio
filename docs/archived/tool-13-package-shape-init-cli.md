# TOOL-13 — Package shape + git-dep consumption + `init` CLI

**Branch:** `feat/tool-13-package-shape-init-cli`
**Deps satisfied:** TOOL-8, TOOL-11 ✓
**Scope size:** L

## Goal

Reshape this repo so it can be consumed as `@cdhorne/claude-autopilot` via git-dep
(`"@cdhorne/claude-autopilot": "github:cdhorne/claude-autopilot#<sha>"`), and ship an
`init` CLI that scaffolds `.claude/skills/`, `.autopilot.yml`, and starter roadmap docs
into a consuming project. No npm publish (TOOL-18). No `sync` command (TOOL-14).

The consuming-project story after this lands:

```bash
pnpm add -D github:cdhorne/claude-autopilot#<sha>
npx claude-autopilot init
# → scaffolds .claude/skills/, .autopilot.yml, docs/task-index.md, docs/roadmap-example.md
# → adds "autopilot": "claude-autopilot run" to package.json scripts
pnpm autopilot --cycles 1 --verbose
```

## Scope

### In scope
- `package.json` name, `bin`, `exports`, `main`, `dependencies` reshuffle
- `bin/claude-autopilot.js` — JS shim dispatching to `init | run | stats`
- `scripts/autopilot/init.ts` — scaffold implementation
- `scripts/autopilot/index.ts` — public library surface (`run`, `loadConfig`,
  `runStatsCommand`)
- Make `REPO` derivation CWD-based (via `git rev-parse --show-toplevel`) so the
  pipeline works when the package is installed under `node_modules/`
- README update: install-as-git-dep instructions + pointer to TOOL-18
- Unit tests for `init` and `resolveRepo`

### Out of scope (explicit)
- npm publish, `files` allowlist, `.npmignore` — deferred to TOOL-18
- `sync` subcommand — TOOL-14 (unknown-subcommand prints usage; no stub handler)
- Semver stability
- Migrating `.claude-templates/` content — reused as-is by `init`
- Any change to the pipeline's runtime behavior beyond REPO resolution
- Bundling / compilation — runtime stays on `tsx`

## Approach

### 1. Package metadata

Edit `package.json`. Show only the fields that change — preserve existing `description`,
`license`, `packageManager`, and `scripts` untouched. `scripts.autopilot` (currently
`"tsx scripts/autopilot.ts"`) stays as-is: it's the repo's own dogfooding entry and has
no bearing on consumers (who invoke `claude-autopilot run` via the `bin`).

```jsonc
{
  "name": "@cdhorne/claude-autopilot",           // was: "claude-autopilot"
  "private": true,                                // stays true — flipped in TOOL-18
  "bin": { "claude-autopilot": "./bin/claude-autopilot.js" },  // new
  "main": "./scripts/autopilot/index.ts",         // new
  "exports": {                                    // new
    ".": "./scripts/autopilot/index.ts",
    "./package.json": "./package.json"
  },
  "dependencies": {                               // new — moved from devDependencies
    "@anthropic-ai/claude-agent-sdk": "^0.2.113",
    "tsx": "^4.19.0",
    "yaml": "^2.8.3"
  },
  "devDependencies": {                            // trimmed — runtime deps moved out
    "@anthropic-ai/claude-code": "^2.1.113",
    "@biomejs/biome": "^2.4.12",
    "lefthook": "^2.1.6",
    "typescript": "^6.0.3"
  }
}
```

Key moves:
- **Rename** `claude-autopilot` → `@cdhorne/claude-autopilot`
- **Keep `private: true`** — git-dep installs don't consult it; it's a safety net against
  accidental `npm publish` until TOOL-18 lifts it deliberately.
- **Split deps**: runtime modules (`@anthropic-ai/claude-agent-sdk`, `tsx`, `yaml`) move
  to `dependencies` so they install for consumers. Dev-only (`biome`, `lefthook`,
  `typescript`, `@anthropic-ai/claude-code`) stay in `devDependencies`.
- **`exports`/`main` point to `.ts` — known limitation**: this works fine for the CLI
  path because `bin/claude-autopilot.js` spawns `tsx` explicitly. It also works for
  programmatic library consumers who run under `tsx` (the expected case — any consumer
  doing `import { run } from "@cdhorne/claude-autopilot"` today is a tsx-based repo like
  Fathom). It does **not** work for plain Node or bundlers without a `.ts` loader.
  TOOL-18 is where we add a build step that emits `.js` for `exports`. Until then, note
  this explicitly in the README's "Install as a dep" section so consumers aren't
  surprised.
- **Why `main` alongside `exports`**: a belt-and-braces fallback for loaders that ignore
  `exports`. Both point at the same file.

### 2. CLI entry — `bin/claude-autopilot.js`

New file. Plain ESM JS (no tsx compile step needed to *launch* it). Resolves the package
root, then dispatches to tsx for the TypeScript modules.

```js
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [, , sub, ...rest] = process.argv;

const HELP = `
claude-autopilot <command> [options]

Commands:
  init    Scaffold .claude/skills/, .autopilot.yml, and starter docs into this project.
  run     Run the pipeline (same flags as \`pnpm autopilot\`: --cycles --parallel --item …).
  stats   Print the stats dashboard from .dev/autopilot-log.jsonl.

See README for full options.
`.trim();

const routes = {
  init:  ["scripts/autopilot/init.ts"],
  run:   ["scripts/autopilot.ts"],
  stats: ["scripts/autopilot.ts", "stats"],
};

if (!sub || sub === "--help" || sub === "-h" || !routes[sub]) {
  console.log(HELP);
  process.exit(sub && sub !== "--help" && sub !== "-h" ? 1 : 0);
}

import { existsSync } from "node:fs";

const [script, ...prefix] = routes[sub];
const localTsx = resolve(pkgRoot, "node_modules/.bin/tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

spawn(tsx, [resolve(pkgRoot, script), ...prefix, ...rest], {
  stdio: "inherit",
  env: process.env,
}).on("exit", (code) => process.exit(code ?? 1));
```

- **Unknown subcommand or `sync`** → prints help and exits 1. No stub handler for `sync`
  (YAGNI — TOOL-14 adds it properly).
- **Why `node_modules/.bin/tsx` inside the package?** `tsx` is a `dependency` of the
  package, so it's installed alongside `@cdhorne/claude-autopilot` under
  `<consumer>/node_modules/@cdhorne/claude-autopilot/node_modules/.bin/tsx` with pnpm's
  isolated layout (or hoisted with `npm`/`yarn`). If the file is missing (edge case —
  unusual hoisting, or running the shim from a checkout without installed deps), the
  `existsSync` fallback hands off to whatever `tsx` is on PATH. `spawn` with a bare
  command name resolves against PATH; if neither exists, the child errors out loudly.
- **Make the file executable** (`chmod +x bin/claude-autopilot.js`) before committing.

### 3. `init` subcommand — `scripts/autopilot/init.ts`

Self-contained module, no pipeline imports. Uses only `node:fs`, `node:path`,
`node:child_process`, and `node:util.parseArgs`.

```ts
#!/usr/bin/env tsx
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

interface Plan { src: string; dest: string; overwrite: boolean; }

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function resolveConsumerRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error("claude-autopilot init must run inside a git repository");
  }
}

function walk(dir: string): string[] { /* recursive file list */ }

function planCopies(pkgRoot: string, consumerRoot: string, force: boolean): Plan[] {
  const plans: Plan[] = [];
  // 1. .claude/skills/ — copy every skill file, but substitute _rubric.md with the template
  // 2. .autopilot.yml stub (only if missing)
  // 3. docs/task-index.md + docs/roadmap-example.md (only if missing)
  return plans;
}

function updatePackageJson(consumerRoot: string, dryRun: boolean): boolean {
  // Read <consumer>/package.json, add scripts.autopilot = "claude-autopilot run" if missing.
  // Return true if changed.
}

function main() {
  const { values } = parseArgs({ options: {
    force:   { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  }});
  const consumer = resolveConsumerRoot();
  const plans = planCopies(PKG_ROOT, consumer, !!values.force);
  // ... render summary, execute copies (unless dry-run), update package.json, print next-steps.
}

main();
```

**Source-of-truth map** (package → consumer):

| Source in package                              | Destination in consumer        | Skip if exists? |
|-----------------------------------------------|--------------------------------|-----------------|
| `.claude/skills/**` (excluding `_rubric.md`)   | `.claude/skills/**`            | yes (no `--force`) |
| `.claude-templates/_rubric.md`                | `.claude/skills/_rubric.md`    | yes             |
| `.claude-templates/docs/task-index.md`        | `docs/task-index.md`           | yes             |
| `.claude-templates/docs/roadmap-example.md`   | `docs/roadmap-example.md`      | yes             |
| `.autopilot.example.yml` (new — tiny stub)    | `.autopilot.yml`               | yes             |

- Copy skills from the *package's* `.claude/skills/` — these are generic per the current
  rubric (the repo's own `_rubric.md` is the one exception; we substitute the template).
- `.claude/skills/_review-logic.md` is generic → copies over.
- `.autopilot.example.yml` is a new file added to this repo's root: ~15 lines of
  commented-out defaults. Shipped inside the package so `init` always has something to
  copy; useful standalone too (it's the worked example `docs/config.md` already refers
  to).
- Overwrite semantics: `--force` ignores all "skip if exists" checks uniformly.
- `--dry-run` prints the plan (source → destination, + "would overwrite"/"would create")
  and exits 0 without touching files.
- Summary output at end: count created, count skipped, count overwritten + "next steps"
  block pointing the user at `_rubric.md` (to author their rubric) and `pnpm autopilot`.

### 4. `scripts/autopilot/index.ts` — library exports

```ts
export { loadConfig } from "./config.js";
export { orchestrate as run } from "./pipeline.js";
export { runStatsCommand } from "./stats.js";
export type { Flags, CycleResult, PipelineOpts, Step } from "./types.js";
```

Small surface — just what the deliverable calls for. `run` is the rename from
`orchestrate` (which is already the public-ish entry point used by `main.ts`). Keeping
the re-export light means we don't commit to stabilizing every internal.

### 5. REPO resolution — `scripts/autopilot/config.ts`

Current (module-load time):
```ts
export const REPO = resolve(__dirname, "../..");
```

New:
```ts
function resolveRepo(): string {
  if (process.env.CLAUDE_AUTOPILOT_REPO) return resolve(process.env.CLAUDE_AUTOPILOT_REPO);
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error("claude-autopilot must run inside a git repository (or set CLAUDE_AUTOPILOT_REPO)");
  }
}
export const REPO = resolveRepo();
```

- Uses `execSync` (already used throughout `helpers.ts`, no new dep).
- Keeps `CLAUDE_AUTOPILOT_REPO` as escape hatch, mirroring the existing
  `CLAUDE_AUTOPILOT_WORKTREE_PREFIX` env precedence pattern.
- Dogfooding regression: running `pnpm autopilot` in this repo still computes
  `REPO = /home/chris/workspace/claude-autopilot` correctly because CWD at launch is the
  repo root.
- Worktree regression: inside a worktree, `git rev-parse --show-toplevel` returns the
  worktree's own path, not the main repo. But autopilot currently only reads `REPO` at
  the *orchestrator* level — which always runs from the main repo — and passes `cwd` into
  `runStep` explicitly when dispatching into a worktree. So the resolution is still
  correct. (Double-check during implement: `runStatsCommand` and `orchestrate` are the
  two entry points and both launch from the main repo.)
- **Update `config.ts` imports**: drop `dirname(fileURLToPath(import.meta.url))` usage
  since REPO no longer needs it. The `__dirname` computation still lives for potential
  future use — remove if unused after the change.

### 6. `.autopilot.example.yml` (new file at repo root)

~15 lines, all commented-out defaults so a consumer can uncomment selectively. Matches
the schema documented in `docs/config.md`:

```yaml
# .autopilot.yml — see https://github.com/cdhorne/claude-autopilot/blob/main/docs/config.md
#
# worktree:
#   prefix: my-project-
#
# budgets:
#   implement: 25
#
# ship:
#   target: direct-push  # direct-push | pull-request | auto-merge-pr
```

### 7. README update

Add an "Install as a dep" section near the top, above "What's in here":

```md
## Install it in another project (recommended path)

Until TOOL-18 makes the public npm publish, install via git dep:

    pnpm add -D github:cdhorne/claude-autopilot#<sha>
    npx claude-autopilot init

Pin by SHA — the package intentionally provides no semver stability guarantees yet.
```

Keep the existing "Using it in a new project" copy-paste section but mark it as the
legacy path, kept for reference.

## Files to change

| File | Change |
|------|--------|
| `package.json` | name, bin, main, exports, deps reshuffle |
| `bin/claude-autopilot.js` | **new** — CLI multiplexer |
| `scripts/autopilot/init.ts` | **new** — init command |
| `scripts/autopilot/index.ts` | **new** — library exports |
| `scripts/autopilot/config.ts` | `REPO` via `git rev-parse`; drop unused `__dirname` |
| `.autopilot.example.yml` | **new** — copied by `init` |
| `README.md` | install-as-git-dep section |
| `scripts/autopilot/__tests__/init.test.ts` | **new** — init behavior tests |
| `scripts/autopilot/__tests__/config.test.ts` | **new (or extend existing)** — `resolveRepo` behavior |

No changes to: `pipeline.ts`, `helpers.ts`, `step-runner.ts`, `stats.ts`, `tui.ts`,
`types.ts`, any skill markdown. Step exhaustiveness is untouched.

## Schema changes

None.

## Test strategy

New tests live under `scripts/autopilot/__tests__/`, run via `node:test` + `tsx --test`.

**`init.test.ts`:**
- Scaffolds into a tmp git repo; verifies expected files land in expected paths.
- Re-running without `--force` is a no-op (skip messages, no mutation).
- Re-running with `--force` overwrites.
- `--dry-run` prints plan but creates zero files.
- `package.json` gets `scripts.autopilot = "claude-autopilot run"` added; preexisting
  unrelated scripts are preserved; existing `scripts.autopilot` is left alone.
- Running outside a git repo fails with the informative error.

**`config.test.ts`** (or extend `helpers.test.ts`):
- `resolveRepo()` respects `CLAUDE_AUTOPILOT_REPO` env.
- `resolveRepo()` falls back to `git rev-parse`; throws when neither is available.
- No regression in `loadConfig` behavior — existing config tests still pass.

**Manual smoke test** (per deliverable): install this package into Fathom as a git dep,
run `npx claude-autopilot init`, verify scaffold is usable. This is a post-merge check,
not a CI gate — noted in the PR body as a follow-up task.

**Verification commands** (run during `shakedown-code`):
```bash
npx tsx --test scripts/autopilot/__tests__/*.test.ts
npx tsx -e "import('./scripts/autopilot/config.ts')"
npx tsx -e "import('./scripts/autopilot/pipeline.ts')"
npx tsx -e "import('./scripts/autopilot/index.ts')"
pnpm autopilot --dry-run --cycles 1          # dogfood regression: pipeline still loads
pnpm check                                    # biome clean
```

## i18n needs

None — this is tooling, no user-facing strings.

## Rubric self-check

| Dimension | Notes |
|-----------|-------|
| Well-typed | All new TS files are strict. No `any`. `init.ts` uses discriminated `Plan` objects (create vs overwrite) if the summary rendering benefits from it. |
| Well-tested | `init` and `resolveRepo` both get unit tests. Pipeline runtime is unchanged, so existing tests cover regression. |
| Well-factored | `init.ts` is self-contained and does not import pipeline internals. `bin/…` is pure plumbing. `index.ts` is a thin re-export — no new surface logic. |
| Idiomatic | Biome-clean, ESM, `.js`-suffix imports, node builtins first. Named exports only. |
| Correct | REPO resolution preserves the worktree-isolation invariant (same main-repo path at orchestrator level). Step exhaustiveness untouched. No hardcoded model strings added. `init` is non-destructive by default. |
| Concise | No stub `sync` handler. No new abstraction layers. No premature "template engine" — just `copyFileSync`. `.autopilot.example.yml` is 15 lines. |

## Self-review — revisions made

1. **Initial draft had `"private": false`** to match the dep-consumption narrative. On
   review: `npm publish` requires `private:false`, and TOOL-18 is where we flip that
   deliberately. Reverted to `private:true` — git-dep ignores it; it's a cheap safety
   net.

2. **Initial draft added a `sync` stub** ("coming in TOOL-14" message). Removed: the
   deliverable's "Out of scope" explicitly names `sync`, and YAGNI beats a courtesy
   message. Unknown subcommand → help text, exit 1.

3. **Initial draft changed `REPO` lazily** (getter on a property). On review, the current
   codebase treats `REPO` as a module-level `const` throughout — preserving that contract
   (eager evaluation at import) avoids a cross-cutting refactor. Kept eager.

4. **Initial draft used `CLAUDE_AUTOPILOT_PKG_ROOT` env var** for the package root inside
   `bin/claude-autopilot.js`. Redundant — `import.meta.url` gives it deterministically,
   and the env var was noise.

5. **Initial draft copied `.claude-templates/docs/*.md` wholesale** (8+ files). Trimmed
   to the two files the deliverable names (`task-index.md`, `roadmap-example.md`). The
   other templates (`philosophy.md`, `architecture.md`, etc.) are author-intent docs the
   migration checklist explicitly says should be written *by hand* by the human
   operator — scaffolding them with placeholder content is a regression. The full
   template set remains available in the repo under `.claude-templates/docs/` for copy-
   paste.

6. **Initial draft added `tsx` as a peerDependency**, reasoning that consumers already
   had it. On review, consumer install flow is fragile — safer to make `tsx` a direct
   `dependency` so `bin/claude-autopilot.js` has a guaranteed path to it via the
   package's own `node_modules`. pnpm's isolated install creates a nested tsx, which is
   exactly what we want.

7. **Initial draft wrote `.autopilot.yml` with all defaults populated.** Changed to an
   all-commented-out stub — that's closer to YAGNI (defaults live in code; file is only
   for overrides) and matches the pattern in `docs/config.md`.

8. **Initial draft showed a full replacement `package.json` block** that silently dropped
   `description`, `license`, `packageManager`, and `scripts`. Changed to a jsonc diff-
   style snippet with `// was/new` annotations so the implementer edits the existing file
   in place rather than overwriting. `scripts.autopilot` intentionally stays as
   `tsx scripts/autopilot.ts` — the repo dogfoods itself; only *consumers* get the
   `claude-autopilot run` script (via `init`).

9. **Initial draft omitted the `tsx` binary fallback from the bin snippet**; the prose
   mentioned "fall back to `tsx` on PATH" but the code didn't implement it. Added an
   `existsSync` check so the fallback is real, not aspirational.

10. **Initial draft didn't flag the `.ts`-in-`exports` limitation.** Added an explicit
    "known limitation" bullet under Package metadata so the README's install section
    calls it out — consumers running plain Node or a bundler without a `.ts` loader will
    hit import errors. Fine for the Fathom-style tsx consumer this cycle targets; TOOL-18
    introduces the build step.

---

Run `/shakedown` for an independent review, or say **go** to start building. When done,
run `/shakedown` again to review the code.
