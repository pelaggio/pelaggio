/** Git plumbing for the main checkout and worktrees (L1): shas, checkpoints, diffs, worktree lookup. */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { REPO, WORKTREE_PREFIX } from "./config.js";
import type { CycleGitBinding } from "./types.js";

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

// ── git argv plumbing (shared with ship/freshness) ──

/** Argv Git invoker. Same `(args, cwd) => string` shape as `GitExec` in review/seats.ts. */
export type GitArgvExec = (args: readonly string[], cwd: string) => string;

export const defaultGitArgvExec: GitArgvExec = (args, cwd) => execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

const FRESHNESS_DETAIL_CAP = 300;

function gitArgvDetail(error: unknown): string {
	const err = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
	const stderr = typeof err.stderr === "string" ? err.stderr : Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf-8") : "";
	const stdout = typeof err.stdout === "string" ? err.stdout : Buffer.isBuffer(err.stdout) ? err.stdout.toString("utf-8") : "";
	return (stderr + stdout || err.message || String(error)).trim().slice(0, FRESHNESS_DETAIL_CAP);
}

export function tryGitArgv(run: GitArgvExec, args: readonly string[], cwd: string): { ok: true; out: string } | { ok: false; detail: string } {
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

export function hasMergeHead(run: GitArgvExec, cwd: string): boolean {
	return tryGitArgv(run, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd).ok;
}

export function unmergedPaths(run: GitArgvExec, cwd: string): string[] {
	return gitNameOnly(run, ["diff", "--name-only", "--diff-filter=U"], cwd);
}

export function porcelainStatus(run: GitArgvExec, cwd: string): { ok: true; dirty: boolean } | { ok: false; detail: string } {
	const result = tryGitArgv(run, ["status", "--porcelain"], cwd);
	if (!result.ok) return { ok: false, detail: result.detail || "git status --porcelain failed" };
	return { ok: true, dirty: result.out !== "" };
}

export function resolveOriginMainOid(run: GitArgvExec, cwd: string): string | null {
	const result = tryGitArgv(run, ["rev-parse", "--verify", "origin/main"], cwd);
	return result.ok && result.out !== "" ? result.out : null;
}

export function oidIsAncestorOfHead(run: GitArgvExec, cwd: string, oid: string): boolean {
	return tryGitArgv(run, ["merge-base", "--is-ancestor", oid, "HEAD"], cwd).ok;
}

export function upstreamTouchedFrom(run: GitArgvExec, cwd: string, incomingRef: string): string[] {
	// Three-dot: only files touched on the upstream side since the merge-base. Two-dot
	// (`HEAD..ref`) diffs the endpoint trees, so the branch's own files leak into the
	// "Upstream-touched files" list fed to the author.
	return gitNameOnly(run, ["diff", "--name-only", `HEAD...${incomingRef}`], cwd);
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
