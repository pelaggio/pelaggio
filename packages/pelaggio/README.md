# Pelaggio

The published Pelaggio pipeline. See the [repo root README](../../README.md) for usage; this package directory holds the runtime entry points (`scripts/pelaggio.ts`, `bin/pelaggio.js`) and the pipeline modules under `scripts/pelaggio/`.

Skills (`.claude/skills/`) and consumer templates (`.claude-templates/`) live at the monorepo root for dogfooding, and are copied into this package by the `prepack` lifecycle script before publishing.
