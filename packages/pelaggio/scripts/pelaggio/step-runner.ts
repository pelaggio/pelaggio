import { type ChildProcess, spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HookInput, HookJSONOutput, SDKAssistantMessage, SDKRateLimitEvent, SDKResultMessage, SDKSystemMessage, SpawnedProcess, SpawnOptions, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { codexProvider } from "./codex-provider.js";
import { CONFIG, REPO, resolveStepSettings } from "./config.js";
import { sessionsDir } from "./confinement/sessions.js";
import { grokProvider } from "./grok-provider.js";
import { classifyStepError, isRefusal, looksLikeStalledAsk, type MainCheckoutDeltaObserver, parseBlockedReason, parseDecisions, parseWaitFlag, resolveParkReset } from "./helpers.js";
import { opencodeProvider } from "./opencode-provider.js";
import { composeSystemAppend, EDIT_LOOP_EXEMPT_STEPS, EDIT_LOOP_THRESHOLD, isWorktreePath } from "./step-runner-shared.js";
import { MUTATING_TOOLS, toolBrief } from "./tui.js";
import type { ParkSignal, ProviderCapabilities, ProviderName, Step, StepEmit, StepResult, TokenUsage } from "./types.js";
import { ensureWorktreeDeps } from "./worktree-deps.js";

export { composeSystemAppend, isWorktreePath } from "./step-runner-shared.js";

// ── Step runner ────────────────────────────────────────────────────────

export interface ForeignRootDenial {
	mainRepo: string;
	/** Known Git worktree roots (main + siblings); foreign roots are denied. */
	registeredWorktrees: readonly string[];
	/** Explicit own item worktree (e.g. shipwreck from main cwd). */
	ownWorktree?: string;
}

export interface RunStepOpts {
	cwd: string;
	profile: string;
	trace: boolean;
	itemId?: string;
	parkSignal: ParkSignal;
	/** Per-call override for the step's `maxTurns`. Used by `implement` to size the
	 * budget from the plan's file count (see `computeImplementTurns` in helpers.ts).
	 * When undefined, falls back to the profile-resolved turn limit. */
	maxTurnsOverride?: number;
	/** Cancellation signal — sourced from SIGINT and/or a mid-step confinement trip
	 * (#388; the pipeline always threads its own per-step `AbortController` here, composed
	 * with any external SIGINT signal). Threaded through to the SDK's `query()` call so an
	 * in-flight fetch stream tears down when the controller aborts. */
	signal?: AbortSignal;
	/** Brackets mutating provider tools for dirty-main delta attribution. */
	mainCheckoutObserver?: MainCheckoutDeltaObserver;
	/** Select a provider/model for this invocation without changing profile configuration. */
	executionOverride?: { provider: ProviderName; model?: string; codexModel?: string };
	/**
	 * #369: register the Claude SDK child PID once spawned so the session record
	 * can bind Linux /proc evidence to the worktree-resident child. Invoked from
	 * a custom `spawnClaudeCodeProcess` adapter; pid is captured from ChildProcess
	 * (SpawnedProcess does not declare pid).
	 */
	onChildSpawn?: (info: { pid: number; cwd: string }) => void;
	/**
	 * #369: deny Write/Edit into main and every registered foreign worktree root.
	 * When present, hooks install even for main-cwd steps (shipwreck) so foreign-root
	 * + `.dev/sessions/` denial actually run.
	 */
	foreignRootDenial?: ForeignRootDenial;
}

/** Canonical signature of a step runner. Single-sourced here (all four types are in
 *  scope) and re-exported from `pipeline.ts`, so `mocks.ts`'s `RunStepFn` import and
 *  the `deps.runStep` DI seam resolve to one definition. */
export type RunStepFn = (name: Step, prompt: string, opts: RunStepOpts, emit: StepEmit) => Promise<StepResult>;

/** A step-execution backend. Every registered provider declares a complete static
 *  capability descriptor beside `runStep` (ADR-0020 / #337). The exported `runStep`
 *  dispatches by the per-step resolved `provider` and gains no adaptation registry. */
export interface StepProvider {
	name: ProviderName;
	/** Data-only native capability row. Orthogonal predicates; never ranked by strength. */
	capabilities: ProviderCapabilities;
	runStep: RunStepFn;
}

/** Claude: native semantic deny via PreToolUse hooks; billed USD; cache counters; stream events. */
export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
	semanticDeny: true,
	isolation: [],
	costMeter: { kind: "usd-billed" },
	cacheReporting: true,
	outputTransport: "stream",
	sessionResume: false,
};

// Worktree-side install guard: the worktree shares MAIN_REPO's `node_modules`
// via symlink, so any in-worktree `pnpm install` (or equivalent) re-points the
// shared symlinks into the worktree's `.pnpm` store and corrupts main once the
// worktree is removed. The escape hatch is the explicit `worktree-deps
// --repair-main` invocation, which restores the layout from the lockfile.
const INSTALL_PATTERN = /\b(pnpm\s+(install|i|add|update|up|upgrade|remove|rm)|npm\s+(install|i|ci))\b/;

export function blockWorktreeInstall(input: HookInput): SyncHookJSONOutput {
	const tn = "tool_name" in input ? String(input.tool_name) : "";
	if (tn !== "Bash") return {};
	const ti = ("tool_input" in input ? input.tool_input : {}) as Record<string, unknown>;
	const cmd = String(ti.command ?? "");
	if (!cmd) return {};
	if (cmd.includes("worktree-deps") && cmd.includes("--repair-main")) return {};
	if (!INSTALL_PATTERN.test(cmd)) return {};
	return {
		decision: "block" as const,
		reason:
			"Worktree-side `pnpm install` (or equivalent) is blocked: this worktree shares MAIN_REPO's `node_modules` via symlink, and a worktree-side install re-points the symlinks into the worktree's `.pnpm` store, which corrupts the main repo when the worktree is removed. If you genuinely need a dep change, raise it in your final message — dep updates are managed via Renovate / patch-bump cadence, not in-cycle.",
	};
}

// Plan-polish guard: during `implement`, block writes to docs/plans/ so the model
// executes the plan instead of editing it. Surfaced as a named helper because the
// reason — not the mechanics — is the non-obvious part worth locating.
export function blockPlanPolish(input: HookInput, cwd: string): SyncHookJSONOutput {
	const tn = "tool_name" in input ? String(input.tool_name) : "";
	if (tn !== "Write" && tn !== "Edit") return {};
	const ti = ("tool_input" in input ? input.tool_input : {}) as Record<string, unknown>;
	const fp = String(ti.file_path ?? "");
	if (!fp) return {};
	const abs = fp.startsWith("/") ? fp : resolve(cwd, fp);
	if (!/\/docs\/plans\//.test(abs)) return {};
	return {
		decision: "block" as const,
		reason: `"${fp}" is under docs/plans/, which is READ-ONLY during implement. Execute the plan by writing code to other files — do not edit the plan itself. If the plan is genuinely wrong, stop and report the issue instead of editing around it.`,
	};
}

function pathUnderRoot(abs: string, root: string): boolean {
	const a = resolve(abs);
	const r = resolve(root);
	return a === r || a.startsWith(`${r}/`);
}

/**
 * #369: Block Write/Edit into main and every known foreign Git worktree root,
 * while allowing the step cwd and an explicitly threaded own item worktree.
 * Nested authoring-review seats under `MAIN_REPO/.dev/authoring-review-seats/`
 * remain allowed as cwd (#269). Separately denies Write/Edit into
 * `MAIN_REPO/.dev/sessions/` so agents cannot forge session evidence.
 * Bash is not covered — residual matches the prior main-repo string guard only.
 */
export function blockForeignRootWrite(input: HookInput, cwd: string, mainRepo: string, registeredWorktrees: readonly string[], ownWorktree?: string): SyncHookJSONOutput {
	const tn = "tool_name" in input ? String(input.tool_name) : "";
	if (tn !== "Write" && tn !== "Edit") return {};
	const ti = ("tool_input" in input ? input.tool_input : {}) as Record<string, unknown>;
	const fp = String(ti.file_path ?? "");
	if (!fp) return {};
	const cwdAbs = resolve(cwd);
	const mainAbs = resolve(mainRepo);
	const abs = fp.startsWith("/") ? resolve(fp) : resolve(cwdAbs, fp);

	// Sessions-dir denial is absolute — even when cwd/own would otherwise allow.
	const sessionsAbs = sessionsDir(mainAbs);
	if (pathUnderRoot(abs, sessionsAbs)) {
		return {
			decision: "block" as const,
			reason: `Path "${fp}" targets the session-record directory (${sessionsAbs}), which is harness-owned evidence. Do not write session records from agent tools.`,
		};
	}

	// Always allow writes inside the step cwd (sibling worktree or nested seat).
	if (pathUnderRoot(abs, cwdAbs)) return {};
	// Explicit own item worktree (shipwreck from main cwd).
	if (ownWorktree && pathUnderRoot(abs, ownWorktree)) return {};

	const foreignRoots = new Set<string>();
	foreignRoots.add(mainAbs);
	for (const wt of registeredWorktrees) foreignRoots.add(resolve(wt));
	if (ownWorktree) foreignRoots.delete(resolve(ownWorktree));
	foreignRoots.delete(cwdAbs);

	for (const root of foreignRoots) {
		if (pathUnderRoot(abs, root)) {
			const ownHint = ownWorktree ? resolve(ownWorktree) : cwdAbs;
			const rel = abs.slice(root.length + (abs === root ? 0 : 1));
			const safe = resolve(ownHint, rel);
			const label = root === mainAbs ? "main repo" : `foreign worktree ${root}`;
			return {
				decision: "block" as const,
				reason: `Path "${fp}" targets ${label}. Use "${safe}" (own worktree) instead.`,
			};
		}
	}
	return {};
}

export function beginMainCheckoutAttribution(input: HookInput, toolUseId: string | undefined, observer?: MainCheckoutDeltaObserver): SyncHookJSONOutput {
	const toolName = "tool_name" in input ? String(input.tool_name) : "";
	if (!observer || !MUTATING_TOOLS.has(toolName)) return {};
	const outcome = observer.beforeTool(toolUseId ?? "");
	return outcome.kind === "error" ? { decision: "block" as const, reason: `Confinement attribution failed: ${outcome.message}` } : {};
}

export function endMainCheckoutAttribution(input: HookInput, toolUseId: string | undefined, observer?: MainCheckoutDeltaObserver): HookJSONOutput {
	const toolName = "tool_name" in input ? String(input.tool_name) : "";
	if (observer && MUTATING_TOOLS.has(toolName)) observer.afterTool(toolUseId ?? "");
	return {};
}

// The Claude SDK-driven runner — the original `runStep` body, verbatim, rebound as a
// named const so it can be registered as the `"claude"` provider. The exported
// `runStep` below is now the dispatcher; this is what it calls for the default provider.
const claudeRunStep: RunStepFn = async (name, prompt, opts, emit) => {
	const resolved = resolveStepSettings(CONFIG, opts.profile, name);
	const { budget, turns: baseTurns, effort } = resolved;
	const model = opts.executionOverride?.model ?? resolved.model;
	const turns = opts.maxTurnsOverride ?? baseTurns;

	const modelLabel = model ? model.replace("claude-", "") : "default";
	emit({
		type: "step_header",
		name,
		model: modelLabel,
		budget,
		maxTurns: turns,
		prompt: opts.trace ? prompt : undefined,
	});

	const t0 = Date.now();

	// Worktree guardrail: block mutating tools that target the main repo
	const isWorktree = isWorktreePath(opts.cwd, REPO);

	// Mid-cycle drift guard: re-evaluate the shared-node_modules decision
	// before each worktree-cwd step. If the branch bumped pnpm-lock.yaml,
	// the stale symlink is replaced by a real install before verification
	// commands (pnpm test, pnpm check) run downstream.
	if (isWorktree) {
		try {
			const report = ensureWorktreeDeps(opts.cwd, REPO);
			if (report.root.type === "restore") {
				emit({
					type: "sdk_error",
					message: "worktree node_modules was a real directory with .pnpm/ — restored symlink to MAIN_REPO (lockfiles match; recovered from worktree-side pnpm install)",
				});
			}
			for (const { pkg, action } of report.subpackages) {
				if (action.type === "restore") {
					emit({
						type: "sdk_error",
						message: `worktree ${pkg}/node_modules was a real directory — restored symlink to MAIN_REPO (coupled to root restore; lockfiles match)`,
					});
				}
			}
			// TOOL-52 corruption signature: noop + real-dir worktree-nm + a *real*
			// `.pnpm/` directory inside (lstat — not existsSync, since after a
			// materialize `.pnpm` is a symlink to MAIN's store and existsSync would
			// follow it, producing a spurious warning every step).
			// `restore` already covers the lockfiles-match case; this branch warns when
			// lockfile drift prevents safe restoration and ship-time repair is the
			// remaining safety net.
			if (report.root.type === "noop") {
				const wtNm = resolve(opts.cwd, "node_modules");
				try {
					const s = lstatSync(wtNm);
					if (s.isDirectory() && !s.isSymbolicLink()) {
						let pnpmIsRealDir = false;
						try {
							const ps = lstatSync(join(wtNm, ".pnpm"));
							pnpmIsRealDir = ps.isDirectory() && !ps.isSymbolicLink();
						} catch {}
						if (pnpmIsRealDir) {
							emit({
								type: "sdk_error",
								message: "worktree node_modules became a real directory mid-cycle (pnpm install re-installed locally) and lockfile drift prevents safe restore; main repo will be repaired at ship time",
							});
						}
					}
				} catch {}
			}
		} catch (err) {
			emit({ type: "sdk_error", message: `worktree-deps guard failed: ${err instanceof Error ? err.message : String(err)}` });
		}
	}

	const planBlockActive = name === "implement";
	const systemAppend = composeSystemAppend({ isWorktree, cwd: opts.cwd, repo: REPO, planBlockActive });

	const mainAbs = resolve(REPO) + "/";
	const worktreeCwd = resolve(opts.cwd);
	const foreignDenial = opts.foreignRootDenial;
	// #369: install hooks for main-cwd steps that supply foreign-root denial (shipwreck)
	// or sessions-dir protection — not only when isWorktree.
	const installHooks = isWorktree || planBlockActive || !!opts.mainCheckoutObserver || !!foreignDenial;
	const closeAttributedTool = async (input: HookInput, toolUseId: string | undefined): Promise<HookJSONOutput> => {
		return endMainCheckoutAttribution(input, toolUseId, opts.mainCheckoutObserver);
	};
	const hooks = installHooks
		? {
				PreToolUse: [
					{
						hooks: [
							async (input: HookInput, toolUseId: string | undefined): Promise<HookJSONOutput> => {
								const tn = "tool_name" in input ? String(input.tool_name) : "";
								const ti = ("tool_input" in input ? input.tool_input : {}) as Record<string, unknown>;

								if (foreignDenial) {
									const foreignOut = blockForeignRootWrite(input, worktreeCwd, foreignDenial.mainRepo, foreignDenial.registeredWorktrees, foreignDenial.ownWorktree);
									if (foreignOut.decision === "block") return foreignOut;
								} else if (isWorktree) {
									// Fallback when pipeline did not thread foreignRootDenial (tests /
									// direct callers): still protect main via the generalized helper.
									const foreignOut = blockForeignRootWrite(input, worktreeCwd, REPO, [REPO], worktreeCwd);
									if (foreignOut.decision === "block") return foreignOut;
								}

								if (isWorktree && tn === "Bash") {
									const installOut = blockWorktreeInstall(input);
									if (installOut.decision === "block") return installOut;

									const cmd = String(ti.command ?? "");
									if (cmd.includes(mainAbs) && !cmd.includes(worktreeCwd)) {
										return {
											decision: "block" as const,
											reason: `Command references main repo "${REPO}". Use worktree "${opts.cwd}" paths instead.`,
										};
									}
								}

								if (planBlockActive) {
									const out = blockPlanPolish(input, worktreeCwd);
									if (out.decision === "block") return out;
								}

								const attribution = beginMainCheckoutAttribution(input, toolUseId, opts.mainCheckoutObserver);
								if (attribution.decision === "block") return attribution;

								return {};
							},
						],
					},
				],
				PostToolUse: [{ hooks: [closeAttributedTool] }],
				PostToolUseFailure: [{ hooks: [closeAttributedTool] }],
			}
		: undefined;

	// Adapt the parent AbortSignal into a child controller for the SDK: `query()`
	// wants an AbortController, but the public type chain carries a signal so
	// downstream callers don't gain `.abort()` authority. The listener is removed
	// explicitly on happy-path completion — `{ once: true }` alone only covers the
	// fired case, leaving a closure leak across N steps when abort never fires.
	const sdkCtrl = new AbortController();
	let onParentAbort: (() => void) | undefined;
	if (opts.signal) {
		if (opts.signal.aborted) sdkCtrl.abort();
		else {
			onParentAbort = () => sdkCtrl.abort();
			opts.signal.addEventListener("abort", onParentAbort, { once: true });
		}
	}

	// #369: observe the Claude SDK child PID via the documented custom-spawn seam.
	// SpawnedProcess does not declare `pid` — capture it from the local ChildProcess
	// before returning. Pass the SDK's forwarded `signal` so force-kill stays after
	// the stdin-EOF + grace window.
	const spawnClaudeCodeProcess = opts.onChildSpawn
		? (spawnOpts: SpawnOptions): SpawnedProcess => {
				const child: ChildProcess = spawn(spawnOpts.command, spawnOpts.args, {
					cwd: spawnOpts.cwd,
					env: spawnOpts.env as NodeJS.ProcessEnv,
					stdio: ["pipe", "pipe", "pipe"],
					signal: spawnOpts.signal,
				});
				const pid = child.pid;
				if (typeof pid === "number" && pid > 0) {
					opts.onChildSpawn?.({ pid, cwd: spawnOpts.cwd ?? opts.cwd });
				}
				// ChildProcess already satisfies SpawnedProcess (stdin/stdout/killed/exitCode/kill/on/once/off).
				return child as unknown as SpawnedProcess;
			}
		: undefined;

	const gen = query({
		prompt,
		options: {
			cwd: opts.cwd,
			// canUseTool allow-all instead of `permissionMode: "bypassPermissions"`: the SDK
			// hardcodes a deny for writes to `.claude/skills/*` that survives bypassPermissions
			// and allowDangerouslySkipPermissions. canUseTool is the only knob that reaches
			// past it (TOOL-27). Hooks still fire — PreToolUse is evaluated after the allow.
			canUseTool: async (_tool, input) => ({ behavior: "allow" as const, updatedInput: input }),
			maxBudgetUsd: budget,
			maxTurns: turns,
			effort,
			abortController: sdkCtrl,
			...(model ? { model } : {}),
			systemPrompt: {
				type: "preset" as const,
				preset: "claude_code" as const,
				append: systemAppend,
			},
			...(hooks ? { hooks } : {}),
			...(spawnClaudeCodeProcess ? { spawnClaudeCodeProcess } : {}),
		},
	});

	let text = "";
	let fullText = "";
	let assistantText = "";
	let cost = 0;
	let resultTurns = 0;
	let ok = true;
	let subtype = "unknown";
	let stalledAsk = false;
	// True only when a rate-limit event drove the park — gates the #68 estimate so a manual
	// pause (SIGUSR2), which mutates the same parkSignal to resetsAt=0, still hands back.
	let rateLimitPark = false;
	let lastToolName = "";
	let tokens: TokenUsage | undefined;

	// Edit loop detection
	const editCounts = new Map<string, number>();
	const toolCounts = new Map<string, number>();
	let loopFile: string | null = null;

	try {
		for await (const msg of gen) {
			// System events
			if (msg.type === "system") {
				const sys = msg as SDKSystemMessage;
				if (sys.subtype === "init") {
					emit({ type: "init", model: sys.model, toolCount: sys.tools?.length ?? 0 });
				}
				if ((msg as { subtype: string }).subtype === "compact_boundary") {
					emit({ type: "compact" });
				}
			}

			// Rate limit events
			if (msg.type === "rate_limit_event") {
				const rle = msg as SDKRateLimitEvent;
				const info = rle.rate_limit_info;
				const overageAvailable = info?.overageStatus === "allowed" || info?.overageStatus === "allowed_warning";
				if (info?.status === "rejected" && !opts.parkSignal.parked && !overageAvailable) {
					// Record the reset faithfully; the estimate for a missing reset is a last resort
					// applied in the backfill below (#68), after the text-parse recovery gets a shot.
					opts.parkSignal.parked = true;
					opts.parkSignal.resetsAt = info.resetsAt ?? 0;
					opts.parkSignal.limitType = info.rateLimitType ?? "unknown";
					opts.parkSignal.triggerWorker = opts.itemId ?? "";
					rateLimitPark = true;
					emit({ type: "rate_limit", limitType: opts.parkSignal.limitType, resetsAt: opts.parkSignal.resetsAt });
				} else if (info?.status === "rejected" && overageAvailable) {
					emit({ type: "rate_limit", limitType: `${info.rateLimitType ?? "unknown"} (continuing on extra usage)`, resetsAt: 0 });
				}
			}

			// Assistant turns
			if (msg.type === "assistant") {
				const assistant = msg as SDKAssistantMessage;
				emit({ type: "turn" });
				const content = assistant.message?.content ?? [];
				for (const block of content) {
					if (block.type === "text" && "text" in block) {
						const blockText = (block as { text: string }).text;
						fullText += blockText + "\n";
						assistantText += blockText + "\n";
						if (blockText.trim()) {
							emit({ type: "text", content: blockText });
						}
					}
					if (block.type === "tool_use" && "name" in block) {
						const toolName = (block as { name: string }).name;
						const input = (block as { input: Record<string, unknown> }).input;
						if (input.command) fullText += String(input.command) + "\n";
						if (input.description) fullText += String(input.description) + "\n";
						const brief = toolBrief(toolName, input);
						const mutating = MUTATING_TOOLS.has(toolName);

						toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);

						// Track edits per file (skipped for plan-editing steps)
						if (toolName === "Edit" && input.file_path && !EDIT_LOOP_EXEMPT_STEPS.has(name)) {
							const fp = String(input.file_path);
							const count = (editCounts.get(fp) ?? 0) + 1;
							editCounts.set(fp, count);
							if (count >= EDIT_LOOP_THRESHOLD) {
								loopFile = fp;
								emit({ type: "edit_loop", file: fp, count });
								break;
							}
						}

						emit({ type: "tool_use", name: toolName, brief, mutating });
						lastToolName = toolName;
					}
				}
				if (loopFile) break;
			}

			// User messages (tool results with errors)
			if (msg.type === "user") {
				const u = msg as { isSynthetic?: boolean; message?: { content?: Array<{ type: string; is_error?: boolean; content?: unknown }> } };
				if (u.isSynthetic) {
					for (const block of u.message?.content ?? []) {
						if (block.type === "tool_result" && block.is_error) {
							const body = Array.isArray(block.content) ? (block.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("") : String(block.content ?? "");
							emit({ type: "tool_error", name: lastToolName, brief: "", error: body });
						}
					}
				}
			}

			// Final result
			if (msg.type === "result") {
				const r = msg as SDKResultMessage;
				text = "result" in r ? String(r.result) : "";
				cost = r.total_cost_usd ?? 0;
				resultTurns = r.num_turns ?? 0;
				subtype = r.subtype ?? "unknown";
				ok = subtype === "success";
				// A safety-classifier decline arrives as subtype:"success" with
				// stop_reason:"refusal" (or, rarely, refusal-shaped text and no
				// stop_reason). Downgrade to a terminal error_refusal so the pipeline
				// neither ships it as done nor parks it as a rate limit.
				if (ok && isRefusal(r.stop_reason, text)) {
					ok = false;
					subtype = "error_refusal";
					emit({ type: "sdk_error", message: "model refused / declined the task" });
				}
				// `usage` is NonNullableUsage: token counts are numbers, but
				// `cache_creation` is an object (BetaCacheCreation) — read only the
				// numeric per-category token fields, never the object.
				const u: SDKResultMessage["usage"] | undefined = r.usage;
				if (u) {
					tokens = {
						input: u.input_tokens ?? 0,
						output: u.output_tokens ?? 0,
						cacheCreation: u.cache_creation_input_tokens ?? 0,
						cacheRead: u.cache_read_input_tokens ?? 0,
					};
				}
			}
		}
	} catch (err) {
		ok = false;
		const errMsg = err instanceof Error ? err.message : String(err);
		subtype = classifyStepError(errMsg, opts.parkSignal.parked);
		text = errMsg;
		emit({ type: "sdk_error", message: errMsg });
	}

	// Edit loop override
	if (loopFile) {
		ok = false;
		subtype = "edit_loop";
		text = `Edit loop detected: ${loopFile} edited ${editCounts.get(loopFile)} times`;
	}

	// Structured stall contract (AUTONOMY_APPEND): a step that self-reports it can't
	// finish ends with a trailing `BLOCKED: <reason>` line. The SDK reports this as
	// subtype:"success", so reclassify out-of-band — but only when the step otherwise
	// succeeded (edit-loop / refusal / errors already own `ok` + `subtype`).
	if (ok) {
		const blockedReason = parseBlockedReason(text);
		if (blockedReason) {
			ok = false;
			subtype = "blocked";
			text = blockedReason;
			emit({ type: "blocked", reason: blockedReason });
		} else if (looksLikeStalledAsk(text)) {
			stalledAsk = true;
			emit({ type: "stalled_ask", tail: text.replace(/\s+$/, "").slice(-160) });
		}
	}

	// Resolve the park reset by precedence: event reset > reset parsed from text > conservative
	// estimate for a rate-limit park with no reset anywhere (#68). See resolveParkReset.
	if (opts.parkSignal.parked) {
		const resolved = resolveParkReset(opts.parkSignal.resetsAt, rateLimitPark, opts.parkSignal.limitType, text, Date.now(), parseWaitFlag(CONFIG.park.unknownResetWait));
		opts.parkSignal.resetsAt = resolved.resetsAt;
		opts.parkSignal.limitType = resolved.limitType;
	}

	if (onParentAbort) opts.signal?.removeEventListener("abort", onParentAbort);

	const decisions = parseDecisions(assistantText);
	for (const decision of decisions) emit({ type: "decision", decision });
	const elapsed = Date.now() - t0;
	emit({ type: "done", ok, subtype, cost, turns: resultTurns, elapsed });

	const outputTail = text ? text.replace(/\x1b\[[0-9;]*m/g, "").slice(-200) : undefined;
	const toolCountsObj = toolCounts.size > 0 ? Object.fromEntries(toolCounts) : undefined;

	return {
		ok,
		subtype,
		text,
		fullText,
		assistantText,
		cost,
		turns: resultTurns,
		...(tokens ? { tokens } : {}),
		...(toolCountsObj ? { toolCounts: toolCountsObj } : {}),
		...(outputTail ? { outputTail } : {}),
		...(stalledAsk ? { stalledAsk: true } : {}),
		...(decisions.length ? { decisions } : {}),
	};
};

// ── Provider registry ──────────────────────────────────────────────────

/** The default provider — the Claude SDK runner above. Exported so the registry
 *  unit test can assert `getProvider("claude") === claudeProvider`. */
export const claudeProvider: StepProvider = { name: "claude", capabilities: CLAUDE_CAPABILITIES, runStep: claudeRunStep };

// Keyed by `ProviderName` so the map is exhaustive over the union — #80's widening
// surfaces a compile error here until it registers the new provider.
const PROVIDERS: Record<ProviderName, StepProvider> = {
	claude: claudeProvider,
	codex: codexProvider,
	grok: grokProvider,
	opencode: opencodeProvider,
};

export const REGISTERED_PROVIDERS: readonly ProviderName[] = Object.freeze(Object.keys(PROVIDERS) as ProviderName[]);

/** Look up a registered provider. Throws on an unknown name — defense-in-depth for
 *  #80 (a misconfigured provider fails loudly rather than silently defaulting). */
export function getProvider(name: ProviderName): StepProvider {
	const provider = PROVIDERS[name];
	if (!provider) throw new Error(`unknown step provider: ${name}`);
	return provider;
}

/**
 * The exported step runner is a thin dispatcher: it resolves the per-step
 * `provider` and delegates to that provider's `runStep`. Keeping the exported name
 * `runStep` means both importers — `pipeline.ts` (the `deps.runStep` DI default) and
 * `pr-review-cli.ts` — route through the dispatcher with no import edits. The
 * provider's runner re-resolves `resolveStepSettings` for budget/turns/effort/model;
 * `resolveStepSettings` is pure and cheap, so the double call keeps the runner body
 * byte-identical at no real cost.
 */
export const runStep: RunStepFn = (name, prompt, opts, emit) => getProvider(opts.executionOverride?.provider ?? resolveStepSettings(CONFIG, opts.profile, name).provider).runStep(name, prompt, opts, emit);
