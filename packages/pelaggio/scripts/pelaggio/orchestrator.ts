/**
 * Orchestrator (L4): drives cycles end-to-end — worker scheduling, park/resume waiting, the
 * review drain, hermetic defaults. The single cycle lives in `pipeline.ts`.
 */
import { execFileSync } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG, DEFAULT_SHIP_TARGET, LOG_PATH, REPO, REVIEW_CONFIG, REVISE_LOCAL, type ReviewRunner, ROADMAP_GITHUB, ROADMAP_LINEAR, ROADMAP_SOURCE, SHIP_TARGET } from "./config.js";
import { continuousCycleCap, DayBudgetTracker, dayKey, freeQueueProbe, nextLocalMidnightMs, resolveContinuousConfig, sumDaySpendFromLog } from "./continuous.js";
import { RECOVERABLE_ERRORS } from "./cycle-errors.js";
import { classifyCycleDisposition } from "./cycle-outcome.js";
import { resultDetail, resultIcon, resultStatus } from "./cycle-result.js";
import { createMutex, detectResumeStep } from "./cycle-support.js";
import { tryWithFileLock, withFileLock } from "./file-lock.js";
import { createEventWriter } from "./flow-events.js";
import { DEFAULT_FLOW_POLICY, type FlowPolicy } from "./flow-policy.js";
import { mainWorktree, resolveWorktree } from "./git.js";
import { type NotifyConfig, notifyCycle, notifyDecision as notifyDecisionEvent, notifyStrandedReview, sendNotification as sendNotificationDefault } from "./notify.js";
import { parseWaitFlag } from "./outcome-classify.js";
import { type PipelineDeps, runPipeline } from "./pipeline.js";
import { buildFailClosedComment, type PrReviewGateResult, resolveCarryOptions, runPrReviewGate } from "./pr-review-gate.js";
import { gateRecordsDir, type NewPrReviewGateRecord, writePrReviewGateRecord } from "./pr-review-gate-record.js";
import { detectUnattendedSignals, resolveAuthoringReviewExecution } from "./provider-routing.js";
import { devRoot, registerFamilyPath, registerFamilyRelativePath } from "./registers.js";
import { adjudicationSourcesDir, fleetRecordDigestOf, writeAdjudicationSourceRecord } from "./review/adjudication.js";
import { prFindingDispositionsDir, writePrFindingDispositionRecord } from "./review/carry.js";
import { claimReviewRequest, completeReviewRequest, listReviewRequests, type ReviewRequestRecord, reclaimStaleReviewClaims, reviewDrainLockPath, reviewRequestsDir, unclaimReviewRequest } from "./review-request-queue.js";
import { cleanupReviewHead, findReviewCandidates, postLocalModeWorkflowComment, postReviewStatus, prepareReviewHead, type ReviewCandidate, reviewStatusForSha, upsertReviewComment } from "./review-sweep.js";
import {
	acquireReviseExecution,
	autopilotManagedState,
	claimRevisionExclusive,
	ensureReviseWorktree,
	fetchReviewFindings,
	findRevisablePrs,
	isAutopilotManaged,
	postParkComment,
	reviseExecLeaseRoot,
	reviseFindingsPath,
} from "./revise-sweep.js";
import { defaultGhRun, type GhRunner } from "./roadmap/github-issues.js";
import { getRoadmapSource, type RoadmapSource } from "./roadmap/index.js";
import { RUN_HEARTBEAT_MS, startRunLifecycle } from "./run-lifecycle.js";
import { getShipTarget, isAutonomousRemotePush, isShipTargetName, SHIP_TARGET_NAMES } from "./ship/index.js";
import { isPipelineStep, STEPS } from "./step-names.js";
import { fmtWait, formatResumeHint } from "./text.js";
import { A, LiveStatus, StatusBar, TUI_ENABLED } from "./tui.js";
import type { CycleResult, CycleStatus, EventWriter, Flags, ParkSignal, PipelineOpts, ShipTargetName, Step } from "./types.js";

// Consecutive whole-cycle "transient sdk error" outcomes (issue #128) that distinguish a
// sustained provider outage from a single blip. One transient cycle stays silently
// recoverable (#127's behavior); this many in a row parks + pages instead of quietly
// burning through every remaining --cycles against a dead provider.
const CONSECUTIVE_TRANSIENT_ERROR_LIMIT = 3;
// Shared across workers and reset by any non-quarantine outcome, so this only trips
// on an unbroken no-ship streak. Five tolerates a few independent blocked items.
const CONSECUTIVE_QUARANTINE_LIMIT = 5;

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
	revise?: Partial<{ local: boolean; ghRepo: string; gh: GhRunner; acquireExec: typeof acquireReviseExecution; execLeaseRoot: string; claimRepo: string }>;
	/** Local review sweep config (issue #84; mid-run drain #387). Partial — merged onto config defaults. */
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
		/** Mid-run review-request queue root (#387). Defaults to `mainWorktree(REPO)/.dev/review-requests`;
		 *  tests inject a temp dir to drive the drain without touching real `.dev/`. */
		queueRoot: string;
		gateRecordsRoot: string;
		writeGateRecord: typeof writePrReviewGateRecord;
		adjudicationSourcesRoot: string;
		writeAdjudicationSource: typeof writeAdjudicationSourceRecord;
		dispositionsRoot: string;
		writeDispositionRecord: typeof writePrFindingDispositionRecord;
		resolveCarry: typeof resolveCarryOptions;
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
	/**
	 * Shared activity-event writer for this process. CLI `orchestrate()` injects a writer
	 * correlated with the lifecycle worker by executionId; fallback creation stays continuous-only so ordinary
	 * `runOrchestrator` tests do not write `.dev/flow-events/` under `REPO`.
	 */
	eventWriter?: EventWriter;
	/** Roadmap + flow policy used by the default free queue probe. */
	roadmap?: RoadmapSource;
	flowPolicy?: FlowPolicy;
	/**
	 * Orchestrator entry mode. `"standard"` (default) is every existing campaign / `--resume`
	 * / CI path. `"operator-revision"` is the `pelaggio revise --pr` entry: after a findings-
	 * driven `--resume` parks, it reuses the campaign `awaitParkReset` / `resumeOne` loop for
	 * that single id. Not a `Flags` field — ordinary `--resume` stays single-attempt.
	 */
	mode?: "standard" | "operator-revision";
	/** Cycle-log appender for local-review day-budget spend receipts (#398). Defaults to the
	 *  helpers.ts export; injectable so tests can capture the `budgetCharge` marker writes. */
	appendLog?: (entry: Record<string, unknown>) => void;
	/** Day-budget seed override (#398): today's already-spent USD. Skips reading the cycle log
	 *  (test seam). When omitted, continuous+day-budget runs derive it from `daySpendLogPath`. */
	initialDaySpend?: number;
	/** Path to the cycle log scanned for the day-budget seed (#398). Defaults to `LOG_PATH`;
	 *  overridable so integration tests can point at a temp jsonl. */
	daySpendLogPath?: string;
}

// Post-reset resume grace: jitter deliberately bounded inside the pre-existing 30s
// post-reset envelope so timer-mocked orchestrator tests need no `tick()` changes.
// delay = 15s + rand(0..15s) ∈ [15s, 30s). Widening these requires updating those tests.
const RESUME_MIN_GRACE_MS = 15_000;
const RESUME_JITTER_MS = 15_000;
// Defensive bound against a pathological park→tiny-reset→park spin. Each real wait is
// minutes+, and `maxWaitMs` already caps each round, so 12 is generous insurance.
const MAX_RESUME_ROUNDS = 12;
// Review drain lock (#387): one drain pass reviews PRs sequentially and may run minutes per PR;
// size the orphan-steal window well above the longest realistic single pass. It only matters
// across processes (a crashed holder), so 4h is generous insurance, not a per-PR timeout.
const REVIEW_DRAIN_LOCK_STALE_MS = 4 * 60 * 60 * 1000;

/**
 * Hermetic-test guard (#420, #456).
 *
 * `runOrchestrator`/`runPipeline` build their review + revise dependency bundles from real
 * defaults — the `gh` CLI runner, the PR-review gate that spawns provider agents, and the
 * host repo's `.dev/review-requests` queue. A test that reaches the drain without injecting
 * `deps.review` / `deps.revise` therefore uses the developer's real repo and network.
 *
 * Two failures were observed from exactly that: live Claude/Codex/Grok agents spawned out of
 * `orchestrator.test.ts` (#420), and a 4-hour hang because the host queue held a stale
 * `.drain.lock` and the post-cycle drain fell back to a blocking acquire (#456). The lock was
 * accidentally *masking* the agent spawn — clearing it to "fix" the hang exposes the escape.
 *
 * Under `node --test` (`NODE_TEST_CONTEXT`), the effectful defaults are replaced:
 * - callables throw on invocation, naming the dep to inject. Lazy by design: a test that never
 *   reaches the drain (e.g. `runner: "ci"`) stays green without boilerplate.
 * - queue roots point at a per-process temp dir, so lock paths and records can never resolve
 *   into the host `.dev/`.
 */
const IN_NODE_TEST = process.env.NODE_TEST_CONTEXT !== undefined;

export function hermeticDefault<T extends (...args: never[]) => unknown>(dep: string, real: T): T {
	if (!IN_NODE_TEST) return real;
	return ((..._args: never[]) => {
		throw new Error(
			`hermetic-test guard: \`${dep}\` was not injected. Under node --test the real implementation is withheld because it reaches the host repo or spawns provider agents (#420/#456). Pass it via deps.review/deps.revise in the test.`,
		);
	}) as unknown as T;
}

/** One temp base per process, created lazily. Memoised: `hermeticQueueRoot` is called on every
 *  `runOrchestrator`, so minting a fresh `mkdtempSync` per call leaked ~170 directories per test
 *  run and never removed them — on a box where /tmp inode exhaustion is already a known failure
 *  mode for repeated test runs. */
let hermeticBaseDir: string | undefined;

/** Per-`runOrchestrator` discriminator for the hermetic day-spend ledger. One shared temp file would
 *  let each test's `budgetCharge` receipts seed the *next* test's reconstructed day spend, making
 *  every day-budget assertion order-dependent (and passing for the wrong reason once the accumulated
 *  total crosses the cap). Ignored outside `node --test`, where the real ledger path is returned. */
let hermeticRunSeq = 0;

export function hermeticQueueRoot(real: () => string, name = "queue"): string {
	if (!IN_NODE_TEST) return real();
	// Not a throw: the path is read eagerly to derive the drain-lock path even when the drain
	// never runs, so withholding it would break tests that legitimately never touch the queue.
	hermeticBaseDir ??= mkdtempSync(join(tmpdir(), "pelaggio-hermetic-"));
	// Distinct subdirectories so queue records and gate records cannot collide in the shared base.
	const dir = join(hermeticBaseDir, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

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

function eventWriterCorrelation(): { streamId?: string; executionId?: string } {
	return {
		...(isUlidEnv(process.env.PELAGGIO_EVENT_STREAM_ID) ? { streamId: process.env.PELAGGIO_EVENT_STREAM_ID } : {}),
		...(isUlidEnv(process.env.PELAGGIO_EXECUTION_ID) ? { executionId: process.env.PELAGGIO_EXECUTION_ID } : {}),
	};
}

function finishOutcome(exitCode: number): { outcome: "completed" | "failed" | "parked"; exitCode: number } {
	if (exitCode === 0) return { outcome: "completed", exitCode: 0 };
	if (exitCode === PARKED_EXIT_CODE) return { outcome: "parked", exitCode: PARKED_EXIT_CODE };
	return { outcome: "failed", exitCode };
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

/** Retryable process status for a parked handback; 75 is the conventional EX_TEMPFAIL. */
export const PARKED_EXIT_CODE = 75;

function hasUnresolvedPark(results: CycleResult[]): boolean {
	// A later attempt for the same item resolves its earlier parked result.
	const latestByItem = new Map<string | null, CycleResult>();
	for (const result of results) latestByItem.set(result.itemId, result);
	return [...latestByItem.values()].some((result) => result.error === "parked");
}

export async function runOrchestrator(flags: Flags, deps: OrchestratorDeps = {}, statusBar: StatusBar = new StatusBar(), signal?: AbortSignal): Promise<{ exitCode: number; results: CycleResult[] }> {
	const _runPipeline = deps.runPipeline ?? runPipeline;
	const _detectResumeStep = deps.detectResumeStep ?? detectResumeStep;
	const _resolveWorktree = deps.resolveWorktree ?? resolveWorktree;
	// Preserve the entry value after runPipeline consumes the one-shot flag. Operator-revision
	// auto-resumes still need the revision lease, and a park handback must name the durable input
	// when implement has not completed yet.
	const entryReviewFindingsPath = flags["review-findings"];
	const consumedReviewFindingsItems = new Set<string>();
	const reviewFindingsLifecycleDeps: PipelineDeps = {
		onReviewFindingsConsumed: (itemId) => consumedReviewFindingsItems.add(itemId.toUpperCase()),
	};

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
		// Unattended-execution evidence for the review.authoring=local gate (#276): computed
		// once here — the only place run shape (cycles), daemon marker, and TTY are all known —
		// and threaded through PipelineOpts so the gate itself stays pure/injectable. The report
		// carries both positive signals and any PELAGGIO_OPERATOR_ATTENDED TTY suppression.
		const unattendedEvidenceFor = (multiCycle: boolean) => detectUnattendedSignals({ singleShot: noWorktree, multiCycle, env: process.env, stdoutIsTTY: process.stdout.isTTY === true });
		const orchestratorMode = deps.mode ?? "standard";
		// Operator revise restores a claim worktree then calls us in-process. Those ambient
		// single-shot paths set `worktree = REPO`, which would write the revision into the
		// main checkout — refuse loud rather than silently degrade.
		if (orchestratorMode === "operator-revision" && noWorktree) {
			console.error("operator-revision refuses --no-worktree / CI / PELAGGIO_SINGLE_SHOT (would write the revision into the main checkout)");
			return { exitCode: 2, results };
		}
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
		// One campaign-wide signal set: a multi-cycle campaign stays "multi-cycle" for every
		// cycle in it (including park-and-resume rounds), not just cycles after the first.
		const runUnattendedEvidence = unattendedEvidenceFor(cycles > 1);
		// Pre-flight (#276 follow-up): `enabled=local` with a deterministic unattended signal
		// (CI/single-shot, daemon marker, multi-cycle) can only ever refuse — yet the
		// resolution-time gate sits at shakedown-code, after the full plan+implement spend.
		// Refuse before any paid work, reusing the exact resolution-time refusal. The TTY
		// evidence is deliberately excluded (`stdoutIsTTY: true`): the headless signal is
		// operator-attestable via PELAGGIO_OPERATOR_ATTENDED and belongs to resolution time.
		// Resume re-entry may legitimately start past shakedown-code, so it keeps the
		// resolution-time gate alone; that gate stays the authoritative backstop everywhere.
		if (!flags.resume && REVIEW_CONFIG.authoring.enabled === "local") {
			const deterministic = detectUnattendedSignals({ singleShot: noWorktree, multiCycle: cycles > 1, env: process.env, stdoutIsTTY: true });
			if (deterministic.signals.length > 0) {
				const preflight = resolveAuthoringReviewExecution(REVIEW_CONFIG.authoring, { unattendedSignals: deterministic.signals });
				if (!preflight.ok) {
					console.error(preflight.reason);
					return { exitCode: 2, results };
				}
			}
		}
		// Provider-estimated spend (e.g. Codex on a subscription) counts toward `--budget` the same
		// as billed USD — deliberate: it fails safe (a subscription run still respects the cap as a
		// token-spend proxy) and the warning below marks the figure `~` so it never reads as real USD.
		const maxBudget = parseFloat(flags.budget);
		const dryRun = flags["dry-run"];
		const v = flags.verbose;
		const isParallel = parallel > 1;
		const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
		const now = deps.now ?? Date.now;
		// Day-budget durability (#398): reconstruct today's spend on every continuous process start
		// (fresh launch, daemon pause→resume, crash restart) from the durable cycle-log ledger, so a
		// same-day restart and a midnight-crossing restart both honor the cap. Read the log only when
		// continuous AND a day budget is set — ordinary `--item` runs pay no IO.
		// Under node --test this must not resolve to the host cycle log: seeding from a developer's
		// real spend makes an existing main test ("drain: day-budget exhaustion stops") fail whenever
		// today's actual spend exceeds its $5 cap — green on a fresh CI runner, red locally. Same
		// non-hermetic class as #456. `hermeticQueueRoot` yields a temp dir under test and the real
		// parent otherwise, so the composed path is LOG_PATH in production and a nonexistent temp file
		// in tests (which `sumDaySpendFromLog` reads as ENOENT → $0).
		const daySpendLogPath =
			deps.daySpendLogPath ??
			join(
				hermeticQueueRoot(() => dirname(LOG_PATH), `day-spend-log-${++hermeticRunSeq}`),
				basename(LOG_PATH),
			);
		if (continuous?.dayBudget != null && deps.initialDaySpend === undefined) {
			// Reconstruction proves the ledger is *readable*; the day budget also depends on it being
			// *appendable*. A readable-but-unwritable ledger otherwise passes startup, paid review then
			// runs, and only `appendDayBudgetCharge` discovers EACCES — after the money is spent, with
			// the charge unrecorded, so the next restart under-counts and grants budget again. Probe the
			// write path before any paid work rather than after (#398 review).
			try {
				// `appendLog` creates `.dev/` lazily on first write (helpers.ts), so on a fresh consumer
				// checkout the ledger's parent does not exist yet and probing it would throw ENOENT —
				// reported as "not writable", failing every first-ever day-budget run including --dry-run.
				// Create it first, exactly as the eventual writer would, then probe for real.
				mkdirSync(dirname(daySpendLogPath), { recursive: true });
				accessSync(existsSync(daySpendLogPath) ? daySpendLogPath : dirname(daySpendLogPath), constants.W_OK);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				throw new Error(`day-budget ledger is not writable (${daySpendLogPath}): ${msg}. Refusing to start paid work whose spend could not be durably recorded — fix permissions or clear the day budget.`);
			}
		}
		// One clock sample feeds both the ledger scan and the tracker's starting day. Sampling twice
		// lets a scan that crosses local midnight seed yesterday's spend against today's key.
		const seedNowMs = now();
		const initialDaySpend = continuous?.dayBudget != null ? (deps.initialDaySpend ?? sumDaySpendFromLog(daySpendLogPath, seedNowMs)) : 0;
		const dayBudgetTracker = new DayBudgetTracker(continuous?.dayBudget, now, initialDaySpend, dayKey(seedNowMs));
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
			console.log(`${A.dim("logs")}  ${registerFamilyRelativePath("pelaggio-", "{N}.log")}`);
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
		// Correlate activity with this process's lifecycle executionId. CLI `orchestrate()`
		// injects the activity writer; fallback stays continuous-only.
		const writer = deps.eventWriter ?? (continuous ? createEventWriter(eventWriterCorrelation()) : undefined);
		const emitContinuous = (input: Parameters<NonNullable<typeof writer>["append"]>[0]): void => {
			try {
				writer?.append(input);
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
		// Single-sourced with `notify.ts`'s classifier via `RECOVERABLE_ERRORS` (cycle-errors.ts) to
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
						} else if (campaignDrainDeferred && !dayBudgetTracker.exceeded()) {
							// The budget rolled over (or a peer's spend was refunded): run the campaign-start
							// drain that was deferred at startup, before any paid pick work. Claimed under the
							// continuous gate and flipped before awaiting so ×N workers cannot double-drain.
							campaignDrainDeferred = false;
							console.log(`${A.dim("↻")} day budget rolled over — running the deferred campaign-start review drain`);
							await runCampaignStartDrain();
							retryGate = true;
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
					mkdirSync(devRoot(REPO), { recursive: true });
					logPath = registerFamilyPath(REPO, "pelaggio-", `${cycle}.log`);
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
						unattendedSignals: runUnattendedEvidence.signals,
						unattendedSignalSuppressions: runUnattendedEvidence.suppressed,
						...(decisionNotifier ? { notifyDecision: decisionNotifier } : {}),
						...(noWorktree ? { noWorktree: true } : {}),
						...(signal ? { signal } : {}),
					},
					parkSignal,
					flags,
					reviewFindingsLifecycleDeps,
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
						// KNOWN GAP (#458): this relabel is in-memory only and happens *after*
						// runPipeline's finish() already appended this cycle's log entry, which
						// the append-only log never reconciles. So the tripping cycle persists as
						// an ordinary `transient sdk error` failure with no `parkClass`, and
						// `resetsAt = 0` below makes awaitParkReset hand back immediately — so a
						// serial run has no next cycle to record the park either. `pelaggio stats`
						// therefore under-reports `sdk-outage`. See the ParkClass doc in types.ts.
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

				const logRef = logPath ? `  ${A.dim(`→ ${registerFamilyRelativePath("pelaggio-", `${cycle}.log`)}`)}` : "";
				const detail = resultDetail(result);
				console.log(`${resultIcon(result)} cycle ${cycle}: ${A.bold(result.itemId ?? "?")} — ${result.costEstimated ? "~" : ""}$${result.cost.toFixed(2)}${detail ? `  ${A.dim(detail)}` : ""}${logRef}`);

				if (v) liveStatus.render();

				// Post-cycle review drain (#387): the load-bearing symptom fix — review the PR this cycle
				// just shipped (and any backlog) before the worker pulls again, in every mode incl. a single
				// `--item` (its lone ship drains before the worker returns). In continuous mode this drain of
				// iteration N precedes revise-at-top of N+1, preserving review→revise order across the
				// boundary. The first lock attempt is non-blocking; on contention this cycle waits and then
				// re-lists, because the current holder may have snapshotted before this cycle enqueued. On
				// a rate-limit park the drain sets parkSignal and returns; the break below hands off to the
				// main park-and-resume block (no nested auto-resume wait inside the worker).
				if (doReviewDrain && !parkSignal.parked) {
					await runPostCycleReviewDrain();
				}

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

		// Revise-sweep config — hoisted above `resumeOne` because the execution lease it
		// carries is shared by every revision executor: the sweep, and (#507 round 3) every
		// revision-mode resume path. Injecting `ghRepo` lets tests force-activate the sweep
		// with a stubbed `gh` without a real github-issues config.
		const revise = {
			local: REVISE_LOCAL,
			ghRepo: ROADMAP_SOURCE === "github-issues" ? ROADMAP_GITHUB.ghRepo : "",
			gh: hermeticDefault("revise.gh", defaultGhRun),
			// Execution lease shared with `pelaggio revise --pr` (revise-cli.ts). The real
			// function is safe under node --test because the ROOT is hermetically redirected —
			// tests never write the host `.dev/revise-exec/`.
			acquireExec: acquireReviseExecution,
			execLeaseRoot: hermeticQueueRoot(() => reviseExecLeaseRoot(REPO), "revise-exec"),
			// Repo whose `.dev/revise-claim.lock` serializes the one-pass label claim.
			// Hermetically redirected like execLeaseRoot so `node --test` never writes the
			// HOST repo's `.dev/revise-claim.lock`.
			claimRepo: hermeticQueueRoot(() => REPO, "revise-claim-repo"),
			...deps.revise,
		};

		// #507 round 3: every path that executes a revision in an item's claim worktree must
		// hold the per-item execution lease — the sweep, the operator CLI, AND every
		// revision-mode resume. The lease is released when a revision attempt parks (holding
		// it across a reset sleep would pin it), so each resume attempt REACQUIRES it before
		// touching the worktree. Fail-soft on contention: refuse naming the holder, never
		// proceed unleased.
		const acquireRevisionResumeLease = async (id: string): Promise<{ ok: true; release: () => Promise<void> } | { ok: false; refusal: string }> => {
			const acq = await revise.acquireExec(revise.execLeaseRoot, id);
			if (acq.kind === "acquired") return { ok: true, release: () => acq.lease.release() };
			const why = acq.kind === "held" ? acq.holder : `the execution-lease register under ${revise.execLeaseRoot} is unavailable`;
			return { ok: false, refusal: `refusing to resume ${id} without the revise execution lease — ${why}` };
		};

		// Per-item resume body — the `--resume` re-entry path in-process. Hoisted so both
		// the campaign park-and-resume loop and operator-revision mode call the same function
		// (it used to be declared only inside the later campaign `if (parkSignal.parked)` block).
		const resumeOne = async (id: string, i: number): Promise<CycleResult> => {
			const wt = noWorktree ? REPO : _resolveWorktree(id);
			// Findings survival across an implement park (issue #76): if the sweep-written
			// findings file still exists on disk, re-inject it before choosing the restart step so
			// the resumed item routes through implement and still fixes the specific blockers.
			// Successful implement consumes the flag and archives this local file, so a park in a
			// later step follows the normal logged-step resume path instead of reapplying findings.
			// Inert for non-revision items — no findings file is present, so `flags` passes
			// through unchanged.
			let resumeFlags = flags;
			if (!flags["review-findings"]) {
				const fp = reviseFindingsPath(REPO, id);
				if (existsSync(fp)) resumeFlags = { ...flags, "review-findings": fp };
			}
			// A findings-driven resume is a revision attempt in the item's claim worktree, so it
			// reacquires the execution lease released by the parked attempt (#507 round 3).
			let releaseLease: (() => Promise<void>) | undefined;
			if (resumeFlags["review-findings"] || consumedReviewFindingsItems.has(id.toUpperCase()) || orchestratorMode === "operator-revision") {
				const leased = await acquireRevisionResumeLease(id);
				if (!leased.ok) {
					console.log(`${A.red("✗")} resume ${id} — ${leased.refusal}`);
					return { itemId: id, completed: false, cost: 0, error: "revise lease unavailable", detail: leased.refusal, disposition: "continue" };
				}
				releaseLease = leased.release;
			}
			try {
				const st: CycleStatus = { itemId: id, status: "running", cost: 0 };
				liveStatus.cycles.push(st);
				if (v) liveStatus.render();
				let resumeLogPath: string | undefined;
				if (isParallel && v) {
					resumeLogPath = registerFamilyPath(REPO, "pelaggio-", `resume-${id.toLowerCase()}.log`);
					appendFileSync(resumeLogPath, `${"=".repeat(60)}\nresume ${id} — ${new Date().toISOString()}\n${"=".repeat(60)}\n`);
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
						unattendedSignals: runUnattendedEvidence.signals,
						unattendedSignalSuppressions: runUnattendedEvidence.suppressed,
						...(decisionNotifier ? { notifyDecision: decisionNotifier } : {}),
						...(noWorktree ? { noWorktree: true } : {}),
						...(signal ? { signal } : {}),
					},
					parkSignal,
					resumeFlags,
					reviewFindingsLifecycleDeps,
				);
				await notify(r, resumeLogPath ?? LOG_PATH);
				st.status = resultStatus(r);
				st.cost = r.cost;
				st.step = undefined;
				if (v) liveStatus.render();
				const detail = resultDetail(r);
				console.log(`${resultIcon(r)} resume ${id} — ${r.costEstimated ? "~" : ""}$${r.cost.toFixed(2)}${detail ? `  ${A.dim(detail)}` : ""}`);
				return r;
			} finally {
				// Release-on-park by construction: the attempt ends (parked or not) before the
				// shared wait loop sleeps, so the lease is never pinned across a reset window.
				await releaseLease?.();
			}
		};

		// ── Local review drain (issue #84 sweep + #387 mid-run reconciler) ──
		//
		// In local review mode the trusted local main tree owns the review CLI/skill/parser/status
		// posting code; PR heads are only diff/file data. The reconciler is the SOLE executor and
		// status poster — the ship tail only ENQUEUES a review-request (#387). It drains at campaign
		// start (cold-start + backlog) and post-cycle inside every worker, so a PR opened mid-run — or
		// the sole PR of an `--item` run — gets its `review` status before the worker exits rather than
		// "next process". It always runs before revise, so a fresh local BLOCK is immediately revisable.
		const review = {
			runner: REVIEW_CONFIG.runner,
			policy: REVIEW_CONFIG,
			statuslessAfter: REVIEW_CONFIG.statuslessAfter,
			ghRepo: ROADMAP_SOURCE === "github-issues" ? ROADMAP_GITHUB.ghRepo : "",
			gh: hermeticDefault("review.gh", defaultGhRun),
			runReviewGate: hermeticDefault("review.runReviewGate", runPrReviewGate),
			now: () => Date.now(),
			prepareReviewHead: hermeticDefault("review.prepareReviewHead", prepareReviewHead),
			cleanupReviewHead: hermeticDefault("review.cleanupReviewHead", cleanupReviewHead),
			queueRoot: hermeticQueueRoot(() => reviewRequestsDir(mainWorktree(REPO)), "review-requests"),
			gateRecordsRoot: hermeticQueueRoot(() => gateRecordsDir(mainWorktree(REPO)), "gate-records"),
			// Not guarded: it writes to `gateRecordsRoot`, which is itself hermetic by default above.
			writeGateRecord: writePrReviewGateRecord,
			adjudicationSourcesRoot: hermeticQueueRoot(() => adjudicationSourcesDir(mainWorktree(REPO)), "adjudication-sources"),
			writeAdjudicationSource: writeAdjudicationSourceRecord,
			dispositionsRoot: hermeticQueueRoot(() => prFindingDispositionsDir(mainWorktree(REPO)), "finding-dispositions"),
			// Not guarded: reads/writes only `dispositionsRoot` + `gateRecordsRoot` (hermetic by
			// default above); with an empty store it returns before any git call.
			writeDispositionRecord: writePrFindingDispositionRecord,
			resolveCarry: resolveCarryOptions,
			...deps.review,
		};
		const shipIsPr = shipTargetName === "pull-request" || shipTargetName === "auto-merge-pr";
		// #387: `items.length === 0` is REMOVED for review only — the `review` status is a merge gate,
		// not optional campaign work, so an explicit `--item` run drains too. Revise keeps its
		// `items.length === 0` exclusion below ("do exactly these").
		const doReviewDrain = review.runner === "local" && shipIsPr && !!review.ghRepo && !noWorktree && !dryRun;
		const reviewDrainLock = reviewDrainLockPath(review.queueRoot);

		// Local-review day-budget durability (#398): the review drain charges `dayBudgetTracker.add`
		// but — unlike pick/revise cycles — writes no cycle-log line, so a pure jsonl seed would
		// under-count review spend after a restart. Append a minimal `budgetCharge` receipt whenever
		// review cost is charged to the day budget. `sumDaySpendFromLog` reads these rows for the seed
		// while `stats.reduce()` filters them, so durability costs `/stats` nothing. `doReviewDrain` is
		// already `!dryRun`-gated, so this only runs on real spend.
		// Receipts must land in the same ledger the seed reads (`daySpendLogPath`), not the ambient
		// `appendLog` default. Production keeps them identical (both `LOG_PATH`), but under `node --test`
		// only the seed was redirected: the default wrote real $5 `budgetCharge` rows into the host
		// cycle log, so `sumDaySpendFromLog` counted them and the next real `--day-budget 5` campaign
		// started already exhausted. Injection still wins, so tests can capture marker writes.
		const appendDayBudgetReceipt =
			deps.appendLog ??
			((entry: Record<string, unknown>): void => {
				mkdirSync(dirname(daySpendLogPath), { recursive: true });
				appendFileSync(daySpendLogPath, `${JSON.stringify(entry)}\n`);
			});
		/** Returns false when the receipt could not be made durable — callers must stop paid work. */
		// Campaign-scoped latch. This flag has now been widened three times — per-PR, per-drain-pass,
		// then review-drain-only — each time because the previous scope let some other paid path keep
		// running. It lives here, above the only writer, and the writer halts the whole campaign:
		// an undurable ledger invalidates *all* spend accounting, not just review spend.
		let receiptUndurable = false;
		const appendDayBudgetCharge = (cost: number): boolean => {
			// The receipt exists solely to seed durable day-spend reconstruction, so it is meaningful
			// only when a continuous day budget is set. No budget (or non-continuous single-item runs
			// that still drain reviews) → nothing is "charged to the day budget", so skip the write.
			if (continuous?.dayBudget == null) return true;
			if (!(Number.isFinite(cost) && cost > 0)) return true;
			try {
				appendDayBudgetReceipt({
					ts: new Date(now()).toISOString(),
					cycle: 0,
					item: null, // spend receipt, not a delivered item
					quick: false,
					steps: [],
					total_cost: Number(cost.toFixed(4)),
					completed: true,
					error: null,
					verdict: null,
					budgetCharge: true,
				});
			} catch (e) {
				// The startup W_OK probe proves writability before any paid work, so reaching here means
				// the ledger went unwritable mid-run. The in-memory charge stands (this process still
				// honors the cap), but nothing survives a restart — the next launch would reconstruct a
				// smaller day spend and re-grant budget already spent. Fail closed rather than absorb it:
				// the broad review catch would otherwise record a zero-cost crash and keep drawing.
				const msg = e instanceof Error ? e.message : String(e);
				console.error(`day-budget receipt could not be written (${daySpendLogPath}): ${msg}. $${cost.toFixed(2)} is charged in memory but will not survive a restart — halting the campaign.`);
				// Halt every paid path, not just the review drain: below the cap the orchestrator would
				// otherwise go on to revise and pick work whose spend is equally unreconstructable.
				receiptUndurable = true;
				campaignHalted = true;
				return false;
			}
			return true;
		};

		// One drain pass: reconcile enqueued records with live statusless PRs, post each `review`
		// status from the trusted tree, and complete records. Respects `parkSignal` — a rate-limit
		// park stops starting new reviews and returns (the caller decides whether to wait+retry).
		// Serialized by the drain lock at both call sites so two finishing workers never
		// double-execute one PR+SHA.
		async function runLocalReviewDrainOnce(opts: { notifyStranded: boolean }): Promise<void> {
			reclaimStaleReviewClaims(review.queueRoot, review.now());
			const records = listReviewRequests(review.queueRoot);
			const { candidates, stranded } = findReviewCandidates(review.gh, review.ghRepo, review.now(), parseWaitFlag(review.statuslessAfter));
			// Stranded nudge (idempotent comment + notification) — campaign-start's first round only, so
			// post-cycle drains and resumed retries do not re-notify the same stranded PRs.
			if (opts.notifyStranded) {
				for (const pr of stranded) {
					postLocalModeWorkflowComment(review.gh, review.ghRepo, pr.prNumber);
					if (notifyEnabled) await notifyStrandedReview(notifyCfg, { itemId: pr.itemId, prNumber: pr.prNumber, ghRepo: review.ghRepo, headSha: pr.headSha, logPath: LOG_PATH }, { send });
				}
			}

			// Union by (prNumber, headSha): enqueued records are authoritative mid-run intent; live
			// candidates (status missing|pending) backfill cold-start backlog + prior-run statusless PRs.
			const work = new Map<string, { candidate: ReviewCandidate; record?: ReviewRequestRecord }>();
			for (const { record } of records) {
				work.set(`${record.prNumber}-${record.headSha}`, {
					candidate: { prNumber: record.prNumber, itemId: record.itemId, branch: record.headBranch, headSha: record.headSha, statusState: "missing" },
					record,
				});
			}
			const liveKeys = new Set(candidates.map((c) => `${c.prNumber}-${c.headSha}`));
			for (const candidate of candidates) {
				const key = `${candidate.prNumber}-${candidate.headSha}`;
				const existing = work.get(key);
				if (existing)
					existing.candidate = candidate; // prefer live candidate data; keep the record for completion
				else work.set(key, { candidate });
			}

			for (const { candidate: pr, record } of work.values()) {
				if (parkSignal.parked) break;
				// Stop before *starting* another paid review. A single operation may cross the cap
				// (cost is unknowable until the gate returns), but the next one must not: without this
				// the campaign-start gate is the only check, so one review crossing the cap still let
				// the whole remaining backlog run.
				if (dayBudgetTracker.exceeded()) break;
				if (receiptUndurable) break;
				// Tri-state on purpose: deleting the durable record requires a POSITIVE
				// "unmanaged" read — a transient/malformed gh response ("unknown") skips
				// this round and retains the record for retry (#387 gate finding).
				const managed = autopilotManagedState(review.gh, review.ghRepo, pr.itemId, ROADMAP_GITHUB.label);
				if (managed !== "managed") {
					if (record && managed === "unmanaged") completeReviewRequest(review.queueRoot, pr.prNumber, pr.headSha);
					continue;
				}
				// Crash-between-post-and-dequeue: an orphaned record (no live candidate) may already be
				// terminal on the forge. Confirm POSITIVELY on the exact SHA — never "absent from the
				// candidate list" — before deleting without re-running the agent. Live candidates are
				// never terminal (findReviewCandidates drops done PRs), so they skip this probe.
				const key = `${pr.prNumber}-${pr.headSha}`;
				if (record && !liveKeys.has(key) && reviewStatusForSha(review.gh, review.ghRepo, pr.headSha) === "done") {
					completeReviewRequest(review.queueRoot, pr.prNumber, pr.headSha);
					continue;
				}
				if (record) claimReviewRequest(review.queueRoot, pr.prNumber, pr.headSha);
				if (!postReviewStatus(review.gh, review.ghRepo, pr.headSha, "pending", "local pelaggio review running")) {
					if (record) unclaimReviewRequest(review.queueRoot, pr.prNumber, pr.headSha);
					continue;
				}
				let body = "";
				let finalState: "success" | "failure" = "failure";
				let reviewCost = 0;
				let reviewCostEstimated = false;
				let parked = false;
				let gateResult: PrReviewGateResult | null = null;
				let gateStartedAt: number | undefined;
				let elapsedMs = 0;
				try {
					const prepared = review.prepareReviewHead(REPO, pr);
					if (!prepared) throw new Error("could not prepare PR head for local review");
					// #495: cross-push carry — prior selection, interdiff, and eligibility resolve
					// deterministically before the gate; any predicate failure runs cold with a warning.
					const carry = review.policy.carry
						? review.resolveCarry({
								prNumber: pr.prNumber,
								itemId: pr.itemId,
								reviewedSha: pr.headSha,
								repo: REPO,
								diffCwd: prepared.diffCwd,
								dispositionsRoot: review.dispositionsRoot,
								gateRecordsRoot: review.gateRecordsRoot,
								execFileSync,
								readFileSync,
								taxonomy: review.policy.taxonomy,
								warn: (msg) => console.warn(`review ${pr.itemId}#${pr.prNumber} — ${msg}`),
							})
						: undefined;
					gateStartedAt = review.now();
					const result = await review.runReviewGate({
						pr: String(pr.prNumber),
						itemId: pr.itemId,
						profile: "standard",
						cwd: REPO,
						diffCwd: prepared.diffCwd,
						diffBaseRef: prepared.baseRef,
						diffHeadRef: prepared.headRef,
						reviewedSha: pr.headSha,
						policy: review.policy,
						parkSignal, // shared: a rate-limit park sets this and flows into the wait+retry policy
						...(carry ? { carry } : {}),
					});
					elapsedMs = Math.max(0, Math.trunc(review.now() - gateStartedAt));
					if (result.gate === "park") {
						// Transient: leave the pending status as-is (do NOT upsert findings or post failure),
						// charge the partial cost, hand the record back, and stop starting new reviews this pass.
						// Day-budget must see the partial spend too, or a rate-limited review
						// under-reports --day-budget and drains keep picking past the cap.
						totalSpent += result.cost;
						dayBudgetTracker.add(result.cost);
						// The partial cost is real spend; a lost receipt re-grants that budget on restart.
						appendDayBudgetCharge(result.cost);
						parked = true;
						console.log(`review ${pr.itemId}#${pr.prNumber} — parked (${result.park?.limitType ?? parkSignal.limitType})`);
					} else {
						gateResult = result;
						body = result.body;
						finalState = result.gate === "pass" ? "success" : "failure";
						reviewCost = result.cost;
						reviewCostEstimated = result.costEstimated;
					}
				} catch (e) {
					if (gateStartedAt !== undefined) elapsedMs = Math.max(0, Math.trunc(review.now() - gateStartedAt));
					const msg = e instanceof Error ? e.message : String(e);
					body = buildFailClosedComment("error_crash", `local pr-review crashed before producing a review, so this gate blocks the merge.\n\n${msg}`);
					finalState = "failure";
				} finally {
					review.cleanupReviewHead(REPO, pr);
				}
				if (parked) {
					if (record) unclaimReviewRequest(review.queueRoot, pr.prNumber, pr.headSha);
					break;
				}
				const gateRecord: NewPrReviewGateRecord = gateResult
					? {
							producer: "fleet",
							prNumber: pr.prNumber,
							headSha: pr.headSha,
							itemId: pr.itemId,
							gate: gateResult.gate === "pass" ? "pass" : "block",
							ok: gateResult.ok,
							subtype: gateResult.subtype,
							agreement: gateResult.agreement ?? "invalid",
							breakerReason: gateResult.breakerReason,
							iterations: gateResult.iterations,
							survivorCount: gateResult.survivorCount,
							cost: gateResult.cost,
							costEstimated: gateResult.costEstimated,
							turns: gateResult.turns,
							elapsedMs,
							runner: "local",
							reviewedAt: new Date(review.now()).toISOString(),
						}
					: {
							producer: "fleet",
							prNumber: pr.prNumber,
							headSha: pr.headSha,
							itemId: pr.itemId,
							gate: "block",
							ok: false,
							subtype: "error_crash",
							agreement: "invalid",
							cost: 0,
							costEstimated: false,
							turns: 0,
							elapsedMs,
							runner: "local",
							reviewedAt: new Date(review.now()).toISOString(),
						};
				// The review has already incurred its cost. Charge it before persistence so
				// a durable-store failure cannot turn retries into unmetered paid runs.
				totalSpent += reviewCost;
				dayBudgetTracker.add(reviewCost);
				// #398 receipt rides immediately after the charge it durabilizes, so a later
				// `writeGateRecord` failure (which `continue`s) still leaves the already-incurred
				// review cost reconstructable from the cycle log after a restart.
				// A lost receipt means restart-reconstruction would under-count this spend, so stop
				// starting new paid reviews this pass rather than drawing against a budget that will
				// look unspent after a restart. Persistence for *this* PR still completes below — the
				// review is already paid for, so its outcome must not be thrown away too.
				appendDayBudgetCharge(reviewCost); // failure latches receiptUndurable + halts the campaign
				let fleetPath: string | undefined;
				try {
					fleetPath = review.writeGateRecord(review.gateRecordsRoot, gateRecord);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.warn(`review ${pr.itemId}#${pr.prNumber} — could not persist gate outcome: ${msg}`);
					if (record) unclaimReviewRequest(review.queueRoot, pr.prNumber, pr.headSha);
					continue;
				}
				const draft = gateResult?.adjudicationSource;
				if (
					fleetPath &&
					draft &&
					draft.reviewedSha.toLowerCase() === pr.headSha.toLowerCase() &&
					draft.survivorCount === gateRecord.survivorCount &&
					draft.agreement === gateRecord.agreement &&
					draft.prNumber === gateRecord.prNumber &&
					draft.itemId === gateRecord.itemId
				) {
					try {
						const fleetBytes = readFileSync(fleetPath);
						review.writeAdjudicationSource(review.adjudicationSourcesRoot, {
							...draft,
							schemaVersion: 1,
							fleetRecordDigest: fleetRecordDigestOf(fleetBytes),
						});
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						console.warn(`review ${pr.itemId}#${pr.prNumber} — could not persist adjudication source: ${msg}`);
					}
				}
				// #495: cross-push disposition record, next to the fleet record + sidecar. Written on
				// pass AND block (a pass record keeps the refutation memory); best-effort — a failure
				// warns and only ever means the next run on this PR reviews cold.
				const dispositionDraft = gateResult?.dispositionDraft;
				if (
					fleetPath &&
					dispositionDraft &&
					gateRecord.producer === "fleet" &&
					dispositionDraft.headSha === pr.headSha.toLowerCase() &&
					dispositionDraft.prNumber === gateRecord.prNumber &&
					dispositionDraft.itemId === gateRecord.itemId &&
					dispositionDraft.gate === gateRecord.gate &&
					dispositionDraft.agreement === gateRecord.agreement &&
					dispositionDraft.ok === gateRecord.ok
				) {
					try {
						const fleetBytes = readFileSync(fleetPath);
						review.writeDispositionRecord(review.dispositionsRoot, {
							...dispositionDraft,
							fleetRecordDigest: fleetRecordDigestOf(fleetBytes),
							reviewedAt: gateRecord.reviewedAt,
						});
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						console.warn(`review ${pr.itemId}#${pr.prNumber} — could not persist finding dispositions: ${msg}`);
					}
				}
				upsertReviewComment(review.gh, review.ghRepo, pr.prNumber, body);
				const posted = postReviewStatus(review.gh, review.ghRepo, pr.headSha, finalState, finalState === "success" ? "local pelaggio review passed" : "local pelaggio review blocked");
				// The record is satisfied only when the terminal status POST SUCCEEDED —
				// deleting it on a failed post would leave the PR pending forever with no
				// durable request to guarantee a retry (#387 gate finding). Unclaim instead
				// so the next drain round retries.
				if (record) {
					if (posted) completeReviewRequest(review.queueRoot, pr.prNumber, pr.headSha);
					else unclaimReviewRequest(review.queueRoot, pr.prNumber, pr.headSha);
				}
				console.log(`review ${pr.itemId}#${pr.prNumber} — ${finalState}${reviewCost > 0 ? ` ${reviewCostEstimated ? "~" : ""}$${reviewCost.toFixed(2)}` : ""}`);
			}
		}

		async function runPostCycleReviewDrain(): Promise<void> {
			const attempt = await tryWithFileLock(reviewDrainLock, () => runLocalReviewDrainOnce({ notifyStranded: false }), { label: "review drain lock", staleMs: REVIEW_DRAIN_LOCK_STALE_MS });
			if (!attempt.ran) {
				// The holder may have listed before this cycle enqueued its ship record. Wait for
				// release, then re-list under the lock so that record cannot be stranded.
				await withFileLock(reviewDrainLock, () => runLocalReviewDrainOnce({ notifyStranded: false }), {
					label: "review drain lock",
					staleMs: REVIEW_DRAIN_LOCK_STALE_MS,
					acquireTimeoutMs: REVIEW_DRAIN_LOCK_STALE_MS,
				});
			}
		}

		// Resume mode
		if (flags.resume) {
			const id = flags.resume.toUpperCase();
			const worktree = noWorktree ? REPO : _resolveWorktree(id);
			const v = flags.verbose;
			if (flags.from !== undefined && (!isPipelineStep(flags.from) || flags.from === "pick")) {
				console.error(`invalid --from ${JSON.stringify(flags.from)}; valid: ${STEPS.filter((s) => s !== "pick").join(", ")}`);
				return { exitCode: 2, results };
			}
			if (flags["review-findings"] !== undefined && flags.from !== undefined && flags.from !== "implement") {
				console.error(`--review-findings requires --from implement (got ${JSON.stringify(flags.from)}): the findings are read and validated by the implement step`);
				return { exitCode: 2, results };
			}
			if (flags["review-findings"] !== undefined) {
				const findingsPath = flags["review-findings"];
				if (findingsPath.trim() === "") {
					console.error("empty --review-findings path — refusing a findings-driven resume without findings");
					return { exitCode: 1, results };
				}
				try {
					readFileSync(findingsPath);
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "ENOENT") {
						console.error(`findings file not found; refusing a findings-driven resume without findings: ${JSON.stringify(findingsPath)}`);
					} else {
						const detail = err instanceof Error ? err.message : String(err);
						console.error(`could not read review findings ${JSON.stringify(findingsPath)}: ${detail}`);
					}
					return { exitCode: 1, results };
				}
			}

			let startFrom: Step;
			if (flags.from !== undefined) {
				startFrom = flags.from;
				console.log(`${A.bold("resume")} ${id} from ${A.bold(startFrom)} ${A.dim("(--from override)")}`);
			} else if (flags["review-findings"] !== undefined) {
				startFrom = "implement";
				console.log(`${A.bold("resume")} ${id} from ${A.bold(startFrom)} ${A.dim("(--review-findings)")}`);
			} else {
				startFrom = _detectResumeStep(id, worktree);
				console.log(`${A.bold("resume")} ${id} from ${A.bold(startFrom)}`);
			}

			// Revision-mode resumes (operator-revision, and a standard `--resume <id>
			// --review-findings <path>` — the advertised park continuation) execute in the
			// item's claim worktree, so the attempt holds the same per-item execution lease as
			// the sweep and the operator CLI (#507 round 3). Acquired before any worktree work,
			// released right after the attempt — never across a park sleep; the auto-resume
			// loop's `resumeOne` reacquires per attempt. Fail-soft: refuse naming the holder,
			// never proceed unleased.
			let releaseResumeLease: (() => Promise<void>) | undefined;
			if (flags["review-findings"] !== undefined || consumedReviewFindingsItems.has(id) || orchestratorMode === "operator-revision") {
				const leased = await acquireRevisionResumeLease(id);
				if (!leased.ok) {
					console.error(leased.refusal);
					return { exitCode: 1, results };
				}
				releaseResumeLease = leased.release;
			}

			const status: CycleStatus = { itemId: id, status: "running", cost: 0 };
			liveStatus.cycles.push(status);
			liveStatus.totalCycles = 1;
			if (v) statusBar.setup();

			let result: CycleResult;
			try {
				const unattendedEvidence = unattendedEvidenceFor(false);
				result = await _runPipeline(
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
						unattendedSignals: unattendedEvidence.signals,
						unattendedSignalSuppressions: unattendedEvidence.suppressed,
						...(decisionNotifier ? { notifyDecision: decisionNotifier } : {}),
						...(noWorktree ? { noWorktree: true } : {}),
						...(signal ? { signal } : {}),
					},
					parkSignal,
					flags,
					reviewFindingsLifecycleDeps,
				);
			} finally {
				await releaseResumeLease?.();
			}
			results.push(result);
			await notify(result, LOG_PATH);

			status.status = resultStatus(result);
			status.step = undefined;
			if (v) {
				liveStatus.render();
				statusBar.teardown();
			}
			const detail = resultDetail(result);
			console.log(`\n${result.completed ? A.green("✓") : A.red("✗")} ${id} — ${result.costEstimated ? "~" : ""}$${result.cost.toFixed(2)}${detail ? `  ${A.dim(detail)}` : ""}`);

			// Operator-revision park parity: stay inside this `--resume` branch. Never fall
			// out into pick, the revise sweep, or campaign-start drain. Ordinary `--resume`
			// (mode default `"standard"`) still returns after one attempt.
			if (orchestratorMode === "operator-revision" && parkSignal.parked) {
				// The advertised continuation is itself LEASED: a findings-driven resume carries
				// the flag; operator-revision mode keeps consumed later-step continuations leased.
				const printOperatorHandback = (): void => {
					// Re-evaluate after every resume round: implement may have consumed and archived
					// the canonical file before a later step parked again.
					const candidate = consumedReviewFindingsItems.has(id) ? undefined : (flags["review-findings"] ?? entryReviewFindingsPath);
					const canonicalPath = reviseFindingsPath(REPO, id);
					const findingsPath = candidate && (resolve(candidate) !== canonicalPath || existsSync(canonicalPath)) ? candidate : undefined;
					const hint = findingsPath ? `pnpm pelaggio --resume ${id} --review-findings ${findingsPath}` : formatResumeHint([id]);
					console.log(`  Parked: ${id}`);
					console.log(`  Resume: ${A.bold(hint)}`);
				};
				if (!autoResume) {
					console.log("");
					console.log(`${A.yellow("⏸")} ${parkSignal.limitType} limit hit — auto-resume disabled`);
					printOperatorHandback();
					return { exitCode: PARKED_EXIT_CODE, results };
				}
				let round = 0;
				while (parkSignal.parked && round < MAX_RESUME_ROUNDS) {
					round++;
					const outcome = await awaitParkReset(parkSignal, { maxWaitMs, itemsLabel: id });
					if (outcome === "handback") {
						printOperatorHandback();
						return { exitCode: PARKED_EXIT_CODE, results };
					}
					emitResumed();
					console.log(`\n${A.green("▶")} ${A.bold("Resuming")} ${id}...`);
					results.push(await resumeOne(id, 0));
				}
				if (parkSignal.parked) {
					console.log(`${A.yellow("⏸")} auto-resume round cap (${MAX_RESUME_ROUNDS}) reached — leaving remaining items parked`);
					printOperatorHandback();
					return { exitCode: PARKED_EXIT_CODE, results };
				}
			}

			// #387: a resumed cycle can ship a PR whose review-request record would
			// otherwise sit undrained until the next process. Drain before returning
			// so resume mode gets the same review-at-delivery as the worker pool.
			if (doReviewDrain && !parkSignal.parked) {
				await runPostCycleReviewDrain();
				// A drain park (rate limit) leaves the merge-gate review undrained; exiting
				// 0 would falsely report delivery-complete and bypass park handling.
				if (parkSignal.parked) {
					console.log(`${A.yellow("⚠")} post-resume review drain parked — review status still pending; re-run --resume ${id} after the limit clears`);
					return { exitCode: PARKED_EXIT_CODE, results };
				}
			}
			const last = results[results.length - 1];
			return { exitCode: parkSignal.parked || hasUnresolvedPark(results) ? PARKED_EXIT_CODE : last?.completed ? 0 : 1, results };
		}

		// Campaign-start drain: cold-start backlog + statusless PRs from prior runs (all modes incl.
		// `--item`). A rate-limit park during the gate is transient — under the same auto-resume /
		// --max-wait / reset-time policy as the item loop, wait and retry the drain in-process
		// (records + pending PRs stay eligible). A non-blocking drain lock avoids blocking startup on
		// a peer process's in-flight drain; contention skips the round (the peer covers the queue).
		// awaitParkReset runs OUTSIDE the lock so a park never holds the queue for the reset window.
		async function runCampaignStartDrain(): Promise<void> {
			let reviewRound = 0;
			while (reviewRound < MAX_RESUME_ROUNDS) {
				reviewRound++;
				const notifyStranded = reviewRound === 1;
				await tryWithFileLock(reviewDrainLock, () => runLocalReviewDrainOnce({ notifyStranded }), { label: "review drain lock", staleMs: REVIEW_DRAIN_LOCK_STALE_MS });
				if (!parkSignal.parked) break; // no rate-limit park this round → drain is done (or a peer holds the lock)
				if (!autoResume) break; // off-switch → leave pending, hand back (park block reports it)
				const outcome = await awaitParkReset(parkSignal, { maxWaitMs });
				if (outcome === "handback") break; // no reset / exceeds --max-wait → leave pending
				// resumed: parkSignal cleared → re-list records + candidates and retry.
			}
		}

		// The drain launches paid review agents, so it is gated on the *reconstructed* day spend
		// exactly like the in-loop drains. Without that, a restart reloading a ledger already at the
		// cap spends a second full day budget on review before the loop can stop it.
		//
		// Deferred, never skipped: this is the only drain that clears the cold-start backlog, so
		// dropping it strands pending and statusless PRs for the rest of the run. In watch mode the
		// budget rolls over at local midnight and the loop keeps going, so the drain is re-attempted
		// on the first iteration after the cap clears (#398 review). Drain mode exits when exhausted,
		// so there is no later chance and the deferral simply never fires.
		let campaignDrainDeferred = false;
		if (doReviewDrain && dayBudgetTracker.exceeded()) {
			campaignDrainDeferred = true;
			console.log(`${A.yellow("⚠")} day budget ($${continuous?.dayBudget?.toFixed(2)}) already exhausted (spent $${dayBudgetTracker.daySpent.toFixed(2)} today) — campaign-start review drain deferred until the budget rolls over`);
		} else if (doReviewDrain) {
			await runCampaignStartDrain();
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
		const doSweep = revise.local && shipIsPr && !!revise.ghRepo && !noWorktree && !dryRun && items.length === 0;

		async function runReviseSweepOnce(): Promise<void> {
			if (!doSweep) return;
			const { revisable, labeledStillRed } = findRevisablePrs(revise.gh, revise.ghRepo);
			// PRs already past their one revision pass but still red → idempotent human handoff.
			for (const pr of labeledStillRed) postParkComment(revise.gh, revise.ghRepo, pr.prNumber);

			for (const pr of revisable) {
				if (parkSignal.parked) break; // a park mid-sweep stops starting new revisions
				if (!isAutopilotManaged(revise.gh, revise.ghRepo, pr.itemId, ROADMAP_GITHUB.label)) continue;
				// Execution-scoped exclusion (#507 finding): hold the per-item lease for the WHOLE
				// revision so an operator `pelaggio revise --pr` — whose `--allow-repeat` bypasses
				// the one-pass label — can never run concurrently in the same claim worktree.
				// Contention or lock failure skips fail-soft, like every other sweep primitive.
				const exec = await revise.acquireExec(revise.execLeaseRoot, pr.itemId);
				if (exec.kind !== "acquired") continue;
				try {
					// Atomic one-pass claim BEFORE any work — cross-process with the operator
					// `pelaggio revise --pr` CLI (see claimRevisionExclusive); non-claimed skips
					// fail-soft. The claim-lock repo is `revise.claimRepo`, hermetically redirected
					// under node --test so the lock never lands in the HOST repo's `.dev/`.
					if ((await claimRevisionExclusive(revise.gh, revise.ghRepo, revise.claimRepo, pr.prNumber)) !== "claimed") continue;
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
							unattendedSignals: runUnattendedEvidence.signals,
							unattendedSignalSuppressions: runUnattendedEvidence.suppressed,
							...(decisionNotifier ? { notifyDecision: decisionNotifier } : {}),
							...(signal ? { signal } : {}),
						},
						parkSignal,
						{ ...flags, "review-findings": findingsPath }, // per-item findings injection
						reviewFindingsLifecycleDeps,
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
				} finally {
					await exec.lease.release();
				}
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

			// `park`/`autoResume`/`maxWaitMs`/`resumeOne` are hoisted above the review sweep
			// (shared with operator-revision and the review-retry loop). The park signal is
			// reset by `awaitParkReset` on a successful wait.

			let pending = results.filter((r) => r.error === "parked" && r.itemId).map((r) => r.itemId!);

			if (pending.length === 0) {
				// Reached when a rate-limit park has no parked *pipeline* item to resume — e.g. the local
				// review sweep parked and handed back (its pending PRs retry on the next run), or a manual
				// pause fired before any work started.
				console.log(`${A.yellow("⏸")} Rate limit hit but no items to resume (any pending local review retries on the next run).`);
				return { exitCode: receiptUndurable || campaignHalted ? 1 : PARKED_EXIT_CODE, results };
			}

			// Off-switch: auto-resume disabled → report parked items and hand the prompt back.
			if (!autoResume) {
				console.log("");
				console.log(`${A.yellow("⏸")} ${parkSignal.limitType} limit hit — auto-resume disabled`);
				console.log(`  Parked: ${pending.join(", ")}`);
				console.log(`  Resume: ${A.bold(formatResumeHint(pending))}`);
				return { exitCode: receiptUndurable || campaignHalted ? 1 : PARKED_EXIT_CODE, results };
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
				// #387: an auto-resumed cycle can ship a PR; drain its enqueued review
				// request like the worker-pool and explicit --resume paths do, or the
				// process can exit 0 with the required review status absent.
				if (doReviewDrain && !parkSignal.parked) await runPostCycleReviewDrain();
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

		// A review drain that parked left a required review status pending (#387):
		// completed cycles alone must not report delivery-complete over it.
		if (receiptUndurable) {
			console.log(`${A.yellow("⚠")} day-budget ledger became unwritable mid-run — spend after that point is not reconstructable; fix permissions before the next run`);
			return { exitCode: 1, results };
		}
		if (doReviewDrain && parkSignal.parked) {
			console.log(`${A.yellow("⚠")} review drain parked — one or more review statuses still pending; re-run after the limit clears`);
			return { exitCode: campaignHalted ? 1 : PARKED_EXIT_CODE, results };
		}
		if (!campaignHalted && (parkSignal.parked || hasUnresolvedPark(results))) return { exitCode: PARKED_EXIT_CODE, results };
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

	const writer = createEventWriter(eventWriterCorrelation());
	const lifecycle = startRunLifecycle({ flags, executionId: writer.executionId, heartbeatMs: RUN_HEARTBEAT_MS });
	try {
		const { exitCode } = await runOrchestrator(flags, { eventWriter: writer }, statusBar, controller.signal);
		lifecycle.finish(finishOutcome(exitCode));
		lifecycle.stop();
		process.exit(exitCode);
	} catch (error) {
		lifecycle.finish({ outcome: "failed", exitCode: 1 });
		lifecycle.stop();
		throw error;
	}
}
