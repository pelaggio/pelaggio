#!/usr/bin/env bash
# Pre-commit guard conformance, delta-scoped: run the layering + register tests against the
# STAGED snapshot (the tree `git write-tree` would commit), never the live worktree, so an
# unrelated unstaged violation cannot refuse an unrelated commit (guarded-actions.md §8.1
# "narrow"). Dependencies are borrowed from the checkout by symlink; nothing is installed.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/pelaggio-guards.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tree=$(git write-tree)
git archive "$tree" packages/pelaggio packages/server package.json | tar -x -C "$tmp"
ln -s "$root/node_modules" "$tmp/node_modules"
ln -s "$root/packages/pelaggio/node_modules" "$tmp/packages/pelaggio/node_modules"
cd "$tmp/packages/pelaggio"
exec "$root/node_modules/.bin/tsx" --test --test-reporter=dot \
  scripts/pelaggio/__tests__/module-layering.test.ts \
  scripts/pelaggio/__tests__/registers.test.ts
