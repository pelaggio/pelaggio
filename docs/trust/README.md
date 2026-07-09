# Trust surface

This directory is Pelaggio's trust surface: what the orchestrator can touch, what leaves your machine, and the commands that prove every claim. It is generated from a single source of truth and is falsifiable — if the code stops matching a claim, the verifier fails.

## Contents

- [`overview.md`](./overview.md) — the trust posture in one page: five questions, five answers.
- [`threat-model.md`](./threat-model.md) — the defining threat (prompt injection via untrusted input) and how the boundaries answer it.
- [Architecture Decision Records](../decisions/) — the *why* behind each boundary, cross-linked to the claims they govern.
- [`trust-claims.yml`](./trust-claims.yml) — the claim registry and source of truth; every doc, manifest entry, and CI check is generated from it.
- [`pelaggio.trust.json`](./pelaggio.trust.json) — the machine-readable manifest of capabilities, egress, and hard *nevers*, with its [schema](./pelaggio.trust.schema.json).

Regenerate the machine manifest with `pnpm trust:generate`. The checked-in JSON must match the projection from `trust-claims.yml`; `pnpm check:trust` fails on drift and prints `run pnpm trust:generate`.

Run the falsifiability gate with `pnpm check:trust`: it validates the registry and schema, runs every `guarantee` claim's local evidence command, and fails on missing, placeholder-like, or failing guarantee evidence. `last_verified` must be present and well-formed; dates older than 180 days are reported as warnings because CI re-runs the evidence live.

The control-plane daemon serves the checked-in generated manifest publicly at `/.well-known/pelaggio.trust.json`, before bearer auth. Override the file path with `AUTOPILOT_SERVER_TRUST_MANIFEST` when serving a packaged or relocated copy.
