#!/usr/bin/env bash

set -o pipefail

receipts="$(
	node --import tsx ci/assurance-observations.ts --node-test-args |
		PELAGGIO_REPO=. xargs -0 -r -n 2 bash -c '
			node --import tsx --test --experimental-test-isolation=none --test-concurrency=1 \
				--test-reporter=./ci/assurance-observation-reporter.mjs "$1" "$2"
		' _ |
		node --import tsx ci/assurance-observations.ts --resolve-test-events
)"
observation_status=$?

PELAGGIO_ASSURANCE_OBSERVATION_RESULTS="$receipts" node --import tsx --test --test-reporter=dot ci/__tests__/*.test.ts
graph_status=$?

if (( observation_status != 0 )); then
	exit "$observation_status"
fi
exit "$graph_status"
