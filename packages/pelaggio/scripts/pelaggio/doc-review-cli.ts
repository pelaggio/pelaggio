#!/usr/bin/env tsx

/**
 * `pelaggio doc-review <path>` — provider-diverse, read-only review of an arbitrary document (#384).
 *
 * Reuses the authoring-loop panel machinery (seat fan-out, finding normalize/dedupe, Judge
 * completeness, diversity recording, report serialization) via `runReviewLoop` in its typed
 * `mode: "no-revise"` — the revision seat, claim branch, feature worktree, and Step lifecycle are all
 * out of reach by construction. The document is bound to its sha256 byte digest: read once, injected
 * identically into every seat, and re-verified before a success-bound report is written.
 *
 * Exit codes: 0 = converged-clean | converged-with-notes | ceiling; 1 = hard-block | dissent | budget
 * (rate-limit park) | crash | digest-changed; 2 = usage / missing path.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type AuthoringReviewConfig, CONFIG, modelForProvider, type ResolvedConfig, type ReviewSlot, resolveStepSettings, type StepSettings } from "./config.js";
import { expandPackagedSkill } from "./helpers.js";
import { detectCliUnattendedSignals } from "./provider-routing.js";
import { assertDocumentUnchanged, type DocumentSnapshot, documentInjectionState, formatDocumentUnderReview, snapshotDocument } from "./review/document.js";
import type { ReviewOutcome } from "./review/loop.js";
import { runReviewLoop } from "./review/loop.js";
import { type DocReviewRecord, renderDocReviewRecord, writeDocReviewRecord } from "./review/record.js";
import { type RunStepFn, runStep } from "./step-runner.js";
import type { ParkSignal, StepEmit } from "./types.js";

/** Recorded honest pin: the code-diff path-signal taxonomy is not the right floor for a bare document. */
export const DOC_REVIEW_SAFETY_FLOOR_NOTE = "document review: code-diff path-signal floor not applied";

/** Outcomes that clear the gate (exit 0). Everything else exits 1. */
const PASS_OUTCOMES = new Set<ReviewOutcome>(["converged-clean", "converged-with-notes", "ceiling"]);

const USAGE = "usage: pelaggio doc-review <path> [--profile <name>] [--json] [--out <report.json>]";

interface DocReviewDeps {
	runStep: RunStepFn;
	snapshotDocument: typeof snapshotDocument;
	assertDocumentUnchanged: typeof assertDocumentUnchanged;
	/** Injected clock for a deterministic runId/createdAt in tests. */
	clock: () => number;
}

let deps: DocReviewDeps = {
	runStep,
	snapshotDocument,
	assertDocumentUnchanged,
	clock: () => Date.now(),
};

export function setDocReviewDepsForTests(overrides: Partial<DocReviewDeps>): () => void {
	const previous = deps;
	deps = { ...deps, ...overrides };
	return () => {
		deps = previous;
	};
}

/** Minimal stderr progress emitter — the pipeline's TUI renderer is neither available nor wanted here. */
const emit: StepEmit = (event) => {
	switch (event.type) {
		case "step_header":
			process.stderr.write(`▶ doc-review — model=${event.model} budget=$${event.budget} maxTurns=${event.maxTurns}\n`);
			break;
		case "tool_error":
			process.stderr.write(`  ✗ ${event.name}: ${event.error.slice(0, 200)}\n`);
			break;
		case "rate_limit":
			process.stderr.write(`  ⏸ rate limit (${event.limitType})\n`);
			break;
		case "sdk_error":
			process.stderr.write(`  ✗ SDK error: ${event.message}\n`);
			break;
		case "done":
			process.stderr.write(`■ done — ok=${event.ok} subtype=${event.subtype} cost=$${event.cost.toFixed(2)} turns=${event.turns}\n`);
			break;
	}
};

/** Fill a configured reviewer/judge slot's model from the step defaults (mirrors resolveAuthoringReviewConfig). */
function fillReviewSlot(slot: ReviewSlot, defaults: StepSettings): ReviewSlot {
	if (slot.provider === "codex") {
		const codexModel = slot.codexModel ?? defaults.codexModel;
		return codexModel ? { ...slot, codexModel } : { ...slot };
	}
	// Fill a non-Codex seat from that provider's own step-settings slot, never the top-level
	// Claude `model` slot (#431).
	const model = slot.model ?? modelForProvider(defaults, slot.provider);
	return model ? { ...slot, model } : { ...slot };
}

/**
 * Doc-review seating: keep every configured reviewer (no author to exclude), fill reviewer models from
 * `pr-review` and the judge from `pr-verify`, and force `maxRevisions: 0`. No capability matching — the
 * pipeline needs it because it pre-creates seat worktrees; doc-review creates none, so an unavailable
 * provider simply fails its `runStep` and is recorded as a not-completed seat.
 */
export function resolveDocReviewPolicy(config: ResolvedConfig, profile: string): AuthoringReviewConfig {
	const policy = config.review.authoring;
	const reviewerDefaults = resolveStepSettings(config, profile, "pr-review");
	const judgeDefaults = resolveStepSettings(config, profile, "pr-verify");
	return {
		...policy,
		reviewers: policy.reviewers.map((slot) => fillReviewSlot(slot, reviewerDefaults)),
		judge: fillReviewSlot(policy.judge, judgeDefaults),
		maxRevisions: 0,
	};
}

function executionOverrideFor(slot: ReviewSlot) {
	return { provider: slot.provider, ...(slot.provider === "codex" ? (slot.codexModel ? { codexModel: slot.codexModel } : {}) : slot.model ? { model: slot.model } : {}) };
}

function emptyParkSignal(): ParkSignal {
	return { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };
}

export interface DocReviewOptions {
	/** Pre-taken snapshot (read once, digest bound). */
	snapshot: DocumentSnapshot;
	profile?: string;
	cwd?: string;
	config?: ResolvedConfig;
	runStep?: RunStepFn;
	clock?: () => number;
	/**
	 * #279: unattended-execution evidence threaded into every seat's `RunStepOpts` for
	 * provider-level auth gates (grok transparent subscription auth). Defaults to the
	 * ambient CLI evidence (`detectCliUnattendedSignals`).
	 */
	unattendedSignals?: readonly string[];
}

export interface DocReviewResult {
	exitCode: 0 | 1;
	outcome: ReviewOutcome | "digest-changed";
	record?: DocReviewRecord;
	recordPath?: string;
	/** Human markdown summary (default stdout). */
	body: string;
}

/**
 * Run the no-revise panel over an already-snapshotted document, re-verify the digest, and write a
 * path+digest-bound record. Never creates a worktree, claim branch, or roadmap item; never revises.
 */
export async function reviewDocument(options: DocReviewOptions): Promise<DocReviewResult> {
	const config = options.config ?? CONFIG;
	const profile = options.profile ?? "standard";
	const cwd = options.cwd ?? process.cwd();
	const runStepImpl = options.runStep ?? deps.runStep;
	const clock = options.clock ?? deps.clock;
	const { snapshot } = options;
	const policy = resolveDocReviewPolicy(config, profile);
	const parkSignal = emptyParkSignal();
	const documentBlock = formatDocumentUnderReview(snapshot, documentInjectionState(snapshot));
	// #279: ambient unattended evidence for provider-level auth gates (grok transparent
	// subscription auth). Attestation suppressions are echoed so they are never silent.
	let unattendedSignals = options.unattendedSignals;
	if (unattendedSignals === undefined) {
		const ambient = detectCliUnattendedSignals();
		if (ambient.suppressed.length > 0) process.stderr.write(`${ambient.suppressed.join("; ")}\n`);
		unattendedSignals = ambient.signals;
	}

	const loop = await runReviewLoop({
		policy,
		mode: "no-revise",
		parkSignal,
		// changedFiles is not consulted by the classifier; the disabled floor is what makes the honest record.
		classificationContext: { changedFiles: [] },
		// The real taxonomy still drives emission-time forensic classification on each finding.
		taxonomy: config.review.taxonomy,
		safetyFloor: "disabled",
		safetyFloorNote: DOC_REVIEW_SAFETY_FLOOR_NOTE,
		runSeat: async ({ role, slot, prompt, parkSignal: child }) =>
			runStepImpl(role === "judge" ? "pr-verify" : "pr-review", prompt, { cwd, profile, trace: false, parkSignal: child, executionOverride: executionOverrideFor(slot), unattendedSignals }, emit),
		prompts: {
			review: () => `${expandPackagedSkill("pr-review", "--document")}\n\n${documentBlock}`,
			judge: (candidates) => `${expandPackagedSkill("pr-verify", "--authoring-loop-judge")}\n\nTRUSTED_CANDIDATE_DATA\n${JSON.stringify(candidates)}\nEND_TRUSTED_CANDIDATE_DATA`,
		},
	});

	// Re-verify the digest before writing a success-bound report. A file changed / removed during the
	// review invalidates the binding — fail closed with no report (exit 1), never a stale success.
	try {
		deps.assertDocumentUnchanged(snapshot);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { exitCode: 1, outcome: "digest-changed", body: `🚫 doc-review aborted — ${message}\n\nNo report written: the reviewed bytes no longer match the file on disk.` };
	}

	const ms = clock();
	const runId = `doc-${snapshot.digest.slice(0, 12)}-${ms.toString(36)}`;
	const record: DocReviewRecord = {
		schemaVersion: 1,
		runId,
		createdAt: new Date(ms).toISOString(),
		document: { path: snapshot.path, digest: snapshot.digest, byteLength: snapshot.byteLength },
		blockingBar: "must-fix",
		safetyFloor: "disabled",
		safetyFloorNote: DOC_REVIEW_SAFETY_FLOOR_NOTE,
		result: loop,
	};
	const recordPath = writeDocReviewRecord(cwd, record);
	const exitCode: 0 | 1 = PASS_OUTCOMES.has(loop.outcome) ? 0 : 1;
	const body = `${renderDocReviewRecord(record)}\n\nReport: ${recordPath}`;
	return { exitCode, outcome: loop.outcome, record, recordPath, body };
}

export async function main(argv: string[]): Promise<number> {
	let values: { profile?: string; json?: boolean; out?: string };
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args: argv,
			options: { profile: { type: "string" }, json: { type: "boolean" }, out: { type: "string" } },
			allowPositionals: true,
		}));
	} catch (e) {
		process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
		return 2;
	}
	if (positionals.length !== 1) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}

	let snapshot: DocumentSnapshot;
	try {
		snapshot = deps.snapshotDocument(positionals[0]);
	} catch (e) {
		process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
		return 2;
	}

	try {
		const result = await reviewDocument({ snapshot, profile: values.profile });
		if (values.out && result.record) writeFileSync(values.out, `${JSON.stringify(result.record, null, 2)}\n`, "utf-8");
		process.stdout.write(`${values.json && result.record ? JSON.stringify(result.record, null, 2) : result.body}\n`);
		process.stderr.write(`doc-review: ${result.outcome} (exit ${result.exitCode})\n`);
		return result.exitCode;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		process.stderr.write(`doc-review crashed — failing closed: ${msg}\n`);
		return 1;
	}
}

// Run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main(process.argv.slice(2)).then((code) => process.exit(code));
}
