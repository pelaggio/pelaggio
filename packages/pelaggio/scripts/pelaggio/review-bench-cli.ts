#!/usr/bin/env tsx

/**
 * `pelaggio review-bench --replay` — deterministic, zero-LLM Tier A authoring-review benchmark (#291).
 *
 * Replays committed reviewer/Judge recordings through the real `runReviewLoop` and scores the resulting
 * gate decisions against human goldens and a committed recall/safety-FN baseline. This path makes NO
 * provider/SDK call and inspects no API keys — the replay module (`review/bench.ts`) never imports
 * provider execution, `runStep`, config credentials, or the SDK, so the guarantee is structural.
 *
 * Only `--replay` is a valid mode in this slice; the deferred live/record path (Tier B) is rejected with
 * a usage error rather than silently ignored.
 *
 * Exit codes: 0 = every golden matched and no baseline regression; 1 = golden mismatch, baseline
 * regression, or a malformed corpus; 2 = usage error.
 */

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type BenchCorpus, type BenchReplayResult, loadBenchCorpus, renderReplayReport, runReplay } from "./review/bench.js";

const USAGE = "usage: pelaggio review-bench --replay [--json]";

export interface BenchCliDeps {
	/** Corpus directory override (defaults to the packaged fixtures resolved by `loadBenchCorpus`). */
	corpusDir?: string;
	loadCorpus: (corpusDir?: string) => BenchCorpus;
	runReplay: (corpus: BenchCorpus) => Promise<BenchReplayResult>;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

function defaultDeps(): BenchCliDeps {
	return {
		loadCorpus: loadBenchCorpus,
		runReplay,
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
	};
}

export async function main(argv: string[], overrides: Partial<BenchCliDeps> = {}): Promise<number> {
	const deps = { ...defaultDeps(), ...overrides };
	let values: { replay?: boolean; json?: boolean; live?: boolean; record?: boolean };
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args: argv,
			options: { replay: { type: "boolean" }, json: { type: "boolean" }, live: { type: "boolean" }, record: { type: "boolean" } },
			allowPositionals: true,
		}));
	} catch (error) {
		deps.stderr(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
		return 2;
	}
	// Tier B (--live / --record) is deferred; reject it explicitly so it is never a silent no-op.
	if (values.live || values.record) {
		deps.stderr(`review-bench: --live and --record are not available in this build (Tier A replay only)\n${USAGE}\n`);
		return 2;
	}
	if (positionals.length > 0) {
		deps.stderr(`unexpected argument: ${positionals[0]}\n${USAGE}\n`);
		return 2;
	}
	if (!values.replay) {
		deps.stderr(`review-bench requires --replay\n${USAGE}\n`);
		return 2;
	}

	let result: BenchReplayResult;
	try {
		const corpus = deps.loadCorpus(deps.corpusDir);
		result = await deps.runReplay(corpus);
	} catch (error) {
		deps.stderr(`review-bench: corpus failed to load or replay — ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}

	deps.stdout(`${values.json ? JSON.stringify(result, null, 2) : renderReplayReport(result)}\n`);
	return result.ok ? 0 : 1;
}

// Run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main(process.argv.slice(2)).then((code) => process.exit(code));
}
