import { encodeJsonStdout } from "./transport.js";
import type { Problem, RunSnapshot } from "./types.js";
import { PROTOCOL_PROBLEM_TYPES } from "./types.js";

export function presentJson(value: RunSnapshot | Problem): string {
	return encodeJsonStdout(value);
}

export function presentHuman(snapshot: RunSnapshot): string {
	const lines = [`run ${snapshot.runId}`, `state ${snapshot.state}${snapshot.disposition ? ` disposition ${snapshot.disposition}` : ""}`, `task ${snapshot.workContract.title}`];
	if (snapshot.worktree) lines.push(`worktree ${snapshot.worktree.branch}${snapshot.worktree.path ? ` @ ${snapshot.worktree.path}` : ""}`);
	if (snapshot.pauseReason) lines.push(`paused ${snapshot.pauseReason.code}: ${snapshot.pauseReason.message}`);
	for (const problem of snapshot.problems) lines.push(`problem ${problem.type}/${problem.code}: ${problem.message}`);
	if (snapshot.metrics) {
		lines.push(`duration ${snapshot.metrics.durationMs}ms`);
	}
	return `${lines.join("\n")}\n`;
}

export function presentProblemHuman(problem: Problem): string {
	return `${problem.type}/${problem.code}: ${problem.message}\n`;
}

export function exitCodeFor(snapshot: RunSnapshot): number {
	if (snapshot.state === "paused") return snapshot.pauseReason?.code === "interrupted" ? 130 : 0;
	if (snapshot.state !== "completed") return 0;
	if (snapshot.disposition === "ready_for_review" || snapshot.disposition === "cancelled") return 0;
	return 1;
}

export function exitCodeForProblem(problem: Problem): number {
	return PROTOCOL_PROBLEM_TYPES.has(problem.type) ? 2 : 1;
}
