import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	CONFIG,
	CONFINEMENT_CONFIG,
	DEFAULT_SHIP_TARGET,
	isPipelineStep,
	LOG_PATH,
	type PipelineStep,
	REPO,
	REVIEW_CONFIG,
	REVISE_LOCAL,
	type ReviewRunner,
	ROADMAP_GITHUB,
	ROADMAP_LINEAR,
	ROADMAP_SOURCE,
	resolveDriverCandidates,
	resolveProviderBin,
	resolveStepSettings,
	SHIP_TARGET,
	STEPS,
	WORKTREE_PREFIX,
} from "./config.js";
import { forbiddenRootsForConfinement } from "./confinement/roots.js";
import { type AcceptedSession, captureEvaluatorContext, createSessionController, firstDiffPathsByRoot, resolveEligibleSessions, revalidateChangedRoot, type SessionController, type SessionEvaluatorContext } from "./confinement/sessions.js";
import { continuousCycleCap, DayBudgetTracker, freeQueueProbe, nextLocalMidnightMs, resolveContinuousConfig } from "./continuous.js";
import { appendDecisions as appendDecisionsDefault, appendReviewEscalation as appendReviewEscalationDefault, lookupReviewEscalation as lookupReviewEscalationDefault } from "./decisions.js";
import { createDriverAssignmentState, type DriverIdentity, recordArtifactAuthor, resolveStaticAuthor, selectAuthor, selectReviewers } from "./driver-assignment.js";
import {
	dispatchStepEffects as dispatchStepEffectsDefault,
	type Effect,
	type EffectsContext,
	EffectsManifestError,
	type ReviewEscalationEffect,
	type ReviewSeatIdentity,
	type ReviewVerdictEffect,
	writeEffectsManifest as writeEffectsManifestDefault,
} from "./effects.js";
import { digestChallenge } from "./execution-receipt.js";
import { createEventWriter } from "./flow-events.js";
import { DEFAULT_FLOW_POLICY, type FlowPolicy } from "./flow-policy.js";
import {
	appendLog as appendLogDefault,
	buildReviewDiffBlock,
	buildStepArgs,
	canRetryWithinBudget,
	captureShipState,
	checkpoint,
	classifyCycleDisposition,
	classifyOutcome,
	computeImplementTurns,
	createMainCheckoutDeltaObserver,
	createMutex,
	detectResumeStep,
	diffForbiddenRootSnapshots,
	ensureCheckpointed,
	ensureMainCheckoutOnBranch,
	expandSkill,
	filesChangedSince,
	findLoggedArtifactAuthor,
	fmtWait,
	formatResumeHint,
	getArtifactHeadSha,
	getHeadSha,
	gitDiffNameOnly,
	hasDeliverableCommits,
	isTransientSdkError,
	listWorktrees as listWorktreesDefault,
	parseDeferredItems,
	parsePickItem,
	parsePickResult,
	parseShipMerged,
	parseVerdict,
	parseWaitFlag,
	pickDivergedFromPin,
	quarantineCheckpoint,
	readGitBinding,
	readRuntimeVersions,
	resolveWorktree,
	revertPlanPolish,
	reviewFindingsPreamble,
	snapshotForbiddenRoots,
	stepIndex,
	uniqueDriverProvenance,
	verifyShipLanded,
} from "./helpers.js";
import { type NotifyConfig, notifyCycle, notifyDecision as notifyDecisionEvent, notifyStrandedReview, sendNotification as sendNotificationDefault } from "./notify.js";
import { buildFailClosedComment, runPrReviewGate } from "./pr-review-cli.js";
import { capabilityMapFrom, resolveAuthoringReviewConfig } from "./provider-routing.js";
import { runReviewLoop } from "./review/loop.js";
import { type ReviewRecord, renderReviewRecord, writeReviewRecord } from "./review/record.js";
import { cleanupAuthoringReviewSeatsForSha, isAuthoringReviewSeatPath, prepareAuthoringReviewSeat } from "./review/seats.js";
import { cleanupReviewHead, findReviewCandidates, isReviewHeadPath, postLocalModeWorkflowComment, postReviewStatus, prepareReviewHead, upsertReviewComment } from "./review-sweep.js";
import { claimRevision, ensureReviseWorktree, fetchReviewFindings, findRevisablePrs, isAutopilotManaged, postParkComment, reviseFindingsPath } from "./revise-sweep.js";
import { defaultGhRun, type GhRunner } from "./roadmap/github-issues.js";
import { getRoadmapSource, type RoadmapSource } from "./roadmap/index.js";
import { cleanupShipBodyFile, parseShipDecisionEffect, shipBodyFile } from "./ship/decision.js";
import { commitStrayBookkeeping, getShipTarget, isAutonomousRemotePush, isShipTargetName, runShipBookkeeping as runShipBookkeepingDefault, SHIP_TARGET_NAMES } from "./ship/index.js";
import { extractPrUrl } from "./ship/pull-request.js";
import { getProvider, REGISTERED_PROVIDERS, type RunStepFn, runStep as runStepDefault } from "./step-runner.js";
import { A, createStepRenderer, fmtElapsed, LiveStatus, StatusBar, TUI_ENABLED } from "./tui.js";
import {
	type CycleDisposition,
	type CycleGitBinding,
	type CycleResult,
	type CycleStatus,
	type CycleVersionProvenance,
	type ExecutionReceiptDescriptor,
	type Flags,
	type ParkSignal,
	type PipelineOpts,
	RECOVERABLE_ERRORS,
	type ShipTargetName,
	type Step,
	type StepLog,
	type StepResult,
} from "./types.js";

// ── Pipeline ───────────────────────────────────────────────────────────

// Re-export so mocks.ts can keep resolving `import type { RunStepFn } from "../pipeline.js"`.
export type { RunStepFn };

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
// Shared across workers and reset by any non-quarantine outcome, so this only trips
// on an unbroken no-ship streak. Five tolerates a few independent blocked items.
const CONSECUTIVE_QUARANTINE_LIMIT = 5;
// #388: cadence for the mid-step forbidden-root prober that runs concurrently with an
// in-flight provider call. Bounds a mid-step confinement violation's cost to roughly one
// interval instead of the whole step, without polling git status so often it competes with
// the step's own work. Overridable in tests via PipelineDeps.confinementProbeIntervalMs.
const CONFINEMENT_PROBE_INTERVAL_MS = 15_000;

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
	/** Test seam: replace whole-step forbidden-root snapshot collection. */
	snapshotForbiddenRoots?: typeof snapshotForbiddenRoots;
	/** Test seam: replace forbidden-root snapshot comparison. */
	diffForbiddenRootSnapshots?: typeof diffForbiddenRootSnapshots;
	/** Test seam: replace session-record eligibility resolution (#369). */
	resolveEligibleSessions?: typeof resolveEligibleSessions;
	/** Test seam: replace diff-time session revalidation (#369). */
	revalidateChangedRoot?: typeof revalidateChangedRoot;
	/** Test seam: override the mid-step confinement prober's polling interval (#388). */
	confinementProbeIntervalMs?: number;
	/** Test seam: replace evaluator-context capture (#369). */
	captureEvaluatorContext?: typeof captureEvaluatorContext;
	/** Test seam: replace session-controller factory (#369). */
	createSessionController?: typeof createSessionController;
	appendDecisions?: typeof appendDecisionsDefault;
	appendReviewEscalation?: typeof appendReviewEscalationDefault;
	lookupReviewEscalation?: typeof lookupReviewEscalationDefault;
	now?: () => number;
	readGitBinding?: typeof readGitBinding;
	readRuntimeVersions?: typeof readRuntimeVersions;
}

// Test seam (#304): the pipeline flow tests stub provider availability so they do
// not depend on the codex/grok driver binaries being installed on the runner.
// Production always uses the real binary-presence check below; only pipeline.test.ts
// sets this (in its `before`, restored in `after`). Without it, on a claude-only host
// (e.g. CI) the reviewer-not-author selection fails closed and every flow test parks.
let providerAvailableForTests: ((candidate: DriverIdentity) => boolean) | undefined;
export function __setProviderAvailableForTests(fn: ((candidate: DriverIdentity) => boolean) | undefined): void {
	providerAvailableForTests = fn;
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
	const snapshotForbiddenRootsFn = deps.snapshotForbiddenRoots ?? snapshotForbiddenRoots;
	const diffForbiddenRootSnapshotsFn = deps.diffForbiddenRootSnapshots ?? diffForbiddenRootSnapshots;
	const resolveEligibleSessionsFn = deps.resolveEligibleSessions ?? resolveEligibleSessions;
	const revalidateChangedRootFn = deps.revalidateChangedRoot ?? revalidateChangedRoot;
	const confinementProbeIntervalMs = deps.confinementProbeIntervalMs ?? CONFINEMENT_PROBE_INTERVAL_MS;
	const captureEvaluatorContextFn = deps.captureEvaluatorContext ?? captureEvaluatorContext;
	const createSessionControllerFn = deps.createSessionController ?? createSessionController;
	const appendDecisions = deps.appendDecisions ?? appendDecisionsDefault;
	const appendReviewEscalation = deps.appendReviewEscalation ?? appendReviewEscalationDefault;
	const lookupReviewEscalation = deps.lookupReviewEscalation ?? lookupReviewEscalationDefault;
	const now = deps.now ?? Date.now;
	const readGitBindingFn = deps.readGitBinding ?? readGitBinding;
	const readRuntimeVersionsFn = deps.readRuntimeVersions ?? readRuntimeVersions;
	// Per-cycle challenge for execution receipts (#188). Held in process memory only;
	// only challengeDigest is persisted on receipts / cycle provenance.
	const cycleChallenge = randomBytes(32);
	const cycleChallengeDigest = digestChallenge(cycleChallenge);

	// #369: capture immutable evaluator context once per cycle when the caller
	// (orchestrator or test) did not pre-supply it. Direct runPipeline() callers
	// and tests must not skip inventory.
	const sessionEvaluator: SessionEvaluatorContext = opts.sessionEvaluator ?? captureEvaluatorContextFn(mainRepo);
	/** Live session controller for this cycle's own record; disposed in finish(). */
	let sessionController: SessionController | undefined;
	// The cycle's dollar ceiling. A turn-exhaustion retry (issue #33) is funded up to the
	// step's configured budget again, so the budget guard skips a retry we can't fully fund.
	// A non-finite value (unset / unparseable --budget) disables the dollar gate.
	const maxBudget = Number.parseFloat(flags.budget);
	let cost = 0;
	// A pinned --profile (issue #247) takes control of the whole run; otherwise default to
	// "standard" and let quick-scope detection downgrade to "quick" below.
	let profile = flags.profile ?? "standard";
	const steps: StepLog[] = [];
	const provenanceUnavailable: string[] = [];
	/** Descriptors for every execution receipt written this cycle (steps + aggregate review). */
	const executionReceipts: ExecutionReceiptDescriptor[] = [];
	const assignment = createDriverAssignmentState(opts.cycle);
	const pipelineT0 = now();
	const runIdBase = opts.logPath ? basename(opts.logPath, extname(opts.logPath)) : `cycle-${opts.cycle}`;
	let logLabel = `cycle ${opts.cycle}`;
	const log = (msg: string): void => {
		const elapsed = fmtElapsed(now() - pipelineT0);
		const ts = new Date().toLocaleTimeString("en-CA", { hour12: false });
		console.log(`${A.dim(ts)} [${logLabel}] ${A.dim(elapsed)} ${msg}`);
	};

	/** Shared observeGit for effects dispatch: post-dispatch binding from readGitBinding. */
	const observeGitForReceipt = (cwd: string): { worktree: string | null; headSha: string | null; branch: string | null } => {
		const binding = readGitBindingFn(cwd, mainRepo);
		return { worktree: binding.worktree, headSha: binding.headSha, branch: binding.branch };
	};
	if (allowDirtyMain) {
		log(
			"⚠ confinement.allow-dirty-main is active: operator main-checkout changes between tool windows are tolerated; Claude mutating-tool deltas and sibling changes remain audited, while Codex excludes main through its workspace boundary; simultaneous changes inside a tool window fail closed",
		);
	}

	function forbiddenRootsForStep(cwd: string, ownWorktree?: string): { roots: string[]; excludedSessions: AcceptedSession[] } {
		const cwdAbs = resolve(cwd);
		const mainAbs = resolve(mainRepo);
		// Main-repo-based steps (pick, shipwreck) legitimately write inside mainRepo
		// itself — and shipwreck legitimately finishes a squash/commit in the item's
		// own worktree (SKILL.md states 3c/3d) — but must not touch sibling worktrees.
		// `listWorktrees()` already includes mainRepo, so prepend it only when it must be
		// audited and dedup by resolved path. `allowDirtyMain` drops mainRepo from the set.
		// Authoring-review seats (#269) are throwaway per-seat checkouts under
		// `.dev/authoring-review-seats/`; concurrent peer seats may hold session files
		// and must not trip confinement.
		const candidates = cwdAbs === mainAbs ? listWorktrees() : [mainRepo, ...listWorktrees()];
		// #369: cross-process peers proven by the eligibility predicate. Kept distinct
		// from in-memory activeWorktrees so the trust boundary stays visible.
		const excludedSessions = resolveEligibleSessionsFn(sessionEvaluator);
		const sessionWorktrees = excludedSessions.map((s) => s.worktreePath);
		return {
			roots: forbiddenRootsForConfinement({
				cwd,
				mainRepo,
				worktrees: candidates,
				ownWorktree,
				allowDirtyMain,
				isEphemeralReviewWorktree: (root) => isAuthoringReviewSeatPath(root, mainRepo) || isReviewHeadPath(root, mainRepo),
				activeWorktrees: opts.activeWorktrees,
				sessionWorktrees,
			}),
			excludedSessions,
		};
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
			executionOverride,
			parkSignalOverride,
		}: {
			attempt?: number;
			commitLabel?: string;
			effects?: StepEffects;
			maxTurnsOverride?: number;
			retriedMaxTurns?: boolean;
			ownWorktree?: string;
			executionOverride?: { provider: import("./types.js").ProviderName; model?: string; codexModel?: string };
			parkSignalOverride?: ParkSignal;
		} = {},
	): Promise<StepResult> {
		const settings = resolveStepSettings(CONFIG, profile, name);
		const realized = executionOverride ?? settings;
		const stepLog = (entry: Omit<StepLog, "name" | "provider" | "model">): StepLog => ({
			name,
			provider: realized.provider,
			model: realized.provider === "codex" ? (realized.codexModel ?? "default") : (realized.model ?? "default"),
			...entry,
		});
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
			steps.push(stepLog({ cost: 0, turns: 0, ok: false, ...(attempt > 1 ? { attempt } : {}) }));
			return { ok: false, subtype: "error_abort", text: "aborted", fullText: "", cost: 0, turns: 0 };
		}

		if (opts.dryRun) {
			log(`[dry-run] ${name}: "${prompt.slice(0, 60)}" in ${cwd}`);
			steps.push(stepLog({ cost: 0, turns: 0, ok: true, ...(attempt > 1 ? { attempt } : {}) }));
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
		// Observer construction may stay outside; finish() must be inside the critical section.
		const mainCheckoutObserver = allowDirtyMain && itemId !== null && resolve(cwd) !== resolve(mainRepo) ? createMainCheckoutDeltaObserver(mainRepo) : undefined;

		// Concurrent cycles never attribute one another's legitimate own-worktree writes as
		// sibling violations because `forbiddenRootsForStep` exempts every active peer
		// worktree (see `activeWorktrees` + #369 session records). No serialization is
		// needed or wanted here — steps run fully in parallel; only `mainRepo` and
		// inactive/stale siblings stay audited.
		let result: StepResult;
		{
			let forbiddenRoots: string[] = [];
			let forbiddenBefore = new Map<string, string>();
			let forbiddenAfter = new Map<string, string>();
			const confinementRoots: string[] = [];
			let confinementAuditError: string | undefined;
			let stepExcludedSessions: AcceptedSession[] = [];
			const revalidationWarnings: string[] = [];
			try {
				const enumResult = forbiddenRootsForStep(cwd, ownWorktree);
				forbiddenRoots = enumResult.roots;
				stepExcludedSessions = enumResult.excludedSessions;
			} catch (e) {
				confinementAuditError = `confinement audit failed to enumerate roots before ${name}: ${e instanceof Error ? e.message : String(e)}`;
				log(`⚠ ${confinementAuditError}`);
			}
			try {
				forbiddenBefore = snapshotForbiddenRootsFn(forbiddenRoots);
			} catch (e) {
				// Snapshot *execution* failed — not a proven root mutation. Preserve the Git
				// diagnostic as an audit error so classification does not misreport "changed".
				confinementAuditError = `confinement audit failed before ${name}: ${e instanceof Error ? e.message : String(e)}`;
				log(`⚠ ${confinementAuditError}`);
			}

			// #369-eligibility classification of a raw before/after diff, shared by the
			// mid-step prober and the natural end-of-step diff (#388) so a probe never trips
			// on a legitimate concurrent peer write that the end-of-step diff would have
			// excluded anyway — both apply the identical revalidation discipline.
			const classifyForbiddenRootChanges = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): { violated: string[]; excludedSessions: AcceptedSession[]; warnings: string[] } => {
				const violated: string[] = [];
				const excludedSessions: AcceptedSession[] = [];
				const warnings: string[] = [];
				for (const root of diffForbiddenRootSnapshotsFn(before, after)) {
					const abs = resolve(root);
					if (abs === resolve(mainRepo)) {
						violated.push(root);
						continue;
					}
					const stillLive = revalidateChangedRootFn(sessionEvaluator, abs);
					if (stillLive) {
						const paths = firstDiffPathsByRoot(before, after, [abs]).get(abs) ?? [];
						const warn = `confinement: excluded live session ${stillLive.identity.sessionId} (${stillLive.identity.claimedItem} @ ${abs}${paths.length ? `; paths: ${paths.join(", ")}` : ""})`;
						warnings.push(warn);
						log(`⚠ ${warn}`);
						excludedSessions.push(stillLive);
						continue;
					}
					violated.push(root);
				}
				return { violated, excludedSessions, warnings };
			};
			const mergeExcludedSessions = (found: AcceptedSession[]): void => {
				for (const s of found) {
					if (!stepExcludedSessions.some((es) => es.worktreePath === s.worktreePath)) {
						stepExcludedSessions = [...stepExcludedSessions, s];
					}
				}
			};

			// #369: foreign-root Write/Edit denial + sessions-dir protection for Claude steps,
			// including shipwreck (main cwd + ownWorktree). Registered roots from listWorktrees.
			const registeredWorktrees = (() => {
				try {
					return listWorktrees();
				} catch {
					return [mainRepo];
				}
			})();
			const foreignRootDenial = {
				mainRepo,
				registeredWorktrees,
				...(ownWorktree || (worktree && worktree !== mainRepo) ? { ownWorktree: ownWorktree ?? worktree ?? undefined } : {}),
			};
			const onChildSpawn = sessionController
				? (info: { pid: number; cwd: string }) => {
						sessionController?.updateChild(info.pid);
					}
				: undefined;

			let providerResult: StepResult;
			if (confinementAuditError !== undefined) {
				// #388: fail closed before any provider spend. A before-phase audit problem
				// (root enumeration or snapshot execution failure) already means the tree
				// cannot be trusted as a clean baseline for this step — continuing on to spend
				// the full step cost only to override the result afterward (the prior
				// behavior) burns real money on a step already known to be error_confinement.
				providerResult = { ok: false, subtype: "error_confinement", text: confinementAuditError, fullText: confinementAuditError, cost: 0, turns: 0 };
			} else {
				// A step-scoped controller composes the external (SIGINT) signal with an
				// internal one the periodic prober below can trip independently, so a
				// mid-step forbidden-root mutation cancels the in-flight provider call through
				// the same signal/driver boundary SIGINT already uses (#388) — and confirmed
				// child termination is awaited (the `await runStep` below) before this step
				// classifies anything. Deliberately never touches `opts.signal` itself: `finish()`
				// labels a cycle "aborted" only when `opts.signal.aborted`, and a confinement
				// trip must classify as error_confinement, not a SIGINT abort.
				const stepAbort = new AbortController();
				if (opts.signal) {
					if (opts.signal.aborted) stepAbort.abort();
					else opts.signal.addEventListener("abort", () => stepAbort.abort(), { once: true });
				}
				// Woken early (not just on its own interval) once the provider call settles, so a
				// normal/fast step never waits out a stale probe tick before returning (#388).
				let midStepSettled = false;
				const settledController = new AbortController();
				const probeLoop = (async () => {
					while (!midStepSettled) {
						try {
							await delay(confinementProbeIntervalMs, undefined, { signal: settledController.signal });
						} catch {
							return; // settledController fired — the step already settled.
						}
						if (midStepSettled) return;
						try {
							const probeSnapshot = snapshotForbiddenRootsFn(forbiddenRoots);
							const probeEval = classifyForbiddenRootChanges(forbiddenBefore, probeSnapshot);
							if (probeEval.violated.length > 0) {
								forbiddenAfter = probeSnapshot;
								confinementRoots.push(...probeEval.violated);
								revalidationWarnings.push(...probeEval.warnings);
								mergeExcludedSessions(probeEval.excludedSessions);
								log(`⚠ confinement: mid-step forbidden root change detected during ${name}: ${probeEval.violated.join(", ")} — aborting`);
								stepAbort.abort();
								return;
							}
						} catch (e) {
							// A probe-tick snapshot execution failure is the same fail-closed audit
							// problem as a before/after snapshot failure — abort rather than silently
							// retrying indefinitely against a root we can no longer verify.
							confinementAuditError = `confinement audit failed during ${name} (mid-step probe): ${e instanceof Error ? e.message : String(e)}`;
							log(`⚠ ${confinementAuditError}`);
							stepAbort.abort();
							return;
						}
					}
				})();

				providerResult = await runStep(
					name,
					prompt,
					{
						cwd,
						profile,
						trace: flags.trace,
						itemId: itemId ?? undefined,
						parkSignal: parkSignalOverride ?? parkSignal,
						...(executionOverride ? { executionOverride } : {}),
						...(maxTurnsOverride !== undefined ? { maxTurnsOverride } : {}),
						signal: stepAbort.signal,
						...(mainCheckoutObserver ? { mainCheckoutObserver } : {}),
						foreignRootDenial,
						...(onChildSpawn ? { onChildSpawn } : {}),
					},
					emit,
				);
				midStepSettled = true;
				settledController.abort();
				await probeLoop;
			}

			if (confinementRoots.length === 0 && confinementAuditError === undefined) {
				try {
					forbiddenAfter = snapshotForbiddenRootsFn(forbiddenRoots);
					const finalEval = classifyForbiddenRootChanges(forbiddenBefore, forbiddenAfter);
					confinementRoots.push(...finalEval.violated);
					revalidationWarnings.push(...finalEval.warnings);
					mergeExcludedSessions(finalEval.excludedSessions);
				} catch (e) {
					confinementAuditError = `confinement audit failed after ${name}: ${e instanceof Error ? e.message : String(e)}`;
					log(`⚠ ${confinementAuditError}`);
				}
			}

			const attributedMain = mainCheckoutObserver?.finish();
			if (attributedMain?.kind === "error") {
				confinementAuditError = `confinement attribution failed during ${name}: ${attributedMain.message}`;
			} else if (attributedMain?.kind === "violation") {
				confinementRoots.push(...attributedMain.roots);
			}

			result = providerResult;
			// Pipeline-owned diagnosis: replace the provider's text/fullText/outputTail so
			// finish() detail and JSONL recent-failures show the confinement cause, not a
			// stale provider success/review tail. outputTail takes the *first* 200 chars
			// (diagnosis leads with phase/root; provider tails care about the end).
			if (confinementAuditError !== undefined) {
				result = {
					...providerResult,
					ok: false,
					subtype: "error_confinement",
					text: confinementAuditError,
					fullText: confinementAuditError,
					outputTail: confinementAuditError.slice(0, 200),
				};
			} else if (confinementRoots.length > 0) {
				const roots = [...new Set(confinementRoots.map((root) => resolve(root)))].sort();
				const pathMap = firstDiffPathsByRoot(forbiddenBefore, forbiddenAfter, roots);
				const pathBits = roots
					.map((r) => {
						const ps = pathMap.get(r) ?? [];
						return ps.length ? `${r} [${ps.join(", ")}]` : r;
					})
					.join(", ");
				const excludedBits = stepExcludedSessions.length > 0 ? `; excluded sessions: ${stepExcludedSessions.map((s) => `${s.identity.sessionId}@${s.worktreePath}(${s.leg})`).join(", ")}` : "";
				const text = `forbidden root changed during ${name}: ${pathBits}${excludedBits}`;
				log(`⚠ ${text}`);
				result = {
					...providerResult,
					ok: false,
					subtype: "error_confinement",
					text,
					fullText: text,
					outputTail: text.slice(0, 200),
				};
			} else if (revalidationWarnings.length > 0) {
				// No violation retained — warnings already logged. Leave provider result as-is.
			}
		}

		if (commitLabel && result.subtype !== "error_confinement") {
			const committed = checkpoint(cwd, commitLabel);
			log(committed ? `${commitLabel} committed` : `no changes to commit (${commitLabel})`);
			ensureCheckpointed(cwd, commitLabel, log);
		}
		// Captured when effects dispatch succeeds so the step log can record the receipt.
		let stepExecutionReceipt: ExecutionReceiptDescriptor | undefined;
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
				// Phase-split so retry policy can tell resolve-time invalid decisions
				// (no forge side-effect yet) from write/dispatch failures (terminal).
				const failEffects = (e: unknown, phase: "resolve" | "write" | "dispatch"): void => {
					const code = e instanceof EffectsManifestError ? e.code : "effect_failed";
					const message = e instanceof Error ? e.message : String(e);
					const text = `${code}: ${message}`;
					// Prefer diagnosis over a valid-looking decision tail for TUI / recent-failures
					// (same pattern as confinement's pipeline-owned override).
					result = {
						...result,
						ok: false,
						subtype: "error_effects_manifest",
						text,
						fullText: text,
						outputTail: text.slice(0, 200),
						effectsError: { code, message, phase },
					};
				};
				let resolvedEffects: Effect[] | undefined;
				try {
					resolvedEffects = typeof effects === "function" ? effects(result) : effects;
				} catch (e) {
					failEffects(e, "resolve");
				}
				if (resolvedEffects !== undefined && resolvedEffects.length > 0) {
					try {
						writeEffectsManifest(ctx, resolvedEffects);
					} catch (e) {
						failEffects(e, "write");
						resolvedEffects = undefined;
					}
					if (resolvedEffects !== undefined) {
						try {
							const authorshipSteps = new Set(["plan", "implement", "shakedown-plan", "shakedown-code", "ship"]);
							const assistedByProviders = [...steps.filter((entry) => entry.ok && authorshipSteps.has(entry.name) && entry.provider).map((entry) => entry.provider!), ...(authorshipSteps.has(name) ? [realized.provider] : [])];
							const realizedProvider = realized.provider;
							const realizedModel = realized.provider === "codex" ? (realized.codexModel ?? "default") : (realized.model ?? "default");
							const effectsResult = await dispatchStepEffects({
								...ctx,
								roadmap,
								log,
								assistedByProviders,
								challenge: cycleChallenge,
								provider: realizedProvider,
								model: realizedModel,
								observeGit: () => observeGitForReceipt(cwd),
							});
							if (effectsResult.appendText) {
								result = {
									...result,
									text: appendResultText(result.text, effectsResult.appendText),
									fullText: appendResultText(result.fullText, effectsResult.appendText),
								};
							}
							if (effectsResult.receipt) {
								stepExecutionReceipt = effectsResult.receipt;
								executionReceipts.push(effectsResult.receipt);
							}
						} catch (e) {
							failEffects(e, "dispatch");
						}
					}
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

		if (result.decisions?.length) {
			const prUrl = name === "ship" || name === "shipwreck" ? extractPrUrl(result) : undefined;
			const source = prUrl ?? (itemId ? (ROADMAP_SOURCE === "github-issues" && ROADMAP_GITHUB.ghRepo ? `https://github.com/${ROADMAP_GITHUB.ghRepo}/issues/${itemId.replace(/^\D+/, "")}` : itemId) : `unclaimed:${runIdBase}`);
			try {
				// Write into the step worktree (per-item authority); never redirect to main.
				await appendDecisions(cwd, {
					...(itemId ? { itemId } : {}),
					runId: runIdBase,
					step: name,
					attempt,
					decisions: result.decisions.map((emitted, occurrence) => ({
						id: emitted.id,
						contentFingerprint: emitted.contentFingerprint,
						decision: emitted.decision,
						occurrence,
					})),
					source,
				});
			} catch (error) {
				log(`⚠ decisions: ${error instanceof Error ? error.message : String(error)}`);
			}
			for (const emitted of result.decisions) {
				try {
					await opts.notifyDecision?.({ itemId, decision: emitted.decision, step: name, source, logPath: opts.logPath ?? LOG_PATH });
				} catch (error) {
					log(`⚠ decision notification: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}

		const filesChanged = filesChangedSince(cwd, preSha);

		// Persist the full confinement diagnosis on the step log (unbounded) when the
		// pipeline overrode the provider result — outputTail alone is capped at 200.
		const confinementErrorDetail = result.subtype === "error_confinement" ? result.text : undefined;
		// Effects failures get a structured { code, message } pair for log-only repro
		// (phase stays in-memory only — retry policy is not operator-facing).
		const effectsErrorLog = result.effectsError ? { code: result.effectsError.code, message: result.effectsError.message } : undefined;

		steps.push(
			stepLog({
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
				...(confinementErrorDetail !== undefined ? { errorDetail: confinementErrorDetail } : {}),
				...(effectsErrorLog ? { effectsError: effectsErrorLog } : {}),
				...(filesChanged.length > 0 ? { filesChanged } : {}),
				...(result.stalledAsk ? { stalledAsk: true } : {}),
				...(result.decisions?.length ? { decisions: result.decisions } : {}),
				...(stepExecutionReceipt ? { executionReceipt: stepExecutionReceipt } : {}),
			}),
		);
		if (worktree && resolve(cwd) === resolve(worktree)) {
			try {
				gitBinding = readGitBindingFn(worktree, mainRepo, gitBinding);
			} catch {
				// Provenance is observational and must never change the step outcome.
				provenanceUnavailable.push("git");
			}
		}
		if (opts.workerStatus) opts.workerStatus.cost += result.cost;
		return result;
	}

	let shipwrecked = false;

	function finish(result: CycleResult): CycleResult {
		// Deregister this cycle's worktree from the active-peer registry on every exit path
		// (success, park, abort, error). Once inactive, a sibling worktree is audited again
		// by peers — a stale/abandoned tree must not be silently writable. Deleting an absent
		// member (early pick-fail exits, before registration) is a harmless no-op.
		if (worktree && worktree !== mainRepo) opts.activeWorktrees?.delete(resolve(worktree));
		// #369: stop heartbeat and remove the owned session record (idempotent).
		// Covers success, ordinary failure, parkExit, and abort paths that call finish().
		try {
			sessionController?.dispose();
		} catch {
			// Teardown must not change the cycle outcome.
		}
		sessionController = undefined;
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
		// Compose a legible failure one-liner (#268): keep `error` as the classification string, but
		// attach the last failing step's subtype + bounded output tail so a non-verbose failure explains
		// itself in the console instead of a bare "parked"/"<step> failed".
		if (!result.completed && result.error && !result.detail) {
			const failed = [...steps].reverse().find((s) => !s.ok);
			const bits = failed ? [failed.subtype, failed.outputTail].filter(Boolean).join(": ") : "";
			if (bits) result = { ...result, detail: `${result.error} — ${failed?.name}: ${bits}`.slice(0, 200) };
		}
		if (!opts.dryRun) {
			const parked = result.error === "parked";
			const drivers = uniqueDriverProvenance(steps);
			const unavailable: string[] = [...provenanceUnavailable];
			let versions: CycleVersionProvenance = { pelaggio: "unknown", node: process.version, drivers: {} };
			try {
				const observed = readRuntimeVersionsFn(drivers.map((driver) => driver.provider));
				versions = observed.versions;
				unavailable.push(...observed.unavailable);
			} catch {
				unavailable.push("versions");
			}
			try {
				gitBinding = readGitBindingFn(worktree, mainRepo, gitBinding);
			} catch {
				unavailable.push("git");
			}
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
				...(result.bookkeepingWarnings?.length ? { bookkeepingWarnings: result.bookkeepingWarnings } : {}),
				provenance: {
					runId: runIdBase,
					durationMs: Math.max(0, Math.trunc(now() - pipelineT0)),
					drivers,
					git: gitBinding,
					versions,
					...(result.prUrl ? { prUrl: result.prUrl } : {}),
					...(unavailable.length ? { unavailable: [...new Set(unavailable)] } : {}),
					challengeDigest: cycleChallengeDigest,
					...(executionReceipts.length > 0 ? { executionReceipts: [...executionReceipts] } : {}),
				},
			});
		}
		return result;
	}

	// ── Resolve item + worktree ──

	let itemId = opts.itemId ?? null;
	let worktree = opts.worktree ?? null;
	let gitBinding: CycleGitBinding;
	try {
		gitBinding = readGitBindingFn(worktree, mainRepo);
	} catch {
		gitBinding = { branch: null, worktree: worktree ? basename(worktree) : null, mainShaAtStart: null, headSha: null };
		provenanceUnavailable.push("git");
	}
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

			// Worktree-isolated claims branch off the literal `main` ref (git-claim.ts), so a
			// detached/off-branch mainRepo can't corrupt a *new* claim — but it does break an
			// operator's between-cycle `git merge --ff-only origin/main` and misleads `git log
			// -1` there (issue #216). --no-worktree mode legitimately leaves mainRepo on the
			// prior claim's feature branch (or a CI-provided checkout), so it's exempt.
			if (!opts.dryRun && !opts.noWorktree && !ensureMainCheckoutOnBranch(mainRepo, "main", log)) {
				return finish({ itemId: null, completed: false, cost, error: "main checkout is not on main and could not be reattached" });
			}
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

			// #332: an explicit `--item <N>` pin is a DETERMINISTIC gate, not a hint. The /pick skill's
			// contract is to claim exactly the requested id (or report `already-done`/`blocked`) — never
			// substitute a different ready item. For a PINNED claimed pick, resolve the id ONLY from the
			// authoritative `pick-item:` marker (SKILL.md declares it authoritative precisely to avoid
			// ambiguous free-text) — never fall back to `parseItemId(pick.text)`, or free text narrating
			// the requested id could mask an actual divert. A missing/malformed marker on a claimed pin is
			// itself a contract violation → fail closed. Auto-pick (no pin) keeps the free-text fallback.
			if (opts.dryRun) {
				itemId = itemId ?? "DRY";
			} else if (opts.itemId) {
				itemId = parsePickItem(pickText);
				if (!itemId) return finish({ itemId: null, completed: false, cost, error: "pick:unparsed-marker" });
				if (await pickDivergedFromPin(opts.itemId, itemId, (text) => roadmap.parseItemId(text))) {
					log(`⚠ pick diverted: requested ${opts.itemId} but /pick claimed ${itemId} — refusing (a pinned --item must resolve exactly; the stray claim needs cleanup)`);
					return finish({ itemId, completed: false, cost, error: "pick:diverted" });
				}
			} else {
				itemId = parsePickItem(pickText) ?? (await roadmap.parseItemId(pick.text)) ?? (await roadmap.parseItemId(pick.fullText));
				if (!itemId) return finish({ itemId: null, completed: false, cost, error: "no item ID parsed" });
			}

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

	// Register this cycle's worktree as an active peer so concurrent siblings exempt it
	// from their whole-tree confinement snapshot (see `forbiddenRootsForStep`). Resolved to
	// match the audit's absolute-path comparison. `finish()` removes it on every exit path.
	// `--no-worktree` cycles run in mainRepo (never registered — main stays hard-gated) and
	// `--parallel > 1` is disallowed there, so there is no peer to exempt.
	if (worktree && worktree !== mainRepo) opts.activeWorktrees?.add(resolve(worktree));

	// #369: publish a cross-process session record once the item worktree + claim are known
	// (same window as activeWorktrees). Claude steps later refresh the binding pid; Codex/Grok
	// still register so inventory fallback works for earlier evaluators. finish() disposes.
	if (!opts.dryRun && worktree && worktree !== mainRepo && itemId) {
		let claimBranch = "";
		try {
			claimBranch = execSync("git branch --show-current", { cwd: worktree, encoding: "utf-8" }).trim();
		} catch {
			claimBranch = "";
		}
		if (claimBranch.startsWith("feat/")) {
			const sessionId = `${runIdBase}-${itemId}`;
			try {
				sessionController = createSessionControllerFn({
					mainRepo,
					sessionId,
					claimedItem: itemId,
					claimBranch,
					worktreePath: resolve(worktree),
				});
				// Best-effort process-level cleanup for the window before finish() returns
				// (SIGINT between steps). finish() is also idempotent; drop listeners on dispose.
				const disposeOnce = (): void => {
					process.removeListener("SIGINT", disposeOnce);
					if (opts.signal) opts.signal.removeEventListener("abort", disposeOnce);
					try {
						sessionController?.dispose();
					} catch {
						// ignore
					}
				};
				process.once("SIGINT", disposeOnce);
				if (opts.signal) {
					if (opts.signal.aborted) disposeOnce();
					else opts.signal.addEventListener("abort", disposeOnce, { once: true });
				}
				// Wrap controller dispose so normal finish() also drops the SIGINT listener.
				const inner = sessionController;
				sessionController = {
					sessionId: inner.sessionId,
					identity: inner.identity,
					updateChild: (pid) => inner.updateChild(pid),
					dispose: () => {
						process.removeListener("SIGINT", disposeOnce);
						if (opts.signal) opts.signal.removeEventListener("abort", disposeOnce);
						inner.dispose();
					},
				};
			} catch (e) {
				log(`⚠ session record registration failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	if (opts.workerStatus) opts.workerStatus.itemId = itemId!;

	// ── Detect quick mode ──
	// A pinned --profile (issue #247) suppresses the automatic downgrade: the operator has taken
	// explicit control of the profile, so keep the step set and backend identical to the pin.

	if (!flags.profile) {
		const quickItem = !opts.dryRun && itemId ? await roadmap.getItem(itemId).catch(() => null) : null;
		if (flowPolicy.isQuickScope({ item: quickItem, summaryText: pickText })) {
			profile = "quick";
			log("scope S/XS or bug — quick mode (Sonnet, skip plan+shakedown-plan)");
			startFrom ??= "implement";
		}
	}
	startFrom ??= "plan";

	const shouldRun = (s: PipelineStep): boolean => stepIndex(startFrom as PipelineStep) <= stepIndex(s);

	function parkExit(reason?: string): CycleResult | null {
		if (!parkSignal.parked && !reason) return null;
		if (worktree) checkpoint(worktree, reason ? "review-loop park" : "rate-limit park");
		log(`⏸ parked (${reason ?? parkSignal.limitType})`);
		return finish({ itemId, completed: false, cost, error: "parked" });
	}

	function quarantineExit(error: string, extra: Pick<CycleResult, "verdict"> = {}): CycleResult {
		const preserved = worktree ? quarantineCheckpoint(worktree, "andon quarantine") : true;
		const disposition: CycleDisposition = preserved ? "quarantine-and-continue" : "halt-campaign";
		if (preserved) log(`⊘ quarantined: ${error} — checkpointed, sweep continues`);
		else log("⚠ quarantine checkpoint failed — halting campaign to preserve WIP + diagnosis");
		return finish({ ...extra, itemId, completed: false, cost, error, disposition });
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
		executionOverride?: DriverIdentity;
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
				...(cfg.executionOverride ? { executionOverride: cfg.executionOverride } : {}),
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
				return { kind: "terminal", cycleResult: quarantineExit(`${cfg.name} blocked: ${result.text}`) };
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
	const driverCandidates = (name: Step): DriverIdentity[] =>
		resolveDriverCandidates(CONFIG, profile, name).map((candidate) =>
			candidate.provider === "codex" ? { provider: "codex", ...(candidate.codexModel ? { codexModel: candidate.codexModel } : {}) } : { provider: candidate.provider, ...(candidate.model ? { model: candidate.model } : {}) },
		);
	const available: (candidate: DriverIdentity) => boolean =
		providerAvailableForTests ??
		((candidate: DriverIdentity): boolean => {
			if (candidate.provider === "claude") return true;
			const executable = resolveProviderBin(CONFIG, candidate.provider, candidate.provider);
			const paths =
				isAbsolute(executable) || executable.includes("/")
					? [executable]
					: (process.env.PATH ?? "")
							.split(delimiter)
							.filter(Boolean)
							.map((directory) => join(directory, executable));
			return paths.some((path) => {
				try {
					accessSync(path, constants.X_OK);
					return true;
				} catch {
					return false;
				}
			});
		});

	// Reconstruct an already-produced artifact's author when its step isn't running
	// this process (resume, or plan-exists-on-disk skip). Attribution comes from the
	// structured step records in LOG_PATH (pelaggio-log.jsonl), never opts.logPath —
	// that is the human verbose/parallel transcript and holds no JSON step records, so
	// parsing it returns undefined and the assignment fails closed into a false park
	// (#245). When the log genuinely lacks attribution (legacy log, out-of-band plan),
	// fall back to the statically-resolved author and warn that reviewer separation is
	// then best-effort, not proven — rather than falsely claiming a guarantee or parking.
	const reconstructAuthor = (artifact: "plan" | "implementation", step: "plan" | "implement"): void => {
		const logged = findLoggedArtifactAuthor(itemId!, step, LOG_PATH);
		if (logged) {
			recordArtifactAuthor(assignment, artifact, logged);
			return;
		}
		const fallback = resolveStaticAuthor(driverCandidates(step), available);
		if (!fallback) return;
		log(`⚠ ${artifact} attribution absent from log; using statically-resolved author (${fallback.provider}) — reviewer separation is best-effort, not proven (#245)`);
		recordArtifactAuthor(assignment, artifact, fallback);
	};

	let verdict: "APPROVE" | "REVISE" | "RETHINK" = "APPROVE";
	let shakedownPlanText = "";
	// Shared across the plan-time and shakedown-code deferred-item parses so a marker echoed in both
	// (createItem is not idempotent) creates the follow-up only once. (#353 review)
	const deferredItemTitles = new Set<string>();

	if (!assignment.authors.plan && shouldRun("shakedown-plan") && !shouldRun("plan")) {
		reconstructAuthor("plan", "plan");
	}

	if (shouldRun("plan")) {
		const existingPlan = roadmap.resolvePlanPath({ id: itemId!, worktree: worktree! });
		if (!opts.dryRun && existsSync(existingPlan)) {
			log(`plan exists at ${existingPlan} — skipping plan generation`);
			reconstructAuthor("plan", "plan");
		} else {
			const selected = selectAuthor(assignment, driverCandidates("plan"), available);
			if (!selected.ok) return finish({ itemId, completed: false, cost, error: `plan assignment failed: ${selected.reason}` });
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
			if (outcome.kind === "terminal") return outcome.cycleResult;
			recordArtifactAuthor(assignment, "plan", planAuthor);

			// Plan-time decomposition: a plan that judges the item too large for one cycle emits
			// `deferred-item: {json}` markers for the slices it splits off, and scopes THIS cycle to a
			// coherent first slice instead of starving at the implement turn wall. Decomposition is the
			// preferred path for large items; the raised implement turn ceiling is the escape hatch for
			// changes that don't decompose cleanly. Best-effort, mirrors the shakedown-code deferral (#115).
			if (!opts.dryRun) {
				for (const d of parseDeferredItems(outcome.result.fullText, deferredItemTitles)) {
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
	}

	if (shouldRun("shakedown-plan")) {
		const planAuthor = assignment.authors.plan;
		if (!planAuthor) return finish({ itemId, completed: false, cost, error: "shakedown-plan assignment failed: plan author attribution is unavailable" });
		const selected = selectReviewers(assignment, driverCandidates("shakedown-plan"), planAuthor, 1, available);
		if (!selected.ok) return finish({ itemId, completed: false, cost, error: `shakedown-plan assignment failed: ${selected.reason}` });
		const shakedownPlanArgs = await buildStepArgs(roadmap, itemId!, "plan-review");
		const outcome = await runStepWithRetry({
			name: "shakedown-plan",
			stepBudget: resolveStepSettings(CONFIG, profile, "shakedown-plan").budget,
			buildPrompt: () => expandSkill("shakedown", shakedownPlanArgs),
			logAttempt: (attempt) => log(attempt === 1 ? "shakedown (plan)..." : "continuing shakedown-plan (attempt 2)..."),
			refusedError: "shakedown-plan refused (model declined the review)",
			executionOverride: selected.drivers[0],
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
	if (!assignment.authors.implementation && shouldRun("shakedown-code") && !shouldRun("implement")) {
		reconstructAuthor("implementation", "implement");
	}

	if (shouldRun("implement")) {
		const selected = selectAuthor(assignment, driverCandidates("implement"), available);
		if (!selected.ok) return finish({ itemId, completed: false, cost, error: `implement assignment failed: ${selected.reason}` });
		const implementationAuthor = selected.drivers[0];
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
			executionOverride: implementationAuthor,
		});
		if (outcome.kind === "terminal") return outcome.cycleResult;
		recordArtifactAuthor(assignment, "implementation", implementationAuthor);
	}

	// ── Shakedown-code ──
	let reviewRecordMarkdown: string | undefined;

	if (shouldRun("shakedown-code")) {
		const implementationAuthor = assignment.authors.implementation;
		if (!implementationAuthor) return finish({ itemId, completed: false, cost, error: "shakedown-code assignment failed: implementation author attribution is unavailable" });
		const planPath = await roadmap.getItemPlan({ worktree: worktree! });
		// The retry (attempt 2) points at the plan file only — NOT "the roadmap entry", which a
		// sandboxed provider can't fetch (#103/#115); the plan already carries the scope.
		const shakedownPlanRef = planPath ? `Read the plan at \`${planPath}\` to understand the scope.` : `Find the plan in \`${resolve(REPO, "docs", "plans")}/\`.`;
		const shakedownCodeArgs = await buildStepArgs(roadmap, itemId!, "code-review");

		let shakedownResult: StepResult;
		if (REVIEW_CONFIG.authoring.enabled) {
			const reviewedSha = getArtifactHeadSha(worktree!);
			if (!reviewedSha) return parkExit("adversarial review could not bind current HEAD")!;
			const existingEscalation = lookupReviewEscalation(worktree!, itemId!, reviewedSha);
			if (existingEscalation.state === "active" || existingEscalation.state === "resolved-block" || existingEscalation.state === "invalid") return parkExit(`adversarial review escalation ${existingEscalation.state}`)!;
			// A committed resolution remains untrusted policy input until an operator binds
			// this resume to its evidence. Issue #419 owns the successor authority design.
			if (existingEscalation.state === "resolved-proceed") {
				// Both sides must be present strings: a record missing its fingerprint and
				// an omitted flag are each undefined, and undefined must never satisfy the gate.
				const evidenceFp = existingEscalation.escalation.evidenceFingerprint;
				const ackFlag = flags["acknowledge-escalation"];
				if (typeof evidenceFp !== "string" || evidenceFp.length === 0) {
					return parkExit("adversarial review escalation record lacks an evidence fingerprint — treated as active; re-escalate through the review loop")!;
				}
				if (typeof ackFlag !== "string" || ackFlag !== evidenceFp) {
					return parkExit(`adversarial review escalation active; after reviewing, re-run with --resume ${itemId} --acknowledge-escalation ${evidenceFp}`)!;
				}
			}
			if (existingEscalation.state === "resolved-proceed" && existingEscalation.escalation.hasSafetyBlocker) return parkExit("adversarial review safety blocker")!;
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
			if (!seating.ok) return finish({ itemId, completed: false, cost, error: `shakedown-code assignment failed: ${seating.reason}` });
			const policy = seating.policy;
			log(`authoring review capability realizations: ${JSON.stringify(seating.realizations)}`);
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
								return { ok: false, subtype: "error", text: `authoring review seat prepare failed: ${message}`, fullText: `authoring review seat prepare failed: ${message}`, cost: 0, turns: 0 };
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
				} finally {
					for (const sha of preparedSeatShas) cleanupAuthoringReviewSeatsForSha(mainRepo, sha);
				}
			}
			if (!loop) {
				// loop is only skipped for resolved-proceed; narrow before reading audit fields.
				if (existingEscalation.state !== "resolved-proceed") return parkExit("adversarial review produced no loop result")!;
				reviewRecordMarkdown = `## Adversarial review escalation\n\nDecision **${existingEscalation.id}** was resolved **proceed** by ${existingEscalation.resolution.actor}.\n\nRationale: ${existingEscalation.resolution.rationale}\n\nReviewed commit: \`${reviewedSha}\`. Evidence fingerprint: \`${existingEscalation.escalation.evidenceFingerprint}\`.`;
				shakedownResult = { ok: true, subtype: "success", text: "resolved-proceed", fullText: "resolved-proceed", cost: 0, turns: 0 };
			} else {
				cost += loop.cost;
				const finalReviewedSha = getArtifactHeadSha(worktree!);
				if (!finalReviewedSha) return parkExit("adversarial review could not bind final reviewed HEAD")!;
				const reviewRunId = `${runIdBase}-${itemId}`;
				const record: ReviewRecord = { schemaVersion: 1, runId: reviewRunId, itemId: itemId!, createdAt: new Date().toISOString(), blockingBar: "must-fix", result: loop };
				const recordPath = writeReviewRecord(worktree!, record);
				reviewRecordMarkdown = renderReviewRecord(record);
				log(`review record → ${recordPath}`);
				const reviewRecordSource = `.dev/review-records/${record.runId}.json`;
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
						const written = await appendReviewEscalation(worktree!, escalation);
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
						if (written.status === "failed" || state.state !== "resolved-proceed" || escalation.hasSafetyBlocker) escalationParkReason = `adversarial review escalation ${written.status === "failed" ? "write-failed" : state.state}`;
					} catch (error) {
						log(`⚠ adversarial review escalation write failed: ${error instanceof Error ? error.message : String(error)}`);
						return parkExit("adversarial review escalation write-failed")!;
					}
				}
				if (!opts.dryRun) {
					try {
						writeEffectsManifest(effectsCtx, reviewEffects);
						// Aggregate authoring-review uses reserved attempt 0; provider/model from the
						// configured judge seat when present, else the shakedown-code step settings.
						const reviewSettings = resolveStepSettings(CONFIG, profile, "shakedown-code");
						const reviewProvider = policy.judge.provider;
						const reviewModel = policy.judge.provider === "codex" ? (policy.judge.codexModel ?? "default") : (policy.judge.model ?? reviewSettings.model ?? "default");
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
						if (loop.disagreement) return parkExit(`shakedown-code effects failed after escalation: ${text}`)!;
						return finish({ itemId, completed: false, cost, error: `shakedown-code effects failed: ${text}` });
					}
				}
				if (escalationParkReason) return parkExit(escalationParkReason)!;
				// A reviewer-split `dissent` already escalated + parked in the `loop.disagreement` block above.
				// A Judge-ruled judgment-dissent (no disagreement, non-safety) keeps its pre-#244 posture:
				// park only for direct-push; in PR mode ship with the dissent recorded (the PR is the veto).
				if (loop.outcome === "budget" || loop.outcome === "hard-block" || (loop.outcome === "dissent" && opts.shipTarget.name === "direct-push")) return parkExit(`adversarial review ${loop.outcome}`)!;
				shakedownResult = { ok: true, subtype: "success", text: loop.outcome, fullText: loop.outcome, cost: 0, turns: 0 };
			}
		} else {
			const selected = selectReviewers(assignment, driverCandidates("shakedown-code"), implementationAuthor, 1, available);
			if (!selected.ok) return finish({ itemId, completed: false, cost, error: `shakedown-code assignment failed: ${selected.reason}` });
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
			if (outcome.kind === "terminal") return outcome.cycleResult;
			shakedownResult = outcome.result;
		}

		// Harness owns deferred-item creation (#115): under pelaggio the model lists follow-ups as
		// `deferred-item: {json}` markers instead of running `roadmap create-item` (a sandboxed
		// provider can't). Create them in-process, best-effort — a failure logs and continues (they're
		// backlog niceties, not the cycle's deliverable). Skipped in dry-run (no real backlog writes).
		if (!opts.dryRun) {
			for (const d of parseDeferredItems(shakedownResult.fullText, deferredItemTitles)) {
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

	// PR modes resolve a dynamic ship decision from the step output; direct-push has no
	// effects. Retry only resolve-phase invalid_manifest (before any forge write/dispatch).
	const shipEffects =
		target.name === "direct-push"
			? undefined
			: (result: StepResult) => {
					const decision = parseShipDecisionEffect(result, { itemId: itemId!, target: target.name, worktree: worktree! });
					return [{ ...decision, ...(reviewRecordMarkdown ? { prBody: `${decision.prBody}\n\n${reviewRecordMarkdown}` } : {}) }];
				};

	let ship: StepResult;
	if (target.name === "direct-push") {
		ship = await step("ship", shipPrompt, worktree!);
		cost += ship.cost;
	} else {
		// Clear any stale body file BEFORE the first attempt. A prior failed run retains
		// `.dev/ship/pr-body-{ID}.md` (gitignored, persists in the worktree) for diagnosis; on a
		// resume/re-run the model must write a FRESH body this run. Without this, `parseShipDecisionEffect`
		// only checks the file exists — so a resumed cycle could open/update a PR with the stale body
		// from the failed run. Removing it first makes the transport fail closed: no fresh write → parse
		// fails (file missing). Within-run retry (attempt 2) still overwrites as needed.
		// FAIL CLOSED if the stale file cannot actually be removed (e.g. unlink EPERM): a body we
		// can't clear would be silently reused, so refuse the ship rather than proceed. (#303 review)
		const staleBody = resolve(worktree!, shipBodyFile(itemId!));
		if (!opts.dryRun && existsSync(staleBody)) {
			try {
				cleanupShipBodyFile(worktree!, itemId!);
			} catch {
				// The existence recheck below is the fail-closed gate — a swallowed unlink error
				// still leaves the file present and is caught there.
			}
		}
		const staleBlock = !opts.dryRun && existsSync(staleBody) ? `stale ship body file could not be cleared before attempt 1: ${shipBodyFile(itemId!)}` : undefined;
		if (staleBlock) {
			log(`⚠ ${staleBlock} — refusing to ship`);
			ship = { ok: false, subtype: "error_effects_manifest", text: staleBlock, fullText: staleBlock, cost: 0, turns: 0, outputTail: staleBlock.slice(0, 200), effectsError: { code: "invalid_manifest", message: staleBlock, phase: "resolve" } };
		} else {
			// Attempt-cap only (no budget gate) — one acceptance-required recovery for a
			// malformed decision / missing body file before any manifest is written.
			ship = await step("ship", shipPrompt, worktree!, { attempt: 1, effects: shipEffects });
			cost += ship.cost;
			const canRetryShip = !ship.ok && ship.subtype === "error_effects_manifest" && ship.effectsError?.code === "invalid_manifest" && ship.effectsError?.phase === "resolve";
			if (canRetryShip) {
				const parkedBeforeRetry = parkExit();
				if (parkedBeforeRetry) return parkedBeforeRetry;
				const prior = ship.effectsError!;
				const retryPrompt = [
					`Previous ship decision failed (${prior.code}: ${prior.message}).`,
					`Write the PR body (markdown, ≤512 KiB) to exactly \`${shipBodyFile(itemId!)}\` inside the worktree`,
					"(overwrite if present; plain file at that exact path, not a symlink).",
					"Re-emit exactly one SHIP_DECISION block with short scalar JSON fields only — use prBodyFile,",
					"never an inline prBody.",
					"",
					shipPrompt,
				].join("\n");
				log("ship decision invalid — retrying once...");
				ship = await step("ship", retryPrompt, worktree!, { attempt: 2, effects: shipEffects });
				cost += ship.cost;
			}
			// Scratch lifecycle: delete the body file only after a successful PR dispatch.
			// Retain it on terminal failure for diagnosis / second-attempt input.
			if (ship.ok && !opts.dryRun) {
				try {
					cleanupShipBodyFile(worktree!, itemId!);
				} catch (e) {
					log(`⚠ ship body cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
		}
	}

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
	if (classifyOutcome(ship) === "blocked") return quarantineExit(`ship blocked: ${ship.text}`, { verdict });

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
				// A blocking push/integration failure: local main holds the merge + bookkeeping
				// (recoverable) and the feature branch was left intact. Surface as an
				// incomplete cycle so origin-never-got-it is visible, not reported shipped.
				log(`⚠ bookkeeping incomplete: ${bk.error}`);
				return finish({ itemId, completed: false, cost, verdict, error: bk.error ?? "ship bookkeeping failed", ...(bk.warnings.length ? { bookkeepingWarnings: bk.warnings } : {}) });
			}
			return finish({ itemId, completed: true, cost, verdict, ...(bk.warnings.length ? { bookkeepingWarnings: bk.warnings } : {}) });
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
	if (r.completed && r.bookkeepingWarnings?.length) return A.yellow("⚠");
	if (r.completed) return A.green("✓");
	if (r.error === "parked") return A.yellow("⏸");
	if (r.error === "plan needs rethink") return A.yellow("↻");
	if (r.disposition === "quarantine-and-continue") return A.yellow("⊘");
	return A.red("✗");
}

function resultStatus(r: CycleResult): "done" | "warning" | "skipped" | "failed" | "parked" | "quarantined" {
	if (r.completed && r.bookkeepingWarnings?.length) return "warning";
	if (r.completed) return "done";
	if (r.error === "parked") return "parked";
	if (r.error === "plan needs rethink") return "skipped";
	if (r.disposition === "quarantine-and-continue") return "quarantined";
	return "failed";
}

function resultDetail(r: CycleResult): string {
	if (r.completed && r.bookkeepingWarnings?.length) return `shipped — bookkeeping incomplete: ${r.bookkeepingWarnings.join("; ")}`;
	return r.detail ?? r.error ?? "";
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
		policy: typeof REVIEW_CONFIG;
		ghRepo: string;
		gh: GhRunner;
		statuslessAfter: string;
		runReviewGate: typeof runPrReviewGate;
		now: () => number;
		prepareReviewHead: typeof prepareReviewHead;
		cleanupReviewHead: typeof cleanupReviewHead;
	}>;
	/**
	 * Continuous-mode free queue probe (issue #82). Defaults to `listItems` + FlowPolicy
	 * evaluation — no pick agent. Injectable for tests so drain/watch stop conditions
	 * need no real roadmap.
	 */
	queueProbe?: () => Promise<{ empty: boolean; readyCount: number }>;
	/** Sleep seam for watch-mode free-probe waits (and pipeline rate-limit backoff). */
	sleep?: (ms: number) => Promise<void>;
	/** Clock for day-budget accounting (defaults to `Date.now`). */
	now?: () => number;
	/** Roadmap + flow policy used by the default free queue probe. */
	roadmap?: RoadmapSource;
	flowPolicy?: FlowPolicy;
}

// Post-reset resume grace: jitter deliberately bounded inside the pre-existing 30s
// post-reset envelope so timer-mocked orchestrator tests need no `tick()` changes.
// delay = 15s + rand(0..15s) ∈ [15s, 30s). Widening these requires updating those tests.
const RESUME_MIN_GRACE_MS = 15_000;
const RESUME_JITTER_MS = 15_000;
// Defensive bound against a pathological park→tiny-reset→park spin. Each real wait is
// minutes+, and `maxWaitMs` already caps each round, so 12 is generous insurance.
const MAX_RESUME_ROUNDS = 12;

/**
 * Wait out the current park's reset window, or report that we can't. The timing/jitter/max-wait
 * semantics live here in exactly one place so both the item park-and-resume loop and the local
 * review-retry sweep (#134) share one implementation — copy-pasting the wait block would let
 * timing/jitter/max-wait drift, and the timer-mocked tests assume a single code path. On "resumed"
 * the park signal is cleared and the caller may re-run its work; on "handback" the signal stays
 * parked and the caller prints its own pending/resume hint. `itemsLabel`, when given, lists the
 * parked items under the wait banner (the item loop; the review sweep omits it).
 */
const ULID_ENV_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** True when `value` is a ULID-shaped string (flow writer correlation env). */
function isUlidEnv(value: string | undefined): value is string {
	return typeof value === "string" && ULID_ENV_PATTERN.test(value);
}

async function awaitParkReset(parkSignal: ParkSignal, opts: { maxWaitMs: number; itemsLabel?: string }): Promise<"resumed" | "handback"> {
	const waitMs = parkSignal.resetsAt - Date.now();
	const isWeekly = /week/i.test(parkSignal.limitType);

	// No reset time → never spin (checked every round). Rate-limit parks synthesize a conservative
	// reset upstream (#68), so this is reached only by a manual pause (SIGUSR2, resetsAt=0) or a
	// stale reset already in the past — neither is auto-resumable by time.
	if (!parkSignal.resetsAt || waitMs <= 0) {
		console.log("");
		console.log(`${A.yellow("⏸")} ${parkSignal.limitType} limit hit — cannot auto-resume (no reset time)`);
		return "handback";
	}

	if (waitMs > opts.maxWaitMs) {
		const label = isWeekly ? "Weekly rate limit" : `${parkSignal.limitType} limit`;
		console.log("");
		console.log(`${A.yellow("⏸")} ${label} — wait ${fmtWait(waitMs)} exceeds --max-wait ${fmtWait(opts.maxWaitMs)}`);
		return "handback";
	}

	// Jitter within the existing 30s post-reset envelope (see the constants above) so timer-mocked
	// tests need no change: delay ∈ [15s, 30s).
	const delay = RESUME_MIN_GRACE_MS + Math.floor(Math.random() * RESUME_JITTER_MS);
	const resumeAt = parkSignal.resetsAt + delay;
	const eta = new Date(resumeAt).toLocaleTimeString("en-CA", { hour12: false });
	console.log("");
	console.log(`${A.yellow("⏸")} ${A.bold("Parked")} — ${parkSignal.limitType} limit, waiting ${fmtWait(waitMs)} (ETA ${eta})`);
	if (opts.itemsLabel) console.log(`  Items: ${opts.itemsLabel}`);

	const countdownInterval = setInterval(() => {
		const remaining = resumeAt - Date.now();
		if (remaining > 0) {
			console.log(`  ${A.dim("⏳")} ${fmtWait(remaining)} remaining...`);
		}
	}, 5 * 60_000);

	await new Promise((r) => setTimeout(r, resumeAt - Date.now()));
	clearInterval(countdownInterval);

	parkSignal.parked = false;
	parkSignal.resetsAt = 0;
	parkSignal.limitType = "";
	parkSignal.triggerWorker = "";
	return "resumed";
}

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

		// --profile pins the model/provider profile for the whole run (issue #247); it overrides
		// the automatic quick-mode downgrade so the step set and backend stay identical across
		// runs (e.g. a Claude-vs-Codex capability bake-off). Validate against known profiles.
		if (flags.profile !== undefined && !Object.hasOwn(CONFIG.modelProfiles, flags.profile)) {
			console.error(`invalid --profile ${JSON.stringify(flags.profile)}; valid: ${Object.keys(CONFIG.modelProfiles).join(", ")}`);
			return { exitCode: 2, results };
		}

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

		if (flags["acknowledge-escalation"] !== undefined && !flags.resume) {
			console.error("--acknowledge-escalation <fingerprint> requires --resume <id>");
			return { exitCode: 2, results };
		}

		// Continuous mode (issue #82/#83): drain/watch presets with free queue probe + day budget.
		// Day-budget precedence: CLI `--day-budget` > CONFIG.watch.dailyBudget > unlimited.
		const continuousResolved = resolveContinuousConfig(flags, { dayBudget: CONFIG.watch.dailyBudget });
		if (!continuousResolved.ok) {
			console.error(continuousResolved.message);
			return { exitCode: 2, results };
		}
		const continuous = continuousResolved.config;
		if (continuous && noWorktree) {
			console.error("--continuous / --preset is not supported with --no-worktree / CI mode");
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
		const decisionNotifier: PipelineOpts["notifyDecision"] = notifyEnabled
			? async (input) => {
					await notifyDecisionEvent(notifyCfg, input, { send });
				}
			: undefined;

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
					...(decisionNotifier ? { notifyDecision: decisionNotifier } : {}),
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
		const parallel = parseInt(flags.parallel, 10);
		const items =
			flags.item
				?.split(",")
				.map((s) => s.trim())
				.filter(Boolean) ?? [];
		// Auto-derive cycles to cover the full item list when --cycles isn't
		// explicitly sized for it — otherwise items beyond index `max(cycles-1,
		// parallel-1)` would silently drop off the worker queue.
		// Continuous mode (issue #82): default `--cycles 1` means unlimited; explicit
		// `--cycles N` (N>1) is a safety ceiling. See `continuousCycleCap`.
		const cycles = continuousCycleCap(flags, continuous);
		// Provider-estimated spend (e.g. Codex on a subscription) counts toward `--budget` the same
		// as billed USD — deliberate: it fails safe (a subscription run still respects the cap as a
		// token-spend proxy) and the warning below marks the figure `~` so it never reads as real USD.
		const maxBudget = parseFloat(flags.budget);
		const dryRun = flags["dry-run"];
		const v = flags.verbose;
		const isParallel = parallel > 1;
		const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
		const now = deps.now ?? Date.now;
		const dayBudgetTracker = new DayBudgetTracker(continuous?.dayBudget, now);
		const roadmapForProbe = deps.roadmap ?? getRoadmapSource(ROADMAP_SOURCE, { repo: REPO, github: ROADMAP_GITHUB, linear: ROADMAP_LINEAR });
		const flowPolicyForProbe = deps.flowPolicy ?? DEFAULT_FLOW_POLICY;
		const queueProbe = deps.queueProbe ?? (() => freeQueueProbe(roadmapForProbe, flowPolicyForProbe));

		const targetBanner = shipTargetName === DEFAULT_SHIP_TARGET ? "" : `  ${A.dim(`target=${shipTargetName}`)}`;
		const continuousBanner = continuous ? `  ${A.dim(`continuous=${continuous.preset}`)}${continuous.dayBudget != null ? `  ${A.dim(`day-budget=$${continuous.dayBudget.toFixed(2)}`)}` : ""}` : "";
		const cyclesLabel = continuous && cycles === Number.MAX_SAFE_INTEGER ? "∞" : String(cycles);
		console.log(
			`${A.bold("pelaggio")}  ${cyclesLabel} cycle(s)${isParallel ? `  ${A.dim("×")}${parallel} parallel` : ""}  ${A.dim("budget")} $${maxBudget.toFixed(2)}${continuousBanner}${targetBanner}${dryRun ? `  ${A.yellow("[DRY RUN]")}` : ""}`,
		);
		if (isParallel && v) {
			console.log(`${A.dim("logs")}  .dev/pelaggio-{N}.log`);
		}
		console.log("");

		liveStatus.totalCycles = cycles === Number.MAX_SAFE_INTEGER ? 0 : cycles;
		liveStatus.multiline = isParallel;
		if (v) {
			const rows = process.stderr.rows || 24;
			const barLines = isParallel ? Math.min(parallel + 1, Math.floor(rows / 3)) : 2;
			statusBar.setup(barLines);
		}

		const statusInterval = isParallel && v && TUI_ENABLED ? setInterval(() => liveStatus.render(), 200) : null;

		const pickMutex = isParallel ? createMutex() : undefined;
		// Continuous gate (issue #83): one serialized critical section for budget check,
		// revise, free probe, idle/budget sleep, and lifecycle event emission. Released
		// before paid `runPipeline` work so ×N workers can claim independently.
		const continuousGate = continuous ? createMutex() : undefined;
		// Run-scoped registry of live peer worktrees. Each cycle registers its worktree on
		// entry and deregisters on finish; peers exempt registered worktrees from their
		// confinement snapshot so a sibling's own-worktree write never false-positives —
		// without serializing any step. Serial runs need no registry (no peers).
		const activeWorktrees = isParallel ? new Set<string>() : undefined;
		let nextCycle = 0;
		let totalSpent = 0;
		// Drain-complete flag so waiting peers stop once the gate holder sees emptiness.
		let drainComplete = false;
		// Transition-only idle tracking: re-emitting watch-idle/budget-idle is forbidden.
		let continuousIdle: "none" | "watch-idle" | "budget-idle" = "none";
		// Emit at most one suspended per park interval (peers may all observe park).
		let continuousSuspendedEmitted = false;
		// Correlate supervised continuous runs with `.dev/flow-events/<streamId>.jsonl`.
		const continuousWriter = continuous
			? createEventWriter({
					...(isUlidEnv(process.env.PELAGGIO_EVENT_STREAM_ID) ? { streamId: process.env.PELAGGIO_EVENT_STREAM_ID } : {}),
					...(isUlidEnv(process.env.PELAGGIO_EXECUTION_ID) ? { executionId: process.env.PELAGGIO_EXECUTION_ID } : {}),
				})
			: undefined;
		const emitContinuous = (input: Parameters<NonNullable<typeof continuousWriter>["append"]>[0]): void => {
			try {
				continuousWriter?.append(input);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				console.log(`${A.dim(`flow-event emit failed: ${msg}`)}`);
			}
		};
		const suspensionReason = (): string => {
			const lt = parkSignal.limitType;
			if (lt === "paused") return "operator-pause";
			if (lt === "sdk-outage") return "sdk-outage";
			return "rate-limit";
		};
		const emitSuspendedIfParked = (): void => {
			if (!continuous || !parkSignal.parked || continuousSuspendedEmitted) return;
			continuousSuspendedEmitted = true;
			const reason = suspensionReason();
			const resumeAt = parkSignal.resetsAt > 0 ? new Date(parkSignal.resetsAt).toISOString() : undefined;
			emitContinuous({
				type: "pelaggio.suspended",
				itemId: null,
				reason,
				...(resumeAt ? { resumeAt } : {}),
			});
		};
		const emitResumed = (): void => {
			if (!continuous) return;
			continuousSuspendedEmitted = false;
			emitContinuous({ type: "pelaggio.resumed", itemId: null });
		};
		// Consecutive "transient sdk error" cycle outcomes across the whole worker pool
		// (issue #128) — reset by any other outcome. Shared across parallel workers since
		// it tracks the campaign's overall health, not any one worker's.
		let consecutiveTransientErrors = 0;
		let consecutiveQuarantines = 0;
		let campaignHalted = false;
		// Single-sourced with `notify.ts`'s classifier via `RECOVERABLE_ERRORS` (types.ts) to
		// prevent drift. `pick:unknown-id` and `pick:blocked` are intentionally *absent* — fatal
		// so typos in `--item X,Y,Z` and user-requested blocked items halt loudly instead of
		// silently skipping. `pick:unknown` (parser fallback) stays recoverable.
		const RECOVERABLE = new Set<string>(RECOVERABLE_ERRORS);

		async function worker(): Promise<void> {
			if (campaignHalted) return;
			while (true) {
				// Continuous-mode pre-cycle gates (issue #82/#83): day budget, per-iteration
				// revise, and free queue probe — under one continuous gate so ×N workers do
				// not double-probe or double-sleep. Gate released before paid work.
				//
				// Park check is continuous-only here: a global early park return would race
				// parallel non-continuous workers (one parks → siblings skip their first pull).
				if (continuous && continuousGate) {
					let exitWorker = false;
					let retryGate = false;
					await continuousGate.acquire();
					try {
						if (campaignHalted) {
							exitWorker = true;
						} else if (parkSignal.parked || drainComplete) {
							if (parkSignal.parked) emitSuspendedIfParked();
							exitWorker = true;
						} else if (dayBudgetTracker.exceeded()) {
							if (continuous.preset === "drain") {
								console.log(`${A.yellow("⚠")} day budget ($${continuous.dayBudget!.toFixed(2)}) exhausted (spent $${dayBudgetTracker.daySpent.toFixed(2)} today) — stopping continuous run`);
								exitWorker = true;
							} else {
								// Watch: idle until local-day rollover, then probe again (no paid work).
								const resumeAtMs = nextLocalMidnightMs(now());
								const resumeAt = new Date(resumeAtMs).toISOString();
								const spent = dayBudgetTracker.daySpent;
								if (continuousIdle !== "budget-idle") {
									emitContinuous({
										type: "pelaggio.budget-idle",
										itemId: null,
										resumeAt,
										budget: continuous.dayBudget!,
										spent,
									});
									continuousIdle = "budget-idle";
									console.log(`${A.yellow("⚠")} day budget ($${continuous.dayBudget!.toFixed(2)}) exhausted (spent $${spent.toFixed(2)}) — budget-idle until ${resumeAt}`);
								}
								const sleepMs = Math.max(0, resumeAtMs - now());
								await sleep(sleepMs);
								if (parkSignal.parked) {
									emitSuspendedIfParked();
									exitWorker = true;
								} else {
									if (continuousIdle === "budget-idle") {
										emitContinuous({ type: "pelaggio.budget-wake", itemId: null });
										continuousIdle = "none";
										console.log(`${A.dim("budget-wake — day rolled, resuming watch")}`);
									}
									retryGate = true;
								}
							}
						} else {
							// Run even when the pick queue is empty: red PRs are independent work and
							// watch sessions must keep discovering them between queue probes.
							await runReviseSweepOnce();
							if (campaignHalted) {
								// A halt can land during the sweep; honor it before any further probe/pick.
								exitWorker = true;
							} else if (parkSignal.parked) {
								emitSuspendedIfParked();
								exitWorker = true;
							} else if (dayBudgetTracker.exceeded()) {
								// After revise spend — re-enter gate loop for drain-stop or watch rollover.
								retryGate = true;
							} else if (items.length === 0) {
								let probe: { empty: boolean; readyCount: number } | null = null;
								try {
									probe = await queueProbe();
								} catch (e) {
									const msg = e instanceof Error ? e.message : String(e);
									console.log(`${A.yellow("⚠")} queue probe failed: ${msg}`);
									// Fail closed: a broken free probe must never turn into an unbounded paid
									// pick loop. Drain stops; watch waits and retries without consuming a cycle.
									if (continuous.preset === "drain") {
										exitWorker = true;
									} else {
										await sleep(continuous.probeIntervalMs);
										retryGate = true;
									}
								}
								if (!exitWorker && !retryGate && probe) {
									if (probe.empty) {
										if (continuous.preset === "drain") {
											console.log(`${A.green("✓")} queue empty — drain complete`);
											drainComplete = true;
											exitWorker = true;
										} else if (nextCycle >= cycles) {
											// Watch with an explicit --cycles N>1 ceiling.
											console.log(`${A.dim("queue empty — cycle ceiling reached, stopping watch")}`);
											exitWorker = true;
										} else {
											// watch: free wait (no cycle consumed, no pick agent)
											const probeAt = new Date(now() + continuous.probeIntervalMs).toISOString();
											if (continuousIdle !== "watch-idle") {
												emitContinuous({ type: "pelaggio.watch-idle", itemId: null, probeAt });
												continuousIdle = "watch-idle";
											}
											console.log(`${A.dim("queue empty — watching")} ${A.dim(`(probe in ${fmtWait(continuous.probeIntervalMs)})`)}`);
											await sleep(continuous.probeIntervalMs);
											if (parkSignal.parked) {
												emitSuspendedIfParked();
												exitWorker = true;
											} else {
												retryGate = true;
											}
										}
									} else if (continuousIdle === "watch-idle") {
										// Work available — wake from watch-idle, then release for paid work.
										emitContinuous({ type: "pelaggio.watch-wake", itemId: null });
										continuousIdle = "none";
										console.log(`${A.dim("watch-wake — work available")}`);
									}
								}
							}
						}
					} finally {
						continuousGate.release();
					}
					if (exitWorker) return;
					if (retryGate) continue;
					// Fall through to paid work with gate released.
				}

				if (campaignHalted) return;
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

				// #369: each cycle captures its own evaluator inventory + starttime inside
				// runPipeline when sessionEvaluator is omitted — so later cycles still see
				// peers that registered after process start. (Orchestrator does not pre-capture.)
				const result = await _runPipeline(
					{
						itemId: items[cycle - 1],
						cycle,
						verbose: !isParallel && v,
						shipTarget,
						dryRun,
						pickMutex,
						activeWorktrees,
						workerStatus: status,
						logPath,
						liveStatus,
						...(decisionNotifier ? { notifyDecision: decisionNotifier } : {}),
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
					consecutiveQuarantines = 0;
					if (consecutiveTransientErrors >= CONSECUTIVE_TRANSIENT_ERROR_LIMIT && !parkSignal.parked) {
						parkSignal.parked = true;
						parkSignal.resetsAt = 0;
						parkSignal.limitType = "sdk-outage";
						parkSignal.triggerWorker = result.itemId ?? "";
						result.error = "parked";
					}
				} else if (result.disposition === "quarantine-and-continue") {
					consecutiveQuarantines++;
					consecutiveTransientErrors = 0;
					if (consecutiveQuarantines >= CONSECUTIVE_QUARANTINE_LIMIT) result.disposition = "halt-campaign";
				} else {
					consecutiveTransientErrors = 0;
					consecutiveQuarantines = 0;
				}

				totalSpent += result.cost;
				dayBudgetTracker.add(result.cost);
				results.push(result);
				// Set the halt flag BEFORE the notification await: notify() is best-effort
				// network I/O, and a peer worker must not launch a new cycle in that gap
				// when this result halts the campaign (#385 round-3 review finding).
				if (classifyCycleDisposition(result, RECOVERABLE) === "halt-campaign") campaignHalted = true;
				await notify(result, logPath ?? LOG_PATH);

				status.itemId = result.itemId ?? "?";
				status.status = resultStatus(result);
				status.cost = result.cost;
				status.step = undefined;
				status.turns = undefined;

				const logRef = logPath ? `  ${A.dim(`→ .dev/pelaggio-${cycle}.log`)}` : "";
				const detail = resultDetail(result);
				console.log(`${resultIcon(result)} cycle ${cycle}: ${A.bold(result.itemId ?? "?")} — ${result.costEstimated ? "~" : ""}$${result.cost.toFixed(2)}${detail ? `  ${A.dim(detail)}` : ""}${logRef}`);

				if (v) liveStatus.render();

				if (parkSignal.parked) {
					if (continuous) emitSuspendedIfParked();
					break;
				}
				// #385's typed disposition replaces the raw RECOVERABLE membership check:
				// continue / quarantine-and-continue keep the worker pulling; only
				// halt-campaign (confinement/safety polarity) stops new cycle launches.
				if (classifyCycleDisposition(result, RECOVERABLE) === "halt-campaign") {
					campaignHalted = true;
					return;
				}
				// Continuous drain: a race can leave pick:queue-empty after the free probe
				// saw work (another process claimed it). Stop rather than spinning paid picks.
				if (continuous?.preset === "drain" && result.error === "pick:queue-empty") {
					console.log(`${A.green("✓")} queue empty — drain complete`);
					drainComplete = true;
					return;
				}
			}
		}

		// Park/auto-resume policy — hoisted above the review sweep so the review-retry loop (which
		// runs before the item park-and-resume block) can wait out a rate-limit park with the same
		// `autoResume`/`maxWaitMs` semantics. The item loop below reuses these same values.
		const park = { ...CONFIG.park, ...deps.park };
		const autoResume = park.autoResume;
		const maxWaitMs = parseWaitFlag(flags["max-wait"] ?? park.maxWait);

		// ── Local review sweep (issue #84) ──
		//
		// In local review mode the trusted local tree owns the review CLI/skill/parser/status
		// posting code. PR heads are only diff/file data. This sweep posts `review` commit
		// statuses before the existing revise sweep runs, so a fresh local BLOCK is immediately
		// visible to `findRevisablePrs` below.
		const review = {
			runner: REVIEW_CONFIG.runner,
			policy: REVIEW_CONFIG,
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
			// A rate-limit park during pr-review/pr-verify is transient, not a BLOCK: the gate returns
			// `park`, the sweep leaves the `review` status *pending* (never red, never a revisable
			// findings comment), stops starting more reviews, and — under the same auto-resume /
			// --max-wait / reset-time policy as the item park-and-resume loop — waits and retries the
			// sweep in-process. Pending PRs stay eligible in `findReviewCandidates`, so a resumed round
			// re-lists and re-reviews them; a hand-back leaves the PR pending for the next run.
			let reviewRound = 0;
			while (reviewRound < MAX_RESUME_ROUNDS) {
				reviewRound++;
				const { candidates, stranded } = findReviewCandidates(review.gh, review.ghRepo, review.now(), parseWaitFlag(review.statuslessAfter));
				// Stranded handling is a one-time nudge (idempotent comment + a notification) — only on
				// the first round, so a resumed retry does not re-notify the same stranded PRs.
				if (reviewRound === 1) {
					for (const pr of stranded) {
						postLocalModeWorkflowComment(review.gh, review.ghRepo, pr.prNumber);
						if (notifyEnabled) await notifyStrandedReview(notifyCfg, { itemId: pr.itemId, prNumber: pr.prNumber, ghRepo: review.ghRepo, headSha: pr.headSha, logPath: LOG_PATH }, { send });
					}
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
							policy: review.policy,
							parkSignal, // shared: a rate-limit park sets this and flows into the wait+retry below
						});
						if (result.gate === "park") {
							// Transient: leave the pending status as-is (do NOT upsert findings or post
							// failure), charge the partial cost, and stop starting new reviews this round.
							// `finally` still cleans the review head; the shared `parkSignal` is already parked.
							// Day-budget must see the partial spend too (#397): local review is in the
							// day-budget accounting set, and the post-try path below is skipped on break.
							totalSpent += result.cost;
							dayBudgetTracker.add(result.cost);
							console.log(`review ${pr.itemId}#${pr.prNumber} — parked (${result.park?.limitType ?? parkSignal.limitType})`);
							break;
						}
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
					dayBudgetTracker.add(reviewCost);
					console.log(`review ${pr.itemId}#${pr.prNumber} — ${finalState}${reviewCost > 0 ? ` ${reviewCostEstimated ? "~" : ""}$${reviewCost.toFixed(2)}` : ""}`);
				}

				if (!parkSignal.parked) break; // no rate-limit park this round → sweep is done
				if (!autoResume) break; // off-switch → leave pending, hand back (park block reports it)
				const outcome = await awaitParkReset(parkSignal, { maxWaitMs });
				if (outcome === "handback") break; // no reset / exceeds --max-wait → leave pending
				// resumed: parkSignal cleared → re-list candidates (pending PRs remain) and retry.
			}
		}

		// ── Revise sweep (issue #76, continuous per-iteration in #82) ──
		//
		// Sweep for red-review PRs and revise each in-process on the local subscription —
		// the same in-process resume the park/auto-resume loop uses (`startFrom: "implement"`
		// + a fetched `--review-findings` file). Auto-pick mode only (`items.length === 0`):
		// naming `--item X,Y` means "do exactly these". A hard no-op unless the repo is
		// github-issues + a PR ship target; any gh/git error skips fail-soft and the normal
		// pick loop proceeds. Revisions do NOT consume `--cycles` (that sizes *new-work*
		// throughput) but DO count toward `--budget` / day-budget.
		//
		// Non-continuous: run once before the pick worker pool.
		// Continuous (#82): run at the start of every iteration so newly-red PRs are revised
		// between picks rather than only at campaign start.
		const revise = {
			local: REVISE_LOCAL,
			ghRepo: ROADMAP_SOURCE === "github-issues" ? ROADMAP_GITHUB.ghRepo : "",
			gh: defaultGhRun,
			...deps.revise,
		};
		const doSweep = revise.local && shipIsPr && !!revise.ghRepo && !noWorktree && !dryRun && items.length === 0;

		async function runReviseSweepOnce(): Promise<void> {
			if (!doSweep) return;
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
						...(decisionNotifier ? { notifyDecision: decisionNotifier } : {}),
						...(signal ? { signal } : {}),
					},
					parkSignal,
					{ ...flags, "review-findings": findingsPath }, // per-item findings injection
				);
				totalSpent += r.cost;
				dayBudgetTracker.add(r.cost);
				results.push(r);
				// Revise outcomes gate the campaign exactly like cycle outcomes: a
				// confinement/safety-classed revise failure must stop new cycle launches,
				// not just render red. Flag set BEFORE the notify await so a peer worker
				// cannot launch in the delivery gap (#385 round-2/3 review findings).
				const reviseHalts = classifyCycleDisposition(r, RECOVERABLE) === "halt-campaign";
				if (reviseHalts) campaignHalted = true;
				await notify(r, LOG_PATH);
				status.status = resultStatus(r);
				status.cost = r.cost;
				status.step = undefined;
				if (v) liveStatus.render();
				const detail = resultDetail(r);
				console.log(`${resultIcon(r)} revise ${pr.itemId} — ${r.costEstimated ? "~" : ""}$${r.cost.toFixed(2)}${detail ? `  ${A.dim(detail)}` : ""}`);
				if (reviseHalts) return;
			}
		}

		// One-shot pre-pool revise for non-continuous runs. Continuous mode runs the sweep
		// per-iteration inside the worker (below) so each pick is preceded by a revise pass.
		if (!continuous) {
			await runReviseSweepOnce();
		}

		// Skip the pick worker pool entirely if the sweep already parked — its parked revisions
		// are in `results` (pushed above), so they flow into the park-and-resume block below.
		if (!parkSignal.parked) {
			// Continuous gate serializes probe/idle; paid cycles may run up to `parallel` workers.
			await Promise.all(Array.from({ length: Math.min(parallel, cycles === Number.MAX_SAFE_INTEGER ? parallel : cycles) }, () => worker()));
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

			// `park`/`autoResume`/`maxWaitMs` are hoisted above the review sweep (shared with its
			// retry loop). The park signal is reset by `awaitParkReset` on a successful wait.

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
						// Resume skips pick (no pickMutex) but still opens audited provider steps;
						// register its (already-existing) worktree so peers exempt it.
						activeWorktrees,
						workerStatus: st,
						logPath: resumeLogPath,
						liveStatus,
						...(decisionNotifier ? { notifyDecision: decisionNotifier } : {}),
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
				const detail = resultDetail(r);
				console.log(`${resultIcon(r)} resume ${id} — ${r.costEstimated ? "~" : ""}$${r.cost.toFixed(2)}${detail ? `  ${A.dim(detail)}` : ""}`);
				return r;
			};

			let pending = results.filter((r) => r.error === "parked" && r.itemId).map((r) => r.itemId!);

			if (pending.length === 0) {
				// Reached when a rate-limit park has no parked *pipeline* item to resume — e.g. the local
				// review sweep parked and handed back (its pending PRs retry on the next run), or a manual
				// pause fired before any work started.
				console.log(`${A.yellow("⏸")} Rate limit hit but no items to resume (any pending local review retries on the next run).`);
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
				// Shared wait: identical timing/jitter/max-wait semantics as the review-retry sweep.
				// `break` (not `return`) on hand-back so we funnel through the shared teardown+summary
				// below — a round-≥2 exit here would otherwise leak the status-bar scroll region set up
				// by the prior round's `statusBar.setup()`.
				const outcome = await awaitParkReset(parkSignal, { maxWaitMs, itemsLabel: pending.join(", ") });
				if (outcome === "handback") {
					console.log(`  Parked: ${pending.join(", ")}`);
					console.log(`  Resume: ${A.bold(formatResumeHint(pending))}`);
					break;
				}
				emitResumed();

				console.log(`\n${A.green("▶")} ${A.bold("Resuming")} ${pending.length} item(s)...`);

				if (v) {
					liveStatus.cycles = [];
					liveStatus.totalCycles = pending.length;
					statusBar.setup();
				}

				// Resume SEQUENTIALLY: a resumed item can itself report a halt-campaign-
				// classed failure (confinement/safety), and concurrent launches would let
				// peers run before the halt is known. A suspect environment argues for
				// serial resumes anyway; parked lists are small (#385 round-4/5 findings).
				const batch: CycleResult[] = [];
				let resumeHalted = false;
				for (const [i, id] of pending.entries()) {
					const r = await resumeOne(id, i);
					batch.push(r);
					results.push(r);
					if (classifyCycleDisposition(r, RECOVERABLE) === "halt-campaign") {
						resumeHalted = true;
						break;
					}
				}
				if (resumeHalted) {
					campaignHalted = true;
					const remaining = pending.slice(batch.length);
					if (remaining.length) console.log(`${A.yellow("⏸")} halt-campaign during auto-resume — leaving ${remaining.length} item(s) parked`);
					break;
				}
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
			} else if (r.completed && r.bookkeepingWarnings?.length) {
				label = A.yellow(resultDetail(r));
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
