/** The `plan` step (plan step 9): reuse an existing plan or author one, then plan-time decomposition. Moved verbatim from `runPipeline`; see `steps/context.ts`. */
import { existsSync } from "node:fs";
import { CONFIG, resolveStepSettings } from "../config.js";
import { recordArtifactAuthor, selectAuthor } from "../driver-assignment.js";
import { parseDeferredItems } from "../pick-parse.js";
import { buildStepArgs, expandSkill } from "../skills.js";
import type { CycleContext, CycleHelpers, StepOutcome } from "./context.js";

/** Exactly the cycle state `runPlan` reads — a step that needs more must widen this type, visibly. */
export type PlanInput = Pick<CycleContext, "opts" | "roadmap" | "assignment" | "available" | "deferredItemTitles" | "itemId" | "worktree" | "profile" | "cost">;
/** Exactly the cycle helpers `runPlan` calls. */
export type PlanDeps = Pick<CycleHelpers, "log" | "finish" | "runStepWithRetry" | "driverCandidates" | "reconstructAuthor">;

export async function runPlan(ctx: PlanInput, helpers: PlanDeps): Promise<StepOutcome> {
	const { opts, roadmap, assignment, available, deferredItemTitles, itemId, worktree, profile } = ctx;
	const { log, finish, runStepWithRetry, driverCandidates, reconstructAuthor } = helpers;
	const existingPlan = roadmap.resolvePlanPath({ id: itemId!, worktree: worktree! });
	if (!opts.dryRun && existsSync(existingPlan)) {
		log(`plan exists at ${existingPlan} — skipping plan generation`);
		reconstructAuthor("plan", "plan");
	} else {
		const selected = selectAuthor(assignment, driverCandidates("plan"), available);
		if (!selected.ok) return { kind: "terminal", result: finish({ itemId, completed: false, cost: ctx.cost(), error: `plan assignment failed: ${selected.reason}` }) };
		const planAuthor = selected.drivers[0];
		// Inject the item's requirements into the plan prompt in the harness (#103): a sandboxed
		// model (Codex) can't run `roadmap get` / `gh issue view` (no network, and the roadmap CLI
		// dies on tsx-IPC in the sandbox), so it would otherwise plan blind. The harness has an
		// injected RoadmapSource with network access — fetch here and pass it in.
		const planArgs = await buildStepArgs(roadmap, itemId!);
		const outcome = await runStepWithRetry({
			name: "plan",
			stepBudget: resolveStepSettings(CONFIG, profile, "plan").budget,
			buildPrompt: () => expandSkill("plan", planArgs),
			logAttempt: (attempt) => log(attempt === 1 ? "planning..." : "continuing plan (attempt 2)..."),
			refusedError: "plan refused (model declined the task)",
			effects: () => [{ kind: "checkpoint", label: "plan" }, { kind: "plan.publish" }],
			executionOverride: planAuthor,
		});
		if (outcome.kind === "terminal") return { kind: "terminal", result: outcome.cycleResult };
		recordArtifactAuthor(assignment, "plan", planAuthor);

		// Plan-time decomposition: a plan that judges the item too large for one cycle emits
		// `deferred-item: {json}` markers for the slices it splits off, and scopes THIS cycle to a
		// coherent first slice instead of starving at the implement turn wall. Decomposition is the
		// preferred path for large items; the raised implement turn ceiling is the escape hatch for
		// changes that don't decompose cleanly. Best-effort, mirrors the shakedown-code deferral (#115).
		if (!opts.dryRun) {
			for (const d of parseDeferredItems(outcome.result.assistantText, deferredItemTitles)) {
				try {
					const created = await roadmap.createItem(d);
					log(`plan deferred → ${created.id}: ${d.title}`);
				} catch (e) {
					log(`deferred-item create failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
				}
			}
		}
	}
	const planPath = await roadmap.getItemPlan({ worktree: worktree! });
	if (planPath) log(`plan: file://${planPath}`);
	return { kind: "continue" };
}
