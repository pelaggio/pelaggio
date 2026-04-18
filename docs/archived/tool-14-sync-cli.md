# TOOL-14 — `sync` CLI: upgrade installed skills with diff prompts

**Branch:** `feat/tool-14-sync-cli`
**Roadmap:** [docs/roadmap-core.md § TOOL-14](../roadmap-core.md)
**Depends on:** TOOL-13 (package shape + `init` CLI) — done.

## Goal

Give consumers of `@cdhorne/claude-autopilot` a one-shot upgrade path for the
shipped skills. After `init` scaffolded `.claude/skills/<name>/SKILL.md` into
their repo at version *v1*, when the package upgrades to *v2*, running
`npx claude-autopilot sync` diffs the package's current SKILL.md bodies
against the consumer's copies and prompts per-file: **overwrite**, **skip**, or
**merge** (defer to manual resolution).

## Scope

**In scope (touched by sync):**
- Files matching `<consumerRoot>/.claude/skills/<name>/SKILL.md` where `<name>`
  is a directory in the package's `.claude/skills/` (e.g., `pick/SKILL.md`,
  `plan/SKILL.md`, `ship/SKILL.md`).
- Sidecar files of the form `<file>.upstream` produced by the `merge` action.

**Out of scope (allowlist explicitly excludes — never touched):**
- `.claude/skills/_rubric.md` — consumer-customized.
- `.claude/skills/_review-logic.md` — top-level shared file (not inside a named
  skill dir per the strict allowlist). Mirrors what TOOL-14's deliverable text
  says: "SKILL.md in named skill directories." If a future tool needs to refresh
  `_review-logic.md`, it ships separately.
- `docs/`, `docs/plans/`, `.autopilot.yml`, `package.json`, anything outside
  `.claude/skills/<name>/`.
- `scripts/autopilot/` (per spec out-of-scope: that's a package upgrade, not
  sync).
- Skill directories present in the *consumer* but absent in the *package*
  (i.e., consumer-authored skills) — left alone, never reported as a conflict.
- Downgrades — sync only ever pulls *forward* from package → consumer. There is
  no version semantic; sync just copies whatever the installed package
  currently ships.

## Approach

Follow the shape and conventions established by `scripts/autopilot/init.ts`:

- Self-contained module — imports nothing from the pipeline (`config.ts`,
  `helpers.ts`, etc.). Safe to run with no `.autopilot.yml`.
- Exports a small set of pure-ish functions for unit testing
  (`planSync`, `applyAction`, `runSync`).
- `bin/claude-autopilot.js` gains a `sync` route and a HELP entry alongside
  `init`, `run`, `stats`.
- Direct invocation works (`tsx scripts/autopilot/sync.ts`) for the bin
  shim and for local dev.

### File classification (planSync)

Walk the package's `.claude/skills/` directory. For each `<name>/SKILL.md`
discovered there, classify against the consumer:

| State | Outcome |
|---|---|
| Consumer file missing | `create` — silent, no prompt |
| Consumer file identical to package (byte-equal) | `identical` — silent, no prompt |
| Consumer file differs from package | `conflict` — show diff, prompt |

Skill directories present *only* in the consumer: ignored entirely (not
listed, not warned). They're consumer-authored and outside our remit.

### Prompt actions on conflict

Show a unified diff (via `createTwoFilesPatch` from the `diff` package) once,
then ask:

```
[o]verwrite, [s]kip, [m]erge (write .upstream sidecar), [q]uit?  (default: s)
```

- **overwrite** — replace consumer's `SKILL.md` with the package version.
- **skip** — leave consumer's `SKILL.md` untouched.
- **merge** — leave the consumer's `SKILL.md` in place; write the package
  version to `<file>.upstream` next to it for the user to manually reconcile
  with their editor / `git diff --no-index`. This honors "no auto-merge of
  conflicts" while still giving the user a side-by-side reference. A summary
  at the end lists every sidecar created.
- **quit** — abort the run; no further files processed. Already-applied
  changes stand (we don't roll back overwrites).

Default is `[s]kip` — the safest action when a user mashes Enter.

### Flag semantics

- `--dry-run` — compute and print the plan (`create`, `identical`, `conflict`
  counts and per-file lines). No prompts, no writes. Identical to init's
  dry-run discipline.
- `--force` — apply `overwrite` to every conflict; create missing files;
  skip identical. Still respects the allowlist (never touches `_rubric.md`,
  `_review-logic.md`, etc.). Required for CI.
- Mutually compatible: `--dry-run --force` reports what `--force` would do.
- TTY guard: if stdin is not a TTY and neither `--dry-run` nor `--force` is
  set, exit non-zero with a helpful error ("--force or --dry-run required when
  not running interactively"). Prevents hangs in piped contexts.

### Allowlist enforcement (defense in depth)

Three layers, all must agree before any write happens:

1. **planSync** only emits plans for files matching
   `<pkgSkillsRoot>/<name>/SKILL.md` where `<name>` is a directory entry whose
   name does not start with `_`.
2. **applyAction** asserts every destination path it writes ends in
   `/.claude/skills/<name>/SKILL.md` (or `.upstream` sidecar of same) and
   `<name>` does not start with `_`. Throws otherwise.
3. **--force** path goes through the same `applyAction` — no shortcut around
   the check.

A unit test confirms that even a hand-crafted plan pointing at
`.claude/skills/_rubric.md` is rejected by `applyAction`.

### Dependency: `diff`

Add `diff@^7` to `dependencies`. ~30 KB, zero subdeps, used widely (Jest,
Vitest, Prettier all transitively). Consumed via:

```ts
import { createTwoFilesPatch } from "diff";
```

We do NOT add `@types/diff` — `tsx` runs at runtime and our test suite uses
`node:test`. If a future TOOL adds `tsc --noEmit`, that's when types come in.
Note in CLAUDE.md follows existing convention.

### Prompt library: stdlib over `@clack/prompts`

Spec suggests `@clack/prompts` *or similar*. Choosing **`node:readline/promises`** instead:

- Pipeline currently has 3 prod deps total (`@anthropic-ai/claude-agent-sdk`,
  `tsx`, `yaml`). Rubric's "Concise" dimension favors not adding a UX library
  for a single y/n/m prompt loop.
- The interaction is one keystroke per file. `clack`'s strengths
  (multi-select, spinners) aren't useful here.
- Trivially mockable in tests by injecting a `prompter` function.

Tradeoff: no fancy ANSI rendering. Acceptable — diff display uses simple
inline ANSI green/red on `+`/`-` lines, gated on `process.stdout.isTTY`.

If a future skill needs richer prompts and pulls in `@clack/prompts`, we
revisit. Today, YAGNI.

## Files changed

| File | Change | Lines |
|---|---|---|
| `scripts/autopilot/sync.ts` | **new** — module + CLI entry | ~180 |
| `scripts/autopilot/__tests__/sync.test.ts` | **new** | ~150 |
| `bin/claude-autopilot.js` | add `sync` route to `routes` map; extend HELP | +2 |
| `package.json` | add `"diff": "^7"` to `dependencies` | +1 |
| `CLAUDE.md` | add `sync` row to the pipeline-steps table; one-line mention in "Running things" | +2 |

No schema changes. No i18n. No skill-body changes. No edits to existing
`scripts/autopilot/*.ts` files. No edits to skills.

## Module shape (sync.ts)

```ts
// Public API
export interface SyncOptions {
  pkgRoot: string;
  consumerRoot: string;
  force: boolean;
  dryRun: boolean;
  prompter?: Prompter;     // injected for tests
}

export type Action = "overwrite" | "skip" | "merge" | "quit";

// Discriminated union — exhaustive switches catch new states.
export type SyncPlan =
  | { kind: "create";    rel: string; src: string; dest: string }
  | { kind: "identical"; rel: string; src: string; dest: string }
  | { kind: "conflict";  rel: string; src: string; dest: string;
      consumerBody: string; packageBody: string };

export type Prompter = (plan: Extract<SyncPlan, { kind: "conflict" }>) => Promise<Action>;

export function planSync(pkgRoot: string, consumerRoot: string): SyncPlan[];
export function applyAction(plan: SyncPlan, action: Action): { wrote: string | null };
export function resolveConsumerRoot(cwd?: string): string;  // reuse pattern from init.ts
export async function runSync(opts: SyncOptions): Promise<SyncResult>;

interface SyncResult {
  created: number;
  overwritten: number;
  skipped: number;          // identical OR user chose skip
  merged: number;           // .upstream sidecars written
  conflicts: number;        // for dry-run reporting
  sidecars: string[];       // paths reported in summary
}
```

`resolveConsumerRoot` shares the same shell-out as `init.ts`. Lightly
duplicated (both files own ~5 lines) — pulling into a shared helper would
cross the "init is self-contained" boundary the rubric already establishes.
Two small twins are fine; if a third caller appears, refactor then.

## CLI changes (bin/claude-autopilot.js)

```js
const routes = {
  init:  ["scripts/autopilot/init.ts"],
  sync:  ["scripts/autopilot/sync.ts"],   // new
  run:   ["scripts/autopilot.ts"],
  stats: ["scripts/autopilot.ts", "stats"],
};
```

HELP block gets a `sync` line:

```
sync    Diff and update installed .claude/skills/<name>/SKILL.md against the package.
```

## Test strategy

`scripts/autopilot/__tests__/sync.test.ts` — `node:test` + `tsx --test`.
Mirrors the shape of `init.test.ts`.

### planSync
- Returns `create` for skill dirs missing in consumer.
- Returns `identical` when consumer file byte-matches package.
- Returns `conflict` when consumer file differs.
- Excludes `_rubric.md`, `_review-logic.md`, and any underscore-prefixed top-level entries.
- Ignores skill dirs present in consumer but absent in package (no plan emitted).

### applyAction
- `overwrite` writes package body to consumer dest.
- `skip` returns `{ wrote: null }`, no fs change.
- `merge` writes package body to `<dest>.upstream`, leaves dest untouched.
- `quit` is a no-op at the apply layer (handled by runSync's loop).
- **Allowlist guard**: synthesizing a plan whose `dest` ends in `_rubric.md` and calling `applyAction` with `overwrite` throws.

### runSync (integration)
- Empty consumer → all `create` plans applied; counters correct.
- `--dry-run` → no fs writes; counters report what would happen.
- `--force` → conflicts auto-overwritten without invoking prompter; sidecar count is 0.
- `--force` does NOT touch `_rubric.md` even if user has manually mangled it (test setup writes a sentinel into `_rubric.md`, runs sync, asserts sentinel survives).
- Prompter injection: stub returning `["overwrite", "skip", "merge"]` cycle through three pre-staged conflicts and asserts: 1 dest body changed, 1 unchanged, 1 sidecar written.
- Quit action stops processing remaining files (assert by giving 3 conflicts and a prompter that returns `quit` on the second).
- TTY guard: when stdin is not a TTY and neither flag is passed, `runSync` rejects (test passes a non-TTY-stdin proxy via opts).
- All-identical case → 0 conflicts, 0 prompts invoked.

### resolveConsumerRoot
- Same two cases init covers: nested-cwd resolves to repo root; non-git dir throws.

## Rubric self-check

- **Well-typed** — Discriminated union over plan kinds; `Action` is a literal union; `Prompter` is a typed function. No `any`. Exhaustive `switch (plan.kind)` in `applyAction`. Asserted by relying on TypeScript's `never` exhaustion if a new kind is added.
- **Well-tested** — Pure `planSync`/`applyAction` get direct unit tests. `runSync` gets integration tests via prompter injection — same pattern init uses for testability.
- **Well-factored** — New file. No edits to `pipeline.ts`, `step-runner.ts`, `helpers.ts`, `config.ts`. No SDK calls (sync is a static file operation). Allowlist enforcement is centralized in `applyAction`, not scattered across callers.
- **Idiomatic** — Imports `node:` builtins explicitly; relative imports use `.js` extension; no default exports; tabs + double quotes (Biome catches drift via lefthook). `for await` not needed (no async iteration); plain `for…of` over plans.
- **Correct** — Three-layer allowlist (planSync filter, applyAction assertion, --force routes through same path). TTY guard prevents hangs. Default action on Enter is `skip` (safe). Quit doesn't roll back already-applied changes — explicit and tested.
- **Concise** — ~180 LOC; one new dep (`diff`); reuses init's CLI shim pattern; no shared-helper extraction yet (init twin is 5 lines).

## Self-review revisions

Two changes from the first draft:

1. **Sidecar location.** Initially considered a hidden `.claude/skills/<name>/.upstream-SKILL.md`. Switched to `<file>.upstream` (visible) — convention from `dpkg`'s `.dpkg-new`, easier for users to spot. Visibility is the point: sidecars are pending work the user must address.
2. **Drop `[d]iff again` action.** First draft included it. Diff is shown once unconditionally before the prompt; re-displaying it adds a state-machine to a single-keystroke loop for no gain. Removed.

## Verification commands

```bash
npx tsx --test scripts/autopilot/__tests__/sync.test.ts        # new tests pass
npx tsx --test scripts/autopilot/__tests__/*.test.ts           # full suite green
npx tsx -e "import('./scripts/autopilot/sync.ts')"             # parse-check
node bin/claude-autopilot.js --help                            # sync appears in HELP
node bin/claude-autopilot.js sync --dry-run                    # smoke against this repo (consumer == package, all identical)
pnpm check                                                     # Biome clean
```

---

Run `/shakedown` for an independent review, or say **go** to start building. When done, run `/shakedown` again to review the code.
