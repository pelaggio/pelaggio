# TOOL-52 — Worktree pnpm install corrupts main `node_modules` symlinks

## Problem

After a TOOL-51 cycle on 2026-04-25, `git worktree remove` left the main repo's
`node_modules` with six dangling top-level symlinks pointing at the now-deleted
worktree's `.pnpm` store:

```
node_modules/tsx -> ../../claude-autopilot-tool-51/node_modules/.pnpm/tsx@…
node_modules/typescript -> …/claude-autopilot-tool-51/node_modules/.pnpm/typescript@…
node_modules/lefthook -> …
node_modules/@biomejs/biome -> …
node_modules/@anthropic-ai/claude-code -> …
node_modules/@cdhorne/claude-autopilot -> …
```

Two root-level smoke tests (`check-roadmap CLI smoke test`,
`runCli integration` in `roadmap-graph.test.ts`) failed with
`ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'` until `pnpm install`
repaired the layout.

The corruption mechanism: at some point in the cycle, `pnpm install` ran
inside the worktree while `<worktree>/node_modules` was still a symlink to
`<MAIN_REPO>/node_modules`. pnpm rewrote the top-level package symlinks
inside MAIN's `node_modules/` so they pointed into a worktree-local `.pnpm`
store. The symlinks survived `git worktree remove` (they live under MAIN),
but their targets vanished with the worktree.

The trigger isn't fully nailed down. Candidates:
- The mid-cycle `ensureWorktreeDeps()` guard hitting the `reinstall` branch
  (lockfiles drift would be required, which is rare but possible).
- An SDK tool call running `pnpm install` from inside the worktree as part
  of agentic work in `implement` / `shakedown-code` / `ship`.
- A `pnpm <other-cmd>` invocation that internally normalises layout
  (`pnpm test`, `pnpm dlx`, etc.) — pnpm has been known to "auto-fix"
  drift it observes.

## Scope

- **Detect & repair main's `node_modules` corruption at ship time** — the
  durable boundary where the consequence (worktree removal) creates user
  pain.
- **Surface the symptom mid-cycle** — when `worktree-deps` finds the
  worktree's `node_modules` is now a real directory containing its own
  `.pnpm` store, log a clear warning so the corruption is traceable to a
  step in the cycle log.
- **Test coverage** for the new detection + repair helpers.

**Out of scope** (consistent with the charter):
- Reworking TOOL-26's "share `node_modules`" approach. Symlinking is
  correct; we're hardening its blast radius.
- Migrating off pnpm.
- Workspace sub-package `node_modules` (`packages/*/node_modules`). The
  observed corruption is exclusively at root level — both because pnpm
  hoists root devDependencies there and because the symlink we create
  is `<worktree>/node_modules → <MAIN_REPO>/node_modules`, not the
  per-package ones (which pnpm manages itself).
- Preventing pnpm from running inside the worktree. Too many entry
  points (SDK Bash calls, agentic flows). Detection + repair at the
  cleanup boundary is the robust point.

## Approach (and why this over alternatives)

**Why ship-time detection + repair, not prevention.**

The deliverable in the charter offers two framings: (a) post-creation
verification + abort if subsequently replaced, (b) detect at ship-time
that the worktree's `node_modules` became a real directory and refuse
to ship until reconciled. Option (a) requires either a continuous
filesystem watcher or a pre-tool-use hook on every `pnpm` Bash call
(brittle: the corruption can come from indirect pnpm invocations like
`pnpm test`'s lifecycle). Option (b) is the right model but on its
own it's just "abort", not "fix".

The minimal, robust shape is:

1. **Scan** `<MAIN_REPO>/node_modules/` (top-level + `@scope/*`) for
   symlinks whose resolved absolute target lies outside
   `<MAIN_REPO>`. That set is the corruption signature.
2. **Repair** by running `pnpm install --frozen-lockfile` in
   `<MAIN_REPO>` once corruption is detected. pnpm's installer
   reconciles the layout from the lockfile; this is exactly what
   the user did manually to recover.
3. **Run the repair from `/ship` step 9** before
   `git worktree remove`. Idempotent: when there's no corruption,
   it's a sub-100ms scan and a no-op return.

**Why scan top-level only.**

The corruption entries the charter cites are all root devDependencies
(`tsx`, `typescript`, `lefthook`, `@biomejs/biome`, `@anthropic-ai/claude-code`,
`@cdhorne/claude-autopilot`). The shared-`node_modules` symlink is
`<worktree>/node_modules → <MAIN_REPO>/node_modules` — a root-level
swap. Per-package `node_modules` are managed independently by pnpm
and weren't observed to corrupt. Restricting the scan keeps the
helper fast and the false-positive surface small (we don't have to
classify every `.pnpm` internal symlink).

**Why not also abort the cycle when corruption is detected.**

Aborting `/ship` mid-cycle leaves the user with a half-merged branch
and a warning to read. Auto-repair, then continue, gets us back to
green with a one-line diagnostic in the cycle log. The post-merge
verification (skill step 5) has already passed, and `pnpm install` is
exactly the recovery step the user would run manually.

**Why a mid-cycle warning, not mid-cycle repair.**

Repairing main's `node_modules` mid-cycle competes with whatever the
running step is doing (it could be `pnpm test`-ing in the worktree
using main's `.pnpm` store). The cleanup boundary is the only point
where we know no in-flight pnpm process needs the current layout.
A warning is enough to get the corruption attributed to a specific
step when post-mortem analysis is needed.

## Files to change

| File | Change |
|------|--------|
| `packages/autopilot/scripts/autopilot/worktree-deps.ts` | Add `findOutboundMainSymlinks(mainRepo)` + `repairMainNodeModules(mainRepo)` exports. Extend the direct-invocation block to dispatch `--repair-main` (and `--check-main` as a no-side-effect peek for testing/diagnostics). |
| `packages/autopilot/scripts/autopilot/__tests__/worktree-deps.test.ts` | New `describe("findOutboundMainSymlinks", …)` and `describe("repairMainNodeModules", …)` blocks covering: clean main → empty list; outbound-symlink fixture (pointing into a sibling-worktree path) → reports the entry; `@scope/*` entry detection; ignored entries (`.pnpm`, `.bin`, `.modules.yaml`); repair invokes `pnpm install --frozen-lockfile` (mocked via dependency injection or via a `runner` parameter so the test never spawns a real pnpm). |
| `.claude/skills/ship/SKILL.md` | In step 9 ("Clean up"), under the "If in worktree:" branch, insert a `npx @cdhorne/claude-autopilot worktree-deps --repair-main` line **before** `git worktree remove`. Brief inline comment ("repair MAIN's `node_modules` if a worktree-side `pnpm install` re-pointed any top-level symlinks — TOOL-52"). |
| `packages/autopilot/scripts/autopilot/step-runner.ts` | Capture the return of the existing `ensureWorktreeDeps()` call in the mid-cycle guard. If `action.type === "noop"` *and* `<worktree>/node_modules` is a real (non-symlink) directory *and* `<worktree>/node_modules/.pnpm/` exists, emit `{ type: "sdk_error", message: "worktree node_modules became a real directory mid-cycle (pnpm install re-installed locally); main repo will be repaired at ship time" }`. Single warning, doesn't block. **Why all three conditions:** `noop` alone fires for both "symlink-to-main correct" (case a) and "real-dir worktree-nm" (case b); only case b is the corruption signature. Adding the explicit `isRealDir(worktreeNm) && !isSymlink(worktreeNm)` check disambiguates — without it, `lstatSync(<worktree>/node_modules/.pnpm)` traverses through the live symlink in case a and resolves to `<MAIN>/node_modules/.pnpm/` (which is real), false-positiving on every successful step. The `noop` gate also excludes the `install`/`reinstall` branches, where pnpm legitimately just created a real dir with `.pnpm/`. |

That's the entire surface. Four files, ~80 LOC of code, ~120 LOC of test.

## Detection algorithm — detail

Imports to add to `worktree-deps.ts`: `readdirSync` to the `node:fs` named imports;
`dirname, relative, sep` to `node:path`.

```ts
// Returns { name: <relative-to-node_modules>, target: <readlink string>, resolvedAbsolute: <abs path> }[]
export function findOutboundMainSymlinks(mainRepo: string): OutboundSymlink[] {
  const repoRoot = resolve(mainRepo);
  const nm = join(repoRoot, "node_modules");
  if (!isRealDir(nm)) return []; // no node_modules → nothing to corrupt
  const out: OutboundSymlink[] = [];
  scanDir(nm, /* depth */ 0);
  return out;

  function scanDir(dir: string, depth: number): void {
    for (const entry of readdirSync(dir)) {
      // Skip pnpm's internals at any level — `.pnpm`, `.bin`, `.modules.yaml`.
      if (entry.startsWith(".")) continue;
      const p = join(dir, entry);
      let stat;
      try { stat = lstatSync(p); } catch { continue; }
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(p);
        const abs = resolve(dirname(p), target);
        // Boundary is `<mainRepo>` — *not* `<mainRepo>/node_modules`. Workspace
        // package symlinks (e.g. `@cdhorne/claude-autopilot → ../../packages/autopilot`)
        // resolve outside `node_modules/` but still inside the repo root. Those
        // are legitimate; flag only links that escape the repo entirely.
        const repoPrefix = repoRoot + sep;
        if (!abs.startsWith(repoPrefix) && abs !== repoRoot) {
          out.push({ name: relative(nm, p), target, resolvedAbsolute: abs });
        }
      } else if (stat.isDirectory() && entry.startsWith("@") && depth === 0) {
        // Recurse exactly one level into `@scope/` dirs. Depth-limit prevents
        // walking the entire pnpm virtual store.
        scanDir(p, depth + 1);
      }
    }
  }
}
```

Key invariants:
- Skip `.pnpm`, `.bin`, `.modules.yaml`, and any other `.`-prefixed
  pnpm internal — those are allowed to be symlinks with non-MAIN
  targets (the `.pnpm` store itself is just a real dir, but `.bin/*`
  symlinks point into it; we don't audit those).
- Boundary is the **repo root**, not the `node_modules/` directory.
  Pnpm represents workspace packages as symlinks inside `node_modules/`
  whose targets sit at `<repo>/packages/<pkg>` (i.e. *outside*
  `node_modules/` but *inside* the repo). Those are the canonical
  layout, not corruption. Only links that resolve outside the repo
  itself indicate the TOOL-52 signature.
- Recurse exactly one level into `@scope/*` directories (not deeper)
  — that's where scoped packages live. Anything deeper is pnpm's
  internal layout.
- Treat dangling symlinks as outbound: they were valid at write time
  and pointed somewhere; if we can't resolve them now and they're
  outside the repo, they're corruption regardless.
- An `EACCES` / `ENOENT` from `lstatSync` on a child entry shouldn't
  abort the scan — `try/catch` and continue.

## Repair flow — detail

```ts
export function repairMainNodeModules(mainRepo: string, runner: { run: (cmd: string, cwd: string) => void } = defaultRunner): RepairReport {
  const outbound = findOutboundMainSymlinks(mainRepo);
  if (outbound.length === 0) return { ranInstall: false, repaired: [] };
  // pnpm install --frozen-lockfile is the standard recovery — same lockfile,
  // re-stitch the layout. Stdio inherited so the user sees pnpm's progress.
  runner.run("pnpm install --frozen-lockfile", mainRepo);
  return { ranInstall: true, repaired: outbound };
}
```

The `runner` parameter is the test seam — production code passes the
default that spawns `pnpm`; tests pass a mock that records the call.
This keeps the test from needing pnpm in the harness or constructing
a real workspace.

The `defaultRunner` is a one-liner that mirrors the shape used elsewhere
in this module:

```ts
const defaultRunner = { run: (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: "inherit" }) };
```

## CLI surface

`npx @cdhorne/claude-autopilot worktree-deps --repair-main` →
runs `repairMainNodeModules(REPO)` and prints:

- `clean: no outbound symlinks found in <main>/node_modules` (exit 0), or
- `corruption detected: <N> outbound symlinks` then one line per entry,
  then runs `pnpm install --frozen-lockfile`, then `repaired` (exit 0).

`npx @cdhorne/claude-autopilot worktree-deps --check-main` →
no-side-effect variant for diagnostics. Prints the corrupt entries
and exits 0 (clean) or 1 (corrupt). Used by tests and for
`/shipwreck` follow-up if we ever want to surface this state without
auto-repairing.

The existing `npx @cdhorne/claude-autopilot worktree-deps <worktree>`
positional invocation continues to work — the new flags are only
recognised when the first non-bin arg is `--repair-main` or `--check-main`.

## Skill change — detail

In `.claude/skills/ship/SKILL.md`, step 9, the "If in worktree" block
becomes:

````md
**If in worktree**:
```bash
# TOOL-52: repair MAIN's node_modules if any top-level symlinks
# got re-pointed into the worktree's .pnpm store mid-cycle.
npx @cdhorne/claude-autopilot worktree-deps --repair-main
git worktree remove "$WORKTREE" --force
git branch -d "$BRANCH"
git push origin --delete "$BRANCH" 2>/dev/null
```
````

The fallback "if `git worktree remove` fails because of files the
consuming project left behind" guidance stays unchanged.

The `allowed-tools` list at the top of the skill already covers
`Bash(npx:*)` (TOOL-29), so no frontmatter edit is required.

## Test strategy

`worktree-deps.test.ts` gains three new describe blocks:

```ts
describe("findOutboundMainSymlinks", () => {
  it("returns empty list when main/node_modules is absent");
  it("returns empty list when only inbound symlinks exist (relative to node_modules)");
  it("returns empty list when a symlink resolves to a workspace package inside the repo (e.g. <repo>/packages/<pkg>)");
  it("ignores .pnpm, .bin, .modules.yaml dotfiles");
  it("detects a top-level symlink pointing into a sibling worktree's .pnpm store");
  it("detects an @scope/pkg symlink pointing into a sibling worktree's .pnpm store");
  it("does not recurse beyond @scope/* one level deep");
  it("treats a dangling outbound symlink (target deleted) as outbound");
});

describe("repairMainNodeModules", () => {
  it("returns { ranInstall: false, repaired: [] } when main is clean");
  it("invokes the runner with `pnpm install --frozen-lockfile` and the main repo cwd when corruption is detected");
  it("reports the outbound entries it observed in the repaired list");
});

describe("worktree-deps --repair-main CLI", () => {
  // Optional, depending on how many of these we already exercise via direct exports.
  // Skip if too thin — direct-export tests already cover the logic.
});
```

The fixtures use the existing `makeSetup` helper, extended with a
`mainNm` mode that lays out a real `node_modules/` containing both
inbound symlinks (e.g. `tsx -> ../.pnpm/...`) and the corruption
shape (e.g. `tsx -> ../../sibling-worktree/node_modules/.pnpm/...`).

The repair test injects a mock runner:
```ts
const calls: Array<{ cmd: string; cwd: string }> = [];
const runner = { run: (cmd, cwd) => calls.push({ cmd, cwd }) };
const report = repairMainNodeModules(main, runner);
assert.deepEqual(calls, [{ cmd: "pnpm install --frozen-lockfile", cwd: main }]);
```

No real `pnpm` invocation happens in tests.

## Rubric self-check

**Correct**
- ✅ Pipeline invariants preserved: doesn't modify worktree isolation,
  plan-polish guard, `parkExit()`, phantom-ship guard, frontmatter
  stripping, ship target dispatch, MODEL_PROFILES, STEPS exhaustiveness.
- ✅ `STEPS` / `BUDGETS` / `TURN_LIMITS` / `EFFORT` / `MODEL_PROFILES`
  unchanged — no new step.
- ✅ Skill body change is minimal (one inline comment + one bash line)
  and doesn't touch the existing post-merge/post-mark-done flow.
- ✅ The `step-runner` mid-cycle warning emits via the existing
  `sdk_error` event channel (no new event type), so TUI rendering
  and JSONL log fields stay backward-compatible.

**Well-typed**
- ✅ New exports declare explicit types: `OutboundSymlink`, `RepairReport`,
  `Runner`. No `any`s.
- ✅ The `runner` injection is typed as `{ run: (cmd: string, cwd: string) => void }`
  — explicit and minimal, no over-reach into `child_process.SpawnOptions`.

**Well-factored**
- ✅ Logic lives in `worktree-deps.ts` — same module that owns the
  symlink semantics on the create side. One file owns the
  shared-`node_modules` lifecycle end-to-end.
- ✅ The skill body delegates to the bin (consistent with the
  established adapter pattern: skills shell out to `npx @cdhorne/claude-autopilot …`,
  TS owns the logic).
- ✅ The `runner` seam is the only injection added — keeps the
  default flow indistinguishable from the existing
  `execSync("pnpm install --frozen-lockfile --silent", …)` call shape.

**Well-tested**
- ✅ Unit tests for both pure functions and the CLI dispatch.
- ✅ Outbound-symlink detection is the core invariant; all edge cases
  (`@scope`, `.pnpm`, dangling, missing main `node_modules`) are
  covered in fixtures.
- ✅ Repair test verifies the exact pnpm command + cwd via injected
  runner — no shell-out in tests.

**Concise**
- ✅ ~80 LOC of new TS + ~120 LOC of new tests + 2-line skill diff.
  No new dependencies, no new config keys, no new event types.
- ✅ No extension points left for hypothetical future requirements
  (e.g. user-configurable allowlist of outbound paths). If a future
  consumer legitimately needs cross-repo symlinks under
  `<MAIN_REPO>/node_modules`, they can extend then.

(Idioms is deferred to `/shakedown` per the in-context vs. out-of-context
review split.)

## Open question (reviewer's call)

The current `decideDepsAction` returns `noop` when `<worktree>/node_modules`
is a real directory ("user-managed, left alone"). Under TOOL-52's
corruption signature, that real directory is *not* user-managed —
it's pnpm having replaced our symlink. We could distinguish "pnpm
made this real" from "user made this real" by checking for
`<worktree>/node_modules/.pnpm/` (pnpm-managed real dir) versus the
absence of `.pnpm/` (manual `mkdir node_modules`, vanishingly rare).

This plan opts for **warn at the worktree, repair at main**, not
"flip the worktree real dir back to a symlink mid-cycle". The
worktree's local node_modules is going to be deleted by `git worktree
remove` anyway; the only state worth preserving is main's. If a
follow-up cycle observes the same corruption pattern recurring in
practice, that's the moment to revisit and consider adding an
"unlink + reinstall" branch to `decideDepsAction` that triggers when
`<worktree>/node_modules/.pnpm/` is real and lockfiles match.
