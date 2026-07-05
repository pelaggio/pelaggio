import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HookInput, HookJSONOutput, SDKAssistantMessage, SDKRateLimitEvent, SDKResultMessage, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { BUDGETS, EFFORT, MODEL_PROFILES, REPO, TURN_LIMITS } from "./config.js";
import { parseResetTime } from "./helpers.js";
import { MUTATING_TOOLS, toolBrief } from "./tui.js";
import type { ParkSignal, Step, StepEmit, StepResult, TokenUsage } from "./types.js";
import { ensureWorktreeDeps } from "./worktree-deps.js";

// ── Step runner ────────────────────────────────────────────────────────

export interface RunStepOpts {
	cwd: string;
	profile: string;
	trace: boolean;
	itemId?: string;
	parkSignal: ParkSignal;
	/** Per-call override for the step's `maxTurns`. Used by `implement` to size the
	 * budget from the plan's file count (see `computeImplementTurns` in helpers.ts).
	 * When undefined, falls back to the static `TURN_LIMITS[name]`. */
	maxTurnsOverride?: number;
	/** SIGINT-driven cancellation. Threaded through to the SDK's `query()` call so an
	 * in-flight fetch stream tears down when the parent controller aborts. */
	signal?: AbortSignal;
}

const EDIT_LOOP_THRESHOLD = 22;

// Steps whose entire job is iteratively editing the plan document. The raw-edit
// loop guard would false-positive on legitimate refinement passes, so it is
// skipped here. Steps editing code (`implement`, `shakedown-code`) keep it.
const EDIT_LOOP_EXEMPT_STEPS: ReadonlySet<Step> = new Set(["plan", "shakedown-plan"]);

// Autonomy framing: rides on every SDK call for every step. Opus 4.8 asks
// clarifying questions more readily than 4.7, but here a question ends the turn
// with unfinished work and retry logic can't tell it apart from progress. Terse
// on purpose — this is a per-call token cost on every step.
const AUTONOMY_APPEND = [
	"",
	"## Operating autonomously",
	"You are operating autonomously inside a headless pipeline. Nobody is watching in real time and nobody can answer questions mid-step, so ending your turn with a question stalls the step. For minor choices (naming, formatting, defaults, which of two equivalent approaches), pick a reasonable option and note it in your final message. End your turn only when the step is complete or you are genuinely blocked — and if blocked, state precisely what is missing rather than asking permission to proceed.",
].join("\n");

/** True when `cwd` is a sibling worktree, not the main repo. Exported for testing. */
export function isWorktreePath(cwd: string, repo: string): boolean {
	return resolve(cwd) !== resolve(repo);
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

/** Composes the per-step system-prompt append. The autonomy block is
 * unconditional; the worktree-isolation and plan-polish blocks layer on when
 * their conditions hold. Exported for testing. */
export function composeSystemAppend(args: { isWorktree: boolean; cwd: string; repo: string; planBlockActive: boolean }): string {
	const worktreeAppend = args.isWorktree
		? [
				"",
				"## CRITICAL: Worktree isolation",
				`Your working directory is a git worktree at: ${args.cwd}`,
				`The main repository is at: ${args.repo}`,
				"You MUST use relative paths or paths under your working directory for ALL file operations.",
				`NEVER use absolute paths starting with ${args.repo}/ — those point to the main worktree and will corrupt another workspace.`,
				"Use $PWD-relative paths, or resolve from your cwd. The codebase in your worktree is identical — read and write here.",
			].join("\n")
		: undefined;

	const planAppend = args.planBlockActive
		? [
				"",
				"## CRITICAL: Do not edit the plan",
				"Files under `docs/plans/` are READ-ONLY for this step. Your job is to EXECUTE the plan by writing code to other files — not to polish, clarify, or extend the plan document itself.",
				"Writes to `docs/plans/*` will be blocked by a hook. If you believe the plan is wrong, stop and surface the issue in your final message instead of editing around it.",
			].join("\n")
		: undefined;

	return [AUTONOMY_APPEND, worktreeAppend, planAppend].filter(Boolean).join("\n");
}

export async function runStep(name: Step, prompt: string, opts: RunStepOpts, emit: StepEmit): Promise<StepResult> {
	const budget = BUDGETS[name];
	const turns = opts.maxTurnsOverride ?? TURN_LIMITS[name];
	const model = MODEL_PROFILES[opts.profile]?.[name];
	const effort = EFFORT[name];

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
	const hooks =
		isWorktree || planBlockActive
			? {
					PreToolUse: [
						{
							hooks: [
								async (input: HookInput): Promise<HookJSONOutput> => {
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

									return {};
								},
							],
						},
					],
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
					opts.parkSignal.parked = true;
					opts.parkSignal.resetsAt = info.resetsAt ?? 0;
					opts.parkSignal.limitType = info.rateLimitType ?? "unknown";
					opts.parkSignal.triggerWorker = opts.itemId ?? "";
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
		if (/rate.?limit|usage.?limit|quota|rejected/i.test(errMsg) || opts.parkSignal.parked) {
			subtype = "error_rate_limit";
		} else if (/budget/i.test(errMsg)) {
			subtype = "error_budget";
		} else if (/abort/i.test(errMsg)) {
			subtype = "error_abort";
		} else if (/max.*turns|turn.?limit|maximum.*turns/i.test(errMsg)) {
			subtype = "error_max_turns";
		} else {
			subtype = "error_sdk";
		}
		text = errMsg;
		emit({ type: "sdk_error", message: errMsg });
	}

	// Edit loop override
	if (loopFile) {
		ok = false;
		subtype = "edit_loop";
		text = `Edit loop detected: ${loopFile} edited ${editCounts.get(loopFile)} times`;
	}

	// Backfill resetsAt from error/result text when the rate_limit_event didn't provide it
	if (opts.parkSignal.parked && !opts.parkSignal.resetsAt) {
		const parsed = parseResetTime(text);
		if (parsed) opts.parkSignal.resetsAt = parsed;
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
	};
}
