import { resolve } from "node:path";
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
	"When a fork affects an invariant, security, cost, public API surface, or scope beyond M and a reviewer could reasonably veto it, emit `DECISION: <fork> | chose: <default> | alternatives: <other options>` and proceed with that default. `DECISION:` is non-halting and may appear multiple times. Do not flag routine implementation choices.",
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
