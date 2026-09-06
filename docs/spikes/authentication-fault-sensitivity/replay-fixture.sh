#!/usr/bin/env bash
# Replay one disposable auth-fault fixture. Not a CI runner.
# Usage: replay-fixture.sh <label> [patch-file]
# label: control | c1 | c2 | c3
# cwd must be the worktree root. Copies are under .dev/ (gitignored).

set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
	echo "usage: $0 <label> [patch-file]" >&2
	exit 2
fi

label="$1"
patch_file="${2:-}"
repo="$(pwd -P)"
evid="$repo/docs/spikes/authentication-fault-sensitivity"
expected_auth_hash="${EXPECTED_AUTH_SHA256:-}"

mkdir -p "$repo/.dev"
fixture="$(mktemp -d "$repo/.dev/assurance-mutation-XXXXXX")"
echo "$fixture" > "$evid/${label}-fixture-path.txt"

mkdir -p "$fixture/packages/server/__tests__"
cp -a "$repo/packages/server/src" "$fixture/packages/server/src"
cp "$repo/packages/server/package.json" "$fixture/packages/server/package.json"
cp "$repo/packages/server/__tests__/auth.test.ts" "$fixture/packages/server/__tests__/auth.test.ts"
cp "$repo/packages/server/__tests__/app.test.ts" "$fixture/packages/server/__tests__/app.test.ts"
ln -s "$repo/packages/server/node_modules" "$fixture/packages/server/node_modules"

if [[ -n "$patch_file" ]]; then
	(cd "$fixture" && patch -p0 --forward --batch < "$repo/$patch_file") > "$evid/${label}-patch-apply.txt"
fi

node --input-type=module - "$repo" "$fixture" "$evid" "$label" "$expected_auth_hash" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const [repo, fixture, evid, label, expected] = process.argv.slice(2);
const appTs = realpathSync(join(fixture, "packages/server/src/app.ts"));
const authFromApp = realpathSync(join(dirname(appTs), "auth.ts"));
const fixtureAuth = realpathSync(join(fixture, "packages/server/src/auth.ts"));
const liveAuth = realpathSync(join(repo, "packages/server/src/auth.ts"));
if (existsSync(join(dirname(appTs), "auth.js"))) {
	throw new Error("compiled auth.js would shadow fixture auth.ts");
}
if (authFromApp !== fixtureAuth) {
	throw new Error(`bind failed: app.ts ./auth.ts realpath ${authFromApp} !== ${fixtureAuth}`);
}
if (fixtureAuth === liveAuth) {
	throw new Error("fixture auth realpath is the live checkout; copy-set bind failed");
}
const hash = createHash("sha256").update(readFileSync(fixtureAuth)).digest("hex");
if (expected && hash !== expected) {
	throw new Error(`fixture auth sha256 ${hash} !== expected ${expected}`);
}
const bind = {
	label,
	fixture,
	appTs,
	authFromApp,
	fixtureAuth,
	liveAuth,
	authSha256: hash,
	authTestSha256: createHash("sha256").update(readFileSync(join(fixture, "packages/server/__tests__/auth.test.ts"))).digest("hex"),
	appTestSha256: createHash("sha256").update(readFileSync(join(fixture, "packages/server/__tests__/app.test.ts"))).digest("hex"),
	packageJsonSha256: createHash("sha256").update(readFileSync(join(fixture, "packages/server/package.json"))).digest("hex"),
	bindOk: true,
};
writeFileSync(join(evid, `${label}-bind.json`), `${JSON.stringify(bind, null, "\t")}\n`);
console.log(JSON.stringify(bind));
NODE

auth_test="$fixture/packages/server/__tests__/auth.test.ts"
app_test="$fixture/packages/server/__tests__/app.test.ts"

{
	echo "cwd=$repo"
	echo "fixture=$fixture"
	echo "label=$label"
	echo "patch=${patch_file:-none}"
	echo "node --import tsx --test --experimental-test-isolation=none --test-concurrency=1 --test-timeout=60000 --test-reporter=spec --test-reporter-destination=$evid/${label}-spec.txt --test-reporter=./ci/assurance-observation-reporter.mjs --test-reporter-destination=$evid/${label}-observations.jsonl $auth_test $app_test"
} > "$evid/${label}-command.txt"

set +e
node --import tsx --test --experimental-test-isolation=none --test-concurrency=1 --test-timeout=60000 \
	--test-reporter=spec --test-reporter-destination="$evid/${label}-spec.txt" \
	--test-reporter=./ci/assurance-observation-reporter.mjs --test-reporter-destination="$evid/${label}-observations.jsonl" \
	"$auth_test" "$app_test" \
	> "$evid/${label}-stdout.txt" 2> "$evid/${label}-stderr.txt"
status=$?
set -e
echo "$status" > "$evid/${label}-exit.txt"
echo "label=$label fixture=$fixture exit=$status"

# Keep referenced receipts; drop the scratch copy.
rm -rf "$fixture"
exit 0
