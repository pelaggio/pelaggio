#!/usr/bin/env tsx

/**
 * `claude-autopilot pr-review --pr <n>` — the CI merge-gate entry point.
 *
 * Runs a fresh-session, out-of-context agentic review of a PR diff through the
 * same `runStep` machinery the pipeline uses, parses the fail-closed gate
 * verdict, upserts a single PR comment with the findings, and sets the process
 * exit code so the `review` status check goes green (pass) or red (block).
 *
 * The **agent** produces the review; the **CLI** owns comment posting + the exit
 * code, so a refused / crashed / rate-limited agent still posts a red, failing
 * check rather than a phantom sign-off. Exit codes: 0 pass, 1 block, 2 usage.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { REPO } from "./config.js";
import { expandSkill, formatReviewMetrics, parseReviewGate } from "./helpers.js";
import { runStep } from "./step-runner.js";
import type { ParkSignal, StepEmit } from "./types.js";

const MARKER = "<!-- autopilot-pr-review -->";

/** Minimal stderr progress emitter — the pipeline's rich TUI renderer is not
 *  available (nor wanted) in a single-shot CI job. */
const emit: StepEmit = (event) => {
	switch (event.type) {
		case "step_header":
			process.stderr.write(`▶ pr-review — model=${event.model} budget=$${event.budget} maxTurns=${event.maxTurns}\n`);
			break;
		case "tool_use":
			process.stderr.write(`  · ${event.name} ${event.brief}\n`);
			break;
		case "tool_error":
			process.stderr.write(`  ✗ ${event.name}: ${event.error.slice(0, 200)}\n`);
			break;
		case "rate_limit":
			process.stderr.write(`  ⏸ rate limit (${event.limitType})\n`);
			break;
		case "sdk_error":
			process.stderr.write(`  ⚠ ${event.message}\n`);
			break;
		case "blocked":
			process.stderr.write(`  ⛔ blocked: ${event.reason}\n`);
			break;
		case "done":
			process.stderr.write(`■ done — ok=${event.ok} subtype=${event.subtype} cost=$${event.cost.toFixed(2)} turns=${event.turns}\n`);
			break;
	}
};

/** Build the PR-comment body. On a completed review, the agent's text is the
 *  body verbatim under a status header; on a failed run we post an explicit
 *  fail-closed notice so the red check is self-explaining. */
function buildComment(gate: "pass" | "block", ok: boolean, subtype: string, reviewText: string, cost: number, turns: number): string {
	const header = gate === "pass" ? "✅ **Automated review: PASS**" : "🚫 **Automated review: BLOCK**";
	// Durable, aggregatable precision signal — appended by the CLI, never seen by
	// `parseReviewGate` (which reads the agent's `result.text`, not this comment).
	const metrics = formatReviewMetrics(gate, ok, subtype, cost, turns);
	if (!ok) {
		// A truncated run (e.g. error_max_turns) may still have found real
		// blockers — the partial text is the expensive artifact, so keep it.
		const partial = reviewText.trim() ? ["", "Partial review output (run did not complete — may be incomplete):", "", reviewText.trim()] : [];
		return [
			MARKER,
			"🚫 **Automated review could not complete — failing closed**",
			"",
			`The review step exited without a clean verdict (\`${subtype}\`), so this gate blocks the merge. Re-run the workflow once the cause (rate limit, refusal, or transient SDK error) clears.`,
			...partial,
			"",
			`<sub>autopilot pr-review · ${subtype}</sub>`,
			metrics,
		].join("\n");
	}
	return [MARKER, header, "", reviewText.trim(), "", `<sub>autopilot pr-review · ${subtype}</sub>`, metrics].join("\n");
}

/** Upsert the single gate comment. Best-effort: a posting failure must not
 *  change the exit code (the gate color must still reflect the verdict). */
function upsertComment(pr: string, body: string): void {
	try {
		execFileSync("gh", ["pr", "comment", pr, "--edit-last", "--create-if-none", "--body-file", "-"], {
			cwd: REPO,
			input: body,
			stdio: ["pipe", "ignore", "pipe"],
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		process.stderr.write(`⚠ failed to upsert PR comment: ${msg}\n`);
	}
}

export async function main(argv: string[]): Promise<number> {
	let values: { pr?: string; profile?: string };
	try {
		({ values } = parseArgs({
			args: argv,
			options: { pr: { type: "string" }, profile: { type: "string" } },
			allowPositionals: false,
		}));
	} catch (e) {
		process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
		process.stderr.write("usage: claude-autopilot pr-review --pr <number> [--profile <name>]\n");
		return 2;
	}

	const pr = values.pr;
	if (!pr || !/^\d+$/.test(pr)) {
		process.stderr.write("usage: claude-autopilot pr-review --pr <number> [--profile <name>]\n");
		return 2;
	}
	const profile = values.profile ?? "standard";

	// Everything past arg-parsing runs under a fail-closed guard: if the review
	// throws (expandSkill can't find the skill, runStep hits an uncaught SDK
	// error), we still post a self-explaining red comment and exit 1 rather than
	// crash silently. The gate's whole value is that a crashed agent never reads
	// as a merge-clear sign-off.
	try {
		const prompt = expandSkill("pr-review", `--pr ${pr}`);
		const parkSignal: ParkSignal = { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };

		const result = await runStep("pr-review", prompt, { cwd: REPO, profile, trace: false, parkSignal, itemId: pr }, emit);

		const gate = parseReviewGate(result.text, result.ok);

		// The review text goes to stdout unconditionally so the CI log always
		// carries the findings — a failed comment upsert (or a truncated run)
		// must not be able to lose the only copy of a $-priced review.
		if (result.text.trim()) process.stdout.write(`\n${result.text.trim()}\n\n`);

		upsertComment(pr, buildComment(gate, result.ok, result.subtype, result.text, result.cost, result.turns));

		process.stderr.write(`gate: ${gate.toUpperCase()} (ok=${result.ok})\n`);
		return gate === "block" ? 1 : 0;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		process.stderr.write(`pr-review crashed — failing closed: ${msg}\n`);
		upsertComment(pr, buildComment("block", false, "error_crash", "", 0, 0));
		return 1;
	}
}

// Run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main(process.argv.slice(2)).then((code) => process.exit(code));
}
