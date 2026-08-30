/** The `shakedown-plan` step (plan step 9): one reviewer seat over the plan; yields the verdict the implement prompt reads. Moved verbatim from `runPipeline`; see `steps/context.ts`. */
import { CONFIG, resolveStepSettings } from "../config.js";
import { parseVerdict } from "../cycle-outcome.js";
import { selectReviewers } from "../driver-assignment.js";
import { buildStepArgs, expandSkill } from "../skills.js";
import type { CycleContext, CycleHelpers, StepOutcome } from "./context.js";

export async function runShakedownPlan(ctx: CycleContext, helpers: CycleHelpers): Promise<StepOutcome<{ verdict: "APPROVE" | "REVISE" | "RETHINK"; shakedownPlanText: string }>> {
	const { roadmap, assignment, available, steps, itemId, profile } = ctx;
	const { log, finish, runStepWithRetry, driverCandidates } = helpers;
	const planAuthor = assignment.authors.plan;
	if (!planAuthor) return { kind: "terminal", result: finish({ itemId, completed: false, cost: ctx.cost(), error: "shakedown-plan assignment failed: plan author attribution is unavailable" }) };
	const selected = selectReviewers(assignment, driverCandidates("shakedown-plan"), planAuthor, 1, available);
	if (!selected.ok) return { kind: "terminal", result: finish({ itemId, completed: false, cost: ctx.cost(), error: `shakedown-plan assignment failed: ${selected.reason}` }) };
	const shakedownPlanArgs = await buildStepArgs(roadmap, itemId!, "plan-review");
	const outcome = await runStepWithRetry({
		name: "shakedown-plan",
		stepBudget: resolveStepSettings(CONFIG, profile, "shakedown-plan").budget,
		buildPrompt: () => expandSkill("shakedown", shakedownPlanArgs),
		logAttempt: (attempt) => log(attempt === 1 ? "shakedown (plan)..." : "continuing shakedown-plan (attempt 2)..."),
		refusedError: "shakedown-plan refused (model declined the review)",
		executionOverride: selected.drivers[0],
	});
	if (outcome.kind === "terminal") return { kind: "terminal", result: outcome.cycleResult };

	const shakedown = outcome.result;
	const verdict = parseVerdict(shakedown.text);
	const shakedownPlanText = shakedown.text;
	const lastStep = steps[steps.length - 1];
	if (lastStep && lastStep.name === "shakedown-plan") lastStep.verdict = verdict;
	log(`verdict: ${verdict}`);
	if (verdict === "RETHINK") return { kind: "terminal", result: finish({ itemId, completed: false, cost: ctx.cost(), verdict, error: "plan needs rethink" }) };
	return { kind: "continue", verdict, shakedownPlanText };
}
