import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { REPO } from "./config.js";
import { mainWorktree } from "./git.js";
import { type AssessmentTask, assessmentDigest, assessmentSarif, type CapturedReviewCheck, renderAssessment } from "./review/assessment.js";
import { prepareAssessmentInput } from "./review/assessment-context.js";
import { answerAssessmentQuestion, readAssessmentFile, writeAssessmentRecord } from "./review/assessment-store.js";

export interface ReviewAssessmentCliDeps {
	env: NodeJS.ProcessEnv;
	repo: string;
	mainRepo: string;
	task: (pr: number, item: string, sha: string) => Promise<AssessmentTask>;
	now: () => string;
	print: (text: string) => void;
}

const USAGE =
	"pelaggio review-assessment <show|sarif|answer|check> [--file <record.json>] [--pr <n> --item <id> --sha <full-sha>] [--assessment <id> --question <id> --by <actor> --response <text> --supersedes <id,id>] [--script <package-script> --scope <exercised behavior>]";

export async function reviewAssessmentMain(argv: string[], overrides: Partial<ReviewAssessmentCliDeps> = {}): Promise<number> {
	const deps: ReviewAssessmentCliDeps = {
		env: process.env,
		repo: REPO,
		mainRepo: mainWorktree(REPO),
		task: async (pr, item, sha) => (await prepareAssessmentInput(overrides.repo ?? REPO, pr, item, sha)).task,
		now: () => new Date().toISOString(),
		print: console.log,
		...overrides,
	};
	const [command, ...args] = argv;
	const parsed = parseArgs({
		args,
		options: Object.fromEntries(["file", "pr", "item", "sha", "assessment", "question", "by", "response", "supersedes", "script", "scope"].map((name) => [name, { type: "string" as const }])),
		allowPositionals: false,
		tokens: true,
	});
	const names = parsed.tokens.filter((token) => token.kind === "option").map((token) => token.name);
	if (new Set(names).size !== names.length) throw new Error("Duplicate arguments; state preserved.");
	const v = parsed.values as Record<string, string | undefined>;
	if (command === "show" || command === "sarif") {
		if (!v.file || names.some((name) => name !== "file")) throw new Error(USAGE);
		const record = readAssessmentFile(resolve(v.file));
		if (record.kind !== "assessment") throw new Error("Expected assessment record");
		deps.print(command === "show" ? renderAssessment(record) : JSON.stringify(assessmentSarif(record), null, 2));
		return 0;
	}
	if (command !== "answer" && command !== "check") throw new Error(USAGE);
	if (!v.pr || !/^[1-9]\d*$/.test(v.pr) || !v.item?.trim() || !v.sha || !/^[a-f0-9]{40}$/.test(v.sha)) throw new Error(USAGE);
	if (deps.env.CI === "true" || deps.env.PELAGGIO_SINGLE_SHOT) throw new Error("Use the attended host-operator command outside CI/pipeline seats; existing records preserved.");
	const task = await deps.task(Number(v.pr), v.item, v.sha);
	if (task.itemId !== v.item || task.prNumber !== Number(v.pr)) throw new Error("Task binding mismatch; state preserved.");
	if (command === "answer") {
		if (!v.assessment || !v.question || !v.by || !v.response || v.file || v.script || v.scope) throw new Error(USAGE);
		const answer = answerAssessmentQuestion({
			mainRepo: deps.mainRepo,
			repo: deps.repo,
			assessmentId: v.assessment,
			questionId: v.question,
			headSha: v.sha,
			task,
			actor: v.by,
			response: v.response,
			supersedes: v.supersedes?.split(",") ?? [],
			now: deps.now(),
		});
		deps.print(`Recorded clarification ${answer.id} for PR #${task.prNumber}, question ${answer.question.id}. Scope: work-item. No permission, disposition, status or merge changed.`);
		return 0;
	}
	if (!v.script || !v.scope || v.file || v.assessment || v.question || v.by || v.response || v.supersedes) throw new Error(USAGE);
	const git = (args: string[]): string => execFileSync("git", args, { cwd: deps.repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const cleanBinding = (): boolean => git(["rev-parse", "HEAD"]) === v.sha && git(["status", "--porcelain", "--untracked-files=all"]) === "";
	if (!cleanBinding()) throw new Error("Check capture requires the requested clean revision; work preserved. Commit the intended check inputs and retry.");
	const manifest: unknown = JSON.parse(readFileSync(resolve(deps.repo, "package.json"), "utf8"));
	if (!manifest || typeof manifest !== "object" || !("scripts" in manifest) || !manifest.scripts || typeof manifest.scripts !== "object" || !Object.hasOwn(manifest.scripts, v.script))
		throw new Error("Check must name a configured package script.");
	const commandArgv = ["pnpm", "--silent", "run", v.script] as const;
	const result = spawnSync(commandArgv[0], commandArgv.slice(1), { cwd: deps.repo, encoding: "utf8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
	const checkBody = { headSha: v.sha, command: [...commandArgv], scope: v.scope, exitCode: cleanBinding() ? result.status : null, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
	const check: CapturedReviewCheck = { id: assessmentDigest(checkBody), ...checkBody };
	writeAssessmentRecord(deps.mainRepo, { schemaVersion: 1, kind: "check", id: check.id, task, check });
	deps.print(`Captured check ${check.id}: ${check.exitCode === null ? "unavailable (execution or revision binding changed)" : `exit ${check.exitCode}`}. Scope: ${check.scope}. Re-run PR review to assess it.`);
	return check.exitCode === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	reviewAssessmentMain(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
}
