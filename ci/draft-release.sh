#!/usr/bin/env bash
# Create a GitHub *draft* release for packages/pelaggio. Does not publish to npm.
# Publishing the draft in the GitHub UI is what runs .github/workflows/publish.yml.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() { echo "draft-release: $*" >&2; exit 1; }

command -v gh >/dev/null || fail "gh is required"
command -v git >/dev/null || fail "git is required"
command -v node >/dev/null || fail "node is required"

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || fail "must run on main (on ${branch})"

git fetch origin main --quiet
[ -z "$(git status --porcelain)" ] || fail "working tree is dirty"
head="$(git rev-parse HEAD)"
origin="$(git rev-parse origin/main)"
[ "$head" = "$origin" ] || fail "main is not in sync with origin/main (local ${head:0:12}, origin ${origin:0:12})"

version="$(node -p "require('./packages/pelaggio/package.json').version")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "packages/pelaggio/package.json version ${version} is not semver"
tag="v${version}"

if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
	fail "local tag ${tag} already exists"
fi
if git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1; then
	fail "origin already has ${tag}"
fi
if gh release view "$tag" >/dev/null 2>&1; then
	fail "GitHub release ${tag} already exists: $(gh release view "$tag" --json url --jq .url)"
fi

ci_sha="$(gh run list --workflow=CI --branch main --event push --limit 20 --json headSha,conclusion,status,url \
	--jq ".[] | select(.headSha == \"${head}\") | [.conclusion, .status, .url] | @tsv" | head -1)"
[ -n "$ci_sha" ] || fail "no CI push run found for ${head:0:12}. Wait for CI on main, or check gh run list."
ci_conclusion="${ci_sha%%$'\t'*}"
rest="${ci_sha#*$'\t'}"
ci_status="${rest%%$'\t'*}"
ci_url="${rest#*$'\t'}"
[ "$ci_status" = "completed" ] && [ "$ci_conclusion" = "success" ] || fail "CI on ${head:0:12} is ${ci_status}/${ci_conclusion} — ${ci_url}"

prerelease_args=()
notes_args=()
case "$version" in
	*-*) prerelease_args+=(--prerelease) ;;
esac

prev="$(git tag -l 'v*' --sort=-version:refname | head -1 || true)"
notes_file=""
if [ -n "$prev" ] && [ "$prev" != "$tag" ]; then
	notes_args+=(--generate-notes --notes-start-tag "$prev")
else
	notes_file="$(mktemp)"
	trap 'rm -f "$notes_file"' EXIT
	cat >"$notes_file" <<EOF
<!-- Edit this draft, then click Publish release. That publishes pelaggio@${version} to npm. That version number cannot be reused. -->

Pelaggio ${version} is the first public npm release.

## Install

\`\`\`bash
npm install --save-dev pelaggio@${version}
npx pelaggio init
\`\`\`

See the README for prerequisites and the [trust docs](https://github.com/pelaggio/pelaggio/blob/main/docs/trust/overview.md) for what the package does and does not guarantee.
EOF
	notes_args+=(--notes-file "$notes_file")
fi

echo "Creating DRAFT GitHub release ${tag} at ${head:0:12}"
echo "This does not publish to npm. Review the notes, then click Publish release."

url="$(gh release create "$tag" \
	--draft \
	--title "pelaggio ${version}" \
	--target "$head" \
	"${prerelease_args[@]}" \
	"${notes_args[@]}")"

echo
echo "Draft: ${url}"
echo "When you publish it, GitHub Actions publishes pelaggio@${version} to npm."
echo "Rollback after that is npm deprecate, not unpublish."
