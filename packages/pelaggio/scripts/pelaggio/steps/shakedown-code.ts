/** The `shakedown-code` step (plan step 9): adversarial authoring review or single-reviewer shakedown, then deferred-item creation. Moved verbatim from `runPipeline`; see `steps/context.ts` for the seam. */
import { resolve } from "node:path";
import { CONFIG, LOG_PATH, modelForProvider, REPO, REVIEW_CONFIG, resolveStepSettings } from "../config.js";
import { buildReviewDiffBlock } from "../cycle-support.js";
import type { appendReviewEscalation as appendReviewEscalationDefault, lookupReviewEscalation as lookupReviewEscalationDefault } from "../decisions.js";
import { type ReviewEscalationAdjudication, reviewEscalationCommands } from "../decisions.js";
import type { DriverAssignmentState } from "../driver-assignment.js";
import { selectReviewers } from "../driver-assignment.js";
import type { dispatchStepEffects as dispatchStepEffectsDefault, writeEffectsManifest as writeEffectsManifestDefault } from "../effects.js";
import { type Effect, type EffectsContext, EffectsManifestError, type ReviewEscalationEffect, type ReviewSeatIdentity, type ReviewVerdictEffect } from "../effects.js";
import { getArtifactHeadSha, gitDiffNameOnly } from "../git.js";
import { parseDeferredItems } from "../pick-parse.js";
import { capabilityMapFrom, resolveAuthoringReviewConfig, resolveAuthoringReviewExecution } from "../provider-routing.js";
import { registerRelativePath } from "../registers.js";
import { runReviewLoop } from "../review/loop.js";
import { type ReviewRecord, renderReviewRecord, writeReviewRecord } from "../review/record.js";
import type { AuthoringReviewHostDependencyRepairResult } from "../review/seat-deps.js";
import { buildStepArgs, expandSkill } from "../skills.js";
import { getProvider, REGISTERED_PROVIDERS } from "../step-runner.js";
import type { ExecutionReceiptDescriptor, Flags, ParkSignal, PipelineOpts, StepLog, StepResult } from "../types.js";
import type { CycleHelpers, StepOutcome } from "./context.js";

/** Exactly the cycle state `runShakedownCode` reads — a step that needs more must widen this type, visibly. */
/** The cycle bindings `runShakedownCode` reads — plain values, built by the cycle at the call site. */
export interface ShakedownCodeInput {
	readonly flags: Flags;
	readonly parkSignal: ParkSignal;
	readonly mainRepo: string;
	readonly assignment: DriverAssignmentState;
	readonly steps: readonly StepLog[];
	/** Shared with the cycle; the step pushes receipts, never replaces the array. */
	readonly executionReceipts: ExecutionReceiptDescriptor[];
	readonly deferredItemTitles: Set<string>;
	readonly cycleChallenge: Buffer;
	readonly itemId: string;
	readonly worktree: string;
	readonly profile: string;
}
type ShakedownCodeDepNames =
	| "roadmap"
	| "available"
	| "log"
	| "finishFailed"
	| "parkExit"
	| "runStepWithRetry"
	| "step"
	| "driverCandidates"
	| "itemRunId"
	| "observeGitForReceipt"
	| "cost"
	| "addCost"
	| "prepareAuthoringReviewSeat"
	| "cleanupAuthoringReviewSeatsForSha";
/** Exactly the cycle helpers `runShakedownCode` calls. */
export type ShakedownCodeDeps = Pick<CycleHelpers, ShakedownCodeDepNames> & {
	/** Run options: carry `notifyDecision` and the ship target (callables), so they ride as a Dep. */
	readonly opts: PipelineOpts;
	/** Effects seam and escalation ledger, injected so tests can observe them. */
	readonly writeEffectsManifest: typeof writeEffectsManifestDefault;
	readonly dispatchStepEffects: typeof dispatchStepEffectsDefault;
	readonly appendReviewEscalation: typeof appendReviewEscalationDefault;
	readonly lookupReviewEscalation: typeof lookupReviewEscalationDefault;
};

export async function runShakedownCode(ctx: ShakedownCodeInput, helpers: ShakedownCodeDeps): Promise<StepOutcome<{ reviewRecordMarkdown: string | undefined }>> {
	const { flags, parkSignal, mainRepo, assignment, steps, executionReceipts, deferredItemTitles, cycleChallenge, itemId, worktree, profile } = ctx;
	const {
		opts,
		roadmap,
		available,
		log,
		finishFailed,
		parkExit,
		runStepWithRetry,
		step,
		driverCandidates,
		itemRunId,
		observeGitForReceipt,
		writeEffectsManifest,
		dispatchStepEffects,
		appendReviewEscalation,
		lookupReviewEscalation,
		prepareAuthoringReviewSeat,
		cleanupAuthoringReviewSeatsForSha,
	} = helpers;
	const hostDependencyParkReason = (result: Extract<AuthoringReviewHostDependencyRepairResult, { status: "park" }>, context: string): string =>
		[
			`authoring-review host dependency restoration parked ${context} (${result.reason}): ${result.detail}`,
			`preserved state: claim worktree ${worktree} will be checkpointed; MAIN links remain at the last repair state`,
			`resume: pnpm pelaggio --resume ${itemId}`,
		].join("\n");
	const hostDependencyVerificationFailure = (detail: string, context: string): string =>
		[
			`authoring-review host dependency restoration parked ${context} (verification-failed): ${detail}`,
			`preserved state: claim worktree ${worktree} will be checkpointed; MAIN links remain at the last repair state`,
			`resume: pnpm pelaggio --resume ${itemId}`,
		].join("\n");
	let reviewRecordMarkdown: string | undefined;
	const implementationAuthor = assignment.authors.implementation;
	if (!implementationAuthor) return { kind: "terminal", result: finishFailed("shakedown-code assignment failed: implementation author attribution is unavailable", "selection", { itemId, cost: helpers.cost() }) };
	const planPath = await roadmap.getItemPlan({ worktree: worktree! });
	// The retry (attempt 2) points at the plan file only — NOT "the roadmap entry", which a
	// sandboxed provider can't fetch (#103/#115); the plan already carries the scope.
	const shakedownPlanRef = planPath ? `Read the plan at \`${planPath}\` to understand the scope.` : `Find the plan in \`${resolve(REPO, "docs", "plans")}/\`.`;
	const shakedownCodeArgs = await buildStepArgs(roadmap, itemId!, "code-review");

	let shakedownResult: StepResult;
	if (REVIEW_CONFIG.authoring.enabled !== "off") {
		const reviewedSha = getArtifactHeadSha(worktree!);
		if (!reviewedSha) return { kind: "terminal", result: parkExit("adversarial review could not bind current HEAD")! };
		const existingEscalation = lookupReviewEscalation(worktree!, itemId!, reviewedSha);
		if (existingEscalation.state === "active") {
			const commands = reviewEscalationCommands(existingEscalation.id, existingEscalation.escalation);
			return { kind: "terminal", result: parkExit(`adversarial review escalation active\n${commands.proceedResolve}\n${commands.resume}\n${commands.blockResolve}`)! };
		}
		if (existingEscalation.state === "resolved-block" || existingEscalation.state === "invalid") return { kind: "terminal", result: parkExit(`adversarial review escalation ${existingEscalation.state}`)! };
		// A committed resolution remains untrusted policy input until an operator binds
		// this resume to its evidence. Issue #419 owns the successor authority design.
		if (existingEscalation.state === "resolved-proceed") {
			// Both sides must be present strings: a record missing its fingerprint and
			// an omitted flag are each undefined, and undefined must never satisfy the gate.
			const evidenceFp = existingEscalation.escalation.evidenceFingerprint;
			const ackFlag = flags["acknowledge-escalation"];
			if (typeof evidenceFp !== "string" || evidenceFp.length === 0) {
				return { kind: "terminal", result: parkExit("adversarial review escalation record lacks an evidence fingerprint — treated as active; re-escalate through the review loop")! };
			}
			if (typeof ackFlag !== "string" || ackFlag !== evidenceFp) {
				const commands = reviewEscalationCommands(existingEscalation.id, existingEscalation.escalation);
				return { kind: "terminal", result: parkExit(`adversarial review escalation active\n${commands.resume}`)! };
			}
		}
		if (existingEscalation.state === "resolved-proceed" && existingEscalation.escalation.hasSafetyBlocker) return { kind: "terminal", result: parkExit("adversarial review safety blocker")! };
		// Capability-aware fixed-seat resolution (#337): fill configured seats via settings
		// inheritance + capability matcher; fail before seat worktrees when ineligible.
		const authorSettings = implementationAuthor;
		const authorIdentity = {
			provider: authorSettings.provider,
			...(authorSettings.provider === "codex" ? (authorSettings.codexModel ? { model: authorSettings.codexModel } : {}) : authorSettings.model ? { model: authorSettings.model } : {}),
		};
		const seating = resolveAuthoringReviewConfig({
			config: CONFIG,
			profile,
			author: authorIdentity,
			capabilities: capabilityMapFrom(getProvider, REGISTERED_PROVIDERS),
		});
		if (!seating.ok) return { kind: "terminal", result: finishFailed(`shakedown-code assignment failed: ${seating.reason}`, "selection", { itemId, cost: helpers.cost() }) };
		const execution = resolveAuthoringReviewExecution(seating.policy, {
			// Orchestrator-computed evidence (CI/single-shot, daemon marker, multi-cycle,
			// headless). Fallback for direct callers keeps the legacy single-shot-only signal.
			unattendedSignals: opts.unattendedSignals ?? (opts.noWorktree === true ? ["CI/single-shot (--no-worktree)"] : []),
			suppressedSignals: opts.unattendedSignalSuppressions ?? [],
			// Keys mode validates the author revision seat's key with the same fail-closed
			// rule as Judge/reviewers — before any seat runs (#276 follow-up).
			author: seating.author,
			envAllowlist: CONFIG.security.envAllowlist,
		});
		if (!execution.ok) return { kind: "terminal", result: finishFailed(`shakedown-code execution context failed: ${execution.reason}`, "verification", { itemId, cost: helpers.cost() }) };
		if (!execution.enabled) return { kind: "terminal", result: finishFailed("shakedown-code execution context unexpectedly disabled the authoring loop", "verification", { itemId, cost: helpers.cost() }) };
		const policy = execution.policy;
		log(`authoring review capability realizations: ${JSON.stringify(seating.realizations)}`);
		// Attestation audit: every operator-attested suppression is logged at resolution time
		// so a run that used PELAGGIO_OPERATOR_ATTENDED is reconstructible from the cycle log.
		if (execution.suppressedSignals.length > 0) log(execution.suppressedSignals.join("; "));
		if (execution.softened.length > 0) log(`authoring review key-mode softening: ${execution.softened.join("; ")}`);
		// Hand every reviewer seat the actual branch diff so a single-turn seat that never runs
		// `git diff` (codex) still reviews real code instead of parroting the skill example.
		// Recomputed per pass inside the `review` prompt: the author revision seat advances HEAD
		// between passes, so a once-computed block would show pass 2+ reviewers pre-revision code.
		// Concurrent reviewer seats get isolated detached checkouts so they no longer race on
		// the shared artifact worktree's index.lock (#269). Author revisions stay on the real
		// worktree (they must commit). Seat SHAs are re-read from the artifact HEAD so a
		// post-revision pass reviews the new commit, not the pre-revision tree. Seats are
		// torn down after the loop. `git worktree add` is serialized (shared main-repo lock)
		// while the seat agents still fan out via Promise.allSettled once checkouts exist.
		let loop: Awaited<ReturnType<typeof runReviewLoop>> | undefined;
		if (existingEscalation.state === "resolved-proceed") {
			loop = undefined;
		} else {
			let seatPrepareChain: Promise<void> = Promise.resolve();
			const preparedSeatShas = new Set<string>([reviewedSha]);
			let cleanupParkReason: string | undefined;
			let loopFailure: { error: unknown } | undefined;
			try {
				loop = await runReviewLoop({
					policy,
					author: authorIdentity,
					parkSignal,
					// Plain changed-file list for emission-time classification; path signals are derived pure-side.
					classificationContext: { changedFiles: gitDiffNameOnly(worktree!) },
					// Resolved ADR-0016 taxonomy: the deterministic safety floor consulted by the loop.
					taxonomy: REVIEW_CONFIG.taxonomy,
					runSeat: async ({ role, slot, pass, prompt, parkSignal: child }) => {
						const executionOverride = { provider: slot.provider, ...(slot.provider === "codex" ? (slot.codexModel ? { codexModel: slot.codexModel } : {}) : slot.model ? { model: slot.model } : {}) };
						if (role === "author") {
							return step("shakedown-code", prompt, worktree!, {
								attempt: pass,
								parkSignalOverride: child,
								executionOverride,
								commitLabel: "adversarial review revision",
							});
						}
						// Reviewer + Judge: cold seats pinned to the artifact HEAD at seat start
						// (post-revision pass 2 must not re-review the pre-revision tree).
						// Do NOT pass ownWorktree: artifact — confinement is change-based;
						// exempting the artifact would let a seat mutate it unaudited. Peer
						// seats are skipped via isEphemeralReviewWorktree in forbiddenRootsForStep.
						const prepare = seatPrepareChain.then(() => {
							const seatSha = getArtifactHeadSha(worktree!) ?? reviewedSha;
							preparedSeatShas.add(seatSha);
							return prepareAuthoringReviewSeat(mainRepo, { sha: seatSha, seatId: slot.id, pass });
						});
						seatPrepareChain = prepare.then(
							() => undefined,
							() => undefined,
						);
						let seatCwd: string;
						try {
							seatCwd = await prepare;
						} catch (e) {
							const message = e instanceof Error ? e.message : String(e);
							log(`⚠ authoring review seat prepare failed (${slot.id} p${pass}): ${message}`);
							return { ok: false, subtype: "error", text: `authoring review seat prepare failed: ${message}`, fullText: "", assistantText: "", cost: 0, turns: 0 };
						}
						return step(role === "reviewer" ? "pr-review" : "pr-verify", prompt, seatCwd, {
							attempt: pass,
							parkSignalOverride: child,
							executionOverride,
						});
					},
					prompts: {
						review: () => `${expandSkill("pr-review", "--authoring-loop")}\n\n${buildReviewDiffBlock(worktree!)}`,
						judge: (candidates) => `${expandSkill("pr-verify", "--authoring-loop-judge")}\n\nTRUSTED_CANDIDATE_DATA\n${JSON.stringify(candidates)}\nEND_TRUSTED_CANDIDATE_DATA`,
						revise: (survivors) => `${expandSkill("shakedown", shakedownCodeArgs)}\n\nThe Judge retained these blockers:\n${JSON.stringify(survivors)}`,
					},
				});
				if (execution.softened.length > 0) {
					// Key-mode softening joins — never replaces — the loop's own diversity
					// explanation (e.g. "reviewer seats did not complete"), mirroring the
					// merge rule inside runReviewLoop.
					const explanation = execution.softened.join("; ");
					if (loop.diversity.state === "met") loop.diversity = { state: "softened", explanation };
					else if (!loop.diversity.explanation.includes(explanation)) loop.diversity = { state: "softened", explanation: `${loop.diversity.explanation}; ${explanation}` };
				}
			} catch (error) {
				loopFailure = { error };
			} finally {
				for (const sha of preparedSeatShas) {
					try {
						const repair = await cleanupAuthoringReviewSeatsForSha(mainRepo, sha);
						if (repair.status === "park") cleanupParkReason ??= hostDependencyParkReason(repair, `after seat teardown for ${sha.slice(0, 12)}`);
					} catch (error) {
						cleanupParkReason ??= hostDependencyVerificationFailure(error instanceof Error ? error.message : String(error), `after seat teardown for ${sha.slice(0, 12)}`);
					}
				}
			}
			if (cleanupParkReason) return { kind: "terminal", result: parkExit(cleanupParkReason, "halt-campaign")! };
			if (loopFailure) throw loopFailure.error;
		}
		if (!loop) {
			// loop is only skipped for resolved-proceed; narrow before reading audit fields.
			if (existingEscalation.state !== "resolved-proceed") return { kind: "terminal", result: parkExit("adversarial review produced no loop result")! };
			reviewRecordMarkdown = `## Adversarial review escalation\n\nDecision **${existingEscalation.id}** was resolved **proceed** by ${existingEscalation.resolution.actor}.\n\nRationale: ${existingEscalation.resolution.rationale}\n\nReviewed commit: \`${reviewedSha}\`. Evidence fingerprint: \`${existingEscalation.escalation.evidenceFingerprint}\`.`;
			shakedownResult = { ok: true, subtype: "success", text: "resolved-proceed", fullText: "", assistantText: "", cost: 0, turns: 0 };
		} else {
			helpers.addCost(loop.cost);
			const finalReviewedSha = getArtifactHeadSha(worktree!);
			if (!finalReviewedSha) return { kind: "terminal", result: parkExit("adversarial review could not bind final reviewed HEAD")! };
			const reviewRunId = itemRunId();
			const record: ReviewRecord = { schemaVersion: 1, runId: reviewRunId, itemId: itemId!, createdAt: new Date().toISOString(), blockingBar: "must-fix", result: loop };
			const recordPath = writeReviewRecord(worktree!, record);
			reviewRecordMarkdown = renderReviewRecord(record);
			log(`review record → ${recordPath}`);
			const reviewRecordSource = registerRelativePath("review-records", `${record.runId}.json`);
			// Aggregate authoring-review provenance at reserved attempt 0 (seat step() calls
			// use 1-indexed pass as attempt; effectManifestPath is `${step}-${attempt}.json`).
			const seats: ReviewSeatIdentity[] = [
				{ role: "author", seatId: "author", provider: authorIdentity.provider, ...(authorIdentity.model ? { model: authorIdentity.model } : {}) },
				...policy.reviewers.map((slot) => ({
					role: "reviewer" as const,
					seatId: slot.id,
					provider: slot.provider,
					...(slot.provider === "codex" ? (slot.codexModel ? { model: slot.codexModel } : {}) : slot.model ? { model: slot.model } : {}),
				})),
				{
					role: "judge",
					seatId: policy.judge.id,
					provider: policy.judge.provider,
					...(policy.judge.provider === "codex" ? (policy.judge.codexModel ? { model: policy.judge.codexModel } : {}) : policy.judge.model ? { model: policy.judge.model } : {}),
				},
			];
			const verdictEffect: ReviewVerdictEffect = {
				kind: "review.Verdict",
				itemId: itemId!,
				reviewedSha: finalReviewedSha,
				reviewRecordSource,
				outcome: loop.outcome,
				seats,
			};
			const reviewEffects: Effect[] = [verdictEffect];
			if (loop.disagreement) {
				const escalationEffect: ReviewEscalationEffect = {
					kind: "review.Escalation",
					itemId: itemId!,
					reviewedSha: finalReviewedSha,
					reviewRecordSource,
					evidenceFingerprint: loop.disagreement.evidenceFingerprint,
					hasSafetyBlocker: loop.disagreement.hasSafetyBlocker,
				};
				reviewEffects.push(escalationEffect);
			}
			const effectsCtx: EffectsContext = {
				runId: reviewRunId,
				itemId: itemId!,
				step: "shakedown-code",
				attempt: 0,
				cwd: worktree!,
				preSha: finalReviewedSha,
			};
			let escalationParkReason: string | undefined;
			if (loop.disagreement) {
				const escalation = {
					kind: "review-escalation" as const,
					itemId: itemId!,
					step: "shakedown-code" as const,
					reviewedSha: finalReviewedSha,
					evidenceFingerprint: loop.disagreement.evidenceFingerprint,
					reviewRecordSource,
					hasSafetyBlocker: loop.disagreement.hasSafetyBlocker,
					drivers: loop.disagreement.drivers.map((driver) => ({ ...driver, identity: { ...driver.identity, role: "reviewer" as const } })),
				};
				try {
					// The durable safety action precedes effect attestation. A manifest write or
					// dispatch failure below must never swallow the escalation or skip parking.
					const adjudication: ReviewEscalationAdjudication = {
						spend: { amount: helpers.cost(), estimated: steps.some((s) => s.costEstimated) },
						evidenceFingerprint: escalation.evidenceFingerprint,
						...(escalation.hasSafetyBlocker
							? {
									recommendedDefault: {
										disposition: "block" as const,
										source: "deterministic-policy" as const,
										rationale: "A safety-class must-fix is on the record; the safety floor cannot be acknowledged through.",
									},
								}
							: {}),
					};
					const written = await appendReviewEscalation(worktree!, { escalation, adjudication });
					if (written.status !== "failed")
						await opts.notifyDecision?.({
							itemId,
							decision: { fork: `Cross-model review split (${written.ids[0]})`, chosen: "human adjudication required", alternatives: "proceed or block" },
							step: "shakedown-code",
							source: escalation.reviewRecordSource,
							logPath: opts.logPath ?? LOG_PATH,
							escalation: { ...escalation, id: written.ids[0] },
						});
					const state = lookupReviewEscalation(worktree!, itemId!, finalReviewedSha);
					if (written.status === "failed") escalationParkReason = "adversarial review escalation write-failed";
					else if (state.state !== "resolved-proceed" || escalation.hasSafetyBlocker) {
						const decisionId = written.ids[0];
						if (state.state === "active" && decisionId) {
							const commands = reviewEscalationCommands(decisionId, escalation);
							escalationParkReason = `adversarial review escalation active\n${commands.proceedResolve}\n${commands.resume}\n${commands.blockResolve}`;
						} else {
							escalationParkReason = `adversarial review escalation ${state.state}`;
						}
					}
				} catch (error) {
					log(`⚠ adversarial review escalation write failed: ${error instanceof Error ? error.message : String(error)}`);
					return { kind: "terminal", result: parkExit("adversarial review escalation write-failed")! };
				}
			}
			if (!opts.dryRun) {
				try {
					writeEffectsManifest(effectsCtx, reviewEffects);
					// Aggregate authoring-review uses reserved attempt 0; provider/model from the
					// configured judge seat when present, else the shakedown-code step settings.
					const reviewSettings = resolveStepSettings(CONFIG, profile, "shakedown-code");
					const reviewProvider = policy.judge.provider;
					// Non-Codex judge: prefer the realized seat model; else the judge provider's own
					// step-settings slot (never the top-level Claude `model` slot) (#431).
					const reviewModel = policy.judge.provider === "codex" ? (policy.judge.codexModel ?? "default") : (policy.judge.model ?? modelForProvider(reviewSettings, reviewProvider) ?? "default");
					const reviewEffectsResult = await dispatchStepEffects({
						...effectsCtx,
						roadmap,
						log,
						challenge: cycleChallenge,
						provider: reviewProvider,
						model: reviewModel,
						observeGit: () => observeGitForReceipt(worktree!),
					});
					if (reviewEffectsResult.receipt) executionReceipts.push(reviewEffectsResult.receipt);
				} catch (e) {
					const code = e instanceof EffectsManifestError ? e.code : "effect_failed";
					const message = e instanceof Error ? e.message : String(e);
					const text = `${code}: ${message}`;
					if (loop.disagreement) return { kind: "terminal", result: parkExit(`shakedown-code effects failed after escalation: ${text}`)! };
					return { kind: "terminal", result: finishFailed(`shakedown-code effects failed: ${text}`, "effects", { itemId, cost: helpers.cost() }) };
				}
			}
			if (escalationParkReason) return { kind: "terminal", result: parkExit(escalationParkReason)! };
			// A reviewer-split `dissent` already escalated + parked in the `loop.disagreement` block above.
			// A Judge-ruled judgment-dissent (no disagreement, non-safety) keeps its pre-#244 posture:
			// park only for direct-push; in PR mode ship with the dissent recorded (the PR is the veto).
			if (loop.outcome === "budget" || loop.outcome === "hard-block" || (loop.outcome === "dissent" && opts.shipTarget.name === "direct-push")) return { kind: "terminal", result: parkExit(`adversarial review ${loop.outcome}`)! };
			shakedownResult = { ok: true, subtype: "success", text: loop.outcome, fullText: "", assistantText: "", cost: 0, turns: 0 };
		}
	} else {
		const selected = selectReviewers(assignment, driverCandidates("shakedown-code"), implementationAuthor, 1, available);
		if (!selected.ok) return { kind: "terminal", result: finishFailed(`shakedown-code assignment failed: ${selected.reason}`, "selection", { itemId, cost: helpers.cost() }) };
		const outcome = await runStepWithRetry({
			name: "shakedown-code",
			stepBudget: resolveStepSettings(CONFIG, profile, "shakedown-code").budget,
			commitLabel: () => "shakedown checkpoint",
			refusedError: "shakedown-code refused (model declined the review)",
			turnLimitNoun: "shakedown",
			executionOverride: selected.drivers[0],
			logAttempt: (attempt) => log(attempt === 1 ? "shakedown (code)..." : "continuing shakedown (attempt 2)..."),
			buildPrompt: (attempt) =>
				attempt === 1
					? expandSkill("shakedown", shakedownCodeArgs)
					: [
							"The previous shakedown session ran out of turns. Work has been committed to disk.",
							"",
							"## Context",
							shakedownPlanRef,
							"",
							"## Instructions",
							"1. Run the verification commands from `.claude/skills/_rubric.md`'s Verification section to see the current state.",
							"2. Check what's already been fixed vs. what remains.",
							"3. Focus on fix-now items only (type errors, test failures, lint errors, bugs).",
							'4. Skip near-term items (missing tests, i18n gaps, refactoring) — list each as a `deferred-item: {"title": "...", "scope": "..."}` marker line; the harness creates them (do not run `roadmap create-item`).',
							"5. Re-run the verification commands before finishing.",
						].join("\n"),
		});
		if (outcome.kind === "terminal") return { kind: "terminal", result: outcome.cycleResult };
		shakedownResult = outcome.result;
	}

	// Harness owns deferred-item creation (#115): under pelaggio the model lists follow-ups as
	// `deferred-item: {json}` markers instead of running `roadmap create-item` (a sandboxed
	// provider can't). Create them in-process, best-effort — a failure logs and continues (they're
	// backlog niceties, not the cycle's deliverable). Skipped in dry-run (no real backlog writes).
	if (!opts.dryRun) {
		for (const d of parseDeferredItems(shakedownResult.assistantText, deferredItemTitles)) {
			try {
				const created = await roadmap.createItem(d);
				log(`deferred → ${created.id}: ${d.title}`);
			} catch (e) {
				log(`deferred-item create failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}
	return { kind: "continue", reviewRecordMarkdown };
}
