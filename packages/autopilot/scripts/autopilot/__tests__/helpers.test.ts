import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
	checkpoint,
	classifyStepError,
	computeImplementTurns,
	countPlanFiles,
	filesChangedSince,
	fmtWait,
	getHeadSha,
	hasDeliverableCommits,
	isRefusal,
	looksLikeRefusal,
	looksLikeStalledAsk,
	parseBlockedReason,
	parsePickItem,
	parsePickResult,
	parseResetTime,
	parseVerdict,
	parseWaitFlag,
} from "../helpers.js";

function makeFeatRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "autopilot-helpers-test-"));
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

describe("parsePickResult", () => {
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
		assert.equal(log, "wip: autopilot test");
	});
});
