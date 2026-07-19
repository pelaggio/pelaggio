import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HookInput, HookJSONOutput, SDKAssistantMessage, SDKRateLimitEvent, SDKResultMessage, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { codexProvider } from "./codex-provider.js";
import { CONFIG, REPO, resolveStepSettings } from "./config.js";
import { grokProvider } from "./grok-provider.js";
import { classifyStepError, isRefusal, looksLikeStalledAsk, type MainCheckoutDeltaObserver, parseBlockedReason, parseWaitFlag, resolveParkReset } from "./helpers.js";
import { composeSystemAppend, EDIT_LOOP_EXEMPT_STEPS, EDIT_LOOP_THRESHOLD, isWorktreePath } from "./step-runner-shared.js";
import { MUTATING_TOOLS, toolBrief } from "./tui.js";
import type { ParkSignal, ProviderName, Step, StepEmit, StepResult, TokenUsage } from "./types.js";
import { ensureWorktreeDeps } from "./worktree-deps.js";

export { composeSystemAppend, isWorktreePath } from "./step-runner-shared.js";

// ── Step runner ────────────────────────────────────────────────────────

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
	/** SIGINT-driven cancellation. Threaded through to the SDK's `query()` call so an
	 * in-flight fetch stream tears down when the parent controller aborts. */
	signal?: AbortSignal;
	/** Brackets mutating provider tools for dirty-main delta attribution. */
	mainCheckoutObserver?: MainCheckoutDeltaObserver;
}

/** Canonical signature of a step runner. Single-sourced here (all four types are in
 *  scope) and re-exported from `pipeline.ts`, so `mocks.ts`'s `RunStepFn` import and
 *  the `deps.runStep` DI seam resolve to one definition. */
export type RunStepFn = (name: Step, prompt: string, opts: RunStepOpts, emit: StepEmit) => Promise<StepResult>;

/** A step-execution backend. Today only the Claude SDK runner; #80 adds a second and
 *  registers it in `PROVIDERS`. The exported `runStep` dispatches to `runStep` here by
 *  the per-step resolved `provider`. */
export interface StepProvider {
	name: ProviderName;
	runStep: RunStepFn;
}

// Worktree-side install guard: the worktree shares MAIN_REPO's `node_modules`
// via symlink, so any in-worktree `pnpm install` (or equivalent) re-points the
// shared symlinks into the worktree's `.pnpm` store and corrupts main once the
// worktree is removed. The escape hatch is the explicit `worktree-deps
// --repair-main` invocation, which restores the layout from the lockfile.
const INSTALL_PATTERN = /\b(pnpm\s+(install|i|add|update|up|upgrade|remove|rm)|npm\s+(install|i|ci))\b/;

export function blockWorktreeInstall(input: HookInput): HookJSONOutput {
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
export function blockPlanPolish(input: HookInput, cwd: string): HookJSONOutput {
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

export function beginMainCheckoutAttribution(input: HookInput, toolUseId: string | undefined, observer?: MainCheckoutDeltaObserver): HookJSONOutput {
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
	const { budget, turns: baseTurns, effort, model } = resolveStepSettings(CONFIG, opts.profile, name);
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
	const closeAttributedTool = async (input: HookInput, toolUseId: string | undefined): Promise<HookJSONOutput> => {
		return endMainCheckoutAttribution(input, toolUseId, opts.mainCheckoutObserver);
	};
	const hooks =
		isWorktree || planBlockActive || opts.mainCheckoutObserver
			? {
					PreToolUse: [
						{
							hooks: [
								async (input: HookInput, toolUseId: string | undefined): Promise<HookJSONOutput> => {
									const tn = "tool_name" in input ? String(input.tool_name) : "";
									const ti = ("tool_input" in input ? input.tool_input : {}) as Record<string, unknown>;

									if (isWorktree && (tn === "Write" || tn === "Edit")) {
										const fp = String(ti.file_path ?? "");
										if (fp.startsWith(mainAbs)) {
											const rel = fp.slice(mainAbs.length);
											return {
												decision: "block" as const,
												reason: `Path "${fp}" targets main repo. Use "${resolve(worktreeCwd, rel)}" instead.`,
											};
										}
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
		},
	});

	let text = "";
	let fullText = "";
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
				const u = (r as { usage?: Record<string, number> }).usage;
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

	const elapsed = Date.now() - t0;
	emit({ type: "done", ok, subtype, cost, turns: resultTurns, elapsed });

	const outputTail = text ? text.replace(/\x1b\[[0-9;]*m/g, "").slice(-200) : undefined;
	const toolCountsObj = toolCounts.size > 0 ? Object.fromEntries(toolCounts) : undefined;

	return {
		ok,
		subtype,
		text,
		fullText,
		cost,
		turns: resultTurns,
		...(tokens ? { tokens } : {}),
		...(toolCountsObj ? { toolCounts: toolCountsObj } : {}),
		...(outputTail ? { outputTail } : {}),
		...(stalledAsk ? { stalledAsk: true } : {}),
	};
};

// ── Provider registry ──────────────────────────────────────────────────

/** The default provider — the Claude SDK runner above. Exported so the registry
 *  unit test can assert `getProvider("claude") === claudeProvider`. */
export const claudeProvider: StepProvider = { name: "claude", runStep: claudeRunStep };

// Keyed by `ProviderName` so the map is exhaustive over the union — #80's widening
// surfaces a compile error here until it registers the new provider.
const PROVIDERS: Record<ProviderName, StepProvider> = {
	claude: claudeProvider,
	codex: codexProvider,
	grok: grokProvider,
};

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
export const runStep: RunStepFn = (name, prompt, opts, emit) => getProvider(resolveStepSettings(CONFIG, opts.profile, name).provider).runStep(name, prompt, opts, emit);
