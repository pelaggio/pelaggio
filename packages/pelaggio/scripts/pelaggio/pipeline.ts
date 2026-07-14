import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import {
	CONFIG,
	CONFINEMENT_CONFIG,
	DEFAULT_SHIP_TARGET,
	isPipelineStep,
	LOG_PATH,
	MODEL_PROFILES,
	REPO,
	REVIEW_CONFIG,
	REVISE_LOCAL,
	type ReviewRunner,
	ROADMAP_GITHUB,
	ROADMAP_LINEAR,
	ROADMAP_SOURCE,
	resolveStepSettings,
	SHIP_TARGET,
	STEPS,
	WORKTREE_PREFIX,
} from "./config.js";
import { dispatchStepEffects as dispatchStepEffectsDefault, type Effect, EffectsManifestError, writeEffectsManifest as writeEffectsManifestDefault } from "./effects.js";
import { DEFAULT_FLOW_POLICY, type FlowPolicy } from "./flow-policy.js";
import {
	appendLog as appendLogDefault,
	buildStepArgs,
	canRetryWithinBudget,
	captureShipState,
	checkpoint,
	classifyOutcome,
	computeImplementTurns,
	createMutex,
	detectResumeStep,
	diffForbiddenRootSnapshots,
	ensureCheckpointed,
	expandSkill,
	filesChangedSince,
	fmtWait,
	formatResumeHint,
	getHeadSha,
	hasDeliverableCommits,
	isTransientSdkError,
	listWorktrees as listWorktreesDefault,
	parseDeferredItems,
	parsePickItem,
	parsePickResult,
	parseShipMerged,
	parseVerdict,
	parseWaitFlag,
	resolveWorktree,
	revertPlanPolish,
	reviewFindingsPreamble,
	snapshotForbiddenRoots,
	stepIndex,
	verifyShipLanded,
} from "./helpers.js";
import { type NotifyConfig, notifyCycle, notifyStrandedReview, sendNotification as sendNotificationDefault } from "./notify.js";
import { buildFailClosedComment, runPrReviewGate } from "./pr-review-cli.js";
import { cleanupReviewHead, findReviewCandidates, postLocalModeWorkflowComment, postReviewStatus, prepareReviewHead, upsertReviewComment } from "./review-sweep.js";
import { claimRevision, ensureReviseWorktree, fetchReviewFindings, findRevisablePrs, isAutopilotManaged, postParkComment, reviseFindingsPath } from "./revise-sweep.js";
import { defaultGhRun, type GhRunner } from "./roadmap/github-issues.js";
import { getRoadmapSource, type RoadmapSource } from "./roadmap/index.js";
import { parseShipDecisionEffect } from "./ship/decision.js";
import { commitStrayBookkeeping, getShipTarget, isAutonomousRemotePush, isShipTargetName, runShipBookkeeping as runShipBookkeepingDefault, SHIP_TARGET_NAMES } from "./ship/index.js";
import { runStep as runStepDefault } from "./step-runner.js";
import { A, createStepRenderer, fmtElapsed, LiveStatus, StatusBar, TUI_ENABLED } from "./tui.js";
import { type CycleResult, type CycleStatus, type Flags, type ParkSignal, type PipelineOpts, RECOVERABLE_ERRORS, type ShipTargetName, type Step, type StepLog, type StepResult } from "./types.js";

// ── Pipeline ───────────────────────────────────────────────────────────

// Re-export the single-sourced runner signature (canonical in step-runner.ts) so
// `mocks.ts`'s `import type { RunStepFn } from "../pipeline.js"` keeps resolving —
// same public name, one definition, no pipeline↔step-runner type cycle.
export type { RunStepFn } from "./step-runner.js";

/**
 * Outcome of a step run through `runStepWithRetry`: either a success carrying the
 * `StepResult` for step-specific follow-up (verdict parse, etc.), or a terminal
 * cycle result the caller should `return` immediately (park / refusal / blocked /
 * max-turns exhaustion / budget-gated retry skip). A discriminated union rather
 * than a sentinel bool so "terminal vs continue" is explicit at each call site.
 */
type StepAttempt = { kind: "ok"; result: StepResult } | { kind: "terminal"; cycleResult: CycleResult };
type StepEffects = Effect[] | ((result: StepResult) => Effect[]);

function appendResultText(text: string, appendText: string): string {
	if (text.trim() === "") return appendText;
	return `${text}\n${appendText}`;
}

const TRANSIENT_MAX_ATTEMPTS = 3;
const TRANSIENT_BACKOFF_MS = 1000;
// Consecutive whole-cycle "transient sdk error" outcomes (issue #128) that distinguish a
// sustained provider outage from a single blip. One transient cycle stays silently
// recoverable (#127's behavior); this many in a row parks + pages instead of quietly
// burning through every remaining --cycles against a dead provider.
const CONSECUTIVE_TRANSIENT_ERROR_LIMIT = 3;

export interface PipelineDeps {
	runStep?: RunStepFn;
	listWorktrees?: () => string[];
	appendLog?: (entry: Record<string, unknown>) => void;
	sleep?: (ms: number) => Promise<void>;
	/** Override the main-repo path used for ghost-ship verification, pick cwd, and shipwreck cwd. Defaults to REPO. */
	mainRepo?: string;
	/** Override worktree-path derivation (mirrors OrchestratorDeps). Defaults to the helpers.ts export. */
	resolveWorktree?: typeof resolveWorktree;
	/** Roadmap source adapter. Defaults to one constructed from `ROADMAP_SOURCE` + `REPO`. */
	roadmap?: RoadmapSource;
	/** Scheduling and quick-scope policy. Defaults to the provider-neutral FIFO policy. */
	flowPolicy?: FlowPolicy;
	/** Deterministic direct-push bookkeeping tail. Injectable for testing the merged-path branch with a spy. */
	runShipBookkeeping?: typeof runShipBookkeepingDefault;
	/** Effects-manifest writer. Defaults to the production JSON writer; injectable for fail-closed tests. */
	writeEffectsManifest?: typeof writeEffectsManifestDefault;
	/** Effects-manifest dispatcher. Defaults to the production registry dispatcher; injectable for fail-closed tests. */
	dispatchStepEffects?: typeof dispatchStepEffectsDefault;
	/** Override the configured main-checkout confinement exception. */
	allowDirtyMain?: boolean;
}

export async function runPipeline(opts: PipelineOpts, parkSignal: ParkSignal, flags: Flags, deps: PipelineDeps = {}): Promise<CycleResult> {
	const runStep = deps.runStep ?? runStepDefault;
	const listWorktrees = deps.listWorktrees ?? listWorktreesDefault;
	const appendLog = deps.appendLog ?? appendLogDefault;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const mainRepo = deps.mainRepo ?? REPO;
	const _resolveWorktree = deps.resolveWorktree ?? resolveWorktree;
	const roadmap = deps.roadmap ?? getRoadmapSource(ROADMAP_SOURCE, { repo: REPO, github: ROADMAP_GITHUB, linear: ROADMAP_LINEAR });
	const flowPolicy = deps.flowPolicy ?? DEFAULT_FLOW_POLICY;
	const runShipBookkeeping = deps.runShipBookkeeping ?? runShipBookkeepingDefault;
	const writeEffectsManifest = deps.writeEffectsManifest ?? writeEffectsManifestDefault;
	const dispatchStepEffects = deps.dispatchStepEffects ?? dispatchStepEffectsDefault;
	const allowDirtyMain = deps.allowDirtyMain ?? CONFINEMENT_CONFIG.allowDirtyMain;
	// The cycle's dollar ceiling. A turn-exhaustion retry (issue #33) is funded up to the
	// step's configured budget again, so the budget guard skips a retry we can't fully fund.
	// A non-finite value (unset / unparseable --budget) disables the dollar gate.
	const maxBudget = Number.parseFloat(flags.budget);
	let cost = 0;
	let profile = "standard";
	const steps: StepLog[] = [];
	const pipelineT0 = Date.now();
	const runIdBase = opts.logPath ? basename(opts.logPath, extname(opts.logPath)) : `cycle-${opts.cycle}`;
	let logLabel = `cycle ${opts.cycle}`;
	const log = (msg: string): void => {
		const elapsed = fmtElapsed(Date.now() - pipelineT0);
		const ts = new Date().toLocaleTimeString("en-CA", { hour12: false });
		console.log(`${A.dim(ts)} [${logLabel}] ${A.dim(elapsed)} ${msg}`);
	};
	if (allowDirtyMain) {
		log("⚠ confinement.allow-dirty-main is active: main-checkout writes are not audited; sibling worktrees remain audited");
	}

	function forbiddenRootsForStep(cwd: string, ownWorktree?: string): string[] {
		const cwdAbs = resolve(cwd);
		const mainAbs = resolve(mainRepo);
		const exempt = new Set([cwdAbs, ...(ownWorktree ? [resolve(ownWorktree)] : [])]);
		// Main-repo-based steps (pick, shipwreck) legitimately write inside mainRepo
		// itself — and shipwreck legitimately finishes a squash/commit in the item's
		// own worktree (SKILL.md states 3c/3d) — but must not touch sibling worktrees.
		// `listWorktrees()` already includes mainRepo, so prepend it only when it must be
		// audited and dedup by resolved path. `allowDirtyMain` drops mainRepo from the set.
		const candidates = cwdAbs === mainAbs ? listWorktrees() : [mainRepo, ...listWorktrees()];
		const seen = new Set<string>();
		const roots: string[] = [];
		for (const root of candidates) {
			const abs = resolve(root);
			if (seen.has(abs) || exempt.has(abs)) continue;
			if (allowDirtyMain && abs === mainAbs) continue;
			seen.add(abs);
			roots.push(root);
		}
		return roots;
	}

	async function step(
		name: Step,
		prompt: string,
		cwd: string,
		{
			attempt = 1,
			commitLabel,
			effects,
			maxTurnsOverride,
			retriedMaxTurns = false,
			ownWorktree,
		}: { attempt?: number; commitLabel?: string; effects?: StepEffects; maxTurnsOverride?: number; retriedMaxTurns?: boolean; ownWorktree?: string } = {},
	): Promise<StepResult> {
		// Short-circuit before runStep when SIGINT fired between steps; also covers
		// --dry-run so Ctrl-C during a dry run bails promptly.
		if (opts.signal?.aborted) {
			const emitAbort = createStepRenderer({
				verbose: opts.verbose,
				trace: flags.trace,
				toFile: !!opts.logPath,
				logPath: opts.logPath,
				liveStatus: opts.liveStatus!,
				workerStatus: opts.workerStatus,
			});
			emitAbort({ type: "done", ok: false, subtype: "error_abort", cost: 0, turns: 0, elapsed: 0 });
			steps.push({ name, model: MODEL_PROFILES[profile]?.[name] ?? "default", cost: 0, turns: 0, ok: false, ...(attempt > 1 ? { attempt } : {}) });
			return { ok: false, subtype: "error_abort", text: "aborted", fullText: "", cost: 0, turns: 0 };
		}

		if (opts.dryRun) {
			log(`[dry-run] ${name}: "${prompt.slice(0, 60)}" in ${cwd}`);
			steps.push({ name, model: MODEL_PROFILES[profile]?.[name] ?? "default", cost: 0, turns: 0, ok: true, ...(attempt > 1 ? { attempt } : {}) });
			return { ok: true, subtype: "success", text: `[dry-run] ${name}`, fullText: `[dry-run] ${name}`, cost: 0, turns: 0 };
		}

		const emit = createStepRenderer({
			verbose: opts.verbose,
			trace: flags.trace,
			toFile: !!opts.logPath,
			logPath: opts.logPath,
			liveStatus: opts.liveStatus!,
			workerStatus: opts.workerStatus,
		});

		const preSha = getHeadSha(cwd);
		let forbiddenRoots: string[] = [];
		let forbiddenBefore = new Map<string, string>();
		let confinementRoots: string[] = [];
		let confinementAuditError: string | undefined;
		try {
			forbiddenRoots = forbiddenRootsForStep(cwd, ownWorktree);
		} catch (e) {
			confinementAuditError = `confinement audit failed to enumerate roots before ${name}: ${e instanceof Error ? e.message : String(e)}`;
			log(`⚠ ${confinementAuditError}`);
		}
		try {
			forbiddenBefore = snapshotForbiddenRoots(forbiddenRoots);
		} catch (e) {
			confinementRoots = forbiddenRoots.map((root) => resolve(root));
			log(`⚠ confinement audit failed before ${name}: ${e instanceof Error ? e.message : String(e)}`);
		}

		const providerResult = await runStep(
			name,
			prompt,
			{
				cwd,
				profile,
				trace: flags.trace,
				itemId: itemId ?? undefined,
				parkSignal,
				...(maxTurnsOverride !== undefined ? { maxTurnsOverride } : {}),
				...(opts.signal ? { signal: opts.signal } : {}),
			},
			emit,
		);

		if (confinementRoots.length === 0 && confinementAuditError === undefined) {
			try {
				const forbiddenAfter = snapshotForbiddenRoots(forbiddenRoots);
				confinementRoots = diffForbiddenRootSnapshots(forbiddenBefore, forbiddenAfter);
			} catch (e) {
				confinementRoots = forbiddenRoots.map((root) => resolve(root));
				log(`⚠ confinement audit failed after ${name}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		let result = providerResult;
		if (confinementAuditError !== undefined) {
			result = { ...providerResult, ok: false, subtype: "error_confinement", text: confinementAuditError };
		} else if (confinementRoots.length > 0) {
			const roots = [...new Set(confinementRoots)].sort();
			const text = `forbidden root changed during ${name}: ${roots.join(", ")}`;
			log(`⚠ ${text}`);
			result = {
				...providerResult,
				ok: false,
				subtype: "error_confinement",
				text,
			};
		}

		if (commitLabel && result.subtype !== "error_confinement") {
			const committed = checkpoint(cwd, commitLabel);
			log(committed ? `${commitLabel} committed` : `no changes to commit (${commitLabel})`);
			ensureCheckpointed(cwd, commitLabel, log);
		}
		if (effects && result.subtype !== "error_confinement") {
			const staticEffects = Array.isArray(effects) ? effects : [];
			const checkpointEffect = staticEffects.find((effect): effect is Extract<Effect, { kind: "checkpoint" }> => effect.kind === "checkpoint");
			if (result.ok && !parkSignal.parked && !opts.dryRun) {
				const ctx = {
					runId: `${runIdBase}-${itemId ?? "unclaimed"}`,
					itemId: itemId ?? "",
					step: name,
					attempt,
					cwd,
					preSha,
				};
				try {
					const resolvedEffects = typeof effects === "function" ? effects(result) : effects;
					if (resolvedEffects.length > 0) {
						writeEffectsManifest(ctx, resolvedEffects);
						const effectsResult = await dispatchStepEffects({ ...ctx, roadmap, log });
						if (effectsResult.appendText) {
							result = {
								...result,
								text: appendResultText(result.text, effectsResult.appendText),
								fullText: appendResultText(result.fullText, effectsResult.appendText),
							};
						}
					}
				} catch (e) {
					const code = e instanceof EffectsManifestError ? e.code : "effect_failed";
					const message = e instanceof Error ? e.message : String(e);
					result = {
						...result,
						ok: false,
						subtype: "error_effects_manifest",
						text: `${code}: ${message}`,
					};
				}
			} else if (checkpointEffect) {
				const committed = checkpoint(cwd, checkpointEffect.label);
				log(committed ? `${checkpointEffect.label} committed` : `no changes to commit (${checkpointEffect.label})`);
				ensureCheckpointed(cwd, checkpointEffect.label, log);
			}
		}

		// Plan-polish backstop (#80): implement is execute-only under docs/plans/. The Claude hook
		// blocks such writes; for providers whose sandbox can't (Codex), this deterministic revert
		// undoes any docs/plans/ edits made this step — including committed ones — since preSha.
		if (name === "implement" && result.subtype !== "error_confinement") {
			const reverted = revertPlanPolish(cwd, preSha);
			if (reverted.length > 0) log(`reverted plan-polish edits: ${reverted.join(", ")}`);
		}

		const filesChanged = filesChangedSince(cwd, preSha);

		steps.push({
			name,
			model: MODEL_PROFILES[profile]?.[name] ?? "default",
			cost: result.cost,
			turns: result.turns,
			ok: result.ok,
			...(!result.ok ? { subtype: result.subtype } : {}),
			...(result.tokens ? { tokens: result.tokens } : {}),
			...(result.costEstimated ? { costEstimated: true } : {}),
			...(attempt > 1 ? { attempt } : {}),
			...(retriedMaxTurns ? { retriedMaxTurns: true } : {}),
			...(result.toolCounts ? { toolCounts: result.toolCounts } : {}),
			...(result.outputTail ? { outputTail: result.outputTail } : {}),
			...(filesChanged.length > 0 ? { filesChanged } : {}),
			...(result.stalledAsk ? { stalledAsk: true } : {}),
		});
		if (opts.workerStatus) opts.workerStatus.cost += result.cost;
		return result;
	}

	let shipwrecked = false;

	function finish(result: CycleResult): CycleResult {
		// Park wins over abort (it's a preserve-work path; abort is discard-work).
		// Don't relabel successful cycles — SIGINT during the 2s grace after ship
		// completed shouldn't turn a real success into a phantom abort.
		if (opts.signal?.aborted && !result.completed && result.error !== "parked") {
			result = { ...result, error: "aborted" };
		}
		// Surface the local shipwreck flag on the returned result so the orchestrator can
		// classify a `shipwrecked` notification (also brings CycleResult into parity with
		// CycleLogEntry.shipwrecked). The JSONL log records it separately below.
		if (shipwrecked) result = { ...result, shipwrecked: true };
		// Any estimated step makes the cycle total estimated — surfaced on the result (live
		// prints) and the jsonl (stats/notify) so a subscription-provider run never reads as USD.
		const costEstimated = steps.some((s) => s.costEstimated);
		if (costEstimated) result = { ...result, costEstimated: true };
		if (!opts.dryRun) {
			const parked = result.error === "parked";
			appendLog({
				ts: new Date().toISOString(),
				cycle: opts.cycle,
				item: result.itemId,
				quick: profile === "quick",
				steps,
				total_cost: Number(result.cost.toFixed(4)),
				...(costEstimated ? { costEstimated: true } : {}),
				verdict: result.verdict ?? null,
				completed: result.completed,
				error: result.error ?? null,
				parked,
				parkReason: parked ? parkSignal.limitType || null : null,
				shipwrecked,
			});
		}
		return result;
	}

	// ── Resolve item + worktree ──

	let itemId = opts.itemId ?? null;
	let worktree = opts.worktree ?? null;
	let pickText = "";
	let startFrom = opts.startFrom;
	if (itemId) logLabel = itemId;

	if (!worktree) {
		const mutex = opts.pickMutex;
		const ws = opts.workerStatus;
		if (ws && mutex) ws.step = "waiting";
		if (mutex) await mutex.acquire();
		try {
			if (parkSignal.parked) return finish({ itemId: null, completed: false, cost, error: "parked" });
			const worktreesBefore = new Set(opts.dryRun ? [] : listWorktrees());

			if (!opts.dryRun && itemId && roadmap.isCharterPickRace(itemId)) {
				return finish({ itemId, completed: false, cost, error: "pick:unknown-id" });
			}
			log(`/pick ${itemId ?? "next"}`);
			const pickArgs = itemId ? (opts.noWorktree ? `${itemId} --no-worktree` : itemId) : "next";
			const pick = await step("pick", expandSkill("pick", pickArgs), mainRepo);
			cost += pick.cost;
			pickText = pick.text + "\n" + pick.fullText;

			if (!pick.ok) {
				const err = classifyOutcome(pick) === "blocked" ? `pick blocked: ${pick.text}` : "pick failed";
				return finish({ itemId: null, completed: false, cost, error: err });
			}

			if (!opts.dryRun) {
				const reason = parsePickResult(pickText);
				if (reason !== "claimed") {
					return finish({ itemId: null, completed: false, cost, error: `pick:${reason ?? "unknown"}` });
				}
			}

			itemId = opts.dryRun ? (itemId ?? "DRY") : (parsePickItem(pickText) ?? (await roadmap.parseItemId(pick.text)) ?? (await roadmap.parseItemId(pick.fullText)));
			if (!itemId) return finish({ itemId: null, completed: false, cost, error: "no item ID parsed" });

			if (opts.noWorktree) {
				// In no-worktree mode, the feature branch was checked out in-place.
				worktree = mainRepo;
			} else {
				worktree = _resolveWorktree(itemId);
				if (!opts.dryRun && (!existsSync(worktree) || worktreesBefore.has(worktree))) {
					// Match on the basename prefix, not a path substring: a parent/main-repo path can
					// contain WORKTREE_PREFIX (e.g. a checkout whose dir basename is the prefix root) and
					// must not be mistaken for the freshly-created sibling worktree.
					const newWt = listWorktrees().find((p) => !worktreesBefore.has(p) && (p.split(/[/\\]/).pop() ?? "").startsWith(WORKTREE_PREFIX));
					if (newWt) worktree = newWt;
					else if (!existsSync(worktree)) {
						const idLower = itemId.toLowerCase();
						const expected = `${WORKTREE_PREFIX}${idLower}`;
						const all = listWorktrees();
						const nested = all.filter((p) => {
							const base = p.split(/[/\\]/).pop() ?? "";
							return base === expected || base.startsWith(`${expected}-`);
						});
						if (nested.length === 1) {
							const base = nested[0].split(/[/\\]/).pop() ?? "";
							const extendedId = (base.startsWith(WORKTREE_PREFIX) ? base.slice(WORKTREE_PREFIX.length) : base).toUpperCase();
							log(`expected ${worktree}, using ${nested[0]} for in-flight ${extendedId}`);
							worktree = nested[0];
						} else if (nested.length > 1) return finish({ itemId, completed: false, cost, error: `worktree ambiguous: ${nested.join(", ")}` });
						else {
							const summary = all.map((p) => p.split(/[/\\]/).pop()).join(", ");
							return finish({ itemId, completed: false, cost, error: `worktree missing for ${itemId}: expected ${expected}; git worktree list (${all.length} entries): ${summary}` });
						}
					}
				}
			}
		} finally {
			mutex?.release();
		}
	} else if (!opts.dryRun && !existsSync(worktree)) {
		return finish({ itemId, completed: false, cost, error: "worktree missing" });
	}

	logLabel = itemId!;
	log(`→ ${worktree}`);

	if (opts.workerStatus) opts.workerStatus.itemId = itemId!;

	// ── Detect quick mode ──

	const quickItem = !opts.dryRun && itemId ? await roadmap.getItem(itemId).catch(() => null) : null;
	if (flowPolicy.isQuickScope({ item: quickItem, summaryText: pickText })) {
		profile = "quick";
		log("scope S/XS or bug — quick mode (Sonnet, skip plan+shakedown-plan)");
		startFrom ??= "implement";
	}
	startFrom ??= "plan";

	const shouldRun = (s: Step): boolean => stepIndex(startFrom!) <= stepIndex(s);

	function parkExit(): CycleResult | null {
		if (!parkSignal.parked) return null;
		if (worktree) checkpoint(worktree, "rate-limit park");
		log(`⏸ parked (${parkSignal.limitType})`);
		return finish({ itemId, completed: false, cost, error: "parked" });
	}

	/**
	 * Run a step with the shared bounded max-turns retry policy (issue #33), consolidating
	 * the four previously-inlined loops (plan / shakedown-plan / implement / shakedown-code)
	 * into one parameterized wrapper. Behavior-preserving — see #32 plan Part A.
	 *
	 * Per-attempt flow: park check → run → classify. `ok` returns immediately for caller
	 * follow-up. `error_rate_limit`/park, `blocked`, `error_refusal`, and non-max-turns
	 * failures are terminal. `edit_loop` (implement only, `retryOnEditLoop`) retries with a
	 * fresh-approach prompt and is NOT budget-gated. `error_max_turns` retries up to
	 * `maxAttempts`, gated by `canRetryWithinBudget`; the final attempt yields "(max retries)".
	 *
	 * Owns `cost += result.cost` — callers must not double-count. `retriedMaxTurns` tracks
	 * the prior failure (not `attempt > 1`) so an edit-loop retry is distinguished from a
	 * turn-exhaustion retry in the step log.
	 */
	async function runStepWithRetry(cfg: {
		name: Step;
		/** `resolveStepSettings(...).budget` for the dollar gate on a max-turns retry. */
		stepBudget: number;
		buildPrompt: (attempt: number, ctx: { lastLoopFile: string | null }) => string;
		logAttempt: (attempt: number) => void;
		/** Exact per-step refusal wording (task vs review noun) — preserved for tests. */
		refusedError: string;
		maxAttempts?: number;
		/** implement / shakedown-code only: checkpoint label per attempt. */
		commitLabel?: (attempt: number) => string;
		/** Success-dispatched effects; checkpoint effects also preserve work on non-confinement failures. */
		effects?: (attempt: number) => Effect[];
		/** implement only: dynamic turn budget (scaled by plan file count). */
		maxTurnsOverride?: number;
		/** implement only: retry (un-budget-gated) with a fresh-approach prompt on edit_loop. */
		retryOnEditLoop?: boolean;
		/** Turn-limit log noun; defaults to `name` (shakedown-code logs "shakedown"). */
		turnLimitNoun?: string;
	}): Promise<StepAttempt> {
		const maxAttempts = cfg.maxAttempts ?? 2;
		const noun = cfg.turnLimitNoun ?? cfg.name;
		let lastLoopFile: string | null = null;
		// Attempt 2 can follow EITHER an edit_loop OR error_max_turns — track the prior
		// failure so only genuine turn-exhaustion retries get marked `retriedMaxTurns`.
		let prevMaxTurns = false;
		let transientAttempts = 0;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const parked = parkExit();
			if (parked) return { kind: "terminal", cycleResult: parked };
			cfg.logAttempt(attempt);
			const result = await step(cfg.name, cfg.buildPrompt(attempt, { lastLoopFile }), worktree!, {
				attempt,
				retriedMaxTurns: prevMaxTurns,
				...(cfg.commitLabel ? { commitLabel: cfg.commitLabel(attempt) } : {}),
				...(cfg.effects ? { effects: cfg.effects(attempt) } : {}),
				...(cfg.maxTurnsOverride !== undefined ? { maxTurnsOverride: cfg.maxTurnsOverride } : {}),
			});
			cost += result.cost;

			if (result.ok) return { kind: "ok", result };

			const outcome = classifyOutcome(result);
			if (outcome === "error_confinement") {
				return { kind: "terminal", cycleResult: finish({ itemId, completed: false, cost, error: `${cfg.name} failed: confinement violation` }) };
			}
			if (outcome === "error_rate_limit" || parkSignal.parked) {
				return { kind: "terminal", cycleResult: parkExit() ?? finish({ itemId, completed: false, cost, error: `${cfg.name} failed` }) };
			}
			if (outcome === "blocked") {
				return { kind: "terminal", cycleResult: finish({ itemId, completed: false, cost, error: `${cfg.name} blocked: ${result.text}` }) };
			}
			if (outcome === "error_refusal") {
				return { kind: "terminal", cycleResult: finish({ itemId, completed: false, cost, error: cfg.refusedError }) };
			}
			if (cfg.retryOnEditLoop && outcome === "edit_loop") {
				const match = result.text.match(/Edit loop detected: (.+?) edited/);
				lastLoopFile = match?.[1]?.replace(/^.*[/\\]/, "") ?? null;
				prevMaxTurns = false;
				log(`edit loop on ${lastLoopFile ?? "unknown file"} — will retry with fresh approach`);
				continue;
			}
			if (isTransientSdkError(result)) {
				transientAttempts++;
				if (transientAttempts >= TRANSIENT_MAX_ATTEMPTS) {
					return { kind: "terminal", cycleResult: finish({ itemId, completed: false, cost, error: "transient sdk error" }) };
				}
				const backoffMs = TRANSIENT_BACKOFF_MS * 2 ** (transientAttempts - 1);
				log(`transient SDK error in ${cfg.name} (attempt ${transientAttempts}/${TRANSIENT_MAX_ATTEMPTS - 1}) — retrying after ${backoffMs / 1000}s`);
				await sleep(backoffMs);
				attempt--;
				continue;
			}
			if (outcome !== "error_max_turns") {
				return { kind: "terminal", cycleResult: finish({ itemId, completed: false, cost, error: `${cfg.name} failed` }) };
			}
			// error_max_turns
			prevMaxTurns = true;
			log(`${noun} hit turn limit (attempt ${attempt}/${maxAttempts})`);
			if (attempt === maxAttempts) {
				return { kind: "terminal", cycleResult: finish({ itemId, completed: false, cost, error: `${cfg.name} failed (max retries)` }) };
			}
			if (!canRetryWithinBudget({ spent: cost, maxBudget, stepBudget: cfg.stepBudget })) {
				return { kind: "terminal", cycleResult: finish({ itemId, completed: false, cost, error: `${cfg.name} failed (insufficient budget to retry after max turns)` }) };
			}
			// budget OK, more attempts remain — continue.
		}
		// Unreachable: the `attempt === maxAttempts` guard returns on the final iteration.
		// Present so the function is total over StepAttempt.
		return { kind: "terminal", cycleResult: finish({ itemId, completed: false, cost, error: `${cfg.name} failed (max retries)` }) };
	}

	// ── Plan + Shakedown-plan ──

	let verdict: "APPROVE" | "REVISE" | "RETHINK" = "APPROVE";
	let shakedownPlanText = "";

	if (shouldRun("plan")) {
		const existingPlan = roadmap.resolvePlanPath({ id: itemId!, worktree: worktree! });
		if (!opts.dryRun && existsSync(existingPlan)) {
			log(`plan exists at ${existingPlan} — skipping plan generation`);
		} else {
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
			});
			if (outcome.kind === "terminal") return outcome.cycleResult;
		}
		const planPath = await roadmap.getItemPlan({ worktree: worktree! });
		if (planPath) log(`plan: file://${planPath}`);
	}

	if (shouldRun("shakedown-plan")) {
		const shakedownPlanArgs = await buildStepArgs(roadmap, itemId!, "plan-review");
		const outcome = await runStepWithRetry({
			name: "shakedown-plan",
			stepBudget: resolveStepSettings(CONFIG, profile, "shakedown-plan").budget,
			buildPrompt: () => expandSkill("shakedown", shakedownPlanArgs),
			logAttempt: (attempt) => log(attempt === 1 ? "shakedown (plan)..." : "continuing shakedown-plan (attempt 2)..."),
			refusedError: "shakedown-plan refused (model declined the review)",
		});
		if (outcome.kind === "terminal") return outcome.cycleResult;

		const shakedown = outcome.result;
		verdict = parseVerdict(shakedown.text);
		shakedownPlanText = shakedown.text;
		const lastStep = steps[steps.length - 1];
		if (lastStep && lastStep.name === "shakedown-plan") lastStep.verdict = verdict;
		log(`verdict: ${verdict}`);
		if (verdict === "RETHINK") return finish({ itemId, completed: false, cost, verdict, error: "plan needs rethink" });
	}

	// ── Implement ──

	if (shouldRun("implement")) {
		const parked = parkExit();
		if (parked) return parked;
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
		const planRef = planPath ? `Read the plan at \`${planPath}\`.` : `Find the plan in \`${resolve(REPO, ".dev", "plans")}/\` (filename matches branch without \`feat/\` prefix).`;
		const worktreeHint = [
			`**Your working directory is**: \`${worktree}\`.`,
			`Any path the plan writes as \`foo/bar\` (project-relative) means \`${worktree}/foo/bar\` — use that absolute form when calling Edit/Write/Bash, so the worktree-isolation hook does not mistake it for a main-repo reference.`,
		].join("\n");

		// Revision input (issue #60): on a resume driven by a red PR review, `--review-findings <path>`
		// points at a findings file the closed-loop workflow wrote. Read best-effort — an absent or
		// unreadable file must never crash a resume; it just means no review preamble is injected.
		let reviewNote = "";
		const findingsPath = flags["review-findings"];
		if (findingsPath) {
			try {
				reviewNote = reviewFindingsPreamble(readFileSync(findingsPath, "utf-8"));
			} catch {
				reviewNote = "";
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
		});
		if (outcome.kind === "terminal") return outcome.cycleResult;
	}

	// ── Shakedown-code ──

	if (shouldRun("shakedown-code")) {
		const planPath = await roadmap.getItemPlan({ worktree: worktree! });
		// The retry (attempt 2) points at the plan file only — NOT "the roadmap entry", which a
		// sandboxed provider can't fetch (#103/#115); the plan already carries the scope.
		const shakedownPlanRef = planPath ? `Read the plan at \`${planPath}\` to understand the scope.` : `Find the plan in \`${resolve(REPO, "docs", "plans")}/\`.`;
		const shakedownCodeArgs = await buildStepArgs(roadmap, itemId!, "code-review");

		const outcome = await runStepWithRetry({
			name: "shakedown-code",
			stepBudget: resolveStepSettings(CONFIG, profile, "shakedown-code").budget,
			commitLabel: () => "shakedown checkpoint",
			refusedError: "shakedown-code refused (model declined the review)",
			turnLimitNoun: "shakedown",
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
		if (outcome.kind === "terminal") return outcome.cycleResult;

		// Harness owns deferred-item creation (#115): under pelaggio the model lists follow-ups as
		// `deferred-item: {json}` markers instead of running `roadmap create-item` (a sandboxed
		// provider can't). Create them in-process, best-effort — a failure logs and continues (they're
		// backlog niceties, not the cycle's deliverable). Skipped in dry-run (no real backlog writes).
		if (!opts.dryRun) {
			for (const d of parseDeferredItems(outcome.result.fullText)) {
				try {
					const created = await roadmap.createItem(d);
					log(`deferred → ${created.id}: ${d.title}`);
				} catch (e) {
					log(`deferred-item create failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
				}
			}
		}
	}

	// ── Ship ──

	{
		const parked = parkExit();
		if (parked) return parked;
	}
	if (!opts.dryRun && !hasDeliverableCommits(worktree!)) {
		log("⚠ no deliverable commits on branch — skipping ship");
		return finish({
			itemId,
			completed: false,
			cost,
			verdict,
			error: "nothing to ship: branch only touches docs/plans/ (plan-only / no implementation)",
		});
	}
	const target = opts.shipTarget;
	const targetSuffix = target.name === "direct-push" ? "" : ` (${target.name})`;
	log(`shipping...${targetSuffix}`);
	const shipPrompt = `${expandSkill("ship", `pelaggio --target=${target.name}`)}\n\n${target.buildPrompt({ itemId: itemId!, worktree: worktree! })}`;

	// Direct-push only: the pipeline owns everything past the merge. Recover any
	// stray MAIN_REPO changes as a commit *before* the agent runs so the merge
	// never faces a dirty tree and never has cause to discard uncommitted work
	// (a prior cycle's deferred create-item, pending bookkeeping, etc.). Never
	// discards — see commitStrayBookkeeping.
	if (!opts.dryRun && target.name === "direct-push") {
		await commitStrayBookkeeping(mainRepo, itemId!, log);
	}

	// Capture pre-ship git state for merge detection (direct-push only).
	const preShipState = !opts.dryRun && target.name === "direct-push" ? captureShipState(mainRepo, worktree!) : null;

	// Fail closed if the pre-ship capture itself failed: `preShipState === null` would
	// otherwise skip the merge-verification block below entirely (its guard requires a
	// truthy preShipState) and fall through to `target.interpretResult(ship)`, which for
	// direct-push blindly returns `completed: ship.ok` with no verification, no shipwreck
	// recovery, and no bookkeeping tail. A repo whose main repo can't answer `rev-parse` is
	// not shippable — refuse before invoking the ship step rather than let the agent merge
	// ungoverned.
	if (target.name === "direct-push" && !opts.dryRun && !preShipState) {
		return finish({
			itemId,
			completed: false,
			cost,
			verdict,
			error: "cannot capture pre-ship git state — refusing to ship blind",
		});
	}

	const ship = await step("ship", shipPrompt, worktree!, {
		...(target.name === "direct-push" ? {} : { effects: (result) => [parseShipDecisionEffect(result, { itemId: itemId!, target: target.name })] }),
	});
	cost += ship.cost;

	if (classifyOutcome(ship) === "error_confinement") {
		return finish({ itemId, completed: false, cost, verdict, error: "ship failed: confinement violation" });
	}

	// Confinement outranks park: a foreign write must not be hidden by checkpoint/
	// resume control flow. Otherwise, a mid-ship rate limit still checkpoints and
	// resumes; a self-reported `blocked` ship is terminal-with-reason before
	// /shipwreck recovery (recovery is retry-in-spirit and would mask the actionable reason).
	{
		const parked = parkExit();
		if (parked) return parked;
	}
	if (classifyOutcome(ship) === "blocked") return finish({ itemId, completed: false, cost, verdict, error: `ship blocked: ${ship.text}` });

	// Direct-push: the agent's job ended at the merge. Detect whether it landed
	// on local `main`, then either run the deterministic bookkeeping tail (the
	// pipeline owns mark-done / archive / push / cleanup) or route to /shipwreck.
	// PR modes never merge in-session, so they skip this and fall through to
	// interpretResult exactly as before.
	if (target.name === "direct-push" && !opts.dryRun && preShipState) {
		const merged = verifyShipLanded(mainRepo, preShipState.mainSha, preShipState.featSha);
		// The skill contract (ship / shipwreck SKILL.md hand-off gates) requires the
		// agent to emit `ship-merged: <itemId>` as proof it reached the gate — i.e. ran
		// post-merge verification — rather than ending its session successfully some
		// other way (issue #37). Session `ok` + an advanced `main` are necessary but not
		// sufficient; without the marker the merge is treated as UNVERIFIED.
		const reportedShipMerged = (r: StepResult): boolean => {
			const id = parseShipMerged(`${r.text}\n${r.fullText}`);
			return id !== null && id.toLowerCase() === itemId!.toLowerCase();
		};
		// The deterministic tail runs ONLY on a cleanly-verified merge. `ship.ok`
		// means the agent completed post-merge verification (SKILL.md step 5) before
		// reporting `ship-merged` — the merge is safe to push. A merge that landed
		// but the agent then ran out of turns (`error_max_turns`) is potentially
		// UNVERIFIED (the ship skill merges in step 4, before verifying in step 5),
		// and a hard failure (`error`) flags a genuine regression — both route to
		// /shipwreck, which re-runs verification with its own budget and can roll
		// the merge back. (There is no consumer-agnostic verification command the
		// tail could run itself — verification is agent-delegated via `_rubric.md`.)
		// DRY the two identical "run the deterministic tail → incomplete on !ok, else
		// completed" call sites (the canTail happy path and the verified-shipwreck
		// recovery path). `cost` is a `let` captured by reference, so each call reads
		// the up-to-date accumulated cost (ship-only for canTail; ship+wreck here).
		const runTail = async (intro: string): Promise<CycleResult> => {
			log(intro);
			const bk = await runShipBookkeeping({ mainRepo, worktree: worktree!, branch: preShipState.branch, itemId: itemId! }, { roadmap, log });
			if (!bk.ok) {
				// A blocking bookkeeping failure (real mark-done/archive error, push
				// failure, or pull conflict): local main holds the merge + bookkeeping
				// (recoverable) and the feature branch was left intact. Surface as an
				// incomplete cycle so origin-never-got-it is visible, not reported shipped.
				log(`⚠ bookkeeping incomplete: ${bk.error}`);
				return finish({ itemId, completed: false, cost, verdict, error: bk.error ?? "ship bookkeeping failed" });
			}
			return finish({ itemId, completed: true, cost, verdict });
		};

		const canTail = merged && ship.ok && reportedShipMerged(ship);
		if (canTail) return runTail("merge landed and verified — running deterministic bookkeeping tail");
		// Not merged (ghost-ship / clean failure) OR merged-but-unverified (agent
		// ran out of turns / hard-failed after merging) → /shipwreck, unless
		// rate-limited / parked (those fall through to interpretResult, preserving
		// today's park semantics).
		if (classifyOutcome(ship) !== "error_rate_limit" && !parkSignal.parked) {
			const reason = merged ? "merge landed but ship did not complete verification" : ship.ok ? "ghost-ship" : "ship failed";
			log(`${reason} — attempting /shipwreck recovery...`);
			shipwrecked = true;
			// Hand shipwreck the same pelaggio/direct-push signal /ship gets so it
			// stops at its hand-off gate (finish + verify the merge, then STOP) instead
			// of running mark-done/archive/push/cleanup itself.
			const wreck = await step("shipwreck", expandSkill("shipwreck", `${itemId!} pelaggio --target=direct-push`), mainRepo, { ownWorktree: worktree! });
			cost += wreck.cost;

			// Tail runs ONLY on a shipwreck that actually LANDED the merge — mirrors the
			// canTail gate (`merged && ship.ok && reportedShipMerged(ship)`), including the
			// #37 marker requirement. verifyShipLanded fails closed, so a shipwreck reporting
			// ok without advancing main (e.g. diagnosed "unknown") never reaches the
			// destructive push/branch-delete steps.
			const recoveredMerge = wreck.ok && reportedShipMerged(wreck) && verifyShipLanded(mainRepo, preShipState.mainSha, preShipState.featSha);
			if (!recoveredMerge) {
				return finish({
					itemId,
					completed: false,
					cost,
					verdict,
					error: merged ? "ship merged but post-merge verification/recovery failed" : ship.ok ? "ship claimed success but main did not advance (recovery also failed)" : "ship failed (recovery also failed)",
				});
			}

			// Shipwreck recovered + verified the merge and handed off at its gate — run
			// the SAME deterministic tail the canTail path runs (issue #30: the #28
			// failure mode had merely relocated to this recovery path).
			return runTail("shipwreck recovered the merge — running deterministic bookkeeping tail");
		}
	}

	// PR modes, dry-run, and direct-push rate-limit fall-through.
	const shipResult = target.interpretResult(ship);
	return finish({
		itemId,
		completed: shipResult.completed,
		cost,
		verdict,
		error: shipResult.error,
		...(shipResult.awaitingMerge ? { awaitingMerge: true } : {}),
		...(shipResult.prUrl ? { prUrl: shipResult.prUrl } : {}),
	});
}

// ── Orchestrator ───────────────────────────────────────────────────────

function resultIcon(r: CycleResult): string {
	if (r.completed) return A.green("✓");
	if (r.error === "parked") return A.yellow("⏸");
	if (r.error === "plan needs rethink") return A.yellow("↻");
	return A.red("✗");
}

function resultStatus(r: CycleResult): "done" | "skipped" | "failed" | "parked" {
	if (r.completed) return "done";
	if (r.error === "parked") return "parked";
	if (r.error === "plan needs rethink") return "skipped";
	return "failed";
}

export interface OrchestratorDeps {
	runPipeline?: typeof runPipeline;
	detectResumeStep?: typeof detectResumeStep;
	resolveWorktree?: typeof resolveWorktree;
	/** Override park/auto-resume policy. Partial — merged onto `CONFIG.park`. Injectable for
	 *  tests to exercise `auto-resume: false` and config-sourced `max-wait` without an
	 *  `.pelaggio.yml` (the orchestrator otherwise reads module-level `CONFIG`). */
	park?: Partial<{ autoResume: boolean; maxWait: string }>;
	/** Override notify config. Partial — merged onto `CONFIG.notify`. Mirrors `park` injection. */
	notifyConfig?: Partial<NotifyConfig>;
	/** Override the notification transport (defaults to `sendNotification`). Spy seam for tests. */
	sendNotification?: typeof sendNotificationDefault;
	/** Local revise sweep config (issue #76). Partial — merged onto the resolved defaults
	 *  (`REVISE_LOCAL`, the github-source-gated `ghRepo`, `defaultGhRun`). Injecting `ghRepo` lets
	 *  tests force-activate the sweep with a stubbed `gh` without a real github-issues config. */
	revise?: Partial<{ local: boolean; ghRepo: string; gh: GhRunner }>;
	/** Local review sweep config (issue #84). Partial — merged onto config defaults. */
	review?: Partial<{
		runner: ReviewRunner;
		ghRepo: string;
		gh: GhRunner;
		statuslessAfter: string;
		runReviewGate: typeof runPrReviewGate;
		now: () => number;
		prepareReviewHead: typeof prepareReviewHead;
		cleanupReviewHead: typeof cleanupReviewHead;
	}>;
}

// Post-reset resume grace: jitter deliberately bounded inside the pre-existing 30s
// post-reset envelope so timer-mocked orchestrator tests need no `tick()` changes.
// delay = 15s + rand(0..15s) ∈ [15s, 30s). Widening these requires updating those tests.
const RESUME_MIN_GRACE_MS = 15_000;
const RESUME_JITTER_MS = 15_000;
// Defensive bound against a pathological park→tiny-reset→park spin. Each real wait is
// minutes+, and `maxWaitMs` already caps each round, so 12 is generous insurance.
const MAX_RESUME_ROUNDS = 12;

// Loud one-time startup banner when an autonomous remote-push target is configured. Pure
// (builder only) so "a banner fires for X, not for Y" is unit-testable without the orchestrator.
// Returns null for the safe default (`pull-request`); a non-null string for the opt-in targets.
export function remotePushWarning(name: ShipTargetName): string | null {
	if (!isAutonomousRemotePush(name)) return null;
	const body = name === "direct-push" ? "It will squash-merge into your local main and push to origin — no PR, no review gate." : "It will open a PR and auto-merge once CI passes — no human review gate.";
	return [A.yellow(A.bold(`⚠  ship.target = ${name} — autonomous remote push`)), A.yellow(`   ${body}`), A.yellow(`   To keep a review gate, set  ship: { target: ${DEFAULT_SHIP_TARGET} }  in .pelaggio.yml.`)].join("\n");
}

export async function runOrchestrator(flags: Flags, deps: OrchestratorDeps = {}, statusBar: StatusBar = new StatusBar(), signal?: AbortSignal): Promise<{ exitCode: number; results: CycleResult[] }> {
	const _runPipeline = deps.runPipeline ?? runPipeline;
	const _detectResumeStep = deps.detectResumeStep ?? detectResumeStep;
	const _resolveWorktree = deps.resolveWorktree ?? resolveWorktree;

	const liveStatus = new LiveStatus(statusBar);
	const parkSignal: ParkSignal = { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };
	const results: CycleResult[] = [];

	const onPause = (): void => {
		parkSignal.parked = true;
		parkSignal.limitType = "paused";
		parkSignal.resetsAt = 0;
	};
	process.on("SIGUSR2", onPause);

	try {
		// Resolve ship target: CLI --target > config SHIP_TARGET > default
		let shipTargetName = SHIP_TARGET;
		if (flags.target !== undefined) {
			if (!isShipTargetName(flags.target)) {
				console.error(`invalid --target ${JSON.stringify(flags.target)}; valid: ${SHIP_TARGET_NAMES.join(", ")}`);
				return { exitCode: 2, results };
			}
			shipTargetName = flags.target;
		}
		const shipTarget = getShipTarget(shipTargetName);

		// One-time startup banner (before the resume/normal branch → fires exactly once, covers
		// both modes; mode- and dry-run-agnostic — a dry run is when an operator most wants to
		// notice an autonomous-push target is configured).
		const warning = remotePushWarning(shipTargetName);
		if (warning) console.log(warning);

		// Resolve no-worktree: --no-worktree flag, CI=true, or PELAGGIO_SINGLE_SHOT=1
		const noWorktree = flags["no-worktree"] || process.env.CI === "true" || process.env.PELAGGIO_SINGLE_SHOT === "1";
		if (noWorktree && !flags.item && !flags.resume) {
			console.error("--no-worktree / CI mode requires --item <ID> or --resume <ID> (explicit id required; no auto-pick)");
			return { exitCode: 2, results };
		}
		if (noWorktree && Number(flags.parallel) > 1) {
			console.error("--no-worktree / CI mode does not support --parallel > 1");
			return { exitCode: 2, results };
		}

		// --from overrides the auto-detected restart step, but only makes sense in resume mode
		// (normal/--item mode has no worktree or plan yet — pick must create them first).
		if (flags.from !== undefined && !flags.resume) {
			console.error("--from <step> requires --resume <id> (it overrides the auto-detected restart step)");
			return { exitCode: 2, results };
		}

		// --review-findings feeds the implement step's revision input on a resume (issue #60);
		// it is meaningless without a resume (a fresh --item run implements from the plan, not findings).
		if (flags["review-findings"] !== undefined && !flags.resume) {
			console.error("--review-findings <path> requires --resume <id> (it feeds the implement step revision input)");
			return { exitCode: 2, results };
		}

		// ── Notifications (issue #34) ──
		// One best-effort webhook per terminal cycle, emitted from deterministic orchestrator
		// code *after* runPipeline returns — so a notification fires even when the agent step
		// died mid-cycle. No-op when unconfigured (url unset) or in --dry-run. The title lookup
		// builds a RoadmapSource only when notifications are enabled (zero cost when disabled).
		const notifyCfg: NotifyConfig = { ...CONFIG.notify, ...deps.notifyConfig };
		const send = deps.sendNotification ?? sendNotificationDefault;
		const notifyEnabled = !!notifyCfg.url && !flags["dry-run"];
		const notifyRoadmap = notifyEnabled ? getRoadmapSource(ROADMAP_SOURCE, { repo: REPO, github: ROADMAP_GITHUB, linear: ROADMAP_LINEAR }) : null;
		const resolveTitle = notifyRoadmap
			? (id: string): Promise<string | undefined> =>
					notifyRoadmap
						.getItem(id)
						.then((i) => i?.title ?? undefined)
						.catch(() => undefined)
			: undefined;
		const notify = async (result: CycleResult, logPath: string): Promise<void> => {
			if (!notifyEnabled) return;
			await notifyCycle(notifyCfg, result, logPath, { send, resolveTitle });
		};

		// Resume mode
		if (flags.resume) {
			const id = flags.resume.toUpperCase();
			const worktree = noWorktree ? REPO : _resolveWorktree(id);
			const v = flags.verbose;

			let startFrom: Step;
			if (flags.from !== undefined) {
				// "pick" is excluded: resume mode starts with the worktree already resolved,
				// so the pick step (worktree/branch creation) never executes — accepting it
				// would silently start at plan instead of honoring the override.
				if (!isPipelineStep(flags.from) || flags.from === "pick") {
					console.error(`invalid --from ${JSON.stringify(flags.from)}; valid: ${STEPS.filter((s) => s !== "pick").join(", ")}`);
					return { exitCode: 2, results };
				}
				startFrom = flags.from;
				console.log(`${A.bold("resume")} ${id} from ${A.bold(startFrom)} ${A.dim("(--from override)")}`);
			} else if (flags["review-findings"] !== undefined) {
				startFrom = "implement";
				console.log(`${A.bold("resume")} ${id} from ${A.bold(startFrom)} ${A.dim("(--review-findings)")}`);
			} else {
				startFrom = _detectResumeStep(id, worktree);
				console.log(`${A.bold("resume")} ${id} from ${A.bold(startFrom)}`);
			}

			const status: CycleStatus = { itemId: id, status: "running", cost: 0 };
			liveStatus.cycles.push(status);
			liveStatus.totalCycles = 1;
			if (v) statusBar.setup();

			const result = await _runPipeline(
				{
					itemId: id,
					worktree,
					startFrom,
					cycle: 1,
					verbose: v,
					shipTarget,
					dryRun: false,
					workerStatus: status,
					liveStatus,
					...(noWorktree ? { noWorktree: true } : {}),
					...(signal ? { signal } : {}),
				},
				parkSignal,
				flags,
			);
			results.push(result);
			await notify(result, LOG_PATH);

			status.status = resultStatus(result);
			status.step = undefined;
			if (v) {
				liveStatus.render();
				statusBar.teardown();
			}
			console.log(`\n${result.completed ? A.green("✓") : A.red("✗")} ${id} — ${result.costEstimated ? "~" : ""}$${result.cost.toFixed(2)}`);
			return { exitCode: result.completed ? 0 : 1, results };
		}

		// Normal mode
		const requestedCycles = parseInt(flags.cycles, 10);
		const parallel = parseInt(flags.parallel, 10);
		const items =
			flags.item
				?.split(",")
				.map((s) => s.trim())
				.filter(Boolean) ?? [];
		// Auto-derive cycles to cover the full item list when --cycles isn't
		// explicitly sized for it — otherwise items beyond index `max(cycles-1,
		// parallel-1)` would silently drop off the worker queue.
		const cycles = Math.max(requestedCycles, parallel, items.length);
		// Provider-estimated spend (e.g. Codex on a subscription) counts toward `--budget` the same
		// as billed USD — deliberate: it fails safe (a subscription run still respects the cap as a
		// token-spend proxy) and the warning below marks the figure `~` so it never reads as real USD.
		const maxBudget = parseFloat(flags.budget);
		const dryRun = flags["dry-run"];
		const v = flags.verbose;
		const isParallel = parallel > 1;

		const targetBanner = shipTargetName === DEFAULT_SHIP_TARGET ? "" : `  ${A.dim(`target=${shipTargetName}`)}`;
		console.log(`${A.bold("pelaggio")}  ${cycles} cycle(s)${isParallel ? `  ${A.dim("×")}${parallel} parallel` : ""}  ${A.dim("budget")} $${maxBudget.toFixed(2)}${targetBanner}${dryRun ? `  ${A.yellow("[DRY RUN]")}` : ""}`);
		if (isParallel && v) {
			console.log(`${A.dim("logs")}  .dev/pelaggio-{N}.log`);
		}
		console.log("");

		liveStatus.totalCycles = cycles;
		liveStatus.multiline = isParallel;
		if (v) {
			const rows = process.stderr.rows || 24;
			const barLines = isParallel ? Math.min(parallel + 1, Math.floor(rows / 3)) : 2;
			statusBar.setup(barLines);
		}

		const statusInterval = isParallel && v && TUI_ENABLED ? setInterval(() => liveStatus.render(), 200) : null;

		const pickMutex = isParallel ? createMutex() : undefined;
		let nextCycle = 0;
		let totalSpent = 0;
		// Consecutive "transient sdk error" cycle outcomes across the whole worker pool
		// (issue #128) — reset by any other outcome. Shared across parallel workers since
		// it tracks the campaign's overall health, not any one worker's.
		let consecutiveTransientErrors = 0;
		// Single-sourced with `notify.ts`'s classifier via `RECOVERABLE_ERRORS` (types.ts) to
		// prevent drift. `pick:unknown-id` and `pick:blocked` are intentionally *absent* — fatal
		// so typos in `--item X,Y,Z` and user-requested blocked items halt loudly instead of
		// silently skipping. `pick:unknown` (parser fallback) stays recoverable.
		const RECOVERABLE = new Set<string>(RECOVERABLE_ERRORS);

		async function worker(): Promise<void> {
			while (true) {
				const cycle = ++nextCycle;
				if (cycle > cycles) return;
				if (totalSpent >= maxBudget) {
					// If any spend so far was a provider-side estimate, mark the figure so it doesn't
					// read as billed USD against the --budget threshold (#80).
					const est = results.some((r) => r.costEstimated);
					console.log(`${A.yellow("⚠")} spend (${est ? "~" : ""}$${totalSpent.toFixed(2)}) exceeds --budget threshold ($${maxBudget.toFixed(2)})${est ? A.dim(" — spend includes provider estimates") : ""}`);
				}

				const status: CycleStatus = {
					itemId: items[cycle - 1] ?? "…",
					status: "running",
					cost: 0,
				};
				liveStatus.cycles.push(status);
				if (v) liveStatus.render();

				let logPath: string | undefined;
				if (isParallel && v) {
					mkdirSync(resolve(REPO, ".dev"), { recursive: true });
					logPath = resolve(REPO, ".dev", `pelaggio-${cycle}.log`);
					appendFileSync(logPath, `${"=".repeat(60)}\nautopilot cycle ${cycle} — ${new Date().toISOString()}\n${"=".repeat(60)}\n`);
				}

				const result = await _runPipeline(
					{
						itemId: items[cycle - 1],
						cycle,
						verbose: !isParallel && v,
						shipTarget,
						dryRun,
						pickMutex,
						workerStatus: status,
						logPath,
						liveStatus,
						...(noWorktree ? { noWorktree: true } : {}),
						...(signal ? { signal } : {}),
					},
					parkSignal,
					flags,
				);

				// Sustained-outage detection (#128): a lone "transient sdk error" cycle stays
				// recoverable (#127) so the worker keeps pulling. But N in a row — no other
				// outcome between them — means the provider, not the item, is the problem;
				// relabel this cycle `parked` so it pages (notify's classifier pages `parked`
				// but not `transient sdk error`) and flows into the same park-and-resume path
				// a rate-limit park uses, instead of quietly burning the rest of --cycles.
				if (result.error === "transient sdk error") {
					consecutiveTransientErrors++;
					if (consecutiveTransientErrors >= CONSECUTIVE_TRANSIENT_ERROR_LIMIT && !parkSignal.parked) {
						parkSignal.parked = true;
						parkSignal.resetsAt = 0;
						parkSignal.limitType = "sdk-outage";
						parkSignal.triggerWorker = result.itemId ?? "";
						result.error = "parked";
					}
				} else {
					consecutiveTransientErrors = 0;
				}

				totalSpent += result.cost;
				results.push(result);
				await notify(result, logPath ?? LOG_PATH);

				status.itemId = result.itemId ?? "?";
				status.status = resultStatus(result);
				status.cost = result.cost;
				status.step = undefined;
				status.turns = undefined;

				const logRef = logPath ? `  ${A.dim(`→ .dev/pelaggio-${cycle}.log`)}` : "";
				console.log(`${resultIcon(result)} cycle ${cycle}: ${A.bold(result.itemId ?? "?")} — ${result.costEstimated ? "~" : ""}$${result.cost.toFixed(2)}${result.error ? `  ${A.dim(result.error)}` : ""}${logRef}`);

				if (v) liveStatus.render();

				if (parkSignal.parked) break;
				if (!result.completed && !RECOVERABLE.has(result.error ?? "")) return;
			}
		}

		// ── Local review sweep (issue #84) ──
		//
		// In local review mode the trusted local tree owns the review CLI/skill/parser/status
		// posting code. PR heads are only diff/file data. This sweep posts `review` commit
		// statuses before the existing revise sweep runs, so a fresh local BLOCK is immediately
		// visible to `findRevisablePrs` below.
		const review = {
			runner: REVIEW_CONFIG.runner,
			statuslessAfter: REVIEW_CONFIG.statuslessAfter,
			ghRepo: ROADMAP_SOURCE === "github-issues" ? ROADMAP_GITHUB.ghRepo : "",
			gh: defaultGhRun,
			runReviewGate: runPrReviewGate,
			now: () => Date.now(),
			prepareReviewHead,
			cleanupReviewHead,
			...deps.review,
		};
		const shipIsPr = shipTargetName === "pull-request" || shipTargetName === "auto-merge-pr";
		const doReviewSweep = review.runner === "local" && shipIsPr && !!review.ghRepo && !noWorktree && !dryRun && items.length === 0;

		if (doReviewSweep) {
			const { candidates, stranded } = findReviewCandidates(review.gh, review.ghRepo, review.now(), parseWaitFlag(review.statuslessAfter));
			for (const pr of stranded) {
				postLocalModeWorkflowComment(review.gh, review.ghRepo, pr.prNumber);
				if (notifyEnabled) await notifyStrandedReview(notifyCfg, { itemId: pr.itemId, prNumber: pr.prNumber, ghRepo: review.ghRepo, headSha: pr.headSha, logPath: LOG_PATH }, { send });
			}

			for (const pr of candidates) {
				if (parkSignal.parked) break;
				if (!isAutopilotManaged(review.gh, review.ghRepo, pr.itemId, ROADMAP_GITHUB.label)) continue;
				if (!postReviewStatus(review.gh, review.ghRepo, pr.headSha, "pending", "local pelaggio review running")) continue;
				let body = "";
				let finalState: "success" | "failure" = "failure";
				let reviewCost = 0;
				let reviewCostEstimated = false;
				try {
					const prepared = review.prepareReviewHead(REPO, pr);
					if (!prepared) throw new Error("could not prepare PR head for local review");
					const result = await review.runReviewGate({
						pr: String(pr.prNumber),
						profile: "standard",
						cwd: REPO,
						diffCwd: prepared.diffCwd,
						diffBaseRef: prepared.baseRef,
						diffHeadRef: prepared.headRef,
					});
					body = result.body;
					finalState = result.gate === "pass" ? "success" : "failure";
					reviewCost = result.cost;
					reviewCostEstimated = result.costEstimated;
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					body = buildFailClosedComment("error_crash", `local pr-review crashed before producing a review, so this gate blocks the merge.\n\n${msg}`);
					finalState = "failure";
				} finally {
					review.cleanupReviewHead(REPO, pr);
				}
				upsertReviewComment(review.gh, review.ghRepo, pr.prNumber, body);
				postReviewStatus(review.gh, review.ghRepo, pr.headSha, finalState, finalState === "success" ? "local pelaggio review passed" : "local pelaggio review blocked");
				totalSpent += reviewCost;
				console.log(`review ${pr.itemId}#${pr.prNumber} — ${finalState}${reviewCost > 0 ? ` ${reviewCostEstimated ? "~" : ""}$${reviewCost.toFixed(2)}` : ""}`);
			}
		}

		// ── Revise sweep (issue #76) ──
		//
		// Before the pick worker pool, sweep for red-review PRs and revise each in-process on the
		// local Claude subscription — the same in-process resume the park/auto-resume loop uses
		// (`startFrom: "implement"` + a fetched `--review-findings` file). Auto-pick mode only
		// (`items.length === 0`): naming `--item X,Y` means "do exactly these". A hard no-op unless
		// the repo is github-issues + a PR ship target; any gh/git error skips fail-soft and the
		// normal pick loop proceeds. Revisions do NOT consume `--cycles` (that sizes *new-work*
		// throughput) but DO count toward `--budget` (a revision still spends real money), so each
		// result is pushed into `results` and its cost added to `totalSpent`.
		const revise = {
			local: REVISE_LOCAL,
			ghRepo: ROADMAP_SOURCE === "github-issues" ? ROADMAP_GITHUB.ghRepo : "",
			gh: defaultGhRun,
			...deps.revise,
		};
		const doSweep = revise.local && shipIsPr && !!revise.ghRepo && !noWorktree && !dryRun && items.length === 0;

		if (doSweep) {
			const { revisable, labeledStillRed } = findRevisablePrs(revise.gh, revise.ghRepo);
			// PRs already past their one revision pass but still red → idempotent human handoff.
			for (const pr of labeledStillRed) postParkComment(revise.gh, revise.ghRepo, pr.prNumber);

			for (const pr of revisable) {
				if (parkSignal.parked) break; // a park mid-sweep stops starting new revisions
				if (!isAutopilotManaged(revise.gh, revise.ghRepo, pr.itemId, ROADMAP_GITHUB.label)) continue;
				if (!claimRevision(revise.gh, revise.ghRepo, pr.prNumber)) continue; // one-pass label BEFORE any work
				const findingsPath = reviseFindingsPath(REPO, pr.itemId);
				if (!fetchReviewFindings(revise.gh, revise.ghRepo, pr.prNumber, findingsPath)) {
					// labeled but no findings comment → fail-safe park + skip (mirrors CI).
					postParkComment(revise.gh, revise.ghRepo, pr.prNumber);
					continue;
				}
				const wt = ensureReviseWorktree(_resolveWorktree(pr.itemId), pr.branch, { repo: REPO });
				if (!wt) continue;

				const status: CycleStatus = { itemId: pr.itemId, status: "running", cost: 0 };
				liveStatus.cycles.push(status);
				if (v) liveStatus.render();
				const r = await _runPipeline(
					{
						itemId: pr.itemId,
						worktree: wt,
						startFrom: "implement",
						cycle: results.length + 1,
						verbose: !isParallel && v,
						shipTarget,
						dryRun: false,
						workerStatus: status,
						liveStatus,
						...(signal ? { signal } : {}),
					},
					parkSignal,
					{ ...flags, "review-findings": findingsPath }, // per-item findings injection
				);
				totalSpent += r.cost;
				results.push(r);
				await notify(r, LOG_PATH);
				status.status = resultStatus(r);
				status.cost = r.cost;
				status.step = undefined;
				if (v) liveStatus.render();
				console.log(`${resultIcon(r)} revise ${pr.itemId} — ${r.costEstimated ? "~" : ""}$${r.cost.toFixed(2)}${r.error ? `  ${A.dim(r.error)}` : ""}`);
			}
		}

		// Skip the pick worker pool entirely if the sweep already parked — its parked revisions
		// are in `results` (pushed above), so they flow into the park-and-resume block below.
		if (!parkSignal.parked) {
			await Promise.all(Array.from({ length: Math.min(parallel, cycles) }, () => worker()));
		}

		// ── Park-and-resume ──
		//
		// Config-driven, multi-window (issue #32): after each wait+resume, if work re-parks
		// in a *later* rate-limit window we wait again — up to MAX_RESUME_ROUNDS — so an
		// overnight run spanning several 5h windows keeps going. `park.auto-resume: false`
		// is the explicit off-switch (hand the prompt back immediately). CLI `--max-wait`
		// overrides config `park.max-wait`, which overrides the built-in 6h.

		if (parkSignal.parked) {
			if (v) statusBar.teardown();
			if (statusInterval) clearInterval(statusInterval);

			const park = { ...CONFIG.park, ...deps.park };
			const autoResume = park.autoResume;
			const maxWaitMs = parseWaitFlag(flags["max-wait"] ?? park.maxWait);

			const resetParkSignal = (): void => {
				parkSignal.parked = false;
				parkSignal.resetsAt = 0;
				parkSignal.limitType = "";
				parkSignal.triggerWorker = "";
			};

			// Per-item resume body — the `--resume` re-entry path in-process. Reused each
			// round of the loop, so the resume-worktree/log/detect wiring lives in one place.
			const resumeOne = async (id: string, i: number): Promise<CycleResult> => {
				const wt = noWorktree ? REPO : _resolveWorktree(id);
				const st: CycleStatus = { itemId: id, status: "running", cost: 0 };
				liveStatus.cycles.push(st);
				if (v) liveStatus.render();
				let resumeLogPath: string | undefined;
				if (isParallel && v) {
					resumeLogPath = resolve(REPO, ".dev", `pelaggio-resume-${id.toLowerCase()}.log`);
					appendFileSync(resumeLogPath, `${"=".repeat(60)}\nresume ${id} — ${new Date().toISOString()}\n${"=".repeat(60)}\n`);
				}
				// Findings survival across park→auto-resume (issue #76): if the sweep-written
				// findings file still exists on disk, re-inject it before choosing the restart step so
				// the resumed item routes through implement and still fixes the specific blockers.
				// Inert for non-revision items — no findings file is present, so `flags` passes
				// through unchanged.
				let resumeFlags = flags;
				if (!flags["review-findings"]) {
					const fp = reviseFindingsPath(REPO, id);
					if (existsSync(fp)) resumeFlags = { ...flags, "review-findings": fp };
				}
				const sf = resumeFlags["review-findings"] ? "implement" : _detectResumeStep(id, wt);
				const r = await _runPipeline(
					{
						itemId: id,
						worktree: wt,
						startFrom: sf,
						cycle: results.length + i + 1,
						verbose: !isParallel && v,
						shipTarget,
						dryRun: false,
						workerStatus: st,
						logPath: resumeLogPath,
						liveStatus,
						...(noWorktree ? { noWorktree: true } : {}),
						...(signal ? { signal } : {}),
					},
					parkSignal,
					resumeFlags,
				);
				await notify(r, resumeLogPath ?? LOG_PATH);
				st.status = resultStatus(r);
				st.cost = r.cost;
				st.step = undefined;
				if (v) liveStatus.render();
				console.log(`${resultIcon(r)} resume ${id} — ${r.costEstimated ? "~" : ""}$${r.cost.toFixed(2)}${r.error ? `  ${A.dim(r.error)}` : ""}`);
				return r;
			};

			let pending = results.filter((r) => r.error === "parked" && r.itemId).map((r) => r.itemId!);

			if (pending.length === 0) {
				console.log(`${A.yellow("⏸")} Rate limit hit but no items to resume.`);
				return { exitCode: 1, results };
			}

			// Off-switch: auto-resume disabled → report parked items and hand the prompt back.
			if (!autoResume) {
				console.log("");
				console.log(`${A.yellow("⏸")} ${parkSignal.limitType} limit hit — auto-resume disabled`);
				console.log(`  Parked: ${pending.join(", ")}`);
				console.log(`  Resume: ${A.bold(formatResumeHint(pending))}`);
				return { exitCode: 1, results };
			}

			let round = 0;
			while (parkSignal.parked && pending.length > 0 && round < MAX_RESUME_ROUNDS) {
				round++;
				const waitMs = parkSignal.resetsAt - Date.now();
				const isWeekly = /week/i.test(parkSignal.limitType);
				const resumeCmd = formatResumeHint(pending);

				// No reset time → never spin (checked every round, not just the first). Rate-limit
				// parks now synthesize a conservative reset upstream (#68), so this branch is reached
				// only by a manual pause (SIGUSR2, resetsAt=0) or a stale reset already in the past —
				// neither is auto-resumable by time. `break` (not `return`) so we funnel through the
				// shared teardown+summary below — a round-≥2 exit here would otherwise leak the
				// status-bar scroll region set up by the prior round's `statusBar.setup()`.
				if (!parkSignal.resetsAt || waitMs <= 0) {
					console.log("");
					console.log(`${A.yellow("⏸")} ${parkSignal.limitType} limit hit — cannot auto-resume (no reset time)`);
					console.log(`  Parked: ${pending.join(", ")}`);
					console.log(`  Resume: ${A.bold(resumeCmd)}`);
					break;
				}

				if (waitMs > maxWaitMs) {
					const label = isWeekly ? "Weekly rate limit" : `${parkSignal.limitType} limit`;
					console.log("");
					console.log(`${A.yellow("⏸")} ${label} — wait ${fmtWait(waitMs)} exceeds --max-wait ${fmtWait(maxWaitMs)}`);
					console.log(`  Parked: ${pending.join(", ")}`);
					console.log(`  Resume: ${A.bold(resumeCmd)}`);
					break;
				}

				// Jitter within the existing 30s post-reset envelope (see the constants above)
				// so timer-mocked tests need no change: delay ∈ [15s, 30s).
				const delay = RESUME_MIN_GRACE_MS + Math.floor(Math.random() * RESUME_JITTER_MS);
				const resumeAt = parkSignal.resetsAt + delay;
				const eta = new Date(resumeAt).toLocaleTimeString("en-CA", { hour12: false });
				console.log("");
				console.log(`${A.yellow("⏸")} ${A.bold("Parked")} — ${parkSignal.limitType} limit, waiting ${fmtWait(waitMs)} (ETA ${eta})`);
				console.log(`  Items: ${pending.join(", ")}`);

				const countdownInterval = setInterval(() => {
					const remaining = resumeAt - Date.now();
					if (remaining > 0) {
						console.log(`  ${A.dim("⏳")} ${fmtWait(remaining)} remaining...`);
					}
				}, 5 * 60_000);

				await new Promise((r) => setTimeout(r, resumeAt - Date.now()));
				clearInterval(countdownInterval);

				resetParkSignal();

				console.log(`\n${A.green("▶")} ${A.bold("Resuming")} ${pending.length} item(s)...`);

				if (v) {
					liveStatus.cycles = [];
					liveStatus.totalCycles = pending.length;
					statusBar.setup();
				}

				const batch = await Promise.all(pending.map((id, i) => resumeOne(id, i)));
				results.push(...batch);
				pending = batch.filter((r) => r.error === "parked" && r.itemId).map((r) => r.itemId!);
			}

			if (round >= MAX_RESUME_ROUNDS && parkSignal.parked) {
				console.log(`${A.yellow("⏸")} auto-resume round cap (${MAX_RESUME_ROUNDS}) reached — leaving remaining items parked`);
			}

			// `totalSpent` is authoritatively recomputed from `results` here (the resume rounds
			// pushed their cycles), so per-round spend needs no manual bookkeeping.
			totalSpent = results.reduce((s, r) => s + r.cost, 0);
		}

		if (v) statusBar.teardown();
		if (statusInterval) clearInterval(statusInterval);
		console.log("");
		console.log(`${A.bold("summary")}  $${totalSpent.toFixed(2)} across ${results.length} cycle(s)${isParallel ? `  ${A.dim("×")}${parallel} parallel` : ""}`);
		for (const r of results) {
			let label: string;
			if (r.completed && r.awaitingMerge) {
				label = `${A.green("↗ PR opened")}${r.prUrl ? ` ${A.dim(r.prUrl)}` : ""}`;
			} else if (r.completed) {
				label = A.green("shipped");
			} else {
				label = A.dim(r.error ?? "failed");
			}
			console.log(`  ${resultIcon(r)} ${r.itemId ?? "?"}: ${label}`);
		}

		return { exitCode: results.every((r) => r.completed) ? 0 : 1, results };
	} finally {
		process.off("SIGUSR2", onPause);
	}
}

export async function orchestrate(flags: Flags): Promise<void> {
	const statusBar = new StatusBar();
	const cleanup = (): void => {
		statusBar.teardown();
		process.stderr.write(A.showCursor);
	};
	process.on("exit", cleanup);

	// Two-stage SIGINT: first aborts in-flight SDK call and gives a 2s grace window
	// for the orchestrator to unwind cleanly; second Ctrl-C bypasses grace (standard
	// Unix expectation — first interrupt is polite, second is force). `.unref()`
	// lets the process exit naturally if the promise resolves before the timer.
	const controller = new AbortController();
	let sigintCount = 0;
	process.on("SIGINT", () => {
		sigintCount += 1;
		if (sigintCount >= 2) {
			cleanup();
			process.exit(130);
		}
		controller.abort();
		setTimeout(() => {
			cleanup();
			process.exit(130);
		}, 2_000).unref();
	});

	const { exitCode } = await runOrchestrator(flags, {}, statusBar, controller.signal);
	process.exit(exitCode);
}
