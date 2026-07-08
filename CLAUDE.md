@AGENTS.md

## Claude Code

- Repo workflows are exposed as slash skills under `.claude/skills/`.
- Prefer the project skills (`/pick`, `/plan`, `/shakedown`, `/ship`, `/status`, `/tidy`, `/charter`) when the user asks for the corresponding autopilot workflow.
- Claude-specific skill frontmatter such as `allowed-tools`, `context: fork`, `agent`, `effort`, and `disable-model-invocation` is intentional. Keep shared workflow bodies provider-neutral where practical, but do not remove Claude metadata from the canonical `.claude/skills` tree.
- For large or path-specific context, read the routed docs listed in `AGENTS.md` instead of expanding this file.
