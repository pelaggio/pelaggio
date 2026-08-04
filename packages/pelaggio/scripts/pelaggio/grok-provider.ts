// Grok provider (issue #136): drives `grok agent stdio` over the ACP client (#239).
//
// Mirrors codex-provider's shape — a pure `buildGrokStepResult` that maps the accumulated ACP
// `session/update` stream + the `session/prompt` result into a StepResult/StepEvent set, and an
// async `runStep` that owns the subprocess + protocol lifecycle. Grok speaks ACP (JSON-RPC over
// stdio), NOT a one-shot JSON stream, because the `-p` surface omits tool-call/file-change events
// (#238); the ACP `session/update` stream carries them. See docs/agent-context/acp-grok-protocol.md.
//
// Confinement note: every run explicitly requests Pelaggio's fail-closed custom Grok profile when
// Landlock is available. A config-gated fallback exists for externally contained, supervised runs
// on Landlock-less hosts. Permission prompts remain auto-allowed because confinement is external.

import { type AcpIncomingRequest, AcpRpcError, spawnAcpAgent } from "./acp-client.js";
import { CONFIG, REPO, resolveProviderBin, resolveStepSettings, type StepSettings } from "./config.js";
import { buildGrokArgs, detectLandlock, installGrokSandboxProfile } from "./grok-sandbox.js";
import { classifyStepError, isRefusal, looksLikeStalledAsk, parseBlockedReason, parseDecisions, parseWaitFlag, resolveParkReset } from "./helpers.js";
import { buildAgentEnv, makeSecretScrubber } from "./secret-hygiene.js";
import type { StepProvider } from "./step-runner.js";
import { composeSystemAppend, EDIT_LOOP_EXEMPT_STEPS, EDIT_LOOP_THRESHOLD, isWorktreePath } from "./step-runner-shared.js";
import { MUTATING_TOOLS, toolBrief } from "./tui.js";
import type { ParkSignal, ProviderCapabilities, Step, StepEvent, StepResult, TokenUsage } from "./types.js";
import { ensureWorktreeDeps } from "./worktree-deps.js";

/**
 * Grok: Landlock isolation when declared native, pool-quota ticks (token-price fallback
 * degraded), cache counters, ACP stream. No semantic deny; no session resume.
 */
export function grokCapabilities(allowUnsandboxedFallback: boolean): ProviderCapabilities {
	return {
		semanticDeny: false,
		// Enabling fallback means a run may be unsandboxed, so it cannot honestly satisfy
		// a hard Landlock route. With fallback disabled, missing Landlock fails execution closed.
		isolation: allowUnsandboxedFallback ? [] : ["landlock"],
		costMeter: { kind: "pool-quota", estimateFallback: "degraded" },
		cacheReporting: true,
		outputTransport: "stream",
		sessionResume: false,
	};
}

export const GROK_CAPABILITIES = grokCapabilities(CONFIG.grokAllowUnsandboxedFallback);

type JsonObject = Record<string, unknown>;

/** The sole in-process operational destination observed in the Grok 0.2.103 live capture. Grok's
 * custom profile cannot express an L7 allowlist; release conformance locks this assumption. */
export const GROK_EGRESS_ENDPOINT = "cli-chat-proxy.grok.com";

/**
 * Grok-provider-only prompt append. Like codex, the harness owns git + the roadmap/forge effects
 * and commits the step's work afterward; grok must stay inside its worktree and not run stateful
 * git or network CLIs. The managed Grok profile enforces the filesystem/child-network boundary.
 */
export const GROK_SANDBOX_APPEND = [
	"## Sandbox: stay in the worktree; the harness owns git and network",
	"Work only inside the current working directory (a git worktree). Do NOT run stateful git commands (`git add`, `commit`, `rm`, `restore`, `checkout`, `stash`, `push`, `merge`) and do NOT run network/roadmap CLIs (`gh ...`, `npx pelaggio roadmap ...`). Just create and edit files — the harness commits your work automatically after this step and owns all roadmap/forge effects. Read-only git (`git status`/`diff`/`log`/`show`) is fine.",
].join("\n");

// grok bills against a flat-rate subscription; cost is reported (via costUsdTicks, nano-USD) for the
// budget gate but is not per-token metered. Fallback rough per-token rate only if ticks are absent.
const GROK_COST_PER_INPUT_TOKEN = 0.000_003;
const GROK_COST_PER_OUTPUT_TOKEN = 0.000_015;

export function grokTimeoutMs(turns: number): number {
	// Grok runs a prompt autonomously to completion; we can't cap internal turns, so bound by wall
	// clock like codex (10–90 min, proportional to the step's turn budget).
	return Math.max(10 * 60_000, Math.min(90 * 60_000, turns * 60_000));
}

/** Grok reasoning effort is high|medium|low; collapse pelaggio's finer scale onto it. */
export function grokEffort(effort: StepSettings["effort"]): "low" | "medium" | "high" {
	if (effort === "low") return "low";
	if (effort === "medium") return "medium";
	return "high";
}

/** Pick the grok model to pass with `-m`. Never forward a Claude id; absence → grok CLI default. */
export function selectGrokModel(settings: Pick<StepSettings, "model" | "codexModel">): string | undefined {
	const candidate = settings.model ?? settings.codexModel;
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

/** The discriminant on an ACP `session/update` payload (`agent_message_chunk`, `tool_call`, …). */
function updateKind(u: JsonObject): string {
	return stringField(u, "sessionUpdate");
}

/** Map a grok tool title/kind onto a pelaggio display tool name (for the TUI; not load-bearing). */
function grokToolName(title: string, kind: string): string {
	const t = `${title} ${kind}`.toLowerCase();
	if (/shell|bash|command|exec|terminal/.test(t)) return "Bash";
	if (/create|write|edit|str_replace|patch|apply/.test(t)) return "Edit";
	if (/read|cat|open|view/.test(t)) return "Read";
	if (/search|grep|find|glob/.test(t)) return "Grep";
	if (/web|fetch|browse/.test(t)) return "Grep";
	if (/mcp|agent|task|subagent/.test(t)) return "Agent";
	return title || kind || "Grok";
}

/** File paths touched by a tool_call / tool_call_update, from its ACP `locations`. */
function updateLocations(u: JsonObject): string[] {
	const locs = u.locations;
	if (!Array.isArray(locs)) return [];
	return locs.map((l) => (isObject(l) ? stringField(l, "path", "file_path", "filePath") : typeof l === "string" ? l : "")).filter(Boolean);
}

function tokensFromUsage(usage: JsonObject | undefined): TokenUsage | undefined {
	if (!usage) return undefined;
	return {
		input: Number(usage.inputTokens ?? usage.input_tokens ?? 0) || 0,
		output: (Number(usage.outputTokens ?? usage.output_tokens ?? 0) || 0) + (Number(usage.reasoningTokens ?? usage.reasoning_tokens ?? 0) || 0),
		cacheCreation: 0,
		cacheRead: Number(usage.cachedReadTokens ?? usage.cached_read_tokens ?? 0) || 0,
	};
}

function costFromUsage(usage: JsonObject | undefined, tokens: TokenUsage | undefined): number {
	const ticks = usage ? Number(usage.costUsdTicks ?? usage.cost_usd_ticks ?? 0) : 0;
	if (ticks > 0) return ticks / 1e9; // grok reports cost in nano-USD ticks
	if (!tokens) return 0;
	return (tokens.input + tokens.cacheRead) * GROK_COST_PER_INPUT_TOKEN + tokens.output * GROK_COST_PER_OUTPUT_TOKEN;
}

function rateLimitText(errorText: string): boolean {
	return /\b429\b|rate.?limit|usage.?limit|quota|limit exceeded/i.test(errorText);
}

export interface GrokExitInfo {
	/** stopReason from the `session/prompt` result (`end_turn`, `max_tokens`, `refusal`, …). */
	stopReason?: string;
	/** `_meta.usage` from the `session/prompt` result, if the turn_completed stream didn't carry it. */
	resultUsage?: JsonObject;
	stderr?: string;
	timedOut?: boolean;
	spawnError?: Error;
	driveError?: Error;
	now?: number;
	unknownResetWaitMs?: number;
}

export interface GrokBuildResult {
	result: StepResult;
	parkUpdate?: Partial<ParkSignal>;
	events: StepEvent[];
}

/**
 * Pure: fold the accumulated ACP `session/update` payloads + the prompt result into a StepResult.
 * Kept side-effect-free and exported so it can be unit-tested against captured update fixtures with
 * no live grok — mirroring `buildCodexStepResult`.
 */
export function buildGrokStepResult(name: Step, updates: JsonObject[], exitInfo: GrokExitInfo): GrokBuildResult {
	const emitted: StepEvent[] = [];
	let text = "";
	let fullText = "";
	let turns = 0;
	let sawTurn = false;
	let usage: JsonObject | undefined;
	let streamStopReason: string | undefined;
	let loopFile: string | null = null;
	const editCounts = new Map<string, number>();
	const toolCounts = new Map<string, number>();

	for (const u of updates) {
		switch (updateKind(u)) {
			case "agent_message_chunk": {
				const chunk = contentText(u.content);
				if (chunk) {
					text += chunk;
					fullText += chunk;
					emitted.push({ type: "text", content: chunk });
				}
				break;
			}
			case "tool_call": {
				const title = stringField(u, "title") || stringField(nestedObject(u, "_meta") ?? {}, "name");
				const kind = stringField(u, "kind");
				const toolName = grokToolName(title, kind);
				const input = isObject(u.rawInput) ? u.rawInput : {};
				increment(toolCounts, toolName);
				emitted.push({ type: "tool_use", name: toolName, brief: toolBrief(toolName, input) || title, mutating: MUTATING_TOOLS.has(toolName) });
				for (const fp of updateLocations(u)) trackEdit(fp);
				break;
			}
			case "tool_call_update": {
				const status = stringField(u, "status");
				for (const fp of updateLocations(u)) trackEdit(fp);
				if (status === "failed") {
					const title = stringField(u, "title");
					const errText = contentText(u.content) || stringField(u, "rawOutput") || `tool ${title || "call"} failed`;
					emitted.push({ type: "tool_error", name: grokToolName(title, stringField(u, "kind")), brief: title, error: errText });
				}
				break;
			}
			case "turn_completed": {
				sawTurn = true;
				turns++;
				const tu = nestedObject(u, "usage");
				if (tu) usage = tu;
				streamStopReason = stringField(u, "stop_reason", "stopReason") || streamStopReason;
				break;
			}
		}
	}

	function trackEdit(fp: string): void {
		if (!fp || EDIT_LOOP_EXEMPT_STEPS.has(name)) return;
		const count = increment(editCounts, fp);
		if (count >= EDIT_LOOP_THRESHOLD && !loopFile) {
			loopFile = fp;
			emitted.push({ type: "edit_loop", file: fp, count });
		}
	}

	usage = usage ?? exitInfo.resultUsage;
	const stopReason = exitInfo.stopReason || streamStopReason;
	// grok's modelCalls is the closest analogue to pelaggio "turns"; else the turn_completed count.
	turns = Number(usage?.modelCalls ?? usage?.model_calls ?? 0) || turns || (sawTurn ? turns : 1);
	const tokens = tokensFromUsage(usage);
	const cost = costFromUsage(usage, tokens);
	text = text.trim();

	const driveMsg = exitInfo.spawnError?.message || exitInfo.driveError?.message || exitInfo.stderr || "";
	const completedCleanly = stopReason !== undefined && !exitInfo.spawnError && !exitInfo.driveError;
	let ok = completedCleanly && stopReason === "end_turn" && !exitInfo.timedOut;
	let subtype = ok ? "success" : "error_sdk";
	let parkUpdate: Partial<ParkSignal> | undefined;

	if (exitInfo.timedOut) {
		ok = false;
		subtype = "error_max_turns";
		text = text || `Grok step timed out after ${turns} turns`;
	} else if (!completedCleanly && rateLimitText(driveMsg)) {
		ok = false;
		subtype = "error_rate_limit";
		text = driveMsg || "Grok rate limit";
		const resolved = resolveParkReset(0, true, "", driveMsg, exitInfo.now ?? Date.now(), exitInfo.unknownResetWaitMs ?? parseWaitFlag(CONFIG.park.unknownResetWait));
		parkUpdate = { parked: true, resetsAt: resolved.resetsAt, limitType: resolved.limitType };
		emitted.push({ type: "rate_limit", limitType: resolved.limitType, resetsAt: resolved.resetsAt });
	} else if (!completedCleanly) {
		ok = false;
		subtype = classifyStepError(driveMsg, false);
		text = text || driveMsg || "Grok step did not complete";
		emitted.push({ type: "sdk_error", message: driveMsg || "grok did not return a stop reason" });
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
			emitted.push({ type: "stalled_ask", tail: text.replace(/\s+$/, "").slice(-160) });
		}
	}

	const stalledAsk = ok && looksLikeStalledAsk(text);
	const outputTail = text ? text.replace(/\x1b\[[0-9;]*m/g, "").slice(-200) : undefined;
	const decisions = parseDecisions(fullText);
	for (const decision of decisions) emitted.push({ type: "decision", decision });
	const toolCountsObj = toolCounts.size > 0 ? Object.fromEntries(toolCounts) : undefined;
	return {
		result: {
			ok,
			subtype,
			text,
			fullText,
			// grok's `text` accumulates agent_message chunks only — no tool data — so it is the
			// assistant text verbatim.
			assistantText: text,
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

function increment(map: Map<string, number>, key: string): number {
	const next = (map.get(key) ?? 0) + 1;
	map.set(key, next);
	return next;
}

/** Auto-answer an ACP server→client request. For a permission prompt, select an allow option so the
 *  run proceeds unattended (confinement is enforced by cwd/sandbox, not by declining). */
export function grokServerRequestResponse(req: AcpIncomingRequest): unknown {
	if (req.method !== "session/request_permission") return {};
	const params = isObject(req.params) ? req.params : {};
	const options = Array.isArray(params.options) ? params.options.filter(isObject) : [];
	const label = (o: JsonObject): string => `${stringField(o, "optionId", "id")} ${stringField(o, "kind")} ${stringField(o, "name")}`.toLowerCase();
	const pick = options.find((o) => /allow.?always|always/.test(label(o))) ?? options.find((o) => /allow|accept|approve|yes|proceed/.test(label(o))) ?? options.find((o) => !/reject|deny|cancel|abort|\bno\b/.test(label(o))) ?? options[0];
	const optionId = pick ? (pick.optionId ?? pick.id ?? pick.name) : undefined;
	return { outcome: { outcome: "selected", optionId } };
}

export const runStep: StepProvider["runStep"] = async (name, prompt, opts, emit) => {
	const resolved = resolveStepSettings(CONFIG, opts.profile, name);
	const settings = { ...resolved, model: opts.executionOverride?.model ?? resolved.model, codexModel: opts.executionOverride?.codexModel ?? resolved.codexModel };
	const { budget, turns: baseTurns, effort } = settings;
	const turns = opts.maxTurnsOverride ?? baseTurns;
	const model = selectGrokModel(settings);
	emit({ type: "step_header", name, model: model ?? "default", budget, maxTurns: turns, prompt: opts.trace ? prompt : undefined });

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
	const finalPrompt = `${prompt}\n\n${systemAppend}\n\n${GROK_SANDBOX_APPEND}`;
	const scrub = makeSecretScrubber();
	const agentEnv = buildAgentEnv({ allow: CONFIG.security.envAllowlist });
	const sandbox = await detectLandlock();
	if (!sandbox && !CONFIG.grokAllowUnsandboxedFallback) {
		const message = "Grok sandbox requires Landlock, but this Linux kernel does not expose it; set providers.grok.allow-unsandboxed-fallback: true only for a supervised run with an external containment boundary";
		emit({ type: "sdk_error", message });
		emit({ type: "done", ok: false, subtype: "error_confinement", cost: 0, turns: 0, elapsed: Date.now() - t0 });
		return { ok: false, subtype: "error_confinement", text: message, fullText: "", assistantText: "", cost: 0, costEstimated: true, turns: 0 };
	}
	if (sandbox) {
		try {
			await installGrokSandboxProfile({ home: agentEnv.HOME });
		} catch (error) {
			const message = `Grok sandbox profile preparation failed: ${error instanceof Error ? error.message : String(error)}`;
			emit({ type: "sdk_error", message });
			emit({ type: "done", ok: false, subtype: "error_confinement", cost: 0, turns: 0, elapsed: Date.now() - t0 });
			return { ok: false, subtype: "error_confinement", text: message, fullText: "", assistantText: "", cost: 0, costEstimated: true, turns: 0 };
		}
	} else {
		emit({
			type: "sdk_warning",
			message: "Landlock is unavailable; providers.grok.allow-unsandboxed-fallback is enabled, so Grok is starting without its CLI sandbox. Only deny-env and cwd guidance protect this supervised run until Pelaggio's host-side jail is wired.",
		});
	}
	const args = buildGrokArgs({ ...(model ? { model } : {}), reasoningEffort: grokEffort(effort), sandbox });
	const { conn, done, kill } = spawnAcpAgent({
		bin: resolveProviderBin(CONFIG, "grok", "grok"),
		args,
		cwd: opts.cwd,
		env: agentEnv,
		timeoutMs: grokTimeoutMs(turns),
		...(opts.signal ? { signal: opts.signal } : {}),
	});

	const updates: JsonObject[] = [];
	conn.onNotification((n) => {
		if (!isObject(n.params)) return;
		const u = (n.params as JsonObject).update;
		if (isObject(u)) updates.push(u);
	});
	conn.onRequest((req) => grokServerRequestResponse(req));

	let resultStopReason: string | undefined;
	let resultUsage: JsonObject | undefined;
	let driveError: Error | undefined;
	try {
		await conn.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
		const sess = (await conn.request("session/new", { cwd: opts.cwd, mcpServers: [] })) as JsonObject;
		const sessionId = stringField(sess, "sessionId", "session_id");
		const res = (await conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: finalPrompt }] })) as JsonObject;
		resultStopReason = stringField(res, "stopReason", "stop_reason") || undefined;
		const meta = nestedObject(res, "_meta");
		resultUsage = (meta && nestedObject(meta, "usage")) ?? meta;
	} catch (err) {
		driveError = err instanceof AcpRpcError || err instanceof Error ? err : new Error(String(err));
	}

	kill();
	const exit = await done;

	const built = buildGrokStepResult(name, updates, {
		...(resultStopReason ? { stopReason: resultStopReason } : {}),
		...(resultUsage ? { resultUsage } : {}),
		stderr: scrub(exit.stderr || ""),
		timedOut: exit.timedOut,
		...(exit.spawnError ? { spawnError: exit.spawnError } : {}),
		...(driveError ? { driveError } : {}),
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

export const grokProvider: StepProvider = { name: "grok", capabilities: GROK_CAPABILITIES, runStep };
