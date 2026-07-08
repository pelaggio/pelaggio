# Skills Context

## Canonical Tree

`.claude/skills/` is currently canonical because package publishing and sync copy from that path. It lives at the repo root for dogfooding (`REPO` from `git rev-parse --show-toplevel` is the workspace root) and is copied into `packages/autopilot/.claude/skills/` by `prepack` so the published tarball includes it (see `architecture.md`).

`.agents/skills` exposes the same tree to Codex as a symlink to `../.claude/skills`. Keep it a symlink (single-sourced, can't drift) until packaging is deliberately migrated to a neutral source tree; `check-skills` enforces that it exists, is a symlink, and points at the canonical tree.

## Bilingual Agent Substrate

- `AGENTS.md` is the portable root instruction file for Codex, Cursor, Windsurf, Devin, and other agents that follow the convention.
- `CLAUDE.md` imports `AGENTS.md` (via `@AGENTS.md`) and contains only Claude Code-specific notes.
- `.claude/skills` remains the canonical skill source for publishing until the packaging scripts are deliberately migrated.
- Provider-neutral instructions belong in shared skill bodies or `docs/agent-context/`. Provider-specific client behavior belongs in thin provider sections, not duplicated whole workflows.

When adapting skills for Codex: keep workflow instructions provider-neutral where possible; avoid duplicating whole skills per provider; put provider-specific execution details in small sections or wrappers; preserve Claude Code metadata while `.claude/skills` remains canonical; keep `.agents/skills` pointed at the canonical tree.

## Skill List

- `pick`: select and claim a work item.
- `plan`: write and publish an implementation plan.
- `shakedown`: review plans or code and fix issues.
- `charter`: create a new work item.
- `ship`: finalize, push, and clean up completed work.
- `shipwreck`: recover a failed direct-push ship attempt.
- `pickup`: rebuild context for in-progress work.
- `status`: show current branch, plan, and progress.
- `tidy`: prune stale worktrees and clean roadmap state.
- `bump-models`: refresh Claude model IDs in config.
- `pr-review`: fresh-session CI merge-gate review.

`sync` (`npx @cdhorne/claude-autopilot sync`) diffs installed skills against the package and prompts overwrite/skip/merge per file. It is a consumer CLI, not a pipeline step.

## Frontmatter

Claude-specific fields are allowed in `.claude/skills`: `allowed-tools`, `argument-hint`, `context`, `agent`, `effort`, `disable-model-invocation`, `consumer`.

- The pipeline strips frontmatter with `expandSkill()` before sending skill bodies to the model. Frontmatter exists for inline client usage (a human typing `/shakedown`) and local linting; do not rely on it inside pipeline prompts.
- `context: fork` is only meaningful inline — the SDK `query()` call already spawns an isolated session, so it is redundant for pipeline use.

## Includes

Skill bodies can include shared rubric/context with shell includes:

```md
!`cat .claude/skills/_rubric.md`
!`cat .claude/skills/_project-context.md 2>/dev/null`
```

`_project-context.md` is the **consumer-side extension point** for the three review skills (`plan`, `shakedown`, `ship`). They read it opt-in, so it is deliberately absent from this repo — autopilot itself is the generic baseline, and exercising the fallback keeps the graceful include honest. Upstream `sync` never touches it (underscore-prefix skip in `planSync()` + the `ALLOWED_DEST` regex in `applyAction()`); consumers copy `_project-context.md.example` to start. `check-skills` treats the `2>/dev/null` suffix as "dangling is fine" via the second capture group on `INCLUDE_RE` (`include.dangling`).
