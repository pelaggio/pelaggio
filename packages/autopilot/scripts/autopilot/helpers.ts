import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOG_PATH, REPO, STEPS, WORKTREE_PREFIX } from "./config.js";
import { MarkdownRoadmap } from "./roadmap/markdown.js";
import type { Mutex, Step } from "./types.js";

// ── Skill loading ──────────────────────────────────────────────────────

export function expandSkill(name: string, skillArgs?: string): string {
	const upper = resolve(REPO, ".claude", "skills", name, "SKILL.md");
	const lower = resolve(REPO, ".claude", "skills", name, "skill.md");
	const body = readFileSync(existsSync(upper) ? upper : lower, "utf-8")
		.replace(/^---[\s\S]*?---\n*/, "")
		.trim();
	return skillArgs ? `${body}\n\nArguments: ${skillArgs}` : body;
}

// ── Worktree utilities ─────────────────────────────────────────────────

export function resolveWorktree(itemId: string): string {
	return resolve(REPO, "..", `${WORKTREE_PREFIX}${itemId.toLowerCase()}`);
}

export function listWorktrees(): string[] {
	return execSync("git worktree list --porcelain", { cwd: REPO, encoding: "utf-8" })
		.split("\n")
		.filter((l) => l.startsWith("worktree "))
		.map((l) => l.slice(9).trim());
}

// ── Pick result parsing ────────────────────────────────────────────────

export type PickReason = "claimed" | "blocked" | "unknown-id" | "already-done" | "worktree-exists" | "already-claimed" | "queue-empty";

const PICK_REASONS: ReadonlySet<PickReason> = new Set(["claimed", "blocked", "unknown-id", "already-done", "worktree-exists", "already-claimed", "queue-empty"]);

/**
 * Parse a structured `pick-result: <tag>` trailing line from the /pick skill output.
 * Last occurrence wins so the skill can safely restate the tag in a summary
 * paragraph. Unknown tags → null. No tag present → null.
 */
export function parsePickResult(text: string): PickReason | null {
	const re = /^[ \t]*pick-result:[ \t]*([a-z-]+)[ \t]*$/gim;
	let last: string | null = null;
	for (const m of text.matchAll(re)) last = m[1].toLowerCase();
	if (last === null) return null;
	return PICK_REASONS.has(last as PickReason) ? (last as PickReason) : null;
}

/**
 * Parse a structured `pick-item: <ID>` line from the /pick skill output.
 * Last occurrence wins. Accepts IDs matching `[A-Z]+-?\d[\dA-Z-]*` — the
 * hyphens allow nested sub-items (`COMP-11C-II`). Malformed values → null.
 */
export function parsePickItem(text: string): string | null {
	const re = /^[ \t]*pick-item:[ \t]*([^\s][^\n]*?)[ \t]*$/gim;
	let last: string | null = null;
	for (const m of text.matchAll(re)) last = m[1];
	if (last === null) return null;
	return /^[A-Z]+-?\d[\dA-Z-]*$/.test(last) ? last : null;
}

// ── Plan file-count helpers (dynamic implement-turn budget) ────────────

function extractFilesSection(body: string): string | null {
	const headingRe = /^#{1,6}[ \t]+.*\bfiles\b.*$/im;
	const match = body.match(headingRe);
	if (!match) return null;
	const start = (match.index ?? 0) + match[0].length;
	const rest = body.slice(start);
	const nextHeading = rest.search(/^#{1,6}[ \t]+/m);
	return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
}

function parseTableFirstColumn(section: string): Set<string> {
	const files = new Set<string>();
	const lines = section.split("\n");
	let inTable = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line.startsWith("|")) {
			inTable = false;
			continue;
		}
		if (!inTable) {
			const next = (lines[i + 1] ?? "").trim();
			if (/^\|[\s\-:|]+\|$/.test(next)) {
				inTable = true;
				i++;
				continue;
			}
			continue;
		}
		const cells = line
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());
		if (cells.length === 0) continue;
		const first = cells[0].replace(/`/g, "").trim();
		if (first) files.add(first);
	}
	return files;
}

const PATH_EXT = /\b[\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|js|md|yml|yaml|json|sh|py)\b/g;

/**
 * Count distinct file paths in a plan body. Prefers the first-column values of
 * a markdown table under a heading containing "Files" (case-insensitive).
 * Falls back to path-shaped tokens in the prose, ignoring fenced code blocks
 * and plan self-references under `docs/plans/`.
 */
export function countPlanFiles(body: string): number {
	const section = extractFilesSection(body);
	if (section) {
		const fromTable = parseTableFirstColumn(section);
		if (fromTable.size > 0) return fromTable.size;
	}
	const stripped = body.replace(/```[\s\S]*?```/g, "");
	const files = new Set<string>();
	for (const m of stripped.match(PATH_EXT) ?? []) {
		if (m.startsWith("docs/plans/")) continue;
		files.add(m);
	}
	return files.size;
}

/**
 * Derive a per-cycle implement turn budget from the plan's file count:
 *   `clamp(2 × files + 60, 100, 250)`.
 * Falls back to the static `fallback` when the plan is absent or parses to zero
 * files (e.g. a `--resume` that starts at `implement` with no plan on disk).
 */
export function computeImplementTurns(planBody: string | null, fallback: number): number {
	if (!planBody) return fallback;
	const files = countPlanFiles(planBody);
	if (files === 0) return fallback;
	return Math.max(100, Math.min(250, 2 * files + 60));
}

// ── Refusal & error classification ─────────────────────────────────────

// Anchored refusal openers: a decline announces itself in the first sentence.
// Matching only at the start of the trimmed final result keeps a review that
// merely *discusses* a decline mid-paragraph ("the code can't be simplified")
// from tripping the heuristic.
const REFUSAL_OPENERS: readonly RegExp[] = [
	/^i can(?:'|no)?t (?:help|assist|comply|continue|provide|do)\b/i,
	/^i cannot (?:help|assist|comply|continue|provide|do)\b/i,
	/^i(?:'m| am) (?:not able|unable) to\b/i,
	/^i won'?t (?:be able|help|assist)\b/i,
	/^i must decline\b/i,
	/^i(?:'m| am) sorry,? but i (?:can(?:'|no)?t|cannot|won'?t)\b/i,
];

/** Conservative, anchored text heuristic: does the output *open* with a refusal? */
export function looksLikeRefusal(text: string): boolean {
	const head = text.trim().slice(0, 200);
	return REFUSAL_OPENERS.some((re) => re.test(head));
}

/**
 * Structured-first refusal classifier. A streaming safety decline surfaces as
 * `subtype: "success"` with `stop_reason: "refusal"` — trust that signal first.
 * A populated non-refusal `stop_reason` means the turn completed normally, so
 * don't second-guess it. Only fall back to the text heuristic when the SDK
 * surfaced no `stop_reason` at all.
 */
export function isRefusal(stopReason: string | null | undefined, resultText: string): boolean {
	if (stopReason === "refusal") return true;
	if (stopReason != null) return false;
	return looksLikeRefusal(resultText);
}

/**
 * Categorize a thrown SDK step error into a `subtype`. The authoritative
 * `parked` flag (set by the structured `rate_limit_event` handler) wins first;
 * remaining branches key off the message text. Deliberately does NOT match a
 * bare "rejected" — that word also appears in safety refusals, which must be
 * terminal (`error_sdk`), not parked forever as a phantom rate limit.
 */
export function classifyStepError(errMsg: string, parked: boolean): string {
	if (parked || /rate.?limit|usage.?limit|quota/i.test(errMsg)) return "error_rate_limit";
	if (/budget/i.test(errMsg)) return "error_budget";
	if (/abort/i.test(errMsg)) return "error_abort";
	if (/max.*turns|turn.?limit|maximum.*turns/i.test(errMsg)) return "error_max_turns";
	return "error_sdk";
}

// ── Retry budget decision ──────────────────────────────────────────────

/**
 * Whether a step that ended in `error_max_turns` may be re-entered once more with a
 * fresh turn budget (issue #33). The attempt-count bound is owned by the caller's loop;
 * this owns only the dollar gate: a retry is funded up to the step's configured budget
 * again, so skip it when too little remains. A non-finite `maxBudget` (unset / unparseable
 * `--budget`) disables the gate — the caller's attempt cap still bounds the retry.
 */
export function canRetryWithinBudget(args: { spent: number; maxBudget: number; stepBudget: number }): boolean {
	if (!Number.isFinite(args.maxBudget)) return true;
	return args.maxBudget - args.spent >= args.stepBudget;
}

// ── Verdict parsing ────────────────────────────────────────────────────

// Vocabulary a genuine rubric review uses. Presence of any term (in a
// substantial, non-refusal body) is what distinguishes a real review that
// merely omitted the verdict keyword from an empty/refused/truncated one.
const REVIEW_SIGNAL = /\b(?:rubric|verdict|fix[- ]?now|near[- ]?term|deferred|well-(?:typed|tested|factored)|idiomatic|idioms|concise|correctness|blocker)\b/i;

function reviewEngaged(text: string): boolean {
	const t = text.trim();
	if (t.length < 120) return false; // a real review is substantial
	if (looksLikeRefusal(t)) return false; // a decline is not engagement
	return REVIEW_SIGNAL.test(t);
}

export function parseVerdict(text: string): "APPROVE" | "REVISE" | "RETHINK" {
	const match = text.match(/verdict[:\s*]+\*{0,2}(APPROVE|REVISE|RETHINK)\b/i);
	if (match) return match[1].toUpperCase() as "APPROVE" | "REVISE" | "RETHINK";
	if (/\bRETHINK\b/i.test(text)) return "RETHINK";
	if (/\bREVISE\b/i.test(text)) return "REVISE";
	// No verdict keyword. Fail closed: an empty/refused/truncated shakedown must
	// not read as an implicit APPROVE and ship on a phantom sign-off. Return
	// RETHINK — the only verdict that HALTS the cycle (REVISE still proceeds to
	// implement+ship) — unless the output shows the review actually engaged with
	// the rubric, which preserves the historical APPROVE fail-safe for a genuine
	// review that merely omitted the keyword.
	return reviewEngaged(text) ? "APPROVE" : "RETHINK";
}

// ── PR-review merge-gate parsing ───────────────────────────────────────

/**
 * Parse the `/pr-review` gate verdict for the CI merge gate. Distinct from
 * `parseVerdict` on purpose: `parseVerdict` keeps an "engaged ⇒ APPROVE"
 * fail-**safe** so a genuine review that omitted the keyword still ships. A
 * *merge gate* must instead fail **closed to block** on any ambiguity — a
 * keyword-less-but-engaged review mapping to pass would let unattended runs
 * merge on a phantom sign-off.
 *
 * `ok` is the step-runner's success flag: a refusal / SDK error / max-turns /
 * rate-limit exit (`ok:false`) blocks unconditionally. On a successful run,
 * only an explicit `Verdict: PASS` passes; everything else (including
 * `Verdict: BLOCK` and no verdict at all) blocks.
 *
 * Last occurrence wins and the match is line-anchored (mirrors
 * `parsePickResult` / `parseBlockedReason`): the skill contract puts the
 * verdict on the trailing line, so a review that *quotes* `Verdict: PASS`
 * earlier in its body (e.g. when reviewing this gate's own docs) must not
 * shadow a final `Verdict: BLOCK` — first-match-wins here is a fail-open hole.
 */
export function parseReviewGate(text: string, ok: boolean): "pass" | "block" {
	if (!ok) return "block"; // refusal / SDK error / max_turns / rate-limit → fail closed
	const matches = [...text.matchAll(/^[ \t>*-]*\*{0,2}verdict[:\s*]+\*{0,2}(PASS|BLOCK)\b/gim)];
	const last = matches.at(-1);
	if (last) return last[1].toLowerCase() as "pass" | "block";
	return "block"; // no explicit `Verdict: PASS` ⇒ block (no engagement fail-safe)
}

// ── Blocked / stalled-ask parsing ──────────────────────────────────────

/**
 * A step that cannot finish ends its final message with a trailing sentinel line
 * `BLOCKED: <reason>` (see `AUTONOMY_APPEND`). Parsed out-of-band because the SDK
 * reports a polite stall as `subtype: "success"`. Trailing-line semantics (last
 * non-blank line must match) so a mid-text mention — "is this BLOCKED: no, …" —
 * followed by a normal finish is NOT a false positive. Bold markers tolerated,
 * matching `parseVerdict`. `BLOCKED` stays uppercase/case-sensitive so prose
 * ("the task is blocked") never matches. Returns the reason, or null when not blocked.
 */
export function parseBlockedReason(text: string): string | null {
	const lines = text.split("\n");
	let i = lines.length - 1;
	while (i >= 0 && lines[i].trim() === "") i--;
	if (i < 0) return null;
	const m = lines[i].match(/^\s*\*{0,2}BLOCKED:\*{0,2}\s*(.*\S)?\s*$/);
	if (!m) return null;
	return m[1]?.trim() || "(no reason given)";
}

// Offer-to-continue phrasings that read as a stall even without a trailing `?`.
const STALLED_ASK_PHRASING = /\b(want me to|shall i|should i|let me know|would you like|do you want)\b/i;

/**
 * Observe-only soft heuristic: a final message that ends in a question or an
 * offer-to-continue without the `BLOCKED:` sentinel. Never fails a step —
 * legitimate final messages can contain questions — it only feeds the
 * `stalled_ask` telemetry, so false positives are acceptable.
 */
export function looksLikeStalledAsk(text: string): boolean {
	const lines = text.split("\n");
	let i = lines.length - 1;
	while (i >= 0 && lines[i].trim() === "") i--;
	if (i < 0) return false;
	const last = lines[i].trim();
	return last.endsWith("?") || STALLED_ASK_PHRASING.test(last);
}

// ── Git checkpointing ──────────────────────────────────────────────────

export function checkpoint(cwd: string, label: string): boolean {
	try {
		execSync(`git add -A && git commit -m "wip: autopilot ${label}" --no-verify`, {
			cwd,
			encoding: "utf-8",
			stdio: "pipe",
		});
		return true;
	} catch (e: unknown) {
		const err = e as Record<string, unknown>;
		// git reports "nothing to commit" on stdout with stderr set to "" (not null),
		// so `stderr ?? stdout` short-circuits on the empty string — concatenate both
		// streams before classifying, or the empty-tree case logs a bogus warning.
		const streams = `${err.stderr ?? ""}${err.stdout ?? ""}`;
		const msg = (streams || String((e as Error).message ?? "")).slice(0, 300);
		if (/nothing to commit|clean/i.test(msg)) return false;
		process.stderr.write(`⚠ checkpoint commit failed: ${msg}\n`);
		return false;
	}
}

/** Verify worktree has no uncommitted changes; retry checkpoint once if dirty. */
export function ensureCheckpointed(cwd: string, label: string, log: (s: string) => void): void {
	const dirty = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
	if (!dirty) return;
	log(`⚠ worktree dirty after checkpoint — retrying (${dirty.split("\n").length} files)`);
	const ok = checkpoint(cwd, `${label} (retry)`);
	if (!ok) {
		const still = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
		if (still) log(`⚠ worktree still dirty after retry — ship may fail`);
	}
}

// ── Step-boundary diff ─────────────────────────────────────────────────

export function getHeadSha(cwd: string): string | null {
	try {
		return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch {
		return null;
	}
}

export function filesChangedSince(cwd: string, preSha: string | null): string[] {
	if (!preSha) return [];
	try {
		const out = execSync(`git diff --name-only ${preSha}..HEAD`, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (!out) return [];
		return out.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

// ── Ship pre-condition ─────────────────────────────────────────────────

/**
 * True iff the feat branch has at least one commit beyond main that touches
 * a file outside `docs/plans/`. Plan artifacts live at `docs/plans/<slug>.md`
 * and are produced by `/plan` — a branch that only touches those is the
 * ghost-ship case (plan-only, no implementation). Doc-only work like rubric
 * or skill-body edits is still deliverable. Returns false on any git error.
 */
export function hasDeliverableCommits(worktree: string): boolean {
	try {
		// Three-dot diff: compare merge-base(main, HEAD) to HEAD. This restricts
		// the file list to changes introduced on the feat branch. Two-dot
		// (main..HEAD) would also include files main advanced past while the
		// feat branch was dormant, which falsely credits the branch for work
		// it didn't do.
		const files = execSync("git diff --name-only main...HEAD", {
			cwd: worktree,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (!files) return false;
		return files.split("\n").some((f) => !f.startsWith("docs/plans/"));
	} catch {
		return false;
	}
}

// ── Ghost-ship verification ────────────────────────────────────────────

/**
 * Capture the state needed to verify a direct-push ship landed. Returns null
 * if either git command fails (e.g. no main branch). The caller (pipeline.ts)
 * fails the cycle closed on a null result for direct-push rather than shipping
 * blind — a repo that can't answer `rev-parse` is not shippable.
 */
export function captureShipState(mainRepo: string, worktree: string): { mainSha: string; featSha: string; branch: string } | null {
	try {
		const mainSha = execSync("git rev-parse main", { cwd: mainRepo, encoding: "utf-8" }).trim();
		const featSha = execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim();
		// The worktree is on the feature branch at capture time (pre-merge). The
		// pipeline-owned bookkeeping tail needs this name to clean up the branch
		// after the merge lands.
		const branch = execSync("git branch --show-current", { cwd: worktree, encoding: "utf-8" }).trim();
		return { mainSha, featSha, branch };
	} catch {
		return null;
	}
}

/**
 * Returns true if main advanced after a direct-push ship: either the sha
 * changed or the pre-ship feat tip is now reachable from main (fast-forward).
 * **Fails closed** — a git error during verification returns false, so the
 * merge is treated as *not* landed and routes to /shipwreck (which assesses the
 * real state) rather than to a blind push. Failing open here would classify a
 * ghost-ship-plus-git-error as merged and push it, defeating the very gate this
 * implements.
 */
export function verifyShipLanded(mainRepo: string, mainShaBefore: string, featShaBefore: string): boolean {
	try {
		const mainShaAfter = execSync("git rev-parse main", { cwd: mainRepo, encoding: "utf-8" }).trim();
		if (mainShaAfter !== mainShaBefore) return true;
		try {
			execSync(`git merge-base --is-ancestor ${featShaBefore} main`, { cwd: mainRepo, stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	} catch {
		return false;
	}
}

// ── Resume detection ───────────────────────────────────────────────────

export function detectResumeStep(itemId: string, worktree: string): Step {
	// Plan files live on the feature branch, so scan the worktree's tree — not main.
	const roadmap = new MarkdownRoadmap({ repo: worktree });

	if (existsSync(LOG_PATH)) {
		try {
			const lines = readFileSync(LOG_PATH, "utf-8").trim().split("\n").filter(Boolean);
			const entries = lines
				.map((l) => {
					try {
						return JSON.parse(l);
					} catch {
						return null;
					}
				})
				.filter((e): e is Record<string, unknown> => e != null && typeof e.item === "string" && (e.item as string).toUpperCase() === itemId.toUpperCase());
			if (entries.length > 0) {
				const last = entries[entries.length - 1];
				const steps = last.steps as Array<{ name: string; ok: boolean; verdict?: string }> | undefined;
				if (steps && steps.length > 0) {
					let lastOk = -1;
					for (let i = steps.length - 1; i >= 0; i--) {
						if (steps[i].ok) {
							lastOk = i;
							break;
						}
					}
					if (typeof last.error === "string" && (last.error as string).toLowerCase().includes("ship failed")) return "ship";
					const lastStep = steps[steps.length - 1];
					if (!lastStep.ok && lastStep.name === "implement") return "implement";
					if (lastStep.name === "shakedown-plan" && lastStep.verdict === "RETHINK") return "plan";
					if (lastOk >= 0) {
						const okStepName = steps[lastOk].name as Step;
						const idx = STEPS.indexOf(okStepName);
						if (idx >= 0 && idx < STEPS.length - 1) return STEPS[idx + 1];
						return "ship";
					}
				}
			}
		} catch {
			/* log parse failed — fall through to git heuristics */
		}
	}

	const branches = execSync("git branch --list 'feat/*'", { cwd: REPO, encoding: "utf-8" });
	const line = branches.split("\n").find((l) => l.toLowerCase().includes(itemId.toLowerCase()));
	const slug = (line?.replace(/^[*+]?\s*/, "").trim() ?? "").replace("feat/", "");

	if (!roadmap.findPlanFile(slug)) return "plan";

	try {
		const log = execSync("git log main..HEAD --oneline", { cwd: worktree, encoding: "utf-8" });
		if (
			log
				.trim()
				.split("\n")
				.filter((l) => l.trim()).length === 0
		)
			return "shakedown-plan";
	} catch {
		/* empty */
	}

	return "shakedown-code";
}

// ── Logging ────────────────────────────────────────────────────────────

export function appendLog(entry: Record<string, unknown>): void {
	mkdirSync(resolve(REPO, ".dev"), { recursive: true });
	appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
}

// ── Step index ─────────────────────────────────────────────────────────

export function stepIndex(s: Step): number {
	return STEPS.indexOf(s);
}

// ── Reset time parsing ────────────────────────────────────────────────

/** Parse "resets 4pm (America/Edmonton)" from an error message into a Unix-ms timestamp. */
export function parseResetTime(msg: string): number {
	const m = msg.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
	if (!m) return 0;

	let hours = parseInt(m[1], 10);
	const minutes = parseInt(m[2] ?? "0", 10);
	const period = m[3].toLowerCase();
	const tz = m[4];

	if (period === "pm" && hours !== 12) hours += 12;
	if (period === "am" && hours === 12) hours = 0;

	try {
		const now = new Date();
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(now);

		const y = parseInt(parts.find((p) => p.type === "year")!.value, 10);
		const mo = parseInt(parts.find((p) => p.type === "month")!.value, 10) - 1;
		const d = parseInt(parts.find((p) => p.type === "day")!.value, 10);

		// Compute tz offset via reference-point comparison
		const utcRef = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
		const tzRef = new Date(now.toLocaleString("en-US", { timeZone: tz }));
		const offsetMs = tzRef.getTime() - utcRef.getTime();

		const resetMs = Date.UTC(y, mo, d, hours, minutes) - offsetMs;
		return resetMs > Date.now() ? resetMs : resetMs + 86_400_000;
	} catch {
		return 0;
	}
}

// ── Wait-flag parsing & formatting ────────────────────────────────────

/** Parse "6h", "90m", "1h30m", "360" (bare number = minutes) → milliseconds. */
export function parseWaitFlag(value: string): number {
	const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
	if (match && (match[1] || match[2])) {
		const hours = parseInt(match[1] ?? "0", 10);
		const minutes = parseInt(match[2] ?? "0", 10);
		return (hours * 3600 + minutes * 60) * 1000;
	}
	const bare = parseInt(value, 10);
	if (!isNaN(bare)) return bare * 60_000; // bare number = minutes
	return 6 * 3600_000; // fallback
}

/** Format milliseconds as human-readable wait time: "4h 32m", "12m", "<1m". */
export function fmtWait(ms: number): string {
	const totalMin = Math.ceil(ms / 60_000);
	if (totalMin < 1) return "<1m";
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	if (h === 0) return `${m}m`;
	if (m === 0) return `${h}h`;
	return `${h}h ${m}m`;
}

// ── Mutex ──────────────────────────────────────────────────────────────

export function createMutex(): Mutex {
	const queue: (() => void)[] = [];
	let locked = false;
	return {
		acquire(): Promise<void> {
			if (!locked) {
				locked = true;
				return Promise.resolve();
			}
			return new Promise<void>((r) => queue.push(r));
		},
		release() {
			const next = queue.shift();
			if (next) next();
			else locked = false;
		},
	};
}
