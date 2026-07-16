import { type GhRunner, parseGhJson } from "./roadmap/github-issues.js";

interface CommentEntry {
	id: number;
	body: string;
	created_at?: string;
	createdAt?: string;
}

export function runGhSoft(gh: GhRunner, args: string[]): string | null {
	try {
		const result = gh(args);
		return result.status === 0 ? result.stdout : null;
	} catch {
		return null;
	}
}

function latestMarkerComment(comments: readonly CommentEntry[], marker: string): CommentEntry | null {
	const matches = comments.filter((comment) => comment.body.includes(marker));
	if (matches.length === 0) return null;
	return matches.reduce((a, b) => ((b.created_at ?? b.createdAt ?? "").localeCompare(a.created_at ?? a.createdAt ?? "") > 0 ? b : a));
}

export function postCommitStatus(gh: GhRunner, ghRepo: string, sha: string, state: "pending" | "success" | "failure", context: string, description: string, targetUrl?: string): boolean {
	const args = ["api", `repos/${ghRepo}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${context}`, "-f", `description=${description}`];
	if (targetUrl) args.push("-f", `target_url=${targetUrl}`);
	return runGhSoft(gh, args) !== null;
}

export function upsertMarkerComment(gh: GhRunner, ghRepo: string, issueNumber: string | number, marker: string, body: string): boolean {
	const out = runGhSoft(gh, ["api", `repos/${ghRepo}/issues/${issueNumber}/comments`, "--paginate"]);
	if (out === null) return false;
	let comments: CommentEntry[];
	try {
		comments = parseGhJson<CommentEntry[]>(out, (value) => Array.isArray(value));
	} catch {
		return false;
	}
	const existing = latestMarkerComment(comments, marker);
	const args = existing ? ["api", "--method", "PATCH", `repos/${ghRepo}/issues/comments/${existing.id}`, "-f", `body=${body}`] : ["api", "--method", "POST", `repos/${ghRepo}/issues/${issueNumber}/comments`, "-f", `body=${body}`];
	return runGhSoft(gh, args) !== null;
}

export function hasMarkerComment(gh: GhRunner, ghRepo: string, issueNumber: string | number, marker: string): boolean | null {
	const out = runGhSoft(gh, ["api", `repos/${ghRepo}/issues/${issueNumber}/comments`, "--paginate"]);
	if (out === null) return null;
	try {
		const comments = parseGhJson<CommentEntry[]>(out, (value) => Array.isArray(value));
		return latestMarkerComment(comments, marker) !== null;
	} catch {
		return null;
	}
}
