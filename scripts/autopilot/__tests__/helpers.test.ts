import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fmtWait, hasDeliverableCommits, parseResetTime, parseWaitFlag } from "../helpers.js";

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
});
