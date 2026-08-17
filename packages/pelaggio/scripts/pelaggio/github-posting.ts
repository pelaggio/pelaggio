import { type GhRunner, parseGhJson } from "./roadmap/github-issues.js";

interface CommentEntry {
	id: number;
	body: string;
	created_at?: string;
	createdAt?: string;
	author_association?: string;
	authorAssociation?: string;
	user?: { login?: string } | null;
	author?: { login?: string } | null;
}

/**
 * Associations whose comments the review loop treats as authoritative, on both directions of
 * the seam. OWNER only: MEMBER and COLLABORATOR are relationship labels, not proof of write
 * authority — a read-only organization member or triage-level collaborator carries them and
 * could forge the marker. No pelaggio surface posts gate comments under either association:
 * local mode posts as the operator's gh identity (OWNER of the repo it manages), CI posts as
 * the Actions bot. A multi-maintainer repo that ever needs wider human trust should verify
 * actual push permission (`gh api repos/{owner}/{repo}/collaborators/{login}/permission`)
 * instead of widening this set.
 */
const TRUSTED_COMMENT_ASSOCIATIONS = new Set(["OWNER"]);

/**
 * The GitHub Actions gate identity in both API spellings: REST `user.login` (the `gh api`
 * comment endpoints the upsert path reads) reports "github-actions[bot]", while GraphQL
 * `author.login` (`gh pr view --json comments`, the read path) reports "github-actions".
 * Missing either spelling silently drops every CI-posted findings comment on that side.
 */
const TRUSTED_BOT_LOGINS = new Set(["github-actions", "github-actions[bot]"]);

/**
 * Canonical author-trust rule for marker comments — ONE rule at every consumption site:
 * the read side (`fetchReviewFindings` in `revise-sweep.ts`), the write side
 * (`upsertMarkerComment`), the existence probe (`hasMarkerComment`), and the CI workflow's
 * findings selection (`.github/workflows/pr-review-revise.yml` via
 * `ci/fetch-review-findings.ts`). Marker text is not authority: any PR participant can copy
 * it into a comment, so only the repository owner and the GitHub Actions gate identity count.
 * Takes the raw fields so both API casings can call it (REST `author_association`/`user.login`,
 * GraphQL `authorAssociation`/`author.login`); a missing association fails closed to untrusted.
 */
export function isTrustedCommentAuthor(authorAssociation: string | undefined, login: string | null | undefined): boolean {
	if (authorAssociation !== undefined && TRUSTED_COMMENT_ASSOCIATIONS.has(authorAssociation.toUpperCase())) return true;
	// GitHub's built-in Actions identity has authorAssociation=NONE even though the
	// workflow token is the authority that posts the CI review gate.
	return login != null && TRUSTED_BOT_LOGINS.has(login.toLowerCase());
}

const isTrustedEntry = (comment: CommentEntry): boolean => isTrustedCommentAuthor(comment.author_association ?? comment.authorAssociation, (comment.user ?? comment.author)?.login);

export function runGhSoft(gh: GhRunner, args: string[]): string | null {
	try {
		const result = gh(args);
		return result.status === 0 ? result.stdout : null;
	} catch {
		return null;
	}
}

function latestMarkerComment(comments: readonly CommentEntry[], marker: string, eligible: (comment: CommentEntry) => boolean = () => true): CommentEntry | null {
	const matches = comments.filter((comment) => comment.body.includes(marker) && eligible(comment));
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
	// Same author-trust rule as the read side: PATCH only the newest marker comment from a
	// trusted author. An untrusted participant can copy the marker into a newer comment; patching
	// it would hand them the body every later upsert edits and the read side would either consume
	// a hijacked comment or park on a stale trusted one. When no trusted comment bears the marker,
	// POST a fresh one — never touch the untrusted copy. The fresh comment is then the newest
	// trusted one, which is exactly what `fetchReviewFindings` selects, so the pair converges.
	const existing = latestMarkerComment(comments, marker, isTrustedEntry);
	const args = existing ? ["api", "--method", "PATCH", `repos/${ghRepo}/issues/comments/${existing.id}`, "-f", `body=${body}`] : ["api", "--method", "POST", `repos/${ghRepo}/issues/${issueNumber}/comments`, "-f", `body=${body}`];
	return runGhSoft(gh, args) !== null;
}

export function hasMarkerComment(gh: GhRunner, ghRepo: string, issueNumber: string | number, marker: string): boolean | null {
	const out = runGhSoft(gh, ["api", `repos/${ghRepo}/issues/${issueNumber}/comments`, "--paginate"]);
	if (out === null) return null;
	try {
		const comments = parseGhJson<CommentEntry[]>(out, (value) => Array.isArray(value));
		// Same author-trust rule as the read and upsert sides. This only gates an informational
		// once-only diagnostic, but an untrusted participant copying the marker must not be able
		// to suppress it — and the one-rule claim has to be true at every consumption site.
		return latestMarkerComment(comments, marker, isTrustedEntry) !== null;
	} catch {
		return null;
	}
}
