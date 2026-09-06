# Evidence notes — #799 authentication fault-sensitivity

Companion to [`../authentication-fault-sensitivity.md`](../authentication-fault-sensitivity.md). Frozen challenges, identity, commands, binds, named receipts, and classification. Scratch fixtures under `.dev/assurance-mutation-*` were deleted after receipts were copied here.

## Timing ledger (UTC)

Active investigation started after planning, on a clean worktree. No challenge was substituted. Cap was 240 minutes / three behavioral challenges; all three completed.

| Interval (UTC) | Work | Active |
| --- | --- | --- |
| 2026-09-06T16:27:31Z – 16:29:31Z | Identity, versions, hashes; freeze C1–C3 patches (unique anchors confirmed) | ~2 min |
| 2026-09-06T16:29:31Z – 16:29:33Z | Live config/auth/app baseline (dot + dual reporters) | ~2 s |
| 2026-09-06T16:30:35Z – 16:30:36Z | Unmutated control fixture, bind, auth+app observations | ~1 s |
| 2026-09-06T16:30:44Z – 16:30:47Z | C1, C2, C3 independent fixtures, binds, observations | ~3 s |
| 2026-09-06T16:30:47Z – 16:33:13Z | Named-receipt extraction, causal classification, C3 assertion-line diagnosis | ~2.5 min |
| 2026-09-06T16:33:13Z – 16:35:40Z | Findings + these notes (no further challenges) | ~2.5 min |
| 2026-09-06T16:35:40Z – 16:37:06Z | Ordinary repo checks (live hashes, rubric tests/typecheck/biome/skills); no further challenges | ~1.5 min |

- Wall elapsed, identity capture → close-out: **~10 minutes**.
- Active minutes (setup, runs, classification, writing, close-out): **~10 minutes**.
- Behavioral challenges attempted: **3** (C1, C2, C3). Replays of the same patch are not additional challenges.
- Diagnostic JSON `POST /runs`: **not run** (see Diagnosing C3).

## Identity

- HEAD: `2fbbde1c86ed7f16b49bc1525d042421bd5d0d12` (`feat: consume durable authoring review metrics (#797)`)
- Branch: `feat/issue-799-experiment-audit-authentication-fault-se`
- `git status --short`: empty at start. `git diff --name-only main...HEAD`: empty (no implement commits yet). No dirty tracked source. Plan path `.dev/plans/799.md` is gitignored and was not edited.
- Node `v22.22.2`; pnpm `11.18.0`; tsx `4.23.1`; Hono `4.12.33` (from `packages/server/node_modules/hono/package.json`).
- Cwd for every test invocation: this worktree root.

### Content hashes (SHA-256)

| Path | SHA-256 |
| --- | --- |
| `packages/server/src/auth.ts` | `d9799e95a76c534820982b2f6c7fb426f278a3063bfe3aa41063ff16226b80d4` |
| `packages/server/src/app.ts` | `bc800a1b3344599a041e9047e3402fc5867f988f6be28b9c1dbbed585e2a4bb0` |
| `packages/server/__tests__/auth.test.ts` | `e6c6d41e8e16d5b2e0970982a30ee77b49cb482dd0ee3be3376a978e8f696b43` |
| `packages/server/__tests__/app.test.ts` | `98f58a474344a09d9430cbf6785b16a6eaa00f41966f86ffca4f942d79d98cd1` |
| `packages/server/__tests__/config.test.ts` | `fb5145de7a00af2144bc3affea5103e2c666948ff71630c27668a3dbb7d5c8a0` |
| `packages/server/package.json` | `8b86cd766911c02aacbf8dc1f4575e542b122e52565ab93ecddb9f0ac8799e68` |
| `ci/assurance-observation-reporter.mjs` | `e51ea229b02750fbdd22516324d192ee2397aa0ec9add8438d26f4f9a09a5b09` |
| `ci/test-realization-mutation.sh` | `3adc12e6bdbad8e1f26885504147c7229ffaf4b4da9ed155cfc00b68e8650b9c` |
| `pnpm-lock.yaml` | `52c1e41ce7e0c93bd872f4095af7e5499e1bae7c5b40e6df54002e3e5ecd3c7f` |
| `c1-skip-match-401.patch` | `f48f068f20e79a9f2b153743ea749008b73c310ecb27daaba392a3efd7b8ab1d` |
| `c2-hollow-success-handoff.patch` | `ff159d6df5a09453fe05b6848b26d192f8ebfbd11e13905344066daea30e137b` |
| `c3-overwrite-after-next.patch` | `73927a7eb14be9e079a2cce5dd555dd86655842782f2de8b5c4e7eea8275611e` |

Live hashes were re-read after the challenges and matched the table. Copied tests and `package.json` in every bind record matched the live hashes above.

Patched `auth.ts` content hashes (expected and observed in bind records):

| Copy | SHA-256 of fixture `auth.ts` |
| --- | --- |
| control / live | `d9799e95a76c534820982b2f6c7fb426f278a3063bfe3aa41063ff16226b80d4` |
| C1 | `e4db2cfd2aa4ed0ac3e046668bef36157d9bc6de0a5e3f406d6d7b2fb6206b30` |
| C2 | `d1fa9a2763922cd62ea2f217204b5aedd39d4323a70769d5de3eef2d183c237f` |
| C3 | `e5626bdd82ac9229c0d02e626b1f6362eeb177df6a8b56ccb574f5e044d8e48e` |

## Frozen challenges (before any mutation)

All patches target only copied `packages/server/src/auth.ts`, apply independently to the same baseline (fresh fixture each time), and used an exact single-match anchor.

| ID | Promise under test | Exact edit | Patch |
| --- | --- | --- | --- |
| C1 | Unauthorized requests cannot enter protected handlers | Replace the `!match` `return c.json(..., 401)` with `await next(); return;` | [c1-skip-match-401.patch](c1-skip-match-401.patch) |
| C2 | Valid bearer credentials permit protected requests | Replace the sole `\t\tawait next();` success handoff with `return c.json({ error: "hollowed auth mechanism", code: "unauthorized" }, 401);` | [c2-hollow-success-handoff.patch](c2-hollow-success-handoff.patch) |
| C3 | Refusing authentication must prevent the protected effect, not merely produce 401 | Replace the `!match` 401 return with `await next(); c.res = c.json({ error: "missing bearer token", code: "unauthorized" }, 401); return;` | [c3-overwrite-after-next.patch](c3-overwrite-after-next.patch) |

On-path vs controls are as predeclared in the plan. CTR-0008 (`correct token authenticates state changes`) is a **control** for C1 and C3, and **on-path** for C2. C2 is the existing mutation proof’s behavioral challenge, counted inside the three, not as a fourth.

## Fixture method

Each run used [replay-fixture.sh](replay-fixture.sh):

1. `mktemp -d "$PWD/.dev/assurance-mutation-XXXXXX"`
2. Copy entire `packages/server/src/`, `packages/server/package.json`, and only `auth.test.ts` + `app.test.ts`.
3. `ln -s` the live `packages/server/node_modules`.
4. Apply at most one retained patch with `patch -p0`.
5. Bind check: `realpath` of `./auth.ts` next to copied `app.ts` equals fixture `auth.ts`, is not the live checkout path, and SHA-256 matches the expected patched (or unmutated) content. No compiled `auth.js` shadow file.
6. Invoke tests with **cwd = worktree root**, passing **fixture** test paths (never live `app.test.ts` against a mutated-only-auth copy).
7. Copy receipts here, then delete the fixture.

Config tests stayed on the live checkout.

## Live baseline

Command (cwd = worktree root), recorded in [baseline-live-command.txt](baseline-live-command.txt):

```bash
node --import tsx --test --experimental-test-isolation=none --test-concurrency=1 --test-timeout=60000 --test-reporter=dot \
  packages/server/__tests__/config.test.ts \
  packages/server/__tests__/auth.test.ts \
  packages/server/__tests__/app.test.ts
```

- Exit: `0` ([baseline-live-dot-exit.txt](baseline-live-dot-exit.txt)). Stdout: 68 dots ([baseline-live-dot-stdout.txt](baseline-live-dot-stdout.txt)). Stderr: Node `NO_COLOR`/`FORCE_COLOR` warnings only.

Dual-reporter named receipts (same files, same flags):

```bash
node --import tsx --test --experimental-test-isolation=none --test-concurrency=1 --test-timeout=60000 \
  --test-reporter=spec --test-reporter-destination=docs/spikes/authentication-fault-sensitivity/baseline-live-spec.txt \
  --test-reporter=./ci/assurance-observation-reporter.mjs \
  --test-reporter-destination=docs/spikes/authentication-fault-sensitivity/baseline-live-observations.jsonl \
  packages/server/__tests__/config.test.ts \
  packages/server/__tests__/auth.test.ts \
  packages/server/__tests__/app.test.ts
```

- Exit: `0`. Spec: 65 tests / 3 suites / 65 pass / 0 fail ([baseline-live-spec.txt](baseline-live-spec.txt)).
- Observation JSONL: [baseline-live-observations.jsonl](baseline-live-observations.jsonl). Named (non-suite) events: 65 `test:pass`, 0 `test:fail`.
- Every selected on-path/control name produced exactly one `test:pass` bound to the live test file (see [named-receipts.json](named-receipts.json)).
- The mutation script was **not** used as an unchanged baseline (it injects C2).

## Control copy

Unmutated fixture `.dev/assurance-mutation-5gjzf6`. Bind: [control-bind.json](control-bind.json) (`bindOk: true`, auth SHA matches live). Tests: fixture `auth.test.ts` + `app.test.ts` only.

- Exit: `0`. Spec: 47 tests / 2 suites / 47 pass / 0 fail ([control-spec.txt](control-spec.txt), [control-observations.jsonl](control-observations.jsonl)).
- Named auth+app events vs live auth+app: 47/47, identical names and `test:pass` types, no extras. Comparison valid.

## Challenge results

Classification helper output: [classification.json](classification.json). Detection requires a baseline/control `test:pass` and a causally relevant `test:fail` on the applied fault. A control pass is not survival of the challenge.

### C1 — skip `!match` 401

- Fixture `.dev/assurance-mutation-dkQnhv`. Patch apply: `patching file packages/server/src/auth.ts` ([c1-patch-apply.txt](c1-patch-apply.txt)). Bind: [c1-bind.json](c1-bind.json) (`bindOk: true`, SHA `e4db2c…`).
- Exit: `1` (test failure, not a logger success). Spec: 47 tests / 43 pass / 4 fail ([c1-spec.txt](c1-spec.txt)).

| Observation | Role | Control | C1 | Class |
| --- | --- | --- | --- | --- |
| `missing Authorization header: 401` | on-path | pass | fail (`200 !== 401`, auth.test.ts:18) | **detects** |
| `non-Bearer scheme: 401` | on-path | pass | fail (`200 !== 401`, auth.test.ts:50) | **detects** |
| `bearer gate: missing token → 401 except /healthz` | on-path | pass | fail (`200 !== 401`, app.test.ts:655) | **detects** |
| `unauthenticated POST /runs rejects a text/plain simple request before spawning` | on-path | pass | fail (`200 !== 401`, app.test.ts:321) | **detects** |
| `correct token: 200` | control | pass | pass | control held |
| `wrong token: 401` | control | pass | pass | control held |
| `correct token authenticates state changes` | control | pass | pass | control held |
| `POST /runs happy path → 200; persisted run carries repo` | control | pass | pass | control held |

C1 did not leak onto the token-comparison or success branches. Failed assertions are status 200 on the `!match` path — the protected handler ran and its response was kept. No C3-style 401+effect ambiguity.

### C2 — hollow success handoff (existing mutation proof)

- Fixture `.dev/assurance-mutation-cMXeSo`. Patch apply: `patching file packages/server/src/auth.ts`. Bind: [c2-bind.json](c2-bind.json) (`bindOk: true`, SHA `d1fa9a…`).
- Exit: `1`. Spec: 47 tests / 11 pass / 36 fail ([c2-spec.txt](c2-spec.txt)). Extra failures are authorized application tests that also require `next()`; they are consistent with hollowing success, not off-branch leakage of the `!match`/wrong-token paths.

| Observation | Role | Control | C2 | Class |
| --- | --- | --- | --- | --- |
| `correct token authenticates state changes` | on-path (CTR-0008) | pass | fail (`401 !== 200`, auth.test.ts:38) | **detects** |
| `correct token: 200` | on-path | pass | fail (`401 !== 200`, auth.test.ts:32) | **detects** |
| `POST /runs happy path → 200; persisted run carries repo` | on-path | pass | fail | **detects** |
| `bearer gate: correct token → 200` | on-path | pass | fail | **detects** |
| `missing Authorization header: 401` | control | pass | pass | control held |
| `wrong token: 401` | control | pass | pass | control held |
| `unauthenticated POST /runs … before spawning` | control | pass | pass | control held |

Exact CTR-0008 named receipt: one `test:fail` on the fixture `auth.test.ts`, matching the live `test:pass` for the same name. This is the graph-declared observation, recorded separately from the application suite.

### C3 — `next()` then overwrite 401

- Fixture `.dev/assurance-mutation-TzyXMa`. Patch apply: `patching file packages/server/src/auth.ts`. Bind: [c3-bind.json](c3-bind.json) (`bindOk: true`, SHA `e5626b…`).
- Exit: `1`. Spec: 47 tests / 46 pass / 1 fail ([c3-spec.txt](c3-spec.txt)).

| Observation | Role | Control | C3 | Class |
| --- | --- | --- | --- | --- |
| `missing Authorization header: 401` | on-path | pass | pass | **survives** |
| `non-Bearer scheme: 401` | on-path | pass | pass | **survives** |
| `bearer gate: missing token → 401 except /healthz` | on-path | pass | pass | **survives** |
| `unauthenticated POST /runs rejects a text/plain simple request before spawning` | on-path | pass | fail (`1 !== 0` at app.test.ts:324) | **detects** |
| success-path, wrong-token, CTR-0008, happy path, `bearer gate: correct token → 200` | controls | pass | pass | control held |

The sole failing assertion is `assert.equal(supervisor.list().length, 0)` at `app.test.ts:324`. The two preceding asserts in that test (`res.status === 401`, `body.code === "unauthorized"`) therefore passed. C3 realized “unauthorized response with effect”, **not** a 200+spawn invalid patch. Each `setup()` builds a fresh `Supervisor` / tmpdir, so the stored run is from this request.

Auth unit tests and the bearer-gate test assert status (and, for missing header, `code`) only. They have no handler-invocation or `supervisor.list()` check. Survival there is the expected C3 sensitivity, not equivalence with the effect observation.

## Diagnosing C3

Plan rule: if the existing text/plain unauthenticated `POST /runs` already fails on `supervisor.list().length === 0` (or status), cite it; do not add a redundant JSON-content-type assertion merely because narrower status observations survived.

- **Diagnostic JSON `POST /runs` through `rawApp`: not applied.** Reason: the existing observation already failed on `supervisor.list().length` (`1 !== 0`) after a 401/`unauthorized` response. `c.req.json()` does not consult `Content-Type`; the existing body is already `JSON.stringify({ repo: "main", item: "TOOL-1" })`.
- No baseline-only live-code defect was suspected. Unchanged `auth.ts` does not call `next()` on `!match`.
- No diagnostic test patch is retained because none was applied.

## Reproduction

From the worktree root, with the same Node and local `node_modules`:

```bash
# live baseline (config stays on the checkout)
node --import tsx --test --experimental-test-isolation=none --test-concurrency=1 --test-timeout=60000 --test-reporter=dot \
  packages/server/__tests__/config.test.ts \
  packages/server/__tests__/auth.test.ts \
  packages/server/__tests__/app.test.ts

# control, then one challenge at a time (script deletes its scratch copy)
EXPECTED_AUTH_SHA256=d9799e95a76c534820982b2f6c7fb426f278a3063bfe3aa41063ff16226b80d4 \
  docs/spikes/authentication-fault-sensitivity/replay-fixture.sh control
EXPECTED_AUTH_SHA256=e4db2cfd2aa4ed0ac3e046668bef36157d9bc6de0a5e3f406d6d7b2fb6206b30 \
  docs/spikes/authentication-fault-sensitivity/replay-fixture.sh c1 \
  docs/spikes/authentication-fault-sensitivity/c1-skip-match-401.patch
EXPECTED_AUTH_SHA256=d1fa9a2763922cd62ea2f217204b5aedd39d4323a70769d5de3eef2d183c237f \
  docs/spikes/authentication-fault-sensitivity/replay-fixture.sh c2 \
  docs/spikes/authentication-fault-sensitivity/c2-hollow-success-handoff.patch
EXPECTED_AUTH_SHA256=e5626bdd82ac9229c0d02e626b1f6362eeb177df6a8b56ccb574f5e044d8e48e \
  docs/spikes/authentication-fault-sensitivity/replay-fixture.sh c3 \
  docs/spikes/authentication-fault-sensitivity/c3-overwrite-after-next.patch
```

`replay-fixture.sh` always exits 0 after copying receipts so a failing suite cannot skip retention; the test process status is in `<label>-exit.txt`.

The script is a boundary-specific replay helper, not a CI runner or reusable API.

## Review-recovery verification context

The retained independent-review blocker was this seat's inability to complete the ordinary repository checks: tsx test workers were denied their IPC socket (`EPERM`), and Astro typechecking could not write its dependency cache (`EROFS`). This is an environment limitation, not an experiment result or a production defect.

An operator ran the rubric commands in a capable environment at `add8b06b9933e5fbd8ad9e52b7701215e025871f` (the experiment checkpoint) and reported exit 0 for each command below. HEAD was unchanged before and after, and the tracked worktree was clean. The raw outputs are retained in that operator checkout under `.dev/operator-verification-799/`; the filenames and SHA-256 values make the report reproducible without copying those logs into this experiment's evidence corpus.

| Command | Output | SHA-256 |
| --- | --- | --- |
| `npx tsx --test --test-reporter=dot packages/pelaggio/scripts/pelaggio/__tests__/*.test.ts` | `cli-tests.log` | `cd21b682a578090e545b0ca1045939c85e204ae8b5eb4cbe340c9dc3b62be581` |
| `npx tsx --test --test-reporter=dot packages/server/__tests__/*.test.ts` | `server-tests.log` | `09811f0df87b75caf2fd6892a67455a2ebf92e2f3394785243fb91e3479fe599` |
| `npx tsx -e "import('./packages/pelaggio/scripts/pelaggio/config.ts')"` | `config-import.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `npx tsx -e "import('./packages/pelaggio/scripts/pelaggio/git.ts')"` | `git-import.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `npx tsx -e "import('./packages/pelaggio/scripts/pelaggio/orchestrator.ts')"` | `orchestrator-import.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `npx tsx -e "import('./packages/server/src/app.ts')"` | `server-import.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `pnpm typecheck` | `typecheck.log` | `fcd28831adda0b6b53685a8fa83d73c6eefa61a86272c81d2c3e7060c202c875` |
| `pnpm typecheck:ratchet` | `ratchet.log` | `68f2c4526ae39ae9d9d3f89e854f22c2ea157f9d8f3d8ca727256fd4af706e9f` |
| `pnpm check` | `lint.log` | `3538d070d4a8566539156418002444e8d806615a9cc6fcd9630fb0d86401d9b1` |
| `pnpm check:skills` | `skills.log` | `52854c32f8a440a6177690814b6c63eac5fbacc7b5b0cd7fa8b1417a3e138568` |

This is local operator execution evidence only, not a signed attestation, independent-review clearance, or a waiver of the ordinary review gate. It does not add a behavioral challenge, alter the C1–C3 classifications, or widen this experiment's boundary.

`git diff --check main...HEAD` over the complete experiment reports whitespace in the exact retained patch and terminal-spec receipts (`*.patch` added lines with tab indentation and `*-spec.txt` terminal blank lines). The authored Markdown evidence files themselves pass that check. Those bytes are the recorded inputs/outputs used by the content hashes and classification, so they are preserved rather than normalized; this is not a source or test whitespace finding.

## Artifact index

Produced and referenced:

- Patches: [c1-skip-match-401.patch](c1-skip-match-401.patch), [c2-hollow-success-handoff.patch](c2-hollow-success-handoff.patch), [c3-overwrite-after-next.patch](c3-overwrite-after-next.patch)
- Replay: [replay-fixture.sh](replay-fixture.sh)
- Named receipts: [named-receipts.json](named-receipts.json), per-run `*-observations.jsonl` / `*-spec.txt`
- Binds: `control-bind.json`, `c1-bind.json`, `c2-bind.json`, `c3-bind.json`
- Classification: [classification.json](classification.json)
- Commands, exits, stderr/stdout, patch-apply, fixture path labels: `*-command.txt`, `*-exit.txt`, `*-stderr.txt`, `*-stdout.txt`, `*-patch-apply.txt`, `*-fixture-path.txt`
- Live baseline extras: `baseline-live-*`

No `.log` files. No diagnostic patch. No live source or test edits.

## Residuals (predeclared, not extra challenges)

Wrong-token and length-mismatch branches as injected faults; `loadServerConfig()` `CONTROL_PLANE_TOKEN` `required()` path (TC-010 refuse-to-start); pause/resume/stop and repo-route effects; nested-app vs flattened-route differences beyond Hono 4.12.33; timing side channels.
