# Trust surface

This directory is Pelaggio's trust surface: what the orchestrator can touch, what leaves your machine, and the commands that prove every claim. It is generated from a single source of truth and is falsifiable — if the code stops matching a claim, the verifier fails.

## Contents

- [`overview.md`](./overview.md) — the trust posture in one page: five questions, five answers.
- [`threat-model.md`](./threat-model.md) — the defining threat (prompt injection via untrusted input) and how the boundaries answer it.
- [Architecture Decision Records](../decisions/) — the *why* behind each boundary, cross-linked to the claims they govern.
- [`trust-claims.yml`](./trust-claims.yml) — the claim registry and source of truth; every doc, manifest entry, and CI check is generated from it.
- [`pelaggio.trust.json`](./pelaggio.trust.json) — the machine-readable manifest of capabilities, egress, and hard *nevers*, with its [schema](./pelaggio.trust.schema.json).

Run the falsifiability gate with `pnpm check:trust` (or `node ci/verify-claims.mjs`): it executes each `guarantee` claim's evidence command and fails on regression.

The manifest is intended to also be served at `/.well-known/pelaggio.trust.json` so another agent can read our posture before running us; that endpoint is finalized in a follow-up issue.
