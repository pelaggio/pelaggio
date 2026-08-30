#!/usr/bin/env tsx

/**
 * `pelaggio pr-review --pr <n>` — thin entry over `pr-review-gate.ts`. Parses argv, runs the
 * gate fail-closed, posts the required status + marker comment, and exits. The gate body and
 * its test seam live in `pr-review-gate.ts` (L4); nothing imports this file except the bin.
 */

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CONFIG, REPO, ROADMAP_GITHUB } from "./config.js";
import { mainWorktree } from "./helpers.js";
import { buildFailClosedComment, persistLocalGateEvidence, prReviewDeps, resolveCarryOptions, resolveReviewedHead, runPrReviewGate } from "./pr-review-gate.js";
import { gateRecordsDir } from "./pr-review-gate-record.js";
import { adjudicationSourcesDir } from "./review/adjudication.js";
import { prFindingDispositionsDir } from "./review/carry.js";

export async function main(argv: string[]): Promise<number> {
	const deps = prReviewDeps();
	let values: { pr?: string; profile?: string };
	try {
		({ values } = parseArgs({
			args: argv,
			options: { pr: { type: "string" }, profile: { type: "string" } },
			allowPositionals: false,
		}));
	} catch (e) {
		process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
		process.stderr.write("usage: pelaggio pr-review --pr <number> [--profile <name>]\n");
		return 2;
	}

	const pr = values.pr;
	if (!pr || !/^\d+$/.test(pr)) {
		process.stderr.write("usage: pelaggio pr-review --pr <number> [--profile <name>]\n");
		return 2;
	}
	const profile = values.profile ?? "standard";

	// Everything past arg-parsing runs under a fail-closed guard: if the review
	// throws (expandSkill can't find the skill, runStep hits an uncaught SDK
	// error), we still post a self-explaining red comment and exit 1 rather than
	// crash silently. The gate's whole value is that a crashed agent never reads
	// as a merge-clear sign-off.
	// Pin the reviewed SHA before the review runs so both the success and the
	// fail-closed paths post the required status to the exact commit inspected,
	// never to a live remote head that may have advanced during the review. If
	// even this resolution fails we post no status at all — an absent required
	// status leaves the PR blocked, which is the safe (fail-closed) outcome.
	let reviewedSha: string | undefined;
	try {
		const head = resolveReviewedHead(deps.execFileSync, pr, ROADMAP_GITHUB.ghRepo);
		reviewedSha = head.sha;
		// #495: cross-push carry is a local-runner mechanism (I4) behind the review.carry
		// kill-switch. CI, non-claim heads, and `review.carry: false` read nothing — the run is
		// byte-identical to today (records are still written below, so re-enabling has priors).
		const policy = deps.policy ?? CONFIG.review;
		const dispositionsRoot = deps.dispositionsRoot ?? prFindingDispositionsDir(mainWorktree(REPO));
		const carry =
			!deps.isCi() && head.itemId && policy.carry
				? resolveCarryOptions({
						prNumber: Number.parseInt(pr, 10),
						itemId: head.itemId,
						reviewedSha,
						repo: REPO,
						diffCwd: REPO,
						dispositionsRoot,
						gateRecordsRoot: deps.gateRecordsRoot ?? gateRecordsDir(mainWorktree(REPO)),
						execFileSync: deps.execFileSync,
						readFileSync: deps.readFileSync,
						taxonomy: policy.taxonomy,
						warn: (msg) => process.stderr.write(`⚠ ${msg}\n`),
					})
				: undefined;
		// Policy/pool are intentionally not passed: runPrReviewGate resolves them through
		// options → deps → CONFIG, so the same defaults apply and tests can pin the seam.
		const reviewStartedAt = deps.now();
		const review = await runPrReviewGate({
			pr,
			...(head.itemId ? { itemId: head.itemId } : {}),
			profile,
			cwd: REPO,
			diffCwd: REPO,
			diffHeadRef: reviewedSha,
			reviewedSha,
			runStep: deps.runStep,
			execFileSync: deps.execFileSync,
			...(carry ? { carry } : {}),
		});
		const reviewElapsedMs = Math.max(0, Math.trunc(deps.now() - reviewStartedAt));

		// The review text goes to stdout unconditionally so the CI log always
		// carries the findings — a failed comment upsert (or a truncated run)
		// must not be able to lose the only copy of a $-priced review.
		process.stdout.write(`${review.body}\n`);

		// Local (non-CI) completed runs persist their gate evidence exactly as the drain does,
		// so a red roll here is adjudicable: without this, `pr-adjudicate` either refuses or
		// binds to an older drain record and ignores this run's survivors (#497). CI runs skip
		// it — their checkout is ephemeral and the records claim `runner: "local"`.
		if (!deps.isCi() && head.itemId && review.gate !== "park") {
			persistLocalGateEvidence({
				prNumber: Number.parseInt(pr, 10),
				headSha: reviewedSha,
				itemId: head.itemId,
				review,
				gateRecordsRoot: deps.gateRecordsRoot ?? gateRecordsDir(mainWorktree(REPO)),
				adjudicationSourcesRoot: deps.adjudicationSourcesRoot ?? adjudicationSourcesDir(mainWorktree(REPO)),
				dispositionsRoot,
				writeGateRecord: deps.writeGateRecord,
				writeAdjudicationSource: deps.writeAdjudicationSource,
				writeDispositionRecord: deps.writeDispositionRecord,
				readFileSync: deps.readFileSync,
				now: deps.now,
				elapsedMs: reviewElapsedMs,
				warn: (msg) => process.stderr.write(`⚠ ${msg}\n`),
			});
		}

		// CI stays fail-closed: a rate-limit park has no park loop on a one-shot GH Actions job, so
		// it posts red and exits 1 exactly as a block does. Only the local orchestrator sweep treats
		// `park` specially (leaves the status pending and retries).
		const statusGate: "pass" | "block" = review.gate === "pass" ? "pass" : "block";
		const statusPosted = deps.postStatus(statusGate, reviewedSha);
		deps.upsertComment(pr, review.body);

		process.stderr.write(`gate: ${review.gate.toUpperCase()} (ok=${review.ok})\n`);
		return review.gate === "pass" && statusPosted ? 0 : 1;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		process.stderr.write(`pr-review crashed — failing closed: ${msg}\n`);
		if (reviewedSha) deps.postStatus("block", reviewedSha);
		else process.stderr.write("✗ reviewed SHA unavailable; posting no status (absent required status keeps the PR blocked)\n");
		deps.upsertComment(pr, buildFailClosedComment("error_crash", `pr-review crashed before producing a review, so this gate blocks the merge.\n\n${msg}`));
		return 1;
	}
}

// Run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main(process.argv.slice(2)).then((code) => process.exit(code));
}
