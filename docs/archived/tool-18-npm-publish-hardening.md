# TOOL-18 — Public-npm publish hardening

Branch: `feat/tool-18-npm-publish-hardening`

## Scope

Put the safeguards in place so flipping `@cdhorne/claude-autopilot` from
`private: true` + git-dep to a real public-npm publish is a deliberate, scripted
operation instead of an ad-hoc `npm publish` that leaks secrets or pulls in dev
debris. The *flip itself* (both `"private": true` → `false` and the GitHub repo
visibility change) is the final manual deliverable per the roadmap and stays
out of this cycle — this cycle lands the machinery and the checklist.

**In scope:**

- Strict `files` allowlist in `package.json` (allowlist, tests negatively
  excluded from included dirs).
- `scripts/check-publish.ts` — dry-run packer + packed-content secret scan +
  `package.json` install-script guard; wired as `pnpm check:publish`.
- Unit tests for the pure scanner helpers.
- `.github/workflows/publish.yml` — self-hosted runner, triggered on `v*` tag
  push, verifies tag signature, runs `pnpm check:publish`, publishes with
  `--provenance`.
- `docs/publish-audit.md` — pre-publish checklist template: git history scan
  (gitleaks/trufflehog), npm-account hardening steps, provenance, repo flip.
  Filled in by the human before the actual flip.
- `CLAUDE.md` invariant note: never add `preinstall`/`install`/`postinstall`
  scripts. The scanner enforces it.
- Clean up stale comment in `scripts/autopilot/index.ts` that still refers to
  TOOL-18 "adding a build step" (that is not what TOOL-18 is).

**Out of scope / explicitly not done:**

- Flipping `"private": true` off and running the first real `npm publish` —
  deferred until all deliverables above are in place and the human has filled
  in `docs/publish-audit.md`.
- Flipping GitHub repo visibility from private to public — manual, last step.
- Running gitleaks/trufflehog in this cycle. The check is documented, not
  automated in CI. Autopilot cannot verify the scan ran on an up-to-date
  working tree from inside a cycle, and wiring it into the publish workflow
  would fire after the scan would have mattered (history is already pushed).
- Adding a build step / compiling to JS. `scripts/autopilot/index.ts` already
  ships as `.ts` source for tsx-based consumers; that stance is unchanged.
- Sigstore, alt registries, changesets — explicitly out of scope per roadmap.
- Adding a real `LICENSE` file. Current `package.json` says
  `"license": "UNLICENSED"`; choosing and adding a license is a policy call the
  human owns and is called out as a blocking checklist item in
  `docs/publish-audit.md` rather than decided here.

## Approach

Why the pieces are shaped the way they are:

**`files` allowlist over `.npmignore`.** npm's `files` field is an allowlist
and supports negative patterns, which covers the tests-inside-allowed-dir
case (`scripts/autopilot/__tests__/`) cleanly. `.npmignore` is a denylist and
easier to drift out of sync. Single source of truth = `package.json`.

**`npm publish --dry-run --json` as the authoritative packed-file list.**
Rather than re-implementing npm-packlist or globbing the tree, shell out to
npm itself and parse its JSON. That's what actually ships, so that's what the
scanner reads. Defense-in-depth: even if someone widens `files` too far, the
allowlist regex in `check-publish.ts` still rejects unexpected paths.

**Pure-function scanner + thin runner.** Export pure helpers
(`checkAllowlist`, `scanContentsForSecrets`, `checkPackageScripts`) so
`scripts/autopilot/__tests__/check-publish.test.ts` can unit-test them with
fixture input — same pattern as `check-roadmap.ts`. The runner concatenates
their violations and exits non-zero if any are found. Keeps the SDK-free
tooling scripts testable without spawning `npm`.

**Self-hosted runner for the workflow.** Matches the existing convention
called out in the roadmap (`runs-on: self-hosted`) and avoids leaking the npm
token to a hosted runner. The workflow is minimal — any logic that needs
testing lives in `check-publish.ts`, not in YAML.

**Signed-tag verification as a gate, not a workflow-side signing step.**
Re-reading the roadmap wording "signs the release tag (ssh-signed)" against a
workflow that fires *on tag push*: the tag already exists by the time CI
runs, so CI can only verify, not sign. Verification via
`git tag -v "$GITHUB_REF_NAME"` with `gpg.ssh.allowedSignersFile` pointed at
a committed `.github/allowed_signers` file is the meaningful check. The
workflow sets this via `git config gpg.ssh.allowedSignersFile
.github/allowed_signers` before invoking `git tag -v`. The `allowed_signers`
file itself is a human-owned artifact (it embeds the maintainer's SSH public
key) — checked in as a Files deliverable below, with a stub the human fills
in via `docs/publish-audit.md` before the first publish. Flagging this
interpretation explicitly in `docs/publish-audit.md` in case the human
intended otherwise.

**Why publish-audit as a doc, not automation.** Most checklist items are
account-level (2FA, granular token, package 2FA setting) or one-time
(gitleaks scan of history, repo-visibility flip). Automating them adds
brittle checks that can't actually verify the side-effect. A documented
checklist the human signs off on once is the appropriate surface.

### Alternatives considered

- **`.npmignore` denylist.** Rejected — easier to leak new files by default;
  `files` allowlist is stricter.
- **Bundle TS → JS before publishing.** Rejected — out of scope per roadmap;
  consumers already run under tsx.
- **Run `check-publish` in a `prepublishOnly` script.** Considered. Skipping
  for now because our publish path is the GitHub workflow, not a local
  `npm publish` — adding `prepublishOnly` would also run on any accidental
  local publish, which is a double-edged benefit but shifts the enforcement
  layer. Can revisit; leaving it workflow-only keeps the contract explicit.
- **Fold the install-script check into a separate lint.** Rejected — tightly
  coupled to publish safety, not style; belongs with the publish check.

## Files

**New:**

- `scripts/check-publish.ts` — entry point + exported pure helpers
  (`checkAllowlist(files)`, `scanContentsForSecrets(entries)`,
  `checkPackageScripts(pkg)`). Default export shape matches
  `scripts/check-roadmap.ts`: script `run()` invoked when executed directly.
- `scripts/autopilot/__tests__/check-publish.test.ts` — unit tests for each
  pure helper, covering: happy path, disallowed path, each secret pattern,
  install-script presence.
- `.github/workflows/publish.yml` — self-hosted runner, `on: push: tags: ['v*']`,
  verifies tag signature, `pnpm install --frozen-lockfile`, `pnpm check:publish`,
  `npm publish --provenance --access public` (gated behind `secrets.NPM_TOKEN`).
  `permissions: { id-token: write, contents: read }` — id-token is required
  for npm provenance.
- `docs/publish-audit.md` — checklist template. Sections: gitleaks/trufflehog
  scan result + date, npm account 2FA screenshot/confirmation, automation
  token scope confirmation, package-level require-2FA setting, tag-signing
  key configured, LICENSE decision, repo-visibility flip sign-off.
- `.github/allowed_signers` — stub file with a `# Add maintainer SSH public
  key before first publish` comment and a placeholder example. Consumed by
  the workflow's `git tag -v` step (via `gpg.ssh.allowedSignersFile`). The
  audit checklist blocks the first publish on the human replacing the stub
  with their real key.

**Modified:**

- `package.json` — add `files` allowlist, add
  `"check:publish": "tsx scripts/check-publish.ts"` script. Keep
  `"private": true` for now (flip is out of scope). The `files` array must
  include the top-level `scripts/autopilot.ts` entry point explicitly
  (the bin CLI's `run`/`stats` routes spawn tsx against this path —
  `scripts/autopilot/` as a directory prefix does *not* cover it), plus
  negative globs to exclude tests inside allowed dirs:
  `["scripts/autopilot.ts", "scripts/autopilot/**", ".claude/skills/**",
  ".claude-templates/**", "bin/**", "!scripts/autopilot/__tests__/**",
  "!scripts/autopilot/**/*.test.ts"]`.
- `CLAUDE.md` — add one-line invariant under "Key constraints": never add
  `preinstall`/`install`/`postinstall` scripts; `check-publish` enforces it.
- `scripts/autopilot/index.ts` — drop the stale "until TOOL-18 adds a build
  step" comment; replace with an accurate one-liner about tsx consumption or
  remove entirely.

**Unchanged but verified:**

- `bin/claude-autopilot.js` — already shape-correct and in the allowlist.
- `scripts/autopilot/index.ts` `exports` target — stays as `.ts`.
- `.gitignore` — already excludes `.dev/`, `node_modules`,
  `.claude/worktrees/`, `.claude/settings.local.json`, etc. Those paths are
  also absent from the `files` allowlist, so defense-in-depth holds.

## Detailed design: `scripts/check-publish.ts`

Shape (final uses tabs + double quotes per biome config):

```ts
#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type PackedFile = { path: string; size: number };
export type Violation =
  | { kind: "disallowed-path"; path: string }
  | { kind: "secret"; path: string; pattern: string; match: string }
  | { kind: "install-script"; name: string };

export const ALLOWED_PREFIXES = [
  "scripts/autopilot/",
  ".claude/skills/",
  ".claude-templates/",
  "bin/",
];
export const ALLOWED_EXACT = [
  "package.json",
  "README.md",
  "LICENSE",
  "scripts/autopilot.ts", // top-level entry; bin/claude-autopilot.js routes `run`/`stats` to this
];
export const DISALLOWED_INSIDE_ALLOWED = [/\/__tests__\//, /\.test\.ts$/];

export const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "anthropic-api-key",  re: /sk-ant-[a-zA-Z0-9_\-]{20,}/ },
  { name: "github-token",       re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: "aws-access-key",     re: /AKIA[0-9A-Z]{16}/ },
  { name: "npm-token",          re: /npm_[A-Za-z0-9]{30,}/ },
  { name: "private-key-header", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
];

export const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

export function checkAllowlist(files: PackedFile[]): Violation[] { /* … */ }
export function scanContentsForSecrets(
  entries: Array<{ path: string; contents: string }>,
): Violation[] { /* … */ }
export function checkPackageScripts(
  pkg: { scripts?: Record<string, string> },
): Violation[] { /* … */ }
```

Runner:

1. `npm pack --dry-run --json` → parse the files list.
2. `checkAllowlist` on the packed file list.
3. For each packed file, read from disk, `scanContentsForSecrets`.
4. `checkPackageScripts` on `./package.json`.
5. Print violations; `process.exit(violations.length ? 1 : 0)`.

**Path-contents source.** `npm pack --dry-run --json` lists paths but doesn't
emit bytes. The scanner reads each listed path off disk — fine because the
paths are resolved relative to repo root and the dry run just told us exactly
which files would ship.

**Self-exclusion from scanner matches.** The regex literals in
`check-publish.ts` themselves look enough like the secret patterns to trigger
a false positive if the file is ever packed (it won't be — `scripts/` is not
allowlisted, only `scripts/autopilot/` is). Verified by dry-run output
inspection; no special-casing required.

## Test strategy

- **Unit tests** (`scripts/autopilot/__tests__/check-publish.test.ts` via
  `node:test`):
  - `checkAllowlist`: one file per allowed prefix passes; `docs/foo.md`,
    `CLAUDE.md`, `.dev/log`, `biome.json`,
    `scripts/autopilot/__tests__/x.ts`, `scripts/autopilot/x.test.ts` each
    produce a `disallowed-path` violation.
  - `scanContentsForSecrets`: one fixture per pattern in `SECRET_PATTERNS`
    produces exactly one violation; clean fixture produces none.
  - `checkPackageScripts`: each of `preinstall`/`install`/`postinstall`
    produces a violation; `build`/`test`/etc. do not.
- **No test for the `run()` wrapper.** Shelling to `npm publish --dry-run` is
  a smoke test — ran manually before shipping, output logged once during
  verification. Mocking npm is costly and low-value for a single call.
- **Smoke verification** before commit: `pnpm check:publish` runs green
  against the current tree; intentionally-bad tree (seed
  `scripts/autopilot/leak.ts` with `sk-ant-FAKE…`) fails with the expected
  violation kind.

## Rubric self-check

- **Well-typed** — `Violation` is a discriminated union, no `any`. Exported
  helpers have explicit return types. `PackedFile` narrows what the rest of
  the scanner needs from npm's JSON (the raw JSON has more keys we ignore).
- **Well-tested** — Pure helpers fully covered; `run()` is a thin shell over
  them. Matches the `check-roadmap.ts` pattern.
- **Well-factored** — Scanner split at the seam between pure rules and the
  npm shell-out. No coupling to the pipeline (`scripts/autopilot/`). Lives
  alongside `scripts/check-roadmap.ts`, not in the autopilot SDK-facing code.
- **Correct** — Key invariants:
  - `files` allowlist drives packing; scanner *also* validates. Two locks,
    one key — new deliverables require editing `files` AND `ALLOWED_PREFIXES`
    in step. Exhaustiveness is enforceable in the unit test: fixture includes
    one file per `ALLOWED_PREFIXES` entry.
  - No install-script hooks — `CLAUDE.md` invariant + scanner check.
  - Tag signature verified in the workflow before `npm publish`. Unsigned
    tags fail the gate.
  - `"private": true` stays in place; flip is out of scope and explicitly
    deferred. The workflow path cannot publish before that flip lands because
    npm rejects private packages at publish time — extra safety.
- **Concise** — No build step, no tsup/rollup plumbing. Single TS file +
  single test file + single workflow file + one doc. No new dependencies
  (uses `execFileSync` + `readFileSync`; no gitleaks wrapper, no
  npm-packlist dep).
- **Idioms** — Deferred to `/shakedown` per plan-review protocol.

## Verification

```bash
npx tsx --test --test-reporter=dot scripts/autopilot/__tests__/check-publish.test.ts
pnpm check
pnpm check:publish       # against the real tree; must exit 0
```

Plus a one-off negative test: temporarily add `scripts/autopilot/leak.ts`
containing a fake `sk-ant-…` token and confirm `pnpm check:publish` exits
non-zero with a `secret` violation naming that file; delete the leak file
before committing.

## Self-review notes

Two revisions made during self-review:

1. **Dropped the automated gitleaks CI step.** First draft had the workflow
   call `gitleaks detect` before publishing. Removed — by the time CI runs on
   a tag push, the history is already on the remote; catching a leak there
   is already too late. The roadmap's phrasing ("Git history audit before
   first publish … document the scan result in `docs/publish-audit.md`") is
   explicitly a one-shot human-run step, not recurring CI. Moved to the
   checklist doc.
2. **Clarified tag-signing interpretation.** Roadmap says workflow "signs the
   release tag" but workflow fires on tag-*push*, so signing there is
   impossible — only verification is. Plan now explicitly interprets this as
   `git tag -v` verification with a committed `allowed_signers` file, and
   flags the interpretation in `docs/publish-audit.md` in case the human
   intended a different flow (e.g. workflow creates a separate release tag
   post-publish).

Run `/shakedown` for an independent review, or say **go** to start building.
When done, run `/shakedown` again to review the code.
