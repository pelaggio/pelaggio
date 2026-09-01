# Reconciled change verifier

`npx pelaggio verify <commit> [--bundle <dir>] [--json]` is the read-only path that checks a closed, content-addressed Case against a git subject. It is **not** a pipeline entry: `pnpm pelaggio verify` re-enters the cycle and is rejected as an unknown positional.

## Command

```bash
npx pelaggio verify <commit>            # discover `.dev/delivery-cases/by-tree/<result-tree>/`
npx pelaggio verify --bundle <dir>      # verify a transported cold packet
npx pelaggio verify <commit> --json
```

Exit codes: `0` only when overall is `ACCEPTED`; `1` for overall `WITHHOLD` or `REJECTED`; `2` for usage or missing config.

The screen reports four independent lines: overall, Case, authorization, and effect. A golden Case-complete packet that has not yet been human-authorized is Case `ACCEPTED`, authorization `AWAITING AUTHORIZATION`, effect `EFFECT UNPROVEN`, overall `WITHHOLD`.

## Trust limits

- Objects are content-addressed (`sha256(domain || 0x00 || canonical-bytes)`). Unknown schema versions and unknown fields fail closed.
- `dossier.md` and stored `verify.json` / `verify.txt` are regenerated projections, never evidence. A hand-edited green dossier is discarded.
- Unattached extra objects may produce a diagnostic; they cannot strengthen disposition.
- Identities are `local` / `shadow` / `harness`. No signature, PKI, or authentication claim is made.
- Policy/Human Decisions and landing Effects refer to a Case digest and are never admitted back into it.
- The Case subject is the **result tree**. A later squash/merge is provable only when that tree is byte-for-byte identical.

## Packet inspection

A transported packet contains the closed bundle (`roots.json`, `objects/sha256/`, `attachments/sha256/`), a regenerated dossier, verifier output, and the inspection command. It must not contain issue discussion, sessions, cycle/raw logs, the sealed mutation mapping, or expected answers.

Inspect with `npx pelaggio verify --bundle <dir>`.
