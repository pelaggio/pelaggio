import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { basename, delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { allocateAttempt, attemptRunId } from "./attempt-identity.js";
import { CONFIG, CONFINEMENT_CONFIG, LOG_PATH, modelForProvider, REPO, ROADMAP_GITHUB, ROADMAP_LINEAR, ROADMAP_SOURCE, resolveDriverCandidates, resolveProviderBin } from "./config.js";
import { diffForbiddenRootSnapshots, snapshotForbiddenRoots } from "./confinement/roots.js";
import { captureEvaluatorContext, createSessionController, resolveEligibleSessions, revalidateChangedRoot, type SessionController, type SessionEvaluatorContext } from "./confinement/sessions.js";
import { canRetryWithinBudget, classifyFailure, classifyOutcome, cycleResultBase } from "./cycle-outcome.js";
import { readRuntimeVersions, stepIndex, uniqueDriverProvenance } from "./cycle-support.js";
import { appendDecisions as appendDecisionsDefault, appendReviewEscalation as appendReviewEscalationDefault, lookupReviewEscalation as lookupReviewEscalationDefault } from "./decisions.js";
import { createDriverAssignmentState, type DriverIdentity, recordArtifactAuthor, resolveStaticAuthor } from "./driver-assignment.js";
import { dispatchStepEffects as dispatchStepEffectsDefault, writeEffectsManifest as writeEffectsManifestDefault } from "./effects.js";
import { digestChallenge } from "./execution-receipt.js";
import { appendLog as appendLogDefault, findLoggedArtifactAuthor } from "./flow-events.js";
import { DEFAULT_FLOW_POLICY, type FlowPolicy } from "./flow-policy.js";
import { readFreshnessGateRecord, writeFreshnessGateRecord } from "./freshness-gate-record.js";
import { checkpoint, listWorktrees as listWorktreesDefault, quarantineCheckpoint, readGitBinding, resolveWorktree } from "./git.js";
import { classifyParkReason, isTransientSdkError } from "./outcome-classify.js";
import { runPrReviewGate } from "./pr-review-gate.js";
import { verifyOrRepairAuthoringReviewHostDependencies } from "./review/seat-deps.js";
import { cleanupAuthoringReviewSeatsForSha, prepareAuthoringReviewSeat } from "./review/seats.js";
import { getRoadmapSource, type RoadmapSource } from "./roadmap/index.js";
import { preparePrShipFreshness, verifyPrShipFreshness } from "./ship/freshness.js";
import { runShipBookkeeping as runShipBookkeepingDefault } from "./ship/index.js";
import { createStepExecutor } from "./step-executor.js";
import type { PipelineStep } from "./step-names.js";
import { type RunStepFn, runStep as runStepDefault } from "./step-runner.js";
import type { CycleHelpers, RunStepWithRetryConfig, StepAttempt } from "./steps/context.js";
import { archiveReviewFindingsAfterImplement, runImplement } from "./steps/implement.js";
import { runPick } from "./steps/pick.js";
import { runPlan } from "./steps/plan.js";
import { runShakedownCode } from "./steps/shakedown-code.js";
import { runShakedownPlan } from "./steps/shakedown-plan.js";
import { runShip } from "./steps/ship.js";
import { A, fmtElapsed } from "./tui.js";
import type { BlockedKind, CycleDisposition, CycleGitBinding, CycleResult, CycleResultBase, CycleVersionProvenance, ExecutionReceiptDescriptor, FailureClass, Flags, ParkSignal, PipelineOpts, Step, StepLog } from "./types.js";

// Re-exported for pipeline.test.ts; the implementation moved with the implement step (plan step 9).
export { archiveReviewFindingsAfterImplement };

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

const TRANSIENT_MAX_ATTEMPTS = 3;
const TRANSIENT_BACKOFF_MS = 1000;
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
	/** PR-mode freshness: fetch/merge `origin/main`. Tests stub so empty fixtures without `origin` do not fetch. */
	preparePrShipFreshness?: typeof preparePrShipFreshness;
	/** Deterministic Git gate after freshness author repair. */
	verifyPrShipFreshness?: typeof verifyPrShipFreshness;
	/** Side-effect-free PR gate core for in-cycle pre-flight. Distinct from OrchestratorDeps.review.runReviewGate. */
	runPrReviewGate?: typeof runPrReviewGate;
	/** Deterministic `pnpm typecheck:ratchet` backstop for the PR-mode freshness gates. The default
	 *  probes the target repo's package.json first (#424 review): absent script → soft skip with a
	 *  logged notice (consumer repos don't ship ci/typecheck-ratchet.ts); present script → its
	 *  failure stays a hard, cycle-ending gate. Tests must stub this. */
	runTypecheckRatchet?: (cwd: string) => Promise<{ ok: boolean; skipped?: boolean; detail?: string }>;
	/** Freshness-gate completion (#424 review → #511): trust is in-process (write seeds a
	 *  process-local registry; read consults only that), with `<mainRepo>/.dev/freshness-gate-records/`
	 *  written as observability. Pipeline tests MUST stub both so temp-repo runs never touch the host store. */
	readFreshnessGateRecord?: typeof readFreshnessGateRecord;
	writeFreshnessGateRecord?: typeof writeFreshnessGateRecord;
	/** Test seam: per-invocation cold seats around pre-flight. */
	prepareAuthoringReviewSeat?: typeof prepareAuthoringReviewSeat;
	cleanupAuthoringReviewSeatsForSha?: typeof cleanupAuthoringReviewSeatsForSha;
	/** Fail-closed canonical-link verification before the ship-candidate typecheck. */
	verifyOrRepairAuthoringReviewHostDependencies?: typeof verifyOrRepairAuthoringReviewHostDependencies;
	/** Mark a one-shot findings task consumed after implement succeeds. The orchestrator uses
	 *  this to retain the revision lease if a later step parks without re-injecting findings. */
	onReviewFindingsConsumed?: (itemId: string) => void;
}

/** Upper bound for one deterministic ratchet run (a full-monorepo tsc pass fits comfortably). */
const TYPECHECK_RATCHET_TIMEOUT_MS = 10 * 60_000;

/** Exported for tests (#424): the probe half must stay deterministic and offline. */
export async function defaultTypecheckRatchet(cwd: string): Promise<{ ok: boolean; skipped?: boolean; detail?: string }> {
	// #424 review: `typecheck:ratchet` is a capability of THIS monorepo (root package.json →
	// ci/typecheck-ratchet.ts, excluded from the published package), not a pelaggio contract.
	// Mirror the provider-binary availability probe: consult the target repo's manifest first —
	// absent (or unreadable) manifest/script → soft skip, reported via `skipped` so the caller
	// logs a notice; present script → failure remains a hard gate.
	let scripts: unknown;
	try {
		scripts = (JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8")) as { scripts?: unknown }).scripts;
	} catch (e) {
		return { ok: true, skipped: true, detail: `package.json not readable: ${e instanceof Error ? e.message : String(e)}` };
	}
	const script = typeof scripts === "object" && scripts !== null ? (scripts as Record<string, unknown>)["typecheck:ratchet"] : undefined;
	if (typeof script !== "string" || script.trim() === "") {
		return { ok: true, skipped: true, detail: "no typecheck:ratchet script in package.json" };
	}
	try {
		// #424 gate review: bound the run so the gate fails only in its intended ways — a
		// generous maxBuffer keeps a *green* ratchet with verbose output from throwing on
		// node's 1 MiB default, and the timeout turns a hung ratchet into a diagnosed
		// hard failure instead of wedging the cycle.
		execFileSync("pnpm", ["typecheck:ratchet"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: TYPECHECK_RATCHET_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
		return { ok: true };
	} catch (e) {
		const err = e as { code?: unknown; stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
		// pnpm missing from PATH is an environment capability gap, not a red typecheck —
		// soft-skip exactly like a missing script (#424 gate review). Keyed on the spawn-level
		// ENOENT; a failing ratchet exits non-zero with output and never carries this code.
		if (err.code === "ENOENT") {
			return { ok: true, skipped: true, detail: "pnpm not found on PATH" };
		}
		if (err.code === "ETIMEDOUT") {
			return { ok: false, detail: `typecheck:ratchet timed out after ${TYPECHECK_RATCHET_TIMEOUT_MS}ms` };
		}
		const stderr = typeof err.stderr === "string" ? err.stderr : Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf-8") : "";
		const stdout = typeof err.stdout === "string" ? err.stdout : Buffer.isBuffer(err.stdout) ? err.stdout.toString("utf-8") : "";
		const detail = (stderr + stdout || err.message || String(e)).trim().slice(0, 500);
		return { ok: false, detail };
	}
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
	const preparePrShipFreshnessFn = deps.preparePrShipFreshness ?? preparePrShipFreshness;
	const verifyPrShipFreshnessFn = deps.verifyPrShipFreshness ?? verifyPrShipFreshness;
	const runPrReviewGateFn = deps.runPrReviewGate ?? runPrReviewGate;
	const runTypecheckRatchetFn = deps.runTypecheckRatchet ?? defaultTypecheckRatchet;
	const readFreshnessGateRecordFn = deps.readFreshnessGateRecord ?? readFreshnessGateRecord;
	const writeFreshnessGateRecordFn = deps.writeFreshnessGateRecord ?? writeFreshnessGateRecord;
	const prepareAuthoringReviewSeatFn = deps.prepareAuthoringReviewSeat ?? prepareAuthoringReviewSeat;
	const cleanupAuthoringReviewSeatsForShaFn = deps.cleanupAuthoringReviewSeatsForSha ?? cleanupAuthoringReviewSeatsForSha;
	const verifyOrRepairAuthoringReviewHostDependenciesFn = deps.verifyOrRepairAuthoringReviewHostDependencies ?? verifyOrRepairAuthoringReviewHostDependencies;
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
	// Attestation audit (#276): PELAGGIO_OPERATOR_ATTENDED suppressions are cycle-scoped
	// evidence. `finish()` persists them into cycle provenance on every exit path (success,
	// failure, park) so an attested headless run is reconstructible from
	// .dev/pelaggio-log.jsonl alone — the resolution-time console line is not durable.
	const unattendedSignalSuppressions = [...(opts.unattendedSignalSuppressions ?? [])];
	/** Descriptors for every execution receipt written this cycle (steps + aggregate review). */
	const executionReceipts: ExecutionReceiptDescriptor[] = [];
	const assignment = createDriverAssignmentState(opts.cycle);
	const pipelineT0 = now();
	const runIdBase = opts.logPath ? basename(opts.logPath, extname(opts.logPath)) : `cycle-${opts.cycle}`;
	// #467: a resume recomputes `cycle` from scratch (`results.length + i + 1` is 1 for a
	// fresh `--resume`), so runIdBase alone repeats the superseded attempt's value and every
	// runId-keyed artifact collides with its own predecessor — receipts fail closed with
	// `already exists with different content` (#451). Salting with a monotonic per-item
	// attempt makes the old artifacts stale rather than conflicting.
	//
	// Allocated lazily and memoized: `itemId` is not known until pick resolves, and the
	// allocation must happen exactly once per cycle, not once per step. A dry run never
	// allocates — it writes no artifacts, so it needs no identity and must not advance a
	// real item's sequence.
	let allocated: { itemId: string; attempt: number } | null = null;
	/** Item-scoped attempt run id for an explicit item — pick uses this before the cycle has adopted the claim (#738 review). */
	const itemRunIdFor = (id: string): string => {
		if (opts.dryRun) return `${runIdBase}-${id}`;
		if (!allocated || allocated.itemId !== id) allocated = { itemId: id, attempt: allocateAttempt(mainRepo, id) };
		return attemptRunId(runIdBase, id, allocated.attempt);
	};
	const itemRunId = (): string => (itemId ? itemRunIdFor(itemId) : `${runIdBase}-unclaimed`);
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

	const step = createStepExecutor({
		opts,
		flags,
		parkSignal,
		mainRepo,
		roadmap,
		steps,
		executionReceipts,
		provenanceUnavailable,
		cycleChallenge,
		runIdBase,
		allowDirtyMain,
		confinementProbeIntervalMs,
		sessionEvaluator,
		runStep,
		listWorktrees,
		snapshotForbiddenRoots: snapshotForbiddenRootsFn,
		diffForbiddenRootSnapshots: diffForbiddenRootSnapshotsFn,
		revalidateChangedRoot: revalidateChangedRootFn,
		resolveEligibleSessions: resolveEligibleSessionsFn,
		writeEffectsManifest,
		dispatchStepEffects,
		appendDecisions,
		readGitBinding: readGitBindingFn,
		log,
		itemRunId,
		observeGitForReceipt,
		live: {
			itemId: () => itemId,
			worktree: () => worktree,
			profile: () => profile,
			sessionController: () => sessionController,
			gitBinding: () => gitBinding,
			setGitBinding: (binding) => {
				gitBinding = binding;
			},
		},
	});

	let shipwrecked = false;
	// Detail for a review-loop park. Signal-driven parks (rate limit, pause, outage) carry
	// `parkSignal.limitType` instead; review-loop parks pass their reason to `parkExit()`,
	// which previously used it only for the console line — so it never reached the log.
	let parkReasonDetail: string | null = null;

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
		// Park and completed win over abort (preserve-work / real success). SIGINT during the
		// 2s grace after ship completed shouldn't turn a real success into a phantom abort.
		// Reconstruct the failed/aborted branch — spreading a different branch and overwriting
		// the discriminant would leave failureClass/error on a parked object at runtime.
		if (opts.signal?.aborted && result.outcome !== "completed" && result.outcome !== "parked") {
			result = { ...cycleResultBase(result), outcome: "failed", failureClass: "aborted", error: "aborted" };
		}
		// Surface the local shipwreck flag on the returned result so the orchestrator can
		// classify a `shipwrecked` notification (also brings CycleResult into parity with
		// CycleLogEntry.shipwrecked). The JSONL log records it separately below.
		if (shipwrecked) result = { ...result, shipwrecked: true };
		// Any estimated step makes the cycle total estimated — surfaced on the result (live
		// prints) and the jsonl (stats/notify) so a subscription-provider run never reads as USD.
		const costEstimated = steps.some((s) => s.costEstimated);
		if (costEstimated) result = { ...result, costEstimated: true };
		const failedStep = [...steps].reverse().find((s) => !s.ok);
		// Compose a legible failure one-liner (#268): the branch diagnostic plus the last
		// failing step's subtype + bounded output tail.
		if (result.outcome !== "completed" && !result.detail) {
			const diagnostic = result.outcome === "failed" ? result.error : result.outcome === "blocked" ? result.reason : result.parkReason;
			if (diagnostic) {
				const bits = failedStep ? [failedStep.subtype, failedStep.outputTail].filter(Boolean).join(": ") : "";
				const head = result.outcome === "blocked" && failedStep ? `${failedStep.name} blocked: ${result.reason}` : diagnostic;
				if (bits) result = { ...result, detail: `${head} — ${failedStep?.name}: ${bits}`.slice(0, 200) };
				else if (result.outcome === "blocked" && failedStep) result = { ...result, detail: head };
			}
		}
		if (!opts.dryRun) {
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
			const persistedOutcome =
				result.outcome === "completed"
					? { outcome: "completed" as const }
					: result.outcome === "parked"
						? { outcome: "parked" as const, parkClass: result.parkClass, parkReason: result.parkReason }
						: result.outcome === "blocked"
							? { outcome: "blocked" as const, blockedKind: result.blockedKind, reason: result.reason }
							: { outcome: "failed" as const, failureClass: result.failureClass, error: result.error };
			appendLog({
				ts: new Date().toISOString(),
				cycle: opts.cycle,
				item: result.itemId,
				quick: profile === "quick",
				steps,
				total_cost: Number(result.cost.toFixed(4)),
				...(costEstimated ? { costEstimated: true } : {}),
				verdict: result.verdict ?? null,
				...persistedOutcome,
				shipwrecked,
				...(result.bookkeepingWarnings?.length ? { bookkeepingWarnings: result.bookkeepingWarnings } : {}),
				provenance: {
					// Deliberately NOT attempt-scoped. This is a cycle label, not an artifact key —
					// nothing dedupes on it — and salting it would rename the runId of every
					// unclaimed cycle (a failed pick has no item to scope to). Distinguishing a
					// resume in the cycle log is worth doing, but as its own change.
					runId: runIdBase,
					durationMs: Math.max(0, Math.trunc(now() - pipelineT0)),
					drivers,
					git: gitBinding,
					versions,
					...(result.prUrl ? { prUrl: result.prUrl } : {}),
					...(unavailable.length ? { unavailable: [...new Set(unavailable)] } : {}),
					challengeDigest: cycleChallengeDigest,
					...(executionReceipts.length > 0 ? { executionReceipts: [...executionReceipts] } : {}),
					...(unattendedSignalSuppressions.length > 0 ? { unattendedSignalSuppressions: [...unattendedSignalSuppressions] } : {}),
				},
			});
		}
		return result;
	}

	function finishFailed(error: string, failureClass: FailureClass, extra: Partial<CycleResultBase> = {}): CycleResult {
		const { itemId: id, cost: c, ...rest } = extra;
		return finish({ itemId: id !== undefined ? id : itemId, cost: c ?? cost, ...rest, outcome: "failed", failureClass, error });
	}

	function finishCompleted(extra: Partial<CycleResultBase> = {}): CycleResult {
		const { itemId: id, cost: c, ...rest } = extra;
		return finish({ itemId: id !== undefined ? id : itemId, cost: c ?? cost, ...rest, outcome: "completed" });
	}

	function finishBlocked(blockedKind: BlockedKind, reason: string, extra: Partial<CycleResultBase> & { blockedStep?: Step } = {}): CycleResult {
		const { itemId: id, cost: c, blockedStep, ...rest } = extra;
		return finish({ itemId: id !== undefined ? id : itemId, cost: c ?? cost, ...rest, outcome: "blocked", blockedKind, reason, ...(blockedStep ? { blockedStep } : {}) });
	}

	function finishParked(extra: Partial<CycleResultBase> = {}): CycleResult {
		const { itemId: id, cost: c, ...rest } = extra;
		return finish({
			itemId: id !== undefined ? id : itemId,
			cost: c ?? cost,
			...rest,
			outcome: "parked",
			parkClass: classifyParkReason(parkReasonDetail, parkSignal.limitType),
			parkReason: parkReasonDetail || parkSignal.limitType || null,
		});
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
	let startFrom = opts.startFrom;
	const picked = await runPick(
		{ flags, parkSignal, mainRepo, ...(itemId ? { itemId } : {}), ...(worktree ? { worktree } : {}), ...(startFrom ? { startFrom } : {}), profile },
		{
			opts,
			roadmap,
			log,
			finishFailed,
			finishBlocked,
			finishParked,
			step,
			itemRunIdFor,
			cost: () => cost,
			addCost: (delta) => {
				cost += delta;
			},
			setLogLabel: (label) => {
				logLabel = label;
			},
			listWorktrees,
			resolveWorktree: _resolveWorktree,
			createSessionController: createSessionControllerFn,
			isQuickScope: (input) => flowPolicy.isQuickScope(input),
		},
	);
	if (picked.kind === "terminal") return picked.result;
	itemId = picked.itemId;
	worktree = picked.worktree;
	startFrom = picked.startFrom;
	profile = picked.profile;
	sessionController = picked.sessionController;
	logLabel = itemId;

	const shouldRun = (s: PipelineStep): boolean => stepIndex(startFrom as PipelineStep) <= stepIndex(s);

	function parkExit(reason?: string, disposition?: CycleDisposition): CycleResult | null {
		if (!parkSignal.parked && !reason) return null;
		if (reason) parkReasonDetail = reason;
		if (worktree) checkpoint(worktree, reason ? "review-loop park" : "rate-limit park");
		log(`⏸ parked (${reason ?? parkSignal.limitType})`);
		return finishParked(disposition ? { disposition } : {});
	}

	function quarantineExit(opts: { blockedKind: BlockedKind; reason: string; step: Step } & Pick<CycleResult, "verdict">): CycleResult {
		const preserved = worktree ? quarantineCheckpoint(worktree, "andon quarantine") : true;
		const disposition: CycleDisposition = preserved ? "quarantine-and-continue" : "halt-campaign";
		const display = `${opts.step} blocked: ${opts.reason}`;
		if (preserved) log(`⊘ quarantined: ${display} — checkpointed, sweep continues`);
		else log("⚠ quarantine checkpoint failed — halting campaign to preserve WIP + diagnosis");
		return finishBlocked(opts.blockedKind, opts.reason, { ...(opts.verdict ? { verdict: opts.verdict } : {}), blockedStep: opts.step, disposition });
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
	async function runStepWithRetry(cfg: RunStepWithRetryConfig): Promise<StepAttempt> {
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
				...(cfg.preCheckpointGate ? { preCheckpointGate: cfg.preCheckpointGate } : {}),
			});
			cost += result.cost;

			if (result.ok) return { kind: "ok", result };

			const outcome = classifyOutcome(result);
			if (outcome === "error_confinement") {
				return { kind: "terminal", cycleResult: finishFailed(`${cfg.name} failed: confinement violation`, "confinement") };
			}
			if (outcome === "error_rate_limit" || parkSignal.parked) {
				return { kind: "terminal", cycleResult: parkExit() ?? finishFailed(`${cfg.name} failed`, classifyFailure({ error: `${cfg.name} failed`, subtype: result.subtype })) };
			}
			if (outcome === "blocked") {
				return { kind: "terminal", cycleResult: quarantineExit({ blockedKind: result.blockedKind ?? "unclassified", reason: result.text, step: cfg.name }) };
			}
			if (outcome === "error_refusal") {
				return { kind: "terminal", cycleResult: finishFailed(cfg.refusedError, "refusal") };
			}
			if (cfg.retryOnEditLoop && outcome === "edit_loop") {
				const match = result.text.match(/Edit loop detected: (.+?) edited/);
				lastLoopFile = match?.[1]?.replace(/^.*[/\\]/, "") ?? null;
				prevMaxTurns = false;
				if (attempt === maxAttempts) {
					return { kind: "terminal", cycleResult: finishFailed(`${cfg.name} failed (max retries)`, "unclassified") };
				}
				log(`edit loop on ${lastLoopFile ?? "unknown file"} — will retry with fresh approach`);
				continue;
			}
			if (isTransientSdkError(result)) {
				transientAttempts++;
				if (transientAttempts >= TRANSIENT_MAX_ATTEMPTS) {
					return { kind: "terminal", cycleResult: finishFailed("transient sdk error", "provider") };
				}
				const backoffMs = TRANSIENT_BACKOFF_MS * 2 ** (transientAttempts - 1);
				log(`transient SDK error in ${cfg.name} (attempt ${transientAttempts}/${TRANSIENT_MAX_ATTEMPTS - 1}) — retrying after ${backoffMs / 1000}s`);
				await sleep(backoffMs);
				attempt--;
				continue;
			}
			if (outcome !== "error_max_turns") {
				return { kind: "terminal", cycleResult: finishFailed(`${cfg.name} failed`, classifyFailure({ error: `${cfg.name} failed`, subtype: result.subtype })) };
			}
			// error_max_turns
			prevMaxTurns = true;
			log(`${noun} hit turn limit (attempt ${attempt}/${maxAttempts})`);
			if (attempt === maxAttempts) {
				return { kind: "terminal", cycleResult: finishFailed(`${cfg.name} failed (max retries)`, "turn-limit") };
			}
			if (!canRetryWithinBudget({ spent: cost, maxBudget, stepBudget: cfg.stepBudget })) {
				return { kind: "terminal", cycleResult: finishFailed(`${cfg.name} failed (insufficient budget to retry after max turns)`, "budget") };
			}
			// budget OK, more attempts remain — continue.
		}
		// Unreachable: the `attempt === maxAttempts` guard returns on the final iteration.
		// Present so the function is total over StepAttempt.
		return { kind: "terminal", cycleResult: finishFailed(`${cfg.name} failed (max retries)`, "turn-limit") };
	}

	// ── Plan + Shakedown-plan ──
	// Realize each raw candidate's provider-specific model into the generic DriverIdentity slot:
	// Codex keeps `codexModel`; Claude/Grok/OpenCode carry their own model in `model` (#431).
	const driverCandidates = (name: Step): DriverIdentity[] =>
		resolveDriverCandidates(CONFIG, profile, name).map((candidate) => {
			const model = modelForProvider(candidate, candidate.provider);
			return candidate.provider === "codex" ? { provider: "codex", ...(model ? { codexModel: model } : {}) } : { provider: candidate.provider, ...(model ? { model } : {}) };
		});
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

	// Step modules (plan step 9): each gets a plain value Input built here from the current bindings,
	// and the capabilities it Picks from the cycle's helpers; see steps/context.ts.
	const cycleHelpers: CycleHelpers = {
		log,
		roadmap,
		finish,
		finishFailed,
		finishBlocked,
		finishCompleted,
		finishParked,
		parkExit,
		runStepWithRetry,
		step,
		driverCandidates,
		available,
		itemRunId,
		observeGitForReceipt,
		reconstructAuthor,
		cost: () => cost,
		addCost: (delta: number) => {
			cost += delta;
		},
		setLogLabel: (label) => {
			logLabel = label;
		},
		listWorktrees,
		resolveWorktree: _resolveWorktree,
		createSessionController: createSessionControllerFn,
		isQuickScope: (input) => flowPolicy.isQuickScope(input),
		itemRunIdFor,
		quarantineExit,
		markShipwrecked: () => {
			shipwrecked = true;
		},
		now,
		runShipBookkeeping,
		preparePrShipFreshness: preparePrShipFreshnessFn,
		verifyPrShipFreshness: verifyPrShipFreshnessFn,
		runPrReviewGate: runPrReviewGateFn,
		runTypecheckRatchet: runTypecheckRatchetFn,
		readFreshnessGateRecord: readFreshnessGateRecordFn,
		writeFreshnessGateRecord: writeFreshnessGateRecordFn,
		prepareAuthoringReviewSeat: prepareAuthoringReviewSeatFn,
		cleanupAuthoringReviewSeatsForSha: cleanupAuthoringReviewSeatsForShaFn,
		verifyOrRepairAuthoringReviewHostDependencies: verifyOrRepairAuthoringReviewHostDependenciesFn,
	};

	if (shouldRun("plan")) {
		const outcome = await runPlan({ dryRun: opts.dryRun === true, assignment, deferredItemTitles, itemId: itemId!, worktree: worktree!, profile }, cycleHelpers);
		if (outcome.kind === "terminal") return outcome.result;
	}

	if (shouldRun("shakedown-plan")) {
		const outcome = await runShakedownPlan({ assignment, steps, itemId: itemId!, profile }, cycleHelpers);
		if (outcome.kind === "terminal") return outcome.result;
		verdict = outcome.verdict;
		shakedownPlanText = outcome.shakedownPlanText;
	}

	// ── Implement ──
	// Reconstruct whenever implement is not running this process — including
	// `startFrom: "ship"` — so freshness/pre-flight repair still has the realized
	// implementation author. The previous `shouldRun("shakedown-code")` guard
	// silently dropped the author on a ship-only resume.
	if (!assignment.authors.implementation && !shouldRun("implement")) {
		reconstructAuthor("implementation", "implement");
	}

	if (shouldRun("implement")) {
		const outcome = await runImplement({ flags, mainRepo, assignment, itemId: itemId!, worktree: worktree!, profile, verdict, shakedownPlanText }, { ...cycleHelpers, onReviewFindingsConsumed: deps.onReviewFindingsConsumed });
		if (outcome.kind === "terminal") return outcome.result;
	}

	// ── Shakedown-code ──
	let reviewRecordMarkdown: string | undefined;

	if (shouldRun("shakedown-code")) {
		const outcome = await runShakedownCode(
			{ flags, parkSignal, mainRepo, assignment, steps, executionReceipts, deferredItemTitles, cycleChallenge, itemId: itemId!, worktree: worktree!, profile },
			{ ...cycleHelpers, opts, writeEffectsManifest, dispatchStepEffects, appendReviewEscalation, lookupReviewEscalation },
		);
		if (outcome.kind === "terminal") return outcome.result;
		reviewRecordMarkdown = outcome.reviewRecordMarkdown;
	}

	return runShip({ parkSignal, mainRepo, assignment, itemId: itemId!, worktree: worktree!, profile, verdict, ...(reviewRecordMarkdown !== undefined ? { reviewRecordMarkdown } : {}) }, { ...cycleHelpers, opts });
}

// ── Orchestrator ───────────────────────────────────────────────────────
