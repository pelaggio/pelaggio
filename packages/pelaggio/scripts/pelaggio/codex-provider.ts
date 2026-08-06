import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG, REPO, resolveProviderBin, resolveStepSettings, type StepSettings } from "./config.js";
import { emitDecisionsFromText } from "./decisions.js";
import { classifyStepError, isRefusal, looksLikeStalledAsk, parseBlockedReason, parseWaitFlag, resolveParkReset } from "./helpers.js";
import { buildAgentEnv, makeSecretScrubber } from "./secret-hygiene.js";
import type { StepProvider } from "./step-runner.js";
import { composeSystemAppend, EDIT_LOOP_EXEMPT_STEPS, EDIT_LOOP_THRESHOLD, isWorktreePath } from "./step-runner-shared.js";
import { MUTATING_TOOLS, toolBrief } from "./tui.js";
import type { ParkSignal, ProviderCapabilities, Step, StepEvent, StepResult, TokenUsage } from "./types.js";
import { ensureWorktreeDeps } from "./worktree-deps.js";

/** Codex: workspace-write sandbox, estimated cost, cache counters, JSONL + final-message output. */
export const CODEX_CAPABILITIES: ProviderCapabilities = {
	semanticDeny: false,
	isolation: ["workspace-write"],
	costMeter: { kind: "usd-estimated" },
	cacheReporting: true,
	outputTransport: "stream-plus-final",
	sessionResume: false,
};

type JsonObject = Record<string, unknown>;

export interface CodexExitInfo {
	exitCode: number | null;
	signal?: string | null;
	stderr?: string;
	timedOut?: boolean;
	outputLastMessage?: string;
	now?: number;
	unknownResetWaitMs?: number;
}

export interface CodexBuildResult {
	result: StepResult;
	parkUpdate?: Partial<ParkSignal>;
	events: StepEvent[];
}

const CODEX_COST_PER_INPUT_TOKEN = 0.000_002;
const CODEX_COST_PER_OUTPUT_TOKEN = 0.000_008;

/**
 * Codex-provider-only prompt append (#109). The `workspace-write` sandbox can't write git metadata
 * (a worktree's `.git` points into MAIN/.git, outside the writable root) or reach the network — so
 * the model's autonomous instinct to `git commit` its work fails and blocks the step. Tell it not
 * to run stateful git or network CLIs; the harness owns commits + roadmap/forge effects. Kept OUT
 * of the shared `composeSystemAppend` because the Claude provider's skills legitimately run git.
 */
export const CODEX_SANDBOX_APPEND = [
	"## Sandbox: the harness owns git and network",
	"Your sandbox cannot write git metadata or reach the network. Do NOT run stateful git commands (`git add`, `commit`, `rm`, `restore`, `checkout`, `stash`, `push`, `merge`) and do NOT run network/roadmap CLIs (`gh ...`, `npx pelaggio roadmap ...`). Just create and edit files — the harness commits your work automatically after this step and owns all roadmap/forge effects. Read-only git (`git status`/`diff`/`log`/`show`) is fine.",
].join("\n");

export function codexTimeoutMs(turns: number): number {
	return Math.max(10 * 60_000, Math.min(90 * 60_000, turns * 60_000));
}

// Prefer the explicit Codex layer, then the legacy model slot when it is already
// Codex-compatible. Never forward Claude model ids to the Codex CLI.
export function selectCodexModel(settings: Pick<StepSettings, "model" | "codexModel">): string | undefined {
	const candidate = settings.codexModel ?? settings.model;
	return candidate && !candidate.startsWith("claude-") ? candidate : undefined;
}

/**
 * Collapse Pelaggio's five-value effort scale onto Codex CLI 0.146.0's `model_reasoning_effort`
 * vocabulary (issue #431). The CLI accepts `low | medium | high` (also `minimal`, which has no
 * Pelaggio analogue); preserve `low`/`medium` and collapse `high`/`xhigh`/`max` to `high`. Mirrors
 * `grokEffort` so both subprocess providers translate the single resolved step effort identically.
 */
export function codexEffort(effort: StepSettings["effort"]): "low" | "medium" | "high" {
	if (effort === "low") return "low";
	if (effort === "medium") return "medium";
	return "high";
}

/**
 * Pure assembly of the `codex exec` argv (issue #431). Kept exported and side-effect-free so the
 * acceptance criterion — mapped reasoning effort is present in the spawned argv on every run — is
 * unit-testable without spawning a real Codex session. Passing the value as a separate argv element
 * (`-c`, `model_reasoning_effort=<mapped>`) avoids shell quoting and lets `--config` parse it as a
 * TOML string literal. The `-c` pair sits just before the stdin `-` sentinel, after any `-m` model.
 */
export function buildCodexExecArgs(opts: { cwd: string; outputPath: string; model?: string; effort: "low" | "medium" | "high" }): string[] {
	return ["exec", "--json", "-C", opts.cwd, "-s", "workspace-write", "-o", opts.outputPath, ...(opts.model ? ["-m", opts.model] : []), "-c", `model_reasoning_effort=${opts.effort}`, "-"];
}

function isObject(v: unknown): v is JsonObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringField(obj: JsonObject, ...keys: string[]): string {
	for (const key of keys) {
		const v = obj[key];
		if (typeof v === "string") return v;
		if (typeof v === "number") return String(v);
	}
	return "";
}

function nestedObject(obj: JsonObject, key: string): JsonObject | undefined {
	const v = obj[key];
	return isObject(v) ? v : undefined;
}

function eventType(ev: JsonObject): string {
	return stringField(ev, "type");
}

function eventItem(ev: JsonObject): JsonObject {
	return nestedObject(ev, "item") ?? ev;
}

function itemKind(ev: JsonObject): string {
	const item = eventItem(ev);
	return stringField(item, "type", "kind", "name") || eventType(ev);
}

function contentText(v: unknown): string {
	if (typeof v === "string") return v;
	if (Array.isArray(v)) {
		return v
			.map((part) => {
				if (typeof part === "string") return part;
				if (isObject(part)) return stringField(part, "text", "content");
				return "";
			})
			.filter(Boolean)
			.join("");
	}
	if (isObject(v)) return stringField(v, "text", "content", "message");
	return "";
}

function agentMessageText(ev: JsonObject): string {
	const item = eventItem(ev);
	if (eventType(ev) === "agent_message" || itemKind(ev) === "agent_message") {
		return contentText(item.content ?? item.message ?? item.text ?? ev.content ?? ev.message ?? ev.text);
	}
	return "";
}

function commandExecutionText(ev: JsonObject): string {
	const item = eventItem(ev);
	if (itemKind(ev) !== "command_execution") return "";
	return [stringField(item, "command"), stringField(item, "aggregated_output", "stdout", "output"), stringField(item, "stderr", "error")].filter(Boolean).join("\n");
}

function commandExitCode(ev: JsonObject): number | undefined {
	const item = eventItem(ev);
	const raw = item.exit_code ?? item.exitCode;
	return typeof raw === "number" ? raw : undefined;
}

function fileChangePaths(ev: JsonObject): string[] {
	const item = eventItem(ev);
	const changes = item.changes;
	if (Array.isArray(changes)) {
		return changes.map((change) => (isObject(change) ? stringField(change, "path", "file_path", "filePath") : "")).filter(Boolean);
	}
	const nested = nestedObject(item, "file") ?? nestedObject(item, "change");
	const path = stringField(item, "path", "file_path", "filePath") || (nested ? stringField(nested, "path", "file_path", "filePath") : "");
	return path ? [path] : [];
}

function fileChangePath(ev: JsonObject): string {
	return fileChangePaths(ev)[0] ?? "";
}

function codexToolName(kind: string): string {
	switch (kind) {
		case "command_execution":
			return "Bash";
		case "file_change":
			return "Edit";
		case "mcp_tool_call":
			return "Agent";
		case "web_search":
			return "Grep";
		default:
			return kind || "Codex";
	}
}

function codexToolInput(ev: JsonObject, toolName: string): JsonObject {
	const item = eventItem(ev);
	if (toolName === "Bash") return { command: stringField(item, "command"), description: stringField(item, "description", "command") };
	if (toolName === "Edit") return { file_path: fileChangePath(ev) };
	if (toolName === "Grep") return { pattern: stringField(item, "query", "pattern", "text") };
	if (toolName === "Agent") return { description: stringField(item, "name", "tool_name", "server", "description") };
	return item;
}

function increment(map: Map<string, number>, key: string): number {
	const next = (map.get(key) ?? 0) + 1;
	map.set(key, next);
	return next;
}

function usageFromCompleted(ev: JsonObject): TokenUsage | undefined {
	if (eventType(ev) !== "turn.completed") return undefined;
	const usage = nestedObject(ev, "usage") ?? nestedObject(eventItem(ev), "usage");
	if (!usage) return undefined;
	return {
		input: Number(usage.input_tokens ?? usage.inputTokens ?? 0) || 0,
		output: (Number(usage.output_tokens ?? usage.outputTokens ?? 0) || 0) + (Number(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens ?? 0) || 0),
		cacheCreation: 0,
		cacheRead: Number(usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0) || 0,
	};
}

function estimateCodexCost(tokens: TokenUsage | undefined): number {
	if (!tokens) return 0;
	return (tokens.input + tokens.cacheRead) * CODEX_COST_PER_INPUT_TOKEN + tokens.output * CODEX_COST_PER_OUTPUT_TOKEN;
}

function rateLimitText(errorText: string): boolean {
	return /\b429\b|rate.?limit|usage.?limit|quota|limit exceeded/i.test(errorText);
}

function failedErrorText(ev: JsonObject): string {
	const err = ev.error;
	if (typeof err === "string") return err;
	if (isObject(err)) return stringField(err, "message", "code", "type");
	return stringField(ev, "message");
}

function rateLimitType(errorText: string): string {
	return errorText.match(/\b(429|[^:;\n]*limit[^:;\n]*)/i)?.[1]?.trim() || "unknown";
}

export function buildCodexStepResult(name: Step, events: JsonObject[], exitInfo: CodexExitInfo): CodexBuildResult {
	const emitted: StepEvent[] = [];
	let text = "";
	let fullText = "";
	let assistantText = "";
	let turns = 0;
	let completed = false;
	let failed = false;
	let failedText = "";
	let tokens: TokenUsage | undefined;
	let stopReason: string | undefined;
	let stalledAsk = false;
	let loopFile: string | null = null;
	const editCounts = new Map<string, number>();
	const toolCounts = new Map<string, number>();

	for (const ev of events) {
		const type = eventType(ev);
		const kind = itemKind(ev);
		const toolStart = type === "item.started";
		const itemCompleted = type === "item.completed";

		if (type === "thread.started") {
			emitted.push({ type: "init", model: stringField(ev, "model"), toolCount: 0 });
		}
		if (type === "turn.started") {
			turns++;
			emitted.push({ type: "turn" });
		}
		if (type === "turn.completed") {
			completed = true;
			tokens = usageFromCompleted(ev);
			stopReason = stringField(ev, "stop_reason", "stopReason") || stopReason;
		}
		if (type === "turn.failed") {
			failed = true;
			failedText = failedErrorText(ev);
		}
		if (toolStart && ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(kind)) {
			const toolName = codexToolName(kind);
			const input = codexToolInput(ev, toolName);
			increment(toolCounts, toolName);
			emitted.push({ type: "tool_use", name: toolName, brief: toolBrief(toolName, input), mutating: MUTATING_TOOLS.has(toolName) });
		}
		if (toolStart && kind === "file_change") {
			for (const fp of fileChangePaths(ev)) {
				if (fp && !EDIT_LOOP_EXEMPT_STEPS.has(name)) {
					const count = increment(editCounts, fp);
					if (count >= EDIT_LOOP_THRESHOLD && !loopFile) {
						loopFile = fp;
						emitted.push({ type: "edit_loop", file: fp, count });
					}
				}
			}
		}
		if (itemCompleted && kind === "command_execution") {
			const cmdText = commandExecutionText(ev);
			if (cmdText) fullText += `${cmdText}\n`;
			const exitCode = commandExitCode(ev);
			if (exitCode !== undefined && exitCode !== 0) {
				emitted.push({ type: "tool_error", name: "Bash", brief: toolBrief("Bash", codexToolInput(ev, "Bash")), error: cmdText || `command exited ${exitCode}` });
			}
		}
		const msg = agentMessageText(ev);
		if (msg) {
			text = msg;
			assistantText += `${msg}\n`;
			fullText += `${msg}\n`;
			emitted.push({ type: "text", content: msg });
		}
	}

	const streamedFinalText = text;
	if (exitInfo.outputLastMessage?.trim()) {
		text = exitInfo.outputLastMessage;
		fullText += `${exitInfo.outputLastMessage}\n`;
		if (exitInfo.outputLastMessage.trim() !== streamedFinalText.trim()) assistantText += `${exitInfo.outputLastMessage}\n`;
	}
	const cost = estimateCodexCost(tokens);
	let ok = completed && !failed && exitInfo.exitCode === 0 && !exitInfo.timedOut;
	let subtype = ok ? "success" : "error_sdk";
	let parkUpdate: Partial<ParkSignal> | undefined;
	const errMsg = failedText || exitInfo.stderr || (exitInfo.signal ? `codex exited by ${exitInfo.signal}` : `codex exited ${exitInfo.exitCode ?? "without code"}`);
	const limitText = failedText || errMsg;
	const isRateLimit = (failed || exitInfo.exitCode !== 0) && rateLimitText(limitText);

	if (exitInfo.timedOut) {
		ok = false;
		subtype = "error_max_turns";
		text = `Codex step timed out after ${turns || 0} turns`;
	} else if (isRateLimit) {
		ok = false;
		subtype = "error_rate_limit";
		text = limitText || "Codex rate limit";
		const resolved = resolveParkReset(0, true, rateLimitType(limitText), limitText, exitInfo.now ?? Date.now(), exitInfo.unknownResetWaitMs ?? parseWaitFlag(CONFIG.park.unknownResetWait));
		parkUpdate = { parked: true, resetsAt: resolved.resetsAt, limitType: resolved.limitType };
		emitted.push({ type: "rate_limit", limitType: resolved.limitType, resetsAt: resolved.resetsAt });
	} else if (failed || exitInfo.exitCode !== 0) {
		ok = false;
		subtype = classifyStepError(errMsg, false);
		text = text || errMsg;
		emitted.push({ type: "sdk_error", message: errMsg });
	}

	if (loopFile && subtype !== "error_max_turns" && !parkUpdate) {
		ok = false;
		subtype = "edit_loop";
		text = `Edit loop detected: ${loopFile} edited ${editCounts.get(loopFile)} times`;
	}

	if (ok && isRefusal(stopReason, text)) {
		ok = false;
		subtype = "error_refusal";
		emitted.push({ type: "sdk_error", message: "model refused / declined the task" });
	}

	if (ok) {
		const blockedReason = parseBlockedReason(text);
		if (blockedReason) {
			ok = false;
			subtype = "blocked";
			text = blockedReason;
			emitted.push({ type: "blocked", reason: blockedReason });
		} else if (looksLikeStalledAsk(text)) {
			stalledAsk = true;
			emitted.push({ type: "stalled_ask", tail: text.replace(/\s+$/, "").slice(-160) });
		}
	}

	const outputTail = text ? text.replace(/\x1b\[[0-9;]*m/g, "").slice(-200) : undefined;
	const decisions = emitDecisionsFromText(assistantText);
	for (const d of decisions) emitted.push({ type: "decision", decision: d.decision });
	const toolCountsObj = toolCounts.size > 0 ? Object.fromEntries(toolCounts) : undefined;
	return {
		result: {
			ok,
			subtype,
			text,
			fullText,
			assistantText,
			cost,
			costEstimated: true,
			turns,
			...(tokens ? { tokens } : {}),
			...(toolCountsObj ? { toolCounts: toolCountsObj } : {}),
			...(outputTail ? { outputTail } : {}),
			...(stalledAsk ? { stalledAsk: true } : {}),
			...(decisions.length ? { decisions } : {}),
		},
		...(parkUpdate ? { parkUpdate } : {}),
		events: emitted,
	};
}

function parseJsonlChunk(buffer: string, lines: JsonObject[]): string {
	const parts = buffer.split(/\r?\n/);
	const rest = parts.pop() ?? "";
	for (const line of parts) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isObject(parsed)) lines.push(parsed);
		} catch {
			// Codex --json should be JSONL; ignore malformed diagnostic lines defensively.
		}
	}
	return rest;
}

const runStep: StepProvider["runStep"] = async (name, prompt, opts, emit) => {
	const resolved = resolveStepSettings(CONFIG, opts.profile, name);
	const settings = { ...resolved, model: opts.executionOverride?.model ?? resolved.model, codexModel: opts.executionOverride?.codexModel ?? resolved.codexModel };
	const { budget, turns: baseTurns, effort } = settings;
	const turns = opts.maxTurnsOverride ?? baseTurns;
	const codexModel = selectCodexModel(settings);
	const modelLabel = codexModel ?? "default";
	emit({ type: "step_header", name, model: modelLabel, budget, maxTurns: turns, prompt: opts.trace ? prompt : undefined });

	const t0 = Date.now();
	const isWorktree = isWorktreePath(opts.cwd, REPO);
	if (isWorktree) {
		try {
			ensureWorktreeDeps(opts.cwd, REPO);
		} catch (err) {
			emit({ type: "sdk_error", message: `worktree-deps guard failed: ${err instanceof Error ? err.message : String(err)}` });
		}
	}

	const systemAppend = composeSystemAppend({ isWorktree, cwd: opts.cwd, repo: REPO, planBlockActive: name === "implement" });
	const finalPrompt = `${prompt}\n\n${systemAppend}\n\n${CODEX_SANDBOX_APPEND}`;
	const tmp = mkdtempSync(join(tmpdir(), "pelaggio-codex-"));
	const outputPath = join(tmp, "last-message.txt");
	// Always forward the mapped reasoning effort, even when no Codex model is pinned, so a
	// configured step effort reaches the CLI (issue #431).
	const args = buildCodexExecArgs({ cwd: opts.cwd, outputPath, ...(codexModel ? { model: codexModel } : {}), effort: codexEffort(effort) });
	// Deny-by-default env: the child gets only the allowlisted vars, never the full parent env, so
	// a prompt-injected step cannot read/echo credentials it was never given (#237 / TC-014).
	const scrub = makeSecretScrubber();
	const child = spawn(resolveProviderBin(CONFIG, "codex", "codex"), args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: buildAgentEnv({ allow: CONFIG.security.envAllowlist }) });

	try {
		const events: JsonObject[] = [];
		let stdoutRest = "";
		let stderr = "";
		let spawnError: Error | undefined;
		let timedOut = false;
		let settled = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!settled) child.kill("SIGKILL");
			}, 5_000).unref();
		}, codexTimeoutMs(turns));
		timeout.unref();

		const onAbort = () => child.kill("SIGTERM");
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdoutRest = parseJsonlChunk(stdoutRest + chunk, events);
		});
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.stdin.on("error", (err) => {
			spawnError = err;
		});
		const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			child.on("error", (err) => {
				spawnError = err;
				resolve({ code: null, signal: null });
			});
			child.on("close", (code, signal) => resolve({ code, signal }));
		});
		try {
			child.stdin.end(finalPrompt);
		} catch (err) {
			spawnError = err instanceof Error ? err : new Error(String(err));
			child.kill("SIGTERM");
		}

		const exit = await exitPromise;
		settled = true;
		clearTimeout(timeout);
		if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
		parseJsonlChunk(`${stdoutRest}\n`, events);

		let outputLastMessage = "";
		try {
			outputLastMessage = readFileSync(outputPath, "utf-8");
		} catch {}

		const built = buildCodexStepResult(name, events, {
			exitCode: spawnError && exit.code === 0 ? 1 : exit.code,
			signal: exit.signal,
			stderr: scrub(spawnError?.message || stderr),
			timedOut,
			outputLastMessage,
			now: Date.now(),
			unknownResetWaitMs: parseWaitFlag(CONFIG.park.unknownResetWait),
		});
		if (built.parkUpdate) {
			opts.parkSignal.parked = built.parkUpdate.parked ?? opts.parkSignal.parked;
			opts.parkSignal.resetsAt = built.parkUpdate.resetsAt ?? opts.parkSignal.resetsAt;
			opts.parkSignal.limitType = built.parkUpdate.limitType ?? opts.parkSignal.limitType;
			opts.parkSignal.triggerWorker = opts.itemId ?? "";
		}
		for (const event of built.events) emit(event);
		const elapsed = Date.now() - t0;
		emit({ type: "done", ok: built.result.ok, subtype: built.result.subtype, cost: built.result.cost, turns: built.result.turns, elapsed });
		return built.result;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
};

export const codexProvider: StepProvider = { name: "codex", capabilities: CODEX_CAPABILITIES, runStep };
