/**
 * Deterministic staleness heuristics (#217). Pure functions plus one injectable
 * git-log runner — never touches the network, never closes an item. High precision,
 * fail-open: no match means the item is left pickable. Three v1 signals:
 *
 * - `shipped-by-commit`  — a `git log main` subject completes the item id.
 * - `superseded-marker`  — the item body/title says it was done/superseded by a done sibling.
 * - `title-match-done`   — the item's title equals a done item's title (long enough to be safe).
 *
 * Richer heuristics (path/deliverable overlap, done-sibling body linkage) are deferred (#217 follow-up).
 */

import { execFileSync } from "node:child_process";
import { itemFingerprint, type StaleReason } from "./stale-quarantine.js";
import type { RoadmapItemStatus } from "./types.js";

export interface StaleHit {
	readonly id: string;
	readonly fingerprint: string;
	readonly reason: StaleReason;
	readonly evidence: readonly string[];
}

export interface StaleScanDeps {
	/** Return `git log main` as `"<sha> <subject>\n…"` (oneline). Injected in tests. */
	readonly gitLogMain: (repo: string, maxCommits: number) => string;
}

const DEFAULT_MAX_COMMITS = 2000;
const EVIDENCE_SNIPPET_MAX = 100;

function defaultGitLogMain(repo: string, maxCommits: number): string {
	try {
		return execFileSync("git", ["-C", repo, "log", "main", `-n${maxCommits}`, "--oneline", "--no-color"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch {
		// No `main` ref (fresh claim / CI) or git failure — fail open with no commits.
		return "";
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalize(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Strip a trailing parenthetical and/or a trailing issue-number suffix, then normalize. */
function normalizeTitle(title: string): string {
	const stripped = title
		.trim()
		.replace(/\s*\([^()]*\)\s*$/, "")
		.replace(/[\s:#-]*\d+\s*$/, "");
	return normalize(stripped);
}

function shippedCommitPatterns(id: string): RegExp[] {
	const esc = escapeRegExp(id);
	const patterns = [new RegExp(`\\b(?:closes?|fixes?|resolves?)\\s+#?${esc}\\b`, "i"), new RegExp(`\\(#${esc}\\)`, "i")];
	if (/^\d+$/.test(id)) {
		patterns.push(new RegExp(`\\bfeat/issue-${esc}\\b`, "i"), new RegExp(`\\bfeat/${esc}\\b`, "i"));
	}
	return patterns;
}

// A narrow `issue-N` mention only counts when the subject also reads like a completion, to
// avoid a passing reference ("touches issue-217 tangentially") tripping a quarantine.
const SHIP_VERB_RE = /\b(?:merge|ship|feat|fix|complete)\b/i;

function shippedByCommit(item: RoadmapItemStatus, commits: readonly { sha: string; subject: string; line: string }[]): string[] {
	const patterns = shippedCommitPatterns(item.id);
	const issueMention = new RegExp(`\\bissue[-/ ]${escapeRegExp(item.id)}\\b`, "i");
	const evidence: string[] = [];
	for (const { subject, line } of commits) {
		const hit = patterns.some((re) => re.test(subject)) || (issueMention.test(subject) && SHIP_VERB_RE.test(subject));
		if (hit) evidence.push(line.slice(0, EVIDENCE_SNIPPET_MAX));
	}
	return evidence;
}

// Body/title supersession: "done/superseded/implemented by #<id>" where <id> is a done sibling.
const SUPERSEDED_RE = /\b(?:superseded|implemented|already\s+done|done)\s+by\s+#?([A-Za-z]*-?\d[\w-]*)/gi;

function supersededMarker(item: RoadmapItemStatus, doneById: ReadonlyMap<string, string>): string[] | null {
	const text = `${item.title}\n${item.body ?? ""}`;
	for (const match of text.matchAll(SUPERSEDED_RE)) {
		const ref = match[1];
		if (!ref) continue;
		const canonical = doneById.get(normalize(ref));
		if (canonical) return [canonical, normalize(match[0] ?? "")];
	}
	return null;
}

/**
 * Scan open items for high-precision staleness signals. Only open items are considered;
 * done / blocked / in-progress items never hit. Returns at most one hit per item (first
 * signal in `shipped-by-commit` → `superseded-marker` → `title-match-done` order).
 */
export function scanStaleItems(items: readonly RoadmapItemStatus[], repo: string, deps?: Partial<StaleScanDeps> & { maxCommits?: number }): StaleHit[] {
	const open = items.filter((item) => item.status === "open");
	if (open.length === 0) return [];

	const done = items.filter((item) => item.status === "done");
	const doneById = new Map(done.map((item) => [normalize(item.id), item.id] as const));
	const doneTitles = new Map<string, string>();
	for (const item of done) {
		const norm = normalizeTitle(item.title);
		if (norm.length >= 12 && !doneTitles.has(norm)) doneTitles.set(norm, item.id);
	}

	const gitLogMain = deps?.gitLogMain ?? defaultGitLogMain;
	const commits = gitLogMain(repo, deps?.maxCommits ?? DEFAULT_MAX_COMMITS)
		.split("\n")
		.map((raw) => raw.trim())
		.filter(Boolean)
		.map((line) => {
			const space = line.indexOf(" ");
			return { sha: space < 0 ? line : line.slice(0, space), subject: space < 0 ? "" : line.slice(space + 1), line };
		});

	const hits: StaleHit[] = [];
	for (const item of open) {
		const commitEvidence = shippedByCommit(item, commits);
		if (commitEvidence.length > 0) {
			hits.push({ id: item.id, fingerprint: itemFingerprint(item), reason: "shipped-by-commit", evidence: commitEvidence });
			continue;
		}
		const superseded = supersededMarker(item, doneById);
		if (superseded) {
			hits.push({ id: item.id, fingerprint: itemFingerprint(item), reason: "superseded-marker", evidence: superseded });
			continue;
		}
		const normTitle = normalizeTitle(item.title);
		const doneSibling = normTitle.length >= 12 ? doneTitles.get(normTitle) : undefined;
		if (doneSibling && doneSibling !== item.id) {
			hits.push({ id: item.id, fingerprint: itemFingerprint(item), reason: "title-match-done", evidence: [doneSibling] });
		}
	}
	return hits;
}
