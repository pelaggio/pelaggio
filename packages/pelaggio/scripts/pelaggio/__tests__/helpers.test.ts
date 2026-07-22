import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
	buildReviewDiffBlock,
	buildStepArgs,
	canRetryWithinBudget,
	checkpoint,
	classifyOutcome,
	classifySecurityReviewDiff,
	classifyStepError,
	computeImplementTurns,
	countPlanFiles,
	createMainCheckoutDeltaObserver,
	ensureMainCheckoutOnBranch,
	expandSkill,
	FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS,
	filesChangedSince,
	findLoggedArtifactAuthor,
	fmtWait,
	formatChangesUnderReview,
	formatResumeHint,
	formatReviewMetrics,
	getHeadSha,
	hasDeliverableCommits,
	isRefusal,
	isTransientSdkError,
	looksLikeRefusal,
	looksLikeStalledAsk,
	parseBlockedReason,
	parseDecisions,
	parseDeferredItems,
	parsePickItem,
	parsePickResult,
	parseResetTime,
	parseShipMerged,
	parseVerdict,
	parseWaitFlag,
	REVIEW_DIFF_MAX_BYTES,
	readGitBinding,
	readRuntimeVersions,
	resolveParkReset,
	revertPlanPolish,
	reviewFindingsPreamble,
	snapshotForbiddenRoot,
	uniqueDriverProvenance,
	verifyShipLanded,
} from "../helpers.js";

describe("findLoggedArtifactAuthor", () => {
	it("scans across entries and validates realized attribution", () => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-author-log-"));
		const path = join(dir, "log.jsonl");
		writeFileSync(path, `${JSON.stringify({ item: "245", steps: [{ name: "plan", ok: true }] })}\n${JSON.stringify({ item: "245", steps: [{ name: "implement", ok: true, provider: "codex", model: "gpt-5" }] })}\n`);
		assert.deepEqual(findLoggedArtifactAuthor("245", "implement", path), { provider: "codex", codexModel: "gpt-5" });
		assert.equal(findLoggedArtifactAuthor("245", "plan", path), undefined);
	});
});

describe("parseDecisions", () => {
	it("retains tolerant, ordered sentinels and parses canonical segments", () => {
		assert.deepEqual(parseDecisions("tool DECISION: ignored\n  DECISION: storage fork | chose: files | alternatives: sqlite | remote\nDECISION:\n decision: lower"), [
			{ fork: "storage fork", chosen: "files", alternatives: "sqlite | remote" },
			{ fork: "(unspecified decision)" },
		]);
	});

	it("keeps partial and non-final sentinels", () => {
		assert.deepEqual(parseDecisions("DECISION: first | chose: yes\nmore text\nDECISION: malformed | pipe"), [{ fork: "first", chosen: "yes" }, { fork: "malformed | pipe" }]);
	});
});

import type { RoadmapSource } from "../roadmap/types.js";

function makeFeatRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pelaggio-helpers-test-"));
	execSync("git init -q -b main", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config commit.gpgsign false", { cwd: dir });
	execSync("git commit --allow-empty -q -m init", { cwd: dir });
	execSync("git checkout -q -b feat/tool-99", { cwd: dir });
	return dir;
}

function commitFile(dir: string, rel: string, content: string, msg: string): void {
	const full = resolve(dir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
	execSync("git add -A", { cwd: dir });
	execSync(`git commit -q -m "${msg}"`, { cwd: dir });
}

describe("snapshotForbiddenRoot", () => {
	it("returns the first successful porcelain after transient execution failures", () => {
		const sleeps: number[] = [];
		let calls = 0;
		const status = "?? leaked.txt";
		const result = snapshotForbiddenRoot("/tmp/forbidden-root", {
			attempts: 3,
			retryDelayMs: 25,
			sleepSync: (ms) => {
				sleeps.push(ms);
			},
			run: () => {
				calls++;
				if (calls < 3) throw new Error("index.lock: File exists");
				return status;
			},
		});
		assert.equal(result, status);
		assert.equal(calls, 3);
		assert.deepEqual(sleeps, [25, 25]);
	});

	it("throws with root and underlying message after exhausting attempts", () => {
		const sleeps: number[] = [];
		let calls = 0;
		assert.throws(
			() =>
				snapshotForbiddenRoot("/tmp/broken-root", {
					attempts: FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS,
					retryDelayMs: 10,
					sleepSync: (ms) => {
						sleeps.push(ms);
					},
					run: () => {
						calls++;
						const err = new Error("Command failed: git status");
						(err as Error & { stderr: string }).stderr = "fatal: Unable to create '.git/index.lock': File exists";
						throw err;
					},
				}),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /failed to snapshot forbidden root \/tmp\/broken-root:/);
				assert.match(e.message, /index\.lock/);
				return true;
			},
		);
		assert.equal(calls, FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS);
		assert.equal(sleeps.length, FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS - 1);
	});

	it("does not retry a successful dirty porcelain observation", () => {
		const sleeps: number[] = [];
		let calls = 0;
		const dirty = " M packages/pelaggio/scripts/pelaggio/helpers.ts";
		const result = snapshotForbiddenRoot("/tmp/dirty-root", {
			attempts: 3,
			retryDelayMs: 25,
			sleepSync: (ms) => {
				sleeps.push(ms);
			},
			run: () => {
				calls++;
				return dirty;
			},
		});
		assert.equal(result, dirty);
		assert.equal(calls, 1);
		assert.deepEqual(sleeps, []);
	});
});

describe("createMainCheckoutDeltaObserver", () => {
	it("tolerates unchanged clean and pre-existing dirty baselines", () => {
		const dir = makeFeatRepo();
		writeFileSync(join(dir, "operator.txt"), "existing");
		const observer = createMainCheckoutDeltaObserver(dir);
		assert.deepEqual(observer.beforeTool("one"), { kind: "clean" });
		assert.deepEqual(observer.afterTool("one"), { kind: "clean" });
		assert.deepEqual(observer.finish(), { kind: "clean" });
	});

	it("retains a main delta after a later clean tool window", () => {
		const dir = makeFeatRepo();
		const observer = createMainCheckoutDeltaObserver(dir);
		observer.beforeTool("write");
		writeFileSync(join(dir, "escaped.txt"), "x");
		assert.deepEqual(observer.afterTool("write"), { kind: "violation", roots: [resolve(dir)] });
		observer.beforeTool("clean");
		observer.afterTool("clean");
		assert.deepEqual(observer.finish(), { kind: "violation", roots: [resolve(dir)] });
	});

	it("supports overlapping invocation baselines", () => {
		const dir = makeFeatRepo();
		const observer = createMainCheckoutDeltaObserver(dir);
		observer.beforeTool("a");
		observer.beforeTool("b");
		writeFileSync(join(dir, "escaped.txt"), "x");
		observer.afterTool("b");
		observer.afterTool("a");
		assert.equal(observer.finish().kind, "violation");
	});

	it("fails closed for duplicate, missing, open, and unsnapshotable invocations", () => {
		const duplicate = createMainCheckoutDeltaObserver(makeFeatRepo());
		duplicate.beforeTool("same");
		assert.deepEqual(duplicate.beforeTool("same").kind, "error");

		const missing = createMainCheckoutDeltaObserver(makeFeatRepo());
		assert.equal(missing.afterTool("absent").kind, "error");

		const open = createMainCheckoutDeltaObserver(makeFeatRepo());
		open.beforeTool("open");
		assert.match(open.finish().kind === "error" ? open.finish().message : "", /unclosed/);

		const broken = createMainCheckoutDeltaObserver(join(tmpdir(), "does-not-exist-pelaggio"));
		assert.equal(broken.beforeTool("x").kind, "error");
		assert.deepEqual(broken.finish(), broken.finish(), "finish is idempotent");
	});
});

describe("parseWaitFlag", () => {
	it("parses hours", () => {
		assert.equal(parseWaitFlag("6h"), 21_600_000);
	});

	it("parses minutes", () => {
		assert.equal(parseWaitFlag("90m"), 5_400_000);
	});

	it("parses combined hours and minutes", () => {
		assert.equal(parseWaitFlag("1h30m"), 5_400_000);
	});

	it("treats bare number as minutes", () => {
		assert.equal(parseWaitFlag("360"), 21_600_000);
	});

	it("falls back to 6h on garbage input", () => {
		assert.equal(parseWaitFlag("garbage"), 21_600_000);
	});

	it("parses hours-only without minutes", () => {
		assert.equal(parseWaitFlag("2h"), 7_200_000);
	});

	it("parses minutes-only without hours", () => {
		assert.equal(parseWaitFlag("5m"), 300_000);
	});

	it('returns 0ms for "0h"', () => {
		assert.equal(parseWaitFlag("0h"), 0);
	});

	it('returns 0ms for "0m"', () => {
		assert.equal(parseWaitFlag("0m"), 0);
	});

	it("falls back to 6h for empty string", () => {
		assert.equal(parseWaitFlag(""), 21_600_000);
	});
});

describe("resolveParkReset", () => {
	const NOW = 1_700_000_000_000;
	const HOUR = 3_600_000;
	const resetText = "resets 4:30pm (America/Edmonton)"; // parseResetTime → a concrete future ts

	it("trusts a concrete reset already on the event", () => {
		const r = resolveParkReset(NOW + 5 * HOUR, true, "5h", resetText, NOW, HOUR);
		assert.deepEqual(r, { resetsAt: NOW + 5 * HOUR, limitType: "5h" });
	});

	it("a reset parsed from text wins over the estimate (regression: don't clobber a real reset)", () => {
		const r = resolveParkReset(0, true, "5h", resetText, NOW, HOUR);
		assert.equal(r.resetsAt, parseResetTime(resetText));
		assert.equal(r.limitType, "5h"); // not marked (estimated) — it's a real reset
	});

	it("estimates + marks (estimated) for a rate-limit park with no reset anywhere (Codex 429)", () => {
		const r = resolveParkReset(0, true, "unknown", "no reset here", NOW, HOUR);
		assert.deepEqual(r, { resetsAt: NOW + HOUR, limitType: "unknown (estimated)" });
	});

	it("a manual pause (not a rate-limit park) with no reset keeps 0 → hands back", () => {
		const r = resolveParkReset(0, false, "paused", "no reset here", NOW, HOUR);
		assert.deepEqual(r, { resetsAt: 0, limitType: "paused" });
	});

	it("negative reported reset falls through to the estimate", () => {
		const r = resolveParkReset(-1, true, "weekly", "no reset here", NOW, HOUR);
		assert.deepEqual(r, { resetsAt: NOW + HOUR, limitType: "weekly (estimated)" });
	});
});

describe("revertPlanPolish", () => {
	const headSha = (dir: string) => execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();

	it("reverts committed docs/plans edits made during implement, preserving code changes", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "docs/plans/tool-99.md", "# Plan\noriginal\n", "plan: write plan");
		const sinceSha = headSha(dir); // state after the plan step
		// implement polishes the plan AND writes real code — both committed (checkpoint).
		commitFile(dir, "docs/plans/tool-99.md", "# Plan\npolished during implement\n", "wip: implement");
		commitFile(dir, "src/feature.ts", "export const x = 1;\n", "wip: implement code");

		const reverted = revertPlanPolish(dir, sinceSha);

		assert.deepEqual(reverted, ["docs/plans/tool-99.md"]);
		assert.equal(readFileSync(resolve(dir, "docs/plans/tool-99.md"), "utf-8"), "# Plan\noriginal\n", "plan restored");
		assert.equal(readFileSync(resolve(dir, "src/feature.ts"), "utf-8"), "export const x = 1;\n", "code change preserved");
	});

	it("is a no-op when implement touched no docs/plans files (hook-guarded Claude path)", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "docs/plans/tool-99.md", "# Plan\n", "plan");
		const sinceSha = headSha(dir);
		commitFile(dir, "src/feature.ts", "export const x = 1;\n", "wip: implement");
		assert.deepEqual(revertPlanPolish(dir, sinceSha), []);
	});

	it("removes a plan file ADDED during implement (parity with the Write-blocking hook)", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "docs/plans/tool-99.md", "# Plan\n", "plan");
		const sinceSha = headSha(dir);
		commitFile(dir, "docs/plans/extra.md", "sneaky new plan doc\n", "wip: implement adds a plan file");

		const reverted = revertPlanPolish(dir, sinceSha);

		assert.deepEqual(reverted, ["docs/plans/extra.md"]);
		assert.ok(!existsSync(resolve(dir, "docs/plans/extra.md")), "added plan file must be removed, not left behind");
		assert.equal(readFileSync(resolve(dir, "docs/plans/tool-99.md"), "utf-8"), "# Plan\n", "original plan untouched");
	});

	it("restores a plan file DELETED during implement", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "docs/plans/tool-99.md", "# Plan\nkeep me\n", "plan");
		const sinceSha = headSha(dir);
		execSync("git rm -q docs/plans/tool-99.md && git commit -q -m 'wip: implement deletes plan'", { cwd: dir });

		const reverted = revertPlanPolish(dir, sinceSha);

		assert.deepEqual(reverted, ["docs/plans/tool-99.md"]);
		assert.equal(readFileSync(resolve(dir, "docs/plans/tool-99.md"), "utf-8"), "# Plan\nkeep me\n", "deleted plan restored");
	});

	it("returns [] when sinceSha is null", () => {
		assert.deepEqual(revertPlanPolish(makeFeatRepo(), null), []);
	});
});

describe("buildStepArgs (#103, #115)", () => {
	const mk = (getItem: RoadmapSource["getItem"]) => ({ getItem }) as unknown as RoadmapSource;

	it("injects title + body + the do-not-fetch gate for an item with a body", async () => {
		const args = await buildStepArgs(
			mk(async () => ({ id: "45", title: "Do the thing", deps: "—", sourceRef: "o/r#45", status: "open", body: "## Requirements\nthe full spec" })),
			"45",
		);
		assert.match(args, /^pelaggio\n/);
		assert.match(args, /do NOT run `roadmap get`/);
		assert.match(args, /Title: Do the thing/);
		assert.match(args, /the full spec/);
		assert.match(args, /sourceRef: o\/r#45/);
	});

	it("carries the mode into the gate line (shakedown code-review)", async () => {
		const args = await buildStepArgs(
			mk(async () => ({ id: "7", title: "t", deps: "—", sourceRef: "o/r#7", status: "open", body: "spec" })),
			"7",
			"code-review",
		);
		assert.match(args, /^pelaggio code-review\n/);
		assert.match(args, /Title: t/);
	});

	it("emits a read-the-sourceRef note when the adapter gives no body (markdown)", async () => {
		const args = await buildStepArgs(
			mk(async () => ({ id: "T-1", title: "x", deps: "—", sourceRef: "docs/roadmap-x.md", status: "open" })),
			"T-1",
		);
		assert.match(args, /sourceRef: docs\/roadmap-x\.md/);
		assert.match(args, /read it for the full spec/);
	});

	it("degrades to the bare gate (with mode) when getItem throws (e.g. no network)", async () => {
		const args = await buildStepArgs(
			mk(async () => {
				throw new Error("no network");
			}),
			"9",
			"plan-review",
		);
		assert.equal(args, "pelaggio plan-review");
	});
});

describe("parseDeferredItems (#115)", () => {
	it("parses deferred-item markers into CreateItemOpts with deferred:true", () => {
		const text = ["Some review prose.", 'deferred-item: {"title": "Add retries", "scope": "S", "deps": "T-1, T-2"}', 'deferred-item: {"title": "Doc the flag"}', "more prose"].join("\n");
		const items = parseDeferredItems(text);
		assert.equal(items.length, 2);
		assert.deepEqual(items[0], { title: "Add retries", scope: "S", deps: ["T-1", "T-2"], deferred: true });
		assert.deepEqual(items[1], { title: "Doc the flag", deferred: true });
	});

	it("skips malformed JSON, title-less, and invalid-scope entries gracefully", () => {
		const text = [
			"deferred-item: {not json}",
			'deferred-item: {"scope": "M"}', // no title
			'deferred-item: {"title": "  "}', // blank title
			'deferred-item: {"title": "Keep", "scope": "HUGE"}', // invalid scope dropped, item kept
		].join("\n");
		const items = parseDeferredItems(text);
		assert.deepEqual(items, [{ title: "Keep", deferred: true }]);
	});

	it("returns [] when there are no markers", () => {
		assert.deepEqual(parseDeferredItems("just a normal review with no deferrals"), []);
	});

	it("handles a `}` inside a string value and normalizes lowercase scope", () => {
		const items = parseDeferredItems('deferred-item: {"title": "fix the } brace", "scope": "s"}');
		assert.deepEqual(items, [{ title: "fix the } brace", scope: "S", deferred: true }]);
	});

	it("does not match a mid-line/prose mention of deferred-item: (line-anchored)", () => {
		assert.deepEqual(parseDeferredItems('The reviewer said deferred-item: {"title": "X"} inline in a sentence.'), []);
	});

	it("dedups by title (createItem is not idempotent)", () => {
		const items = parseDeferredItems(['deferred-item: {"title": "Add retries"}', 'deferred-item: {"title": "add retries", "scope": "M"}'].join("\n"));
		assert.equal(items.length, 1, "case-insensitive title dedup keeps the first");
		assert.equal(items[0].title, "Add retries");
	});
});

describe("fmtWait", () => {
	it("formats zero as <1m", () => {
		assert.equal(fmtWait(0), "<1m");
	});

	it("formats exactly 1 minute", () => {
		assert.equal(fmtWait(60_000), "1m");
	});

	it("formats hours and minutes", () => {
		assert.equal(fmtWait(5_400_000), "1h 30m");
	});

	it("formats exact hours", () => {
		assert.equal(fmtWait(3_600_000), "1h");
	});

	it("formats small durations", () => {
		assert.equal(fmtWait(270_000), "5m");
	});

	it("rounds up partial minutes", () => {
		assert.equal(fmtWait(61_000), "2m");
	});

	it("rounds up 30s to 1m", () => {
		assert.equal(fmtWait(30_000), "1m");
	});

	it("formats negative as <1m", () => {
		assert.equal(fmtWait(-1000), "<1m");
	});
});

describe("formatResumeHint", () => {
	it("emits --resume, not --item (#56: --item is refused by pick's worktree-exists guard)", () => {
		assert.equal(formatResumeHint(["X-1"]), "pnpm pelaggio --resume X-1");
	});

	it("emits one --resume command per id, joined for aligned multi-line display", () => {
		assert.equal(formatResumeHint(["X-1", "X-2"]), "pnpm pelaggio --resume X-1\n          pnpm pelaggio --resume X-2");
	});
});

describe("parseResetTime", () => {
	it("returns 0 for invalid input", () => {
		assert.equal(parseResetTime("no match here"), 0);
	});

	it("returns 0 for empty string", () => {
		assert.equal(parseResetTime(""), 0);
	});

	it("parses valid reset time to a future timestamp", () => {
		// Build a time string that's always in the future (next hour)
		const now = new Date();
		const futureHour = (now.getUTCHours() + 2) % 12 || 12;
		const period = (now.getUTCHours() + 2) % 24 >= 12 ? "pm" : "am";
		const msg = `resets ${futureHour}${period} (UTC)`;
		const result = parseResetTime(msg);
		assert.ok(result > 0, `expected positive timestamp, got ${result}`);
		assert.ok(result > Date.now() - 86_400_000, "timestamp should be reasonable");
	});

	it("parses time with minutes", () => {
		const msg = "resets 4:30pm (America/Edmonton)";
		const result = parseResetTime(msg);
		// Should return a valid timestamp (either today or tomorrow)
		assert.ok(result > 0, `expected positive timestamp, got ${result}`);
	});
});

describe("filesChangedSince", () => {
	it("returns [] when preSha is null", () => {
		assert.deepEqual(filesChangedSince("/does/not/matter", null), []);
	});

	it("returns [] when preSha matches HEAD (no-op)", () => {
		const dir = makeFeatRepo();
		const head = getHeadSha(dir);
		assert.ok(head);
		assert.deepEqual(filesChangedSince(dir, head), []);
	});
});

describe("buildReviewDiffBlock (authoring-loop reviewer diff injection)", () => {
	it("injects the actual branch diff so a single-turn seat has real code to review", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "src/thing.ts", "export const answer = 42;\n", "feat: add thing");
		const block = buildReviewDiffBlock(dir);
		assert.match(block, /CHANGES UNDER REVIEW/);
		// The changed hunk is present in the reviewer's prompt without the seat running git itself.
		assert.match(block, /export const answer = 42;/);
		assert.match(block, /src\/thing\.ts/);
		assert.match(block, /```diff/);
	});

	it("emits an empty-diff note (never crashes) when the branch matches main", () => {
		const dir = makeFeatRepo();
		const block = buildReviewDiffBlock(dir);
		assert.match(block, /CHANGES UNDER REVIEW/);
		assert.match(block, /diff against `main` is empty/);
	});

	it("emits an unavailable note when git cannot compute the diff", () => {
		const block = buildReviewDiffBlock("/does/not/exist");
		assert.match(block, /could not compute the branch diff/);
		assert.match(block, /Run `git diff main\.\.\.HEAD`/);
	});

	it("bounds the injected diff and points the seat at the remainder", () => {
		const dir = makeFeatRepo();
		// One large file well over the injection cap.
		const big = `${"export const x = 1;\n".repeat(Math.ceil(REVIEW_DIFF_MAX_BYTES / 10))}`;
		commitFile(dir, "src/big.ts", big, "feat: big file");
		const block = buildReviewDiffBlock(dir);
		assert.match(block, /diff truncated at the injection cap/);
		assert.ok(Buffer.byteLength(block, "utf-8") < REVIEW_DIFF_MAX_BYTES + 2048, "injected block stays near the cap");
	});

	it("formatChangesUnderReview is pure and covers every state", () => {
		assert.match(formatChangesUnderReview("", "empty"), /empty/);
		assert.match(formatChangesUnderReview("", "unavailable"), /could not compute/);
		assert.match(formatChangesUnderReview("+a", "ok"), /```diff\n\+a\n```/);
		assert.match(formatChangesUnderReview("+a", "truncated"), /truncated at the injection cap/);
		// A real review that echoes the schema example would be caught downstream; here we just confirm
		// injected content lands verbatim inside the fence.
		assert.match(formatChangesUnderReview("- old\n+ new", "ok"), /- old\n\+ new/);
	});

	it("the composed authoring-loop reviewer prompt carries both the review contract and the diff", () => {
		// Mirrors pipeline.ts: `${expandSkill("pr-review","--authoring-loop")}\n\n${reviewDiffBlock}`.
		// A single-turn codex seat that never runs git now sees the changed hunk directly in-prompt.
		const dir = makeFeatRepo();
		commitFile(dir, "src/thing.ts", "export const answer = 42;\n", "feat: add thing");
		const skillBody = expandSkill("pr-review", "--authoring-loop");
		const reviewerPrompt = `${skillBody}\n\n${buildReviewDiffBlock(dir)}`;
		assert.match(reviewerPrompt, /AUTHORING_REVIEW_FINDINGS/); // the review reporting contract
		assert.match(reviewerPrompt, /CHANGES UNDER REVIEW/);
		assert.match(reviewerPrompt, /export const answer = 42;/); // the actual changed hunk
	});

	it("the authoring-loop reviewer skill compels multi-turn inspection before findings", () => {
		// Parity fix: a single-turn seat (codex) treated the advisory 'Inspect...' line as a one-shot
		// prompt and answered immediately. The mode now carries an imperative inspection protocol so the
		// seat runs git + reads files + runs checks across turns before emitting the report.
		const body = expandSkill("pr-review", "--authoring-loop");
		assert.match(body, /Mandatory inspection protocol/);
		assert.match(body, /not\W+a\s+one-shot answer/i);
		assert.match(body, /git diff main\.\.\.HEAD/);
		assert.match(body, /read each changed file in\s+full/);
		assert.match(body, /pnpm check/);
		assert.match(body, /do not emit findings|keep working/i);
	});
});

describe("hasDeliverableCommits", () => {
	it("returns true when branch has a non-plan code commit", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "src/foo.ts", "export const x = 1;\n", "feat code");
		assert.equal(hasDeliverableCommits(dir), true);
	});

	it("returns false when branch only touches docs/plans/ (plan-only ghost)", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "docs/plans/x.md", "# plan\n", "docs plan");
		assert.equal(hasDeliverableCommits(dir), false);
	});

	it("returns true for doc-only work outside docs/plans/ (rubric/skill edits)", () => {
		const dir = makeFeatRepo();
		commitFile(dir, ".claude/skills/_rubric.md", "# rubric\n", "rubric edit");
		assert.equal(hasDeliverableCommits(dir), true);
	});

	it("returns true for README-only edits (not a plan)", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "README.md", "# readme\n", "readme only");
		assert.equal(hasDeliverableCommits(dir), true);
	});

	it("returns true for docs/ edits that are not plans (e.g. roadmap)", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "docs/roadmap-core.md", "# roadmap\n", "roadmap edit");
		assert.equal(hasDeliverableCommits(dir), true);
	});

	it("returns false when branch is identical to main", () => {
		const dir = makeFeatRepo();
		assert.equal(hasDeliverableCommits(dir), false);
	});

	it("returns false for a non-existent worktree (no throw)", () => {
		assert.equal(hasDeliverableCommits("/nonexistent/path/does/not/exist"), false);
	});

	it("returns true when branch has plan + code commits", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "docs/plans/x.md", "# plan\n", "plan");
		commitFile(dir, "src/foo.ts", "export const x = 1;\n", "code");
		assert.equal(hasDeliverableCommits(dir), true);
	});

	it("returns false when feat branch is plan-only but main advanced independently", () => {
		// Regression for two-dot vs three-dot diff: if main has moved forward
		// with code/doc commits since the feat branch was created, a two-dot
		// diff (`main..HEAD`) would show those files too and falsely credit
		// the feat branch with them. Three-dot (`main...HEAD`) only counts
		// changes on the feat branch side.
		const dir = makeFeatRepo();
		commitFile(dir, "docs/plans/x.md", "# plan\n", "plan-only on feat");
		execSync("git checkout -q main", { cwd: dir });
		commitFile(dir, "src/unrelated.ts", "export const y = 2;\n", "main moved ahead");
		execSync("git checkout -q feat/tool-99", { cwd: dir });
		assert.equal(hasDeliverableCommits(dir), false);
	});
});

describe("verifyShipLanded", () => {
	it("returns true when main advanced (feat merged in)", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "src/foo.ts", "export const x = 1;\n", "feat code");
		const featSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
		execSync("git checkout -q main", { cwd: dir });
		const mainBefore = execSync("git rev-parse main", { cwd: dir, encoding: "utf-8" }).trim();
		execSync("git merge feat/tool-99 --no-edit -q", { cwd: dir });
		assert.equal(verifyShipLanded(dir, mainBefore, featSha), true);
	});

	it("returns false when main did not advance (ghost-ship)", () => {
		const dir = makeFeatRepo();
		commitFile(dir, "src/foo.ts", "export const x = 1;\n", "feat code");
		const featSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
		const mainSha = execSync("git rev-parse main", { cwd: dir, encoding: "utf-8" }).trim();
		// main never merged the feat branch.
		assert.equal(verifyShipLanded(dir, mainSha, featSha), false);
	});

	it("fails closed: a git error during verification returns false (routes to /shipwreck, not a blind push)", () => {
		assert.equal(verifyShipLanded("/nonexistent/path/does/not/exist", "deadbeef", "cafebabe"), false);
	});
});

describe("ensureMainCheckoutOnBranch", () => {
	it("returns true and does nothing when already on the target branch", () => {
		const dir = makeFeatRepo();
		execSync("git checkout -q main", { cwd: dir });
		assert.equal(
			ensureMainCheckoutOnBranch(dir, "main", () => assert.fail("should not log")),
			true,
		);
		assert.equal(execSync("git branch --show-current", { cwd: dir, encoding: "utf-8" }).trim(), "main");
	});

	it("reattaches and returns true when on a different branch", () => {
		const dir = makeFeatRepo(); // checked out on feat/tool-99
		const messages: string[] = [];
		assert.equal(
			ensureMainCheckoutOnBranch(dir, "main", (m) => messages.push(m)),
			true,
		);
		assert.equal(execSync("git branch --show-current", { cwd: dir, encoding: "utf-8" }).trim(), "main");
		assert.match(messages[0], /feat\/tool-99/);
	});

	it("reattaches and returns true when HEAD is detached", () => {
		const dir = makeFeatRepo();
		execSync("git checkout -q main", { cwd: dir });
		const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
		execSync(`git checkout -q ${sha}`, { cwd: dir });
		assert.equal(execSync("git branch --show-current", { cwd: dir, encoding: "utf-8" }).trim(), "");
		const messages: string[] = [];
		assert.equal(
			ensureMainCheckoutOnBranch(dir, "main", (m) => messages.push(m)),
			true,
		);
		assert.equal(execSync("git branch --show-current", { cwd: dir, encoding: "utf-8" }).trim(), "main");
		assert.match(messages[0], /detached HEAD/);
	});

	it("fails closed: a nonexistent repo returns false", () => {
		assert.equal(
			ensureMainCheckoutOnBranch("/nonexistent/path/does/not/exist", "main", () => {}),
			false,
		);
	});
});

describe("parsePickResult", () => {
	it("accepts the already-claimed tag (issue #12 race loser)", () => {
		assert.equal(parsePickResult("pick-result: already-claimed"), "already-claimed");
	});

	it("returns null when no tag is present", () => {
		assert.equal(parsePickResult("nothing to see here"), null);
	});

	it("parses claimed", () => {
		assert.equal(parsePickResult("done\npick-result: claimed\n"), "claimed");
	});

	it("parses blocked", () => {
		assert.equal(parsePickResult("pick-result: blocked"), "blocked");
	});

	it("parses unknown-id", () => {
		assert.equal(parsePickResult("pick-result: unknown-id"), "unknown-id");
	});

	it("parses already-done", () => {
		assert.equal(parsePickResult("pick-result: already-done"), "already-done");
	});

	it("parses worktree-exists", () => {
		assert.equal(parsePickResult("pick-result: worktree-exists"), "worktree-exists");
	});

	it("parses queue-empty", () => {
		assert.equal(parsePickResult("pick-result: queue-empty"), "queue-empty");
	});

	it("last occurrence wins", () => {
		const text = "pick-result: queue-empty\nsome summary...\npick-result: claimed\n";
		assert.equal(parsePickResult(text), "claimed");
	});

	it("tolerates leading/trailing whitespace", () => {
		assert.equal(parsePickResult("   pick-result:  blocked   "), "blocked");
	});

	it("is case-insensitive on the key", () => {
		assert.equal(parsePickResult("PICK-RESULT: claimed"), "claimed");
	});

	it("returns null for unknown tag", () => {
		assert.equal(parsePickResult("pick-result: bogus"), null);
	});
});

describe("parsePickItem", () => {
	it("parses a plain ID", () => {
		assert.equal(parsePickItem("pick-item: TOOL-9"), "TOOL-9");
	});

	it("parses a nested/hierarchical ID", () => {
		assert.equal(parsePickItem("pick-item: COMP-11C-II"), "COMP-11C-II");
	});

	it("returns null when absent", () => {
		assert.equal(parsePickItem("nothing to see here"), null);
	});

	it("last occurrence wins when repeated", () => {
		const text = "pick-item: TOOL-1\nsummary...\npick-item: TOOL-2\n";
		assert.equal(parsePickItem(text), "TOOL-2");
	});

	it("rejects malformed values", () => {
		assert.equal(parsePickItem("pick-item: foo bar"), null);
		assert.equal(parsePickItem("pick-item: lowercase-99"), null);
		assert.equal(parsePickItem("pick-item: "), null);
	});
});

describe("parseShipMerged", () => {
	it("parses a plain markdown ID", () => {
		assert.equal(parseShipMerged("ship-merged: TOOL-99"), "TOOL-99");
	});

	it("parses a nested/hierarchical ID", () => {
		assert.equal(parseShipMerged("ship-merged: COMP-11C-II"), "COMP-11C-II");
	});

	it("parses a bare numeric github ID", () => {
		assert.equal(parseShipMerged("ship-merged: 37"), "37");
	});

	it("returns null when absent", () => {
		assert.equal(parseShipMerged("nothing to see here"), null);
	});

	it("last occurrence wins when repeated", () => {
		const text = "ship-merged: TOOL-1\nsummary...\nship-merged: TOOL-2\n";
		assert.equal(parseShipMerged(text), "TOOL-2");
	});

	it("rejects malformed values", () => {
		assert.equal(parseShipMerged("ship-merged: foo bar"), null);
		assert.equal(parseShipMerged("ship-merged: "), null);
	});

	it("tolerates surrounding whitespace and a trailing report line", () => {
		assert.equal(parseShipMerged("   ship-merged:  TOOL-99   "), "TOOL-99");
		assert.equal(parseShipMerged("Merged and verified.\nship-merged: TOOL-99\n"), "TOOL-99");
	});

	it("preserves case (returns the raw token, not lowercased)", () => {
		assert.equal(parseShipMerged("ship-merged: Tool-99"), "Tool-99");
	});
});

describe("countPlanFiles", () => {
	it("parses a Files-to-change table", () => {
		const body = ["# Plan", "", "## Files to change", "", "| Path | Change |", "|------|--------|", "| `scripts/a.ts` | thing |", "| `scripts/b.ts` | thing |", "| `scripts/c.ts` | thing |", "", "## Other"].join("\n");
		assert.equal(countPlanFiles(body), 3);
	});

	it("dedupes repeats in the table", () => {
		const body = ["## Files", "", "| Path | Change |", "|------|--------|", "| `x.ts` | a |", "| `x.ts` | b |", "| `y.ts` | c |"].join("\n");
		assert.equal(countPlanFiles(body), 2);
	});

	it("falls back to path-shaped tokens when no Files table exists", () => {
		const body = ["# Plan", "Touch scripts/foo.ts and scripts/bar.ts.", "Also scripts/config.yml."].join("\n");
		assert.equal(countPlanFiles(body), 3);
	});

	it("ignores path-shaped tokens inside fenced code blocks", () => {
		const body = ["# Plan", "", "```ts", "import { x } from './foo.ts';", "```", "", "Edit scripts/a.ts."].join("\n");
		assert.equal(countPlanFiles(body), 1);
	});

	it("ignores docs/plans/ self-references in the fallback", () => {
		const body = "See docs/plans/thing.md. Touch scripts/a.ts.";
		assert.equal(countPlanFiles(body), 1);
	});

	it("returns 0 for empty body", () => {
		assert.equal(countPlanFiles(""), 0);
	});
});

describe("computeImplementTurns", () => {
	it("returns fallback when plan is null", () => {
		assert.equal(computeImplementTurns(null, 200), 200);
	});

	it("returns fallback when plan has 0 files", () => {
		assert.equal(computeImplementTurns("# Plan with no paths\nJust prose.\n", 200), 200);
	});

	it("clamps small file counts up to 100", () => {
		const body = ["## Files", "", "| Path | Change |", "|---|---|", "| `a.ts` | x |"].join("\n");
		// 2*1 + 60 = 62 → clamped to 100
		assert.equal(computeImplementTurns(body, 200), 100);
	});

	it("scales linearly in the middle band", () => {
		const rows = Array.from({ length: 30 }, (_, i) => `| \`file${i}.ts\` | x |`).join("\n");
		const body = ["## Files", "", "| Path | Change |", "|---|---|", rows].join("\n");
		// 2*30 + 60 = 120
		assert.equal(computeImplementTurns(body, 200), 120);
	});

	it("clamps large file counts to 250", () => {
		const rows = Array.from({ length: 150 }, (_, i) => `| \`file${i}.ts\` | x |`).join("\n");
		const body = ["## Files", "", "| Path | Change |", "|---|---|", rows].join("\n");
		// 2*150 + 60 = 360 → clamped to 250
		assert.equal(computeImplementTurns(body, 200), 250);
	});
});

describe("canRetryWithinBudget", () => {
	it("allows the retry when remaining budget ≥ step budget", () => {
		assert.equal(canRetryWithinBudget({ spent: 10, maxBudget: 40, stepBudget: 25 }), true);
	});

	it("skips the retry when remaining budget < step budget", () => {
		assert.equal(canRetryWithinBudget({ spent: 20, maxBudget: 40, stepBudget: 25 }), false);
	});

	it("allows the retry at the exact boundary (remaining === step budget)", () => {
		assert.equal(canRetryWithinBudget({ spent: 15, maxBudget: 40, stepBudget: 25 }), true);
	});

	it("disables the gate for a non-finite maxBudget (unset / unparseable --budget)", () => {
		assert.equal(canRetryWithinBudget({ spent: 100, maxBudget: NaN, stepBudget: 25 }), true);
	});
});

describe("classifyStepError", () => {
	it("classifies rate-limit messages", () => {
		assert.equal(classifyStepError("rate limit exceeded", false), "error_rate_limit");
		assert.equal(classifyStepError("usage limit reached", false), "error_rate_limit");
		assert.equal(classifyStepError("quota exhausted", false), "error_rate_limit");
	});

	it("lets the authoritative parked flag win over an unrelated message", () => {
		assert.equal(classifyStepError("some unrelated failure", true), "error_rate_limit");
	});

	it("does NOT classify a safety 'rejected' as a rate limit (dropped-word regression guard)", () => {
		assert.equal(classifyStepError("request rejected by safety filter", false), "error_sdk");
	});

	it("classifies budget, abort, and max-turns", () => {
		assert.equal(classifyStepError("budget exceeded", false), "error_budget");
		assert.equal(classifyStepError("aborted", false), "error_abort");
		assert.equal(classifyStepError("max turns reached", false), "error_max_turns");
	});

	it("falls through to error_sdk for a generic message", () => {
		assert.equal(classifyStepError("something else broke", false), "error_sdk");
	});
});

describe("isTransientSdkError", () => {
	it("matches transient provider and transport failures", () => {
		for (const text of [
			"Anthropic API error: 500 Internal server error",
			"model overloaded, please try again",
			"temporarily unavailable",
			"service unavailable",
			"read ECONNRESET",
			"request ETIMEDOUT",
			"connect ECONNREFUSED",
			"socket hang up",
			"fetch failed",
			"upstream returned 502",
			"status code 503",
			"gateway timeout 504",
		]) {
			assert.equal(isTransientSdkError({ subtype: "error_sdk", text }), true, text);
		}
	});

	it("does not match fatal provider/config/user failures", () => {
		for (const text of ["invalid api key", "authentication failed", "unauthorized", "forbidden", "permission denied", "bad request", "status 400", "status 404", "unprocessable entity 422"]) {
			assert.equal(isTransientSdkError({ subtype: "error_sdk", text }), false, text);
		}
	});

	it("lets fatal exclusions win over transient-looking text", () => {
		assert.equal(isTransientSdkError({ subtype: "error_sdk", text: "401 unauthorized; upstream also mentioned 500 Internal server error" }), false);
	});

	it("ignores non-sdk subtypes", () => {
		assert.equal(isTransientSdkError({ subtype: "error_max_turns", text: "500 Internal server error" }), false);
		assert.equal(isTransientSdkError({ subtype: "error_rate_limit", text: "service unavailable" }), false);
	});

	it("does not match arbitrary digit runs containing 500", () => {
		assert.equal(isTransientSdkError({ subtype: "error_sdk", text: "changed 500 files successfully before crashing" }), false);
		assert.equal(isTransientSdkError({ subtype: "error_sdk", text: "estimated $500 cost" }), false);
	});
});

describe("classifyOutcome", () => {
	it("maps each closed subtype to itself (identity on branched values)", () => {
		for (const s of ["success", "error_rate_limit", "error_max_turns", "error_refusal", "error_confinement", "blocked", "edit_loop"] as const) {
			assert.equal(classifyOutcome({ subtype: s }), s);
		}
	});

	it("collapses the free-form error subtypes to the catch-all 'error'", () => {
		assert.equal(classifyOutcome({ subtype: "error_sdk" }), "error");
		assert.equal(classifyOutcome({ subtype: "error_budget" }), "error");
		assert.equal(classifyOutcome({ subtype: "error_abort" }), "error");
	});

	it("collapses unknown / arbitrary subtype strings to 'error'", () => {
		assert.equal(classifyOutcome({ subtype: "unknown" }), "error");
		assert.equal(classifyOutcome({ subtype: "totally-made-up" }), "error");
		assert.equal(classifyOutcome({ subtype: "" }), "error");
	});
});

describe("looksLikeRefusal", () => {
	it("matches each refusal opener variant", () => {
		assert.equal(looksLikeRefusal("I can't help with that."), true);
		assert.equal(looksLikeRefusal("I cannot assist with this request."), true);
		assert.equal(looksLikeRefusal("I'm not able to continue here."), true);
		assert.equal(looksLikeRefusal("I am unable to comply."), true);
		assert.equal(looksLikeRefusal("I won't be able to help with this."), true);
		assert.equal(looksLikeRefusal("I must decline this task."), true);
		assert.equal(looksLikeRefusal("I'm sorry, but I can't do that."), true);
	});

	it("does not match a decline discussed mid-paragraph (anchoring guard)", () => {
		assert.equal(looksLikeRefusal("The reviewer notes the code can't be simplified further."), false);
	});

	it("does not match a long legitimate review", () => {
		const review = `The plan is well-structured. It correctly addresses the rubric's Correct dimension by ${"padding ".repeat(40)}and the verdict is sound.`;
		assert.equal(looksLikeRefusal(review), false);
	});

	it("returns false for empty input", () => {
		assert.equal(looksLikeRefusal(""), false);
	});
});

describe("isRefusal", () => {
	it("is true for the structured refusal stop_reason regardless of text", () => {
		assert.equal(isRefusal("refusal", ""), true);
		assert.equal(isRefusal("refusal", "Here is a normal-looking review."), true);
	});

	it("trusts a populated non-refusal stop_reason over refusal-shaped text", () => {
		assert.equal(isRefusal("end_turn", "I can't help with that."), false);
	});

	it("falls back to the text heuristic when stop_reason is absent", () => {
		assert.equal(isRefusal(null, "I can't help with that. This request touches security tooling."), true);
		assert.equal(isRefusal(undefined, "I must decline this review."), true);
	});

	it("does not treat a mid-paragraph decline as a refusal when stop_reason is absent", () => {
		assert.equal(isRefusal(null, "The reviewer notes the code can't be simplified further."), false);
	});
});

describe("parseVerdict", () => {
	it("parses an explicit Verdict: line", () => {
		assert.equal(parseVerdict("Verdict: APPROVE"), "APPROVE");
		assert.equal(parseVerdict("Verdict: REVISE"), "REVISE");
		assert.equal(parseVerdict("Verdict: RETHINK"), "RETHINK");
	});

	it("parses existing VERDICT: and bold shapes", () => {
		assert.equal(parseVerdict("VERDICT: APPROVE"), "APPROVE");
		assert.equal(parseVerdict("Verdict: **APPROVE**"), "APPROVE");
	});

	it("parses a bare keyword when no verdict line is present", () => {
		assert.equal(parseVerdict("This plan needs a RETHINK before proceeding."), "RETHINK");
		assert.equal(parseVerdict("Please REVISE the approach."), "REVISE");
	});

	it("returns APPROVE for an engaged review that omitted the keyword (fail-safe preserved)", () => {
		const review = `This review checks the plan against the rubric. The Correct dimension holds: ${"the approach is sound and ".repeat(8)}no blocker found.`;
		assert.equal(parseVerdict(review), "APPROVE");
	});

	it("fails closed to RETHINK for empty, refused, or non-review output", () => {
		assert.equal(parseVerdict(""), "RETHINK");
		assert.equal(parseVerdict("I can't help with that."), "RETHINK");
		assert.equal(parseVerdict("ok done"), "RETHINK");
	});
});

describe("classifySecurityReviewDiff", () => {
	const hunk = (...lines: string[]): string => ["diff --git a/docs/setup.md b/docs/setup.md", "--- a/docs/setup.md", "+++ b/docs/setup.md", "@@ -1 +1 @@", ...lines].join("\n");

	it("triggers for security-sensitive server config paths", () => {
		const signal = classifySecurityReviewDiff(["packages/server/src/config.ts"], "diff --git a/packages/server/src/config.ts b/packages/server/src/config.ts\n");

		assert.equal(signal.triggered, true);
		assert.ok(signal.reasons.includes("path:packages/server/src/config.ts"));
	});

	it("triggers for security keywords on added and removed hunk lines", () => {
		const signal = classifySecurityReviewDiff(["docs/setup.md"], hunk("-CONTROL_PLANE_TOKEN allowed loopback access.", "+Reject hosts under 127.0.0.1.example.com."));

		assert.equal(signal.triggered, true);
		assert.ok(signal.reasons.includes("keyword:CONTROL_PLANE_TOKEN"));
		assert.ok(signal.reasons.includes("keyword:127."));
		assert.ok(signal.reasons.includes("keyword:loopback"));
	});

	it("triggers for the #102 hostname-prefix bypass shape", () => {
		const signal = classifySecurityReviewDiff(["packages/server/src/config.ts"], hunk("+function isLoopbackHost(host: string): boolean {", '+\treturn host === "localhost" || host.startsWith("127.");', "+}"));

		assert.equal(signal.triggered, true);
		assert.ok(signal.reasons.includes("path:packages/server/src/config.ts"));
		assert.ok(signal.reasons.some((reason) => reason === "keyword:host" || reason === "keyword:loopback" || reason === "keyword:127."));
	});

	it("triggers for workflow and exec/tool changes", () => {
		const signal = classifySecurityReviewDiff([".github/workflows/pr-review.yml", "packages/pelaggio/scripts/pelaggio/helpers.ts"], hunk("+execFileSync('gh', ['workflow', 'run'])", "+spawn('bash', ['-lc', command])"));

		assert.equal(signal.triggered, true);
		assert.ok(signal.reasons.includes("path:.github/workflows/pr-review.yml"));
		assert.ok(signal.reasons.includes("path:packages/pelaggio/scripts/pelaggio/helpers.ts"));
		assert.ok(signal.reasons.includes("keyword:exec"));
	});

	it("triggers for the verification contract and skill paths", () => {
		for (const path of ["packages/pelaggio/scripts/pelaggio/review/findings.ts", ".claude/skills/pr-verify/SKILL.md"]) {
			const signal = classifySecurityReviewDiff([path], hunk("+benign text"));
			assert.equal(signal.triggered, true);
			assert.ok(signal.reasons.includes(`path:${path}`));
		}
	});

	it("does not trigger for benign docs-only diffs without security keywords", () => {
		const signal = classifySecurityReviewDiff(["docs/readme.md"], hunk("+Clarify installation examples."));

		assert.deepEqual(signal, { triggered: false, reasons: [] });
	});

	it("ignores security keywords on unchanged context lines", () => {
		const signal = classifySecurityReviewDiff(["docs/readme.md"], hunk(" CONTROL_PLANE_TOKEN grants authentication permission.", "-Old copy.", "+New copy."));

		assert.deepEqual(signal, { triggered: false, reasons: [] });
	});

	it("ignores diff metadata and security-looking path headers", () => {
		const metadataOnly = ["diff --git a/docs/auth-token.md b/docs/auth-token.md", "similarity index 100%", "rename from docs/auth-token.md", "rename to docs/secret-url.md", "--- a/docs/auth-token.md", "+++ b/docs/secret-url.md"].join("\n");
		const signal = classifySecurityReviewDiff(["docs/secret-url.md"], metadataOnly);

		assert.deepEqual(signal, { triggered: false, reasons: [] });
	});

	it("does not trigger for routine changed-line mentions of git, gh, and url", () => {
		const signal = classifySecurityReviewDiff(["docs/readme.md"], hunk("-Use git and gh to inspect the old url.", "+Use the git CLI and gh command with this url variable."));

		assert.deepEqual(signal, { triggered: false, reasons: [] });
	});

	it("retains specific GH_TOKEN and other credential signals", () => {
		const signal = classifySecurityReviewDiff(["docs/setup.md"], hunk("+Set GH_TOKEN as the authentication secret."));

		assert.equal(signal.triggered, true);
		assert.ok(signal.reasons.includes("keyword:GH_TOKEN"));
		assert.ok(signal.reasons.includes("keyword:auth"));
		assert.ok(signal.reasons.includes("keyword:secret"));
	});

	it("returns deterministic, de-duplicated, capped reasons", () => {
		const signal = classifySecurityReviewDiff(
			["packages/server/src/config.ts", "packages/server/src/config.ts", ".github/workflows/review.yml"],
			hunk("+auth token secret permission host loopback localhost 0.0.0.0 127. ::1 fetch network exec spawn shell bash workflow", "+CONTROL_PLANE_TOKEN ANTHROPIC_API_KEY GH_TOKEN prompt injection ignore instructions"),
		);

		assert.equal(signal.triggered, true);
		assert.deepEqual(signal.reasons, [
			"path:packages/server/src/config.ts",
			"path:.github/workflows/review.yml",
			"keyword:CONTROL_PLANE_TOKEN",
			"keyword:ANTHROPIC_API_KEY",
			"keyword:GH_TOKEN",
			"keyword:prompt injection",
			"keyword:ignore instructions",
			"keyword:0.0.0.0",
		]);
	});
});

describe("formatReviewMetrics", () => {
	it("emits the exact marker string for a clean PASS", () => {
		assert.equal(formatReviewMetrics("pass", true, "success", 1.234, 42), "<!-- pr-review-metrics gate=pass ok=true subtype=success cost=1.23 turns=42 -->");
	});

	it("emits the exact marker string for a clean BLOCK", () => {
		assert.equal(formatReviewMetrics("block", true, "success", 0, 7), "<!-- pr-review-metrics gate=block ok=true subtype=success cost=0.00 turns=7 -->");
	});

	it("records ok=false and the failure subtype for a fail-closed transient", () => {
		assert.equal(formatReviewMetrics("block", false, "error_max_turns", 4.5, 60), "<!-- pr-review-metrics gate=block ok=false subtype=error_max_turns cost=4.50 turns=60 -->");
	});

	it("rounds cost to two decimal places (1.8 → 1.80)", () => {
		assert.match(formatReviewMetrics("pass", true, "success", 1.8, 3), /cost=1\.80 /);
	});

	it("never contains a `verdict:` substring — the marker can't be mistaken for a gate verdict", () => {
		// Belt-and-suspenders: the findings parser reads result.text, not the comment,
		// so the marker is out of its path entirely — but pin the invariant.
		assert.doesNotMatch(formatReviewMetrics("pass", true, "success", 1, 1), /verdict:/i);
		assert.doesNotMatch(formatReviewMetrics("block", false, "error_crash", 0, 0), /verdict:/i);
	});
});

describe("parseBlockedReason", () => {
	it("parses a trailing BLOCKED: line into its reason", () => {
		assert.equal(parseBlockedReason("Investigated the issue.\nBLOCKED: missing API key"), "missing API key");
	});

	it("tolerates bold markers (matching parseVerdict)", () => {
		assert.equal(parseBlockedReason("**BLOCKED:** missing X"), "missing X");
	});

	it("parses even when trailing blank lines follow the sentinel", () => {
		assert.equal(parseBlockedReason("BLOCKED: schema field absent\n\n  \n"), "schema field absent");
	});

	it("returns a placeholder reason for an empty BLOCKED: sentinel", () => {
		assert.equal(parseBlockedReason("BLOCKED:"), "(no reason given)");
	});

	it("returns null for a normal final paragraph", () => {
		assert.equal(parseBlockedReason("Implemented the feature and ran the tests. All green."), null);
	});

	it("does not fire on a mid-text mention followed by a normal finish (false-positive guard)", () => {
		const text = "I considered whether this is BLOCKED: no, I found a workaround.\nImplemented successfully.";
		assert.equal(parseBlockedReason(text), null);
	});

	it("is case-sensitive — lowercase blocked prose does not match", () => {
		assert.equal(parseBlockedReason("the task is blocked: on a missing dependency"), null);
	});

	it("returns null for empty input", () => {
		assert.equal(parseBlockedReason(""), null);
	});
});

describe("looksLikeStalledAsk", () => {
	it("flags a trailing question", () => {
		assert.equal(looksLikeStalledAsk("Here is what I did.\nShall I proceed?"), true);
	});

	it("flags an offer-to-continue without a question mark", () => {
		assert.equal(looksLikeStalledAsk("Want me to continue with the next file"), true);
	});

	it("returns false for a plain completion statement", () => {
		assert.equal(looksLikeStalledAsk("Implemented the feature and ran the tests. All green."), false);
	});

	it("returns false for empty input", () => {
		assert.equal(looksLikeStalledAsk(""), false);
	});

	it("returns false on a plain completion even though a BLOCKED line is the caller's precedence concern", () => {
		assert.equal(looksLikeStalledAsk("Done. Everything is committed."), false);
	});
});

describe("checkpoint", () => {
	it("returns false silently on a clean tree (git reports on stdout, stderr is empty string)", () => {
		const dir = makeFeatRepo();
		const writes: string[] = [];
		const orig = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			writes.push(chunk.toString());
			return true;
		}) as typeof process.stderr.write;
		try {
			assert.equal(checkpoint(dir, "test"), false);
		} finally {
			process.stderr.write = orig;
		}
		assert.deepEqual(
			writes.filter((w) => w.includes("checkpoint commit failed")),
			[],
			`clean tree must not warn; got:\n${writes.join("")}`,
		);
	});

	it("returns true and commits when the tree is dirty", () => {
		const dir = makeFeatRepo();
		writeFileSync(resolve(dir, "f.txt"), "x");
		assert.equal(checkpoint(dir, "test"), true);
		const log = execSync("git log --format=%s -1", { cwd: dir, encoding: "utf-8" }).trim();
		assert.equal(log, "wip: pelaggio test");
	});
});

describe("reviewFindingsPreamble (issue #60)", () => {
	it('empty / whitespace input returns ""', () => {
		assert.equal(reviewFindingsPreamble(""), "");
		assert.equal(reviewFindingsPreamble("   \n\t "), "");
	});

	it("non-empty input returns a block with the header and the findings", () => {
		const out = reviewFindingsPreamble("- bug: null deref at foo.ts:12");
		assert.match(out, /Revision pass/);
		assert.match(out, /primary task/);
		assert.match(out, /approved plan is historical context only/);
		assert.match(out, /### Review findings/);
		assert.match(out, /null deref at foo\.ts:12/);
	});

	it("over-cap input is truncated with an explicit marker", () => {
		const big = "x".repeat(7000);
		const out = reviewFindingsPreamble(big);
		assert.match(out, /\.\.\.\(truncated\)/);
		// under-cap input is not truncated
		assert.doesNotMatch(reviewFindingsPreamble("x".repeat(100)), /\(truncated\)/);
	});
});

describe("cycle provenance helpers", () => {
	it("deduplicates realized driver/model pairs in first-seen order", () => {
		const step = (provider: "claude" | "codex" | undefined, model: string) => ({ name: "implement", provider, model, cost: 0, turns: 1, ok: true });
		assert.deepEqual(uniqueDriverProvenance([step("codex", "gpt-5"), step("claude", "sonnet"), step("codex", "gpt-5"), step("codex", "gpt-5-mini"), step(undefined, "legacy")]), [
			{ provider: "codex", model: "gpt-5" },
			{ provider: "claude", model: "sonnet" },
			{ provider: "codex", model: "gpt-5-mini" },
		]);
	});

	it("preserves Git observations and stores a portable worktree label", () => {
		const commands = new Map([
			["git branch --show-current", "feat/327\n"],
			["git rev-parse main", "a".repeat(40)],
			["git rev-parse HEAD", "b".repeat(40)],
		]);
		const first = readGitBinding("/repo/.dev/worktrees/327", "/repo", undefined, (command) => commands.get(command) ?? "");
		assert.deepEqual(first, { branch: "feat/327", worktree: ".dev/worktrees/327", mainShaAtStart: "a".repeat(40), headSha: "b".repeat(40) });
		const preserved = readGitBinding("/gone/327", "/repo", first, () => {
			throw new Error("gone");
		});
		assert.equal(preserved.headSha, "b".repeat(40));
		assert.equal(preserved.mainShaAtStart, "a".repeat(40));
		assert.equal(preserved.worktree, "327");
	});

	it("bounds driver versions and reports failed probes without stderr", () => {
		let calls = 0;
		const result = readRuntimeVersions(["codex", "codex", "grok"], {
			readManifest: () => JSON.stringify({ version: "0.1.0" }),
			run: (_executable, _args) => {
				calls++;
				if (calls === 2) throw new Error("secret stderr");
				return `codex 1.2.3\r\n${"x".repeat(300)}`;
			},
		});
		assert.equal(calls, 2);
		assert.equal(result.versions.drivers.codex?.includes("\n"), false);
		assert.ok((result.versions.drivers.codex?.length ?? 0) <= 160);
		assert.deepEqual(result.unavailable, ["version.grok"]);
	});

	it("resolves the real installed claude SDK version (no manifest mock)", () => {
		// Exercises the actual node_modules path resolution — the mocked-manifest tests above
		// accept any path, so only this catches a wrong relative depth to the SDK package.json.
		const result = readRuntimeVersions(["claude"]);
		assert.match(result.versions.drivers.claude ?? "", /^\d+\.\d+\.\d+/);
		assert.ok(!result.unavailable.includes("version.claude"));
	});
});
