#!/usr/bin/env bash

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fixture="$(mktemp -d "$repo/.dev/assurance-mutation-XXXXXX")"
trap 'rm -rf "$fixture"' EXIT

control_id="CTR-0008"
mechanism_path="packages/server/src/auth.ts"
observation_path="packages/server/__tests__/auth.test.ts"
observation_id="correct token authenticates state changes"
mechanism_target="$fixture/$mechanism_path"
observation_target="$fixture/$observation_path"

mkdir -p "$(dirname "$mechanism_target")" "$(dirname "$observation_target")"
ln -s "$repo/packages/server/node_modules" "$fixture/packages/server/node_modules"

node - "$repo" "$fixture" "$control_id" "$mechanism_path" "$observation_path" "$observation_id" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const [repo, fixture, controlId, mechanismPath, observationPath, observationId] = process.argv.slice(2);
const graph = JSON.parse(readFileSync(resolve(repo, "docs/assurance/shadow-graph.json"), "utf8"));
const control = graph.nodes.find((node) => node.id === controlId);
const expected = [{ kind: "test", id: observationId, path: observationPath }];
if (control?.kind !== "realization" || JSON.stringify(control.observations) !== JSON.stringify(expected)) {
	throw new Error(`${controlId} no longer declares the mutation proof's exact observation`);
}

const source = readFileSync(resolve(repo, mechanismPath), "utf8");
const handoff = "\t\tawait next();";
if (source.split(handoff).length !== 2) throw new Error(`${mechanismPath}: auth success handoff must occur exactly once`);
const hollowed = source.replace(handoff, '\t\treturn c.json({ error: "hollowed auth mechanism", code: "unauthorized" }, 401);');
writeFileSync(resolve(fixture, mechanismPath), hollowed);
writeFileSync(resolve(fixture, observationPath), readFileSync(resolve(repo, observationPath)));
NODE

live_events="$(
	cd "$repo"
	node --import tsx --test --experimental-test-isolation=none --test-concurrency=1 \
		--test-reporter=./ci/assurance-observation-reporter.mjs \
		"--test-name-pattern=^${observation_id}$" "$repo/$observation_path"
)"

set +e
events="$(
	cd "$repo"
	node --import tsx --test --experimental-test-isolation=none --test-concurrency=1 \
		--test-reporter=spec --test-reporter-destination="$fixture/spec.log" \
		--test-reporter=./ci/assurance-observation-reporter.mjs \
		--test-reporter-destination=stdout \
		"--test-name-pattern=^${observation_id}$" "$observation_target"
)"
test_status=$?
set -e

if [[ "$test_status" -ne 1 ]]; then
	echo "expected hollowed $control_id observation to fail with status 1, got $test_status" >&2
	exit 1
fi

LIVE_EVENTS="$live_events" LIVE_OBSERVATION_PATH="$repo/$observation_path" MUTATION_EVENTS="$events" MUTATION_OBSERVATION_ID="$observation_id" MUTATION_OBSERVATION_PATH="$observation_target" MUTATION_SPEC_LOG="$fixture/spec.log" node <<'NODE'
const { readFileSync, realpathSync } = require("node:fs");

function exactEvents(encoded, path) {
	const expectedFile = realpathSync(path);
	return encoded
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter(
			(event) => event.data?.details?.type !== "suite" && event.data?.name === process.env.MUTATION_OBSERVATION_ID && event.data?.file && realpathSync(event.data.file) === expectedFile,
		);
}

const live = exactEvents(process.env.LIVE_EVENTS ?? "", process.env.LIVE_OBSERVATION_PATH);
if (live.length !== 1 || live[0].type !== "test:pass") {
	throw new Error(`live control must produce one exact test:pass receipt; got ${JSON.stringify(live)}`);
}
const mutated = exactEvents(process.env.MUTATION_EVENTS ?? "", process.env.MUTATION_OBSERVATION_PATH);
if (mutated.length !== 1 || mutated[0].type !== "test:fail") {
	throw new Error(`mutation must produce one exact test:fail receipt; got ${JSON.stringify(mutated)}\n${readFileSync(process.env.MUTATION_SPEC_LOG, "utf8")}`);
}
NODE
