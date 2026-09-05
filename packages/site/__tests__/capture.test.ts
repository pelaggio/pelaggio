import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const capture = fileURLToPath(new URL("../../../experiments/model-delivery/capture.mjs", import.meta.url));

function runCapture(operatorInterventions: unknown, check: (result: ReturnType<typeof spawnSync>, output: string) => void) {
	const directory = mkdtempSync(join(tmpdir(), "capture-history-"));
	try {
		const metadata = join(directory, "execution.json");
		const output = join(directory, "capture");
		writeFileSync(metadata, JSON.stringify({ harnessSha: "new-execution", operatorInterventions, scenarios: {} }));
		check(spawnSync(process.execPath, [capture, metadata, output], { encoding: "utf8" }), output);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("a fresh capture never inherits interventions from the original demonstration", () => {
	for (const entries of [[], ["Resumed this run after a provider rate limit."]]) {
		runCapture(entries, (result, output) => {
			assert.equal(result.status, 0, String(result.stderr));
			assert.deepEqual(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")).operatorInterventions, entries);
		});
	}
});

test("missing or malformed intervention history requires correction before capture writes", () => {
	for (const entries of [undefined, null, "none", [42], [""]]) {
		runCapture(entries, (result, output) => {
			assert.notEqual(result.status, 0);
			assert.match(String(result.stderr), /execution.json must contain operatorInterventions/);
			assert.equal(existsSync(output), false);
		});
	}
});
