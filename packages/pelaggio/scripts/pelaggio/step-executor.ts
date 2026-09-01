/**
 * The cycle's step executor (module-architecture follow-up): runs one provider step under the
 * confinement audit (forbidden-root snapshot/diff with the #369 session-eligibility exclusions
 * and the #388 mid-step prober), then the checkpoint gate, the effects manifest + dispatch with
 * its receipt, the plan-polish backstop, decision capture, and the step log. Moved verbatim
 * from `runPipeline`. The five bindings `pick` changes are read through `live` at step entry;
 * everything else is a plain value or an injected capability.
 */
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CONFIG, LOG_PATH, modelForProvider, ROADMAP_GITHUB, ROADMAP_SOURCE, resolveStepSettings } from "./config.js";
import type { diffForbiddenRootSnapshots as diffForbiddenRootSnapshotsDefault, snapshotForbiddenRoots as snapshotForbiddenRootsDefault } from "./confinement/roots.js";
import { createMainCheckoutDeltaObserver, forbiddenRootsForConfinement } from "./confinement/roots.js";
import type { resolveEligibleSessions as resolveEligibleSessionsDefault, revalidateChangedRoot as revalidateChangedRootDefault, SessionController, SessionEvaluatorContext } from "./confinement/sessions.js";
import { type AcceptedSession, firstDiffPathsByRoot } from "./confinement/sessions.js";
import { revertPlanPolish } from "./cycle-support.js";
import type { appendDecisions as appendDecisionsDefault } from "./decisions.js";
import type { dispatchStepEffects as dispatchStepEffectsDefault, writeEffectsManifest as writeEffectsManifestDefault } from "./effects.js";
import { type Effect, EffectsManifestError } from "./effects.js";
import type { readGitBinding as readGitBindingDefault } from "./git.js";
import { checkpoint, ensureCheckpointed, filesChangedSince, getHeadSha } from "./git.js";
import { isAuthoringReviewSeatPath } from "./review/seats.js";
import { isReviewHeadPath } from "./review-sweep.js";
import type { RoadmapSource } from "./roadmap/index.js";
import { extractPrUrl } from "./ship/pull-request.js";
import type { RunStepFn } from "./step-runner.js";
import type { StepRunOptions } from "./steps/context.js";
import { createStepRenderer } from "./tui.js";
import type { CycleGitBinding, ExecutionReceiptDescriptor, Flags, ParkSignal, PipelineOpts, ProviderName, Step, StepLog, StepResult } from "./types.js";

/** Cycle bindings that move after `pick`; read once per step at entry. */
export interface StepExecutorLive {
	readonly itemId: () => string | null;
	readonly worktree: () => string | null;
	readonly profile: () => string;
	readonly sessionController: () => SessionController | undefined;
	readonly gitBinding: () => CycleGitBinding;
	readonly setGitBinding: (binding: CycleGitBinding) => void;
}

export interface StepExecutorEnv {
	readonly opts: PipelineOpts;
	readonly flags: Flags;
	readonly parkSignal: ParkSignal;
	readonly mainRepo: string;
	readonly roadmap: RoadmapSource;
	/** Shared with the cycle: the executor appends the step log entry and any receipt. */
	readonly steps: StepLog[];
	readonly executionReceipts: ExecutionReceiptDescriptor[];
	readonly provenanceUnavailable: string[];
	readonly cycleChallenge: Buffer;
	/** Attempt-run id prefix (log-path stem or `cycle-<n>`). */
	readonly runIdBase: string;
	readonly allowDirtyMain: boolean;
	readonly confinementProbeIntervalMs: number;
	readonly sessionEvaluator: SessionEvaluatorContext;
	readonly runStep: RunStepFn;
	readonly listWorktrees: () => string[];
	readonly snapshotForbiddenRoots: typeof snapshotForbiddenRootsDefault;
	readonly diffForbiddenRootSnapshots: typeof diffForbiddenRootSnapshotsDefault;
	readonly revalidateChangedRoot: typeof revalidateChangedRootDefault;
	readonly resolveEligibleSessions: typeof resolveEligibleSessionsDefault;
	readonly writeEffectsManifest: typeof writeEffectsManifestDefault;
	readonly dispatchStepEffects: typeof dispatchStepEffectsDefault;
	readonly appendDecisions: typeof appendDecisionsDefault;
	readonly readGitBinding: typeof readGitBindingDefault;
	readonly log: (msg: string) => void;
	readonly itemRunId: () => string;
	readonly observeGitForReceipt: (cwd: string) => { worktree: string | null; headSha: string | null; branch: string | null };
	readonly live: StepExecutorLive;
}

export type StepExecutor = (name: Step, prompt: string, cwd: string, options?: StepRunOptions) => Promise<StepResult>;

function appendResultText(text: string, appendText: string): string {
	if (text.trim() === "") return appendText;
	return `${text}\n${appendText}`;
}

export function createStepExecutor(env: StepExecutorEnv): StepExecutor {
	const {
		opts,
		flags,
		parkSignal,
		mainRepo,
		roadmap,
		steps,
		executionReceipts,
		provenanceUnavailable,
		cycleChallenge,
		allowDirtyMain,
		confinementProbeIntervalMs,
		sessionEvaluator,
		runStep,
		listWorktrees,
		snapshotForbiddenRoots,
		diffForbiddenRootSnapshots,
		revalidateChangedRoot,
		resolveEligibleSessions,
		writeEffectsManifest,
		dispatchStepEffects,
		appendDecisions,
		readGitBinding,
		log,
		itemRunId,
		observeGitForReceipt,
		live,
		runIdBase,
	} = env;

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
		const excludedSessions = resolveEligibleSessions(sessionEvaluator);
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

	return async function step(
		name: Step,
		prompt: string,
		cwd: string,
		{ attempt = 1, commitLabel, effects, maxTurnsOverride, retriedMaxTurns = false, ownWorktree, executionOverride, parkSignalOverride, workspaceAccess, preCheckpointGate, shipGate }: StepRunOptions = {},
	): Promise<StepResult> {
		// The bindings pick changes are read once at entry: none of them move during a step.
		const itemId = live.itemId();
		const worktree = live.worktree();
		const profile = live.profile();
		const sessionController = live.sessionController();
		const settings = resolveStepSettings(CONFIG, profile, name);
		// Normalize into a realized driver identity for logging + effects attribution. An
		// `executionOverride` is already realized (its generic `model`/`codexModel` was projected
		// when the pooled candidate/seat was chosen), so read it as-is. A raw `StepSettings` —
		// a single-provider, non-pooled step (e.g. `providers.<step>: grok`) — must project its
		// provider-specific slot here, or a Grok/OpenCode step would record the top-level Claude id
		// and corrupt `findLoggedArtifactAuthor` recovery and cycle provenance (issue #431).
		const realized: { provider: ProviderName; model?: string; codexModel?: string } =
			executionOverride ?? (settings.provider === "codex" ? { provider: "codex", codexModel: modelForProvider(settings, "codex") } : { provider: settings.provider, model: modelForProvider(settings, settings.provider) });
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
			return { ok: false, subtype: "error_abort", text: "aborted", fullText: "", assistantText: "", cost: 0, turns: 0 };
		}

		if (opts.dryRun) {
			log(`[dry-run] ${name}: "${prompt.slice(0, 60)}" in ${cwd}`);
			steps.push(stepLog({ cost: 0, turns: 0, ok: true, ...(attempt > 1 ? { attempt } : {}) }));
			return { ok: true, subtype: "success", text: `[dry-run] ${name}`, fullText: "", assistantText: "", cost: 0, turns: 0 };
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
				forbiddenBefore = snapshotForbiddenRoots(forbiddenRoots);
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
				for (const root of diffForbiddenRootSnapshots(before, after)) {
					const abs = resolve(root);
					if (abs === resolve(mainRepo)) {
						violated.push(root);
						continue;
					}
					const stillLive = revalidateChangedRoot(sessionEvaluator, abs);
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
			// #424 gate fix (pre-flight seat confinement): grant the claim worktree as an
			// own-worktree write exemption only when the step actually RUNS in it (where the
			// grant is redundant with blockForeignRootWrite's cwd allow) or a caller passed it
			// explicitly (shipwreck from main cwd). A detached review-seat step (cwd under
			// `.dev/authoring-review-seats/` or `.dev/review-heads/`) must NOT inherit Write/Edit
			// authority over the live claim worktree — reviewer seats are read-only against
			// data-only checkouts; the author-revision seats keep their write path because their
			// cwd IS the claim worktree.
			const cwdIsClaimWorktree = !!worktree && worktree !== mainRepo && resolve(cwd) === resolve(worktree);
			const foreignRootDenial = {
				mainRepo,
				registeredWorktrees,
				...(ownWorktree ? { ownWorktree } : cwdIsClaimWorktree && worktree ? { ownWorktree: worktree } : {}),
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
				providerResult = { ok: false, subtype: "error_confinement", text: confinementAuditError, fullText: "", assistantText: "", cost: 0, turns: 0 };
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
							const probeSnapshot = snapshotForbiddenRoots(forbiddenRoots);
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

				// The probe loop is retired in a finally: a rejecting runStep must not leave
				// it re-arming its delay timer forever (the process would never exit).
				try {
					providerResult = await runStep(
						name,
						prompt,
						{
							cwd,
							profile,
							trace: flags.trace,
							itemId: itemId ?? undefined,
							parkSignal: parkSignalOverride ?? parkSignal,
							...(workspaceAccess ? { workspaceAccess } : {}),
							...(executionOverride ? { executionOverride } : {}),
							...(maxTurnsOverride !== undefined ? { maxTurnsOverride } : {}),
							signal: stepAbort.signal,
							...(mainCheckoutObserver ? { mainCheckoutObserver } : {}),
							foreignRootDenial,
							...(onChildSpawn ? { onChildSpawn } : {}),
						},
						emit,
					);
				} finally {
					midStepSettled = true;
					settledController.abort();
					await probeLoop;
				}
			}

			if (confinementRoots.length === 0 && confinementAuditError === undefined) {
				try {
					forbiddenAfter = snapshotForbiddenRoots(forbiddenRoots);
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
			// Pipeline-owned diagnosis: replace the provider's text/outputTail so finish()
			// detail and JSONL recent-failures show the confinement cause, not a stale
			// provider success/review tail. Preserve assistantText/fullText — those are
			// model-authored accumulators and must not take harness diagnostics. outputTail
			// takes the *first* 200 chars (diagnosis leads with phase/root; provider tails
			// care about the end).
			if (confinementAuditError !== undefined) {
				result = {
					...providerResult,
					ok: false,
					subtype: "error_confinement",
					text: confinementAuditError,
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
					outputTail: text.slice(0, 200),
				};
			} else if (revalidationWarnings.length > 0) {
				// No violation retained — warnings already logged. Leave provider result as-is.
			}
		}

		if (commitLabel && result.subtype !== "error_confinement") {
			const preCommitGate = preCheckpointGate?.();
			if (preCommitGate && !preCommitGate.ok) {
				// #424 review: leave the tree exactly as the author left it — no `git add -A`,
				// no commit — so conflict markers / unmerged paths stay observable and are
				// never concluded into a clean, ancestor-containing merge commit.
				log(`⚠ checkpoint skipped (${commitLabel}): ${preCommitGate.detail}`);
			} else {
				const committed = checkpoint(cwd, commitLabel);
				log(committed ? `${commitLabel} committed` : `no changes to commit (${commitLabel})`);
				ensureCheckpointed(cwd, commitLabel, log);
			}
		}
		// Captured when effects dispatch succeeds so the step log can record the receipt.
		let stepExecutionReceipt: ExecutionReceiptDescriptor | undefined;
		if (effects && result.subtype !== "error_confinement") {
			const staticEffects = Array.isArray(effects) ? effects : [];
			const checkpointEffect = staticEffects.find((effect): effect is Extract<Effect, { kind: "checkpoint" }> => effect.kind === "checkpoint");
			if (result.ok && !parkSignal.parked && !opts.dryRun) {
				const ctx = {
					runId: itemRunId(),
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
								...(shipGate ? { shipGate } : {}),
							});
							if (effectsResult.appendText) {
								result = {
									...result,
									text: appendResultText(result.text, effectsResult.appendText),
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
					// Dedupe is fork identity within the item authority (decisions.ts): a
					// re-emission of the same normalized (fork, chosen) — from a later step,
					// a resumed attempt, or with reworded alternatives — collapses into the
					// existing row. runId/step/occurrence are recorded provenance, not the key.
					runId: itemRunId(),
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
				live.setGitBinding(readGitBinding(worktree, mainRepo, live.gitBinding()));
			} catch {
				// Provenance is observational and must never change the step outcome.
				provenanceUnavailable.push("git");
			}
		}
		if (opts.workerStatus) opts.workerStatus.cost += result.cost;
		return result;
	};
}
