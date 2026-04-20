# TOOL-45 — Portable pnpm discovery in autopilot-server.service

## Problem

`infra/systemd/autopilot-server.service` currently has:

```ini
ExecStart=/usr/bin/env pnpm --filter @cdhorne/claude-autopilot-server start
```

systemd user instances boot with a minimal `PATH` (roughly
`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`). Operators
whose `pnpm` comes from a node-version manager — **fnm**, **nvm**, **volta** —
install it outside that PATH, so `/usr/bin/env pnpm` fails with exit status
127 and the unit crash-loops at the `Restart=on-failure` cadence.

Confirmed by a Fathom-box install where the operator uses fnm; the unit
never reached a healthy state until PATH was manually patched in.

## Scope

**In:**
- New wrapper script `infra/systemd/autopilot-server-exec.sh` that
  bootstraps PATH for fnm / nvm / volta / corepack-in-`~/.local/bin`,
  then execs `pnpm --filter @cdhorne/claude-autopilot-server start`.
- `infra/systemd/autopilot-server.service` — point `ExecStart` at the
  wrapper.
- `docs/server.md` — update the "systemd setup" section: explain why the
  wrapper exists, list the managers it supports, and document the escape
  hatch for operators whose setup isn't covered (`PATH=` in the env file,
  or a systemd drop-in that overrides `ExecStart`).
- `packages/autopilot/scripts/autopilot/__tests__/` — one small node:test
  that runs `bash -n` against the wrapper to catch syntax errors in CI
  (matches the repo's "no new test frameworks" idiom).

**Out:**
- No changes to server code (`packages/server/src/**`) — this is purely a
  deployment-ergonomics fix.
- No changes to `.github/workflows/deploy-server.yml` — the deploy step
  still just `systemctl --user restart autopilot-server` and the new
  wrapper is picked up by the restart.
- Not changing the `WorkingDirectory=%h/workspace/claude-autopilot`
  assumption. That's a separate portability concern; stays out of scope
  here (operator docs already call this out).
- No `prepack` inclusion of `infra/**` — consumers don't need the systemd
  unit; this is maintainer-side infrastructure.

## Approach

### Why a wrapper script over inline `Environment=PATH=…`

Alternatives considered:

1. **`Environment=PATH=%h/.local/bin:%h/.volta/bin:…`** in the unit — brittle
   because fnm uses *dynamic* per-shell shim directories
   (`~/.local/state/fnm_multishells/<pid>_<epoch>/bin`) that don't exist
   until `fnm env` has been eval'd. No static PATH list covers fnm.
2. **`ExecStart=/bin/bash -lc "pnpm …"`** — depends on operator's login
   shell sourcing the right rc file. For bash specifically, `-l` sources
   `~/.bash_profile` but *not* `~/.bashrc` (where fnm and nvm install
   their hooks by default). Non-portable across shells and opaque to
   debug.
3. **Require operators to set `PATH=` in `~/.config/autopilot-server.env`**
   — pushes the ecosystem-specific initialization onto each operator. Works
   for volta (static bin dir) but not fnm.
4. **Wrapper script (chosen)** — explicit, auditable, operator can read
   what it does. Handles fnm's `fnm env` eval correctly. Falls through
   cleanly when a manager isn't installed, so it's safe on a plain
   corepack / system-package setup.

### Wrapper contract

`infra/systemd/autopilot-server-exec.sh`:

```bash
#!/usr/bin/env bash
# Bootstraps PATH for common node-version managers so `pnpm` is resolvable
# under a systemd user unit (which boots with a minimal PATH).
# Each block is a no-op when the manager isn't installed.
set -euo pipefail

# XDG + corepack fallbacks first: ~/.local/bin is where fnm installs its
# binary by default, and where standalone pnpm/corepack-enabled shims land.
# Must come BEFORE the fnm probe below, otherwise `command -v fnm` will
# miss it under systemd's minimal PATH.
[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"
[ -d "$HOME/.local/share/pnpm" ] && export PATH="$HOME/.local/share/pnpm:$PATH"

# volta: static bin directory
if [ -d "${VOLTA_HOME:-$HOME/.volta}/bin" ]; then
  export VOLTA_HOME="${VOLTA_HOME:-$HOME/.volta}"
  export PATH="$VOLTA_HOME/bin:$PATH"
fi

# nvm: sourcing nvm.sh puts the current default node on PATH.
# Temporarily relax `set -u` — nvm.sh historically references unset vars.
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  set +u
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh" --no-use
  nvm use default >/dev/null 2>&1 || true
  set -u
fi

# fnm: needs `fnm env` to allocate a multishell dir and export PATH.
# Binary typically at ~/.local/bin/fnm (already on PATH from the XDG block
# above); data dir at ~/.local/share/fnm.
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --shell bash)"
  fnm use default >/dev/null 2>&1 || true
fi

exec pnpm --filter @cdhorne/claude-autopilot-server start
```

Key properties:

- `set -euo pipefail` so a broken init surfaces as a 1-exit, not a silent
  wrong-node invocation. `set -u` is briefly relaxed around `nvm.sh`
  because the upstream script touches unset vars; restored immediately
  after.
- Each manager block is guarded by `command -v` or filesystem probe *before*
  invoking the manager's CLI — no spurious errors on boxes that don't have
  the manager installed.
- XDG/corepack PATH additions happen **before** manager probes so tools
  installed to `~/.local/bin` (fnm, standalone pnpm) resolve.
- `exec` replaces the shell so systemd's PID tracking still works and
  signal handling (SIGUSR2 for pause, SIGINT for stop) propagates to the
  node process exactly as today.
- Runs `pnpm` from the same working directory systemd provides via
  `WorkingDirectory=` — no `cd` in the wrapper.

### Unit change

```diff
 [Service]
 Type=simple
 WorkingDirectory=%h/workspace/claude-autopilot
 EnvironmentFile=%h/.config/autopilot-server.env
-ExecStart=/usr/bin/env pnpm --filter @cdhorne/claude-autopilot-server start
+ExecStart=%h/workspace/claude-autopilot/infra/systemd/autopilot-server-exec.sh
 Restart=on-failure
```

`%h` resolves to the user's `$HOME` via systemd specifier expansion — the
same mechanism already in use on `WorkingDirectory` and `EnvironmentFile`.

The wrapper must be `chmod +x`. Committed as executable (`git update-index
--chmod=+x` on first add); the install docs' `cp` step preserves the mode.

### Docs update

`docs/server.md`, under "systemd setup", add a short section after the
install snippet:

> **Why the wrapper script?** systemd user instances boot with a minimal
> `PATH` that excludes the bin directories used by fnm/nvm/volta. The
> wrapper at `infra/systemd/autopilot-server-exec.sh` sources the right
> init hook for whichever manager is installed and then execs `pnpm`. If
> your setup isn't covered, you have two options: (1) add
> `PATH=/your/bin:$PATH` to `~/.config/autopilot-server.env` (systemd
> `EnvironmentFile` is read before `ExecStart`), or (2) drop a
> `~/.config/systemd/user/autopilot-server.service.d/override.conf` with
> a custom `ExecStart=`.

No change to the env-file example — PATH stays optional there.

## Files to change

| File | Change |
|---|---|
| `infra/systemd/autopilot-server-exec.sh` | **New.** Wrapper script above. `chmod +x`. |
| `infra/systemd/autopilot-server.service` | Point `ExecStart=` at the wrapper. |
| `docs/server.md` | Add "why the wrapper" subsection under systemd setup; document fallback options. |
| `packages/autopilot/scripts/autopilot/__tests__/systemd-wrapper.test.ts` | **New.** `node:test` that resolves the repo root via `resolveArtifactRoot(import.meta.url)` from `../artifact-root.js` (same pattern as `roadmap-graph.test.ts`), spawns `bash -n <root>/infra/systemd/autopilot-server-exec.sh`, and asserts exit 0. Gracefully skips (via `it.skip`) if `bash` is not on PATH so the test isn't Linux-only in spirit. |

## Test strategy

- **Automated:** a single `node:test` case that shells out to
  `bash -n infra/systemd/autopilot-server-exec.sh` from the repo root and
  asserts exit 0. Covers syntax regressions on every `pnpm -r test` run.
  This matches the repo's idiom (no new frameworks, minimal deps).
- **No runtime unit test for the wrapper.** Mocking three different
  node-version managers with enough fidelity to validate their
  integration would be heavier than the bug; the shellcheck-equivalent
  syntax check plus manual smoke is sufficient.
- **Manual smoke (operator side):**
  1. On the Fathom box (fnm-based): `systemctl --user daemon-reload &&
     systemctl --user restart autopilot-server && journalctl --user -u
     autopilot-server -n 50` — expect the app log, not `status=127`.
  2. Confirm `/healthz` returns `{ ok: true }`.
  3. Confirm a `POST /runs` cycle still spawns its `pnpm autopilot`
     subprocess (this validates that PATH propagates to children).
- **Regression surface:** none beyond the service startup path. The
  wrapper is in the call chain before *anything* else; if it breaks,
  systemd reports `status=exited` and `journalctl` shows the bash error.

## Rubric self-check

**Correct.** Behavior-preserving: wrapper `exec`s the exact same command
(`pnpm --filter @cdhorne/claude-autopilot-server start`) the unit ran
before, so signal handling (SIGUSR2 pause, SIGINT stop), stdout/stderr
tee to journal, and `Restart=on-failure` semantics are unchanged. The
server's own env handling (`EnvironmentFile` read by systemd, not the
wrapper) is untouched. No pipeline steps added → no `STEPS` / `BUDGETS`
/ `TURN_LIMITS` / `EFFORT` / `MODEL_PROFILES` update needed. No skills
modified → no worktree-isolation or plan-polish hook updates. Not a
cycle → no phantom-ship-guard or rate-limit-parking interaction.

**Well-typed.** Shell + Markdown; no TypeScript signatures change. The
node:test uses `node:child_process` with default types.

**Well-factored.** Wrapper is one file, one responsibility (PATH
bootstrap + exec). Each manager block is isolated; adding a fourth
manager is a copy-paste of a 3-line `if` stanza. No abstraction layer —
three similar blocks is fine per the "don't prematurely abstract" rule
in CLAUDE.md.

**Well-tested.** One syntax-check test (catches regressions cheaply).
Manual smoke steps are enumerated so the operator has a concrete
checklist. Runtime correctness is verifiable in `journalctl` without
further instrumentation.

**Concise.** ~30-line shell script + 1 unit-file diff + ~8 lines of
docs. No dependencies added, no new packages, no new dev tooling.

**Idioms — deferred to `/shakedown`.** Flagging one thing for the
reviewer to double-check: `exec` form (`exec pnpm …`) vs `exec -a` to
rename argv[0] — I've used plain `exec`, which is what systemd units
typically do. Open to revision if repo convention differs.
