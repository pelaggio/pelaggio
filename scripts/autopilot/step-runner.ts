import { resolve } from "node:path";
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
}

const EDIT_LOOP_THRESHOLD = 12;

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

export async function runStep(name: Step, prompt: string, opts: RunStepOpts, emit: StepEmit): Promise<StepResult> {
	const budget = BUDGETS[name];
	const turns = TURN_LIMITS[name];
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
	const isWorktree = resolve(opts.cwd) !== resolve(REPO);

	// Mid-cycle drift guard: re-evaluate the shared-node_modules decision
	// before each worktree-cwd step. If the branch bumped pnpm-lock.yaml,
	// the stale symlink is replaced by a real install before verification
	// commands (pnpm test, pnpm check) run downstream.
	if (isWorktree) {
		try {
			ensureWorktreeDeps(opts.cwd, REPO);
		} catch (err) {
			emit({ type: "sdk_error", message: `worktree-deps guard failed: ${err instanceof Error ? err.message : String(err)}` });
		}
	}

	const worktreeAppend = isWorktree
		? [
				"",
				"## CRITICAL: Worktree isolation",
				`Your working directory is a git worktree at: ${opts.cwd}`,
				`The main repository is at: ${REPO}`,
				"You MUST use relative paths or paths under your working directory for ALL file operations.",
				`NEVER use absolute paths starting with ${REPO}/ — those point to the main worktree and will corrupt another workspace.`,
				"Use $PWD-relative paths, or resolve from your cwd. The codebase in your worktree is identical — read and write here.",
			].join("\n")
		: undefined;

	const planBlockActive = name === "implement";
	const planAppend = planBlockActive
		? [
				"",
				"## CRITICAL: Do not edit the plan",
				"Files under `docs/plans/` are READ-ONLY for this step. Your job is to EXECUTE the plan by writing code to other files — not to polish, clarify, or extend the plan document itself.",
				"Writes to `docs/plans/*` will be blocked by a hook. If you believe the plan is wrong, stop and surface the issue in your final message instead of editing around it.",
			].join("\n")
		: undefined;

	const systemAppend = [worktreeAppend, planAppend].filter(Boolean).join("\n");

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

	const gen = query({
		prompt,
		options: {
			cwd: opts.cwd,
			permissionMode: "bypassPermissions",
			maxBudgetUsd: budget,
			maxTurns: turns,
			effort,
			...(model ? { model } : {}),
			...(systemAppend
				? {
						systemPrompt: {
							type: "preset" as const,
							preset: "claude_code" as const,
							append: systemAppend,
						},
					}
				: {}),
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

						// Track edits per file
						if (toolName === "Edit" && input.file_path) {
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
