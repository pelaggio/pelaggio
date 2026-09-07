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

- [x] Date run: 2026-09-07
- [x] Tool + version: gitleaks 8.30.1 (`detect --source . --log-opts "--all"`; 941 commits, 16.71 MB)
- [x] Result: 16 hits, all false positives. No live credentials. GitHub secret scanning is currently disabled on the repo (API 404).
- [x] If findings: accept — 7 hits are synthetic keys/JWT in `secret-hygiene.test.ts`; 1 is the placeholder `cf-token-with-tunnel-and-dns-edit-scopes` in `infra/cloudflare/terraform.tfvars.example`; 8 are SHA-256 source fingerprints (`authTestSha256` / `EXPECTED_AUTH_SHA256`) in the authentication-fault-sensitivity spike, not tokens. No history rewrite, no rotation.

Not wired into CI: by the time a release workflow runs, history is already on the remote.

## 2. npm account hardening

- [ ] 2FA enabled on the npm account (authenticator, not SMS). Date confirmed:
- [ ] Trusted publisher added on the `pelaggio` package (GitHub Actions). Date:
  - Organization or user: `pelaggio`
  - Repository: `pelaggio`
  - Workflow filename: `publish.yml`
  - Environment name: `npm`
  - Allowed actions: `npm publish` (direct) enabled
- [ ] Legacy / classic / granular publish tokens on the account revoked. Date:

## 3. Disallow tokens

After the first Trusted Publishing publish succeeds, package Settings → Publishing access → **Require two-factor authentication and disallow tokens**:

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
- Remove the trusted publisher on npmjs.com if the GitHub workflow is compromised.
