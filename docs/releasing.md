# Releasing pelaggio

The public package is `packages/pelaggio` on npm as unscoped `pelaggio`. Nothing else in the workspace is published. The only way a version reaches npm is: **you click Publish on a GitHub Release**. Drafts, tag pushes, and `npm publish` from a laptop do not count.

## Each release

1. Land the version you want on `main`. Edit only `packages/pelaggio/package.json` `"version"` (today `0.1.0`). Semver with a hyphen (`0.2.0-rc.1`) is a prerelease and will go to the npm `next` dist-tag.
2. Wait until CI is green on that `main` SHA.
3. From a clean `main` that matches `origin/main`:

   ```bash
   pnpm release:draft
   ```

   That creates a **draft** GitHub Release. It does not publish to npm.
4. Open the printed URL. Edit the notes. For the first release, replace the stub with a short “what this is / how to install” blurb. Later releases pre-fill the PRs since the previous `v*` tag — trim anything that is not for consumers.
5. Click **Publish release**. That is the irreversible step: Actions checks the tag against `package.json` and against `main`, runs `pnpm check:publish`, then `npm publish --provenance --access public` via Trusted Publishing (OIDC, no npm token).
6. Smoke-test in a throwaway directory:

   ```bash
   npm view pelaggio version
   npm view pelaggio --json | jq '.dist.attestations'
   cd "$(mktemp -d)" && npm i pelaggio && npx pelaggio --help
   ```

A GitHub prerelease **must** pair with a hyphenated semver, and a stable semver **must not** be a GitHub prerelease. The workflow refuses the other combinations so `latest` cannot pick up an rc.

## First publish (once)

One-time npm and GitHub setup, before the first Publish click. Checkboxes live in [`publish-audit.md`](./publish-audit.md).

- History secret scan (gitleaks or trufflehog) against the full git history.
- npm account 2FA (authenticator, not SMS).
- Trusted publisher on [npmjs.com/package/pelaggio](https://www.npmjs.com/package/pelaggio) → Settings → Trusted Publisher → GitHub Actions, matching the workflow exactly:
  - Organization or user: `pelaggio`
  - Repository: `pelaggio`
  - Workflow filename: `publish.yml` (filename only)
  - Environment name: `npm`
  - Allowed actions: allow **`npm publish`** (direct). New publishers default to stage-only; without this checkbox the job fails with ENEEDAUTH.
- After 0.1.0 is on the registry: package Settings → Publishing access → **Require two-factor authentication and disallow tokens**. That blocks write tokens; OIDC still works.

The Actions environment `npm` is the publish job’s extra pause. You can add a required reviewer there later; a solo maintainer can leave it empty — the draft release is the review step. Do not create an npm automation token.

## What will not publish

- `git push origin v0.1.0` with no GitHub Release.
- A draft release (the workflow listens for `published` only).
- A tag that is not an ancestor of `origin/main`.
- A tag whose `v…` suffix does not equal `packages/pelaggio/package.json` `"version"`.
- A local `npm publish`.

## If it goes wrong

- Workflow failed before npm accepted the version: fix, re-run the job, or delete the GitHub Release and the tag and start the draft again.
- npm accepted the version: `npm deprecate pelaggio@<version> "reason"`. Unpublish only within 72 hours and only if nothing depends on it. Prefer deprecate.
- Remove the trusted publisher on npmjs.com if the GitHub workflow is compromised, then add it back after the workflow is fixed.
