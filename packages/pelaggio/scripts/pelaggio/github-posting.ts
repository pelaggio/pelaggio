import { type GhRunner, parseGhJson } from "./roadmap/github-issues.js";

interface CommentEntry {
	id: number;
	body: string;
	created_at?: string;
	createdAt?: string;
	user?: { login?: string } | null;
	author?: { login?: string } | null;
}

/**
 * The GitHub Actions gate identity in both API spellings: REST `user.login` (the `gh api`
 * comment endpoints the upsert path reads) reports "github-actions[bot]", while GraphQL
 * `author.login` (`gh pr view --json comments`, the read path) reports "github-actions".
 * Missing either spelling silently drops every CI-posted findings comment on that side.
 */
const TRUSTED_BOT_LOGINS = new Set(["github-actions", "github-actions[bot]"]);

/** Repository roles that carry write authority per `repos/{owner}/{repo}/collaborators/{login}/permission`. */
const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

/**
 * Per-runner trust caches, keyed by the GhRunner function itself. The injected runner IS the
 * test seam: production call sites share one module-level runner per process, so this is
 * effectively a per-process cache; each test-injected stub gets its own isolated cache with
 * no reset hook needed.
 */
interface TrustCache {
	/** Lowercased authenticated login; `null` = lookup failed (that layer stays closed). Resolved at most once. */
	selfLogin?: string | null;
	/** `${repo}\n${login}` (lowercased) → trusted. Verdicts — including fail-closed ones — are cached: one permission call per login per process. */
	permissionTrusted: Map<string, boolean>;
}
const trustCaches = new WeakMap<GhRunner, TrustCache>();

function trustCacheFor(gh: GhRunner): TrustCache {
	let cache = trustCaches.get(gh);
	if (!cache) {
		cache = { permissionTrusted: new Map() };
		trustCaches.set(gh, cache);
	}
	return cache;
}

/** Fail-closed write-permission probe: read/none/404/API error/unparseable output → untrusted. */
function hasVerifiedWritePermission(gh: GhRunner, ghRepo: string, login: string): boolean {
	const out = runGhSoft(gh, ["api", `repos/${ghRepo}/collaborators/${encodeURIComponent(login)}/permission`]);
	if (out === null) return false;
	try {
		const parsed = parseGhJson<{ permission?: unknown }>(out, (value) => typeof value === "object" && value !== null && !Array.isArray(value));
		return typeof parsed.permission === "string" && WRITE_PERMISSIONS.has(parsed.permission.toLowerCase());
	} catch {
		return false;
	}
}

/** Marker that identifies the harness-owned PR review comment (upserted, never duplicated). */
export const PR_REVIEW_MARKER = "<!-- pelaggio-pr-review -->";

/**
 * Canonical author-trust rule for marker comments — ONE rule at every consumption site:
 * the read side (`fetchReviewFindings` in `revise-sweep.ts`), the write side
 * (`upsertMarkerComment`), the existence probe (`hasMarkerComment`), and the CI workflow's
 * findings selection (`.github/workflows/pr-review-revise.yml` via
 * `ci/fetch-review-findings.ts`). Marker text is not authority — any PR participant can copy
 * it into a comment — and neither are association labels: on an org-owned repo the operator's
 * own gate comments carry MEMBER, and a read-only org member carries MEMBER too, so the label
 * neither includes the real gate identity nor proves write authority (#508). Trust is verified
 * AUTHORITY instead, layered cheapest-first, fail-closed:
 *   1. Bot identity: the GitHub Actions gate login, both API spellings — zero API calls.
 *   2. Authenticated self: the comment author is the CURRENT `gh` identity (`gh api user`),
 *      resolved once per process — covers local mode recognizing its own comments.
 *   3. Verified repository permission: admin/maintain/write via the collaborator-permission
 *      API, one call per login per process — covers other maintainers; anything else
 *      (read, none, 404, API error) stays untrusted.
 * Logins are compared case-insensitively (GitHub logins are case-insensitive); a missing
 * login fails closed with no API traffic.
 */
export function isTrustedCommentAuthor(gh: GhRunner, ghRepo: string, login: string | null | undefined): boolean {
	if (!login) return false;
	const normalized = login.toLowerCase();
	if (TRUSTED_BOT_LOGINS.has(normalized)) return true;
	const cache = trustCacheFor(gh);
	if (cache.selfLogin === undefined) {
		const self = runGhSoft(gh, ["api", "user", "--jq", ".login"])?.trim().toLowerCase();
		cache.selfLogin = self || null;
	}
	if (cache.selfLogin !== null && normalized === cache.selfLogin) return true;
	const key = `${ghRepo.toLowerCase()}\n${normalized}`;
	let trusted = cache.permissionTrusted.get(key);
	if (trusted === undefined) {
		trusted = hasVerifiedWritePermission(gh, ghRepo, login);
		cache.permissionTrusted.set(key, trusted);
	}
	return trusted;
}

const isTrustedEntry = (gh: GhRunner, ghRepo: string, comment: CommentEntry): boolean => isTrustedCommentAuthor(gh, ghRepo, (comment.user ?? comment.author)?.login);

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
	const existing = latestMarkerComment(comments, marker, (comment) => isTrustedEntry(gh, ghRepo, comment));
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
		return latestMarkerComment(comments, marker, (comment) => isTrustedEntry(gh, ghRepo, comment)) !== null;
	} catch {
		return null;
	}
}
