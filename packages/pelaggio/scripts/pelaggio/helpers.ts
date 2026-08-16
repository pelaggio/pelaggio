import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveArtifactRoot } from "./artifact-root.js";
import { CONFIG, isPipelineStep, LOG_PATH, type PipelineStep, REPO, resolveProviderBin, STEPS, WORKTREE_PREFIX } from "./config.js";
import { MarkdownRoadmap } from "./roadmap/markdown.js";
import type { CreateItemOpts, RoadmapSource } from "./roadmap/types.js";
import type { CycleDisposition, CycleDriverProvenance, CycleGitBinding, CycleResult, CycleVersionProvenance, Decision, Mutex, ParkClass, ProviderName, Step, StepLog, StepResult } from "./types.js";

export function parseDecisions(text: string): Decision[] {
	const decisions: Decision[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^\s*DECISION:(.*)$/);
		if (!match) continue;
		const raw = match[1].trim();
		const choseAt = raw.indexOf("| chose:");
		if (choseAt < 0) {
			decisions.push({ fork: raw || "(unspecified decision)" });
			continue;
		}
		const fork = raw.slice(0, choseAt).trim() || "(unspecified decision)";
		const afterChose = raw.slice(choseAt + "| chose:".length);
		const alternativesAt = afterChose.indexOf("| alternatives:");
		if (alternativesAt < 0) {
			const chosen = afterChose.trim();
			decisions.push({ fork, ...(chosen ? { chosen } : {}) });
			continue;
		}
		const chosen = afterChose.slice(0, alternativesAt).trim();
		const alternatives = afterChose.slice(alternativesAt + "| alternatives:".length).trim();
		decisions.push({ fork, ...(chosen ? { chosen } : {}), ...(alternatives ? { alternatives } : {}) });
	}
	return decisions;
}

// ── Skill loading ──────────────────────────────────────────────────────

export function expandSkill(name: string, skillArgs?: string): string {
	return expandSkillFrom(REPO, name, skillArgs);
}

/** Load the package-owned copy of a skill. Merge-gate protocols must not depend
 *  on a consumer having run `pelaggio sync`: a missing or stale consumer copy
 *  must not crash the gate or weaken its current output contract. */
export function expandPackagedSkill(name: string, skillArgs?: string): string {
	return expandSkillFrom(resolveArtifactRoot(import.meta.url), name, skillArgs);
}

function expandSkillFrom(root: string, name: string, skillArgs?: string): string {
	const upper = resolve(root, ".claude", "skills", name, "SKILL.md");
	const lower = resolve(root, ".claude", "skills", name, "skill.md");
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
	return listWorktreesIn(REPO);
}

/** List every registered worktree path for a given repo root (porcelain). */
export function listWorktreesIn(repo: string): string[] {
	try {
		return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf-8" })
			.split("\n")
			.filter((l) => l.startsWith("worktree "))
			.map((l) => l.slice("worktree ".length).trim())
			.filter(Boolean);
	} catch {
		return [repo];
	}
}

/**
 * Resolve the checkout that currently holds `refs/heads/main`.
 * Used by harness-local stores (stale-quarantine) that must land on main regardless of
 * which feature worktree the caller sits in. Decision storage no longer uses this —
 * per-item authority lives under each caller's own checkout.
 */
export function mainWorktree(repo: string): string {
	try {
		const output = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
		for (const block of output.trim().split(/\n\n+/)) {
			const lines = block.split("\n");
			if (lines.includes("branch refs/heads/main")) return lines[0].slice("worktree ".length);
		}
	} catch {
		// `git worktree list` unavailable (non-worktree layout / no git) — fall back to the caller's repo.
	}
	// `--no-worktree` / CI: claim leaves only the feature branch checked out, so no worktree holds
	// `refs/heads/main`. Fall back to the caller's repo — stores land there and there is no sibling
	// main to diverge from in that mode. When a main worktree exists (local supervised runs), the loop
	// above redirects writes to it instead. Never throw: a missing main must not fail store writes.
	return repo;
}

/** Fixed confirmation budget for transient Git snapshot interference (not config). */
export const FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS = 3;
/** Sync delay between failed snapshot attempts (ms). */
export const FORBIDDEN_ROOT_SNAPSHOT_RETRY_DELAY_MS = 25;
/**
 * Typed sentinel for a forbidden root unavailable at snapshot time: fully absent (#330), or a
 * residual present directory shell that is not a Git repository (Git's explicit
 * `fatal: not a git repository` diagnostic conjoined with confirmed absence of `<root>/.git` —
 * #339; e.g. `worktree remove` left an empty path). Distinct from any `git status --porcelain`
 * output (which is either "" or newline-separated entries, never NUL-prefixed), so the diff can
 * treat it as no-violation without colliding with a real clean/dirty observation. Never use `""`
 * — that collides with a clean tree.
 */
export const FORBIDDEN_ROOT_GONE = "\0gone";

export interface SnapshotForbiddenRootOptions {
	/** Test seam: replace the real Git runner. Defaults to `git --no-optional-locks status …`. */
	run?: (root: string) => string;
	/** Test seam: replace the sync sleeper between failed attempts. */
	sleepSync?: (ms: number) => void;
	/** Test seam: replace the absence check. Defaults to `existsSync`. */
	exists?: (root: string) => boolean;
	/** Override production attempt budget (tests only). */
	attempts?: number;
	/** Override production retry delay (tests only). */
	retryDelayMs?: number;
}

function sleepSyncDefault(ms: number): void {
	if (ms <= 0) return;
	// Zero-dependency synchronous delay — PreToolUse hooks must stay sync.
	const lock = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(lock, 0, 0, ms);
}

function formatSnapshotExecError(error: unknown): string {
	if (error && typeof error === "object") {
		const e = error as { stderr?: unknown; message?: unknown };
		const stderr = typeof e.stderr === "string" ? e.stderr.trim() : Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf-8").trim() : "";
		if (stderr) return stderr;
		if (typeof e.message === "string" && e.message) return e.message;
	}
	return error instanceof Error ? error.message : String(error);
}

/** Git's canonical non-repository fatal prefix (plain shell and broken-gitdir forms share it). */
function isNotAGitRepositoryDiagnostic(error: unknown): boolean {
	return formatSnapshotExecError(error).includes("fatal: not a git repository");
}

function runForbiddenRootSnapshot(root: string): string {
	// `--no-optional-locks`: parallel cycles snapshot the *shared* main-repo index twice per
	// step; without it `git status` opportunistically takes `index.lock` to write back its
	// refreshed stat cache, and concurrent snapshots collide (`index.lock: File exists`), which
	// the fail-closed audit would misread as a confinement violation. The porcelain output is
	// identical either way — the flag only skips the index writeback.
	return execSync("git --no-optional-locks status --porcelain=v1 --untracked-files=all", {
		cwd: root,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/**
 * Snapshot a forbidden Git root's porcelain status. Retries **execution failures only**
 * (throws from the runner) a fixed number of times; a successful dirty/clean observation
 * is returned immediately and never re-polled.
 */
export function snapshotForbiddenRoot(root: string, opts?: SnapshotForbiddenRootOptions): string {
	const attempts = opts?.attempts ?? FORBIDDEN_ROOT_SNAPSHOT_ATTEMPTS;
	const retryDelayMs = opts?.retryDelayMs ?? FORBIDDEN_ROOT_SNAPSHOT_RETRY_DELAY_MS;
	const run = opts?.run ?? runForbiddenRootSnapshot;
	const sleepSync = opts?.sleepSync ?? sleepSyncDefault;
	const exists = opts?.exists ?? ((p: string) => existsSync(p));

	// A registered-but-gone root cannot have been mutated by this step, so it is not a violation.
	// Return the typed GONE sentinel instead of letting the retry loop burn attempts on a permanent
	// ENOENT/`/bin/sh`-missing failure and then fail closed. Keyed strictly on *absence* (`!exists`),
	// never on catching an ENOENT-class error: a missing `git`/`sh` binary on an existing root is a
	// real failure that must still fail closed. (#308 follow-up)
	if (!exists(root)) return FORBIDDEN_ROOT_GONE;

	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return run(root);
		} catch (e: unknown) {
			lastError = e;
			// Re-check absence after a failed exec: the root may have been removed *during* the step
			// (TOCTOU) — a permanent condition the retry loop cannot clear. Only confirmed absence maps
			// to GONE; a real error on a still-present root keeps failing closed through the throw below.
			if (!exists(root)) return FORBIDDEN_ROOT_GONE;
			// Present directory shell that is not a repository (e.g. worktree remove left an empty
			// path): same GONE semantics as full absence. Require BOTH Git's explicit non-repo
			// diagnostic and confirmed absence of `<root>/.git` — the diagnostic alone collides with
			// unreadable-but-present `.git` (`chmod 000`), which must stay fail-closed (#339).
			if (isNotAGitRepositoryDiagnostic(e) && !exists(resolve(root, ".git"))) {
				return FORBIDDEN_ROOT_GONE;
			}
			if (attempt < attempts) sleepSync(retryDelayMs);
		}
	}
	throw new Error(`failed to snapshot forbidden root ${root}: ${formatSnapshotExecError(lastError)}`);
}

export function snapshotForbiddenRoots(roots: readonly string[]): Map<string, string> {
	const snapshots = new Map<string, string>();
	for (const root of roots) {
		const resolved = resolve(root);
		if (snapshots.has(resolved)) continue;
		snapshots.set(resolved, snapshotForbiddenRoot(resolved));
	}
	return snapshots;
}

export function diffForbiddenRootSnapshots(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
	const changed: string[] = [];
	for (const [root, status] of before) {
		const next = after.get(root);
		// A root that is GONE at *either* endpoint was already absent or was removed mid-step; it
		// cannot have been mutated-and-observed by this step, so it is never a violation. Only a
		// present→present pair with differing porcelain output is a real confinement breach. (#308)
		if (status === FORBIDDEN_ROOT_GONE || next === FORBIDDEN_ROOT_GONE) continue;
		if (next !== status) changed.push(root);
	}
	return changed;
}

/**
 * HEAD + full ref-state digest of a Git checkout (#510 round-2, finding 2a). A porcelain
 * snapshot cannot see clean-to-clean mutations — `git commit --allow-empty` on a clean tree or a
 * bare ref move (`git update-ref`) leaves porcelain identical — so `pr-adjudicate` brackets its
 * attacker-influenced verifier run with this digest as well: any HEAD move or ref
 * create/move/delete changes the string and the caller refuses. Throws on execution failure
 * (callers fail closed).
 */
export function snapshotRepoRefState(root: string): string {
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const refs = execFileSync("git", ["for-each-ref"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	return `${head}\n${createHash("sha256").update(refs).digest("hex")}`;
}

/**
 * Porcelain + HEAD snapshot of a registered sibling worktree (#510 round-2, finding 2b).
 * Branch-ref moves are visible in the shared ref store (covered by `snapshotRepoRefState` on the
 * main root); the per-worktree HEAD here additionally catches a commit made in a detached
 * sibling checkout, and the porcelain catches working-tree writes. Returns the GONE sentinel for
 * an absent root (gone at both endpoints compares equal, i.e. no delta); throws on a real
 * execution failure so callers fail closed.
 */
export function snapshotSiblingWorktree(root: string): string {
	const status = snapshotForbiddenRoot(root);
	if (status === FORBIDDEN_ROOT_GONE) return status;
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	return `${status}\n@${head}`;
}

export type MainCheckoutDeltaResult = { kind: "clean" } | { kind: "violation"; roots: readonly string[] } | { kind: "error"; message: string };

export interface MainCheckoutDeltaObserver {
	beforeTool(invocationId: string): MainCheckoutDeltaResult;
	afterTool(invocationId: string): MainCheckoutDeltaResult;
	finish(): MainCheckoutDeltaResult;
}

/** Attribute main-checkout Git-state deltas to individual mutating tool windows. */
export function createMainCheckoutDeltaObserver(root: string): MainCheckoutDeltaObserver {
	const mainRoot = resolve(root);
	const baselines = new Map<string, string>();
	let terminal: MainCheckoutDeltaResult | undefined;
	let accumulated: MainCheckoutDeltaResult = { kind: "clean" };

	const fail = (message: string): MainCheckoutDeltaResult => {
		if (accumulated.kind !== "error") accumulated = { kind: "error", message };
		return accumulated;
	};
	const snapshot = (): string | MainCheckoutDeltaResult => {
		try {
			const status = snapshotForbiddenRoot(mainRoot);
			// mainRepo is never GONE-tolerated: cwd lives inside it and it is hard-gated. If it ever
			// snapshots absent, fail closed rather than silently skipping the delta. (#308)
			if (status === FORBIDDEN_ROOT_GONE) return fail(`main checkout root vanished: ${mainRoot}`);
			return status;
		} catch (error) {
			return fail(error instanceof Error ? error.message : String(error));
		}
	};

	return {
		beforeTool(invocationId) {
			if (terminal) return terminal;
			if (!invocationId) return fail("confinement attribution received a mutating tool without an invocation id");
			if (baselines.has(invocationId)) return fail(`duplicate confinement attribution invocation id: ${invocationId}`);
			const baseline = snapshot();
			if (typeof baseline !== "string") return baseline;
			baselines.set(invocationId, baseline);
			return accumulated;
		},
		afterTool(invocationId) {
			if (terminal) return terminal;
			const baseline = baselines.get(invocationId);
			if (baseline === undefined) return fail(`missing confinement attribution baseline for invocation id: ${invocationId || "<missing>"}`);
			baselines.delete(invocationId);
			const after = snapshot();
			if (typeof after !== "string") return after;
			if (after !== baseline && accumulated.kind !== "error") accumulated = { kind: "violation", roots: [mainRoot] };
			return accumulated;
		},
		finish() {
			if (terminal) return terminal;
			if (baselines.size > 0 && accumulated.kind !== "error") {
				accumulated = { kind: "error", message: `unclosed confinement attribution invocation ids: ${[...baselines.keys()].sort().join(", ")}` };
			}
			terminal = accumulated;
			return terminal;
		},
	};
}

// ── Pick result parsing ────────────────────────────────────────────────

export type PickReason = "claimed" | "blocked" | "unknown-id" | "already-done" | "worktree-exists" | "already-claimed" | "queue-empty" | "stale-quarantined";

const PICK_REASONS: ReadonlySet<PickReason> = new Set(["claimed", "blocked", "unknown-id", "already-done", "worktree-exists", "already-claimed", "queue-empty", "stale-quarantined"]);

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
 * Last occurrence wins. Accepts IDs matching `(?:[A-Z]+-?)?\d[\dA-Z-]*` — the
 * optional letter prefix + hyphens allow both markdown/linear ids (`COMP-11C-II`,
 * `ACME-7`) and bare-numeric github issue ids (`337`). The bare-numeric case is
 * load-bearing: `pick-item:` is the skill's AUTHORITATIVE claim marker (SKILL.md),
 * and rejecting numeric ids here would drop github back to ambiguous free-text
 * `parseItemId` parsing — the exact ambiguity the marker exists to remove (#332).
 * Malformed values → null.
 */
export function parsePickItem(text: string): string | null {
	const re = /^[ \t]*pick-item:[ \t]*([^\s][^\n]*?)[ \t]*$/gim;
	let last: string | null = null;
	for (const m of text.matchAll(re)) last = m[1];
	if (last === null) return null;
	return /^(?:[A-Z]+-?)?\d[\dA-Z-]*$/.test(last) ? last : null;
}

/**
 * #332: decide whether the item a /pick step actually resolved diverged from an explicit
 * `--item` pin. An explicit pin is a deterministic gate — the pick skill's contract is to claim
 * exactly that id (or report done/blocked), never substitute a different ready item — but the
 * resolved id is parsed from pick's OUTPUT, so a diverting skill would silently redirect the whole
 * cycle. Both ids are normalized through the adapter's `parseItemId` (so `#286` / `issue-286` /
 * `feat/issue-286` all reduce to `286`) before comparison; a normalizer returning null falls back
 * to the raw string. Comparison is case-insensitive: the markdown adapter's `getItem` accepts ids
 * case-insensitively (so `--item tool-16` is the same item as the canonical `TOOL-16`), while
 * github (numeric) / linear (uppercase) ids are unaffected by folding — so uppercasing avoids a
 * false `pick:diverted` on a mixed-case pin without ever merging two genuinely-distinct ids.
 * Returns true when the resolved id is not the pinned one.
 */
export async function pickDivergedFromPin(pin: string, resolved: string, parseItemId: (text: string) => Promise<string | null>): Promise<boolean> {
	const requested = ((await parseItemId(pin)) ?? pin).toUpperCase();
	const got = ((await parseItemId(resolved)) ?? resolved).toUpperCase();
	return requested !== got;
}

/**
 * Parse a structured `ship-merged: <ID>` line from the /ship or /shipwreck
 * hand-off-gate output. Last occurrence wins (the skill may restate it in a
 * summary). The ID grammar is permissive — uppercase-prefixed markdown IDs
 * (`COMP-11C-II`), Linear keys (`ENG-123`), AND the bare numeric IDs
 * github-issues emits (`37`) — because the caller validates the real
 * constraint (equality to the resolved itemId). Malformed / absent → null.
 */
export function parseShipMerged(text: string): string | null {
	const re = /^[ \t]*ship-merged:[ \t]*([^\s][^\n]*?)[ \t]*$/gim;
	let last: string | null = null;
	for (const m of text.matchAll(re)) last = m[1];
	if (last === null) return null;
	return /^[A-Za-z0-9][\w-]*$/.test(last) ? last : null;
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
 *   `clamp(2 × files + 100, 150, 400)`.
 * Falls back to the static `fallback` when the plan is absent or parses to zero
 * files (e.g. a `--resume` that starts at `implement` with no plan on disk).
 *
 * The ceiling (400) and floor (150) are the escape hatch for a genuinely-large
 * ATOMIC item a single implement cycle must carry. Decomposition into deferred
 * sub-items (emitted at plan time) is the preferred path, but not every large
 * change decomposes cleanly — sized after repeated 100-turn-wall failures on
 * complex-but-few-files items (e.g. #294's taxonomy engine hit the old 100 floor).
 */
export function computeImplementTurns(planBody: string | null, fallback: number): number {
	if (!planBody) return fallback;
	const files = countPlanFiles(planBody);
	if (files === 0) return fallback;
	return Math.max(150, Math.min(400, 2 * files + 100));
}

// ── PR-review revision injection (issue #60) ───────────────────────────

const REVIEW_FINDINGS_MAX = 6000;

/**
 * Build the implement-step preamble that turns a resume into a *revision* of already-shipped
 * code driven by PR-review findings (issue #60). Empty/whitespace input → "" (caller omits the
 * block). Truncated at REVIEW_FINDINGS_MAX with an explicit marker. Pure — unit-tested.
 * Findings are more load-bearing than plan-shakedown text, so the cap is more generous than the
 * 2000-char `shakedownPlanText.slice`.
 */
export function reviewFindingsPreamble(findings: string): string {
	const body = findings.trim();
	if (!body) return "";
	const clipped = body.length > REVIEW_FINDINGS_MAX ? `${body.slice(0, REVIEW_FINDINGS_MAX)}\n...(truncated)` : body;
	return [
		"## Revision pass — fix the review findings",
		"A prior PR review BLOCKED this change. Treat these findings as the primary task.",
		"Inspect the findings first, identify the named files, and edit code/docs to resolve every",
		"blocking issue. The approved plan is historical context only; it must not override the review",
		"findings or turn this into a plan execution pass. After fixing the findings, run the rubric",
		"verification before finishing.",
		"",
		"### Review findings",
		clipped,
	].join("\n");
}

/** Generous cap on the injected item body — the spec is more load-bearing than review findings
 *  (`REVIEW_FINDINGS_MAX`), but a 65 KiB GitHub issue body shouldn't blow the prompt. */
const STEP_BODY_MAX = 16_000;

/**
 * Build a step's skill arguments (#103, #115). Prefixed with the `pelaggio` pipeline-mode gate
 * (plus `mode`, e.g. `plan-review` / `code-review` for shakedown) and the item's requirements
 * fetched in-harness — so a provider whose sandbox can't fetch them (Codex: no network, roadmap CLI
 * dies on tsx-IPC) works against the real issue instead of running `roadmap get` / `gh issue view`
 * itself. Runs for ALL providers (Claude also gets the block and skips its own fetch); load-bearing
 * for sandboxed ones. github-issues carries the full issue `body`; markdown carries its one-line item
 * row (and `sourceRef` still names the locally-readable roadmap file); adapters without either fall
 * back to reading `sourceRef`. `getItem` failure degrades to the bare gate (the model still recovers
 * the id from the branch name per the skill).
 */
export async function buildStepArgs(roadmap: RoadmapSource, itemId: string, mode?: string): Promise<string> {
	const item = await roadmap.getItem(itemId).catch(() => null);
	const lines = [mode ? `pelaggio ${mode}` : "pelaggio"];
	if (item) {
		lines.push("", "## Roadmap item context (provided by the harness — do NOT run `roadmap get` / `gh issue view`)", `ID: ${item.id}`, `Title: ${item.title}`);
		if (item.deps && item.deps !== "—") lines.push(`Depends on: ${item.deps}`);
		lines.push(`sourceRef: ${item.sourceRef}`);
		const body = item.body?.trim();
		if (body) lines.push("", body.length > STEP_BODY_MAX ? `${body.slice(0, STEP_BODY_MAX)}\n…(truncated — read \`${item.sourceRef}\` for the full spec)` : body);
		else lines.push("", "(No body from the adapter — if `sourceRef` names a local file, read it for the full spec.)");
	}
	return lines.join("\n");
}

/**
 * Parse `deferred-item: {json}` markers a shakedown-code step emits (#115). Under pelaggio the
 * model lists deferred follow-ups as these markers instead of running `roadmap create-item` itself
 * (a sandboxed provider can't); the harness creates them post-step. One JSON object per line:
 * `{ "title": "...", "scope"?: "XS|S|M|L|XL", "deps"?: "A, B" }`. Malformed/title-less lines are
 * skipped; every item is flagged `deferred: true`. `deps` accepts a JSON array
 * (`["A","B"]`) or a comma-separated string (`"A, B"`). Pass a shared `seen` set to
 * dedup across multiple call sites (e.g. plan + shakedown-code both parse markers —
 * `createItem` is not idempotent, so a marker echoed in both must create only once).
 */
export function parseDeferredItems(text: string, seen: Set<string> = new Set<string>()): CreateItemOpts[] {
	const SCOPES = new Set(["XS", "S", "M", "L", "XL"]);
	const items: CreateItemOpts[] = [];
	for (const m of text.matchAll(/^[ \t]*deferred-item:[ \t]*(\{.*\})[ \t]*$/gim)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(m[1]);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;
		const rec = parsed as Record<string, unknown>;
		const title = typeof rec.title === "string" ? rec.title.trim() : "";
		if (!title || seen.has(title.toLowerCase())) continue;
		seen.add(title.toLowerCase());
		const scopeRaw = typeof rec.scope === "string" ? rec.scope.toUpperCase() : "";
		const scope = SCOPES.has(scopeRaw) ? (scopeRaw as CreateItemOpts["scope"]) : undefined;
		const deps = Array.isArray(rec.deps)
			? rec.deps.filter((d): d is string => typeof d === "string" && d.trim() !== "").map((d) => d.trim())
			: typeof rec.deps === "string"
				? rec.deps
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined;
		items.push({ title, ...(scope ? { scope } : {}), ...(deps && deps.length > 0 ? { deps } : {}), deferred: true });
	}
	return items;
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

const FATAL_SDK_ERROR_RE = /\b(?:invalid api key|authentication|unauthorized|forbidden|permission|bad request|40[0-9]|422)\b/i;
const TRANSIENT_SDK_ERROR_RE = /\b(?:internal server error|overloaded|temporarily unavailable|service unavailable|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed)\b/i;
const TRANSIENT_SDK_STATUS_RE = /(?<!\$)\b(?:500|502|503|504)\b(?!\s*(?:files?|cost|usd|dollars?))/i;

export function isTransientSdkError(result: Pick<StepResult, "subtype" | "text">): boolean {
	if (result.subtype !== "error_sdk") return false;
	if (FATAL_SDK_ERROR_RE.test(result.text)) return false;
	return TRANSIENT_SDK_ERROR_RE.test(result.text) || TRANSIENT_SDK_STATUS_RE.test(result.text);
}

/**
 * Closed classification of a step outcome, used ONLY at pipeline decision points
 * (retry/park/ship branching). Distinct from the free-form `StepResult.subtype`
 * that flows into the jsonl log / TUI / notify telemetry — those keep the raw
 * value (e.g. `error_sdk`, `error_budget`, `error_abort`) so classifying here
 * never flattens telemetry. Every closed member is identity on the branched
 * subtype; everything else (SDK/budget/abort errors, `unknown`, arbitrary
 * strings) collapses to the catch-all `"error"`.
 */
export type StepSubtype = "success" | "error_rate_limit" | "error_max_turns" | "error_refusal" | "error_confinement" | "blocked" | "edit_loop" | "error";

const CLOSED_SUBTYPES: ReadonlySet<string> = new Set(["success", "error_rate_limit", "error_max_turns", "error_refusal", "error_confinement", "blocked", "edit_loop"]);

export function classifyOutcome(result: Pick<StepResult, "subtype">): StepSubtype {
	return CLOSED_SUBTYPES.has(result.subtype) ? (result.subtype as StepSubtype) : "error";
}

/**
 * Closed classification of *why* a cycle parked, recorded next to the free-form
 * `parkReason` detail in the cycle log.
 *
 * Two families reach `parkExit()`: signal-driven parks carry a structured
 * `parkSignal.limitType` (rate limit, operator pause, SDK outage), while
 * review-loop parks pass an explicit reason string and leave `limitType` empty.
 * Only the former was ever persisted, so every review-gate park logged a null
 * reason — which made "parked because a reviewer found a real blocker" and
 * "parked because the provider fell over" indistinguishable in the stats.
 *
 * `limitType` wins when present: it is already structured. The reason string is
 * matched only as a fallback, most-specific first — "effects failed after
 * escalation" is an effects failure, not an escalation.
 */
export function classifyParkReason(reason: string | null | undefined, limitType: string | null | undefined): ParkClass {
	const limit = (limitType ?? "").trim();
	if (limit === "paused") return "paused";
	if (limit === "sdk-outage") return "sdk-outage";
	if (limit) return "rate-limit";
	const text = (reason ?? "").trim();
	if (!text) return "unclassified";
	if (/effects failed/i.test(text)) return "effects-failed";
	if (/could not bind/i.test(text)) return "review-binding";
	if (/escalation/i.test(text)) return "review-escalation";
	if (/safety blocker|hard-block|dissent|budget|no loop result/i.test(text)) return "review-blocked";
	return "unclassified";
}

export function classifyCycleDisposition(result: Pick<CycleResult, "completed" | "error" | "disposition">, recoverable: ReadonlySet<string>): CycleDisposition {
	if (result.completed) return "continue";
	if (result.error === "aborted") return "halt-campaign";
	if (result.disposition) return result.disposition;
	if (recoverable.has(result.error ?? "")) return "continue";
	return "halt-campaign";
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

export interface SecurityDiffSignal {
	triggered: boolean;
	reasons: string[];
}

const SECURITY_REASON_LIMIT = 8;

const SECURITY_PATHS: readonly RegExp[] = [
	/^\.github\/workflows\//,
	/^infra\//,
	/^packages\/server\/src\/(?:auth|config|app)\.ts$/,
	/^packages\/server\/scripts\//,
	/^packages\/pelaggio\/scripts\/pelaggio\/(?:step-runner|codex-provider|helpers|config|pr-review-cli|revise-sweep|notify|worktree-deps)\.ts$/,
	/^packages\/pelaggio\/scripts\/pelaggio\/review\/findings\.ts$/,
	/^packages\/pelaggio\/scripts\/pelaggio\/(?:ship|roadmap)\//,
	/^\.claude\/skills\/(?:pr-review|pr-verify|shakedown|ship|implement)\/SKILL\.md$/,
	/^\.agents\/skills\/(?:pr-review|pr-verify|shakedown|ship|implement)\/SKILL\.md$/,
];

const SECURITY_KEYWORDS: readonly [string, RegExp][] = [
	["CONTROL_PLANE_TOKEN", /\bCONTROL_PLANE_TOKEN\b/],
	["ANTHROPIC_API_KEY", /\bANTHROPIC_API_KEY\b/],
	["GH_TOKEN", /\bGH_TOKEN\b/],
	["prompt injection", /\bprompt\s+injection\b/i],
	["ignore instructions", /\bignore\s+instructions\b/i],
	["0.0.0.0", /0\.0\.0\.0/],
	["127.", /127\./],
	["::1", /::1/],
	["auth", /\bauth(?:entication|orization)?\b/i],
	["token", /\btoken\b/i],
	["secret", /\bsecret\b/i],
	["permission", /\bpermissions?\b/i],
	["host", /\bhost(?:name)?\b/i],
	["loopback", /\bloopback\b/i],
	["localhost", /\blocalhost\b/i],
	["fetch", /\bfetch\b/i],
	["network", /\bnetwork\b/i],
	["exec", /\bexec(?:FileSync|Sync)?\b/i],
	["spawn", /\bspawn(?:Sync)?\b/i],
	["shell", /\bshell\b/i],
	["bash", /\bbash\b/i],
	// Generic tool and identifier tokens (`git`, `gh`, `url`) are too common to
	// signal security sensitivity; specific credentials and operations remain.
	["workflow", /\bworkflow\b/i],
];

/**
 * Deterministic switch for the extra adversarial PR-review pass. This is not a
 * scanner; it only decides whether the diff is security-sensitive enough to
 * spend a second model session.
 */
export function classifySecurityReviewDiff(files: readonly string[], diff: string): SecurityDiffSignal {
	const reasons: string[] = [];
	const seen = new Set<string>();
	const addReason = (reason: string): void => {
		if (seen.has(reason) || reasons.length >= SECURITY_REASON_LIMIT) return;
		seen.add(reason);
		reasons.push(reason);
	};

	for (const file of files) {
		if (SECURITY_PATHS.some((re) => re.test(file))) addReason(`path:${file}`);
	}

	const changedLines: string[] = [];
	let inHunk = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			inHunk = false;
			continue;
		}
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (inHunk && (line.startsWith("+") || line.startsWith("-"))) changedLines.push(line);
	}
	const keywordInput = changedLines.join("\n");

	for (const [keyword, re] of SECURITY_KEYWORDS) {
		if (re.test(keywordInput)) addReason(`keyword:${keyword}`);
	}

	return { triggered: reasons.length > 0, reasons };
}

/**
 * One-line, machine-readable marker appended to the gate comment so the durable
 * PR-comment stream can be aggregated into a precision dataset (see
 * docs/pr-review.md § Evidence gate). Records `ok`/`subtype` because `gh run list`
 * conclusion alone conflates a real `must-fix` report with a fail-closed transient —
 * only clean (`ok=true subtype=success`) BLOCKs are precision-relevant.
 */
export function formatReviewMetrics(gate: "pass" | "block", ok: boolean, subtype: string, cost: number, turns: number): string {
	return `<!-- pr-review-metrics gate=${gate} ok=${ok} subtype=${subtype} cost=${cost.toFixed(2)} turns=${turns} -->`;
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

/**
 * Paths the checkpoint's `git add -A` would stage: every porcelain v1 entry, including
 * untracked files. `-z` avoids quoting; a rename/copy record carries a second (source-path)
 * token that must be consumed, not read as its own entry.
 */
function pendingCommitPaths(cwd: string): string[] {
	const out = execSync("git status --porcelain=v1 -z --untracked-files=all", { cwd, encoding: "utf-8", stdio: "pipe" });
	const tokens = out.split("\0");
	const paths: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const entry = tokens[i];
		if (entry.length < 4) continue;
		paths.push(entry.slice(3));
		if (entry[0] === "R" || entry[0] === "C") i++; // skip the rename/copy source-path token
	}
	return paths;
}

export function checkpoint(cwd: string, label: string): boolean {
	// #424 review: a checkpoint must never conclude an unresolved merge. `git add -A`
	// stages unmerged paths as "resolved" — conflict markers and all — and the commit
	// then ends the merge, silently turning a conflicted tree into a clean, ancestor-
	// containing branch. Refuse instead: the tree stays dirty-with-MERGE_HEAD, which
	// `preparePrShipFreshness` already classifies as `conflicted` on resume.
	try {
		const unmerged = execSync("git diff --name-only --diff-filter=U", { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
		if (unmerged !== "") {
			process.stderr.write(`⚠ checkpoint refused (${label}): unresolved merge paths present\n`);
			return false;
		}
		// #424 gate fix: unmerged-path state alone is bypassable — a mid-repair `git add` on a
		// marker-laden conflict file clears it while the markers survive in content, and an
		// interleaved rate-limit park then reaches this choke point (parkExit → checkpoint)
		// with MERGE_HEAD still open, which the commit below would silently conclude. When
		// this commit would CONCLUDE a merge, the originally-conflicted file list is not
		// available here (parkExit is generic and `--diff-filter=U` is already empty), so
		// conservatively scan every path `git add -A` would commit for conflict-marker lines.
		// Fail closed: refuse the checkpoint and leave the tree dirty-with-MERGE_HEAD — the
		// documented park contract — so resume re-enters `conflicted` and the repair re-runs.
		let mergeInProgress = false;
		try {
			execSync("git rev-parse -q --verify MERGE_HEAD", { cwd, stdio: "pipe" });
			mergeInProgress = true;
		} catch {
			// no merge being concluded
		}
		if (mergeInProgress) {
			const gate = verifyConflictRepairComplete(cwd, pendingCommitPaths(cwd));
			if (!gate.ok) {
				process.stderr.write(`⚠ checkpoint refused (${label}): would conclude a merge with ${gate.detail}\n`);
				return false;
			}
		}
	} catch {
		// Not a repo / git unavailable — fall through so the add/commit below reports the real error.
	}
	try {
		execSync(`git add -A && git commit -m "wip: pelaggio ${label}" --no-verify`, {
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

export function quarantineCheckpoint(cwd: string, label: string): boolean {
	try {
		checkpoint(cwd, label);
		return execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim() === "";
	} catch {
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

/**
 * The sha the adversarial review actually binds to: the last commit that touches
 * anything OTHER than docs/decision-log/. Escalation/resolution records commit into
 * the worktree (#386) and would otherwise advance HEAD past the stored reviewedSha,
 * making resume's exact-sha lookup permanently miss (a human resolve would never be
 * honored). Falls back to plain HEAD when the pathspec yields nothing.
 */
export function getArtifactHeadSha(cwd: string): string | null {
	try {
		const sha = execSync("git log -1 --format=%H -- . ':(exclude)docs/decision-log'", { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		return sha || getHeadSha(cwd);
	} catch {
		return getHeadSha(cwd);
	}
}

export function uniqueDriverProvenance(steps: StepLog[]): CycleDriverProvenance[] {
	const seen = new Set<string>();
	const drivers: CycleDriverProvenance[] = [];
	for (const step of steps) {
		if (!step.provider) continue;
		const key = `${step.provider}\0${step.model}`;
		if (seen.has(key)) continue;
		seen.add(key);
		drivers.push({ provider: step.provider, model: step.model });
	}
	return drivers;
}

type GitProbe = (command: string, cwd: string) => string;

export function readGitBinding(cwd: string | null, mainRepo: string, previous?: CycleGitBinding, run?: GitProbe): CycleGitBinding {
	const probe = run ?? ((command: string, root: string) => execSync(command, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }));
	const read = (command: string, root: string): string | null => {
		try {
			return probe(command, root).trim() || null;
		} catch {
			return null;
		}
	};
	const relativeWorktree = cwd ? relative(mainRepo, cwd) : "";
	const worktree = cwd ? (relativeWorktree && !relativeWorktree.startsWith("..") ? relativeWorktree : basename(cwd)) : null;
	return {
		branch: cwd ? (read("git branch --show-current", cwd) ?? previous?.branch ?? null) : (previous?.branch ?? null),
		worktree: worktree ?? previous?.worktree ?? null,
		mainShaAtStart: previous?.mainShaAtStart ?? read("git rev-parse main", mainRepo),
		headSha: (cwd ? read("git rev-parse HEAD", cwd) : null) ?? previous?.headSha ?? null,
	};
}

export interface RuntimeVersionResult {
	versions: CycleVersionProvenance;
	unavailable: string[];
}

export interface RuntimeVersionDeps {
	run?: (executable: string, args: string[]) => string;
	readManifest?: (path: string) => string;
	/** Override Claude SDK manifest discovery (tests). Default uses Node module resolution. */
	resolveClaudeSdkManifest?: () => string;
}

/**
 * Locate the installed `@anthropic-ai/claude-agent-sdk` package.json via Node module
 * resolution from this module. Hard-coded `../../node_modules/...` paths break under
 * hoisted / published installs (#333); `exports` also hides `./package.json`, so resolve
 * the package entry and walk up for a manifest whose `name` matches.
 */
export function resolveClaudeSdkManifestPath(fromModuleUrl: string = import.meta.url): string {
	const require = createRequire(fromModuleUrl);
	let dir = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
	for (let i = 0; i < 12; i++) {
		const pkgPath = resolve(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: unknown };
				if (pkg.name === "@anthropic-ai/claude-agent-sdk") return pkgPath;
			} catch {
				// keep walking past unreadable / non-JSON parents
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("claude-agent-sdk package.json not found via module resolution");
}

export function readRuntimeVersions(providers: ProviderName[], deps: RuntimeVersionDeps = {}): RuntimeVersionResult {
	const readManifest = deps.readManifest ?? ((path: string) => readFileSync(path, "utf-8"));
	const packagePath = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../package.json");
	const pelaggio = (JSON.parse(readManifest(packagePath)) as { version: string }).version;
	const versions: CycleVersionProvenance = { pelaggio, node: process.version, drivers: {} };
	const unavailable: string[] = [];
	const run = deps.run ?? ((executable: string, args: string[]) => execFileSync(executable, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }));
	const resolveClaudeSdk = deps.resolveClaudeSdkManifest ?? (() => resolveClaudeSdkManifestPath());
	for (const provider of new Set(providers)) {
		try {
			if (provider === "claude") {
				const sdkPath = resolveClaudeSdk();
				const version = (JSON.parse(readManifest(sdkPath)) as { version?: unknown }).version;
				if (typeof version !== "string" || !version) throw new Error("missing version");
				versions.drivers.claude = version;
			} else {
				const output = run(resolveProviderBin(CONFIG, provider, provider), ["--version"])
					.replace(/[\r\n]+/g, " ")
					.trim()
					.slice(0, 160);
				if (!output) throw new Error("empty version");
				versions.drivers[provider] = output;
			}
		} catch {
			unavailable.push(`version.${provider}`);
		}
	}
	return { versions, unavailable };
}

/**
 * Thin git wrapper: changed file names for a three-dot (or other) range.
 * Taxonomy policy lives in review/findings.ts — this only returns strings.
 */
export function gitDiffNameOnly(cwd: string, range = "main...HEAD"): string[] {
	try {
		const out = execSync(`git diff --name-only ${range}`, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		return out ? out.split("\n").filter(Boolean) : [];
	} catch {
		return [];
	}
}

/**
 * Thin git wrapper: unified diff text for a range. Fail-soft empty string on error.
 * Used only as data for pure path/diff extractors — no classification here.
 */
export function gitDiffUnified(cwd: string, range = "main...HEAD"): string {
	try {
		return execSync(`git diff ${range}`, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return "";
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

// ── Authoring-loop reviewer diff injection ─────────────────────────────
// The authoring-loop reviewer seats are told to inspect `git diff main...HEAD`, but a weak
// single-turn seat (observed: codex runs one turn with no tool calls) never fetches it and, with no
// code in front of it, parrots the SKILL.md example. Hand every reviewer seat the actual branch diff
// as a floor so it always has real code to review; capable seats (claude/grok) stay free to explore
// further — the injected diff supplements, it does not replace, their multi-turn inspection.

/** ~256 KiB cap on the injected diff; a huge diff would blow the seat's context, and the seat can
 * always run `git diff main...HEAD` itself for the remainder. */
export const REVIEW_DIFF_MAX_BYTES = 256 * 1024;

/** Format the CHANGES UNDER REVIEW block. Pure/testable: no git access. Empty diff or a failed read
 * yields a note (never crashes the loop); a truncated diff appends the run-it-yourself pointer. */
export function formatChangesUnderReview(diff: string, state: "ok" | "empty" | "unavailable" | "truncated"): string {
	const header = "## CHANGES UNDER REVIEW (git diff main...HEAD)";
	if (state === "empty") return `${header}\n\nThe branch diff against \`main\` is empty. Confirm with \`git diff main...HEAD\` and review accordingly.`;
	if (state === "unavailable") return `${header}\n\nThe harness could not compute the branch diff. Run \`git diff main...HEAD\` yourself to obtain the changes under review.`;
	const trailer = state === "truncated" ? "\n\n[diff truncated at the injection cap — run `git diff main...HEAD` for the remainder]" : "";
	return `${header}\n\nThis is the authoritative diff. Inspect it in full; explore further (\`git show\`, read files, run tests) as needed.\n\n\`\`\`diff\n${diff}\n\`\`\`${trailer}`;
}

/** Read the branch diff from a worktree and format it for injection. Fail-graceful: any git error
 * returns the "unavailable" note rather than throwing. Byte-bounded to REVIEW_DIFF_MAX_BYTES. */
export function buildReviewDiffBlock(worktree: string): string {
	let raw: string;
	try {
		raw = execSync("git diff main...HEAD", { cwd: worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
	} catch {
		return formatChangesUnderReview("", "unavailable");
	}
	if (raw.trim() === "") return formatChangesUnderReview("", "empty");
	const bytes = Buffer.from(raw, "utf-8");
	if (bytes.byteLength <= REVIEW_DIFF_MAX_BYTES) return formatChangesUnderReview(raw, "ok");
	// Truncate on a byte boundary, then trim any partial trailing line so the fenced block stays clean.
	const sliced = bytes.subarray(0, REVIEW_DIFF_MAX_BYTES).toString("utf-8");
	const trimmed = sliced.slice(0, Math.max(0, sliced.lastIndexOf("\n")));
	return formatChangesUnderReview(trimmed, "truncated");
}

/**
 * Plan-polish backstop (#80). During `implement`, `docs/plans/` is execute-only. The Claude
 * provider enforces this with a PreToolUse hook that blocks Writes there, but a sandboxed provider
 * (Codex) can't express path-exclusion — so this deterministic, provider-agnostic backstop fully
 * reverts the `docs/plans/` subtree to its pre-step (`sinceSha`) state, INCLUDING committed edits:
 * `checkout` restores modified/deleted files that existed at `sinceSha`, and files ADDED during the
 * step (not in `sinceSha`) are removed — matching the hook's coverage (which also prevents new plan
 * files). Note: `sinceSha` is the pre-`implement` HEAD, so it only covers the CURRENT session's
 * edits; polish committed by an earlier parked-then-resumed implement session is already in the
 * baseline. Returns the reverted paths (empty when nothing changed — the normal case, and always so
 * for the hook-guarded Claude path). Failures are surfaced loudly but never crash the pipeline.
 */
export function revertPlanPolish(cwd: string, sinceSha: string | null): string[] {
	if (!sinceSha) return [];
	let changed: string[];
	let added: string[];
	try {
		const out = execSync(`git diff --name-only ${sinceSha} -- docs/plans`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		changed = out ? out.split("\n").filter(Boolean) : [];
		const addedOut = execSync(`git diff --diff-filter=A --name-only ${sinceSha} -- docs/plans`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		added = addedOut ? addedOut.split("\n").filter(Boolean) : [];
	} catch {
		return [];
	}
	if (changed.length === 0) return [];
	try {
		// Restore modified/deleted files to their sinceSha content, then delete files added during
		// the step (checkout can't remove those — they aren't in sinceSha). Commit is path-scoped to
		// docs/plans so it never sweeps in unrelated staged changes.
		execSync(`git checkout ${sinceSha} -- docs/plans 2>/dev/null || true`, { cwd, encoding: "utf-8", stdio: "pipe" });
		if (added.length > 0) {
			const paths = added.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ");
			execSync(`git rm -f --ignore-unmatch -- ${paths}`, { cwd, encoding: "utf-8", stdio: "pipe" });
		}
		execSync(`git commit -m "revert: plan-polish edits during implement (docs/plans is execute-only)" --no-verify -- docs/plans`, { cwd, encoding: "utf-8", stdio: "pipe" });
	} catch (e: unknown) {
		const err = e as Record<string, unknown>;
		const msg = `${err.stderr ?? ""}${err.stdout ?? ""}` || String((e as Error).message ?? "");
		// A revert that finds nothing to commit is fine; anything else is a loud warning.
		if (!/nothing to commit|clean/i.test(msg)) process.stderr.write(`⚠ plan-polish backstop failed: ${msg.slice(0, 200)}\n`);
	}
	return changed;
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
		// docs/decision-log/ rows are harness bookkeeping (#386): a branch whose only
		// non-plan changes are decision records is still the ghost-ship case — DECISION:
		// emissions must never make a plan-only branch shippable.
		return files.split("\n").some((f) => !f.startsWith("docs/plans/") && !f.startsWith("docs/decision-log/"));
	} catch {
		return false;
	}
}

// ── PR-mode ship freshness (#424) ──────────────────────────────────────
// Fetch + merge `origin/main` into the claim worktree. Discriminated outcomes
// so the pipeline can route merge impact to the implementation author without
// discarding a parked conflict. Argv-only Git — never interpolate a path or
// ref into a shell string. Do not import review/seats.ts (helpers is the lower layer).

/** Argv Git invoker. Same `(args, cwd) => string` shape as `GitExec` in review/seats.ts. */
export type GitArgvExec = (args: readonly string[], cwd: string) => string;

const defaultGitArgvExec: GitArgvExec = (args, cwd) => execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Non-failed results retain `originMainOid` — the OID `origin/main` resolved to when this
 * run observed it (immediately post-fetch, or at classification time on the no-fetch
 * resume path). ADR-0025: every later freshness check and the ship effect bind to this
 * OID, never to the mutable `origin/main` ref name, which a subsequent writable author
 * step can move. `conflicted` carries `null` only when `origin/main` does not resolve at
 * all (pathological resume); the pipeline fails closed on a null OID before shipping.
 */
export type PrShipFreshnessResult =
	| { kind: "up-to-date"; originMainOid: string }
	| { kind: "merged"; upstreamTouchedFiles: string[]; originMainOid: string }
	| { kind: "conflicted"; unmergedFiles: string[]; upstreamTouchedFiles: string[]; originMainOid: string | null }
	| { kind: "failed"; detail: string };

export type PrShipFreshnessVerification = { ok: true } | { ok: false; detail: string };

const FRESHNESS_DETAIL_CAP = 300;

function gitArgvDetail(error: unknown): string {
	const err = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
	const stderr = typeof err.stderr === "string" ? err.stderr : Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf-8") : "";
	const stdout = typeof err.stdout === "string" ? err.stdout : Buffer.isBuffer(err.stdout) ? err.stdout.toString("utf-8") : "";
	return (stderr + stdout || err.message || String(error)).trim().slice(0, FRESHNESS_DETAIL_CAP);
}

function tryGitArgv(run: GitArgvExec, args: readonly string[], cwd: string): { ok: true; out: string } | { ok: false; detail: string } {
	try {
		return { ok: true, out: run(args, cwd).trim() };
	} catch (error) {
		return { ok: false, detail: gitArgvDetail(error) };
	}
}

function gitNameOnly(run: GitArgvExec, args: readonly string[], cwd: string): string[] {
	const result = tryGitArgv(run, args, cwd);
	if (!result.ok || result.out === "") return [];
	return result.out.split("\n").filter(Boolean);
}

function hasMergeHead(run: GitArgvExec, cwd: string): boolean {
	return tryGitArgv(run, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd).ok;
}

function unmergedPaths(run: GitArgvExec, cwd: string): string[] {
	return gitNameOnly(run, ["diff", "--name-only", "--diff-filter=U"], cwd);
}

function porcelainStatus(run: GitArgvExec, cwd: string): { ok: true; dirty: boolean } | { ok: false; detail: string } {
	const result = tryGitArgv(run, ["status", "--porcelain"], cwd);
	if (!result.ok) return { ok: false, detail: result.detail || "git status --porcelain failed" };
	return { ok: true, dirty: result.out !== "" };
}

function resolveOriginMainOid(run: GitArgvExec, cwd: string): string | null {
	const result = tryGitArgv(run, ["rev-parse", "--verify", "origin/main"], cwd);
	return result.ok && result.out !== "" ? result.out : null;
}

function oidIsAncestorOfHead(run: GitArgvExec, cwd: string, oid: string): boolean {
	return tryGitArgv(run, ["merge-base", "--is-ancestor", oid, "HEAD"], cwd).ok;
}

function upstreamTouchedFrom(run: GitArgvExec, cwd: string, incomingRef: string): string[] {
	// Three-dot: only files touched on the upstream side since the merge-base. Two-dot
	// (`HEAD..ref`) diffs the endpoint trees, so the branch's own files leak into the
	// "Upstream-touched files" list fed to the author.
	return gitNameOnly(run, ["diff", "--name-only", `HEAD...${incomingRef}`], cwd);
}

/**
 * Fetch `origin/main` and merge it into the claim worktree.
 *
 * `conflicted` includes the resume-after-park case: `parkExit()` → `checkpoint()`
 * cannot commit an unresolved merge, so a parked tree is dirty-with-`MERGE_HEAD`,
 * not a generic dirty input. Treating that as `failed` would abort resume.
 *
 * Never runs `merge --abort`, reset, or clean.
 */
export function preparePrShipFreshness(worktree: string, exec?: GitArgvExec): PrShipFreshnessResult {
	const run = exec ?? defaultGitArgvExec;
	const mergeInProgress = hasMergeHead(run, worktree);
	const unmerged = unmergedPaths(run, worktree);
	if (mergeInProgress || unmerged.length > 0) {
		// No fetch on this resume path: retain whatever origin/main resolves to NOW. Still
		// observed before the writable author step runs, so OID-bound verification rejects
		// any movement the author causes afterwards.
		const originMainOid = resolveOriginMainOid(run, worktree);
		const incoming = mergeInProgress ? "MERGE_HEAD" : originMainOid;
		return {
			kind: "conflicted",
			unmergedFiles: unmerged,
			upstreamTouchedFiles: incoming ? upstreamTouchedFrom(run, worktree, incoming) : [],
			originMainOid,
		};
	}
	const status = porcelainStatus(run, worktree);
	if (!status.ok) return { kind: "failed", detail: status.detail };
	if (status.dirty) return { kind: "failed", detail: "worktree is dirty (no merge in progress)" };

	const fetched = tryGitArgv(run, ["fetch", "origin", "main"], worktree);
	if (!fetched.ok) return { kind: "failed", detail: fetched.detail || "git fetch origin main failed" };
	// ADR-0025: resolve and retain the fetched OID once, immediately post-fetch. Every
	// subsequent check (including the merge below) uses this OID, never the ref name.
	const originMainOid = resolveOriginMainOid(run, worktree);
	if (!originMainOid) return { kind: "failed", detail: "origin/main does not resolve after fetch" };
	if (oidIsAncestorOfHead(run, worktree, originMainOid)) return { kind: "up-to-date", originMainOid };

	const upstreamTouchedFiles = upstreamTouchedFrom(run, worktree, originMainOid);
	const merged = tryGitArgv(run, ["merge", "--no-edit", originMainOid], worktree);
	if (merged.ok) return { kind: "merged", upstreamTouchedFiles, originMainOid };

	const afterUnmerged = unmergedPaths(run, worktree);
	if (hasMergeHead(run, worktree) || afterUnmerged.length > 0) {
		return { kind: "conflicted", unmergedFiles: afterUnmerged, upstreamTouchedFiles, originMainOid };
	}
	return { kind: "failed", detail: merged.detail || "git merge --no-edit origin/main failed" };
}

/**
 * Deterministic Git gate before PR pre-flight or ship. Accepts only a clean,
 * conflict-free worktree whose HEAD already contains the origin/main OID retained
 * at fetch time (`expectedOriginMainOid`, from `preparePrShipFreshness`).
 * Never aborts, resets, or cleans.
 *
 * ADR-0025: verification binds to the fetched OID, never the mutable ref name — a
 * writable author step between fetch and this gate can move `origin/main` (e.g. to an
 * older ancestor) and leave a clean tree that a ref-name check would accept. ANY
 * movement fails closed with both OIDs named; a legitimately-advanced upstream also
 * fails here, and the resume re-fetches — correct and self-healing.
 */
export function verifyPrShipFreshness(worktree: string, expectedOriginMainOid: string, exec?: GitArgvExec): PrShipFreshnessVerification {
	const run = exec ?? defaultGitArgvExec;
	if (hasMergeHead(run, worktree)) return { ok: false, detail: "merge in progress (MERGE_HEAD present)" };
	const unmerged = unmergedPaths(run, worktree);
	if (unmerged.length > 0) return { ok: false, detail: `unmerged paths: ${unmerged.join(", ")}` };
	const status = porcelainStatus(run, worktree);
	if (!status.ok) return { ok: false, detail: status.detail };
	if (status.dirty) return { ok: false, detail: "worktree is dirty" };
	const currentOid = resolveOriginMainOid(run, worktree);
	if (!currentOid) return { ok: false, detail: "origin/main does not resolve" };
	if (currentOid !== expectedOriginMainOid) {
		return { ok: false, detail: `origin/main moved after fetch: fetched ${expectedOriginMainOid}, now ${currentOid} — rejecting ref movement` };
	}
	if (!oidIsAncestorOfHead(run, worktree, expectedOriginMainOid)) return { ok: false, detail: `fetched origin/main OID ${expectedOriginMainOid} is not an ancestor of HEAD` };
	return { ok: true };
}

/** Conflict-marker line forms git itself writes: `<<<<<<< …`, `||||||| …` (diff3), `=======`, `>>>>>>> …`. */
const CONFLICT_MARKER_LINE_RE = /^(?:<{7}(?: |$)|\|{7}(?: |$)|={7}$|>{7}(?: |$))/;

/**
 * Deterministic gate on the conflicted freshness repair (#424 review): git's own
 * unmerged-path state must be empty and the originally-conflicted files must not
 * contain conflict-marker lines in the working tree.
 *
 * Ordering is load-bearing: this must run against the tree BEFORE any checkpoint's
 * `git add -A` executes, because staging normalizes unmerged-path state (marking
 * untouched conflict files "resolved") and the checkpoint commit would then conclude
 * the merge with the markers committed. The working-tree file contents scanned here
 * are exactly what `git add -A` would stage, so a pass here also vouches for the
 * content a subsequent checkpoint commits. Fail-closed: an unreadable listed file
 * counts as unresolved. A listed file absent from the working tree is a legitimate
 * delete-resolution and is skipped.
 */
export function verifyConflictRepairComplete(worktree: string, conflictedFiles: readonly string[], exec?: GitArgvExec): { ok: true } | { ok: false; detail: string } {
	const run = exec ?? defaultGitArgvExec;
	const unmerged = unmergedPaths(run, worktree);
	if (unmerged.length > 0) return { ok: false, detail: `unmerged paths remain: ${unmerged.join(", ")}` };
	const marked: string[] = [];
	for (const rel of [...new Set(conflictedFiles)]) {
		const path = resolve(worktree, rel);
		if (!existsSync(path)) continue;
		let content: string;
		try {
			content = readFileSync(path, "utf-8");
		} catch {
			marked.push(rel);
			continue;
		}
		if (content.split(/\r?\n/).some((line) => CONFLICT_MARKER_LINE_RE.test(line))) marked.push(rel);
	}
	if (marked.length > 0) return { ok: false, detail: `conflict markers remain in: ${marked.join(", ")}` };
	return { ok: true };
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

// ── Main-checkout guard (issue #216) ────────────────────────────────────

/**
 * Guard against a detached (or off-branch) main checkout silently becoming
 * the base for the next cycle. `createClaimWorkspace` always branches off the
 * literal `main` ref, not HEAD, so a detached checkout can't corrupt a *new*
 * claim — but it does break an operator's between-cycle `git merge --ff-only
 * origin/main` and makes `git log -1` in the main checkout misleading.
 * Self-heals with a plain `git checkout <branch>` (never `-f`, so it can't
 * discard uncommitted work); returns false only if that checkout itself
 * fails, in which case the caller should stop rather than claim blind.
 */
export function ensureMainCheckoutOnBranch(mainRepo: string, branch: string, log?: (msg: string) => void): boolean {
	let current: string;
	try {
		current = execSync("git branch --show-current", { cwd: mainRepo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch {
		return false;
	}
	if (current === branch) return true;
	log?.(`⚠ main checkout was on ${current || "detached HEAD"}, not ${branch} — reattaching`);
	try {
		execSync(`git checkout ${branch}`, { cwd: mainRepo, stdio: "pipe" });
		return true;
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
						const okStepName = steps[lastOk].name;
						if (typeof okStepName === "string" && isPipelineStep(okStepName)) {
							const idx = STEPS.indexOf(okStepName);
							if (idx >= 0 && idx < STEPS.length - 1) return STEPS[idx + 1];
							return "ship";
						}
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

export type LoggedDriverIdentity = { provider: "codex"; codexModel?: string } | { provider: "claude" | "grok" | "opencode"; model?: string };

/**
 * Find the latest successful realized author across all cycle entries for an item.
 *
 * The cycle log stores a realized provider plus a single generic `model` string. Codex is
 * reconstructed as `codexModel`; Claude, Grok, and OpenCode as the generic `model` (#431: a Grok or
 * OpenCode step now logs its own realized model, not the top-level Claude id, so the recovered
 * identity round-trips into a correct execution override). A logged `"default"` model means the
 * seat ran on the CLI default and is recovered as an absent model, matching the Codex behavior.
 */
export function findLoggedArtifactAuthor(itemId: string, step: "plan" | "implement", logPath = LOG_PATH): LoggedDriverIdentity | undefined {
	if (!existsSync(logPath)) return undefined;
	try {
		const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
		for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
			const entry: unknown = JSON.parse(lines[lineIndex]);
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			if (typeof record.item !== "string" || record.item.toUpperCase() !== itemId.toUpperCase() || !Array.isArray(record.steps)) continue;
			for (let index = record.steps.length - 1; index >= 0; index--) {
				const value: unknown = record.steps[index];
				if (!value || typeof value !== "object") continue;
				const logged = value as Record<string, unknown>;
				if (logged.name !== step || logged.ok !== true) continue;
				if (logged.provider === "codex") return typeof logged.model === "string" && logged.model !== "default" ? { provider: "codex", codexModel: logged.model } : { provider: "codex" };
				if (logged.provider === "claude" || logged.provider === "grok" || logged.provider === "opencode")
					return typeof logged.model === "string" && logged.model !== "default" ? { provider: logged.provider, model: logged.model } : { provider: logged.provider };
				return undefined;
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

// ── Logging ────────────────────────────────────────────────────────────

export function appendLog(entry: Record<string, unknown>): void {
	mkdirSync(resolve(REPO, ".dev"), { recursive: true });
	appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
}

// ── Step index ─────────────────────────────────────────────────────────

export function stepIndex(s: PipelineStep): number {
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

/**
 * Resolve a parked step's reset time by precedence (issue #68):
 *   1. a concrete reset already on the event (`reportedResetsAt > 0`) — trust it;
 *   2. a reset parsed from the final step text (`parseResetTime`) — the pre-existing recovery
 *      path for Claude limits that omit the reset in the event but state it in the message;
 *   3. for a rate-limit park with no reset anywhere (every Codex 429, some Claude events) — a
 *      conservative `now + estimateMs`, marked `(estimated)`, so auto-resume waits a window
 *      instead of hitting the "unknown reset → end run" path. Still bounded by the orchestrator's
 *      `--max-wait` guard; the suffix flows into the park banner, notify event, and jsonl.
 * A manual pause (`isRateLimitPark === false`, e.g. SIGUSR2) with no reset keeps `0`, so the
 * orchestrator hands back rather than auto-resuming.
 */
export function resolveParkReset(reportedResetsAt: number, isRateLimitPark: boolean, limitType: string, text: string, now: number, estimateMs: number): { resetsAt: number; limitType: string } {
	if (reportedResetsAt > 0) return { resetsAt: reportedResetsAt, limitType };
	const parsed = parseResetTime(text);
	if (parsed) return { resetsAt: parsed, limitType };
	if (isRateLimitPark) return { resetsAt: now + estimateMs, limitType: `${limitType} (estimated)` };
	return { resetsAt: 0, limitType };
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

// `--item` on an already-claimed id is refused by pick's worktree-exists guard (#56) — the
// working re-entry path is `--resume <id>`, one process per id. `--resume` doesn't accept a
// list, so multiple parked items print one hint line each.
export function formatResumeHint(ids: string[]): string {
	return ids.map((id) => `pnpm pelaggio --resume ${id}`).join("\n          ");
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
