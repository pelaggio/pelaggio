import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { classifySecurityReviewDiff, guardConfigDelta, SECURITY_REASON_LIMIT } from "../security-review-trigger.js";

const hunk = (...lines: string[]): string => ["diff --git a/docs/setup.md b/docs/setup.md", "--- a/docs/setup.md", "+++ b/docs/setup.md", "@@ -1 +1 @@", ...lines].join("\n");
const fileDiff = (file: string, ...lines: string[]): string => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", ...lines].join("\n");

const LAYERING = "packages/pelaggio/scripts/pelaggio/__tests__/module-layering.test.ts";
const REGISTERS = "packages/pelaggio/scripts/pelaggio/registers.ts";
const TRIGGER_MODULE = "packages/pelaggio/scripts/pelaggio/security-review-trigger.ts";
const TRIGGER_TEST = "packages/pelaggio/scripts/pelaggio/__tests__/security-review-trigger.test.ts";

describe("classifySecurityReviewDiff", () => {
	it("triggers for security-sensitive server config paths", () => {
		const signal = classifySecurityReviewDiff(["packages/server/src/config.ts"], "diff --git a/packages/server/src/config.ts b/packages/server/src/config.ts\n");
		assert.equal(signal.triggered, true);
		assert.deepEqual(signal.reasons, ["path:packages/server/src/config.ts"]);
	});

	it("true-fires on guarantee-holding merge-gate, confinement, and claude-provider paths", () => {
		for (const file of [
			"packages/pelaggio/scripts/pelaggio/pr-review-gate.ts",
			"packages/pelaggio/scripts/pelaggio/confinement/roots.ts",
			"packages/pelaggio/scripts/pelaggio/providers/claude.ts",
			"packages/server/src/auth.ts",
			"packages/server/src/app.ts",
			"packages/server/src/config.ts",
			"packages/server/scripts/server.ts",
			".github/workflows/pr-review.yml",
			"infra/jail.bpf",
			"lefthook.yml",
			"ci/guards-staged.sh",
			"packages/pelaggio/scripts/pelaggio/ship/decision.ts",
			"packages/pelaggio/scripts/pelaggio/review/findings.ts",
			".claude/skills/pr-review/SKILL.md",
			".claude/skills/pr-verify/SKILL.md",
			".claude/skills/ship/SKILL.md",
			".claude/skills/implement/SKILL.md",
		]) {
			const signal = classifySecurityReviewDiff([file], `diff --git a/${file} b/${file}\n+const label = "standard";\n`);
			assert.equal(signal.triggered, true, file);
			assert.ok(signal.reasons.includes(`path:${file}`), file);
		}
	});

	it("fires only on the two evidence-backed assurance holders, not adjacent names", () => {
		for (const file of ["ci/__tests__/shadow-assurance.test.ts", "ci/assurance-observations.ts"]) {
			assert.equal(classifySecurityReviewDiff([file], "").triggered, true);
			assert.equal(classifySecurityReviewDiff([`${file}.md`], "").triggered, false);
		}
		assert.equal(classifySecurityReviewDiff(["ci/assurance-observations.test.ts"], "").triggered, false);
	});

	it("does not fire on dropped incidental paths", () => {
		for (const file of [
			"packages/pelaggio/scripts/pelaggio/config.ts",
			"packages/pelaggio/scripts/pelaggio/pr-review-cli.ts",
			"packages/pelaggio/scripts/pelaggio/revise-sweep.ts",
			"packages/pelaggio/scripts/pelaggio/worktree-deps.ts",
			"packages/pelaggio/scripts/pelaggio/cycle-outcome.ts",
			"packages/pelaggio/scripts/pelaggio/skills.ts",
			"packages/pelaggio/scripts/pelaggio/pick-parse.ts",
			"packages/pelaggio/scripts/pelaggio/text.ts",
			"packages/pelaggio/scripts/pelaggio/providers/codex.ts",
			"packages/pelaggio/scripts/pelaggio/providers/index.ts",
			"packages/pelaggio/scripts/pelaggio/providers/types.ts",
			"packages/pelaggio/scripts/pelaggio/git.ts",
			"packages/pelaggio/scripts/pelaggio/outcome-classify.ts",
			"packages/pelaggio/scripts/pelaggio/cycle-support.ts",
			"packages/pelaggio/scripts/pelaggio/notify.ts",
			"packages/pelaggio/scripts/pelaggio/roadmap/github-issues.ts",
			".claude/skills/shakedown/SKILL.md",
		]) {
			const signal = classifySecurityReviewDiff([file], `diff --git a/${file} b/${file}\n+const label = "standard";\n`);
			assert.deepEqual(signal, { triggered: false, reasons: [] }, file);
		}
	});

	it("does not trigger for former keyword literals on a non-security path", () => {
		const signal = classifySecurityReviewDiff(
			["docs/setup.md"],
			hunk("+token host permission auth exec CONTROL_PLANE_TOKEN GH_TOKEN ANTHROPIC_API_KEY 0.0.0.0 127. ::1 secret loopback localhost fetch network spawn shell bash workflow", "+prompt injection ignore instructions"),
		);
		assert.deepEqual(signal, { triggered: false, reasons: [] });
	});

	it("still true-fires the #102 hostname-prefix shape via the server-config path, without keyword reasons", () => {
		const signal = classifySecurityReviewDiff(["packages/server/src/config.ts"], hunk("+function isLoopbackHost(host: string): boolean {", '+\treturn host === "localhost" || host.startsWith("127.");', "+}"));
		assert.equal(signal.triggered, true);
		assert.deepEqual(signal.reasons, ["path:packages/server/src/config.ts"]);
	});

	it("triggers for workflow paths without treating git.ts or exec keywords as reasons", () => {
		const signal = classifySecurityReviewDiff([".github/workflows/pr-review.yml", "packages/pelaggio/scripts/pelaggio/git.ts"], hunk("+execFileSync('gh', ['workflow', 'run'])", "+spawn('bash', ['-lc', command])"));
		assert.equal(signal.triggered, true);
		assert.deepEqual(signal.reasons, ["path:.github/workflows/pr-review.yml"]);
	});

	it("triggers for the verification contract and skill paths", () => {
		for (const path of ["packages/pelaggio/scripts/pelaggio/review/findings.ts", ".claude/skills/pr-verify/SKILL.md"]) {
			const signal = classifySecurityReviewDiff([path], hunk("+benign text"));
			assert.equal(signal.triggered, true);
			assert.ok(signal.reasons.includes(`path:${path}`));
		}
	});

	it("does not trigger for benign docs-only diffs", () => {
		const signal = classifySecurityReviewDiff(["docs/readme.md"], hunk("+Clarify installation examples."));
		assert.deepEqual(signal, { triggered: false, reasons: [] });
	});

	it("ignores former security keywords on unchanged context lines", () => {
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

	it("does not retain GH_TOKEN or other credential keyword signals on docs", () => {
		const signal = classifySecurityReviewDiff(["docs/setup.md"], hunk("+Set GH_TOKEN as the authentication secret."));
		assert.deepEqual(signal, { triggered: false, reasons: [] });
	});

	it("returns deterministic, de-duplicated, capped path reasons", () => {
		const files = [
			"packages/server/src/config.ts",
			"packages/server/src/config.ts",
			".github/workflows/review.yml",
			"packages/server/src/auth.ts",
			"packages/server/src/app.ts",
			"lefthook.yml",
			"ci/guards-staged.sh",
			"packages/pelaggio/scripts/pelaggio/pr-review-gate.ts",
			"packages/pelaggio/scripts/pelaggio/providers/claude.ts",
			"packages/pelaggio/scripts/pelaggio/review/findings.ts",
		];
		const signal = classifySecurityReviewDiff(files, hunk("+auth token secret permission host loopback localhost 0.0.0.0 127. ::1 fetch network exec spawn shell bash workflow"));
		assert.equal(signal.triggered, true);
		assert.equal(signal.reasons.length, SECURITY_REASON_LIMIT);
		assert.deepEqual(signal.reasons, [
			"path:packages/server/src/config.ts",
			"path:.github/workflows/review.yml",
			"path:packages/server/src/auth.ts",
			"path:packages/server/src/app.ts",
			"path:lefthook.yml",
			"path:ci/guards-staged.sh",
			"path:packages/pelaggio/scripts/pelaggio/pr-review-gate.ts",
			"path:packages/pelaggio/scripts/pelaggio/providers/claude.ts",
		]);
		assert.equal(signal.reasons.includes("path:packages/pelaggio/scripts/pelaggio/review/findings.ts"), false);
		assert.equal(
			signal.reasons.some((reason) => reason.startsWith("keyword:")),
			false,
		);
	});
});

describe("guard config in the security signal", () => {
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
			fileDiff(LAYERING, '-\t"text.ts": 0,', '+\t"text.ts": 4, // moved', '+\t"a.ts": 4,', '+\t"b.ts": 4,'),
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

describe("self-referential trigger ownership", () => {
	it("true-fires with guard:security-review-trigger when the selector, focused test, or authority changes", () => {
		for (const file of [TRIGGER_MODULE, TRIGGER_TEST]) {
			const signal = classifySecurityReviewDiff([file], fileDiff(file, "+export const x = 1;"));
			assert.equal(signal.triggered, true, file);
			assert.deepEqual(signal.reasons, ["guard:security-review-trigger"]);
		}
		const both = classifySecurityReviewDiff([TRIGGER_MODULE, TRIGGER_TEST], `${fileDiff(TRIGGER_MODULE, "+a")}\n${fileDiff(TRIGGER_TEST, "+b")}`);
		assert.deepEqual(both.reasons, ["guard:security-review-trigger"]);
	});

	it("keeps the self-trigger reason first under the eight-reason cap", () => {
		const files = [
			TRIGGER_MODULE,
			"packages/server/src/config.ts",
			"packages/server/src/auth.ts",
			"packages/server/src/app.ts",
			"lefthook.yml",
			"ci/guards-staged.sh",
			".github/workflows/a.yml",
			".github/workflows/b.yml",
			"packages/pelaggio/scripts/pelaggio/pr-review-gate.ts",
			"packages/pelaggio/scripts/pelaggio/providers/claude.ts",
			"packages/pelaggio/scripts/pelaggio/review/findings.ts",
			"packages/pelaggio/scripts/pelaggio/ship/decision.ts",
			"infra/a.ts",
			"infra/b.ts",
			"packages/server/scripts/a.ts",
			"packages/server/scripts/b.ts",
			"packages/pelaggio/scripts/pelaggio/confinement/roots.ts",
			"packages/pelaggio/scripts/pelaggio/confinement/sessions.ts",
			".claude/skills/pr-review/SKILL.md",
			".claude/skills/ship/SKILL.md",
			"packages/pelaggio/scripts/pelaggio/registers.ts",
		];
		assert.ok(files.length > SECURITY_REASON_LIMIT);
		const signal = classifySecurityReviewDiff(files, "");
		assert.equal(signal.reasons[0], "guard:security-review-trigger");
		assert.equal(signal.reasons.length, SECURITY_REASON_LIMIT);
		assert.equal(
			signal.reasons.some((reason) => reason === `path:${TRIGGER_MODULE}` || reason === `path:${TRIGGER_TEST}`),
			false,
		);
	});
});

describe("21-PR historical replay", () => {
	type Roll = { ok: boolean; subtype: string; gate: string; survivorCount: number; recurrenceCount: number };
	type Entry = { pr: number; files: string[]; diff: string; legacyTriggered: boolean; rolls: Roll[] };
	type Attribution = "safe-skip" | "fired" | "fail-closed-added" | "unobserved";

	const cohortPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "security-review-trigger-cohort.json");
	const cohort = JSON.parse(readFileSync(cohortPath, "utf8")) as { entries: Entry[] };
	/** Frozen after the first honest run of this narrowed classifier. Update deliberately with the allowlist. */
	const GOLDEN_FIRE_SET = [689, 690, 691, 693, 694, 695, 697, 699, 700, 710, 713, 719, 722, 730, 736, 762];

	function attributionOf(entry: Entry, newTriggered: boolean): Attribution {
		if (newTriggered) return "fired";
		const redTeamUnique = entry.rolls.some((r) => r.ok && /^red-team:/.test(r.subtype));
		if (redTeamUnique) return "fail-closed-added";
		const allPass = entry.rolls.length > 0 && entry.rolls.every((r) => r.gate === "pass");
		const noSurvivors = entry.rolls.every((r) => r.survivorCount === 0 && r.recurrenceCount === 0);
		if (entry.rolls.length === 0 || allPass || noSurvivors) return "safe-skip";
		return "unobserved";
	}

	it("classifies the frozen 21-PR cohort with the authoritative-holder fire set", () => {
		assert.equal(cohort.entries.length, 21);
		const prs = cohort.entries.map((e) => e.pr);
		for (const required of [713, 722, 730, 736]) assert.ok(prs.includes(required), `cohort missing #${required}`);

		const classified = cohort.entries.map((entry) => {
			const signal = classifySecurityReviewDiff(entry.files, entry.diff);
			return { entry, signal, attribution: attributionOf(entry, signal.triggered) };
		});
		const fireSet = classified
			.filter((row) => row.signal.triggered)
			.map((row) => row.entry.pr)
			.sort((a, b) => a - b);
		assert.deepEqual(fireSet, GOLDEN_FIRE_SET);
		assert.equal(fireSet.length, 16);
		for (const required of [693, 700, 713, 722, 730, 736]) assert.ok(fireSet.includes(required), `fire set missing #${required}`);

		const failClosed = classified.filter((row) => !row.signal.triggered && row.entry.rolls.some((r) => r.ok && /^red-team:/.test(r.subtype)));
		assert.deepEqual(
			failClosed.map((row) => row.entry.pr),
			[],
			"AC-5: a would-skip PR with a unique verified red-team block must not be skipped",
		);

		assert.equal(
			classified.some((row) => row.entry.diff === "" && row.signal.reasons.some((r) => r.startsWith("keyword:"))),
			false,
		);
		assert.equal(
			classified.some((row) => Array.isArray((row.entry as { standardMustFixDigests?: unknown }).standardMustFixDigests)),
			false,
			"historical fixture must not invent empty digest arrays as a zero-loss claim",
		);

		const unobserved = classified.filter((row) => row.attribution === "unobserved").map((row) => row.entry.pr);
		assert.deepEqual(unobserved, [748, 708]);
	});

	it("retains every known red-team-only verified must-fix from the preserved reports", () => {
		const fixtures = dirname(cohortPath);
		const evidence = JSON.parse(readFileSync(join(fixtures, "security-review-known-findings.json"), "utf8")) as Array<{ pr: number; headSha: string; report: string; sha256: string; uniquePhrase: string }>;
		assert.equal(evidence.length, 2);
		const lost: number[] = [];
		for (const known of evidence) {
			const raw = readFileSync(join(fixtures, known.report), "utf8");
			assert.equal(createHash("sha256").update(raw).digest("hex"), known.sha256);
			assert.match(known.headSha, /^[a-f0-9]{40}$/);
			const split = raw.indexOf("## Adversarial Red-Team Review");
			assert.ok(split > 0);
			assert.equal(raw.slice(0, split).includes(known.uniquePhrase), false);
			assert.ok(
				raw
					.slice(split)
					.split("\n")
					.some((line) => line.includes("**must-fix**") && line.includes(known.uniquePhrase) && line.includes("isolated verification: **survives**")),
			);
			const entry = cohort.entries.find((candidate) => candidate.pr === known.pr);
			assert.ok(entry);
			if (!classifySecurityReviewDiff(entry.files, entry.diff).triggered) lost.push(known.pr);
		}
		assert.deepEqual(lost, [], "known verified red-team-only findings must be retained; aggregate subtype is not evidence of absence");
	});

	it("keeps the full path-and-keyword legacy snapshot distinct from the narrowed fire set", () => {
		const byPr = (a: number, b: number) => a - b;
		const legacy = cohort.entries
			.filter((e) => e.legacyTriggered)
			.map((e) => e.pr)
			.sort(byPr);
		const neu = cohort.entries
			.filter((e) => classifySecurityReviewDiff(e.files, e.diff).triggered)
			.map((e) => e.pr)
			.sort(byPr);
		assert.deepEqual(legacy, [690, 691, 693, 694, 695, 697, 698, 699, 700, 704, 710, 713, 717, 719, 722, 730, 736, 748, 762]);
		assert.equal(legacy.length, 19);
		assert.deepEqual(neu, GOLDEN_FIRE_SET);
		assert.ok((cohort.entries.find((e) => e.pr === 722)?.files.length ?? 0) > 0);
		assert.equal(cohort.entries.find((e) => e.pr === 722)?.legacyTriggered, true);
	});
});
