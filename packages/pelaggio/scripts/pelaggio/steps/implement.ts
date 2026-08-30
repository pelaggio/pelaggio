/** The `implement` step (plan step 9): plan-driven or findings-driven implementation with the retry/edit-loop policy, then findings archival. Moved verbatim from `runPipeline`; see `steps/context.ts` for the seam. */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG, REPO, resolveStepSettings } from "../config.js";
import { computeImplementTurns } from "../cycle-support.js";
import type { DriverAssignmentState } from "../driver-assignment.js";
import { recordArtifactAuthor, selectAuthor } from "../driver-assignment.js";
import { getHeadSha } from "../git.js";
import { registerPath } from "../registers.js";
import { archiveAppliedReviewFindings, reviewFindingsDigest } from "../review-findings-archive.js";
import { reviseFindingsPath } from "../revise-sweep.js";
import type { RoadmapSource } from "../roadmap/index.js";
import { reviewFindingsPreamble } from "../skills.js";
import type { Flags } from "../types.js";
import type { CycleHelpers, StepOutcome } from "./context.js";

export function archiveReviewFindingsAfterImplement(
	flags: Flags,
	mainRepo: string,
	itemId: string,
	findingsSha256: string,
	appliedOnSha: string,
	deps: { archive?: typeof archiveAppliedReviewFindings } = {},
): { ok: true } | { ok: false; path: string; detail: string } {
	const findingsPath = flags["review-findings"];
	if (!findingsPath) return { ok: true };

	const ownedFindingsPath = reviseFindingsPath(mainRepo, itemId);
	if (resolve(findingsPath) === ownedFindingsPath) {
		try {
			(deps.archive ?? archiveAppliedReviewFindings)(mainRepo, itemId, findingsSha256, appliedOnSha, ownedFindingsPath);
		} catch (err) {
			return { ok: false, path: ownedFindingsPath, detail: err instanceof Error ? err.message : String(err) };
		}
	}
	delete flags["review-findings"];
	return { ok: true };
}

/** Exactly the cycle state `runImplement` reads — a step that needs more must widen this type, visibly. */
/** The cycle bindings `runImplement` reads — plain values, built by the cycle at the call site. */
export interface ImplementInput {
	readonly flags: Flags;
	readonly mainRepo: string;
	readonly roadmap: RoadmapSource;
	readonly assignment: DriverAssignmentState;
	readonly itemId: string;
	readonly worktree: string;
	readonly profile: string;
	readonly verdict: "APPROVE" | "REVISE" | "RETHINK";
	readonly shakedownPlanText: string;
}
/** Exactly the cycle helpers `runImplement` calls. */
export type ImplementDeps = Pick<CycleHelpers, "available" | "log" | "finish" | "parkExit" | "runStepWithRetry" | "driverCandidates" | "cost"> & {
	/** Notified after review findings were applied and archived. */
	readonly onReviewFindingsConsumed?: (itemId: string) => void;
};

export async function runImplement(ctx: ImplementInput, helpers: ImplementDeps): Promise<StepOutcome> {
	const { flags, mainRepo, roadmap, assignment, itemId, worktree, profile, verdict, shakedownPlanText } = ctx;
	const { available, log, finish, parkExit, runStepWithRetry, driverCandidates } = helpers;
	const selected = selectAuthor(assignment, driverCandidates("implement"), available);
	if (!selected.ok) return { kind: "terminal", result: finish({ itemId, completed: false, cost: helpers.cost(), error: `implement assignment failed: ${selected.reason}` }) };
	const implementationAuthor = selected.drivers[0];
	const parked = parkExit();
	if (parked) return { kind: "terminal", result: parked };
	const planPath = await roadmap.getItemPlan({ worktree: worktree! });
	// Dynamic implement budget: scale turns with the plan's file count.
	// Plan absent (e.g. quick mode, resume without plan on disk) → static fallback.
	let planBody: string | null = null;
	if (planPath) {
		try {
			planBody = readFileSync(planPath, "utf-8");
		} catch {
			planBody = null;
		}
	}
	const implementTurns = computeImplementTurns(planBody, resolveStepSettings(CONFIG, profile, "implement").turns);
	const planRef = planPath ? `Read the plan at \`${planPath}\`.` : `Find the plan in \`${registerPath(REPO, "plans")}/\` (filename matches branch without \`feat/\` prefix).`;
	const worktreeHint = [
		`**Your working directory is**: \`${worktree}\`.`,
		`Any path the plan writes as \`foo/bar\` (project-relative) means \`${worktree}/foo/bar\` — use that absolute form when calling Edit/Write/Bash, so the worktree-isolation hook does not mistake it for a main-repo reference.`,
	].join("\n");

	// Revision input (issue #60): on a resume driven by a red PR review, `--review-findings <path>`
	// points at a findings file the closed-loop workflow wrote. Fail closed when that explicit
	// input cannot be read: continuing would silently ask the worker to revise without its task.
	let reviewNote = "";
	const findingsPath = flags["review-findings"];
	let findingsSha256: string | undefined;
	// Any DEFINED value is a findings-driven resume — `--review-findings ""` must not
	// slip past a truthiness check into the generic plan prompt.
	if (findingsPath !== undefined && findingsPath.trim() === "") {
		return { kind: "terminal", result: finish({ itemId, completed: false, cost: helpers.cost(), error: "empty --review-findings path — refusing a findings-driven resume without findings" }) };
	}
	if (findingsPath) {
		try {
			const findingsBytes = readFileSync(findingsPath);
			findingsSha256 = reviewFindingsDigest(findingsBytes);
			reviewNote = reviewFindingsPreamble(findingsBytes.toString("utf-8"));
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			return { kind: "terminal", result: finish({ itemId, completed: false, cost: helpers.cost(), error: `could not read review findings ${JSON.stringify(findingsPath)}: ${detail}` }) };
		}
		// A readable but empty/whitespace-only findings file yields no preamble; the
		// prompt selection below would silently fall back to the generic plan prompt
		// and revise without its task. Same failure class as unreadable — fail closed.
		if (!reviewNote) {
			return { kind: "terminal", result: finish({ itemId, completed: false, cost: helpers.cost(), error: `review findings ${JSON.stringify(findingsPath)} is empty — refusing a findings-driven resume without findings` }) };
		}
	}

	const buildRevisionPrompt = (continued: boolean): string =>
		[
			worktreeHint,
			...(continued ? ["", "The previous implementation session ran out of turns. Code has been committed to disk. Continue the revision from the current worktree state."] : []),
			"",
			reviewNote,
			"",
			"## Plan context",
			planRef,
			"The plan is historical context for the branch. Use it to understand intended scope, but do not let it override the review findings.",
			"",
			"## CRITICAL — revise the already-implemented branch",
			"Do not no-op because the approved plan appears complete. The deliverable is a branch that resolves the review findings.",
			"Do NOT edit the plan file itself to refine wording or add detail. Edit the target code/docs named by the findings and any directly related files needed for a correct fix.",
			"Before finishing, confirm `git diff --name-only main...HEAD` lists target files, not only `docs/plans/*`.",
			"",
			"## Verification strategy",
			"1. Read the review findings first and identify every blocking item.",
			"2. Inspect the named files and related code before editing.",
			"3. Implement one logical fix at a time, then run the verification commands from `.claude/skills/_rubric.md`'s Verification section.",
			"4. If the same error persists after 3 fix attempts, commit what works, skip the problematic piece, and note it.",
			"5. Run all verification commands from the rubric before finishing.",
		].join("\n");

	const buildPlanPrompt = (continued: boolean): string => {
		if (profile === "quick") {
			const quickBase = `${worktreeHint}\n\nThis is a small-scope item (bug fix or scope S). Implement it directly — no formal plan needed. Read the roadmap entry for ${itemId} to understand the requirements. Edit the target files the roadmap names; do NOT create or edit a plan file.`;
			return continued
				? `${worktreeHint}\n\nThe previous implementation session ran out of turns. Code has been committed to disk.\n\nContinue the small-scope implementation from the current worktree state. Do NOT create or edit a plan file. Run all verification commands from the rubric before finishing.`
				: quickBase;
		}
		return [
			worktreeHint,
			...(continued ? ["", "The previous implementation session ran out of turns. Code has been committed to disk."] : []),
			"",
			continued ? "" : verdict === "APPROVE" ? "Plan approved." : `Shakedown requested revisions:\n${shakedownPlanText.slice(0, 2000)}${shakedownPlanText.length > 2000 ? "\n...(truncated)" : ""}\nAddress the feedback, then implement.`,
			"",
			"## Plan",
			planRef,
			"",
			"## CRITICAL — execute the plan, do not polish it",
			continued
				? "The plan file is your **reference only**. Your deliverables are the **target files the plan names**. Do NOT edit the plan file itself to refine wording — that is not progress. Before finishing, confirm `git diff --name-only main...HEAD` lists target files, not only `docs/plans/*`."
				: "The plan file is your **reference only**; it is already approved and locked. Your deliverables are the **target files the plan names** (look for a `Files to change` table or file paths under headings). Do NOT edit the plan file itself to refine wording or add detail — that is not progress, it is plan-polishing and it will fail the cycle.",
			...(continued ? [] : ["Before finishing, confirm `git diff --name-only main...HEAD` lists target files, not only `docs/plans/*`."]),
			"",
			continued ? "## Instructions" : "## Strategy — work incrementally",
			...(continued
				? [
						"1. Run the verification commands from `.claude/skills/_rubric.md`'s Verification section to see the current state.",
						"2. Read the plan and compare against what's already implemented.",
						"3. Identify what's missing or broken and finish the remaining work.",
						"4. Follow the same incremental strategy — one chunk at a time, verify between.",
						"5. Run all verification commands from the rubric before finishing.",
					]
				: [
						"1. Read the full plan first. Identify the target files and the implementation order.",
						"2. Implement one logical chunk at a time (e.g., one target file, one new function, one section). For doc-only items the 'chunk' is a specific file or section edit.",
						"3. After each chunk, run the verification commands from `.claude/skills/_rubric.md`'s Verification section. Fix errors before moving on.",
						"4. If the same error persists after 3 fix attempts, commit what works, skip the problematic piece, and note it.",
						"5. Run all verification commands from the rubric before finishing.",
						"6. Do NOT implement all files first and verify at the end — that causes cascading errors.",
					]),
		].join("\n");
	};

	const implementPrompt = reviewNote ? buildRevisionPrompt(false) : buildPlanPrompt(false);
	const continuePrompt = reviewNote ? buildRevisionPrompt(true) : buildPlanPrompt(true);

	const outcome = await runStepWithRetry({
		name: "implement",
		stepBudget: resolveStepSettings(CONFIG, profile, "implement").budget,
		maxTurnsOverride: implementTurns,
		retryOnEditLoop: true,
		refusedError: "implement refused (model declined the task)",
		logAttempt: (attempt) => log(attempt === 1 ? "implementing..." : "continuing implementation (attempt 2)..."),
		effects: (attempt) => [{ kind: "checkpoint", label: attempt === 1 ? "implementation checkpoint" : "implementation continued" }],
		buildPrompt: (attempt, { lastLoopFile }) => {
			if (attempt === 1) return implementPrompt;
			return lastLoopFile
				? [
						continuePrompt,
						"",
						`## ⚠ IMPORTANT: The previous session got stuck editing \`${lastLoopFile}\` in a loop.`,
						"Take a DIFFERENT approach to fix the type errors:",
						"- Read the file and the actual error message carefully before editing",
						"- Consider if the type/interface needs to change upstream instead",
						"- If a component prop type is wrong, fix the type definition, not the call site repeatedly",
						"- If stuck after 2 attempts on the same error, skip it and move on",
					].join("\n")
				: continuePrompt;
		},
		executionOverride: implementationAuthor,
	});
	if (outcome.kind === "terminal") return { kind: "terminal", result: outcome.cycleResult };
	if (findingsPath && findingsSha256) {
		// Archive the canonical findings only after the implement checkpoint commits.
		// A failed or parked implement returns above and leaves the source in place for retry;
		// an operator-supplied path remains caller-owned.
		try {
			const pending = execSync("git status --porcelain", { cwd: worktree!, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
			if (pending) {
				return {
					kind: "terminal",
					result: finish({
						itemId,
						completed: false,
						cost: helpers.cost(),
						error: "review findings were applied but the implementation checkpoint did not commit cleanly; findings preserved for retry",
					}),
				};
			}
		} catch (err) {
			return {
				kind: "terminal",
				result: finish({
					itemId,
					completed: false,
					cost: helpers.cost(),
					error: `review findings were applied but the implementation checkpoint could not be verified: ${err instanceof Error ? err.message : String(err)}; findings preserved for retry`,
				}),
			};
		}
		const appliedOnSha = getHeadSha(worktree!);
		if (!appliedOnSha) {
			return {
				kind: "terminal",
				result: finish({
					itemId,
					completed: false,
					cost: helpers.cost(),
					error: "review findings were applied but the revision HEAD could not be read; findings preserved for a fail-closed retry",
				}),
			};
		}
		const archived = archiveReviewFindingsAfterImplement(flags, mainRepo, itemId!, findingsSha256, appliedOnSha);
		if (!archived.ok) {
			return {
				kind: "terminal",
				result: finish({
					itemId,
					completed: false,
					cost: helpers.cost(),
					error: `review findings were applied but archival failed for ${JSON.stringify(archived.path)}: ${archived.detail}; implementation checkpoint and findings were preserved`,
				}),
			};
		}
		helpers.onReviewFindingsConsumed?.(itemId);
	}
	recordArtifactAuthor(assignment, "implementation", implementationAuthor);
	return { kind: "continue" };
}
