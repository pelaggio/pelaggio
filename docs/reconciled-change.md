# Reconciled change verifier

`npx pelaggio verify <commit> [--bundle <dir>] [--json]` is the read-only path that checks a closed, content-addressed Case against a git subject. It is **not** a pipeline entry: `pnpm pelaggio verify` re-enters the cycle and is rejected as an unknown positional.

## Command

```bash
npx pelaggio verify <commit>            # discover `.dev/delivery-cases/by-tree/<result-tree>/`
npx pelaggio verify --bundle <dir>      # verify a transported cold packet
npx pelaggio verify <commit> --json
```

Exit codes: `0` only when overall is `ACCEPTED`; `1` for overall `WITHHOLD` or `REJECTED`; `2` for usage or missing config.

The screen reports four independent lines: overall, Case, authorization, and effect. A golden Case-complete packet includes a Policy Decision but no Human Decision or landing Effect: Case `ACCEPTED`, authorization `AWAITING AUTHORIZATION`, effect `EFFECT UNPROVEN`, overall `WITHHOLD`.

## Trust limits

- Objects are content-addressed (`sha256(domain || 0x00 || canonical-bytes)`). Unknown schema versions and unknown fields fail closed.
- A Case must close non-empty `intent`, `subject-result-tree`, `subject-config-binding`, `scope`, `governing-context`, `acceptance`, and `review-findings` obligations with admitted records of the matching role. Missing, empty, unadmitted, or role-mismatched evidence withholds the Case.
- `dossier.md` and stored `verify.json` / `verify.txt` are regenerated projections, never evidence. A hand-edited green dossier is discarded.
- Unattached extra objects may produce a diagnostic; they cannot strengthen disposition.
- Identities are `local` / `shadow` / `harness`. No signature, PKI, or authentication claim is made.
- Policy/Human Decisions and landing Effects refer to a Case digest and are never admitted back into it. Overall acceptance requires a `policy` Decision for the exact Case plus Human authorization; missing, malformed, or cross-Case Policy yields `policy-unsatisfied` without changing Case disposition.
- Case identity is the **result tree, base tree, and raw diff-tree digest**. `candidateCommit` is an observation shown in the dossier, not an identity predicate, so a later squash/merge remains provable when those three identity values are byte-identical.

## Packet inspection

A transported packet contains the closed bundle (`roots.json`, `objects/sha256/`, `attachments/sha256/`), a regenerated dossier, verifier output, and the inspection command. It must not contain issue discussion, sessions, cycle/raw logs, the sealed mutation mapping, or expected answers.

Inspect with `npx pelaggio verify --bundle <dir>`.
