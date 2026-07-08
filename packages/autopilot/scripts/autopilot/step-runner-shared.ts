import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { Step } from "./types.js";

export const EDIT_LOOP_THRESHOLD = 22;

// Steps whose entire job is iteratively editing the plan document. The raw-edit
// loop guard would false-positive on legitimate refinement passes, so it is
// skipped here. Steps editing code (`implement`, `shakedown-code`) keep it.
export const EDIT_LOOP_EXEMPT_STEPS: ReadonlySet<Step> = new Set(["plan", "shakedown-plan"]);

// Autonomy framing: rides on every model call for every step. Terse on purpose
// — this is a per-call token cost on every provider.
const AUTONOMY_APPEND = [
	"",
	"## Operating autonomously",
	"You are operating autonomously inside a headless pipeline. Nobody is watching in real time and nobody can answer questions mid-step, so ending your turn with a question stalls the step. For minor choices (naming, formatting, defaults, which of two equivalent approaches), pick a reasonable option and note it in your final message. End your turn only when the step is complete or you are genuinely blocked — and if blocked, state precisely what is missing rather than asking permission to proceed.",
	"If you genuinely cannot complete the step, make the final line of your reply exactly `BLOCKED: <one-line reason — what is missing>` with nothing after it, instead of asking a question or offering options. Completing the step normally needs no sentinel.",
].join("\n");

/** True when `cwd` is a sibling worktree, not the main repo. Exported for testing. */
export function isWorktreePath(cwd: string, repo: string): boolean {
	return resolve(cwd) !== resolve(repo);
}

/** Composes the per-step system-prompt append. The autonomy block is
 * unconditional; the worktree-isolation and plan-polish blocks layer on when
 * their conditions hold. Exported for testing. */
export function composeSystemAppend(args: { isWorktree: boolean; cwd: string; repo: string; planBlockActive: boolean }): string {
	const worktreeAppend = args.isWorktree
		? [
				"",
				"## CRITICAL: Worktree isolation",
				`Your working directory is a git worktree at: ${args.cwd}`,
				`The main repository is at: ${args.repo}`,
				"You MUST use relative paths or paths under your working directory for ALL file operations.",
				`NEVER use absolute paths starting with ${args.repo}/ — those point to the main worktree and will corrupt another workspace.`,
				"Use $PWD-relative paths, or resolve from your cwd. The codebase in your worktree is identical — read and write here.",
			].join("\n")
		: undefined;

	const planAppend = args.planBlockActive
		? [
				"",
				"## CRITICAL: Do not edit the plan",
				"Files under `docs/plans/` are READ-ONLY for this step. Your job is to EXECUTE the plan by writing code to other files — not to polish, clarify, or extend the plan document itself.",
				"Writes to `docs/plans/*` will be blocked by a hook. If you believe the plan is wrong, stop and surface the issue in your final message instead of editing around it.",
			].join("\n")
		: undefined;

	return [AUTONOMY_APPEND, worktreeAppend, planAppend].filter(Boolean).join("\n");
}

// ── Worktree write-confinement ─────────────────────────────────────────
//
// A single source of "what a tool touches" (`mutationTargets`) feeds two layers:
// the `PreToolUse` hook (`worktreeConfinementBlock`, prevention) and the post-step
// filesystem assertion (`snapshotPath`/`confinementViolations`, the hard backstop).
// The boundary is *forbidden roots* — the main repo and every sibling worktree,
// real-path resolved — so sibling / relative / `$HOME` / `cd ../` / symlink spellings
// all resolve to the same real path and are caught.

/** realpathSync that degrades to the input on ENOENT/EACCES (never throws). */
export function safeRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

// Built by concatenation, not written as a literal `"${HOME}"`, so biome's
// noTemplateCurlyInString doesn't false-positive on legitimate shell-variable syntax.
const HOME_BRACE = "$" + "{HOME}";

/** Expand a leading `~`, `$HOME`, or `${HOME}` (bare or followed by `/`) to `home`.
 * Precise on purpose: `$HOMEFOO` is not a home reference and is left untouched. */
function expandHome(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return home + p.slice(1);
	if (p === "$HOME") return home;
	if (p.startsWith("$HOME/")) return home + p.slice("$HOME".length);
	if (p === HOME_BRACE) return home;
	if (p.startsWith(HOME_BRACE + "/")) return home + p.slice(HOME_BRACE.length);
	return p;
}

/** realpath the longest *existing* ancestor, then re-append the not-yet-created
 * tail. Resolving only the existing prefix defeats a symlinked ancestor while
 * still resolving a path whose leaf doesn't exist yet (a file about to be created). */
function realpathLongestPrefix(abs: string): string {
	let existing = abs;
	const tail: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) break; // reached filesystem root
		tail.unshift(basename(existing));
		existing = parent;
	}
	const realBase = safeRealpath(existing);
	return tail.length ? join(realBase, ...tail) : realBase;
}

/** Resolve a tool-supplied path candidate to a canonical real path: expand a
 * leading home reference, resolve relatives against `base` (the worktree cwd),
 * then realpath the existing prefix. `home` is injectable for deterministic tests. */
export function realResolve(candidate: string, base: string, home: string = homedir()): string {
	const expanded = expandHome(candidate, home);
	const abs = isAbsolute(expanded) ? expanded : resolve(base, expanded);
	return realpathLongestPrefix(abs);
}

/** Path-like tokens from a Bash command: split on whitespace and shell separators,
 * strip surrounding quotes, keep tokens that look like paths (contain `/` or start
 * with `~`). Non-path words resolve inside the worktree and are harmless to drop.
 * Dynamically-constructed targets (`> $(cat f)`) are untokenizable — a known residual. */
function bashPathTokens(command: string): string[] {
	const tokens: string[] = [];
	for (const raw of command.split(/[\s;|&()<>]+/)) {
		const tok = raw.replace(/^['"]+/, "").replace(/['"]+$/, "");
		if (!tok) continue;
		if (tok.includes("/") || tok.startsWith("~")) tokens.push(tok);
	}
	return tokens;
}

/** The file paths a single tool call would mutate — the single source of tool→path
 * knowledge shared by the hook and the backstop. Read-only tools and `Agent`
 * sub-agent spawns carry no inspectable target (the latter is a known residual). */
export function mutationTargets(toolName: string, toolInput: Record<string, unknown>): string[] {
	switch (toolName) {
		case "Write":
		case "Edit":
		case "MultiEdit": {
			const fp = String(toolInput.file_path ?? "");
			return fp ? [fp] : [];
		}
		case "NotebookEdit": {
			const np = String(toolInput.notebook_path ?? "");
			return np ? [np] : [];
		}
		case "Bash": {
			const cmd = String(toolInput.command ?? "");
			return cmd ? bashPathTokens(cmd) : [];
		}
		default:
			return [];
	}
}

/** The matched forbidden root if `realPath` is inside one, else null. Boundary-correct:
 * `real === root || real.startsWith(root + sep)` so `/w/repo` does not match the
 * sibling `/w/repo-105` (mirrors the `mainAbs` trailing-slash trick it replaces). */
export function insideAny(realPath: string, roots: readonly string[]): string | null {
	for (const root of roots) {
		if (realPath === root || realPath.startsWith(root + sep)) return root;
	}
	return null;
}

/** The context a `worktreeConfinementBlock` decision needs: the worktree cwd
 * (base for relatives + the message's "write here") and the forbidden roots. */
export interface ConfinementCtx {
	worktreeCwd: string;
	forbiddenRoots: readonly string[];
	/** Injectable home for tests; defaults to `os.homedir()` via `realResolve`. */
	home?: string;
}

/** The `PreToolUse` confinement decision — mirrors `blockPlanPolish` /
 * `blockWorktreeInstall`. Blocks when any mutation target's real path lands inside
 * a forbidden root. Extracting this from the inline hook closure is what makes the
 * block branches unit-testable. */
export function worktreeConfinementBlock(input: HookInput, ctx: ConfinementCtx): HookJSONOutput {
	const tn = "tool_name" in input ? String(input.tool_name) : "";
	const ti = ("tool_input" in input ? input.tool_input : {}) as Record<string, unknown>;
	for (const cand of mutationTargets(tn, ti)) {
		const real = realResolve(cand, ctx.worktreeCwd, ctx.home);
		const root = insideAny(real, ctx.forbiddenRoots);
		if (root) {
			return {
				decision: "block" as const,
				reason: `Path "${cand}" resolves to "${real}", which is inside another workspace ("${root}"). Write only inside this worktree (${ctx.worktreeCwd}).`,
			};
		}
	}
	return {};
}

/** A cheap identity of a path for change detection: existence + mtime + size. */
export interface PathSnapshot {
	exists: boolean;
	mtimeMs: number;
	size: number;
}

/** Snapshot a path's current state (fs). A missing path snapshots as `exists:false`. */
export function snapshotPath(p: string): PathSnapshot {
	try {
		const s = statSync(p);
		return { exists: true, mtimeMs: s.mtimeMs, size: s.size };
	} catch {
		return { exists: false, mtimeMs: 0, size: 0 };
	}
}

/** True iff the path was created, deleted, or its mtime/size changed (pure). */
export function snapshotChanged(before: PathSnapshot, after: PathSnapshot): boolean {
	if (before.exists !== after.exists) return true;
	if (!before.exists && !after.exists) return false;
	return before.mtimeMs !== after.mtimeMs || before.size !== after.size;
}

/** Re-stat every baselined foreign path and return those that changed during the
 * step — i.e. paths an escape actually created or modified. */
export function confinementViolations(baselines: ReadonlyMap<string, PathSnapshot>): string[] {
	const violations: string[] = [];
	for (const [p, before] of baselines) {
		if (snapshotChanged(before, snapshotPath(p))) violations.push(p);
	}
	return violations;
}
