// OpenCode provider (issue #137): drives `opencode run --format json` as a headless subprocess.
//
// OpenCode is one CLI fronting 75+ model backends, so seating it as a true peer on the ADR-0020
// StepProvider seam (not a degraded worker) is the highest-leverage neutrality proof. It mirrors
// codex-provider's shape — a pure `buildOpenCodeStepResult` that folds the accumulated JSON event
// stream into a StepResult/StepEvent set, plus an async `runStep` that owns the subprocess lifecycle.
// We follow the Gastown headless path (`run --format json`) rather than `opencode acp`; the typed
// ACP transport is deferred (see the plan's out-of-scope list).
//
// PINNED ARGV (provisional — the `opencode` binary was absent at implement time, so the argv and
// event field names below are defensive best-effort, matching Codex's `--json` JSONL assumption):
//
//   opencode run --format json [-m <model>] "<prompt>"
//
// The prompt is the trailing positional `run` message (the issue's concrete headless form: runs once
// and exits). Re-pin against `opencode run --help` when the binary is available — switch to a
// `--prompt`/stdin path only if help documents one, and re-capture a live fixture to confirm the
// event shape (if `--format json` emits a single terminal document rather than incremental JSONL,
// flip `outputTransport` to "final" and drop edit-loop detection per the plan's §6 contingency).

import { spawn } from "node:child_process";
import { CONFIG, REPO, resolveProviderBin, resolveStepSettings, type StepSettings } from "../config.js";
import { emitDecisionsFromText } from "../decisions.js";
import { classifyStepError, isRefusal, looksLikeStalledAsk, parseBlockedReason, parseWaitFlag, resolveParkReset } from "../outcome-classify.js";
import { buildAgentEnv, makeSecretScrubber, scopeEnvAllowlistToProvider } from "../secret-hygiene.js";
import { composeSystemAppend, createStepTextProjection, EDIT_LOOP_EXEMPT_STEPS, EDIT_LOOP_THRESHOLD, isWorktreePath } from "../step-runner-shared.js";
import { MUTATING_TOOLS, toolBrief } from "../tui.js";
import type { ParkSignal, ProviderCapabilities, Step, StepEvent, StepResult, TokenUsage } from "../types.js";
import { ensureWorktreeDeps } from "../worktree-deps.js";
import type { StepProvider } from "./types.js";

/**
 * OpenCode: no PreToolUse semantic deny; `OPENCODE_PERMISSION` is a permission-policy env, NOT an OS
 * jail, so `isolation` stays honestly empty (ADR-0020: the descriptor must track real behavior).
 * Cost is estimated — OpenCode aggregates many billable backends, so we never claim `usd-billed`.
 * `outputTransport: "stream"` assumes `--format json` is incremental JSONL (Codex-shaped); flip to
 * "final" if a live fixture shows a single terminal document (plan §6/§7 contingency).
 */
export const OPENCODE_CAPABILITIES: ProviderCapabilities = {
	semanticDeny: false,
	isolation: [],
	costMeter: { kind: "usd-estimated" },
	cacheReporting: false,
	outputTransport: "stream",
	sessionResume: false,
};

type JsonObject = Record<string, unknown>;

export interface OpenCodeExitInfo {
	exitCode: number | null;
	signal?: string | null;
	stderr?: string;
	timedOut?: boolean;
	now?: number;
	unknownResetWaitMs?: number;
}

export interface OpenCodeBuildResult {
	result: StepResult;
	parkUpdate?: Partial<ParkSignal>;
	events: StepEvent[];
}

// OpenCode fronts many backends at heterogeneous prices; these are a single neutral order-of-
// magnitude estimate for the budget gate (costEstimated is always true). A provider-reported `cost`
// field, when present, is preferred over this token estimate.
const OPENCODE_COST_PER_INPUT_TOKEN = 0.000_003;
const OPENCODE_COST_PER_OUTPUT_TOKEN = 0.000_015;

/**
 * OpenCode-provider-only prompt append. Like codex/grok, the harness owns git + the roadmap/forge
 * effects and commits the step's work afterward; OpenCode has no OS workspace-write sandbox we trust
 * (`OPENCODE_PERMISSION` is a policy env, not a jail), so this prompt is load-bearing guidance.
 */
export const OPENCODE_SANDBOX_APPEND = [
	"## Sandbox: stay in the worktree; the harness owns git and network",
	"Work only inside the current working directory (a git worktree). Do NOT run stateful git commands (`git add`, `commit`, `rm`, `restore`, `checkout`, `stash`, `push`, `merge`) and do NOT run network/roadmap CLIs (`gh ...`, `npx pelaggio roadmap ...`). Just create and edit files — the harness commits your work automatically after this step and owns all roadmap/forge effects. Read-only git (`git status`/`diff`/`log`/`show`) is fine.",
].join("\n");

export function opencodeTimeoutMs(turns: number): number {
	// OpenCode runs a prompt autonomously to completion; bound by wall clock like codex/grok
	// (10–90 min, proportional to the step's turn budget).
	return Math.max(10 * 60_000, Math.min(90 * 60_000, turns * 60_000));
}

/**
 * Pick the model to pass with `-m` from OpenCode's own slot only (issue #431). OpenCode addresses
 * backends as `provider/model`; never forward a bare Claude SDK id (defensive — correct routing
 * fills `openCodeModel`). Absence → the OpenCode CLI's configured default.
 */
export function selectOpenCodeModel(settings: Pick<StepSettings, "openCodeModel">): string | undefined {
	const candidate = settings.openCodeModel;
	return candidate && !candidate.startsWith("claude-") ? candidate : undefined;
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

function contentText(v: unknown): string {
	if (typeof v === "string") return v;
	if (Array.isArray(v))
		return v
			.map((p) => (typeof p === "string" ? p : isObject(p) ? stringField(p, "text", "content") : ""))
			.filter(Boolean)
			.join("");
	if (isObject(v)) return stringField(v, "text", "content", "message");
	return "";
}

function eventType(ev: JsonObject): string {
	return stringField(ev, "type", "sessionUpdate", "event");
}

/** OpenCode may wrap the meaningful payload under `part` / `properties.part` (server event shape). */
function eventPart(ev: JsonObject): JsonObject {
	const props = nestedObject(ev, "properties");
	return nestedObject(ev, "part") ?? (props ? (nestedObject(props, "part") ?? props) : ev);
}

/** Map an OpenCode tool name onto a pelaggio display tool name (for the TUI; not load-bearing). */
function opencodeToolName(tool: string): string {
	const t = tool.toLowerCase();
	if (/bash|shell|command|exec|terminal/.test(t)) return "Bash";
	if (/edit|write|patch|create|apply|multiedit/.test(t)) return "Edit";
	if (/read|cat|view|open/.test(t)) return "Read";
	if (/grep|glob|find|list|search/.test(t)) return "Grep";
	if (/web|fetch|browse/.test(t)) return "Grep";
	if (/task|agent|subagent/.test(t)) return "Agent";
	return tool || "OpenCode";
}

function toolInputObject(part: JsonObject): JsonObject {
	const state = nestedObject(part, "state");
	return nestedObject(part, "input") ?? (state ? (nestedObject(state, "input") ?? {}) : {});
}

function toolFilePaths(part: JsonObject): string[] {
	const input = toolInputObject(part);
	const paths = [stringField(input, "filePath", "file_path", "path"), stringField(part, "filePath", "file_path", "path")].filter(Boolean);
	const files = input.files;
	if (Array.isArray(files)) for (const f of files) if (typeof f === "string") paths.push(f);
	return [...new Set(paths)];
}

function opencodeToolBriefInput(toolName: string, part: JsonObject): JsonObject {
	const input = toolInputObject(part);
	if (toolName === "Bash") return { command: stringField(input, "command", "cmd"), description: stringField(input, "description", "command", "cmd") };
	if (toolName === "Edit") return { file_path: toolFilePaths(part)[0] ?? "" };
	if (toolName === "Read") return { file_path: stringField(input, "filePath", "file_path", "path") };
	if (toolName === "Grep") return { pattern: stringField(input, "pattern", "query", "text") };
	if (toolName === "Agent") return { description: stringField(input, "description", "prompt", "name") };
	return input;
}

function toolState(part: JsonObject): { status: string; output: string } {
	const state = nestedObject(part, "state") ?? part;
	return { status: stringField(state, "status"), output: stringField(state, "output", "result", "stdout") };
}

function usageObject(ev: JsonObject): JsonObject | undefined {
	// Live `opencode run --format json` (1.18.x) reports usage as `part.tokens`, not `usage`.
	return nestedObject(ev, "usage") ?? nestedObject(eventPart(ev), "usage") ?? nestedObject(nestedObject(ev, "properties") ?? {}, "usage") ?? nestedObject(eventPart(ev), "tokens") ?? nestedObject(ev, "tokens");
}

function tokensFromUsage(usage: JsonObject | undefined): TokenUsage | undefined {
	if (!usage) return undefined;
	const cache = nestedObject(usage, "cache");
	return {
		input: Number(usage.input ?? usage.inputTokens ?? usage.input_tokens ?? 0) || 0,
		output: (Number(usage.output ?? usage.outputTokens ?? usage.output_tokens ?? 0) || 0) + (Number(usage.reasoning ?? usage.reasoningTokens ?? usage.reasoning_tokens ?? 0) || 0),
		cacheCreation: Number(cache?.write ?? usage.cacheWrite ?? usage.cache_write_tokens ?? 0) || 0,
		cacheRead: Number(cache?.read ?? usage.cacheRead ?? usage.cache_read_tokens ?? 0) || 0,
	};
}

function reportedCost(ev: JsonObject): number {
	const raw = ev.cost ?? eventPart(ev).cost ?? nestedObject(ev, "properties")?.cost;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

function estimateOpenCodeCost(tokens: TokenUsage | undefined, reported: number): number {
	if (reported > 0) return reported;
	if (!tokens) return 0;
	return (tokens.input + tokens.cacheRead) * OPENCODE_COST_PER_INPUT_TOKEN + tokens.output * OPENCODE_COST_PER_OUTPUT_TOKEN;
}

function rateLimitText(errorText: string): boolean {
	return /\b429\b|rate.?limit|usage.?limit|quota|limit exceeded/i.test(errorText);
}

function errorEventText(ev: JsonObject): string {
	const err = ev.error ?? eventPart(ev).error;
	if (typeof err === "string") return err;
	if (isObject(err)) return stringField(err, "message", "code", "name", "type");
	return stringField(ev, "message");
}

function increment(map: Map<string, number>, key: string): number {
	const next = (map.get(key) ?? 0) + 1;
	map.set(key, next);
	return next;
}

/**
 * Pure: fold the accumulated `opencode run --format json` events + exit info into a StepResult. Kept
 * side-effect-free and exported so it can be unit-tested against captured/synthetic fixtures with no
 * live opencode — mirroring `buildCodexStepResult` / `buildGrokStepResult`.
 */
export function buildOpenCodeStepResult(name: Step, events: JsonObject[], exitInfo: OpenCodeExitInfo): OpenCodeBuildResult {
	const emitted: StepEvent[] = [];
	let text = "";
	const projection = createStepTextProjection({ assistantSeparator: "" });
	let turns = 0;
	let completed = false;
	let failed = false;
	let failedText = "";
	let tokens: TokenUsage | undefined;
	let cost = 0;
	let stopReason: string | undefined;
	let loopFile: string | null = null;
	const editCounts = new Map<string, number>();
	const toolCounts = new Map<string, number>();

	function trackEdit(fp: string): void {
		if (!fp || EDIT_LOOP_EXEMPT_STEPS.has(name)) return;
		const count = increment(editCounts, fp);
		if (count >= EDIT_LOOP_THRESHOLD && !loopFile) {
			loopFile = fp;
			emitted.push({ type: "edit_loop", file: fp, count });
		}
	}

	for (const ev of events) {
		const type = eventType(ev);
		const part = eventPart(ev);
		const partType = stringField(part, "type") || type;

		if (/^(session|session\.start|start|init)$/.test(type)) {
			emitted.push({ type: "init", model: stringField(ev, "model", "modelID", "model_id") || stringField(part, "model"), toolCount: 0 });
			continue;
		}
		if (/^(step-start|step\.start|turn-start|turn\.start|turn)$/.test(type) || partType === "step-start") {
			turns++;
			emitted.push({ type: "turn" });
			continue;
		}
		if (/^(step-finish|step\.finish)$/.test(type) || partType === "step-finish") {
			const usage = usageObject(ev);
			if (usage) tokens = tokensFromUsage(usage) ?? tokens;
			cost = reportedCost(ev) || cost;
			// Live 1.18.x emits no trailing `finish` event: the final `step-finish` carries
			// `reason: "stop"` (intermediate ones carry `"tool-calls"`), so it is the completion signal.
			const reason = stringField(part, "reason") || stringField(ev, "reason");
			if (reason && reason !== "tool-calls") {
				completed = true;
				stopReason = reason;
			}
			continue;
		}
		if (/^(finish|done|complete|completed|message\.completed|result)$/.test(type)) {
			completed = true;
			stopReason = stringField(ev, "reason", "stopReason", "stop_reason", "finishReason") || stopReason;
			const usage = usageObject(ev);
			if (usage) tokens = tokensFromUsage(usage) ?? tokens;
			cost = reportedCost(ev) || cost;
			continue;
		}
		if (/^error$/.test(type) || partType === "error") {
			failed = true;
			failedText = errorEventText(ev) || failedText;
			continue;
		}
		if (partType === "tool" || type === "tool" || type === "tool_use") {
			const toolRaw = stringField(part, "tool", "name", "toolName") || stringField(ev, "tool", "name");
			const toolName = opencodeToolName(toolRaw);
			const { status, output } = toolState(part);
			increment(toolCounts, toolName);
			const briefInput = opencodeToolBriefInput(toolName, part);
			emitted.push({ type: "tool_use", name: toolName, brief: toolBrief(toolName, briefInput) || toolRaw, mutating: MUTATING_TOOLS.has(toolName) });
			if (toolName === "Edit") for (const fp of toolFilePaths(part)) trackEdit(fp);
			projection.appendToolInput(toolInputObject(part));
			if (status === "error" || status === "failed") emitted.push({ type: "tool_error", name: toolName, brief: toolBrief(toolName, briefInput) || toolRaw, error: output || `tool ${toolRaw || "call"} failed` });
			continue;
		}
		if (partType === "text" || type === "text" || type === "agent_message" || type === "message.part.updated") {
			const chunk = contentText(part.text ?? part.content ?? ev.text ?? ev.content ?? ev.message);
			if (chunk) {
				text = chunk;
				// Concatenate WITHOUT a separator: text parts are token-boundary fragments
				// of one assistant message, and an injected newline inside a findings/Judge
				// JSON block corrupts the delimited report (#417 gate finding).
				projection.appendAssistant(chunk);
				emitted.push({ type: "text", content: chunk });
			}
		}
	}

	cost = estimateOpenCodeCost(tokens, cost);
	text = text.trim();
	let ok = completed && !failed && exitInfo.exitCode === 0 && !exitInfo.timedOut;
	let subtype = ok ? "success" : "error_sdk";
	let parkUpdate: Partial<ParkSignal> | undefined;
	const errMsg = failedText || exitInfo.stderr || (exitInfo.signal ? `opencode exited by ${exitInfo.signal}` : `opencode exited ${exitInfo.exitCode ?? "without code"}`);
	const limitText = failedText || errMsg;
	const isRateLimit = (failed || exitInfo.exitCode !== 0) && rateLimitText(limitText);

	if (exitInfo.timedOut) {
		ok = false;
		subtype = "error_max_turns";
		text = `OpenCode step timed out after ${turns || 0} turns`;
	} else if (isRateLimit) {
		ok = false;
		subtype = "error_rate_limit";
		text = limitText || "OpenCode rate limit";
		const resolved = resolveParkReset(0, true, "", limitText, exitInfo.now ?? Date.now(), exitInfo.unknownResetWaitMs ?? parseWaitFlag(CONFIG.park.unknownResetWait));
		parkUpdate = { parked: true, resetsAt: resolved.resetsAt, limitType: resolved.limitType };
		emitted.push({ type: "rate_limit", limitType: resolved.limitType, resetsAt: resolved.resetsAt });
	} else if (failed || exitInfo.exitCode !== 0 || !completed) {
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

	// A benign finish reason ("stop"/"end_turn") must NOT suppress text-based refusal detection — a
	// safety refusal still ends the turn normally. Only forward a reason that itself signals refusal;
	// otherwise pass undefined so `looksLikeRefusal(text)` governs (mirrors codex, whose stopReason
	// stays undefined on benign completions).
	const refusalStopReason = stopReason && /refus|declin|content.?filter|safety|policy/i.test(stopReason) ? "refusal" : undefined;
	if (ok && isRefusal(refusalStopReason, text)) {
		ok = false;
		subtype = "error_refusal";
		emitted.push({ type: "sdk_error", message: "model refused / declined the task" });
	}

	let stalledAsk = false;
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
	const { assistantText, fullText } = projection.read();
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
			// `--format json` should be JSONL; ignore malformed diagnostic lines defensively.
		}
	}
	return rest;
}

const runStep: StepProvider["runStep"] = async (name, prompt, opts, emit) => {
	const resolved = resolveStepSettings(CONFIG, opts.profile, name);
	// A pooled OpenCode seat's realized model arrives in the generic `executionOverride.model`
	// slot (DriverIdentity/ReviewSlot stay generic for non-Codex providers); route it into
	// OpenCode's own `openCodeModel` slot so selection never scavenges the Claude model (issue #431).
	const settings = { ...resolved, openCodeModel: opts.executionOverride?.model ?? resolved.openCodeModel };
	const { budget, turns: baseTurns } = settings;
	const turns = opts.maxTurnsOverride ?? baseTurns;
	const model = selectOpenCodeModel(settings);
	emit({ type: "step_header", name, model: model ?? "default", budget, maxTurns: turns, prompt: opts.trace ? prompt : undefined });

	const t0 = Date.now();
	const isWorktree = isWorktreePath(opts.cwd, REPO);
	if (isWorktree) {
		try {
			ensureWorktreeDeps(opts.cwd, REPO, { workspaceAccess: opts.workspaceAccess });
		} catch (err) {
			emit({ type: "sdk_error", message: `worktree-deps guard failed: ${err instanceof Error ? err.message : String(err)}` });
		}
	}

	const systemAppend = composeSystemAppend({ isWorktree, cwd: opts.cwd, repo: REPO, planBlockActive: name === "implement" });
	const finalPrompt = `${prompt}\n\n${systemAppend}\n\n${OPENCODE_SANDBOX_APPEND}`;
	// Trailing positional `run` message (see PINNED ARGV note). spawn passes argv without a shell, so
	// the prompt needs no escaping and cannot be interpreted as flags.
	const args = ["run", "--format", "json", ...(model ? ["-m", model] : []), finalPrompt];
	// Deny-by-default env: the child gets only the allowlisted vars, never the full parent env, so a
	// prompt-injected step cannot read/echo credentials it was never given (#237 / TC-014). The
	// allowlist is provider-scoped — opencode has no direct-key contract, so no provider key var
	// reaches it at all (#276). The autonomous-permission + lsp knobs ride child-only extras,
	// never a process.env mutation.
	const scrub = makeSecretScrubber();
	const agentEnv = buildAgentEnv({
		allow: scopeEnvAllowlistToProvider(CONFIG.security.envAllowlist, "opencode"),
		extra: {
			OPENCODE_PERMISSION: JSON.stringify({ "*": "allow" }),
			OPENCODE_CONFIG_CONTENT: JSON.stringify({ lsp: true }),
		},
	});
	const child = spawn(resolveProviderBin(CONFIG, "opencode", "opencode"), args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: agentEnv });

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
	}, opencodeTimeoutMs(turns));
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
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.on("error", (err) => {
			spawnError = err;
			resolve({ code: null, signal: null });
		});
		child.on("close", (code, signal) => resolve({ code, signal }));
	});
	settled = true;
	clearTimeout(timeout);
	if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
	parseJsonlChunk(`${stdoutRest}\n`, events);

	const built = buildOpenCodeStepResult(name, events, {
		exitCode: spawnError && exit.code === 0 ? 1 : exit.code,
		signal: exit.signal,
		stderr: scrub(spawnError?.message || stderr),
		timedOut,
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
	emit({ type: "done", ok: built.result.ok, subtype: built.result.subtype, cost: built.result.cost, turns: built.result.turns, elapsed: Date.now() - t0 });
	return built.result;
};

export const opencodeProvider: StepProvider = { name: "opencode", capabilities: OPENCODE_CAPABILITIES, runStep };
