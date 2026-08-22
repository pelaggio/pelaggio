import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { readFreshnessOursIntent, writeFreshnessOursIntent } from "../freshness-ours-intent.js";
import {
	buildReviewDiffBlock,
	buildStepArgs,
	canRetryWithinBudget,
	checkpoint,
	classifyCycleDisposition,
	classifyOutcome,
	classifyParkReason,
	classifySecurityReviewDiff,
	classifyStepError,
	computeImplementTurns,
	countPlanFiles,
	createMainCheckoutDeltaObserver,
	diffForbiddenRootSnapshots,
	ensureMainCheckoutOnBranch,
	expandPackagedSkill,
	expandSkill,
	FORBIDDEN_ROOT_GONE,
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
	pickDivergedFromPin,
	preparePrShipFreshness,
	quarantineCheckpoint,
	REVIEW_DIFF_MAX_BYTES,
	readGitBinding,
	readRuntimeVersions,
	resolveClaudeSdkManifestPath,
	resolveParkReset,
	revertPlanPolish,
	reviewFindingsPreamble,
	snapshotForbiddenRoot,
	snapshotRepoRefState,
	snapshotSiblingWorktree,
	uniqueDriverProvenance,
	verifyConflictRepairComplete,
	verifyPrShipFreshness,
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

	// #431: a Grok/OpenCode step now logs its own realized model; recovery must round-trip it into
	// the generic `model` field so it can be reused as an execution override.
	it("recovers a realized grok model from the generic model field", () => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-author-log-"));
		const path = join(dir, "log.jsonl");
		writeFileSync(path, `${JSON.stringify({ item: "431", steps: [{ name: "plan", ok: true, provider: "grok", model: "grok-code-fast-1" }] })}\n`);
		assert.deepEqual(findLoggedArtifactAuthor("431", "plan", path), { provider: "grok", model: "grok-code-fast-1" });
	});

	it("recovers a realized opencode model, and treats a logged default as an absent model", () => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-author-log-"));
		const path = join(dir, "log.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify({ item: "431", steps: [{ name: "implement", ok: true, provider: "opencode", model: "openrouter/qwen" }] })}\n${JSON.stringify({ item: "432", steps: [{ name: "implement", ok: true, provider: "opencode", model: "default" }] })}\n`,
		);
		assert.deepEqual(findLoggedArtifactAuthor("431", "implement", path), { provider: "opencode", model: "openrouter/qwen" });
		assert.deepEqual(findLoggedArtifactAuthor("432", "implement", path), { provider: "opencode" });
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
			exists: () => true,
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
					exists: () => true,
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
			exists: () => true,
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

	it("returns the GONE sentinel for an already-absent root without spawning git (#308)", () => {
		let calls = 0;
		const result = snapshotForbiddenRoot("/tmp/orphaned-review-head", {
			exists: () => false,
			run: () => {
				calls++;
				return "";
			},
		});
		assert.equal(result, FORBIDDEN_ROOT_GONE);
		assert.equal(calls, 0, "must not run git status on a known-gone root");
	});

	it("returns GONE when the root disappears mid-step (run fails, absence then confirmed) (#308 TOCTOU)", () => {
		let calls = 0;
		let existsChecks = 0;
		const result = snapshotForbiddenRoot("/tmp/removed-mid-step", {
			attempts: 3,
			exists: () => existsChecks++ === 0, // present at the pre-check, gone once the run has failed
			sleepSync: () => {},
			run: () => {
				calls++;
				throw new Error("spawnSync /bin/sh ENOENT");
			},
		});
		assert.equal(result, FORBIDDEN_ROOT_GONE);
		assert.equal(calls, 1, "confirmed absence short-circuits the retry loop");
	});

	it("fails closed on a real error while the root still exists (missing git, not absence) (#308)", () => {
		let calls = 0;
		assert.throws(
			() =>
				snapshotForbiddenRoot("/tmp/present-but-broken", {
					attempts: 2,
					exists: () => true, // root is present the whole time — a real failure, not GONE
					sleepSync: () => {},
					run: () => {
						calls++;
						throw new Error("spawnSync git ENOENT");
					},
				}),
			/failed to snapshot forbidden root \/tmp\/present-but-broken/,
		);
		assert.equal(calls, 2, "a present root exhausts the retry budget then throws");
	});

	it("returns GONE for a present non-Git directory shell (diagnostic ∧ no .git) without retry (#339)", () => {
		const root = "/tmp/directory-shell-root";
		const sleeps: number[] = [];
		let calls = 0;
		const result = snapshotForbiddenRoot(root, {
			attempts: 3,
			retryDelayMs: 25,
			exists: (p) => p === root, // root present; <root>/.git absent
			sleepSync: (ms) => {
				sleeps.push(ms);
			},
			run: () => {
				calls++;
				const err = new Error("Command failed: git status");
				(err as Error & { stderr: string }).stderr = "fatal: not a git repository (or any of the parent directories): .git";
				throw err;
			},
		});
		assert.equal(result, FORBIDDEN_ROOT_GONE);
		assert.equal(calls, 1, "directory shell short-circuits without retry");
		assert.deepEqual(sleeps, []);
	});

	it("returns GONE for a real plain directory via the default Git runner (#339)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-non-git-shell-"));
		// Plain directory, no .git — production-shaped residual worktree shell.
		assert.equal(existsSync(join(dir, ".git")), false);
		const result = snapshotForbiddenRoot(dir);
		assert.equal(result, FORBIDDEN_ROOT_GONE);
	});

	it("fails closed when the non-repo diagnostic matches but .git is still present (#339 permission collision)", () => {
		const root = "/tmp/unreadable-git-root";
		const sleeps: number[] = [];
		let calls = 0;
		assert.throws(
			() =>
				snapshotForbiddenRoot(root, {
					attempts: FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS,
					retryDelayMs: 10,
					// Root and .git both present — unreadable .git still existsSync as true.
					exists: () => true,
					sleepSync: (ms) => {
						sleeps.push(ms);
					},
					run: () => {
						calls++;
						const err = new Error("Command failed: git status");
						(err as Error & { stderr: string }).stderr = "fatal: not a git repository (or any of the parent directories): .git";
						throw err;
					},
				}),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /failed to snapshot forbidden root \/tmp\/unreadable-git-root:/);
				assert.match(e.message, /fatal: not a git repository/);
				return true;
			},
		);
		assert.equal(calls, FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS);
		assert.equal(sleeps.length, FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS - 1);
	});

	it("fails closed on a nonmatching Git fatal while the root is present (#339)", () => {
		let calls = 0;
		const sleeps: number[] = [];
		assert.throws(
			() =>
				snapshotForbiddenRoot("/tmp/corrupt-index-root", {
					attempts: 2,
					retryDelayMs: 10,
					exists: () => true,
					sleepSync: (ms) => {
						sleeps.push(ms);
					},
					run: () => {
						calls++;
						const err = new Error("Command failed: git status");
						(err as Error & { stderr: string }).stderr = "fatal: .git/index: index file smaller than expected";
						throw err;
					},
				}),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /failed to snapshot forbidden root \/tmp\/corrupt-index-root:/);
				assert.match(e.message, /index file smaller than expected/);
				return true;
			},
		);
		assert.equal(calls, 2);
		assert.equal(sleeps.length, 1);
	});
});

describe("diffForbiddenRootSnapshots (#308 GONE-aware)", () => {
	const gone = FORBIDDEN_ROOT_GONE;
	it("flags a present→present root whose porcelain changed (clean→dirty)", () => {
		const before = new Map([["/wt", ""]]);
		const after = new Map([["/wt", "?? leaked.txt"]]);
		assert.deepEqual(diffForbiddenRootSnapshots(before, after), ["/wt"]);
	});
	it("does not flag an unchanged present→present root (dirty→dirty)", () => {
		const before = new Map([["/wt", " M x"]]);
		const after = new Map([["/wt", " M x"]]);
		assert.deepEqual(diffForbiddenRootSnapshots(before, after), []);
	});
	it("passes GONE→GONE (already-gone orphan — the live review-head case)", () => {
		assert.deepEqual(diffForbiddenRootSnapshots(new Map([["/wt", gone]]), new Map([["/wt", gone]])), []);
	});
	it("passes present→GONE without a false positive (removed mid-step, incl. dirty→gone)", () => {
		assert.deepEqual(diffForbiddenRootSnapshots(new Map([["/wt", " M x"]]), new Map([["/wt", gone]])), []);
	});
	it("passes GONE→present (root appeared mid-step — cannot be this step's mutation)", () => {
		assert.deepEqual(diffForbiddenRootSnapshots(new Map([["/wt", gone]]), new Map([["/wt", ""]])), []);
	});
});

describe("snapshotRepoRefState / snapshotSiblingWorktree (#510 round-2)", () => {
	it("detects a clean-to-clean --allow-empty commit that porcelain cannot see", () => {
		const dir = makeFeatRepo();
		const porcelainBefore = snapshotForbiddenRoot(dir);
		const refsBefore = snapshotRepoRefState(dir);
		execSync("git commit --allow-empty -q -m sneaky", { cwd: dir });
		assert.equal(snapshotForbiddenRoot(dir), porcelainBefore, "porcelain is blind to the empty commit");
		assert.notEqual(snapshotRepoRefState(dir), refsBefore, "ref-state digest sees the HEAD move");
	});

	it("detects a bare ref move (branch created without touching the working tree)", () => {
		const dir = makeFeatRepo();
		const before = snapshotRepoRefState(dir);
		execSync("git branch forged-branch", { cwd: dir });
		assert.notEqual(snapshotRepoRefState(dir), before);
	});

	it("throws on a non-repository root (callers fail closed)", () => {
		assert.throws(() => snapshotRepoRefState(mkdtempSync(join(tmpdir(), "pelaggio-refstate-notrepo-"))));
	});

	it("sibling snapshot combines porcelain and HEAD, and returns GONE for an absent root", () => {
		const dir = makeFeatRepo();
		const before = snapshotSiblingWorktree(dir);
		assert.match(before, /\n@[0-9a-f]{40}$/);
		writeFileSync(join(dir, "leaked.txt"), "x");
		const dirty = snapshotSiblingWorktree(dir);
		assert.notEqual(dirty, before, "working-tree write changes the snapshot");
		execSync("git add -A && git commit -q -m leak", { cwd: dir });
		// Porcelain is clean again (as before the write) but HEAD moved — clean-to-clean commits differ.
		assert.notEqual(snapshotSiblingWorktree(dir), before, "commit moves HEAD even once porcelain is clean again");
		assert.equal(snapshotSiblingWorktree(join(tmpdir(), "does-not-exist-pelaggio-510")), FORBIDDEN_ROOT_GONE);
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
		const openFinish = open.finish();
		assert.match(openFinish.kind === "error" ? openFinish.message : "", /unclosed/);

		const broken = createMainCheckoutDeltaObserver(join(tmpdir(), "does-not-exist-pelaggio"));
		assert.equal(broken.beforeTool("x").kind, "error");
		assert.deepEqual(broken.finish(), broken.finish(), "finish is idempotent");
	});

	it("fails closed when the main checkout is PRESENT but not a git repository (#339 security guarantee)", () => {
		// A main checkout that exists yet has no `.git` (corrupt/half-removed main) must NEVER be
		// GONE-tolerated the way a peer worktree shell is: it routes through the observer as a
		// fail-closed error. mainRepo is never accepted as FORBIDDEN_ROOT_GONE.
		const notARepo = mkdtempSync(join(tmpdir(), "pelaggio-main-notrepo-"));
		const observer = createMainCheckoutDeltaObserver(notARepo);
		const result = observer.beforeTool("x");
		assert.equal(result.kind, "error");
		assert.match(result.kind === "error" ? result.message : "", /main checkout root vanished/);
	});
});

describe("pickDivergedFromPin (#332)", () => {
	// Mirrors the github adapter's parseItemId: a number from feat/issue-N, #N, or issue-N; else null.
	const ghParse = async (t: string): Promise<string | null> => {
		const m = t.match(/feat\/issue-(\d+)/) ?? t.match(/#(\d+)/) ?? t.match(/\bissue[- ]?(\d+)\b/i);
		return m ? m[1] : null;
	};

	it("no divergence when the resolved id equals the pin (bare numbers)", async () => {
		assert.equal(await pickDivergedFromPin("286", "286", ghParse), false);
	});

	it("DIVERGENCE when the pick claimed a different id (the #332 bug: 286→337)", async () => {
		assert.equal(await pickDivergedFromPin("286", "337", ghParse), true);
	});

	it("normalizes #N / feat/issue-N / issue-N to the same id (no false divergence)", async () => {
		assert.equal(await pickDivergedFromPin("#286", "feat/issue-286", ghParse), false);
		assert.equal(await pickDivergedFromPin("issue-286", "286", ghParse), false);
	});

	it("detects divergence across id formats", async () => {
		assert.equal(await pickDivergedFromPin("286", "feat/issue-337", ghParse), true);
		assert.equal(await pickDivergedFromPin("#286", "337", ghParse), true);
	});

	it("markdown-style letter ids compare exactly", async () => {
		const mdParse = async (t: string): Promise<string | null> => (/^[A-Z]+-?\d[\dA-Z-]*$/.test(t) ? t : null);
		assert.equal(await pickDivergedFromPin("TOOL-16", "TOOL-16", mdParse), false);
		assert.equal(await pickDivergedFromPin("TOOL-16", "TOOL-17", mdParse), true);
	});

	it("does not falsely diverge on a mixed-case markdown pin (getItem is case-insensitive)", async () => {
		// The markdown parser only recognizes UPPERCASE ids → a lowercase pin falls back to its raw
		// string ("tool-16") while the resolved canonical id is "TOOL-16". Case-insensitive compare
		// keeps them equal (they are the same item). (codex #344 review)
		const mdParse = async (t: string): Promise<string | null> => (/^[A-Z]+-?\d[\dA-Z-]*$/.test(t) ? t : null);
		assert.equal(await pickDivergedFromPin("tool-16", "TOOL-16", mdParse), false);
		assert.equal(await pickDivergedFromPin("Tool-16", "TOOL-16", mdParse), false);
		// A genuinely different item still diverges regardless of case.
		assert.equal(await pickDivergedFromPin("tool-16", "TOOL-17", mdParse), true);
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

	it("accepts deps as a JSON array (not just a CSV string) (#353)", () => {
		const arr = parseDeferredItems('deferred-item: {"title": "Slice B", "deps": ["TOOL-99", " TOOL-100 ", ""]}');
		assert.deepEqual(arr, [{ title: "Slice B", deps: ["TOOL-99", "TOOL-100"], deferred: true }]);
		const csv = parseDeferredItems('deferred-item: {"title": "Slice C", "deps": "A, B"}');
		assert.deepEqual(csv[0].deps, ["A", "B"]);
	});

	it("dedups across call sites via a shared seen set (plan + shakedown both parse) (#353)", () => {
		const seen = new Set<string>();
		const plan = parseDeferredItems('deferred-item: {"title": "Shared slice", "scope": "M"}', seen);
		assert.equal(plan.length, 1, "first (plan) parse creates it");
		// The same marker echoed in the shakedown text must NOT create a second item.
		const shakedown = parseDeferredItems('deferred-item: {"title": "shared slice"}\ndeferred-item: {"title": "New one"}', seen);
		assert.deepEqual(
			shakedown.map((i) => i.title),
			["New one"],
			"already-seen title is skipped; only the genuinely-new one is created",
		);
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

	it("loads merge-gate protocols from the packaged skill tree", () => {
		const review = expandPackagedSkill("pr-review", "--pr 286");
		const verify = expandPackagedSkill("pr-verify");
		assert.match(review, /REVIEW_FINDINGS/);
		assert.match(review, /Arguments: --pr 286$/);
		assert.match(verify, /REVIEW_VERIFICATION/);
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

function initBareGit(dir: string): void {
	execSync("git init -q -b main", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config commit.gpgsign false", { cwd: dir });
	execSync("git commit --allow-empty -q -m init", { cwd: dir });
}

function makeFreshnessPair(): { worktree: string; origin: string } {
	const origin = mkdtempSync(join(tmpdir(), "pelaggio-fresh-origin-"));
	initBareGit(origin);
	const worktree = mkdtempSync(join(tmpdir(), "pelaggio-fresh-wt-"));
	execSync(`git clone -q ${JSON.stringify(origin)} ${JSON.stringify(worktree)}`);
	execSync("git config user.name t", { cwd: worktree });
	execSync("git config user.email t@t", { cwd: worktree });
	execSync("git config commit.gpgsign false", { cwd: worktree });
	execSync("git checkout -q -b feat/tool-99", { cwd: worktree });
	// In production the ours-intent store lives in the MAIN repo's gitignored `.dev/`;
	// here the temp repo is its own main repo, so mirror the ignore via info/exclude to
	// keep the porcelain-clean invariant the freshness gates rely on.
	mkdirSync(join(worktree, ".git", "info"), { recursive: true });
	writeFileSync(join(worktree, ".git", "info", "exclude"), ".dev/\n", { flag: "a" });
	return { worktree, origin };
}

describe("preparePrShipFreshness / verifyPrShipFreshness", () => {
	it("returns up-to-date without invoking merge when origin/main is already an ancestor", () => {
		const { worktree } = makeFreshnessPair();
		const argv: string[][] = [];
		const result = preparePrShipFreshness(worktree, (args, cwd) => {
			argv.push([...args]);
			return execSync(`git ${args.map((a) => JSON.stringify(a)).join(" ")}`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		assert.equal(result.kind, "up-to-date");
		if (result.kind !== "up-to-date") return;
		// The retained OID is the fetched origin/main tip, resolved immediately post-fetch.
		assert.equal(result.originMainOid, execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim());
		assert.ok(argv.some((a) => a[0] === "fetch" && a[1] === "origin" && a[2] === "main"));
		assert.ok(!argv.some((a) => a[0] === "merge"));
		assert.deepEqual(verifyPrShipFreshness(worktree, result.originMainOid), { ok: true });
	});

	it("merges a branch behind origin/main and records only upstream-side touched paths (three-dot)", () => {
		const { worktree, origin } = makeFreshnessPair();
		// A branch-side commit must NOT appear in upstreamTouchedFiles: two-dot
		// `HEAD..origin/main` would list it (the endpoint trees differ); three-dot
		// lists only the upstream side since the merge-base.
		commitFile(worktree, "src/feature.ts", "export const feat = 1;\n", "feat side");
		commitFile(origin, "src/upstream.ts", "export const up = 1;\n", "upstream");
		commitFile(origin, "docs/note.md", "note\n", "upstream docs");
		const result = preparePrShipFreshness(worktree);
		assert.equal(result.kind, "merged");
		if (result.kind !== "merged") return;
		assert.deepEqual(result.upstreamTouchedFiles.sort(), ["docs/note.md", "src/upstream.ts"]);
		assert.equal(existsSync(join(worktree, "src/upstream.ts")), true);
		assert.deepEqual(verifyPrShipFreshness(worktree, result.originMainOid), { ok: true });
	});

	it("TOCTOU: origin/main moved to an older ancestor between fetch and verify fails naming both OIDs", () => {
		const { worktree, origin } = makeFreshnessPair();
		const olderOid = execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim();
		commitFile(origin, "src/upstream.ts", "export const up = 1;\n", "upstream");
		const result = preparePrShipFreshness(worktree);
		assert.equal(result.kind, "merged");
		if (result.kind !== "merged") return;
		const fetchedOid = result.originMainOid;
		assert.notEqual(fetchedOid, olderOid);
		// Simulate the writable author step moving the shared remote-tracking ref back to
		// an older ancestor (the tree stays clean and still contains the older tip).
		execSync(`git update-ref refs/remotes/origin/main ${olderOid}`, { cwd: worktree });
		const verified = verifyPrShipFreshness(worktree, fetchedOid);
		assert.equal(verified.ok, false);
		if (verified.ok) return;
		assert.ok(verified.detail.includes(fetchedOid), `detail names the fetched OID: ${verified.detail}`);
		assert.ok(verified.detail.includes(olderOid), `detail names the moved-to OID: ${verified.detail}`);
		assert.match(verified.detail, /moved after fetch/);
	});

	it("returns conflicted and leaves MERGE_HEAD when the merge has unmerged paths", () => {
		const { worktree, origin } = makeFreshnessPair();
		commitFile(worktree, "shared.ts", "feat\n", "feat edit");
		commitFile(origin, "shared.ts", "main\n", "main edit");
		const argv: string[][] = [];
		const result = preparePrShipFreshness(worktree, (args, cwd) => {
			argv.push([...args]);
			return execSync(`git ${args.map((a) => JSON.stringify(a)).join(" ")}`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		assert.equal(result.kind, "conflicted");
		if (result.kind !== "conflicted") return;
		assert.ok(result.unmergedFiles.includes("shared.ts"));
		assert.ok(result.upstreamTouchedFiles.includes("shared.ts"));
		assert.equal(result.originMainOid, execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim());
		assert.equal(execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: worktree, encoding: "utf-8" }).trim().length > 0, true);
		assert.ok(!argv.some((a) => a[0] === "merge" && a.includes("--abort")));
		assert.ok(!argv.some((a) => a[0] === "reset" || a[0] === "clean"));
		assert.equal(verifyPrShipFreshness(worktree, result.originMainOid!).ok, false);
	});

	it("treats an already-conflicted input (MERGE_HEAD) as conflicted without fetching or merging again", () => {
		const { worktree, origin } = makeFreshnessPair();
		commitFile(worktree, "shared.ts", "feat\n", "feat edit");
		commitFile(origin, "shared.ts", "main\n", "main edit");
		const first = preparePrShipFreshness(worktree);
		assert.equal(first.kind, "conflicted");
		const argv: string[][] = [];
		const second = preparePrShipFreshness(worktree, (args, cwd) => {
			argv.push([...args]);
			return execSync(`git ${args.map((a) => JSON.stringify(a)).join(" ")}`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		assert.equal(second.kind, "conflicted");
		if (second.kind !== "conflicted") return;
		assert.ok(second.unmergedFiles.includes("shared.ts"));
		// No fetch on the resume path, but the OID observed before the author step is still retained.
		assert.equal(second.originMainOid, execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim());
		assert.ok(!argv.some((a) => a[0] === "fetch" || a[0] === "merge"));
		assert.equal(execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: worktree, encoding: "utf-8" }).trim().length > 0, true);
	});

	it("returns failed with bounded detail on fetch failure, missing origin, dirty-without-merge, and non-conflict merge failure", () => {
		const dirty = makeFeatRepo();
		writeFileSync(join(dirty, "loose.txt"), "x");
		const dirtyResult = preparePrShipFreshness(dirty);
		assert.equal(dirtyResult.kind, "failed");
		if (dirtyResult.kind === "failed") assert.match(dirtyResult.detail, /dirty/);

		const noOrigin = makeFeatRepo();
		const missing = preparePrShipFreshness(noOrigin);
		assert.equal(missing.kind, "failed");
		if (missing.kind === "failed") {
			assert.ok(missing.detail.length > 0);
			assert.ok(missing.detail.length <= 300);
		}

		const argv: string[][] = [];
		const fake = preparePrShipFreshness("/tmp/freshness-argv", (args) => {
			argv.push([...args]);
			const key = args.join(" ");
			if (key === "rev-parse -q --verify MERGE_HEAD") throw new Error("no merge");
			if (key === "diff --name-only --diff-filter=U") return "";
			if (key === "status --porcelain") return "";
			if (key === "fetch origin main") return "";
			if (key === "rev-parse --verify origin/main") return "abc";
			// Post-fetch checks and the merge itself run against the retained OID, never the ref name.
			if (key === "merge-base --is-ancestor abc HEAD") throw new Error("behind");
			if (key === "rev-parse --path-format=absolute --git-common-dir") return "/tmp/freshness-mock-store/.git";
			if (key === "rev-parse --abbrev-ref HEAD") return "feat/tool-99";
			if (key === "rev-parse --verify HEAD^{commit}") return "headoid";
			if (key === "merge-base --all headoid abc") throw new Error("no common base");
			if (key === "diff --name-only HEAD...abc") return "src/a.ts\n";
			if (key === "merge --no-edit abc") throw Object.assign(new Error("not a fast-forward"), { stderr: "fatal: refusing to merge unrelated histories" });
			throw new Error(`unexpected argv: ${key}`);
		});
		assert.equal(fake.kind, "failed");
		if (fake.kind === "failed") assert.match(fake.detail, /unrelated histories/);
		assert.deepEqual(argv[0], ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
		assert.ok(argv.every((a) => Array.isArray(a)));
		assert.ok(!argv.some((a) => a[0] === "merge" && a.includes("--abort")));
		assert.ok(!argv.some((a) => a[0] === "reset" || a[0] === "clean"));
	});

	it("post-author verification accepts only clean, conflict-free branches containing the fetched OID", () => {
		const { worktree, origin } = makeFreshnessPair();
		const fetchedOid = execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim();
		assert.deepEqual(verifyPrShipFreshness(worktree, fetchedOid), { ok: true });

		writeFileSync(join(worktree, "dirty.txt"), "x");
		assert.equal(verifyPrShipFreshness(worktree, fetchedOid).ok, false);
		execSync("git clean -fdq", { cwd: worktree });

		commitFile(origin, "src/more.ts", "more\n", "more upstream");
		// The fetched OID no longer being an ancestor fails; force the probe via argv.
		const stale = verifyPrShipFreshness(worktree, "def", (args) => {
			const key = args.join(" ");
			if (key === "rev-parse -q --verify MERGE_HEAD") throw new Error("no merge");
			if (key === "diff --name-only --diff-filter=U") return "";
			if (key === "status --porcelain") return "";
			if (key === "rev-parse --verify origin/main") return "def";
			if (key === "merge-base --is-ancestor def HEAD") throw new Error("not ancestor");
			throw new Error(`unexpected argv: ${key}`);
		});
		assert.equal(stale.ok, false);
		if (!stale.ok) assert.match(stale.detail, /ancestor/);

		const unresolved = verifyPrShipFreshness(worktree, fetchedOid, (args) => {
			const key = args.join(" ");
			if (key === "rev-parse -q --verify MERGE_HEAD") return "mergehead";
			throw new Error(`unexpected argv: ${key}`);
		});
		assert.equal(unresolved.ok, false);
		if (!unresolved.ok) assert.match(unresolved.detail, /MERGE_HEAD/);
	});

	it("never interpolates the worktree path into git argv", () => {
		const seen: string[][] = [];
		preparePrShipFreshness("/tmp/some worktree/with spaces", (args) => {
			seen.push([...args]);
			throw new Error("stop");
		});
		assert.ok(seen.length > 0);
		for (const args of seen) {
			assert.ok(!args.some((a) => a.includes("/tmp/some worktree")));
			assert.ok(!args.join(" ").includes("git -C"));
		}
	});

	it("records ancestry with -s ours when upstream content is already present, preserving the feature tree", () => {
		const { worktree, origin } = makeFreshnessPair();
		commitFile(origin, "src/up-a.ts", "export const a = 1;\n", "upstream a");
		commitFile(origin, "src/up-b.ts", "export const b = 2;\n", "upstream b");
		commitFile(worktree, "src/feature.ts", "export const feat = 1;\n", "feature-only");
		commitFile(worktree, "src/up-a.ts", "export const a = 1;\n", "copy a");
		commitFile(worktree, "src/up-b.ts", "export const b = 2;\n", "copy b");
		execSync("git fetch -q origin main", { cwd: worktree });
		const fetchedBefore = execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim();
		assert.throws(() => execFileSync("git", ["merge-base", "--is-ancestor", fetchedBefore, "HEAD"], { cwd: worktree, stdio: "ignore" }));
		const preTree = execSync('git rev-parse "HEAD^{tree}"', { cwd: worktree, encoding: "utf-8" }).trim();
		const preHead = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
		const argv: string[][] = [];
		const result = preparePrShipFreshness(worktree, (args, cwd) => {
			argv.push([...args]);
			return execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		assert.equal(result.kind, "content-integrated");
		if (result.kind !== "content-integrated") return;
		assert.notEqual(result.originMainOid, preHead);
		assert.equal(execSync("git merge-base --is-ancestor " + result.originMainOid + " HEAD", { cwd: worktree, encoding: "utf-8" }).trim(), "");
		assert.equal(execSync('git rev-parse "HEAD^{tree}"', { cwd: worktree, encoding: "utf-8" }).trim(), preTree);
		assert.equal(execSync("git rev-parse HEAD^2", { cwd: worktree, encoding: "utf-8" }).trim(), result.originMainOid);
		assert.deepEqual(verifyPrShipFreshness(worktree, result.originMainOid), { ok: true });
		assert.ok(argv.some((a) => a[0] === "merge" && a.includes("--strategy=ours") && a.includes(result.originMainOid)));
		assert.ok(!argv.some((a) => a[0] === "merge" && a.includes("--abort")));
		assert.deepEqual([...result.upstreamTouchedFiles].sort(), ["src/up-a.ts", "src/up-b.ts"]);
	});

	it("accounts for rename source+destination and NUL-delimited unusual paths in the equivalence proof", () => {
		const { worktree, origin } = makeFreshnessPair();
		const newlinePath = "file\nwith\nnewline.txt";
		// Shared history must contain the rename source so the net write-set lists both
		// the deleted source and the added destination (`--no-renames`).
		commitFile(origin, "old.txt", "renamed-content\n", "add old");
		execSync("git fetch -q origin main", { cwd: worktree });
		execSync("git merge -q --no-edit origin/main", { cwd: worktree });
		execSync("git mv old.txt new.txt", { cwd: origin });
		execSync("git commit -q -m rename", { cwd: origin });
		commitFile(origin, newlinePath, "weird\n", "newline path");
		commitFile(worktree, "src/feature.ts", "export const feat = 1;\n", "feature-only");
		execSync("git rm -q old.txt", { cwd: worktree });
		commitFile(worktree, "new.txt", "renamed-content\n", "copy dest");
		commitFile(worktree, newlinePath, "weird\n", "copy newline path");
		const preTree = execSync('git rev-parse "HEAD^{tree}"', { cwd: worktree, encoding: "utf-8" }).trim();
		const result = preparePrShipFreshness(worktree);
		assert.equal(result.kind, "content-integrated");
		if (result.kind !== "content-integrated") return;
		assert.ok(result.upstreamTouchedFiles.includes("old.txt"), "rename source must appear when rename detection is disabled");
		assert.ok(result.upstreamTouchedFiles.includes("new.txt"), "rename destination must appear when rename detection is disabled");
		assert.ok(result.upstreamTouchedFiles.includes(newlinePath), `NUL-parsed write-set must keep the newline path, got ${JSON.stringify(result.upstreamTouchedFiles)}`);
		assert.ok(!result.upstreamTouchedFiles.includes("with"), "newline-split would leak path fragments");
		assert.equal(execSync('git rev-parse "HEAD^{tree}"', { cwd: worktree, encoding: "utf-8" }).trim(), preTree);
		assert.equal(execSync("git rev-parse HEAD^2", { cwd: worktree, encoding: "utf-8" }).trim(), result.originMainOid);
		assert.deepEqual(verifyPrShipFreshness(worktree, result.originMainOid), { ok: true });
	});

	it("does not take the ours shortcut when any upstream-touched path still differs", () => {
		const { worktree, origin } = makeFreshnessPair();
		commitFile(origin, "src/copied.ts", "same\n", "upstream copied");
		commitFile(origin, "src/dropped.ts", "main-only\n", "upstream not copied");
		commitFile(worktree, "src/copied.ts", "same\n", "copy one file");
		const argv: string[][] = [];
		const result = preparePrShipFreshness(worktree, (args, cwd) => {
			argv.push([...args]);
			return execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		assert.notEqual(result.kind, "content-integrated");
		assert.equal(result.kind, "merged");
		if (result.kind !== "merged") return;
		assert.ok(!argv.some((a) => a.includes("--strategy=ours") || a.includes("-s")));
		assert.ok(argv.some((a) => a[0] === "merge" && a[1] === "--no-edit" && a[2] === result.originMainOid));
		assert.equal(existsSync(join(worktree, "src/dropped.ts")), true);
		assert.deepEqual(verifyPrShipFreshness(worktree, result.originMainOid), { ok: true });
	});

	it("skips the shortcut and runs the ordinary merge when diff-tree fails, without classifying as failed", () => {
		const argv: string[][] = [];
		const result = preparePrShipFreshness("/tmp/freshness-difftree", (args) => {
			argv.push([...args]);
			const key = args.join(" ");
			if (key === "rev-parse -q --verify MERGE_HEAD") throw new Error("no merge");
			if (key === "diff --name-only --diff-filter=U") return "";
			if (key === "status --porcelain") return "";
			if (key === "fetch origin main") return "";
			if (key === "rev-parse --verify origin/main") return "abc";
			if (key === "merge-base --is-ancestor abc HEAD") throw new Error("behind");
			if (key === "rev-parse --verify HEAD^{commit}") return "headoid";
			if (key === "merge-base --all headoid abc") return "baseoid";
			if (key === "rev-parse --abbrev-ref HEAD") return "feat/tool-99";
			if (key === "rev-parse --path-format=absolute --git-common-dir") return "/tmp/freshness-mock-store/.git";
			if (args[0] === "diff-tree") throw new Error("diff-tree failed");
			if (key === "diff --name-only HEAD...abc") return "src/a.ts\n";
			if (key === "merge --no-edit abc") return "";
			throw new Error(`unexpected argv: ${key}`);
		});
		assert.equal(result.kind, "merged");
		if (result.kind !== "merged") return;
		assert.equal(result.originMainOid, "abc");
		assert.ok(argv.some((a) => a[0] === "diff-tree"));
		assert.ok(argv.some((a) => a[0] === "merge" && a[1] === "--no-edit" && a[2] === "abc"));
		assert.ok(!argv.some((a) => a.includes("--strategy=ours")));
		assert.ok(argv.every((a) => Array.isArray(a)));
		assert.ok(!argv.some((a) => a[0] === "merge" && a.includes("origin/main")));
		assert.ok(!argv.some((a) => a[0] === "diff-tree" && a.includes("origin/main")));
	});

	it("skips the shortcut on an ambiguous merge-base rather than picking one parent", () => {
		const argv: string[][] = [];
		const result = preparePrShipFreshness("/tmp/freshness-crisscross", (args) => {
			argv.push([...args]);
			const key = args.join(" ");
			if (key === "rev-parse -q --verify MERGE_HEAD") throw new Error("no merge");
			if (key === "diff --name-only --diff-filter=U") return "";
			if (key === "status --porcelain") return "";
			if (key === "fetch origin main") return "";
			if (key === "rev-parse --verify origin/main") return "abc";
			if (key === "merge-base --is-ancestor abc HEAD") throw new Error("behind");
			if (key === "rev-parse --verify HEAD^{commit}") return "headoid";
			if (key === "merge-base --all headoid abc") return "baseone\nbasetwo";
			if (key === "rev-parse --abbrev-ref HEAD") return "feat/tool-99";
			if (key === "rev-parse --path-format=absolute --git-common-dir") return "/tmp/freshness-mock-store/.git";
			if (key === "diff --name-only HEAD...abc") return "src/a.ts\n";
			if (key === "merge --no-edit abc") return "";
			throw new Error(`unexpected argv: ${key}`);
		});
		assert.equal(result.kind, "merged");
		assert.ok(!argv.some((a) => a[0] === "diff-tree"));
		assert.ok(!argv.some((a) => a.includes("--strategy=ours")));
		assert.ok(argv.some((a) => a[0] === "merge" && a[1] === "--no-edit" && a[2] === "abc"));
	});

	// 40-hex OIDs for the shortcut mocks: the intent record validates OID shape strictly.
	const OID_HEAD = "1".repeat(40);
	const OID_MERGE = "2".repeat(40);
	const OID_TREE = "3".repeat(40);
	const OID_MAIN = "d".repeat(40);
	const MOCK_BRANCH = "feat/tool-99";

	/** Shared mock for the shortcut/probe tests: proof passes bound to OID_HEAD; the
	 *  intent record lands under a per-call temp mainRepo (returned for assertions). */
	function oursProbeExec(argv: string[][], overrides: (key: string) => string | null): { exec: (args: readonly string[]) => string; mainRepo: string } {
		const mainRepo = mkdtempSync(join(tmpdir(), "pelaggio-ours-intent-"));
		const exec = (args: readonly string[]): string => {
			argv.push([...args]);
			const key = args.join(" ");
			const overridden = overrides(key);
			if (overridden !== null) return overridden;
			if (key === "rev-parse -q --verify MERGE_HEAD") throw new Error("no merge");
			if (key === "diff --name-only --diff-filter=U") return "";
			if (key === "status --porcelain") return "";
			if (key === "fetch origin main") return "";
			if (key === "rev-parse --verify origin/main") return OID_MAIN;
			if (key === `merge-base --is-ancestor ${OID_MAIN} HEAD`) throw new Error("behind");
			if (key === `merge-base --all ${OID_HEAD} ${OID_MAIN}`) return "baseoid";
			if (key === `diff-tree -r --name-only -z --no-renames --ignore-submodules=none baseoid ${OID_MAIN}`) return "copied.ts\0";
			if (key === `diff-tree -r --name-only -z --no-renames --ignore-submodules=none ${OID_HEAD} ${OID_MAIN}`) return "feat.ts\0";
			if (key === `rev-parse ${OID_HEAD}^{tree}`) return OID_TREE;
			if (key === "rev-parse --abbrev-ref HEAD") return MOCK_BRANCH;
			if (key === "rev-parse --path-format=absolute --git-common-dir") return join(mainRepo, ".git");
			if (key === `merge --no-edit --strategy=ours ${OID_MAIN}`) return "";
			if (key === `rev-parse --verify ${OID_MERGE}^1^{commit}`) return OID_HEAD;
			if (key === `rev-parse --verify ${OID_MERGE}^2^{commit}`) return OID_MAIN;
			if (key === `rev-parse ${OID_MERGE}^{tree}`) return OID_TREE;
			if (key === `merge-base --is-ancestor ${OID_MAIN} ${OID_MERGE}`) return "";
			throw new Error(`unexpected argv: ${key}`);
		};
		return { exec, mainRepo };
	}

	it("pins the successful-proof argv: captured HEAD OID binds the proof, ours merge, then parent/tree/ancestry probes", () => {
		const argv: string[][] = [];
		let headReads = 0;
		const { exec, mainRepo } = oursProbeExec(argv, (key) => {
			if (key === "rev-parse --verify HEAD^{commit}") {
				headReads += 1;
				return headReads === 1 ? OID_HEAD : OID_MERGE;
			}
			return null;
		});
		const result = preparePrShipFreshness("/tmp/freshness-ours-argv", exec);
		assert.equal(result.kind, "content-integrated");
		if (result.kind !== "content-integrated") return;
		assert.equal(result.originMainOid, OID_MAIN);
		assert.deepEqual(result.upstreamTouchedFiles, ["copied.ts"]);
		assert.equal(headReads, 2);
		const keys = argv.map((a) => a.join(" "));
		const isAncestor = keys.indexOf(`merge-base --is-ancestor ${OID_MAIN} HEAD`);
		const capture = keys.indexOf("rev-parse --verify HEAD^{commit}");
		const allBases = keys.indexOf(`merge-base --all ${OID_HEAD} ${OID_MAIN}`);
		const upstreamDiff = keys.indexOf(`diff-tree -r --name-only -z --no-renames --ignore-submodules=none baseoid ${OID_MAIN}`);
		const endpointDiff = keys.indexOf(`diff-tree -r --name-only -z --no-renames --ignore-submodules=none ${OID_HEAD} ${OID_MAIN}`);
		const treeIdx = keys.indexOf(`rev-parse ${OID_HEAD}^{tree}`);
		const ours = keys.indexOf(`merge --no-edit --strategy=ours ${OID_MAIN}`);
		const reRead = keys.lastIndexOf("rev-parse --verify HEAD^{commit}");
		const firstParent = keys.indexOf(`rev-parse --verify ${OID_MERGE}^1^{commit}`);
		const secondParent = keys.indexOf(`rev-parse --verify ${OID_MERGE}^2^{commit}`);
		const treeAgain = keys.indexOf(`rev-parse ${OID_MERGE}^{tree}`);
		const ancestorOnMerge = keys.indexOf(`merge-base --is-ancestor ${OID_MAIN} ${OID_MERGE}`);
		assert.ok(isAncestor >= 0 && capture > isAncestor && allBases > capture);
		assert.ok(upstreamDiff > allBases && endpointDiff > upstreamDiff);
		assert.ok(treeIdx > endpointDiff && ours > treeIdx);
		assert.ok(reRead > ours && firstParent > reRead && secondParent > firstParent);
		assert.ok(treeAgain > ours && ancestorOnMerge > treeAgain);
		assert.ok(!argv.some((a) => a.includes("origin/main") && a[0] !== "rev-parse" && a[0] !== "fetch"));
		// Every post-merge probe binds to captured OIDs, never to symbolic HEAD.
		assert.ok(!keys.slice(ours + 1).some((k) => k !== "rev-parse --verify HEAD^{commit}" && k.includes("HEAD")));
		assert.ok(!keys.includes(`merge --no-edit ${OID_MAIN}`));
		assert.ok(!argv.some((a) => a[0] === "reset"));
		// The intent/confirmation bracket closed: intent was durably recorded before the
		// merge and confirmed with the probe-verified merge OID.
		const record = readFreshnessOursIntent(mainRepo, MOCK_BRANCH);
		assert.equal(record.kind, "record");
		if (record.kind !== "record") return;
		assert.equal(record.record.state, "confirmed");
		assert.equal(record.record.mergeOid, OID_MERGE);
		assert.equal(record.record.headOid, OID_HEAD);
		assert.equal(record.record.expectedTreeOid, OID_TREE);
	});

	// The post-`ours` probes fail closed as `failed` — never `content-integrated`, never a
	// silent fallthrough — and roll the tainted merge commit back to its first parent so a
	// resume cannot launder the refused ancestry through `up-to-date`. The intent record
	// stays UNCONFIRMED either way: the durable guarantee when rollback cannot run.
	it("fails closed and rolls back when the ours merge changed the HEAD tree instead of preserving it", () => {
		const argv: string[][] = [];
		let headReads = 0;
		const { exec, mainRepo } = oursProbeExec(argv, (key) => {
			if (key === "rev-parse --verify HEAD^{commit}") {
				headReads += 1;
				return headReads === 1 ? OID_HEAD : OID_MERGE;
			}
			if (key === `rev-parse ${OID_MERGE}^{tree}`) return "4".repeat(40);
			if (key === `reset --keep ${OID_HEAD}`) return "";
			return null;
		});
		const result = preparePrShipFreshness("/tmp/freshness-ours-tree-drift", exec);
		assert.equal(result.kind, "failed");
		if (result.kind !== "failed") return;
		assert.match(result.detail, /HEAD tree changed/);
		assert.ok(result.detail.includes(`rolled the branch back to ${OID_HEAD}`));
		assert.ok(argv.some((a) => a.join(" ") === `reset --keep ${OID_HEAD}`));
		const record = readFreshnessOursIntent(mainRepo, MOCK_BRANCH);
		assert.equal(record.kind === "record" && record.record.state, "intent");
	});

	it("fails closed and rolls back when the ours merge did not make the fetched OID an ancestor", () => {
		const argv: string[][] = [];
		let headReads = 0;
		const { exec, mainRepo } = oursProbeExec(argv, (key) => {
			if (key === "rev-parse --verify HEAD^{commit}") {
				headReads += 1;
				return headReads === 1 ? OID_HEAD : OID_MERGE;
			}
			if (key === `merge-base --is-ancestor ${OID_MAIN} ${OID_MERGE}`) throw new Error("not an ancestor");
			if (key === `reset --keep ${OID_HEAD}`) return "";
			return null;
		});
		const result = preparePrShipFreshness("/tmp/freshness-ours-no-ancestry", exec);
		assert.equal(result.kind, "failed");
		if (result.kind !== "failed") return;
		assert.match(result.detail, /not an ancestor of HEAD/);
		assert.ok(result.detail.includes(`rolled the branch back to ${OID_HEAD}`));
		assert.ok(argv.some((a) => a.join(" ") === `reset --keep ${OID_HEAD}`));
		const record = readFreshnessOursIntent(mainRepo, MOCK_BRANCH);
		assert.equal(record.kind === "record" && record.record.state, "intent");
	});

	it("does not roll back a HEAD it does not recognize as its own ours merge commit", () => {
		const argv: string[][] = [];
		let headReads = 0;
		// A foreign commit landed on top of the ours merge before the probes: HEAD's
		// second parent is not the fetched OID, so the harness must not reset anything.
		const { exec, mainRepo } = oursProbeExec(argv, (key) => {
			if (key === "rev-parse --verify HEAD^{commit}") {
				headReads += 1;
				return headReads === 1 ? OID_HEAD : OID_MERGE;
			}
			if (key === `rev-parse --verify ${OID_MERGE}^2^{commit}`) throw new Error("no second parent");
			return null;
		});
		const result = preparePrShipFreshness("/tmp/freshness-ours-foreign-head", exec);
		assert.equal(result.kind, "failed");
		if (result.kind !== "failed") return;
		assert.match(result.detail, /second parent/);
		assert.match(result.detail, /branch left as-is/);
		assert.ok(!argv.some((a) => a[0] === "reset"));
		const record = readFreshnessOursIntent(mainRepo, MOCK_BRANCH);
		assert.equal(record.kind === "record" && record.record.state, "intent");
	});

	it("TOCTOU: a HEAD moved between the equivalence proof and the merge fails closed and leaves no recorded ancestry", () => {
		const { worktree, origin } = makeFreshnessPair();
		commitFile(origin, "src/up.ts", "export const up = 1;\n", "upstream");
		commitFile(worktree, "src/feature.ts", "export const feat = 1;\n", "feature-only");
		commitFile(worktree, "src/up.ts", "export const up = 1;\n", "copy up");
		const capturedHead = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
		let sneakOid = "";
		let diffTrees = 0;
		const result = preparePrShipFreshness(worktree, (args, cwd) => {
			const out = execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
			if (args[0] === "diff-tree") {
				diffTrees += 1;
				if (diffTrees === 2) {
					// Concurrent clean commit lands right after the equivalence proof's last
					// read, REMOVING an upstream-touched path — the tree is no longer proven.
					execSync("git rm -q src/up.ts && git commit -q -m sneak", { cwd: worktree });
					sneakOid = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
				}
			}
			return out;
		});
		assert.equal(result.kind, "failed");
		if (result.kind !== "failed") return;
		assert.match(result.detail, /HEAD moved between the equivalence proof and the merge/);
		assert.notEqual(sneakOid, "");
		assert.notEqual(sneakOid, capturedHead);
		// Rollback restored the mover's commit — only the tainted merge commit is gone.
		assert.equal(execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim(), sneakOid);
		assert.equal(existsSync(join(worktree, "src/up.ts")), false, "the mover's work survives the rollback");
		const originMainOid = execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim();
		assert.throws(() => execFileSync("git", ["merge-base", "--is-ancestor", originMainOid, "HEAD"], { cwd: worktree, stdio: "ignore" }), "no ancestry may survive the refused probe");
		assert.throws(() => execFileSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: worktree, stdio: "ignore" }));
	});

	it("a failed post-ours probe cannot be laundered by resume: the branch is restored and the next run re-proves", () => {
		const { worktree, origin } = makeFreshnessPair();
		commitFile(origin, "src/up.ts", "export const up = 1;\n", "upstream");
		commitFile(worktree, "src/feature.ts", "export const feat = 1;\n", "feature-only");
		commitFile(worktree, "src/up.ts", "export const up = 1;\n", "copy up");
		const capturedHead = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
		const first = preparePrShipFreshness(worktree, (args, cwd) => {
			// Sabotage only the post-merge tree probe (any ^{tree} read of a commit other
			// than the captured HEAD): the ours merge itself is real.
			if (args[0] === "rev-parse" && args[1]?.endsWith("^{tree}") && args[1] !== `${capturedHead}^{tree}`) return "0000000000000000000000000000000000000000\n";
			return execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		assert.equal(first.kind, "failed");
		if (first.kind !== "failed") return;
		assert.match(first.detail, /HEAD tree changed/);
		assert.match(first.detail, /rolled the branch back to/);
		// The tainted merge commit is gone: HEAD is back at the captured OID and
		// origin/main is NOT an ancestor, so a resume cannot classify `up-to-date`.
		assert.equal(execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim(), capturedHead);
		const originMainOid = execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim();
		assert.throws(() => execFileSync("git", ["merge-base", "--is-ancestor", originMainOid, "HEAD"], { cwd: worktree, stdio: "ignore" }));
		// The next evaluation re-proves from scratch and only then records ancestry.
		const second = preparePrShipFreshness(worktree);
		assert.equal(second.kind, "content-integrated");
		if (second.kind !== "content-integrated") return;
		assert.equal(execSync("git rev-parse HEAD^2", { cwd: worktree, encoding: "utf-8" }).trim(), second.originMainOid);
	});

	it("a planted replace ref cannot fake equivalence: the proof reads real objects and routes to the ordinary merge", () => {
		const { worktree, origin } = makeFreshnessPair();
		commitFile(origin, "src/up.ts", "export const up = 1;\n", "upstream change NOT copied");
		commitFile(worktree, "src/feature.ts", "export const feat = 1;\n", "feature-only");
		execSync("git fetch -q origin main", { cwd: worktree });
		const realOriginMain = execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim();
		// Attack: replace the fetched origin/main commit with a fabricated commit whose
		// tree equals HEAD's tree, so plain-git diff-trees would report equivalence.
		const mergeBase = execSync(`git merge-base HEAD ${realOriginMain}`, { cwd: worktree, encoding: "utf-8" }).trim();
		const fake = execSync(`git commit-tree "HEAD^{tree}" -p ${mergeBase} -m fake`, { cwd: worktree, encoding: "utf-8" }).trim();
		execSync(`git replace ${realOriginMain} ${fake}`, { cwd: worktree });
		// Sanity: with replace refs honored, the real upstream delta is invisible.
		assert.equal(execSync(`git diff-tree -r --name-only HEAD ${realOriginMain}`, { cwd: worktree, encoding: "utf-8" }).trim(), "");
		const result = preparePrShipFreshness(worktree);
		assert.notEqual(result.kind, "content-integrated");
		assert.equal(result.kind, "merged");
		if (result.kind !== "merged") return;
		assert.ok(result.upstreamTouchedFiles.includes("src/up.ts"), "the proof must see the real upstream write-set");
		// The ordinary merge integrated the REAL upstream content, not the replacement.
		assert.equal(readFileSync(join(worktree, "src/up.ts"), "utf-8"), "export const up = 1;\n");
	});

	/** Content-copy pair whose shortcut proof passes; returns the pre-run OIDs. */
	function makeContentCopiedPair(): { worktree: string; origin: string; headOid: string; originMainOid: string; expectedTreeOid: string } {
		const { worktree, origin } = makeFreshnessPair();
		commitFile(origin, "src/up.ts", "export const up = 1;\n", "upstream");
		commitFile(worktree, "src/feature.ts", "export const feat = 1;\n", "feature-only");
		commitFile(worktree, "src/up.ts", "export const up = 1;\n", "copy up");
		execSync("git fetch -q origin main", { cwd: worktree });
		return {
			worktree,
			origin,
			headOid: execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim(),
			originMainOid: execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim(),
			expectedTreeOid: execSync('git rev-parse "HEAD^{tree}"', { cwd: worktree, encoding: "utf-8" }).trim(),
		};
	}

	it("laundering is refused: ancestry through an unproven ours merge fails classification and verification closed", () => {
		const { worktree, headOid, originMainOid, expectedTreeOid } = makeContentCopiedPair();
		// Fabricate the residual directly: a merge with the recorded parent pair whose
		// tree is NOT the proven feature tree (upstream's tree — feature work missing),
		// left in history with only an unconfirmed intent to witness it.
		const badMerge = execSync(`git commit-tree "${originMainOid}^{tree}" -p ${headOid} -p ${originMainOid} -m fake-ours`, { cwd: worktree, encoding: "utf-8" }).trim();
		execSync(`git reset -q --hard ${badMerge}`, { cwd: worktree });
		writeFreshnessOursIntent(worktree, { branch: "feat/tool-99", headOid, originMainOid, expectedTreeOid, recordedAt: new Date().toISOString() });
		const result = preparePrShipFreshness(worktree);
		assert.equal(result.kind, "failed");
		if (result.kind !== "failed") return;
		assert.match(result.detail, /unproven ours merge/);
		assert.ok(result.detail.includes(badMerge));
		// Call site 2: the deterministic verification gate refuses the same ancestry.
		const verified = verifyPrShipFreshness(worktree, originMainOid);
		assert.equal(verified.ok, false);
		// The unconfirmed record is never auto-expired into a pass.
		const record = readFreshnessOursIntent(worktree, "feat/tool-99");
		assert.equal(record.kind === "record" && record.record.state, "intent");
	});

	it("a ^2-probe failure leaves the unconfirmed intent as the guarantee; the next run retro-confirms instead of blind up-to-date", () => {
		const { worktree } = makeContentCopiedPair();
		const first = preparePrShipFreshness(worktree, (args, cwd) => {
			if (args[0] === "rev-parse" && args[1] === "--verify" && args[2]?.endsWith("^2^{commit}")) throw new Error("probe infra failure");
			return execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		assert.equal(first.kind, "failed");
		if (first.kind !== "failed") return;
		assert.match(first.detail, /second parent/);
		assert.match(first.detail, /branch left as-is/);
		// The unproven merge is still in history — rollback recognition failed — but the
		// intent record survives on disk, unconfirmed (durable across a process restart:
		// there is no in-memory registry, disk is the only store).
		const mergeOid = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
		const pending = readFreshnessOursIntent(worktree, "feat/tool-99");
		assert.equal(pending.kind === "record" && pending.record.state, "intent");
		// Next evaluation must not trust ancestry blindly: it retrospectively completes
		// the bracket (probes pass — the merge is a faithful ours merge) and only then
		// classifies up-to-date.
		const second = preparePrShipFreshness(worktree);
		assert.equal(second.kind, "up-to-date");
		const confirmed = readFreshnessOursIntent(worktree, "feat/tool-99");
		assert.equal(confirmed.kind, "record");
		if (confirmed.kind !== "record") return;
		assert.equal(confirmed.record.state, "confirmed");
		assert.equal(confirmed.record.mergeOid, mergeOid);
	});

	it("a concurrent commit atop the ours merge defeats rollback but not the bracket: next run retro-confirms the merge beneath", () => {
		const { worktree } = makeContentCopiedPair();
		let mergeOid = "";
		const first = preparePrShipFreshness(worktree, (args, cwd) => {
			const out = execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
			if (args[0] === "merge" && args.includes("--strategy=ours")) {
				mergeOid = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
				writeFileSync(join(worktree, "atop.txt"), "raced\n");
				execSync("git add atop.txt && git commit -q -m atop", { cwd: worktree });
			}
			return out;
		});
		assert.equal(first.kind, "failed");
		if (first.kind !== "failed") return;
		assert.match(first.detail, /second parent/);
		assert.match(first.detail, /branch left as-is/);
		const pending = readFreshnessOursIntent(worktree, "feat/tool-99");
		assert.equal(pending.kind === "record" && pending.record.state, "intent");
		const second = preparePrShipFreshness(worktree);
		assert.equal(second.kind, "up-to-date");
		const confirmed = readFreshnessOursIntent(worktree, "feat/tool-99");
		assert.equal(confirmed.kind, "record");
		if (confirmed.kind !== "record") return;
		assert.equal(confirmed.record.state, "confirmed");
		assert.equal(confirmed.record.mergeOid, mergeOid);
		// The concurrent commit itself is preserved untouched at HEAD.
		assert.equal(readFileSync(join(worktree, "atop.txt"), "utf-8"), "raced\n");
	});

	it("happy path closes the bracket: content-integrated confirms the record and later classification stays up-to-date", () => {
		const { worktree } = makeContentCopiedPair();
		const first = preparePrShipFreshness(worktree);
		assert.equal(first.kind, "content-integrated");
		const mergeOid = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
		const confirmed = readFreshnessOursIntent(worktree, "feat/tool-99");
		assert.equal(confirmed.kind, "record");
		if (confirmed.kind !== "record") return;
		assert.equal(confirmed.record.state, "confirmed");
		assert.equal(confirmed.record.mergeOid, mergeOid);
		// Regression pin: a confirmed record behaves exactly as before the bracket existed.
		const second = preparePrShipFreshness(worktree);
		assert.equal(second.kind, "up-to-date");
		assert.deepEqual(verifyPrShipFreshness(worktree, first.kind === "content-integrated" ? first.originMainOid : ""), { ok: true });
	});

	it("an unreadable intent record fails classification closed rather than reading as absent", () => {
		const { worktree } = makeFreshnessPair();
		// origin/main is trivially an ancestor (clone tip): the plain up-to-date path.
		const dir = join(worktree, ".dev", "freshness-ours-intents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${encodeURIComponent("feat/tool-99")}.json`), "{ not json");
		const result = preparePrShipFreshness(worktree);
		assert.equal(result.kind, "failed");
		if (result.kind !== "failed") return;
		assert.match(result.detail, /cannot be ruled out/);
	});

	/** Fabricated residual: a merge with the recorded parent pair but the WRONG tree left
	 *  in HEAD's history, witnessed only by an unconfirmed intent record. */
	function makeTaintedAncestry(): { worktree: string; origin: string; badMerge: string; originMainOid: string; headOid: string } {
		const { worktree, origin, headOid, originMainOid, expectedTreeOid } = makeContentCopiedPair();
		const badMerge = execSync(`git commit-tree "${originMainOid}^{tree}" -p ${headOid} -p ${originMainOid} -m fake-ours`, { cwd: worktree, encoding: "utf-8" }).trim();
		execSync(`git reset -q --hard ${badMerge}`, { cwd: worktree });
		writeFreshnessOursIntent(worktree, { branch: "feat/tool-99", headOid, originMainOid, expectedTreeOid, recordedAt: new Date().toISOString() });
		return { worktree, origin, badMerge, originMainOid, headOid };
	}

	it("a .gitmodules ignore=all cannot hide an upstream gitlink bump from the equivalence proof", () => {
		const { worktree, origin } = makeFreshnessPair();
		const sub1 = "1".repeat(40);
		const sub2 = "2".repeat(40);
		// Shared history carries the gitlink AND the tracked ignore=all that would hide
		// its changes from the diff family without --ignore-submodules=none.
		writeFileSync(join(origin, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./unused\n\tignore = all\n');
		execSync("git add .gitmodules", { cwd: origin });
		execSync(`git update-index --add --cacheinfo 160000,${sub1},sub`, { cwd: origin });
		execSync("git commit -q -m gitlink-base", { cwd: origin });
		execSync("git fetch -q origin main && git merge -q --no-edit origin/main", { cwd: worktree });
		execSync(`git update-index --add --cacheinfo 160000,${sub2},sub`, { cwd: origin });
		execSync("git commit -q -m gitlink-bump", { cwd: origin });
		commitFile(worktree, "src/feature.ts", "export const feat = 1;\n", "feature-only");
		const result = preparePrShipFreshness(worktree);
		// A vacuous proof here would content-integrate and silently REVERT the bump.
		assert.notEqual(result.kind, "content-integrated");
		assert.equal(result.kind, "merged");
		if (result.kind !== "merged") return;
		assert.equal(execSync("git rev-parse HEAD:sub", { cwd: worktree, encoding: "utf-8" }).trim(), sub2, "the ordinary merge must carry the upstream gitlink bump");
	});

	it("an origin advance cannot clear or supersede an unproven merge: the gate refuses before newer-tip integration", () => {
		const { worktree, origin, badMerge } = makeTaintedAncestry();
		// origin moves past the recorded OID, so the fetched tip is NOT an ancestor — the
		// gate must still run before the shortcut can overwrite or the ordinary path can
		// clear the sole intent record for this branch.
		commitFile(origin, "src/later.ts", "export const later = 1;\n", "upstream advance");
		const result = preparePrShipFreshness(worktree);
		assert.equal(result.kind, "failed");
		if (result.kind !== "failed") return;
		assert.match(result.detail, /unproven ours merge/);
		assert.ok(result.detail.includes(badMerge));
		// Nothing integrated, nothing lost: HEAD and the unconfirmed record are intact.
		assert.equal(execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim(), badMerge);
		assert.equal(existsSync(join(worktree, "src/later.ts")), false);
		const record = readFreshnessOursIntent(worktree, "feat/tool-99");
		assert.equal(record.kind === "record" && record.record.state, "intent");
	});

	it("a faithful unproven merge is retro-confirmed before a newer origin tip integrates on top of it", () => {
		const { worktree, origin } = makeContentCopiedPair();
		const first = preparePrShipFreshness(worktree, (args, cwd) => {
			if (args[0] === "rev-parse" && args[1] === "--verify" && args[2]?.endsWith("^2^{commit}")) throw new Error("probe infra failure");
			return execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		assert.equal(first.kind, "failed");
		const faithfulMerge = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
		commitFile(origin, "src/later.ts", "export const later = 1;\n", "upstream advance");
		const second = preparePrShipFreshness(worktree);
		// The pending O1 bracket is completed first (probes pass — faithful merge), and
		// only then does the ordinary merge integrate the newer tip.
		assert.equal(second.kind, "merged");
		assert.equal(existsSync(join(worktree, "src/later.ts")), true);
		assert.equal(execSync(`git merge-base --is-ancestor ${faithfulMerge} HEAD && echo yes`, { cwd: worktree, encoding: "utf-8" }).trim(), "yes");
		// Confirmed on the way through, then superseded by the ordinary-path clear.
		const record = readFreshnessOursIntent(worktree, "feat/tool-99");
		assert.ok(record.kind === "absent" || (record.kind === "record" && record.record.state === "confirmed"));
	});

	it("a branch rename after a failed probe cannot dodge the gate: records are scanned store-wide", () => {
		const { worktree, badMerge, originMainOid } = makeTaintedAncestry();
		execSync("git branch -m feat/tool-99 feat/renamed", { cwd: worktree });
		const result = preparePrShipFreshness(worktree);
		assert.equal(result.kind, "failed");
		if (result.kind !== "failed") return;
		assert.match(result.detail, /unproven ours merge/);
		assert.ok(result.detail.includes(badMerge));
		assert.equal(verifyPrShipFreshness(worktree, originMainOid).ok, false);
	});

	it("a detached HEAD after a failed probe cannot dodge the gate", () => {
		const { worktree, badMerge } = makeTaintedAncestry();
		execSync("git checkout -q --detach", { cwd: worktree });
		const result = preparePrShipFreshness(worktree);
		assert.equal(result.kind, "failed");
		if (result.kind !== "failed") return;
		assert.match(result.detail, /unproven ours merge/);
		assert.ok(result.detail.includes(badMerge));
	});

	it("a forged confirmed record missing its probe evidence is invalid and fails classification closed", () => {
		const { worktree } = makeTaintedAncestry();
		// Forge: flip the on-disk intent to state=confirmed with NO mergeOid/confirmedAt —
		// no probe-bound evidence. It must read as invalid (and its head is reachable, so
		// it fails closed), never be skipped-as-confirmed.
		const path = join(worktree, ".dev", "freshness-ours-intents", `${encodeURIComponent("feat/tool-99")}.json`);
		const forged = { ...JSON.parse(readFileSync(path, "utf-8")), state: "confirmed" };
		writeFileSync(path, JSON.stringify(forged));
		const result = preparePrShipFreshness(worktree);
		assert.equal(result.kind, "failed");
		if (result.kind !== "failed") return;
		assert.match(result.detail, /cannot be ruled out/);
		assert.match(result.detail, /failed schema validation/);
		assert.equal(verifyPrShipFreshness(worktree, execSync("git rev-parse origin/main", { cwd: worktree, encoding: "utf-8" }).trim()).ok, false);
	});

	it("a probe execution failure cannot bypass an outstanding intent: classification fails closed", () => {
		const { worktree, headOid } = makeTaintedAncestry();
		const result = preparePrShipFreshness(worktree, (args, cwd) => {
			if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === headOid) {
				throw Object.assign(new Error("object store i/o failure"), { status: 128 });
			}
			return execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		// A collapsed probe would read as "not an ancestor", skip the record, and accept
		// up-to-date over the unproven merge.
		assert.equal(result.kind, "failed");
		if (result.kind !== "failed") return;
		assert.match(result.detail, /could not be checked against ancestry/);
	});

	it("a malformed record that cannot reach this HEAD degrades to a diagnostic instead of failing every branch", () => {
		const { worktree } = makeFreshnessPair();
		// A real commit OUTSIDE this HEAD's ancestry keys the malformed record.
		execSync("git checkout -q -b throwaway", { cwd: worktree });
		commitFile(worktree, "side.txt", "side\n", "side commit");
		const sideOid = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
		execSync("git checkout -q feat/tool-99", { cwd: worktree });
		const dir = join(worktree, ".dev", "freshness-ours-intents");
		mkdirSync(dir, { recursive: true });
		// Parseable but schema-invalid (confirmed without probe evidence): it cannot
		// launder what is not in our history, so this branch proceeds; the record still
		// hard-fails the branch whose HEAD descends from its recorded head.
		writeFileSync(
			join(dir, `${encodeURIComponent("feat/other")}.json`),
			JSON.stringify({ schemaVersion: 1, branch: "feat/other", headOid: sideOid, originMainOid: "f".repeat(40), expectedTreeOid: "e".repeat(40), state: "confirmed", recordedAt: new Date().toISOString() }),
		);
		const result = preparePrShipFreshness(worktree);
		assert.equal(result.kind, "up-to-date");
	});

	it("an ours merge that landed despite a reported failure is gated + retro-confirmed, never laundered through the ordinary merge", () => {
		const { worktree } = makeContentCopiedPair();
		let ordinaryMergeRan = false;
		const result = preparePrShipFreshness(worktree, (args, cwd) => {
			if (args[0] === "merge" && args.includes("--strategy=ours")) {
				// The merge actually lands (HEAD advances to a faithful ours merge) but git is
				// "killed" before the harness observes a clean exit — a non-zero, non-conflict
				// failure with a committed HEAD.
				execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
				throw Object.assign(new Error("killed after HEAD update"), { status: 137 });
			}
			if (args[0] === "merge" && !args.includes("--strategy=ours")) ordinaryMergeRan = true;
			return execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		// The landed merge is faithful, so it retro-confirms — it is NOT cleared and re-run
		// through the ordinary merge over the already-advanced ancestry.
		assert.equal(result.kind, "content-integrated");
		assert.equal(ordinaryMergeRan, false, "must not fall through to the ordinary merge over the already-advanced ancestry");
		const mergeOid = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
		const record = readFreshnessOursIntent(worktree, "feat/tool-99");
		assert.equal(record.kind, "record");
		if (record.kind !== "record") return;
		assert.equal(record.record.state, "confirmed");
		assert.equal(record.record.mergeOid, mergeOid);
	});

	it("a landed-but-unfaithful ours merge after a reported failure fails closed instead of laundering the wrong tree", () => {
		const { worktree, headOid, originMainOid } = makeContentCopiedPair();
		let ordinaryMergeRan = false;
		const result = preparePrShipFreshness(worktree, (args, cwd) => {
			if (args[0] === "merge" && args.includes("--strategy=ours")) {
				// Fabricate a WRONG-tree merge landing on HEAD (origin's tree — the feature
				// work is dropped), then "die": a corrupt/interrupted merge that still moved HEAD.
				const bad = execSync(`git commit-tree "${originMainOid}^{tree}" -p ${headOid} -p ${originMainOid} -m corrupt`, { cwd, encoding: "utf-8" }).trim();
				execSync(`git reset -q --hard ${bad}`, { cwd });
				throw Object.assign(new Error("killed after corrupt HEAD update"), { status: 137 });
			}
			if (args[0] === "merge" && !args.includes("--strategy=ours")) ordinaryMergeRan = true;
			return execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		assert.equal(result.kind, "failed");
		if (result.kind !== "failed") return;
		assert.match(result.detail, /HEAD tree changed/);
		assert.equal(ordinaryMergeRan, false, "the unproven tree must never reach the ordinary merge");
		// Rolled back to the pre-merge head — the corrupt merge is discarded, feature work restored.
		assert.equal(execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim(), headOid);
		assert.equal(existsSync(join(worktree, "src/feature.ts")), true);
	});

	it("an orphaned intent whose head object is missing degrades to a diagnostic instead of wedging the store", () => {
		const { worktree } = makeFreshnessPair();
		// origin/main is trivially an ancestor (clone tip) → the up-to-date path, gated first.
		writeFreshnessOursIntent(worktree, {
			branch: "feat/other",
			headOid: "a".repeat(40), // valid OID shape, but no such object exists
			originMainOid: "b".repeat(40),
			expectedTreeOid: "c".repeat(40),
			recordedAt: new Date().toISOString(),
		});
		const result = preparePrShipFreshness(worktree);
		// A missing head object means the recorded merge cannot be in our history, so this
		// branch proceeds; a pre-fix `is-ancestor` on the missing object (exit 128) would
		// have wedged every branch.
		assert.equal(result.kind, "up-to-date");
	});

	it("a git exec failure while probing a pending intent still fails closed, never degrades", () => {
		const { worktree } = makeTaintedAncestry();
		const result = preparePrShipFreshness(worktree, (args, cwd) => {
			if (args[0] === "cat-file" && args[1] === "-e") throw Object.assign(new Error("object store i/o error"), { status: 128 });
			return execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		});
		assert.equal(result.kind, "failed");
		if (result.kind !== "failed") return;
		assert.match(result.detail, /could not be checked against ancestry/);
	});
});

/** Local two-branch conflict on f.txt: worktree left mid-merge (MERGE_HEAD + markers). */
function makeConflictedFeatRepo(): string {
	const dir = makeFeatRepo();
	commitFile(dir, "f.txt", "feat\n", "feat side");
	execSync("git checkout -q main", { cwd: dir });
	commitFile(dir, "f.txt", "main\n", "main side");
	execSync("git checkout -q feat/tool-99", { cwd: dir });
	try {
		execSync("git merge --no-edit main", { cwd: dir, stdio: "pipe" });
	} catch {
		// conflict expected
	}
	return dir;
}

describe("verifyConflictRepairComplete (#424)", () => {
	it("fails while git unmerged-path state remains (no-op repair)", () => {
		const dir = makeConflictedFeatRepo();
		const result = verifyConflictRepairComplete(dir, ["f.txt"]);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.detail, /unmerged paths remain: f\.txt/);
	});

	it("fails when a formerly-conflicted file was staged with its markers intact", () => {
		const dir = makeConflictedFeatRepo();
		execSync("git add f.txt", { cwd: dir });
		const result = verifyConflictRepairComplete(dir, ["f.txt"]);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.detail, /conflict markers remain in: f\.txt/);
	});

	it("passes once the file is genuinely resolved and staged", () => {
		const dir = makeConflictedFeatRepo();
		writeFileSync(join(dir, "f.txt"), "resolved\n");
		execSync("git add f.txt", { cwd: dir });
		assert.deepEqual(verifyConflictRepairComplete(dir, ["f.txt"]), { ok: true });
	});

	it("treats deletion of a conflicted file as a legitimate resolution", () => {
		const dir = makeConflictedFeatRepo();
		execSync("git rm -q -f f.txt", { cwd: dir });
		assert.deepEqual(verifyConflictRepairComplete(dir, ["f.txt"]), { ok: true });
	});

	it("scans only the listed files: markers elsewhere do not trip the gate", () => {
		const dir = makeConflictedFeatRepo();
		writeFileSync(join(dir, "f.txt"), "resolved\n");
		execSync("git add f.txt", { cwd: dir });
		// A doc legitimately containing a seven-equals line, never part of the conflict set.
		writeFileSync(join(dir, "notes.md"), "Heading\n=======\nbody\n");
		assert.deepEqual(verifyConflictRepairComplete(dir, ["f.txt"]), { ok: true });
		const flagged = verifyConflictRepairComplete(dir, ["f.txt", "notes.md"]);
		assert.equal(flagged.ok, false, "the same content IS flagged when the file was conflicted");
	});
});

describe("checkpoint — unresolved merge refusal (#424)", () => {
	it("refuses to conclude an unresolved merge: no commit, MERGE_HEAD and markers intact", () => {
		const dir = makeConflictedFeatRepo();
		const before = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
		assert.equal(checkpoint(dir, "test"), false);
		assert.equal(execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim(), before, "no commit may land");
		assert.equal(execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: dir, encoding: "utf-8" }).trim().length > 0, true, "merge stays open");
		assert.match(readFileSync(join(dir, "f.txt"), "utf-8"), /^<{7} /m, "markers stay in the working tree");
		assert.match(execSync("git diff --name-only --diff-filter=U", { cwd: dir, encoding: "utf-8" }), /f\.txt/, "unmerged state is preserved");
	});

	it("still commits a resolved-and-staged merge (concluding it) as before", () => {
		const dir = makeConflictedFeatRepo();
		writeFileSync(join(dir, "f.txt"), "resolved\n");
		execSync("git add f.txt", { cwd: dir });
		assert.equal(checkpoint(dir, "merge done"), true);
		assert.throws(() => execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: dir, stdio: "pipe" }), "merge must be concluded");
		assert.equal(execSync("git log -1 --format=%P", { cwd: dir, encoding: "utf-8" }).trim().split(" ").length, 2, "two-parent merge commit");
	});

	// #424 gate fix (rate-limit-during-repair interleave): mid-repair the author has
	// `git add`-ed the conflicted file with its markers intact — unmerged-path state is
	// empty, so the original refusal above is blind — and a rate-limit park then calls
	// this unguarded checkpoint while MERGE_HEAD is still open.
	it("refuses the rate-limit-park interleave: staged conflict markers with MERGE_HEAD open never commit", () => {
		const dir = makeConflictedFeatRepo();
		execSync("git add f.txt", { cwd: dir });
		assert.equal(execSync("git diff --name-only --diff-filter=U", { cwd: dir, encoding: "utf-8" }).trim(), "", "precondition: staging cleared unmerged-path state — the unmerged-path guard alone is blind here");
		const before = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
		assert.equal(checkpoint(dir, "rate-limit park"), false);
		assert.equal(execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim(), before, "no commit may land");
		assert.equal(execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: dir, encoding: "utf-8" }).trim().length > 0, true, "merge stays open for resume to re-enter `conflicted`");
		assert.match(readFileSync(join(dir, "f.txt"), "utf-8"), /^<{7} /m, "markers stay observable in the working tree");
	});

	it("conservatively refuses ANY staged marker lines while a merge is open (conflicted set unknown at this choke point)", () => {
		const dir = makeConflictedFeatRepo();
		writeFileSync(join(dir, "f.txt"), "resolved\n");
		execSync("git add f.txt", { cwd: dir });
		// A separate file with a marker-shaped line (setext underline). With MERGE_HEAD open the
		// checkpoint cannot know the conflicted set, so it must fail closed and park dirty.
		writeFileSync(join(dir, "notes.md"), "Heading\n=======\nbody\n");
		assert.equal(checkpoint(dir, "rate-limit park"), false);
		assert.equal(execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: dir, encoding: "utf-8" }).trim().length > 0, true, "merge stays open");
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

	it("parses stale-quarantined (#217)", () => {
		assert.equal(parsePickResult("pick-result: stale-quarantined"), "stale-quarantined");
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

	it("parses a bare-numeric github issue ID — the authoritative marker must win over free text (#332)", () => {
		assert.equal(parsePickItem("Requested issue 286.\npick-item: 337\npick-result: claimed"), "337");
		assert.equal(parsePickItem("pick-item: 286"), "286");
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

	it("clamps small file counts up to the 150 floor", () => {
		const body = ["## Files", "", "| Path | Change |", "|---|---|", "| `a.ts` | x |"].join("\n");
		// 2*1 + 100 = 102 → clamped to 150 floor
		assert.equal(computeImplementTurns(body, 200), 150);
	});

	it("scales linearly in the middle band", () => {
		const rows = Array.from({ length: 40 }, (_, i) => `| \`file${i}.ts\` | x |`).join("\n");
		const body = ["## Files", "", "| Path | Change |", "|---|---|", rows].join("\n");
		// 2*40 + 100 = 180
		assert.equal(computeImplementTurns(body, 200), 180);
	});

	it("clamps large file counts to the 400 ceiling (escape hatch for atomic large work)", () => {
		const rows = Array.from({ length: 150 }, (_, i) => `| \`file${i}.ts\` | x |`).join("\n");
		const body = ["## Files", "", "| Path | Change |", "|---|---|", rows].join("\n");
		// 2*150 + 100 = 400 → at the ceiling
		assert.equal(computeImplementTurns(body, 200), 400);
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

describe("classifyParkReason", () => {
	it("lets a structured limitType win over any reason text", () => {
		assert.equal(classifyParkReason(null, "paused"), "paused");
		assert.equal(classifyParkReason(null, "sdk-outage"), "sdk-outage");
		assert.equal(classifyParkReason("adversarial review dissent", "5h"), "rate-limit");
	});

	it("classifies the review-loop park reasons the pipeline actually emits", () => {
		assert.equal(classifyParkReason("adversarial review could not bind current HEAD", ""), "review-binding");
		assert.equal(classifyParkReason("adversarial review could not bind final reviewed HEAD", ""), "review-binding");
		assert.equal(classifyParkReason("adversarial review escalation active", ""), "review-escalation");
		assert.equal(classifyParkReason("adversarial review escalation write-failed", ""), "review-escalation");
		assert.equal(classifyParkReason("adversarial review safety blocker", ""), "review-blocked");
		assert.equal(classifyParkReason("adversarial review hard-block", ""), "review-blocked");
		assert.equal(classifyParkReason("adversarial review dissent", ""), "review-blocked");
		assert.equal(classifyParkReason("adversarial review budget", ""), "review-blocked");
		assert.equal(classifyParkReason("adversarial review produced no loop result", ""), "review-blocked");
	});

	it("treats an effects failure after escalation as effects-failed, not escalation", () => {
		assert.equal(classifyParkReason("shakedown-code effects failed after escalation: gh pr edit exploded", ""), "effects-failed");
	});

	it("returns unclassified for an absent or unrecognized reason", () => {
		assert.equal(classifyParkReason(null, null), "unclassified");
		assert.equal(classifyParkReason("", ""), "unclassified");
		assert.equal(classifyParkReason("something nobody has seen before", ""), "unclassified");
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

describe("classifyCycleDisposition", () => {
	const recoverable = new Set(["transient sdk error"]);

	it("continues completed and recoverable cycles", () => {
		assert.equal(classifyCycleDisposition({ completed: true }, recoverable), "continue");
		assert.equal(classifyCycleDisposition({ completed: false, error: "transient sdk error" }, recoverable), "continue");
	});

	it("lets aborted override a stale disposition", () => {
		assert.equal(classifyCycleDisposition({ completed: false, error: "aborted", disposition: "quarantine-and-continue" }, recoverable), "halt-campaign");
	});

	it("passes through explicit dispositions", () => {
		assert.equal(classifyCycleDisposition({ completed: false, disposition: "quarantine-and-continue" }, recoverable), "quarantine-and-continue");
		assert.equal(classifyCycleDisposition({ completed: false, disposition: "halt-campaign" }, recoverable), "halt-campaign");
	});

	it("halts unknown non-recoverable failures", () => {
		assert.equal(classifyCycleDisposition({ completed: false, error: "unknown failure" }, recoverable), "halt-campaign");
	});
});

describe("quarantineCheckpoint", () => {
	it("commits a dirty tree and leaves it clean", () => {
		const dir = makeFeatRepo();
		writeFileSync(resolve(dir, "wip.txt"), "work");
		assert.equal(quarantineCheckpoint(dir, "andon quarantine"), true);
		assert.equal(execSync("git status --porcelain", { cwd: dir, encoding: "utf-8" }).trim(), "");
	});

	it("accepts an already-clean tree", () => {
		assert.equal(quarantineCheckpoint(makeFeatRepo(), "andon quarantine"), true);
	});

	it("fails closed outside a git repository", () => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-quarantine-"));
		assert.equal(quarantineCheckpoint(dir, "andon quarantine"), false);
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

	it("resolves the real installed claude SDK version via module resolution (no path mock)", () => {
		// createRequire + walk-up — not a hard-coded ../../node_modules path (#333).
		// Catches hoisted/published layouts and ERR_PACKAGE_PATH_NOT_EXPORTED for package.json.
		const manifestPath = resolveClaudeSdkManifestPath();
		assert.match(manifestPath, /claude-agent-sdk[/\\]package\.json$/);
		const pkg = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name: string; version: string };
		assert.equal(pkg.name, "@anthropic-ai/claude-agent-sdk");
		const result = readRuntimeVersions(["claude"]);
		assert.equal(result.versions.drivers.claude, pkg.version);
		assert.match(result.versions.drivers.claude ?? "", /^\d+\.\d+\.\d+/);
		assert.ok(!result.unavailable.includes("version.claude"));
	});

	it("records version.claude when SDK manifest resolution fails (fail-open)", () => {
		const result = readRuntimeVersions(["claude"], {
			resolveClaudeSdkManifest: () => {
				throw new Error("not installed");
			},
		});
		assert.equal(result.versions.drivers.claude, undefined);
		assert.deepEqual(result.unavailable, ["version.claude"]);
	});

	it("uses an injectable Claude SDK manifest path (hoisted-layout stand-in)", () => {
		const root = mkdtempSync(join(tmpdir(), "pelaggio-sdk-hoist-"));
		// Mimic a hoisted install: package lives outside packages/pelaggio/node_modules.
		const sdkDir = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
		mkdirSync(sdkDir, { recursive: true });
		const manifestPath = join(sdkDir, "package.json");
		writeFileSync(manifestPath, JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "9.9.9-hoisted" }));
		const result = readRuntimeVersions(["claude"], {
			readManifest: (path) => {
				if (path === manifestPath) return readFileSync(path, "utf-8");
				return JSON.stringify({ version: "0.1.0" });
			},
			resolveClaudeSdkManifest: () => manifestPath,
		});
		assert.equal(result.versions.drivers.claude, "9.9.9-hoisted");
		assert.ok(!result.unavailable.includes("version.claude"));
	});

	it("walks up from a nested package entry to the matching package.json", () => {
		// Real SDK exports hide ./package.json (ERR_PACKAGE_PATH_NOT_EXPORTED). Simulate a
		// published layout where require.resolve lands on dist/entry.js and the walk finds the
		// parent manifest — also proves we ignore intermediate package.json with the wrong name.
		const root = mkdtempSync(join(tmpdir(), "pelaggio-sdk-walk-"));
		const sdkDir = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
		const distDir = join(sdkDir, "dist");
		mkdirSync(distDir, { recursive: true });
		writeFileSync(join(distDir, "package.json"), JSON.stringify({ name: "not-the-sdk", version: "0.0.0" }));
		writeFileSync(join(distDir, "entry.js"), "export default {};\n");
		const manifestPath = join(sdkDir, "package.json");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				name: "@anthropic-ai/claude-agent-sdk",
				version: "1.2.3-nested",
				exports: { ".": "./dist/entry.js" },
			}),
		);
		const caller = join(root, "caller.mjs");
		writeFileSync(caller, "export {};\n");
		const found = resolveClaudeSdkManifestPath(pathToFileURL(caller).href);
		assert.equal(found, manifestPath);
	});
});
