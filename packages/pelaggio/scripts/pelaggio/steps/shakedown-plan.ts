/** The `shakedown-plan` step (plan step 9): one reviewer seat over the plan; yields the verdict the implement prompt reads. Moved verbatim from `runPipeline`; see `steps/context.ts`. */
import { CONFIG, resolveStepSettings } from "../config.js";
import { parseVerdict } from "../cycle-outcome.js";
import type { DriverAssignmentState } from "../driver-assignment.js";
import { selectReviewers } from "../driver-assignment.js";
import type { RoadmapSource } from "../roadmap/index.js";
import { buildStepArgs, expandSkill } from "../skills.js";
import type { StepLog } from "../types.js";
import type { CycleHelpers, StepOutcome } from "./context.js";

/** Exactly the cycle state `runShakedownPlan` reads — a step that needs more must widen this type, visibly. */
/** The cycle bindings `runShakedownPlan` reads — plain values, built by the cycle at the call site. */
export interface ShakedownPlanInput {
	readonly roadmap: RoadmapSource;
	readonly assignment: DriverAssignmentState;
	readonly steps: readonly StepLog[];
	readonly itemId: string;
	readonly profile: string;
}
/** Exactly the cycle helpers `runShakedownPlan` calls. */
export type ShakedownPlanDeps = Pick<CycleHelpers, "available" | "log" | "finish" | "runStepWithRetry" | "driverCandidates" | "cost">;

export async function runShakedownPlan(ctx: ShakedownPlanInput, helpers: ShakedownPlanDeps): Promise<StepOutcome<{ verdict: "APPROVE" | "REVISE" | "RETHINK"; shakedownPlanText: string }>> {
	const { roadmap, assignment, steps, itemId, profile } = ctx;
	const { available, log, finish, runStepWithRetry, driverCandidates } = helpers;
	const planAuthor = assignment.authors.plan;
	if (!planAuthor) return { kind: "terminal", result: finish({ itemId, completed: false, cost: helpers.cost(), error: "shakedown-plan assignment failed: plan author attribution is unavailable" }) };
	const selected = selectReviewers(assignment, driverCandidates("shakedown-plan"), planAuthor, 1, available);
	if (!selected.ok) return { kind: "terminal", result: finish({ itemId, completed: false, cost: helpers.cost(), error: `shakedown-plan assignment failed: ${selected.reason}` }) };
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
	if (verdict === "RETHINK") return { kind: "terminal", result: finish({ itemId, completed: false, cost: helpers.cost(), verdict, error: "plan needs rethink" }) };
	return { kind: "continue", verdict, shakedownPlanText };
}
