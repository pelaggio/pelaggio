# @cdhorne/claude-autopilot

The published autopilot pipeline. See the [repo root README](../../README.md) for usage; this package directory holds the runtime entry points (`scripts/autopilot.ts`, `bin/claude-autopilot.js`) and the pipeline modules under `scripts/autopilot/`.

Skills (`.claude/skills/`) and consumer templates (`.claude-templates/`) live at the monorepo root for dogfooding, and are copied into this package by the `prepack` lifecycle script before publishing.
