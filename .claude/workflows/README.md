# `.claude/workflows/` — dev-only orchestration

Reusable Claude Code [Workflow](https://claude.com/claude-code) scripts for developing **pelaggio itself** — e.g. running an adversarial review triad over a design change. They are *meta-tooling*, not product code, and are **not published** to the `pelaggio` package: unlike `.claude/skills/`, this directory is absent from the package `files` allowlist, `pack-prepare`'s `PACK_TARGETS`, and `check-publish`'s `ALLOWED_PREFIXES`, so `check:publish` will flag it if that ever changes.

Invoke a saved workflow by name:

```
Workflow({ name: 'triad-review', args: { title, artifact, grounding, lenses } })
```

## Workflows

- **`triad-review.js`** — 3 diverse-lens reviewers + a Judge, with a **retry-on-stub guard**: if a reviewer seat returns schema-valid but degenerate output (a placeholder such as `overall: "test"`), it is detected and re-run before it can silently weaken the panel. Defaults to fidelity / reuse-grounding / adversarial lenses; override via `args.lenses`.
