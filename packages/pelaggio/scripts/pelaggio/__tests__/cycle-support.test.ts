import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	buildReviewDiffBlock,
	classifySecurityReviewDiff,
	computeImplementTurns,
	countPlanFiles,
	formatChangesUnderReview,
	formatReviewMetrics,
	guardConfigDelta,
	REVIEW_DIFF_MAX_BYTES,
	readRuntimeVersions,
	resolveClaudeSdkManifestPath,
	revertPlanPolish,
	uniqueDriverProvenance,
} from "../cycle-support.js";
import { readGitBinding } from "../git.js";
import { expandPackagedSkill, expandSkill } from "../skills.js";

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

describe("classifySecurityReviewDiff", () => {
	const hunk = (...lines: string[]): string => ["diff --git a/docs/setup.md b/docs/setup.md", "--- a/docs/setup.md", "+++ b/docs/setup.md", "@@ -1 +1 @@", ...lines].join("\n");

	it("triggers for security-sensitive server config paths", () => {
		const signal = classifySecurityReviewDiff(["packages/server/src/config.ts"], "diff --git a/packages/server/src/config.ts b/packages/server/src/config.ts\n");

		assert.equal(signal.triggered, true);
		assert.ok(signal.reasons.includes("path:packages/server/src/config.ts"));
	});

	it("triggers for the merge-gate body and the helpers.ts split even without a security keyword (path-only)", () => {
		for (const file of [
			"packages/pelaggio/scripts/pelaggio/pr-review-gate.ts",
			"packages/pelaggio/scripts/pelaggio/pr-review-cli.ts",
			"packages/pelaggio/scripts/pelaggio/git.ts",
			"packages/pelaggio/scripts/pelaggio/outcome-classify.ts",
			"packages/pelaggio/scripts/pelaggio/cycle-support.ts",
			"packages/pelaggio/scripts/pelaggio/confinement/roots.ts",
			"packages/pelaggio/scripts/pelaggio/text.ts",
			"packages/pelaggio/scripts/pelaggio/providers/claude.ts",
			"packages/pelaggio/scripts/pelaggio/providers/codex.ts",
		]) {
			const signal = classifySecurityReviewDiff([file], `diff --git a/${file} b/${file}\n+const label = "standard";\n`);
			assert.equal(signal.triggered, true, file);
			assert.ok(signal.reasons.includes(`path:${file}`), file);
		}
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
		const signal = classifySecurityReviewDiff([".github/workflows/pr-review.yml", "packages/pelaggio/scripts/pelaggio/git.ts"], hunk("+execFileSync('gh', ['workflow', 'run'])", "+spawn('bash', ['-lc', command])"));

		assert.equal(signal.triggered, true);
		assert.ok(signal.reasons.includes("path:.github/workflows/pr-review.yml"));
		assert.ok(signal.reasons.includes("path:packages/pelaggio/scripts/pelaggio/git.ts"));
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

describe("guard config in the security signal", () => {
	const LAYERING = "packages/pelaggio/scripts/pelaggio/__tests__/module-layering.test.ts";
	const LAYERS_FILE = LAYERING;
	const REGISTERS = "packages/pelaggio/scripts/pelaggio/registers.ts";
	const fileDiff = (file: string, ...lines: string[]): string => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", ...lines].join("\n");

	it("guard config files are security paths even without a keyword (path-only)", () => {
		for (const file of [LAYERING, REGISTERS, "lefthook.yml", "ci/guards-staged.sh"]) {
			const signal = classifySecurityReviewDiff([file], fileDiff(file, "+// comment"));
			assert.equal(signal.triggered, true, file);
			assert.ok(signal.reasons.includes(`path:${file}`), file);
		}
	});

	it("renders a layer reclassification, an added module and a removed module as guard reasons", () => {
		const diff = fileDiff(LAYERING, '-\t"text.ts": 0,', '+\t"text.ts": 4,', '+\t"steps/plan.ts": 4,', '-\t"helpers.ts": 4,');
		assert.deepEqual(guardConfigDelta(diff), ["guard:layer text.ts L0→L4", "guard:layer helpers.ts removed", "guard:layer steps/plan.ts added L4"]);
		const signal = classifySecurityReviewDiff([LAYERING], diff);
		assert.ok(signal.reasons.includes("guard:layer text.ts L0→L4"));
		// Guard deltas outrank path reasons under the limit.
		assert.ok(signal.reasons.indexOf("guard:layer text.ts L0→L4") < signal.reasons.indexOf(`path:${LAYERING}`));
	});

	it("renders a register kind change, including the agentReads bit", () => {
		const diff = fileDiff(
			REGISTERS,
			'-\t{ name: "effects", kind: "harness", shape: "dir" },',
			'+\t{ name: "effects", kind: "agent", shape: "dir" },',
			'-\t{ name: "attempts", kind: "harness", shape: "dir" },',
			'+\t{ name: "attempts", kind: "harness", shape: "dir", agentReads: true },',
		);
		assert.deepEqual(guardConfigDelta(diff), ["guard:register attempts harness/dir→harness/dir+agentReads", "guard:register effects harness/dir→agent/dir"]);
	});

	it("renders a register shape change (dir→file narrows a write denial to one path)", () => {
		const diff = fileDiff(REGISTERS, '-\t{ name: "sessions", kind: "harness", shape: "dir" },', '+\t{ name: "sessions", kind: "harness", shape: "file" },');
		assert.deepEqual(guardConfigDelta(diff), ["guard:register sessions harness/dir→harness/file"]);
	});

	it("a trailing comment on a LAYERS row does not hide its delta, and register deltas outrank added layer rows", () => {
		const diff = [
			fileDiff(LAYERS_FILE, '-\t"text.ts": 0,', '+\t"text.ts": 4, // moved', '+\t"a.ts": 4,', '+\t"b.ts": 4,'),
			fileDiff(REGISTERS, '-\t{ name: "effects", kind: "harness", shape: "dir" },', '+\t{ name: "effects", kind: "agent", shape: "dir" },'),
		].join("\n");
		assert.deepEqual(guardConfigDelta(diff), ["guard:register effects harness/dir→agent/dir", "guard:layer text.ts L0→L4", "guard:layer a.ts added L4", "guard:layer b.ts added L4"]);
	});

	it("does not fire on edits to the guard files that change no table entry (no false fire)", () => {
		const diff = [
			fileDiff(LAYERING, "-\t// L0 foundation — old comment", "+\t// L0 foundation — new comment", '+\t\tassert.ok(true, "text.ts: 4");'),
			fileDiff(REGISTERS, '+// a comment that mentions name: "effects", kind: "agent" in prose'),
			fileDiff("packages/pelaggio/scripts/pelaggio/text.ts", '-\t"text.ts": 0,', '+\t"text.ts": 4,'),
		].join("\n");
		assert.deepEqual(guardConfigDelta(diff), []);
	});

	it("an unchanged entry that merely moves within the table is not a delta", () => {
		const diff = fileDiff(LAYERING, '-\t"text.ts": 0,', '+\t"text.ts": 0,');
		assert.deepEqual(guardConfigDelta(diff), []);
	});
});
