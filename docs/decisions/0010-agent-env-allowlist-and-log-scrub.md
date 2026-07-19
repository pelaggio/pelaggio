---
title: "ADR-0010: Deny-by-default env allowlist for driver subprocesses + secret-scrubbed logs"
status: accepted
date: 2026-07-18
claims: [TC-014]
---

# ADR-0010 — Agent env allowlist and log scrubbing

## Context
Pelaggio spawns driver CLIs (codex today; grok next, via the ACP client) to do work influenced by untrusted repo/issue/PR text (`ADR-0002`, TC-015). Until now those children inherited the full parent `process.env`, and no log stream was redacted. A prompt-injected step could therefore `echo $SOME_SECRET` and exfiltrate every credential in the environment, and any secret the model (or a driver) printed would land verbatim in the verbose `.dev/*.log` transcript. TC-014 already advertised the opposite ("child processes get only the secrets they need, and logs are scrubbed") — so the claim was aspirational, not true. This is the cheapest high-value fix on the launch path and a hard prerequisite for running Grok unattended (grok's `--debug-file` even writes its OAuth JWT in cleartext).

The complete fix — credentials held entirely outside the agent process via a broker — is designed separately (#176) and is larger. This ADR records the pragmatic env-hygiene + log-scrub subset that makes the *advertised* TC-014 claim honest.

## Decision
1. **Deny-by-default env allowlist.** Build each driver subprocess's environment from an explicit allowlist (`buildAgentEnv` in `secret-hygiene.ts`) — `PATH`, `HOME`, locale/cert vars, plus any names an operator adds via `security.env-allowlist` (e.g. a driver's auth var for key auth) — rather than inheriting `process.env`. Subscription auth keeps working because codex/grok read tokens from files under `HOME`. Centralized so every spawn site goes through one helper.
2. **Redact-before-write log scrubbing.** A scrubber (`scrubSecrets` / `makeSecretScrubber`) redacts credential-shaped strings (JWT, provider API keys, bearer/PAT tokens) and the literal values of secret-named parent env vars, applied at the driver's captured stderr and at the verbose file-transcript sink (`tui.ts`) — the chokepoint where raw agent stdout is written to disk.

## Alternatives not taken
- **`env -i` at the shell / per-call allowlists.** Not centralized, easy to drift, and does not address log capture.
- **Scrub after write (post-process the log file).** Loses the window between write and scrub; a crash leaves the secret on disk. Redact-before-write is the only honest ordering.
- **Wait for the #176 broker.** Correct long-term, but ships nothing for launch; env hygiene + scrub is independently valuable defense-in-depth.
- **Allow-all env minus a denylist.** Fails open on any new secret var; deny-by-default fails closed.

## Consequences
- (+) TC-014 flips `planned → guarantee`, verified by `secret-hygiene.test.ts` (a sentinel secret is absent from the child env; a planted value is redacted from captured logs).
- (+) Hardens the existing Codex path immediately and gives the Grok provider (#136) a ready-made allowlisted-env + scrub seam.
- (−) Scrubbing is pattern- and known-value-based: a novel credential format that matches no pattern and is not a secret-named env value can still slip. Documented in the claim's `known_limits`.
- (−) The allowlist covers driver subprocesses only; pelaggio's own `git`/`gh` helper commands still use the repo env by design.
