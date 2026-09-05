import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeJsonAtomically } from "../record-store.js";
import { registerPath } from "../registers.js";
import { type AssessmentInput, type AssessmentQuestion, type AssessmentTask, assessmentDigest, buildAssessment, type CapturedReviewCheck, makeAssessmentTask, type OperatorAnswer, type PrAssessment } from "./assessment.js";
import { parseReviewFindings } from "./findings.js";
import { isAssessmentPath, parseQuestions } from "./qualification.js";

export type AssessmentRecord = PrAssessment | OperatorAnswer | { schemaVersion: 1; kind: "check"; id: string; check: CapturedReviewCheck; task: AssessmentTask };
const DIGEST = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;

export function assessmentRoot(mainRepo: string): string {
	return registerPath(mainRepo, "pr-review-assessments");
}

/** Each generation has its own filename; no shared read/modify/write document or pointer. */
export function writeAssessmentRecord(mainRepo: string, record: AssessmentRecord): string {
	const path = registerPath(mainRepo, "pr-review-assessments", `${record.kind}-${record.id}-${randomUUID()}.json`);
	writeJsonAtomically(path, { digest: assessmentDigest(record), record }, { mode: 0o600 });
	return path;
}

function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function validTask(value: unknown): value is AssessmentTask {
	return (
		object(value) &&
		typeof value.itemId === "string" &&
		typeof value.prNumber === "number" &&
		Number.isSafeInteger(value.prNumber) &&
		Number(value.prNumber) > 0 &&
		typeof value.source === "string" &&
		typeof value.request === "string" &&
		value.digest === makeAssessmentTask({ itemId: value.itemId, prNumber: value.prNumber, source: value.source, request: value.request }).digest
	);
}

function validQuestion(value: unknown): value is AssessmentQuestion {
	if (!object(value)) return false;
	try {
		parseQuestions([{ question: value.question, context: value.context, paths: value.paths }]);
	} catch {
		return false;
	}
	return (
		object(value) &&
		typeof value.id === "string" &&
		DIGEST.test(value.id) &&
		typeof value.assessmentId === "string" &&
		DIGEST.test(value.assessmentId) &&
		typeof value.headSha === "string" &&
		SHA.test(value.headSha) &&
		typeof value.question === "string" &&
		typeof value.context === "string" &&
		Array.isArray(value.paths) &&
		value.paths.every((p) => typeof p === "string")
	);
}

function validCheck(value: unknown): value is CapturedReviewCheck {
	if (!object(value)) return false;
	const { id, ...body } = value;
	if (id !== assessmentDigest(body)) return false;
	return (
		object(value) &&
		typeof value.id === "string" &&
		DIGEST.test(value.id) &&
		typeof value.headSha === "string" &&
		SHA.test(value.headSha) &&
		Array.isArray(value.command) &&
		value.command.every((v) => typeof v === "string") &&
		typeof value.scope === "string" &&
		(value.exitCode === null || Number.isInteger(value.exitCode)) &&
		typeof value.output === "string"
	);
}

function validAnswer(value: unknown): value is OperatorAnswer {
	if (!object(value)) return false;
	const { id, ...body } = value;
	if (id !== assessmentDigest(body)) return false;
	return (
		object(value) &&
		value.schemaVersion === 1 &&
		value.kind === "answer" &&
		typeof value.assessmentId === "string" &&
		DIGEST.test(value.assessmentId) &&
		typeof value.id === "string" &&
		DIGEST.test(value.id) &&
		validTask(value.task) &&
		validQuestion(value.question) &&
		typeof value.headSha === "string" &&
		SHA.test(value.headSha) &&
		object(value.pathObjects) &&
		assessmentDigest(Object.keys(value.pathObjects).sort()) === assessmentDigest([...value.question.paths].sort()) &&
		Object.values(value.pathObjects).every((v) => v === null || (typeof v === "string" && SHA.test(v))) &&
		typeof value.actor === "string" &&
		value.actor.trim().length > 0 &&
		typeof value.response === "string" &&
		value.response.trim().length > 0 &&
		value.scope === "work-item" &&
		Array.isArray(value.supersedes) &&
		value.supersedes.every((id) => typeof id === "string" && DIGEST.test(id)) &&
		typeof value.createdAt === "string"
	);
}

function validReport(value: unknown): boolean {
	if (!object(value)) return false;
	const { contentsUnavailable, ...wire } = value;
	if (contentsUnavailable !== undefined && contentsUnavailable !== true) return false;
	try {
		const parsed = parseReviewFindings(`REVIEW_FINDINGS\n${JSON.stringify(wire)}\nEND_REVIEW_FINDINGS`);
		return !parsed.contentsUnavailable;
	} catch {
		return false;
	}
}

function validStored(value: unknown): value is AssessmentRecord {
	if (!object(value) || value.schemaVersion !== 1 || typeof value.id !== "string" || !DIGEST.test(value.id)) return false;
	if (value.kind === "answer") return validAnswer(value);
	if (value.kind === "check") return validTask(value.task) && validCheck(value.check) && value.id === value.check.id;
	if (value.kind !== "assessment" || !object(value.input) || !validTask(value.input.task) || !validTask(value.input.originalTask) || typeof value.input.headSha !== "string" || !SHA.test(value.input.headSha)) return false;
	if (value.input.originalTask.itemId !== value.input.task.itemId || value.input.originalTask.prNumber !== value.input.task.prNumber) return false;
	if (!Array.isArray(value.questions) || !value.questions.every(validQuestion) || !Array.isArray(value.input.questions) || !value.input.questions.every(validQuestion)) return false;
	if (
		!Array.isArray(value.input.checks) ||
		!value.input.checks.every(validCheck) ||
		!Array.isArray(value.input.answers) ||
		!value.input.answers.every((entry) => object(entry) && validAnswer(entry.answer) && ["applicable", "stale", "conflicting", "superseded", "unavailable"].includes(String(entry.state)) && typeof entry.reason === "string")
	)
		return false;
	if (!Array.isArray(value.input.supersedes) || !value.input.supersedes.every((id) => typeof id === "string") || !Array.isArray(value.input.diagnostics) || !value.input.diagnostics.every((v) => typeof v === "string")) return false;
	return (
		typeof value.createdAt === "string" &&
		(value.gate === "pass" || value.gate === "block") &&
		Array.isArray(value.seats) &&
		value.seats.every(
			(seat) =>
				object(seat) &&
				typeof seat.actor === "string" &&
				Number.isInteger(seat.iteration) &&
				validReport(seat.report) &&
				Array.isArray(seat.dispositions) &&
				seat.dispositions.every(
					(entry) =>
						object(entry) &&
						typeof entry.id === "string" &&
						(entry.decision === "refuted" || entry.decision === "survives") &&
						typeof entry.rationale === "string" &&
						validReport({ schemaVersion: 1, summary: "Stored disposition", findings: [entry.finding] }),
				),
		)
	);
}

export function readAssessmentFile(path: string): AssessmentRecord {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!object(value) || !validStored(value.record) || value.digest !== assessmentDigest(value.record)) throw new Error("invalid assessment record");
	const record = value.record;
	if (record.kind === "assessment") {
		const rebuilt = buildAssessment(record.input, record.seats, record.gate, record.createdAt);
		if (rebuilt.id !== record.id || assessmentDigest(rebuilt.questions) !== assessmentDigest(record.questions)) throw new Error("invalid assessment identity or question lineage");
	}
	return record;
}

export function listAssessmentRecords(mainRepo: string): { records: AssessmentRecord[]; diagnostics: string[] } {
	const root = assessmentRoot(mainRepo);
	if (!existsSync(root)) return { records: [], diagnostics: [] };
	const records: AssessmentRecord[] = [];
	const diagnostics: string[] = [];
	for (const name of readdirSync(root).sort()) {
		if (!name.endsWith(".json")) continue;
		try {
			records.push(readAssessmentFile(registerPath(mainRepo, "pr-review-assessments", name)));
		} catch {
			diagnostics.push("A stored assessment record is unreadable or invalid; its contents were not admitted.");
		}
	}
	const unique = new Map<string, AssessmentRecord>();
	const conflicts = new Set<string>();
	for (const record of records) {
		const task = record.kind === "assessment" ? record.input.task : record.task;
		const key = `${record.kind}:${task.digest}:${record.id}`;
		const existing = unique.get(key);
		if (existing && assessmentDigest(existing) !== assessmentDigest(record)) conflicts.add(key);
		else unique.set(key, record);
	}
	for (const key of conflicts) {
		unique.delete(key);
		diagnostics.push("Conflicting stored identity was not admitted.");
	}
	const admitted = [...unique.values()];
	const invalidAnswers = new Set<string>();
	const answerRecords = admitted.filter((record): record is OperatorAnswer => record.kind === "answer");
	for (const answer of answerRecords) {
		const source = admitted.find((record): record is PrAssessment => record.kind === "assessment" && record.id === answer.assessmentId);
		if (
			!source ||
			source.input.task.prNumber !== answer.task.prNumber ||
			source.input.task.itemId !== answer.task.itemId ||
			source.input.task.digest !== answer.task.digest ||
			source.input.headSha !== answer.headSha ||
			!source.questions.some((question) => assessmentDigest(question) === assessmentDigest(answer.question))
		)
			invalidAnswers.add(answer.id);
		if (
			answer.supersedes.some((id) => id === answer.id || !answerRecords.some((prior) => prior.id === id && prior.task.prNumber === answer.task.prNumber && prior.task.itemId === answer.task.itemId && prior.question.id === answer.question.id))
		)
			invalidAnswers.add(answer.id);
	}
	// Invalid ancestors cannot authorize replacement descendants.
	let changed = true;
	while (changed) {
		changed = false;
		for (const answer of answerRecords)
			if (!invalidAnswers.has(answer.id) && answer.supersedes.some((id) => invalidAnswers.has(id))) {
				invalidAnswers.add(answer.id);
				changed = true;
			}
	}
	if (invalidAnswers.size) diagnostics.push("Stored answers with invalid source or supersession lineage were not admitted.");
	return { records: admitted.filter((record) => record.kind !== "answer" || !invalidAnswers.has(record.id)), diagnostics };
}

export function questionPathObjects(repo: string, headSha: string, paths: string[]): Record<string, string | null> {
	if (!SHA.test(headSha)) throw new Error("expected full revision SHA");
	const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const root = git("rev-parse", "--verify", `${headSha}^{tree}`).trim();
	const entries = paths.map((path): [string, string | null] => {
		if (!isAssessmentPath(path)) throw new Error("invalid relevant path");
		let tree = root;
		const parts = path.split("/");
		for (const [index, part] of parts.entries()) {
			// Successful traversal with no exact entry means absence. Git failures propagate as unavailable.
			const entry = git("ls-tree", "-z", tree)
				.split("\0")
				.find((line) => line.slice(line.indexOf("\t") + 1) === part);
			if (!entry) return [path, null];
			const match = /^[0-7]+ (blob|tree|commit) ([a-f0-9]{40})\t/.exec(entry);
			if (!match?.[2]) throw new Error("invalid tree entry");
			if (index === parts.length - 1) {
				// Gitlink targets need not exist in the superproject object database.
				if (match[1] !== "commit") git("cat-file", "-e", match[2]);
				return [path, match[2]];
			}
			if (match[1] !== "tree") return [path, null];
			tree = match[2];
		}
		throw new Error("invalid relevant path");
	});
	return Object.fromEntries(entries);
}

export function loadAssessmentInput(mainRepo: string, repo: string, task: AssessmentTask, headSha: string): AssessmentInput {
	const listed = listAssessmentRecords(mainRepo);
	const prior = listed.records.filter((record): record is PrAssessment => record.kind === "assessment" && record.input.task.prNumber === task.prNumber && record.input.task.itemId === task.itemId);
	const answers = listed.records.filter((record): record is OperatorAnswer => record.kind === "answer" && record.task.prNumber === task.prNumber && record.task.itemId === task.itemId);
	const superseded = new Set(answers.flatMap((answer) => answer.supersedes));
	const active = answers.filter((answer) => !superseded.has(answer.id));
	const roots = prior.filter((record) => record.input.supersedes.length === 0).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	return {
		task,
		originalTask: (roots[0] ?? prior[0])?.input.originalTask ?? task,
		headSha,
		answers: answers.map((answer) => {
			if (superseded.has(answer.id)) return { answer, state: "superseded", reason: "Replaced explicitly; original response retained." };
			if (active.filter((entry) => entry.question.id === answer.question.id).length > 1) return { answer, state: "conflicting", reason: "Multiple active answers; explicitly supersede every conflicting answer." };
			if (answer.task.digest !== task.digest) return { answer, state: "stale", reason: "Task requirements changed; rebind explicitly." };
			try {
				const unchanged = answer.question.paths.length ? assessmentDigest(questionPathObjects(repo, headSha, answer.question.paths)) === assessmentDigest(answer.pathObjects) : answer.headSha === headSha;
				return { answer, state: unchanged ? "applicable" : "stale", reason: unchanged ? "Task and declared relevant context match; no semantic-completeness claim." : "Relevant context changed; answer retained, explicit rebinding required." };
			} catch {
				return { answer, state: "unavailable", reason: "Relevant git context unavailable." };
			}
		}),
		questions: [...new Map(prior.flatMap((record) => record.questions).map((question) => [question.id, question])).values()],
		checks: listed.records.filter((record): record is Extract<AssessmentRecord, { kind: "check" }> => record.kind === "check" && record.task.digest === task.digest).map((record) => record.check),
		supersedes: prior.map((record) => record.id),
		diagnostics: listed.diagnostics,
	};
}

export function answerAssessmentQuestion(options: {
	mainRepo: string;
	repo: string;
	assessmentId: string;
	questionId: string;
	headSha: string;
	task: AssessmentTask;
	actor: string;
	response: string;
	supersedes: string[];
	now: string;
}): OperatorAnswer {
	const { records } = listAssessmentRecords(options.mainRepo);
	const source = records.find((record): record is PrAssessment => record.kind === "assessment" && record.id === options.assessmentId);
	const question = source?.questions.find((entry) => entry.id === options.questionId);
	if (!source || !question || source.input.task.prNumber !== options.task.prNumber || source.input.task.itemId !== options.task.itemId) throw new Error("Question does not belong to the supplied PR/item assessment; state preserved.");
	if (source.input.headSha !== options.headSha) throw new Error("Stale source binding: use an assessment of the requested revision; state preserved.");
	if (source.input.task.digest !== options.task.digest) throw new Error("Task changed since assessment; reassess before answering; state preserved.");
	if (!options.actor.trim() || !options.response.trim()) throw new Error("Actor and response are required.");
	const prior = records.filter((record): record is OperatorAnswer => record.kind === "answer" && record.task.prNumber === options.task.prNumber && record.task.itemId === options.task.itemId && record.question.id === question.id);
	const replaced = new Set(prior.flatMap((answer) => answer.supersedes));
	const current = prior.filter((answer) => !replaced.has(answer.id));
	if (options.supersedes.some((id) => !current.some((answer) => answer.id === id)) || current.some((answer) => !options.supersedes.includes(answer.id)))
		throw new Error("Conflicting or stale replacement: explicitly supersede all current answers; state preserved.");
	const body = {
		schemaVersion: 1 as const,
		kind: "answer" as const,
		assessmentId: source.id,
		task: options.task,
		question,
		headSha: options.headSha,
		pathObjects: questionPathObjects(options.repo, options.headSha, question.paths),
		actor: options.actor.trim(),
		response: options.response.trim(),
		scope: "work-item" as const,
		supersedes: [...new Set(options.supersedes)].sort(),
		createdAt: options.now,
	};
	const answer: OperatorAnswer = { ...body, id: assessmentDigest(body) };
	writeAssessmentRecord(options.mainRepo, answer);
	return answer;
}
