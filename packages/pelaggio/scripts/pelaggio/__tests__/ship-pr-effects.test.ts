import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ShipDecisionEffect } from "../effects.js";
import type { GhRunner } from "../roadmap/github-issues.js";
import { parseShipDecisionEffect } from "../ship/decision.js";
import { runShipPrEffects } from "../ship/pr-effects.js";
import type { StepResult } from "../types.js";

const PR_URL = "https://github.com/acme/widget/pull/42";

function decision(over: Partial<ShipDecisionEffect> = {}): ShipDecisionEffect {
	return {
		kind: "ship.ShipDecision",
		target: "pull-request",
		itemId: "TOOL-99",
		headBranch: "feat/tool-99",
		prTitle: "Ship TOOL-99",
		prBody: "Body",
		...over,
	};
}

function step(text: string): StepResult {
	return { ok: true, subtype: "success", text, fullText: "", cost: 0, turns: 0 };
}

function makeExec(opts: { dirty?: boolean; branch?: string; deliverable?: string; rejectFirstPush?: boolean } = {}): { exec: (cmd: string, cwd: string) => string; calls: string[] } {
	const calls: string[] = [];
	let pushCount = 0;
	const exec = (cmd: string): string => {
		calls.push(cmd);
		if (cmd === "git status --porcelain") return opts.dirty ? "M dirty.txt" : "";
		if (cmd === "git branch --show-current") return opts.branch ?? "feat/tool-99";
		if (cmd === "git merge-base main HEAD") return "abc123";
		if (cmd.startsWith("git reset --soft ")) return "";
		if (cmd.startsWith("git commit ")) return "";
		if (cmd === "git diff --name-only main...HEAD") return opts.deliverable ?? "src/app.ts";
		if (cmd === "git push -u origin HEAD") {
			pushCount += 1;
			if (opts.rejectFirstPush && pushCount === 1) throw new Error("rejected");
			return "";
		}
		if (cmd === "git push --force-with-lease -u origin HEAD") return "";
		throw new Error(`unexpected exec: ${cmd}`);
	};
	return { exec, calls };
}

function makeGh(responses: Array<{ match: string[]; stdout?: string; stderr?: string; status?: number }>): { gh: GhRunner; calls: string[][] } {
	const calls: string[][] = [];
	const gh: GhRunner = (args) => {
		calls.push(args);
		const next = responses.shift();
		assert.ok(next, `unexpected gh call: ${args.join(" ")}`);
		assert.deepEqual(args.slice(0, next.match.length), next.match);
		return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", status: next.status ?? 0 };
	};
	return { gh, calls };
}

describe("parseShipDecisionEffect", () => {
	it("parses a valid marked JSON block", () => {
		const parsed = parseShipDecisionEffect(step(`SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Ship TOOL-99","prBody":"Body"}\nEND_SHIP_DECISION`), { itemId: "TOOL-99", target: "pull-request" });

		assert.deepEqual(parsed, decision());
	});

	it("rejects missing block, bad JSON, item mismatch, and target mismatch", () => {
		assert.throws(() => parseShipDecisionEffect(step("done"), { itemId: "TOOL-99", target: "pull-request" }), /not found/);
		assert.throws(() => parseShipDecisionEffect(step("SHIP_DECISION\nnope\nEND_SHIP_DECISION"), { itemId: "TOOL-99", target: "pull-request" }), /not valid JSON/);
		assert.throws(
			() =>
				parseShipDecisionEffect(step(`SHIP_DECISION\n{"target":"pull-request","itemId":"TOOL-1","headBranch":"feat/tool-99","prTitle":"Ship","prBody":"Body"}\nEND_SHIP_DECISION`), {
					itemId: "TOOL-99",
					target: "pull-request",
				}),
			/itemId/,
		);
		assert.throws(() => parseShipDecisionEffect(step(`SHIP_DECISION\n{"target":"auto-merge-pr","headBranch":"feat/tool-99","prTitle":"Ship","prBody":"Body"}\nEND_SHIP_DECISION`), { itemId: "TOOL-99", target: "pull-request" }), /target/);
	});
});

describe("runShipPrEffects", () => {
	it("creates a PR when none is open", async () => {
		const ex = makeExec();
		const gh = makeGh([
			{ match: ["pr", "list"], stdout: "[]" },
			{ match: ["pr", "create"], stdout: `${PR_URL}\n` },
		]);

		const result = await runShipPrEffects({ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision() }, { exec: ex.exec, gh: gh.gh, log: () => {} });

		assert.equal(result.prUrl, PR_URL);
		assert.ok(ex.calls.includes("git push -u origin HEAD"));
		assert.deepEqual(
			gh.calls.map((args) => args.slice(0, 2)),
			[
				["pr", "list"],
				["pr", "create"],
			],
		);
	});

	it("updates and reuses an existing PR by head branch", async () => {
		const ex = makeExec();
		const gh = makeGh([
			{ match: ["pr", "list"], stdout: JSON.stringify([{ number: 42, url: PR_URL }]) },
			{ match: ["pr", "edit"], stdout: "" },
		]);

		const result = await runShipPrEffects({ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision() }, { exec: ex.exec, gh: gh.gh, log: () => {} });

		assert.equal(result.prUrl, PR_URL);
		assert.deepEqual(
			gh.calls.map((args) => args.slice(0, 2)),
			[
				["pr", "list"],
				["pr", "edit"],
			],
		);
	});

	it("retries a rejected push with force-with-lease", async () => {
		const ex = makeExec({ rejectFirstPush: true });
		const gh = makeGh([
			{ match: ["pr", "list"], stdout: "[]" },
			{ match: ["pr", "create"], stdout: `${PR_URL}\n` },
		]);

		await runShipPrEffects({ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision() }, { exec: ex.exec, gh: gh.gh, log: () => {} });

		assert.ok(ex.calls.includes("git push -u origin HEAD"));
		assert.ok(ex.calls.includes("git push --force-with-lease -u origin HEAD"));
	});

	it("enables auto-merge for auto-merge-pr", async () => {
		const ex = makeExec();
		const gh = makeGh([
			{ match: ["pr", "list"], stdout: JSON.stringify([{ number: 42, url: PR_URL }]) },
			{ match: ["pr", "edit"], stdout: "" },
			{ match: ["pr", "merge"], stdout: "" },
		]);

		await runShipPrEffects({ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision({ target: "auto-merge-pr" }) }, { exec: ex.exec, gh: gh.gh, log: () => {} });

		assert.deepEqual(gh.calls.at(-1), ["pr", "merge", "--auto", "--squash", "42"]);
	});

	it("rejects dirty worktrees, branch mismatches, empty deliverable diffs, gh failures, and auto-merge failures", async () => {
		await assert.rejects(() => runShipPrEffects({ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision() }, { exec: makeExec({ dirty: true }).exec, gh: makeGh([]).gh, log: () => {} }), /dirty/);
		await assert.rejects(() => runShipPrEffects({ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision() }, { exec: makeExec({ branch: "feat/other" }).exec, gh: makeGh([]).gh, log: () => {} }), /branch mismatch/);
		await assert.rejects(() => runShipPrEffects({ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision() }, { exec: makeExec({ deliverable: "docs/plans/99.md" }).exec, gh: makeGh([]).gh, log: () => {} }), /nothing to ship/);
		await assert.rejects(
			() =>
				runShipPrEffects(
					{ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision() },
					{
						exec: makeExec().exec,
						gh: makeGh([{ match: ["pr", "list"], stderr: "auth failed", status: 1 }]).gh,
						log: () => {},
					},
				),
			/auth failed/,
		);
		await assert.rejects(
			() =>
				runShipPrEffects(
					{ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision({ target: "auto-merge-pr" }) },
					{
						exec: makeExec().exec,
						gh: makeGh([
							{ match: ["pr", "list"], stdout: JSON.stringify([{ number: 42, url: PR_URL }]) },
							{ match: ["pr", "edit"], stdout: "" },
							{ match: ["pr", "merge"], stderr: "merge disabled", status: 1 },
						]).gh,
						log: () => {},
					},
				),
			/merge disabled/,
		);
	});
});
