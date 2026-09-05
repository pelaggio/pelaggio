import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => void;

import { parseCli } from "../cli.js";
import { DEFAULTS } from "../config.js";
import { createDriverAssignmentState } from "../driver-assignment.js";
import { runPrReviewGate } from "../pr-review-gate.js";

import { assessmentDigest, assessmentSarif, assessmentTaskPrompt, buildAssessment, makeAssessmentTask, renderAssessment } from "../review/assessment.js";
import { answerAssessmentQuestion, listAssessmentRecords, loadAssessmentInput, questionPathObjects, readAssessmentFile, writeAssessmentRecord } from "../review/assessment-store.js";
import { parseReviewFindings, reviewFindingFingerprint, reviewFindingsGate } from "../review/findings.js";
import { reviewAssessmentMain } from "../review-assessment-cli.js";
import { reviseFindingsPath } from "../revise-sweep.js";
import type { RoadmapSource } from "../roadmap/index.js";
import { runImplement } from "../steps/implement.js";
import type { StepResult } from "../types.js";

const now = "2026-09-05T00:00:00.000Z";
const task = makeAssessmentTask({ itemId: "782", prNumber: 900, source: "simulated:roadmap/782", request: "Usable labels\n\nReturn a usable display label. Clarify blank-input behavior." });
const question = { question: "Which label should blank input display?", context: "The request requires a usable label but does not name a fallback.", paths: ["requirements.md"] };
const finding = {
	severity: "must-fix",
	path: "label.mjs",
	line: 1,
	message: "Blank input returns an unusable empty label.",
	qualification: {
		basis: "code",
		reference: "label.mjs:1",
		conclusion: "Trimming blank input leaves no visible label.",
		limitation: "Code inference; fallback product policy is unresolved.",
		recommendation: "Implement the chosen fallback and check blank input.",
	},
};
const wire = (value: unknown): string => `REVIEW_FINDINGS\n${JSON.stringify(value)}\nEND_REVIEW_FINDINGS`;
const report = (findings: unknown[] = [finding], questions: unknown[] = [question]): string => wire({ schemaVersion: 1, summary: "Simulated reviewer: blank-input behavior needs a product choice.", findings, questions });
const result = (text: string): StepResult => ({ ok: true, subtype: "success", text, fullText: text, assistantText: text, cost: 0, turns: 1 });

function fixture(): { repo: string; head: () => string; git: (...args: string[]) => string; cleanup: () => void } {
	const repo = mkdtempSync(join(tmpdir(), "pelaggio-assessment-"));
	const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_DATE: now, GIT_COMMITTER_DATE: now } }).trim();
	git("init", "-b", "main");
	git("config", "user.name", "Simulated operator");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "commit.gpgsign", "false");
	writeFileSync(join(repo, ".gitignore"), ".dev/\n");
	writeFileSync(join(repo, "requirements.md"), task.request);
	writeFileSync(join(repo, "label.mjs"), "export const label = value => value.trim();\n");
	writeFileSync(join(repo, "check.mjs"), "import assert from 'node:assert/strict'; import {label} from './label.mjs'; assert.equal(label(' '), 'Untitled'); console.log('blank-input fallback checked');\n");
	writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "simulated-review-loop", private: true, scripts: { "check:label": "node check.mjs" } }));
	git("add", ".");
	git("commit", "-m", "Simulated initial implementation");
	return { repo, git, head: () => git("rev-parse", "HEAD"), cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

describe("PR assessment qualifications", () => {
	it("refuses CI and pipeline mutations before loading task context", async () => {
		for (const env of [{ CI: "true" }, { PELAGGIO_SINGLE_SHOT: "1" }]) {
			await assert.rejects(
				reviewAssessmentMain(["answer", "--pr", "900", "--item", "782", "--sha", "a".repeat(40)], {
					env,
					task: async () => {
						assert.fail("must refuse before roadmap access");
					},
				}),
				/outside CI\/pipeline seats; existing records preserved/,
			);
		}
	});
	it("round-trips task identity regardless of caller property order", () => {
		const f = fixture();
		try {
			const reordered = makeAssessmentTask({ request: task.request, source: task.source, prNumber: task.prNumber, itemId: task.itemId });
			assert.deepEqual(reordered, task);
			const record = buildAssessment(loadAssessmentInput(f.repo, f.repo, reordered, f.head()), [], "pass", now);
			assert.deepEqual(readAssessmentFile(writeAssessmentRecord(f.repo, record)), record);
		} finally {
			f.cleanup();
		}
	});
	it("distinguishes genuine absent paths from missing Git trees and blobs", () => {
		const f = fixture();
		try {
			mkdirSync(join(f.repo, "nested"));
			writeFileSync(join(f.repo, "nested", "policy.md"), "policy");
			f.git("add", ".");
			f.git("commit", "-m", "nested scope");
			const sha = f.head();
			assert.deepEqual(questionPathObjects(f.repo, sha, ["missing", "nested/missing", "label.mjs/child"]), { missing: null, "nested/missing": null, "label.mjs/child": null });
			assert.equal(questionPathObjects(f.repo, sha, ["nested/policy.md"])["nested/policy.md"], f.git("rev-parse", `${sha}:nested/policy.md`));
			const scopedReport = parseReviewFindings(report([], [{ ...question, paths: ["nested/missing"] }]));
			const initial = buildAssessment(loadAssessmentInput(f.repo, f.repo, task, sha), [{ actor: "reviewer", iteration: 1, report: scopedReport, dispositions: [] }], "pass", now);
			writeAssessmentRecord(f.repo, initial);
			assert.ok(initial.questions[0]);
			answerAssessmentQuestion({ mainRepo: f.repo, repo: f.repo, task, headSha: sha, assessmentId: initial.id, questionId: initial.questions[0].id, actor: "operator", response: "Keep absent", supersedes: [], now });
			assert.equal(loadAssessmentInput(f.repo, f.repo, task, sha).answers[0]?.state, "applicable");
			const blob = f.git("rev-parse", `${sha}:nested/policy.md`);
			rmSync(join(f.repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
			assert.throws(() => questionPathObjects(f.repo, sha, ["nested/policy.md"]));
			const tree = f.git("rev-parse", `${sha}:nested`);
			rmSync(join(f.repo, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
			assert.throws(() => questionPathObjects(f.repo, sha, ["nested/missing"]));
			assert.equal(loadAssessmentInput(f.repo, f.repo, task, sha).answers[0]?.state, "unavailable");
		} finally {
			f.cleanup();
		}
	});
	it("projects only canonical code paths into a typed SARIF result", () => {
		const input = { originalTask: task, task, headSha: "a".repeat(40), answers: [], questions: [], checks: [], supersedes: [], diagnostics: [] };
		const paths = ["src/a b.ts", "/absolute", "./relative", "a//b", "a/../b", "a\\b", "bad\0path"];
		const record = buildAssessment(
			input,
			[
				{
					actor: "reviewer",
					iteration: 1,
					report: parseReviewFindings(
						report(
							paths.map((path) => ({ ...finding, path })),
							[],
						),
					),
					dispositions: [],
				},
			],
			"block",
			now,
		);
		const sarif = assessmentSarif(record);
		assert.deepEqual(
			sarif.runs.flatMap((run) => run.results.map((r) => r.locations[0]?.physicalLocation.artifactLocation.uri)),
			["src/a%20b.ts"],
		);
	});
	it("retains legacy reports and keeps optional explanation outside gate and fingerprint authority", () => {
		const legacy = parseReviewFindings(wire({ schemaVersion: 1, summary: "Legacy review", findings: [finding] }));
		const changed = parseReviewFindings(report([{ ...finding, qualification: { inventedTruth: "pass" } }], [{ bad: true }]));
		assert.equal(reviewFindingsGate(legacy), "block");
		assert.equal(reviewFindingsGate(changed), "block");
		assert.ok(legacy.findings[0]);
		assert.ok(changed.findings[0]);
		assert.equal(reviewFindingFingerprint(legacy.findings[0]), reviewFindingFingerprint(changed.findings[0]));
		assert.equal(changed.contentsUnavailable, true);
		assert.equal(reviewFindingsGate(parseReviewFindings(report([], [question]))), "pass", "a question is not a blocker");
		assert.equal(reviewFindingsGate(parseReviewFindings(report([], []))), "pass");
	});
	it("renders unavailable and stale checks distinctly and bounds passing execution to its actual scope", () => {
		const f = fixture();
		try {
			const input = loadAssessmentInput(f.repo, f.repo, task, f.head());
			const qualified = parseReviewFindings(report([{ ...finding, qualification: { ...finding.qualification, basis: "check", reference: "a".repeat(64) } }]));
			const build = () => buildAssessment(input, [{ actor: "simulated/reviewer", iteration: 1, report: qualified, dispositions: [] }], "block", now);
			assert.match(renderAssessment(build()), /Captured observation: unavailable/);
			input.checks.push({ id: "a".repeat(64), headSha: "b".repeat(40), command: ["node", "check.mjs"], scope: "blank input only", exitCode: 0, output: "pass" });
			assert.match(renderAssessment(build()), /Captured observation: stale/);
			assert.ok(input.checks[0]);
			input.checks[0].headSha = f.head();
			assert.match(renderAssessment(build()), /Captured observation: passed/);
			assert.match(renderAssessment(build()), /only what this check exercised/);
			assert.equal(build().gate, "block");
		} finally {
			f.cleanup();
		}
	});
});

describe("operator answer lifecycle", () => {
	it("detects concurrent conflicting answers, preserves changed-task history, and rejects altered record identity", () => {
		const f = fixture();
		try {
			const initial = buildAssessment(loadAssessmentInput(f.repo, f.repo, task, f.head()), [{ actor: "simulated", iteration: 1, report: parseReviewFindings(report()), dispositions: [] }], "block", now);
			writeAssessmentRecord(f.repo, initial);
			assert.ok(initial.questions[0]);
			const answer = answerAssessmentQuestion({ mainRepo: f.repo, repo: f.repo, task, headSha: f.head(), assessmentId: initial.id, questionId: initial.questions[0].id, actor: "operator", response: "Use Untitled", supersedes: [], now });
			const { id: _id, ...body } = answer;
			const concurrentBody = { ...body, response: "Use Blank" };
			writeAssessmentRecord(f.repo, { ...concurrentBody, id: assessmentDigest(concurrentBody) });
			const conflicted = loadAssessmentInput(f.repo, f.repo, task, f.head());
			assert.ok(conflicted.answers.every((entry) => entry.state === "conflicting"));
			assert.doesNotMatch(assessmentTaskPrompt(conflicted), /Use Untitled|Use Blank/);
			const changedTask = makeAssessmentTask({ itemId: task.itemId, prNumber: task.prNumber, source: task.source, request: "A revised product requirement" });
			const changed = loadAssessmentInput(f.repo, f.repo, changedTask, f.head());
			assert.equal(changed.originalTask.request, task.request);
			assert.equal(changed.task.request, changedTask.request);
			const invalidPath = writeAssessmentRecord(f.repo, { ...answer, response: "Altered without a new answer identity" });
			assert.ok(listAssessmentRecords(f.repo).diagnostics.length);
			rmSync(invalidPath);
			assert.equal(listAssessmentRecords(f.repo).diagnostics.length, 0, "valid controls remain admitted");
		} finally {
			f.cleanup();
		}
	});
	it("preserves original requests, scoped answers, supersession, omission and changed-context diagnostics", async () => {
		const f = fixture();
		try {
			const initial = buildAssessment(loadAssessmentInput(f.repo, f.repo, task, f.head()), [{ actor: "simulated", iteration: 1, report: parseReviewFindings(report()), dispositions: [] }], "block", now);
			writeAssessmentRecord(f.repo, initial);
			assert.ok(initial.questions[0]);
			const options = { mainRepo: f.repo, repo: f.repo, assessmentId: initial.id, questionId: initial.questions[0].id, headSha: f.head(), task, actor: "operator", response: "Use Untitled", supersedes: [] as string[], now };
			assert.throws(() => answerAssessmentQuestion({ ...options, questionId: "f".repeat(64) }), /does not belong/);
			assert.throws(() => answerAssessmentQuestion({ ...options, headSha: "f".repeat(40) }), /Stale/);
			const first = answerAssessmentQuestion(options);
			assert.throws(() => answerAssessmentQuestion({ ...options, response: "Use Blank" }), /Conflicting/);
			const second = answerAssessmentQuestion({ ...options, response: "Use Untitled consistently", supersedes: [first.id] });
			let input = loadAssessmentInput(f.repo, f.repo, task, f.head());
			assert.equal(input.answers.find((entry) => entry.answer.id === first.id)?.state, "superseded");
			assert.equal(input.answers.find((entry) => entry.answer.id === second.id)?.state, "applicable");
			writeFileSync(join(f.repo, "unrelated.txt"), "unrelated edit");
			f.git("add", ".");
			f.git("commit", "-m", "Unrelated edit");
			input = loadAssessmentInput(f.repo, f.repo, task, f.head());
			assert.equal(input.answers.find((entry) => entry.answer.id === second.id)?.state, "applicable");
			const next = buildAssessment(input, [{ actor: "simulated", iteration: 1, report: parseReviewFindings(report([], [])), dispositions: [] }], "pass", now);
			assert.equal(next.questions.length, 1, "omission cannot erase residuals");
			assert.equal(next.input.task.request, task.request);
			writeFileSync(join(f.repo, "requirements.md"), "Changed requirements");
			f.git("add", ".");
			f.git("commit", "-m", "Changed relevant path");
			assert.equal(loadAssessmentInput(f.repo, f.repo, task, f.head()).answers.find((entry) => entry.answer.id === second.id)?.state, "stale");
			assert.doesNotMatch(assessmentTaskPrompt(loadAssessmentInput(f.repo, f.repo, task, f.head())), /Use Untitled consistently/);
			assert.equal(listAssessmentRecords(f.repo).records.filter((entry) => entry.kind === "answer").length, 2);
		} finally {
			f.cleanup();
		}
	});
	it("exercises review → CLI answer → findings-driven worker → real configured check → cold reassessment", async () => {
		const f = fixture();
		try {
			const initialSha = f.head();
			const prompts: string[] = [];
			const driver = { model: undefined, codexModel: undefined, grokModel: undefined, openCodeModel: undefined, provider: "claude" as const, budget: 1, turns: 5, effort: "low" as const };
			const gateOptions = {
				pr: "900",
				itemId: "782",
				cwd: f.repo,
				diffCwd: f.repo,
				diffBaseRef: initialSha,
				reviewedSha: initialSha,
				diffHeadRef: initialSha,
				reviewDrivers: [driver],
				verifySettings: { ...driver, provider: "codex" as const },
				policy: { ...DEFAULTS.review, authoring: { ...DEFAULTS.review.authoring, reviewers: DEFAULTS.review.authoring.reviewers.map((s) => ({ ...s })), judge: { ...DEFAULTS.review.authoring.judge } }, maxPasses: 1, budgetCap: 10 },
				foreignRootDenial: { mainRepo: f.repo, registeredWorktrees: [] },
				assessmentMainRepo: f.repo,
				assessmentNow: () => now,
			};
			const initial = await runPrReviewGate({
				...gateOptions,
				assessmentInput: loadAssessmentInput(f.repo, f.repo, task, initialSha),
				runStep: async (step, prompt) => {
					prompts.push(prompt);
					return result(
						step === "pr-review"
							? report()
							: `REVIEW_VERIFICATION\n${JSON.stringify({ schemaVersion: 1, decisions: [{ candidateId: "C1", decision: "survives", rationale: "Simulated verifier: the blank value is still empty in label.mjs." }] })}\nEND_REVIEW_VERIFICATION`,
					);
				},
			});
			assert.equal(initial.gate, "block");
			assert.ok(initial.assessment);
			assert.ok(initial.assessment.questions[0]);
			const cliDeps = { env: {}, repo: f.repo, mainRepo: f.repo, task: async () => task, now: () => now, print: () => {} };
			assert.equal(
				await reviewAssessmentMain(
					["answer", "--pr", "900", "--item", "782", "--sha", initialSha, "--assessment", initial.assessment.id, "--question", initial.assessment.questions[0].id, "--by", "simulated operator", "--response", "Blank input must display Untitled."],
					cliDeps,
				),
				0,
			);
			const findingsPath = reviseFindingsPath(f.repo, "782");
			writeFileSync(findingsPath, initial.body);
			const worker = join(f.repo, "../", `${f.repo.split("/").at(-1)}-worker`);
			f.git("worktree", "add", "-b", "feat/issue-782-demo", worker);
			let workerPrompt = "";
			const intent = parseCli(["--resume", "782", "--review-findings", findingsPath]);
			assert.equal(intent.kind, "run");
			if (intent.kind !== "run") throw new Error("invalid fixture intent");
			const outcome = await runImplement(
				{ flags: intent.flags, mainRepo: f.repo, assignment: createDriverAssignmentState(1), itemId: "782", worktree: worker, profile: "standard", verdict: "APPROVE", shakedownPlanText: "" },
				{
					roadmap: {
						getItem: async () => ({ ...task, id: "782", title: "Usable labels", body: "Return a usable display label. Clarify blank-input behavior.", sourceRef: task.source, deps: "", status: "in-progress" }),
						getItemPlan: async () => null,
					} as unknown as RoadmapSource,
					available: () => true,
					log: () => {},
					finishFailed: (error) => ({ outcome: "failed", failureClass: "verification", itemId: "782", cost: 0, error }),
					parkExit: () => null,
					driverCandidates: () => [{ provider: "claude" }],
					cost: () => 0,
					runStepWithRetry: async (cfg) => {
						workerPrompt = cfg.buildPrompt(1, { lastLoopFile: null });
						assert.match(workerPrompt, /Blank input must display Untitled/);
						writeFileSync(join(worker, "label.mjs"), "export const label = value => value.trim() || 'Untitled';\n");
						execFileSync("git", ["add", "."], { cwd: worker });
						execFileSync("git", ["commit", "-m", "Simulated worker implements clarified fallback"], { cwd: worker, env: { ...process.env, GIT_AUTHOR_DATE: now, GIT_COMMITTER_DATE: now }, stdio: "pipe" });
						return { kind: "ok", result: result("Simulated worker applied the clarification.") };
					},
				},
			);
			assert.equal(outcome.kind, "continue");
			const revisedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worker, encoding: "utf8" }).trim();
			const checkCode = await reviewAssessmentMain(["check", "--pr", "900", "--item", "782", "--sha", revisedSha, "--script", "check:label", "--scope", "blank-input fallback only"], { ...cliDeps, repo: worker });
			assert.equal(checkCode, 0);
			const nextInput = loadAssessmentInput(f.repo, worker, task, revisedSha);
			assert.ok(nextInput.answers[0]);
			assert.equal(nextInput.answers[0].state, "applicable");
			const check = nextInput.checks[0];
			assert.ok(check);
			assert.equal(check.exitCode, 0);
			const withheldPrompts: string[] = [];
			const withheld = await runPrReviewGate({
				...gateOptions,
				reviewedSha: nextInput.headSha,
				diffHeadRef: nextInput.headSha,
				reviewDrivers: [{ ...driver, provider: "grok" }],
				assessmentMainRepo: undefined,
				assessmentInput: nextInput,
				runStep: async (_step, prompt) => {
					withheldPrompts.push(prompt);
					return result(report([], []));
				},
			});
			assert.equal(withheld.gate, "pass", "withholding context does not introduce a new blocking gate");
			assert.deepEqual(withheld.assessment?.input.answers, []);
			assert.doesNotMatch(JSON.stringify(withheld.assessment), /Blank input must display Untitled/);
			assert.doesNotMatch(withheldPrompts.join("\n"), /Blank input must display Untitled/);
			assert.match(renderAssessment(withheld.assessment!), /withheld for an untrusted provider pool/);
			assert.equal(nextInput.answers[0]?.state, "applicable", "caller snapshot remains intact");
			const next = await runPrReviewGate({
				...gateOptions,
				diffCwd: worker,
				diffHeadRef: revisedSha,
				reviewedSha: revisedSha,
				assessmentInput: nextInput,
				runStep: async (_step, prompt) => {
					assert.match(prompt, /Blank input must display Untitled/);
					assert.doesNotMatch(prompt, /Simulated verifier:|Simulated reviewer:|blocker retained/);
					return result(
						wire({
							schemaVersion: 1,
							summary: "Simulated reviewer: the chosen fallback is implemented; a narrow check passed.",
							findings: [
								{
									severity: "note",
									message: "Blank input now displays Untitled.",
									path: "label.mjs",
									line: 1,
									qualification: { basis: "check", reference: check.id, conclusion: "The fallback matches the operator's choice for blank input.", limitation: "Only blank input was executed; other values remain outside this check." },
								},
							],
							questions: [],
						}),
					);
				},
			});
			assert.equal(next.gate, "pass");
			assert.ok(next.assessment);
			assert.match(next.body, /Captured observation: passed/);
			assert.equal(next.assessment.questions.length, 1);
			const ajv = new Ajv({ strict: false, allErrors: true, unicodeRegExp: false });
			addFormats(ajv);
			const validate = ajv.compile(JSON.parse(readFileSync(new URL("./fixtures/review-assessment/sarif-schema-2.1.0.json", import.meta.url), "utf8")));
			assert.equal(validate(assessmentSarif(next.assessment)), true, JSON.stringify(validate.errors));
			assert.doesNotMatch(JSON.stringify(assessmentSarif(next.assessment)), /"rank"|"suppressions"/);
			f.git("worktree", "remove", worker);
			assert.ok(
				listAssessmentRecords(f.repo).records.some((entry) => entry.id === next.assessment?.id),
				"records survive worker cleanup and reader restart",
			);
			if (process.env.PELAGGIO_ASSESSMENT_EXAMPLE_DIR) {
				const out = process.env.PELAGGIO_ASSESSMENT_EXAMPLE_DIR;
				writeFileSync(join(out, "assessment.json"), JSON.stringify({ digest: assessmentDigest(next.assessment), record: next.assessment }, null, 2));
				writeFileSync(join(out, "assessment.md"), `${renderAssessment(next.assessment)}\n`);
				writeFileSync(join(out, "assessment.sarif.json"), `${JSON.stringify(assessmentSarif(next.assessment), null, 2)}\n`);
				writeFileSync(
					join(out, "handoff.json"),
					JSON.stringify(
						{
							simulation: "Reviewer, verifier, worker and operator are fixture-authored; git changes and configured check actually execute.",
							providerSmoke: "See separate provider-smoke.json; this scenario uses simulated seats.",
							originalTask: task,
							initial: initial.assessment,
							workerPromptDisplay: workerPrompt
								.replaceAll(worker, "<worker-worktree>")
								.replaceAll(f.repo, "<main-repo>")
								.replaceAll(process.env.PELAGGIO_REPO ?? process.cwd(), "<harness-repo>"),
							pathNormalization: "Temporary absolute paths in workerPromptDisplay are replaced for reproducible sharing; tests inspect the actual worker prompt.",
							reassessment: next.assessment,
						},
						null,
						2,
					),
				);
			}
		} finally {
			f.cleanup();
		}
	});
});
