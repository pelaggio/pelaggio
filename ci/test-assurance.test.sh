#!/usr/bin/env bash

set -eu

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

cat > "$fixture/node" <<'EOF'
#!/usr/bin/env bash
case " $* " in
	*" --node-test-args "*)
		printf '%s\0%s\0' '--test-name-pattern=fixture' 'fixture.test.ts'
		;;
	*" --resolve-test-events "*)
		printf '%s' '["receipt"]'
		exit "${OBSERVATION_STATUS}"
		;;
	*" ci/__tests__/"*)
		printf '%s' "${PELAGGIO_ASSURANCE_OBSERVATION_RESULTS-}" > "${GRAPH_MARKER}"
		exit "${GRAPH_STATUS}"
		;;
esac
EOF
chmod +x "$fixture/node"

run_case() {
	observation_status="$1"
	graph_status="$2"
	expected_status="$3"
	marker="$fixture/graph-ran"
	rm -f "$marker"

	set +e
	PATH="$fixture:$PATH" \
		OBSERVATION_STATUS="$observation_status" \
		GRAPH_STATUS="$graph_status" \
		GRAPH_MARKER="$marker" \
		bash ci/test-assurance.sh >/dev/null 2>&1
	actual_status=$?
	set -e

	if [[ "$actual_status" -ne "$expected_status" ]]; then
		echo "expected status $expected_status, got $actual_status" >&2
		exit 1
	fi
	if [[ ! -f "$marker" ]]; then
		echo "graph diagnostics did not run" >&2
		exit 1
	fi
	if [[ "$(<"$marker")" != '["receipt"]' ]]; then
		echo "graph diagnostics did not receive generated receipts" >&2
		exit 1
	fi
}

run_case 1 0 1
run_case 0 0 0
run_case 0 7 7
