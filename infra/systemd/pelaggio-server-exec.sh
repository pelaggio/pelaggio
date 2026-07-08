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

exec pnpm --filter @pelaggio/server start
