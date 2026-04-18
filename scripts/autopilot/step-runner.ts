import { resolve } from "node:path";
import type { HookInput, HookJSONOutput, SDKAssistantMessage, SDKRateLimitEvent, SDKResultMessage, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { BUDGETS, EFFORT, MODEL_PROFILES, REPO, TURN_LIMITS } from "./config.js";
import { parseResetTime } from "./helpers.js";
import { MUTATING_TOOLS, toolBrief } from "./tui.js";
import type { ParkSignal, Step, StepEmit, StepResult, TokenUsage } from "./types.js";

// ── Step runner ────────────────────────────────────────────────────────

export interface RunStepOpts {
	cwd: string;
	profile: string;
	trace: boolean;
	itemId?: string;
	parkSignal: ParkSignal;
}

const EDIT_LOOP_THRESHOLD = 12;

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

	const mainAbs = resolve(REPO) + "/";
	const worktreeCwd = resolve(opts.cwd);
	const worktreeHooks = isWorktree
		? {
				PreToolUse: [
					{
						hooks: [
							async (input: HookInput): Promise<HookJSONOutput> => {
								const tn = "tool_name" in input ? String(input.tool_name) : "";
								const ti = ("tool_input" in input ? input.tool_input : {}) as Record<string, unknown>;

								if (tn === "Write" || tn === "Edit") {
									const fp = String(ti.file_path ?? "");
									if (fp.startsWith(mainAbs)) {
										const rel = fp.slice(mainAbs.length);
										return {
											decision: "block" as const,
											reason: `Path "${fp}" targets main repo. Use "${resolve(worktreeCwd, rel)}" instead.`,
										};
									}
								}

								if (tn === "Bash") {
									const cmd = String(ti.command ?? "");
									if (cmd.includes(mainAbs) && !cmd.includes(worktreeCwd)) {
										return {
											decision: "block" as const,
											reason: `Command references main repo "${REPO}". Use worktree "${opts.cwd}" paths instead.`,
										};
									}
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
			...(worktreeAppend
				? {
						systemPrompt: {
							type: "preset" as const,
							preset: "claude_code" as const,
							append: worktreeAppend,
						},
					}
				: {}),
			...(worktreeHooks ? { hooks: worktreeHooks } : {}),
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
				if (info?.status === "rejected" && !opts.parkSignal.parked) {
					opts.parkSignal.parked = true;
					opts.parkSignal.resetsAt = info.resetsAt ?? 0;
					opts.parkSignal.limitType = info.rateLimitType ?? "unknown";
					opts.parkSignal.triggerWorker = opts.itemId ?? "";
					emit({ type: "rate_limit", limitType: opts.parkSignal.limitType, resetsAt: opts.parkSignal.resetsAt });
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

	return { ok, subtype, text, fullText, cost, turns: resultTurns, ...(tokens ? { tokens } : {}) };
}
