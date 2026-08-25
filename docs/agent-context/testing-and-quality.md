# Testing And Quality Context

## Tests

Run all tests:

```bash
pnpm test        # reaps leaked temp fixtures first, then pnpm -r test
```

Run one pelaggio test:

```bash
npx tsx --test packages/pelaggio/scripts/pelaggio/__tests__/<file>.test.ts
```

The project uses `node:test`. Do not add Jest or Vitest.

### Temp fixtures (#579)

Tests must create temp dirs through `makeTestTmpDir(prefix)` in
`packages/pelaggio/scripts/pelaggio/__tests__/tmp-fixture.ts`, never raw
`mkdtempSync(join(tmpdir(), ...))`. The helper parks fixtures under a per-uid root
`<tmpdir>/pelaggio-test-fixtures-<uid>/` (created mode 0700, refusing a symlink or a
foreign-owned dir planted at that path) and removes them on process exit; a full run of
hand-rolled fixtures leaked ~25k tmpfs inodes and exhausted /tmp while `df -h`
looked healthy. The `ci/__tests__/reap-test-tmp.test.ts` reaper suite cannot yet import
the helper (a deferred cross-package shared-location decision) and keeps raw `mkdtemp`
with an inline exemption comment; `packages/server/__tests__/*` remain deferred (they do
not use the helper yet, no exemption comment added).

`ci/reap-test-tmp.ts` (`pnpm test:reap`) sweeps survivors of a hard kill. Because it
*recursively deletes*, it recognizes a dir to remove by an invariant it carries — a
valid helper marker plus a PID sidecar — never by an incidental name or containment alone
(the recognize-by-construction principle in `guarded-actions.md`):

- a predictable fixture-root name is only a pre-filter; the root must be a real same-UID
  directory carrying a valid `.pelaggio-test-fixture` marker before it is traversed;
- a contained fixture is default-reapable only when its own `.owners/<basename>` sidecar
  contains a valid PID; missing, malformed, unreadable, symlinked, or foreign-owned owner
  evidence is preserved rather than falling through to age-based deletion;
- any owned, mkdtemp-shaped top-level dir carrying a valid marker and PID is ours;
- **unmarked** dirs carry no trustworthy provenance or liveness record, even when their
  names use this repo's prefixes. The reaper never deletes them by name alone and rejects
  the unsafe legacy-prefix mode.

It reconciles against **liveness, not staleness**: the helper records the creating
process's PID (marker / `.owners/<basename>` sidecar) and the reaper SKIPS any fixture
whose owner PID is still alive (`process.kill(pid,0)`), regardless of age — a concurrent
suite's old working dir is in-use, not a leak. The helper treats sidecar persistence as
part of fixture creation: if the write fails, it rolls back the directory and throws.
Every deletion also requires a real directory, owned by the current uid, older than the
threshold (default 60 min); a
`chmod 0000` descendant is recovered with a best-effort chmod-then-retry so it can't
strand inodes forever.

Reap mode is fail-open on filesystem errors; CLI validation is separate. A value flag
(`--base`/`--max-age-minutes`/`--max-leaked`) present with a missing, flag-shaped, or
non-numeric value exits 2 (a typo'd `--base` never falls back to a /tmp-root sweep). The
opt-in `--check [--max-leaked N]` leak guard fails *closed* — a bad threshold, an
untrustworthy/unreadable fixture root, or a base it cannot scan is a non-zero exit, never a
silent green — and it counts only the default-reap set (containment + marked), ignoring
younger, live-PID, and unmarked fixtures so it does not false-fire while suites run.

Not wired into CI: `.github/workflows/ci.yml` runs `pnpm -r test` / `pnpm test:ci`
directly, not the root `pnpm test` that chains the reaper, so the pre-test sweep and
`--check` do not run in CI — CI relies on each test process's exit-hook cleanup. Flipping
`--check` on in CI is deferred to the #579 follow-up migration sweep.

## Checks

```bash
pnpm check
pnpm check:skills
pnpm check:publish
```

`pnpm check:skills` (`check-skills.ts`) validates, across `.claude/skills/**/SKILL.md` and `.claude-templates/**`:

- skill frontmatter shape (`frontmatter.*`) and `argument-hint` presence (`arguments.no-hint`);
- skill includes resolve, treating a `2>/dev/null` suffix as "dangling is fine" (`include.dangling`);
- no bare `pelaggio` npx calls or `pnpm pelaggio <subcommand>` (`skill.npx-bare-pelaggio`, `skill.pnpm-pelaggio-subcommand`);
- no pinned Claude model IDs (`model-id.hardcoded`);
- the bilingual agent context substrate — `AGENTS.md`/`CLAUDE.md`/`docs/agent-context/`/`.agents/skills` (`agent-context.*`).

`pnpm check:publish` (`check-publish.ts`) forbids install-script hooks and runs a dry-run pack + secret scan (see `architecture.md`).

## Lint And Format

Biome is scoped via one root `biome.json` (`includes: ["packages/*/scripts/**/*.ts", "scripts/**/*.ts"]`); skill/template markdown is not linted. `pnpm check` lints, `pnpm format` auto-fixes. A lefthook `pre-commit` hook auto-formats staged TypeScript and re-stages it (installed by the `prepare` script on `pnpm install`); pelaggio checkpoint commits bypass it via `--no-verify` in `helpers.ts`.

## Review Rubric

Use `.claude/skills/_rubric.md` for detailed review criteria. In short, changes should be:

- correct
- well-typed
- well-factored
- well-tested
- concise
- idiomatic for this repo

Two review passes with deliberately different context shapes: `/plan`'s self-review is **in-context** (same session that wrote the plan — strongest at project invariants like step exhaustiveness and the phantom-ship guard) and `/shakedown`'s forked review is **out-of-context** (fresh session reading the artifact cold — strongest at convention drift and cleverness-over-simplicity). Don't fold shakedown into plan to save a cycle; the context-shape difference is the point.
