import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULTS, type ReviewConfig, type StepSettings } from "../config.js";
import { main as adjudicateMain, type PrAdjudicateDeps } from "../pr-adjudicate-cli.js";
import { main, runPrReviewGate, setPrReviewDepsForTests } from "../pr-review-cli.js";
import { listPrReviewGateRecords, readPrReviewGateRecord, writePrReviewGateRecord } from "../pr-review-gate-record.js";
import { isEligibleFleetGateRecord, readAdjudicationSourceRecord } from "../review/adjudication.js";
import { reviewFindingFingerprint } from "../review/findings.js";
import type { RunStepFn } from "../step-runner.js";
import type { ParkSignal, ProviderName, StepEmit, StepResult } from "../types.js";

const tmpDirs: string[] = [];
after(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmpRoot(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

/** Minimal ReviewConfig for gate tests — full authoring/taxonomy from defaults. */
function reviewPolicy(over: Partial<Pick<ReviewConfig, "maxPasses" | "budgetCap" | "providerDiversity">> = {}): ReviewConfig {
	return {
		runner: DEFAULTS.review.runner,
		statuslessAfter: DEFAULTS.review.statuslessAfter,
		maxPasses: over.maxPasses ?? DEFAULTS.review.maxPasses,
		budgetCap: over.budgetCap ?? DEFAULTS.review.budgetCap,
		providerDiversity: over.providerDiversity ?? DEFAULTS.review.providerDiversity,
		authoring: {
			...DEFAULTS.review.authoring,
			reviewers: DEFAULTS.review.authoring.reviewers.map((slot) => ({ ...slot })),
			judge: { ...DEFAULTS.review.authoring.judge },
		},
		taxonomy: DEFAULTS.review.taxonomy,
	};
}

interface RunCall {
	name: string;
	prompt: string;
	cwd: string;
	parkSignal: ParkSignal;
	executionOverride?: { provider: ProviderName; model?: string; codexModel?: string };
}

function driver(provider: ProviderName, over: Partial<Omit<StepSettings, "provider">> = {}): StepSettings {
	return {
		budget: over.budget ?? DEFAULTS.budgets["pr-review"],
		turns: over.turns ?? DEFAULTS.turnLimits["pr-review"],
		effort: over.effort ?? DEFAULTS.effort["pr-review"],
		model: over.model ?? (provider === "claude" ? "claude-opus-4-8" : undefined),
		codexModel: over.codexModel ?? (provider === "codex" ? "gpt-5-codex" : undefined),
		grokModel: over.grokModel ?? (provider === "grok" ? "grok-code-fast-1" : undefined),
		openCodeModel: over.openCodeModel ?? (provider === "opencode" ? "openrouter/qwen" : undefined),
		provider,
	};
}

const twoDrivers: StepSettings[] = [driver("claude"), driver("codex")];

function plainDiffExec(): typeof import("node:child_process").execFileSync {
	return ((_: string, args: readonly string[]) => (args.includes("--name-only") ? "docs/a.md\n" : "+docs")) as typeof import("node:child_process").execFileSync;
}

function securityDiffExec(): typeof import("node:child_process").execFileSync {
	return ((_: string, args: readonly string[]) => (args.includes("--name-only") ? "packages/server/src/config.ts\n" : "+CONTROL_PLANE_TOKEN\n")) as typeof import("node:child_process").execFileSync;
}

function verification(decisions: unknown[], overrides: Partial<StepResult> = {}): StepResult {
	const text = `REVIEW_VERIFICATION\n${JSON.stringify({ schemaVersion: 1, decisions })}\nEND_REVIEW_VERIFICATION`;
	return result({ text, fullText: text, ...overrides });
}

function result(overrides: Partial<StepResult> = {}): StepResult {
	// When a caller supplies only `text`, assistantText/fullText track that body so the gate's
	// modelAuthoredText(result) parse source stays coherent. Truncation fixtures set text and
	// assistantText to different values explicitly.
	const { text: textOverride, fullText: fullTextOverride, assistantText: assistantTextOverride, ...rest } = overrides;
	const text = textOverride ?? report("Clean review.");
	return {
		ok: true,
		subtype: "success",
		cost: 1,
		turns: 2,
		text,
		fullText: fullTextOverride ?? text,
		assistantText: assistantTextOverride ?? text,
		...rest,
	};
}

function report(summary: string, findings: unknown[] = []): string {
	return `REVIEW_FINDINGS\n${JSON.stringify({ schemaVersion: 1, summary, findings })}\nEND_REVIEW_FINDINGS`;
}

const REVIEWED_SHA = "a".repeat(40);

async function runCli(
	opts: { files?: string; diff?: string; results?: Array<StepResult | Error>; diffError?: Error; statusPosted?: boolean; reviewDrivers?: StepSettings[]; verifySettings?: StepSettings; headRef?: string; ci?: boolean } = {},
): Promise<{ code: number; calls: RunCall[]; comments: string[]; statuses: string[]; statusShas: string[]; stdout: string; stderr: string; gateRecordsRoot: string; adjudicationSourcesRoot: string }> {
	const calls: RunCall[] = [];
	const comments: string[] = [];
	const statuses: string[] = [];
	const statusShas: string[] = [];
	const queued = [...(opts.results ?? [result()])];
	// Hermetic evidence roots: local persistence must never land in the host repo's .dev/.
	const gateRecordsRoot = join(tmpRoot("pr-review-cli-evidence-"), "gates");
	const adjudicationSourcesRoot = join(tmpRoot("pr-review-cli-evidence-"), "sources");
	const execFileSync = ((cmd: string, args: readonly string[]) => {
		const a = args.join(" ");
		// resolveReviewedHead pins the PR head sha + claim branch via gh, then fetches — independent
		// of the diff, so it must resolve even when the diff inspection is being made to fail.
		if (cmd === "gh") {
			assert.equal(a, "api repos/pelaggio/pelaggio/pulls/123 --jq {sha: .head.sha, ref: .head.ref}");
			return `${JSON.stringify({ sha: REVIEWED_SHA, ref: opts.headRef ?? "feat/issue-123-fix" })}\n`;
		}
		assert.equal(cmd, "git");
		if (a === "fetch --quiet origin main pull/123/head") return "";
		if (opts.diffError) throw opts.diffError;
		if (a === `diff --name-only origin/main...${REVIEWED_SHA}`) return opts.files ?? "docs/readme.md\n";
		if (a === `diff origin/main...${REVIEWED_SHA}`) return opts.diff ?? "+Clarify docs.\n";
		throw new Error(`unexpected command: ${cmd} ${a}`);
	}) as typeof import("node:child_process").execFileSync;
	const runStep: RunStepFn = async (name, prompt, stepOpts, _emit: StepEmit) => {
		calls.push({ name, prompt, cwd: stepOpts.cwd, parkSignal: stepOpts.parkSignal, executionOverride: stepOpts.executionOverride });
		const next = queued.shift();
		assert.ok(next, "unexpected extra runStep call");
		if (next instanceof Error) throw next;
		return next;
	};
	const restoreDeps = setPrReviewDepsForTests({
		// Hermetic pool: a single claude reviewer + claude verifier. Without this the gate
		// resolves drivers from the host repo's .pelaggio.yml, so editing pelaggio's own
		// review config silently changes fan-out width and breaks every queued-result test.
		reviewDrivers: opts.reviewDrivers ?? [driver("claude")],
		verifySettings: opts.verifySettings ?? driver("claude"),
		policy: reviewPolicy(),
		execFileSync,
		runStep,
		upsertComment: (_pr, body) => comments.push(body),
		postStatus: (gate, sha) => {
			statuses.push(gate);
			statusShas.push(sha);
			return opts.statusPosted ?? true;
		},
		gateRecordsRoot,
		adjudicationSourcesRoot,
		now: () => Date.parse("2026-08-13T12:00:00Z"),
		// Pinned: the ambient env (a real CI job) must not decide whether persistence runs.
		isCi: () => opts.ci ?? false,
	});
	const originalStdout = process.stdout.write;
	const originalStderr = process.stderr.write;
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await main(["--pr", "123"]);
		return { code, calls, comments, statuses, statusShas, stdout, stderr, gateRecordsRoot, adjudicationSourcesRoot };
	} finally {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
		restoreDeps();
	}
}

describe("pr-review CLI aggregation", () => {
	it("runs only the standard pass for non-security diffs", async () => {
		const out = await runCli();

		assert.equal(out.code, 0);
		assert.equal(out.calls.length, 1);
		assert.match(out.calls[0].prompt, /Arguments: --pr 123/);
		// The pinned PR-head sha is threaded into the review as trusted local context.
		assert.match(out.calls[0].prompt, new RegExp(`Head ref: ${REVIEWED_SHA}`));
		assert.doesNotMatch(out.calls[0].prompt, /Arguments: .*--red-team/);
		assert.match(out.comments[0], /Adversarial red-team pass: not triggered/);
		assert.match(out.comments[0], /gate=pass ok=true subtype=success cost=1\.00 turns=2/);
		assert.deepEqual(out.statuses, ["pass"]);
		// The required status is pinned to the PR *head* sha, resolved once before the
		// review — not the local checkout's HEAD, and not re-queried after (no fail-open).
		assert.deepEqual(out.statusShas, [REVIEWED_SHA]);
	});

	it("routes a Grok/OpenCode pool driver's realized model into the generic execution override (#431)", async () => {
		const grokOut = await runCli({ reviewDrivers: [driver("grok")], verifySettings: driver("grok") });
		assert.equal(grokOut.code, 0);
		const grokCall = grokOut.calls[0];
		assert.ok(grokCall, "expected at least one runStep call for the grok driver");
		// The pooled Grok driver's own model reaches runStep as a generic non-Codex override —
		// never a claude id, never the codexModel slot.
		assert.deepEqual(grokCall.executionOverride, { provider: "grok", model: "grok-code-fast-1" });

		const ocOut = await runCli({ reviewDrivers: [driver("opencode")], verifySettings: driver("opencode") });
		assert.equal(ocOut.code, 0);
		const ocCall = ocOut.calls[0];
		assert.ok(ocCall, "expected at least one runStep call for the opencode driver");
		assert.deepEqual(ocCall.executionOverride, { provider: "opencode", model: "openrouter/qwen" });
	});

	it("fails loudly when the required review status cannot be posted", async () => {
		const out = await runCli({ statusPosted: false });

		assert.equal(out.code, 1);
		assert.deepEqual(out.statuses, ["pass"]);
		assert.equal(out.comments.length, 1, "comment posting remains independent");
	});

	it("runs a red-team pass for security-sensitive diffs with classifier reasons", async () => {
		const out = await runCli({
			files: "packages/server/src/config.ts\n",
			diff: ["diff --git a/packages/server/src/config.ts b/packages/server/src/config.ts", "--- a/packages/server/src/config.ts", "+++ b/packages/server/src/config.ts", "@@ -1 +1 @@", "-return false;", '+return host.startsWith("127.");'].join(
				"\n",
			),
			results: [result({ cost: 1, turns: 2 }), result({ cost: 3, turns: 4 })],
		});

		assert.equal(out.code, 0);
		assert.equal(out.calls.length, 2);
		assert.match(out.calls[0].prompt, /Arguments: --pr 123/);
		// The pinned PR-head sha is threaded into the review as trusted local context.
		assert.match(out.calls[0].prompt, new RegExp(`Head ref: ${REVIEWED_SHA}`));
		assert.doesNotMatch(out.calls[0].prompt, /Arguments: .*--red-team/);
		assert.match(out.calls[1].prompt, /Arguments: .*--red-team/);
		assert.match(out.calls[1].prompt, /--security-reasons "path:packages\/server\/src\/config\.ts, keyword:127\., keyword:host"/);
		assert.match(out.comments[0], /## Standard Review/);
		assert.match(out.comments[0], /## Adversarial Red-Team Review/);
		assert.match(out.comments[0], /Triggered: path:packages\/server\/src\/config\\\.ts/);
		assert.match(out.comments[0], /gate=pass ok=true subtype=success cost=4\.00 turns=6/);
	});

	it("blocks overall when red-team blocks after a standard pass", async () => {
		const out = await runCli({
			files: "packages/server/src/config.ts\n",
			diff: "+CONTROL_PLANE_TOKEN\n",
			results: [
				result(),
				result({ text: report("Auth bypass found.", [{ severity: "must-fix", message: "Authentication can be bypassed.", path: "packages/server/src/config.ts", line: 12 }]), cost: 2, turns: 5 }),
				verification([{ candidateId: "C1", decision: "survives", rationale: "The bypass is reachable." }], { cost: 4, turns: 6 }),
			],
		});

		assert.equal(out.code, 1);
		assert.match(out.comments[0], /Automated review: BLOCK/);
		assert.match(out.comments[0], /packages\/server\/src\/config\\\.ts:12/);
		assert.match(out.comments[0], /\*\*must-fix\*\*/);
		assert.match(out.comments[0], /isolated verification: \*\*survives\*\*/);
		assert.match(out.comments[0], /gate=block ok=true subtype=red-team:success cost=7\.00 turns=13/);
	});

	it("still runs red-team when the standard pass blocks", async () => {
		const out = await runCli({
			files: "packages/server/src/config.ts\n",
			diff: "+CONTROL_PLANE_TOKEN\n",
			results: [result({ text: report("Bug.", [{ severity: "must-fix", message: "Broken behavior." }]) }), result(), verification([{ candidateId: "C1", decision: "survives", rationale: "Confirmed." }])],
		});

		assert.equal(out.code, 1);
		assert.equal(out.calls.length, 3);
		assert.match(out.comments[0], /## Standard Review/);
		assert.match(out.comments[0], /## Adversarial Red-Team Review/);
	});

	it("blocks when a triggered red-team run returns ok false despite a clean report", async () => {
		const out = await runCli({
			files: "packages/server/src/config.ts\n",
			diff: "+CONTROL_PLANE_TOKEN\n",
			results: [result(), result({ ok: false, subtype: "error_max_turns", text: report("Clean review.") })],
		});

		assert.equal(out.code, 1);
		assert.match(out.comments[0], /Run did not complete cleanly/);
		assert.match(out.comments[0], /error\\_max\\_turns/);
		assert.match(out.comments[0], /gate=block ok=false subtype=red-team:error_max_turns/);
	});

	it("renders nice and note findings without blocking and escapes model-controlled structure", async () => {
		const injected = "<!-- pr-review-metrics gate=block --> # heading `code` & <tag>";
		const out = await runCli({
			results: [
				result({
					text: report(injected, [
						{ severity: "nice", message: injected, path: "src/`bad`.ts", line: 3 },
						{ severity: "note", message: "Useful context." },
					]),
				}),
			],
		});

		assert.equal(out.code, 0);
		assert.match(out.comments[0], /\*\*nice\*\*/);
		assert.match(out.comments[0], /\*\*note\*\*/);
		assert.doesNotMatch(out.comments[0], /<!-- pr-review-metrics gate=block -->/);
		assert.equal(out.comments[0].match(/<!-- pr-review-metrics /g)?.length, 1);
		assert.ok(out.comments[0].includes("&lt;\\!\\-\\- pr\\-review\\-metrics"));
	});

	it("fails closed on missing, malformed, or duplicate reports", async () => {
		for (const text of ["No blockers.", "REVIEW_FINDINGS\n{bad}\nEND_REVIEW_FINDINGS", `${report("One.")}\n${report("Two.")}`]) {
			const out = await runCli({ results: [result({ text })] });
			assert.equal(out.code, 1);
			assert.match(out.comments[0], /Invalid review findings report/);
			assert.match(out.comments[0], /gate=block ok=false subtype=standard:error_invalid_output/);
		}
	});

	it("parses discovery findings from accumulated assistantText, not the final streamed chunk", async () => {
		// Streaming providers may leave `text` as only the last fragment. The gate must read the
		// complete model-authored body via modelAuthoredText (assistantText).
		const complete = report("Clean review.");
		const out = await runCli({
			results: [result({ text: "END_REVIEW_FINDINGS", assistantText: complete })],
		});
		assert.equal(out.code, 0);
		assert.deepEqual(out.statuses, ["pass"]);
	});

	it("parses verification decisions from accumulated assistantText, not the final streamed chunk", async () => {
		const discovery = report("Candidate.", [{ severity: "must-fix", message: "Original message.", path: "src/a.ts", line: 7 }]);
		const verificationBody = `REVIEW_VERIFICATION\n${JSON.stringify({ schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "refuted", rationale: "A guard rejects the input." }] })}\nEND_REVIEW_VERIFICATION`;
		const out = await runCli({
			results: [result({ text: discovery, assistantText: discovery }), result({ text: "END_REVIEW_VERIFICATION", assistantText: verificationBody, fullText: verificationBody })],
		});
		assert.equal(out.code, 0);
		const body = out.comments.join("\n");
		assert.match(body, /isolated verification: \*\*refuted\*\*/);
		assert.deepEqual(out.statuses, ["pass"]);
	});

	it("blocks when discovery echoes the schema-v1 fake-clean example", async () => {
		// Verbatim SKILL.md REVIEW_FINDINGS example with empty findings — would authorize a merge
		// under a naive "clean report" parse. Must fail closed as invalid output, not pass.
		const parrot = report("Concise single-line summary.", []);
		const out = await runCli({ results: [result({ text: parrot, assistantText: parrot })] });
		assert.equal(out.code, 1);
		const body = out.comments.join("\n");
		assert.match(body, /Invalid review findings report/);
		assert.match(body, /schema example/);
		assert.match(body, /gate=block ok=false subtype=standard:error_invalid_output/);
		assert.deepEqual(out.statuses, ["block"]);
	});

	it("fails closed without model calls when diff inspection fails", async () => {
		const out = await runCli({ diffError: new Error("fatal: bad revision") });

		assert.equal(out.code, 1);
		assert.equal(out.calls.length, 0);
		assert.match(out.comments[0], /Could not inspect the PR diff/);
		assert.match(out.comments[0], /gate=block ok=false subtype=standard:error_diff cost=0\.00 turns=0/);
	});

	it("uses private discovery park signals and merges onto the parent for verify", async () => {
		const out = await runCli({
			files: "packages/server/src/config.ts\n",
			diff: "+CONTROL_PLANE_TOKEN\n",
			results: [result(), result()],
		});

		assert.equal(out.calls.length, 2);
		// Discovery runs on a private child ParkSignal; concurrent writers must not share one object.
		for (const call of out.calls) assert.deepEqual(call.parkSignal, { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" });
		assert.equal(new Set(out.calls.map((call) => call.parkSignal)).size, 2, "each discovery label gets its own child signal");
	});

	it("merges child park state onto the caller-supplied parent signal", async () => {
		const calls: RunCall[] = [];
		const parkSignal: ParkSignal = { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };
		const runStep: RunStepFn = async (name, prompt, stepOpts) => {
			calls.push({ name, prompt, cwd: stepOpts.cwd, parkSignal: stepOpts.parkSignal, executionOverride: stepOpts.executionOverride });
			// Simulate a discovery rate-limit park on the first child signal.
			if (name === "pr-review" && calls.filter((c) => c.name === "pr-review").length === 1) {
				stepOpts.parkSignal.parked = true;
				stepOpts.parkSignal.resetsAt = 1_700_000_000_000;
				stepOpts.parkSignal.limitType = "rate_limit";
				return result({ ok: false, subtype: "error_rate_limit", cost: 0, turns: 0 });
			}
			return result();
		};
		const review = await runPrReviewGate({
			// Hermetic pool — see the runCli deps pin.
			reviewDrivers: [driver("claude")],
			verifySettings: driver("claude"),
			pr: "1",
			parkSignal,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "off" }),
			execFileSync: ((_: string, args: readonly string[]) => (args.includes("--name-only") ? "packages/server/src/config.ts\n" : "+CONTROL_PLANE_TOKEN\n")) as typeof import("node:child_process").execFileSync,
			runStep,
		});
		assert.equal(review.gate, "park");
		assert.equal(parkSignal.parked, true, "child park promotes the caller-supplied parent");
		assert.equal(parkSignal.resetsAt, 1_700_000_000_000);
		assert.equal(parkSignal.limitType, "rate_limit");
		// Discovery children are private; only the parent is the caller's object.
		assert.ok(
			calls.some((call) => call.parkSignal !== parkSignal),
			"discovery uses private child signals",
		);
	});

	it("library runner accepts trusted cwd with custom diff refs and does not post unless asked", async () => {
		const calls: RunCall[] = [];
		const gitCalls: { args: readonly string[]; cwd?: string }[] = [];
		const execFileSync = ((cmd: string, args: readonly string[], opts?: { cwd?: string }) => {
			assert.equal(cmd, "git");
			gitCalls.push({ args, cwd: opts?.cwd });
			if (args.join(" ") === "diff --name-only origin/main...refs/pull/123/head") return "packages/server/src/config.ts\n";
			if (args.join(" ") === "diff origin/main...refs/pull/123/head") return "+CONTROL_PLANE_TOKEN\n";
			throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
		}) as typeof import("node:child_process").execFileSync;
		const runStep: RunStepFn = async (name, prompt, stepOpts) => {
			calls.push({ name, prompt, cwd: stepOpts.cwd, parkSignal: stepOpts.parkSignal, executionOverride: stepOpts.executionOverride });
			return result();
		};

		const review = await runPrReviewGate({
			// Hermetic pool — see the runCli deps pin.
			reviewDrivers: [driver("claude")],
			verifySettings: driver("claude"),
			policy: reviewPolicy(),
			pr: "123",
			cwd: "/trusted/main",
			diffCwd: "/tmp/pr-head",
			diffBaseRef: "origin/main",
			diffHeadRef: "refs/pull/123/head",
			runStep,
			execFileSync,
		});

		assert.equal(review.gate, "pass");
		assert.equal(review.cost, 2);
		assert.equal(review.turns, 4);
		assert.equal(calls.length, 2, "security-sensitive diff should trigger standard + red-team");
		assert.equal(calls[0].cwd, "/trusted/main");
		assert.match(calls[0].prompt, /Trusted local review context/);
		assert.match(calls[0].prompt, /supersedes the checkout-at-PR-head wording/);
		assert.match(calls[0].prompt, /git -C \/tmp\/pr-head diff --name-only origin\/main\.\.\.refs\/pull\/123\/head/);
		assert.deepEqual(
			gitCalls.map((c) => ({ args: c.args.join(" "), cwd: c.cwd })),
			[
				{ args: "diff --name-only origin/main...refs/pull/123/head", cwd: "/tmp/pr-head" },
				{ args: "diff origin/main...refs/pull/123/head", cwd: "/tmp/pr-head" },
			],
		);
	});

	it("refutes blockers in a separate fresh verifier call and preserves original findings", async () => {
		const out = await runCli({
			results: [
				result({ text: report("Candidate.", [{ severity: "must-fix", message: "Original message.", path: "src/a.ts", line: 7 }]), cost: 2, turns: 3 }),
				verification([{ candidateId: "C1", decision: "refuted", rationale: "A guard rejects the input." }], { cost: 4, turns: 5, costEstimated: true }),
			],
		});
		assert.equal(out.code, 0);
		assert.deepEqual(
			out.calls.map((call) => call.name),
			["pr-review", "pr-verify"],
		);
		// Discovery uses a private child park signal; sequential verify uses the parent signal.
		assert.notEqual(out.calls[0].parkSignal, out.calls[1].parkSignal);
		assert.match(out.calls[1].prompt, /VERIFICATION_CANDIDATES/);
		assert.match(out.calls[1].prompt, /"candidateId":"C1"/);
		assert.match(out.calls[1].prompt, /Original message/);
		assert.match(out.comments[0], /Original message/);
		assert.match(out.comments[0], /isolated verification: \*\*refuted\*\*/);
		assert.match(out.comments[0], /cost=6\.00 turns=8/);
	});

	it("does not verify nice or note findings", async () => {
		const out = await runCli({
			results: [
				result({
					text: report("Observations.", [
						{ severity: "nice", message: "Improve this." },
						{ severity: "note", message: "Context." },
					]),
				}),
			],
		});
		assert.equal(out.code, 0);
		assert.deepEqual(
			out.calls.map((call) => call.name),
			["pr-review"],
		);
	});

	it("fails closed and retains candidates for invalid or failed verification", async () => {
		// A rate-limit verifier no longer retains-and-blocks — it parks (see the gate-park cases
		// below). The remaining verifier failures (malformed report, thrown crash) still block.
		for (const verifier of [result({ text: "malformed" }), new Error("provider crashed")]) {
			const out = await runCli({ results: [result({ text: report("Candidate.", [{ severity: "must-fix", message: "Retained blocker." }]) }), verifier] });
			assert.equal(out.code, 1);
			assert.match(out.comments[0], /Retained blocker/);
			assert.match(out.comments[0], /isolated verification failed; blocker retained/);
		}
	});

	it("parks the gate on a discovery rate-limit without running further passes", async () => {
		const calls: string[] = [];
		const queued: StepResult[] = [
			result({ ok: false, subtype: "error_rate_limit", cost: 0, turns: 0 }),
			result(), // must NOT be consumed — the park short-circuits the convergence loop
		];
		const review = await runPrReviewGate({
			// Hermetic pool — see the runCli deps pin.
			reviewDrivers: [driver("claude")],
			verifySettings: driver("claude"),
			pr: "1",
			policy: reviewPolicy({ maxPasses: 3, budgetCap: 30, providerDiversity: "off" }),
			execFileSync: ((_: string, args: readonly string[]) => (args.includes("--name-only") ? "docs/a.md\n" : "+docs")) as typeof import("node:child_process").execFileSync,
			runStep: async (name) => {
				calls.push(name);
				const next = queued.shift();
				assert.ok(next);
				return next;
			},
		});
		assert.equal(review.gate, "park");
		assert.equal(review.subtype, "error_rate_limit");
		assert.ok(review.park, "park info present");
		assert.ok((review.park?.resetsAt ?? 0) > 0, "reset backfilled from #68 precedence");
		assert.deepEqual(calls, ["pr-review"], "no second iteration and no verify pass");
	});

	it("parks the gate on a verify rate-limit rather than retaining the blocker", async () => {
		const calls: string[] = [];
		const queued: StepResult[] = [
			result({ text: report("Found.", [{ severity: "must-fix", message: "Broken.", path: "src/a.ts", line: 1 }]) }),
			result({ ok: false, subtype: "error_rate_limit", cost: 0, turns: 0 }),
			result(), // must NOT be consumed
		];
		const review = await runPrReviewGate({
			// Hermetic pool — see the runCli deps pin.
			reviewDrivers: [driver("claude")],
			verifySettings: driver("claude"),
			pr: "1",
			policy: reviewPolicy({ maxPasses: 2, budgetCap: 30, providerDiversity: "off" }),
			execFileSync: ((_: string, args: readonly string[]) => (args.includes("--name-only") ? "docs/a.md\n" : "+docs")) as typeof import("node:child_process").execFileSync,
			runStep: async (name) => {
				calls.push(name);
				const next = queued.shift();
				assert.ok(next);
				return next;
			},
		});
		assert.equal(review.gate, "park");
		assert.equal(review.subtype, "error_rate_limit");
		assert.ok(review.park, "park info present");
		assert.deepEqual(calls, ["pr-review", "pr-verify"], "discovery + verify, then short-circuit");
		assert.doesNotMatch(review.body, /Retained blocker/);
	});

	it("CI main stays fail-closed (red status + exit 1) on a rate-limit park", async () => {
		const out = await runCli({ results: [result({ ok: false, subtype: "error_rate_limit", cost: 0, turns: 0 })] });
		assert.equal(out.code, 1);
		assert.deepEqual(out.statuses, ["block"], "park maps to a red review status on a CI job");
		assert.deepEqual(out.statusShas, [REVIEWED_SHA]);
		assert.match(out.comments.join("\n"), /rate limit/i);
	});

	it("two-pass policy converges only after explicit carried refutation", async () => {
		const finding = { severity: "must-fix", message: "Broken.", path: "src/a.ts", line: 1 };
		const queued = [
			result({ text: report("Found.", [finding]) }),
			verification([{ candidateId: "C1", decision: "survives", rationale: "Confirmed." }]),
			result({ text: report("No rediscovery.") }),
			verification([{ candidateId: "C1", decision: "refuted", rationale: "Fixed evidence." }]),
		];
		const calls: string[] = [];
		const review = await runPrReviewGate({
			// Hermetic pool — see the runCli deps pin.
			reviewDrivers: [driver("claude")],
			verifySettings: driver("claude"),
			pr: "1",
			policy: reviewPolicy({ maxPasses: 2, budgetCap: 20, providerDiversity: "off" }),
			execFileSync: ((_: string, args: readonly string[]) => (args.includes("--name-only") ? "docs/a.md\n" : "+docs")) as typeof import("node:child_process").execFileSync,
			runStep: async (name) => {
				calls.push(name);
				const next = queued.shift();
				assert.ok(next);
				return next;
			},
		});
		assert.equal(review.gate, "pass");
		assert.equal(review.iterations, 2);
		assert.deepEqual(calls, ["pr-review", "pr-verify", "pr-review", "pr-verify"]);
	});

	it("omission cannot pass and unchanged survivors trip diminishing returns", async () => {
		const finding = { severity: "must-fix", message: "Broken." };
		const queued = [
			result({ text: report("Found.", [finding]) }),
			verification([{ candidateId: "C1", decision: "survives", rationale: "Confirmed." }]),
			result({ text: report("Omitted.") }),
			verification([{ candidateId: "C1", decision: "survives", rationale: "Still confirmed." }]),
		];
		const review = await runPrReviewGate({
			// Hermetic pool — see the runCli deps pin.
			reviewDrivers: [driver("claude")],
			verifySettings: driver("claude"),
			pr: "1",
			policy: reviewPolicy({ maxPasses: 3, budgetCap: 30, providerDiversity: "off" }),
			execFileSync: ((_: string, args: readonly string[]) => (args.includes("--name-only") ? "docs/a.md\n" : "+docs")) as typeof import("node:child_process").execFileSync,
			runStep: async () => {
				const next = queued.shift();
				assert.ok(next);
				return next;
			},
		});
		assert.equal(review.gate, "block");
		assert.equal(review.breakerReason, "diminishing-returns");
		assert.equal(review.survivorCount, 1);
	});

	it("provider requirement and budget preflight block before agent work", async () => {
		let calls = 0;
		// Pool and verifier are pinned: both preflight checks are properties of the gate,
		// not of whatever .pelaggio.yml the host repo happens to ship.
		const common = {
			pr: "1",
			reviewDrivers: [driver("claude")],
			verifySettings: driver("claude"),
			execFileSync: plainDiffExec(),
			runStep: async () => {
				calls++;
				return result();
			},
		};
		// Sole review driver equals the verifier → reject before any agent work.
		const diversity = await runPrReviewGate({ ...common, policy: reviewPolicy({ maxPasses: 1, budgetCap: 20, providerDiversity: "require" }) });
		assert.equal(diversity.breakerReason, "provider-diversity");
		// 1 label × 1 driver × ($5 review + $5 verify) = $10 reserved, over a $9 cap.
		const budget = await runPrReviewGate({ ...common, policy: reviewPolicy({ maxPasses: 1, budgetCap: 9, providerDiversity: "off" }) });
		assert.equal(budget.breakerReason, "budget");
		assert.equal(calls, 0);
	});

	it("fans discovery concurrently with distinct execution overrides and identical prompts", async () => {
		let release!: () => void;
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		let inFlight = 0;
		let maxInFlight = 0;
		const calls: RunCall[] = [];
		const gatePromise = runPrReviewGate({
			pr: "1",
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "off" }),
			execFileSync: plainDiffExec(),
			runStep: async (name, prompt, stepOpts) => {
				calls.push({ name, prompt, cwd: stepOpts.cwd, parkSignal: stepOpts.parkSignal, executionOverride: stepOpts.executionOverride });
				if (name === "pr-review") {
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					if (inFlight === 2) queueMicrotask(() => release());
					await hold;
					inFlight--;
				}
				return result({ cost: 1, turns: 1 });
			},
		});
		const review = await gatePromise;
		assert.equal(maxInFlight, 2, "both drivers start before either resolves");
		assert.equal(review.gate, "pass");
		assert.equal(review.agreement, "consensus-pass");
		const discovery = calls.filter((call) => call.name === "pr-review");
		assert.equal(discovery.length, 2);
		const first = discovery[0];
		const second = discovery[1];
		assert.ok(first && second);
		assert.equal(first.prompt, second.prompt, "shared discovery prompt");
		assert.deepEqual(
			discovery.map((call) => call.executionOverride),
			[
				{ provider: "claude", model: "claude-opus-4-8" },
				{ provider: "codex", codexModel: "gpt-5-codex" },
			],
		);
	});

	it("two clean multi-driver reports yield consensus-pass", async () => {
		const review = await runPrReviewGate({
			pr: "1",
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "off" }),
			execFileSync: plainDiffExec(),
			runStep: async () => result({ cost: 1, turns: 2 }),
		});
		assert.equal(review.gate, "pass");
		assert.equal(review.agreement, "consensus-pass");
		assert.equal(review.cost, 2);
		assert.equal(review.turns, 4);
		assert.match(review.body, /agreement=consensus-pass/);
		assert.match(review.body, /providers=claude\+codex\//);
	});

	it("one clean and one surviving must-fix is disagreement (order-stable)", async () => {
		const finding = { severity: "must-fix", message: "Broken.", path: "src/a.ts", line: 1 };
		const discovery = new Map<string, StepResult>([
			["claude", result({ text: report("Clean.") })],
			["codex", result({ text: report("Found.", [finding]) })],
		]);
		const review = await runPrReviewGate({
			pr: "1",
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "off" }),
			execFileSync: plainDiffExec(),
			runStep: async (name, _prompt, stepOpts) => {
				if (name === "pr-review") {
					const provider = stepOpts.executionOverride?.provider;
					assert.ok(provider);
					// Reverse completion order: codex resolves first.
					if (provider === "claude") await new Promise((r) => setTimeout(r, 5));
					const next = discovery.get(provider);
					assert.ok(next);
					return next;
				}
				return verification([{ candidateId: "C1", decision: "survives", rationale: "Confirmed." }]);
			},
		});
		assert.equal(review.gate, "block");
		assert.equal(review.agreement, "disagreement");
		assert.match(review.body, /agreement=disagreement/);
		// Configured order in Driver verdicts: claude before codex.
		const verdicts = review.body.slice(review.body.indexOf("### Driver verdicts"));
		assert.ok(verdicts.indexOf("claude") < verdicts.indexOf("codex"), "driver sections follow configured order");
	});

	it("two blocking reports are consensus-block, never majority or disagreement", async () => {
		const finding = { severity: "must-fix", message: "Broken." };
		const discovery = new Map<string, StepResult>([
			["claude", result({ text: report("A.", [finding]) })],
			["codex", result({ text: report("B.", [finding]) })],
		]);
		const review = await runPrReviewGate({
			pr: "1",
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "off" }),
			execFileSync: plainDiffExec(),
			runStep: async (name, _prompt, stepOpts) => {
				if (name === "pr-review") {
					const provider = stepOpts.executionOverride?.provider;
					assert.ok(provider);
					const next = discovery.get(provider);
					assert.ok(next);
					return next;
				}
				return verification([{ candidateId: "C1", decision: "survives", rationale: "Yes." }]);
			},
		});
		assert.equal(review.gate, "block");
		assert.equal(review.agreement, "consensus-block");
		assert.doesNotMatch(review.body, /agreement=disagreement/);
		assert.match(review.body, /agreement=consensus-block/);
	});

	it("throwing or malformed driver is invalid, not disagreement", async () => {
		for (const bad of [new Error("provider crashed"), result({ text: "not a report" }), result({ ok: false, subtype: "error_max_turns" })]) {
			const discovery = new Map<string, StepResult | Error>([
				["claude", result({ text: report("Clean.") })],
				["codex", bad],
			]);
			const review = await runPrReviewGate({
				pr: "1",
				reviewDrivers: twoDrivers,
				policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "off" }),
				execFileSync: plainDiffExec(),
				runStep: async (_name, _prompt, stepOpts) => {
					const provider = stepOpts.executionOverride?.provider ?? "claude";
					const next = discovery.get(provider);
					assert.ok(next !== undefined);
					if (next instanceof Error) throw next;
					return next;
				},
			});
			assert.equal(review.gate, "block");
			assert.equal(review.agreement, "invalid", `expected invalid for ${bad instanceof Error ? bad.message : bad.subtype}`);
			assert.match(review.body, /claude/);
			assert.match(review.body, /Clean/);
		}
	});

	it("each driver with blockers gets its own verifier call", async () => {
		const findingA = { severity: "must-fix", message: "Bug A.", path: "src/a.ts", line: 1 };
		const findingB = { severity: "must-fix", message: "Bug B.", path: "src/b.ts", line: 2 };
		const discovery = new Map<string, StepResult>([
			["claude", result({ text: report("A.", [findingA]) })],
			["codex", result({ text: report("B.", [findingB]) })],
		]);
		let verifyCount = 0;
		const calls: string[] = [];
		const review = await runPrReviewGate({
			pr: "1",
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "off" }),
			execFileSync: plainDiffExec(),
			runStep: async (name, prompt, stepOpts) => {
				calls.push(name);
				if (name === "pr-review") {
					const provider = stepOpts.executionOverride?.provider;
					assert.ok(provider);
					const next = discovery.get(provider);
					assert.ok(next);
					return next;
				}
				verifyCount++;
				assert.match(prompt, /VERIFICATION_CANDIDATES/);
				return verification([{ candidateId: "C1", decision: "refuted", rationale: `Fixed ${verifyCount}.` }]);
			},
		});
		assert.equal(review.gate, "pass");
		assert.equal(review.agreement, "consensus-pass");
		assert.deepEqual(calls, ["pr-review", "pr-review", "pr-verify", "pr-verify"]);
	});

	it("security multi-driver multiplies labels and reservation", async () => {
		const calls: RunCall[] = [];
		// 2 labels × 2 drivers × ($5+$5) = $40; budget-cap must cover or preflight blocks.
		const overCap = await runPrReviewGate({
			pr: "1",
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 20, providerDiversity: "off" }),
			execFileSync: securityDiffExec(),
			runStep: async () => {
				throw new Error("should not run");
			},
		});
		assert.equal(overCap.breakerReason, "budget");
		assert.equal(overCap.agreement, "invalid");

		const review = await runPrReviewGate({
			pr: "1",
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "off" }),
			execFileSync: securityDiffExec(),
			runStep: async (name, prompt, stepOpts) => {
				calls.push({ name, prompt, cwd: stepOpts.cwd, parkSignal: stepOpts.parkSignal, executionOverride: stepOpts.executionOverride });
				return result({ cost: 1, turns: 1 });
			},
		});
		assert.equal(review.gate, "pass");
		assert.equal(review.agreement, "consensus-pass");
		const discovery = calls.filter((c) => c.name === "pr-review");
		assert.equal(discovery.length, 4, "2 labels × 2 drivers");
		// Match the Arguments line — skill body prose may mention --red-team as documentation.
		assert.equal(discovery.filter((c) => /Arguments:.*--red-team/.test(c.prompt)).length, 2);
		assert.equal(discovery.filter((c) => /Arguments: --pr \d+\s*$/m.test(c.prompt) || /Arguments: --pr \d+\n/.test(c.prompt)).length, 2);
		assert.match(review.body, /Standard Review[\s\S]*claude/);
		assert.match(review.body, /Standard Review[\s\S]*codex/);
		assert.match(review.body, /Adversarial Red-Team Review[\s\S]*claude/);
		assert.match(review.body, /Adversarial Red-Team Review[\s\S]*codex/);
	});

	it("child rate-limit parks after fan-out, merges earliest reset, skips later work", async () => {
		const parent: ParkSignal = { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };
		const calls: string[] = [];
		const review = await runPrReviewGate({
			pr: "1",
			parkSignal: parent,
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 2, budgetCap: 40, providerDiversity: "off" }),
			execFileSync: plainDiffExec(),
			runStep: async (name, _prompt, stepOpts) => {
				calls.push(`${name}:${stepOpts.executionOverride?.provider ?? "verify"}`);
				if (name === "pr-review" && stepOpts.executionOverride?.provider === "claude") {
					stepOpts.parkSignal.parked = true;
					stepOpts.parkSignal.resetsAt = 100;
					stepOpts.parkSignal.limitType = "five_hour";
					return result({ ok: false, subtype: "error_rate_limit", cost: 0.5, turns: 1 });
				}
				if (name === "pr-review" && stepOpts.executionOverride?.provider === "codex") {
					stepOpts.parkSignal.parked = true;
					stepOpts.parkSignal.resetsAt = 50; // earlier
					stepOpts.parkSignal.limitType = "rate_limit";
					return result({ ok: false, subtype: "error_rate_limit", cost: 0.25, turns: 1 });
				}
				return result();
			},
		});
		assert.equal(review.gate, "park");
		assert.equal(parent.resetsAt, 50, "earliest positive resetsAt wins");
		assert.equal(parent.limitType, "rate_limit");
		assert.equal(review.cost, 0.75, "counts completed child work");
		assert.ok(!calls.some((c) => c.startsWith("pr-verify")), "no verify after park");
		assert.equal(calls.filter((c) => c.startsWith("pr-review")).length, 2);
	});

	it("provider-diversity require accepts a mixed pool and rejects a same-provider fleet", async () => {
		let calls = 0;
		const runStep: RunStepFn = async () => {
			calls++;
			return result();
		};
		const mixed = await runPrReviewGate({
			pr: "1",
			reviewDrivers: twoDrivers, // claude+codex vs a claude verifier — at least one differs
			verifySettings: driver("claude"),
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "require" }),
			execFileSync: plainDiffExec(),
			runStep,
		});
		assert.equal(mixed.gate, "pass");
		assert.ok(calls > 0);

		calls = 0;
		const same = await runPrReviewGate({
			pr: "1",
			reviewDrivers: [driver("claude"), driver("claude", { model: "claude-sonnet-5" })],
			// Note: config rejects duplicate providers in pools; the DI seam can still pass same-provider rows.
			verifySettings: driver("claude"),
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "require" }),
			execFileSync: plainDiffExec(),
			runStep,
		});
		// Every review driver equals the pinned verifier → reject.
		assert.equal(same.breakerReason, "provider-diversity");
		assert.equal(same.agreement, "invalid");
		assert.equal(calls, 0);
	});

	it("multi-driver reservation is labels × drivers × (review + verify) and aggregates cost", async () => {
		// 1 × 2 × (5+5) = 20; cap 19 blocks before any call.
		let calls = 0;
		const blocked = await runPrReviewGate({
			pr: "1",
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 19, providerDiversity: "off" }),
			execFileSync: plainDiffExec(),
			runStep: async () => {
				calls++;
				return result();
			},
		});
		assert.equal(blocked.breakerReason, "budget");
		assert.equal(calls, 0);

		const review = await runPrReviewGate({
			pr: "1",
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 20, providerDiversity: "off" }),
			execFileSync: plainDiffExec(),
			runStep: async () => result({ cost: 1.5, turns: 3, costEstimated: true }),
		});
		assert.equal(review.gate, "pass");
		assert.equal(review.cost, 3);
		assert.equal(review.turns, 6);
		assert.equal(review.costEstimated, true);
	});

	it("scalar single-driver path still reports consensus-pass agreement", async () => {
		const review = await runPrReviewGate({
			pr: "1",
			reviewDrivers: [driver("claude")],
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 20, providerDiversity: "off" }),
			execFileSync: plainDiffExec(),
			runStep: async () => result(),
		});
		assert.equal(review.gate, "pass");
		assert.equal(review.agreement, "consensus-pass");
		assert.match(review.body, /providers=claude\//);
	});

	const REVIEWED_HEAD = "d".repeat(40);
	const mappableFinding = { severity: "must-fix" as const, message: "Broken parser.", path: "src/a.ts", line: 10 };
	function mappableDiffExec(): typeof import("node:child_process").execFileSync {
		const diff = ["diff --git a/src/a.ts b/src/a.ts", "index 1111111..2222222 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -8,5 +8,5 @@", " context", " context", "-old", "+new", " context", " context", ""].join("\n");
		return ((_: string, args: readonly string[]) => (args.includes("--name-only") ? "src/a.ts\n" : diff)) as typeof import("node:child_process").execFileSync;
	}

	it("emits SHA-bound adjudication source data for a complete consensus-block with mappable survivors", async () => {
		const review = await runPrReviewGate({
			pr: "497",
			itemId: "497",
			reviewedSha: REVIEWED_HEAD,
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "off" }),
			execFileSync: mappableDiffExec(),
			runStep: async (name) => {
				if (name === "pr-review") return result({ text: report("Block.", [mappableFinding]) });
				return verification([{ candidateId: "C1", decision: "survives", rationale: "Still present." }]);
			},
		});
		assert.equal(review.gate, "block");
		assert.equal(review.agreement, "consensus-block");
		assert.equal(review.ok, true);
		assert.ok(review.adjudicationSource);
		assert.equal(review.adjudicationSource.reviewedSha, REVIEWED_HEAD);
		assert.equal(review.adjudicationSource.prNumber, 497);
		assert.equal(review.adjudicationSource.itemId, "497");
		assert.equal(review.adjudicationSource.survivorCount, 1);
		assert.equal(review.adjudicationSource.survivors[0]?.tier, "safety");
		assert.equal(review.adjudicationSource.survivors[0]?.class, "correctness-regression");
		assert.deepEqual(review.adjudicationSource.survivors[0]?.hunk, { path: "src/a.ts", start: 8, end: 12 });
		assert.equal(review.adjudicationSource.survivors[0]?.finding.line, 10);
		assert.match(review.body, /agreement=consensus-block/);
	});

	it("does not emit adjudicable evidence without an explicit reviewed SHA", async () => {
		const review = await runPrReviewGate({
			pr: "497",
			itemId: "497",
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "off" }),
			execFileSync: mappableDiffExec(),
			runStep: async (name) => {
				if (name === "pr-review") return result({ text: report("Block.", [mappableFinding]) });
				return verification([{ candidateId: "C1", decision: "survives", rationale: "Still present." }]);
			},
		});
		assert.equal(review.agreement, "consensus-block");
		assert.equal(review.adjudicationSource, undefined);
	});

	it("does not emit adjudicable evidence for disagreement, invalid, or unmappable survivors", async () => {
		const disagreement = await runPrReviewGate({
			pr: "497",
			itemId: "497",
			reviewedSha: REVIEWED_HEAD,
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "off" }),
			execFileSync: mappableDiffExec(),
			runStep: async (name, _prompt, stepOpts) => {
				if (name === "pr-review") {
					return stepOpts.executionOverride?.provider === "claude" ? result({ text: report("Clean.") }) : result({ text: report("Block.", [mappableFinding]) });
				}
				return verification([{ candidateId: "C1", decision: "survives", rationale: "Yes." }]);
			},
		});
		assert.equal(disagreement.agreement, "disagreement");
		assert.equal(disagreement.adjudicationSource, undefined);

		const invalid = await runPrReviewGate({
			pr: "497",
			itemId: "497",
			reviewedSha: REVIEWED_HEAD,
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "off" }),
			execFileSync: mappableDiffExec(),
			runStep: async (_name, _prompt, stepOpts) => {
				if (stepOpts.executionOverride?.provider === "codex") return result({ text: "not a report" });
				return result({ text: report("Clean.") });
			},
		});
		assert.equal(invalid.agreement, "invalid");
		assert.equal(invalid.adjudicationSource, undefined);

		const unmappable = await runPrReviewGate({
			pr: "497",
			itemId: "497",
			reviewedSha: REVIEWED_HEAD,
			reviewDrivers: twoDrivers,
			policy: reviewPolicy({ maxPasses: 1, budgetCap: 40, providerDiversity: "off" }),
			execFileSync: mappableDiffExec(),
			runStep: async (name) => {
				if (name === "pr-review") return result({ text: report("Block.", [{ severity: "must-fix", message: "No location." }]) });
				return verification([{ candidateId: "C1", decision: "survives", rationale: "Still present." }]);
			},
		});
		assert.equal(unmappable.agreement, "consensus-block");
		assert.equal(unmappable.ok, true);
		assert.equal(unmappable.adjudicationSource, undefined);
		assert.match(unmappable.body, /No location/);
	});
});

describe("pr-review CLI local gate-evidence persistence (#497)", () => {
	const NEW_HEAD = "b".repeat(40);
	const redFinding = { severity: "must-fix" as const, message: "Broken parser.", path: "src/a.ts", line: 10 };
	const rollInspectionDiff = ["diff --git a/src/a.ts b/src/a.ts", "index 1111111..2222222 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -8,5 +8,5 @@", " context", " context", "-old", "+new", " context", " context", ""].join("\n");

	function redRoll(over: { ci?: boolean; headRef?: string } = {}) {
		return runCli({
			...over,
			files: "src/a.ts\n",
			diff: rollInspectionDiff,
			results: [result({ text: report("Block.", [redFinding]) }), verification([{ candidateId: "C1", decision: "survives", rationale: "Still present." }])],
		});
	}

	/** Full PrAdjudicateDeps against the roots a local pr-review run just wrote. */
	function adjudicateHarness(roll: { gateRecordsRoot: string; adjudicationSourcesRoot: string }): { deps: PrAdjudicateDeps; effects: string[]; comments: string[] } {
		const effects: string[] = [];
		const comments: string[] = [];
		const repo = tmpRoot("pr-review-adjudicate-flow-");
		const prPayload = JSON.stringify({ state: "OPEN", isDraft: false, headRefName: "feat/issue-123-fix", headRefOid: NEW_HEAD, headRepository: { nameWithOwner: "pelaggio/pelaggio" } });
		const deps: PrAdjudicateDeps = {
			repo,
			ghRepo: "pelaggio/pelaggio",
			shipTargetName: "pull-request",
			reviewRunner: "local",
			gh: (args) => {
				if (args[0] === "pr" && args[1] === "view") return { stdout: prPayload, stderr: "", status: 0 };
				if (args[0] === "api" && args[1] === "user") return { stdout: "operator\n", stderr: "", status: 0 };
				throw new Error(`unexpected gh call: ${args.join(" ")}`);
			},
			execFileSync: ((cmd: string, args: readonly string[]) => {
				assert.equal(cmd, "git");
				if (args[0] === "merge-base") return "";
				if (args[0] === "diff") {
					// A genuinely narrow fix: one in-range replacement inside the recorded hunk (8-12).
					return ["diff --git a/src/a.ts b/src/a.ts", "index 2222222..3333333 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,1 +10,1 @@", "-new", "+guarded", ""].join("\n");
				}
				throw new Error(`unexpected git: ${args.join(" ")}`);
			}) as typeof import("node:child_process").execFileSync,
			log: () => {},
			err: (msg) => effects.push(`err:${msg}`),
			now: () => Date.parse("2026-08-13T13:00:00Z"),
			mainWorktree: (cwd) => cwd,
			listGateRecords: listPrReviewGateRecords,
			gateRecordsRoot: roll.gateRecordsRoot,
			adjudicationSourcesRoot: roll.adjudicationSourcesRoot,
			readAdjudicationSource: readAdjudicationSourceRecord,
			readFileSync,
			writeGateRecord: writePrReviewGateRecord,
			prepareReviewHead: (_repo, candidate, _exec, headRef) => ({ diffCwd: "/tmp/adjudicate-flow-head", baseRef: "origin/main", headRef: headRef ?? `refs/pelaggio-review/pr-${candidate.prNumber}` }),
			cleanupReviewHead: () => {},
			runStep: async (name) => {
				effects.push(`step:${name}`);
				return verification([{ candidateId: "C1", decision: "refuted", rationale: "Fixed in the current head." }]);
			},
			resolveVerifySettings: () => driver("claude"),
			// #510 confinement seams pinned hermetic: the tmp repo is not a Git root, so the real
			// snapshot would read GONE and refuse before the verifier runs.
			listWorktrees: (forRepo) => [forRepo],
			snapshotMainRoot: () => "",
			createCheckoutObserver: () => ({
				beforeTool: () => ({ kind: "clean" as const }),
				afterTool: () => ({ kind: "clean" as const }),
				finish: () => ({ kind: "clean" as const }),
			}),
			upsertComment: (_gh, _repo, prNumber, body) => {
				effects.push(`comment:${prNumber}`);
				comments.push(body);
				return true;
			},
			postStatus: (_gh, _repo, sha, state) => {
				effects.push(`status:${state}:${sha}`);
				return true;
			},
			managedState: () => "managed",
			isCi: false,
			isSingleShot: false,
		};
		return { deps, effects, comments };
	}

	it("a local red roll persists drain-parity fleet + source evidence that pr-adjudicate binds to", async () => {
		const roll = await redRoll();
		assert.equal(roll.code, 1);
		// Fleet record: drain-parity shape, itemId resolved from the claim branch, adjudicable.
		const fleetRecord = readPrReviewGateRecord(roll.gateRecordsRoot, 123, REVIEWED_SHA);
		assert.ok(fleetRecord && fleetRecord.schemaVersion === 2 && fleetRecord.producer === "fleet");
		assert.equal(fleetRecord.itemId, "123");
		assert.equal(fleetRecord.agreement, "consensus-block");
		assert.equal(fleetRecord.survivorCount, 1);
		assert.equal(fleetRecord.runner, "local");
		assert.ok(isEligibleFleetGateRecord(fleetRecord));
		// SHA-bound source record with the pre-fix survives evidence and the mapped hunk.
		const source = readAdjudicationSourceRecord(roll.adjudicationSourcesRoot, 123, REVIEWED_SHA);
		assert.ok(source);
		assert.equal(source.itemId, "123");
		assert.equal(source.survivors[0]?.verification.rationale, "Still present.");
		assert.deepEqual(source.survivors[0]?.hunk, { path: "src/a.ts", start: 8, end: 12 });

		// The real pr-adjudicate CLI now finds CURRENT evidence from this roll and completes.
		const flow = adjudicateHarness(roll);
		assert.equal(await adjudicateMain(["--pr", "123"], flow.deps), 0);
		assert.ok(flow.effects.includes("step:pr-verify"), "safety survivor gets a live adjudication-time verification");
		assert.ok(flow.effects.includes(`status:success:${NEW_HEAD}`));
		// The persisted operator record quotes the LIVE refutation, never the stale survives text.
		const operator = readPrReviewGateRecord(roll.gateRecordsRoot, 123, NEW_HEAD);
		assert.ok(operator && operator.schemaVersion === 2 && operator.producer === "operator-adjudication");
		assert.equal(operator.reviewedSourceSha, REVIEWED_SHA);
		const rationale = operator.dispositions[reviewFindingFingerprint(redFinding)]?.rationale ?? "";
		assert.match(rationale, /Fixed in the current head\./);
		assert.doesNotMatch(rationale, /Still present/);
		assert.match(rationale, /adjudication-time/);
	});

	it("a clean local pass persists a drain-parity fleet record without adjudication source", async () => {
		const out = await runCli();
		assert.equal(out.code, 0);
		const record = readPrReviewGateRecord(out.gateRecordsRoot, 123, REVIEWED_SHA);
		assert.ok(record && record.schemaVersion === 2 && record.producer === "fleet");
		assert.equal(record.gate, "pass");
		assert.equal(record.agreement, "consensus-pass");
		assert.equal(readAdjudicationSourceRecord(out.adjudicationSourcesRoot, 123, REVIEWED_SHA), null);
	});

	it("a CI run posts the red status but persists no local gate evidence", async () => {
		const out = await redRoll({ ci: true });
		assert.equal(out.code, 1);
		assert.deepEqual(out.statuses, ["block"]);
		assert.deepEqual(listPrReviewGateRecords(out.gateRecordsRoot), []);
		assert.equal(readAdjudicationSourceRecord(out.adjudicationSourcesRoot, 123, REVIEWED_SHA), null);
	});

	it("persists nothing for a non-claim head branch or a parked gate", async () => {
		const manual = await redRoll({ headRef: "manual/fix" });
		assert.equal(manual.code, 1);
		assert.deepEqual(listPrReviewGateRecords(manual.gateRecordsRoot), []);

		const parked = await runCli({ results: [result({ ok: false, subtype: "error_rate_limit", cost: 0, turns: 0 })] });
		assert.equal(parked.code, 1);
		assert.deepEqual(listPrReviewGateRecords(parked.gateRecordsRoot), []);
	});
});
