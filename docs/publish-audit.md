# First-publish checklist

One-shot items before the first GitHub Release for `pelaggio` is published. Repeating mechanics live in [`releasing.md`](./releasing.md) and `.github/workflows/publish.yml`. Check each box with a date.

The GitHub repo is already public. `packages/pelaggio` is already un-private, licensed AGPL-3.0-or-later, and versioned `0.1.0`. npm already has a `0.0.1` name reservation (`"Reserved."`) owned by `cdhorne` — the first real version is `0.1.0` from that same account.

## 1. Git history secret scan

Run against the full history before the first release:

```bash
gitleaks detect --source . --log-opts "--all"
# or:
trufflehog git file://. --since-commit $(git rev-list --max-parents=0 HEAD)
```

- [ ] Date run:
- [ ] Tool + version:
- [ ] Result (paste summary, or "clean"):
- [ ] If findings: remediation (rewrite history / rotate credentials / accept)

Not wired into CI: by the time a release workflow runs, history is already on the remote.

## 2. npm account hardening

- [ ] 2FA enabled on the npm account (authenticator, not SMS). Date confirmed:
- [ ] Granular access token created for CI, scoped to `pelaggio` publish only. Token ID / last-four:
- [ ] Legacy / classic tokens on the account revoked. Date:
- [ ] Token stored as `NPM_TOKEN` in the repo's GitHub Actions secrets. Date:

## 3. Package-level 2FA

After the first publish succeeds:

```bash
npm access 2fa-required pelaggio
```

- [ ] Enabled. Date:

## 4. Provenance

The workflow publishes with `--provenance` (`permissions: id-token: write`). Verify after the first publish:

```bash
npm view pelaggio --json | jq '.dist.attestations'
```

- [ ] Provenance attestation visible. Date:

## 5. Install-script guardrail

`pnpm check:publish` fails if `package.json` declares `preinstall`, `install`, or `postinstall`.

- [ ] `pnpm check:publish` green against the tree being published. Date:

## 6. First release

Do these only after every item above is checked:

- [ ] `pnpm release:draft` on green `main`. Draft URL:
- [ ] Release notes edited. Date:
- [ ] GitHub Release published. Date:
- [ ] Workflow run succeeded (GitHub-hosted). Run URL:
- [ ] Installed smoke test in a fresh dir: `npm i pelaggio && npx pelaggio --help`. Date:

## Rollback

If something ships that shouldn't have:

- `npm deprecate pelaggio@<version> "reason"` — immediate, preserves install graphs.
- `npm unpublish pelaggio@<version>` — only within 72 hours and only if no other package depends on it. Prefer `deprecate`.
- Rotate `NPM_TOKEN` if a leak is suspected.
