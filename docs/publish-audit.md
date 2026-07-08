# Publish audit — pre-flip checklist

One-shot checklist the human fills in before flipping
`pelaggio` from a private git-dep to a real public-npm publish.
Each item below must be signed off (date + note) before the first `v*` tag is
pushed. The `.github/workflows/publish.yml` workflow handles the repeating
mechanics (dry-run scan, tag-signature verify, provenance); this file covers
the items automation cannot verify.

The actual flips — `"private": true` → `false` in `package.json`, and the
GitHub repo visibility change from private to public — are the **last two
steps** after everything below is green.

## 1. Git history secret scan

Run before the first publish, against the full history that will become public:

```bash
gitleaks detect --source . --log-opts "--all"
# or:
trufflehog git file://. --since-commit $(git rev-list --max-parents=0 HEAD)
```

- [ ] Date run:
- [ ] Tool + version:
- [ ] Result (paste summary, or "clean"):
- [ ] If findings: remediation (rewrite history / rotate credentials / accept)

Not wired into CI: by the time a tag-push workflow runs, history is already on
the remote, so a CI scan fires too late to matter. This is a human one-shot.

## 2. npm account hardening

- [ ] 2FA enabled on the npm account (authenticator, not SMS). Date confirmed:
- [ ] Granular access token created for CI, scoped to `pelaggio`
  publish only. Token ID / last-four:
- [ ] Legacy / classic tokens on the account revoked. Date:
- [ ] Token stored as `NPM_TOKEN` in the repo's GitHub Actions secrets. Date:

## 3. Package-level 2FA

After the first publish succeeds, set `publish` 2FA on the package so any
future publish requires an OTP:

```bash
npm access 2fa-required pelaggio
```

- [ ] Enabled. Date:

## 4. Provenance

The workflow publishes with `--provenance`; `permissions: id-token: write`
is required and already set in `.github/workflows/publish.yml`. Verify after
the first publish:

```bash
npm view pelaggio --json | jq '.dist.attestations'
```

- [ ] Provenance attestation visible. Date:

## 5. Tag signing

The workflow verifies each release tag against `.github/allowed_signers` via
`git tag -v` before publish. Interpretation note: the roadmap reads "signs the
release tag (ssh-signed)" — since the workflow fires *on tag push*, the tag
already exists by the time CI runs, so CI can only **verify**, not sign. If a
different flow was intended (e.g. workflow creates a post-publish release tag
signed in-CI), flag it here and redesign before flipping.

- [ ] Interpretation confirmed (CI-verifies, human-signs) or redesigned:
- [ ] Maintainer SSH public key committed to `.github/allowed_signers`
  (placeholder replaced with real key). Date:
- [ ] Local git configured to sign tags:
  `git config user.signingkey <key>` and `git config tag.gpgsign true`
  (or use `--sign` per tag). Date:
- [ ] Dry-run verified: `git tag -s v0.0.0-test -m test && git tag -v v0.0.0-test`
  succeeds with the `allowed_signers` file. Date:

## 6. Install-script guardrail

`pnpm check:publish` fails if `package.json` declares `preinstall`, `install`,
or `postinstall`. The `CLAUDE.md` "Key constraints" section records this as an
invariant.

- [ ] `pnpm check:publish` green against the tree being published. Date:

## 7. LICENSE decision

`package.json` currently declares `"license": "UNLICENSED"`. A public package
needs a real license (MIT, Apache-2.0, etc.) and a matching `LICENSE` file at
the repo root. This is a policy call the maintainer owns; not decided here.

- [ ] License chosen:
- [ ] `LICENSE` file added at repo root. Date:
- [ ] `package.json` `"license"` field updated to match. Date:

## 8. Final flips (last steps)

Do these only after every item above is checked:

- [ ] `package.json`: `"private": true` → removed (or set to `false`). Commit SHA:
- [ ] GitHub repo visibility: private → public. Date:
- [ ] First release tag pushed: `vX.Y.Z`. Date:
- [ ] Workflow run succeeded (green on self-hosted runner). Run URL:
- [ ] Installed smoke test in a fresh dir: `npm i pelaggio && npx pelaggio --help`. Date:

## Rollback

If something ships that shouldn't have:

- `npm deprecate pelaggio@<version> "reason"` — immediate,
  preserves install graphs.
- `npm unpublish pelaggio@<version>` — only within 72 hours
  and only if no other package depends on it. Prefer `deprecate`.
- Rotate `NPM_TOKEN` if a leak is suspected.
