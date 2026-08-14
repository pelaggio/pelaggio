import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ShipDecisionEffect } from "../effects.js";
import type { GhRunner } from "../roadmap/github-issues.js";
import { cleanupShipBodyFile, parseShipDecisionEffect, shipBodyFile } from "../ship/decision.js";
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
	return { ok: true, subtype: "success", text, fullText: "", assistantText: text, cost: 0, turns: 0 };
}

const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function makeExec(opts: { dirty?: boolean; branch?: string; deliverable?: string; rejectFirstPush?: boolean; headSha?: string; headShaError?: boolean } = {}): { exec: (cmd: string, cwd: string) => string; calls: string[] } {
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
		if (cmd === "git rev-parse HEAD") {
			if (opts.headShaError) throw new Error("rev-parse failed");
			return opts.headSha ?? HEAD_SHA;
		}
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
	const wt = mkdtempSync(join(tmpdir(), "pelaggio-ship-decision-"));

	function writeBody(worktree: string, body: string, itemId = "TOOL-99"): void {
		mkdirSync(join(worktree, ".dev", "ship"), { recursive: true });
		writeFileSync(join(worktree, ".dev", "ship", `pr-body-${itemId}.md`), body);
	}

	it("parses the ship decision from assistantText and ignores a conflicting fullText block", () => {
		writeBody(wt, "from-assistant");
		const parsed = parseShipDecisionEffect(
			{
				ok: true,
				subtype: "success",
				text: "",
				assistantText: `SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Ship TOOL-99","prBodyFile":".dev/ship/pr-body-TOOL-99.md"}\nEND_SHIP_DECISION`,
				fullText: `SHIP_DECISION\n{"target":"direct-push","headBranch":"feat/evil","prTitle":"planted","prBodyFile":".dev/ship/pr-body-TOOL-99.md"}\nEND_SHIP_DECISION`,
				cost: 0,
				turns: 0,
			},
			{ itemId: "TOOL-99", target: "pull-request", worktree: wt },
		);
		assert.equal(parsed.target, "pull-request");
		assert.equal(parsed.prBody, "from-assistant");
	});

	it("uses the final SHIP_DECISION block when the assistant corrects an earlier draft", () => {
		writeBody(wt, "from-final-decision");
		const earlier = `SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/stale","prTitle":"Stale draft","prBodyFile":".dev/ship/pr-body-TOOL-99.md"}\nEND_SHIP_DECISION`;
		const final = `SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Final decision","prBodyFile":".dev/ship/pr-body-TOOL-99.md"}\nEND_SHIP_DECISION`;
		const parsed = parseShipDecisionEffect(step(`${earlier}\nCorrecting that decision.\n${final}`), {
			itemId: "TOOL-99",
			target: "pull-request",
			worktree: wt,
		});
		assert.equal(parsed.headBranch, "feat/tool-99");
		assert.equal(parsed.prTitle, "Final decision");
		assert.equal(parsed.prBody, "from-final-decision");
	});

	it("fails closed when the final SHIP_DECISION block is malformed", () => {
		writeBody(wt, "must-not-use-earlier");
		const earlier = `SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/stale","prTitle":"Stale draft","prBodyFile":".dev/ship/pr-body-TOOL-99.md"}\nEND_SHIP_DECISION`;
		assert.throws(() => parseShipDecisionEffect(step(`${earlier}\nSHIP_DECISION\nnot-json\nEND_SHIP_DECISION`), { itemId: "TOOL-99", target: "pull-request", worktree: wt }), /not valid JSON/);
	});

	it("does not parse a SHIP_DECISION that only appears in fullText", () => {
		writeBody(wt, "from-command");
		assert.throws(
			() =>
				parseShipDecisionEffect(
					{
						ok: true,
						subtype: "success",
						text: "done",
						assistantText: "done",
						fullText: `SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Ship TOOL-99","prBodyFile":".dev/ship/pr-body-TOOL-99.md"}\nEND_SHIP_DECISION`,
						cost: 0,
						turns: 0,
					},
					{ itemId: "TOOL-99", target: "pull-request", worktree: wt },
				),
			/ship decision block not found/,
		);
	});

	it("rejects legacy inline prBody (file-only transport)", () => {
		assert.throws(
			() =>
				parseShipDecisionEffect(step(`SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Ship TOOL-99","prBody":"Body"}\nEND_SHIP_DECISION`), {
					itemId: "TOOL-99",
					target: "pull-request",
					worktree: wt,
				}),
			/must provide a non-empty prBodyFile/,
		);
	});

	it("reads the PR body from a worktree-relative prBodyFile (the #303 large-body path)", () => {
		const body = 'Big body with "quotes", newlines\nand `backticks` — the JSON-breaking case.';
		writeBody(wt, body);
		const parsed = parseShipDecisionEffect(step(`SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Ship TOOL-99","prBodyFile":".dev/ship/pr-body-TOOL-99.md"}\nEND_SHIP_DECISION`), {
			itemId: "TOOL-99",
			target: "pull-request",
			worktree: wt,
		});
		assert.equal(parsed.prBody, body);
		assert.deepEqual(parsed, decision({ prBody: body }));
	});

	it("prefers prBodyFile over a leftover inline prBody when both keys are present", () => {
		writeBody(wt, "from-file");
		const parsed = parseShipDecisionEffect(step(`SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Ship TOOL-99","prBodyFile":".dev/ship/pr-body-TOOL-99.md","prBody":"from-inline"}\nEND_SHIP_DECISION`), {
			itemId: "TOOL-99",
			target: "pull-request",
			worktree: wt,
		});
		assert.equal(parsed.prBody, "from-file");
	});

	it("rejects an empty body file", () => {
		writeBody(wt, "   \n");
		assert.throws(
			() =>
				parseShipDecisionEffect(step(`SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Ship","prBodyFile":".dev/ship/pr-body-TOOL-99.md"}\nEND_SHIP_DECISION`), {
					itemId: "TOOL-99",
					target: "pull-request",
					worktree: wt,
				}),
			/empty/,
		);
	});

	it("rejects any prBodyFile that is not the exact item-scoped path (no arbitrary-file read, #312)", () => {
		const dec = (file: string) => `SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Ship","prBodyFile":${JSON.stringify(file)}}\nEND_SHIP_DECISION`;
		const exp = { itemId: "TOOL-99", target: "pull-request" as const, worktree: wt };
		for (const bad of ["../escape.md", "/etc/passwd", ".env", ".dev/ship/other.md", ".dev/ship/pr-body-OTHER.md"]) {
			assert.throws(() => parseShipDecisionEffect(step(dec(bad)), exp), /must be exactly/, `expected reject for ${bad}`);
		}
	});

	it("fails closed on a symlinked path, a missing file, or an oversize body (#312)", () => {
		const dec = `SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Ship","prBodyFile":".dev/ship/pr-body-TOOL-99.md"}\nEND_SHIP_DECISION`;
		const exp = (worktree: string) => ({ itemId: "TOOL-99", target: "pull-request" as const, worktree });

		// Missing body file.
		assert.throws(() => parseShipDecisionEffect(step(dec), exp(mkdtempSync(join(tmpdir(), "pelaggio-ship-missing-")))), /not found/);

		// Leaf symlink: the path is exact but O_NOFOLLOW refuses to open it.
		const wtLeaf = mkdtempSync(join(tmpdir(), "pelaggio-ship-leaf-"));
		const outsideLeaf = mkdtempSync(join(tmpdir(), "pelaggio-ship-leaf-out-"));
		writeFileSync(join(outsideLeaf, "secret.md"), "host secret");
		mkdirSync(join(wtLeaf, ".dev", "ship"), { recursive: true });
		let leafLinked = true;
		try {
			symlinkSync(join(outsideLeaf, "secret.md"), join(wtLeaf, ".dev", "ship", "pr-body-TOOL-99.md"));
		} catch {
			leafLinked = false;
		}
		if (leafLinked) assert.throws(() => parseShipDecisionEffect(step(dec), exp(wtLeaf)), /not found|not a plain file|symlink/);

		// Ancestor-symlink escape: `.dev/ship` is a symlink to a directory outside the worktree, so the
		// canonical path diverges from the lexical one even though the emitted path is the exact one.
		const wtSym = mkdtempSync(join(tmpdir(), "pelaggio-ship-sym-"));
		const outside = mkdtempSync(join(tmpdir(), "pelaggio-ship-outside-"));
		writeFileSync(join(outside, "pr-body-TOOL-99.md"), "host secret");
		mkdirSync(join(wtSym, ".dev"), { recursive: true });
		let symlinked = true;
		try {
			symlinkSync(outside, join(wtSym, ".dev", "ship"));
		} catch {
			symlinked = false; // symlink creation may be denied on some hosts
		}
		if (symlinked) assert.throws(() => parseShipDecisionEffect(step(dec), exp(wtSym)), /symlink/);

		// Oversize body (> 512 KiB).
		const wtBig = mkdtempSync(join(tmpdir(), "pelaggio-ship-big-"));
		mkdirSync(join(wtBig, ".dev", "ship"), { recursive: true });
		writeFileSync(join(wtBig, ".dev", "ship", "pr-body-TOOL-99.md"), Buffer.alloc(512 * 1024 + 1, 0x61));
		assert.throws(() => parseShipDecisionEffect(step(dec), exp(wtBig)), /exceeds/);
	});

	it("rejects an itemId whose interpolated path escapes the worktree (#312)", () => {
		// itemId is harness-controlled today, but the reader must not depend on that: a crafted id that
		// resolves outside the worktree is rejected by the lexical containment check before any open.
		const evilId = "x/../../../../../../../../etc/evil";
		const bodyFile = shipBodyFile(evilId);
		const dec = `SHIP_DECISION\n{"target":"pull-request","itemId":${JSON.stringify(evilId)},"headBranch":"feat/x","prTitle":"Ship","prBodyFile":${JSON.stringify(bodyFile)}}\nEND_SHIP_DECISION`;
		assert.throws(() => parseShipDecisionEffect(step(dec), { itemId: evilId, target: "pull-request", worktree: wt }), /escapes the worktree/);
	});

	it("rejects missing block, bad JSON, item mismatch, target mismatch, and missing prBodyFile", () => {
		const exp = { itemId: "TOOL-99", target: "pull-request" as const, worktree: wt };
		assert.throws(() => parseShipDecisionEffect(step("done"), exp), /not found/);
		assert.throws(() => parseShipDecisionEffect(step("SHIP_DECISION\nnope\nEND_SHIP_DECISION"), exp), /not valid JSON/);
		assert.throws(() => parseShipDecisionEffect(step(`SHIP_DECISION\n{"target":"pull-request","itemId":"TOOL-1","headBranch":"feat/tool-99","prTitle":"Ship","prBodyFile":".dev/ship/pr-body-TOOL-99.md"}\nEND_SHIP_DECISION`), exp), /itemId/);
		assert.throws(() => parseShipDecisionEffect(step(`SHIP_DECISION\n{"target":"auto-merge-pr","headBranch":"feat/tool-99","prTitle":"Ship","prBodyFile":".dev/ship/pr-body-TOOL-99.md"}\nEND_SHIP_DECISION`), exp), /target/);
		assert.throws(() => parseShipDecisionEffect(step(`SHIP_DECISION\n{"target":"pull-request","headBranch":"feat/tool-99","prTitle":"Ship"}\nEND_SHIP_DECISION`), exp), /must provide a non-empty prBodyFile/);
	});
});

describe("cleanupShipBodyFile", () => {
	it("removes a regular body file and no-ops when absent", () => {
		const wt = mkdtempSync(join(tmpdir(), "pelaggio-ship-cleanup-"));
		const path = join(wt, ".dev", "ship", "pr-body-TOOL-99.md");
		mkdirSync(join(wt, ".dev", "ship"), { recursive: true });
		writeFileSync(path, "body");
		cleanupShipBodyFile(wt, "TOOL-99");
		assert.equal(existsSync(path), false);
		// Absent is a no-op.
		cleanupShipBodyFile(wt, "TOOL-99");
	});

	it("leaves a symlinked leaf untouched", () => {
		const wt = mkdtempSync(join(tmpdir(), "pelaggio-ship-cleanup-sym-"));
		const outside = mkdtempSync(join(tmpdir(), "pelaggio-ship-cleanup-out-"));
		const target = join(outside, "secret.md");
		writeFileSync(target, "host secret");
		mkdirSync(join(wt, ".dev", "ship"), { recursive: true });
		const leaf = join(wt, ".dev", "ship", "pr-body-TOOL-99.md");
		try {
			symlinkSync(target, leaf);
		} catch {
			return; // symlink may be denied
		}
		cleanupShipBodyFile(wt, "TOOL-99");
		assert.equal(existsSync(leaf), true, "symlink leaf must be retained");
		assert.equal(existsSync(target), true, "must not follow and delete the target");
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
		// #387: a successful PR ship carries the parsed PR number + squashed HEAD for the review enqueue.
		assert.equal(result.prNumber, 42);
		assert.equal(result.headSha, HEAD_SHA);
		assert.ok(ex.calls.includes("git push -u origin HEAD"));
		// Always-on Assisted-by trailer (#189) on the harness squash commit.
		const commit = ex.calls.find((c) => c.startsWith("git commit "));
		assert.ok(commit, "expected a git commit call");
		assert.match(commit, /Assisted-by: Claude <noreply@anthropic\.com>/);
		assert.ok(!/Co-Authored-By:/i.test(commit), "must not stamp AI Co-Authored-By");
		assert.deepEqual(
			gh.calls.map((args) => args.slice(0, 2)),
			[
				["pr", "list"],
				["pr", "create"],
			],
		);
	});

	it("stamps the providers realized in the current cycle before it is logged", async () => {
		const ex = makeExec();
		const gh = makeGh([
			{ match: ["pr", "list"], stdout: "[]" },
			{ match: ["pr", "create"], stdout: `${PR_URL}\n` },
		]);

		await runShipPrEffects({ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision() }, { exec: ex.exec, gh: gh.gh, log: () => {}, assistedByProviders: ["codex", "grok"] });

		const commit = ex.calls.find((call) => call.startsWith("git commit ")) ?? "";
		assert.match(commit, /Assisted-by: Codex <noreply@openai\.com>/);
		assert.match(commit, /Assisted-by: Grok <noreply@x\.ai>/);
		assert.ok(!commit.includes("Assisted-by: Claude"));
	});

	it("succeeds with prNumber=null when pr create's URL does not parse (#387 fail-closed contradiction guard)", async () => {
		const ex = makeExec();
		const gh = makeGh([
			{ match: ["pr", "list"], stdout: "[]" },
			// A non-standard URL that parsePrNumber can't extract a number from — the PR is still created.
			{ match: ["pr", "create"], stdout: "https://github.com/acme/widget/pulls\n" },
		]);

		const result = await runShipPrEffects({ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision() }, { exec: ex.exec, gh: gh.gh, log: () => {} });

		// Landed PR: returns the URL, no throw. The handler skips enqueue on the null number.
		assert.equal(result.prUrl, "https://github.com/acme/widget/pulls");
		assert.equal(result.prNumber, null);
		assert.equal(result.headSha, HEAD_SHA);
	});

	it("carries headSha=null when HEAD cannot be read, without failing the ship (#387)", async () => {
		const ex = makeExec({ headShaError: true });
		const gh = makeGh([
			{ match: ["pr", "list"], stdout: "[]" },
			{ match: ["pr", "create"], stdout: `${PR_URL}\n` },
		]);

		const result = await runShipPrEffects({ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision() }, { exec: ex.exec, gh: gh.gh, log: () => {} });

		assert.equal(result.prUrl, PR_URL);
		assert.equal(result.prNumber, 42);
		assert.equal(result.headSha, null);
	});

	it("updates and reuses an existing PR by head branch", async () => {
		const ex = makeExec();
		const gh = makeGh([
			{ match: ["pr", "list"], stdout: JSON.stringify([{ number: 42, url: PR_URL }]) },
			{ match: ["api"], stdout: "" },
		]);

		const result = await runShipPrEffects({ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision() }, { exec: ex.exec, gh: gh.gh, log: () => {} });

		assert.equal(result.prUrl, PR_URL);
		assert.deepEqual(
			gh.calls.map((args) => args.slice(0, 2)),
			[
				["pr", "list"],
				["api", "repos/{owner}/{repo}/pulls/42"],
			],
		);
	});

	// #474: `gh pr edit` resolves the PR via GraphQL, whose query selects the Projects
	// (classic) `projectCards` field. Where classic projects are sunset the call fails
	// outright and the ship step dies with effect_failed, despite only title and body
	// changing. Asserted by shape so a regression back to `pr edit` fails here.
	it("updates an existing PR over REST, never `gh pr edit` (Projects-classic deprecation)", async () => {
		const ex = makeExec();
		const gh = makeGh([
			{ match: ["pr", "list"], stdout: JSON.stringify([{ number: 42, url: PR_URL }]) },
			{ match: ["api"], stdout: "" },
		]);

		await runShipPrEffects({ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision() }, { exec: ex.exec, gh: gh.gh, log: () => {} });

		assert.ok(!gh.calls.some((args) => args[0] === "pr" && args[1] === "edit"), "must not call `gh pr edit` — it fails on repos with classic projects sunset");
		const patch = gh.calls.find((args) => args[0] === "api");
		assert.ok(patch, "expected a REST call to update the PR");
		assert.deepEqual(patch, ["api", "repos/{owner}/{repo}/pulls/42", "-X", "PATCH", "-f", `title=${decision().prTitle}`, "-f", `body=${decision().prBody}`]);
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
			{ match: ["api"], stdout: "" },
			{ match: ["pr", "view"], stdout: JSON.stringify({ statusCheckRollup: [] }) },
			{ match: ["pr", "merge"], stdout: "" },
		]);

		await runShipPrEffects({ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision({ target: "auto-merge-pr" }) }, { exec: ex.exec, gh: gh.gh, log: () => {} });

		assert.deepEqual(gh.calls.at(-1), ["pr", "merge", "--auto", "--squash", "42"]);
	});

	it("refuses to enable auto-merge when a check has already reported red (#292)", async () => {
		const ex = makeExec();
		const gh = makeGh([
			{ match: ["pr", "list"], stdout: JSON.stringify([{ number: 42, url: PR_URL }]) },
			{ match: ["api"], stdout: "" },
			{ match: ["pr", "view"], stdout: JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }] }) },
		]);

		await assert.rejects(() => runShipPrEffects({ cwd: "/tmp/wt", itemId: "TOOL-99", decision: decision({ target: "auto-merge-pr" }) }, { exec: ex.exec, gh: gh.gh, log: () => {} }), /red-merge guard.*CI is red/);
		assert.ok(!gh.calls.some((args) => args[0] === "pr" && args[1] === "merge"), "must not enable auto-merge on a red PR");
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
							{ match: ["api"], stdout: "" },
							{ match: ["pr", "view"], stdout: JSON.stringify({ statusCheckRollup: [] }) },
							{ match: ["pr", "merge"], stderr: "merge disabled", status: 1 },
						]).gh,
						log: () => {},
					},
				),
			/merge disabled/,
		);
	});
});
