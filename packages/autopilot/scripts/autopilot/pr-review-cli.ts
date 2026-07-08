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
import { classifySecurityReviewDiff, expandSkill, formatReviewMetrics, parseReviewGate, type SecurityDiffSignal } from "./helpers.js";
import type { RunStepFn } from "./step-runner.js";
import { runStep } from "./step-runner.js";
import type { ParkSignal, StepEmit, StepResult } from "./types.js";

const MARKER = "<!-- autopilot-pr-review -->";
type ReviewLabel = "standard" | "red-team";

interface ReviewPass {
	label: ReviewLabel;
	result: StepResult;
	gate: "pass" | "block";
}

interface PrReviewDeps {
	runStep: RunStepFn;
	execFileSync: typeof execFileSync;
	upsertComment: (pr: string, body: string) => void;
}

let deps: PrReviewDeps = {
	runStep,
	execFileSync,
	upsertComment: upsertCommentDefault,
};

export function setPrReviewDepsForTests(overrides: Partial<PrReviewDeps>): () => void {
	const previous = deps;
	deps = { ...deps, ...overrides };
	return () => {
		deps = previous;
	};
}

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

function aggregateSubtype(passes: readonly ReviewPass[]): string {
	const failed = passes.filter((pass) => pass.gate === "block" || !pass.result.ok);
	if (failed.length === 0) return "success";
	if (failed.length === 1) return `${failed[0].label}:${failed[0].result.subtype}`;
	return "multiple";
}

function renderPass(pass: ReviewPass): string {
	const title = pass.label === "standard" ? "Standard Review" : "Adversarial Red-Team Review";
	const text = pass.result.text.trim();
	if (pass.result.ok) return [`## ${title}`, "", text || "(No review text returned.)"].join("\n");
	const partial = text ? ["", "Partial review output (run did not complete — may be incomplete):", "", text] : [];
	return [`## ${title}`, "", `Run did not complete cleanly (\`${pass.result.subtype}\`) — failing this pass closed.`, ...partial].join("\n");
}

/** Build the PR-comment body. The agent text is preserved under per-pass
 *  sections; aggregate status and metrics live in the CLI-owned wrapper. */
function buildComment(gate: "pass" | "block", passes: readonly ReviewPass[], securitySignal: SecurityDiffSignal): string {
	const header = gate === "pass" ? "✅ **Automated review: PASS**" : "🚫 **Automated review: BLOCK**";
	const ok = passes.every((pass) => pass.result.ok);
	const subtype = aggregateSubtype(passes);
	const cost = passes.reduce((sum, pass) => sum + pass.result.cost, 0);
	const turns = passes.reduce((sum, pass) => sum + pass.result.turns, 0);
	// Durable, aggregatable precision signal — appended by the CLI, never seen by
	// `parseReviewGate` (which reads the agent's `result.text`, not this comment).
	const metrics = formatReviewMetrics(gate, ok, subtype, cost, turns);
	const redTeamLine = securitySignal.triggered ? `Triggered: ${securitySignal.reasons.join(", ")}` : "Adversarial red-team pass: not triggered (no security-sensitive paths or diff signals).";
	return [MARKER, header, "", ...passes.map(renderPass), "", redTeamLine, "", `<sub>autopilot pr-review · ${subtype}</sub>`, metrics].join("\n");
}

function buildFailClosedComment(subtype: string, message: string): string {
	const result: StepResult = { ok: false, subtype, text: message, fullText: message, cost: 0, turns: 0 };
	const pass: ReviewPass = { label: "standard", result, gate: "block" };
	return buildComment("block", [pass], { triggered: false, reasons: [] });
}

/** Upsert the single gate comment. Best-effort: a posting failure must not
 *  change the exit code (the gate color must still reflect the verdict). */
function upsertCommentDefault(pr: string, body: string): void {
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

function emptyParkSignal(): ParkSignal {
	return { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };
}

function readSecuritySignal(): SecurityDiffSignal {
	const files = deps
		.execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
			cwd: REPO,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		})
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const diff = deps.execFileSync("git", ["diff", "origin/main...HEAD"], {
		cwd: REPO,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return classifySecurityReviewDiff(files, diff);
}

async function runReviewPass(label: ReviewLabel, args: string, profile: string, pr: string): Promise<ReviewPass> {
	process.stderr.write(`▶ pr-review ${label}\n`);
	const prompt = expandSkill("pr-review", args);
	const result = await deps.runStep("pr-review", prompt, { cwd: REPO, profile, trace: false, parkSignal: emptyParkSignal(), itemId: pr }, emit);
	return { label, result, gate: parseReviewGate(result.text, result.ok) };
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
		let securitySignal: SecurityDiffSignal;
		try {
			securitySignal = readSecuritySignal();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const body = buildFailClosedComment("error_diff", `Could not inspect the PR diff for security-sensitive changes, so this gate blocks the merge.\n\n${msg}`);
			process.stderr.write(`pr-review could not inspect diff — failing closed: ${msg}\n`);
			deps.upsertComment(pr, body);
			return 1;
		}

		const passes: ReviewPass[] = [];
		passes.push(await runReviewPass("standard", `--pr ${pr}`, profile, pr));
		if (securitySignal.triggered) {
			const reasonsArg = JSON.stringify(securitySignal.reasons.join(", "));
			passes.push(await runReviewPass("red-team", `--pr ${pr} --red-team --security-reasons ${reasonsArg}`, profile, pr));
		}

		const gate = passes.some((pass) => pass.gate === "block") ? "block" : "pass";
		const ok = passes.every((pass) => pass.result.ok);

		// The review text goes to stdout unconditionally so the CI log always
		// carries the findings — a failed comment upsert (or a truncated run)
		// must not be able to lose the only copy of a $-priced review.
		for (const pass of passes) {
			if (pass.result.text.trim()) process.stdout.write(`\n[${pass.label}]\n${pass.result.text.trim()}\n\n`);
		}

		deps.upsertComment(pr, buildComment(gate, passes, securitySignal));

		process.stderr.write(`gate: ${gate.toUpperCase()} (ok=${ok})\n`);
		return gate === "block" ? 1 : 0;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		process.stderr.write(`pr-review crashed — failing closed: ${msg}\n`);
		deps.upsertComment(pr, buildFailClosedComment("error_crash", `pr-review crashed before producing a review, so this gate blocks the merge.\n\n${msg}`));
		return 1;
	}
}

// Run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main(process.argv.slice(2)).then((code) => process.exit(code));
}
