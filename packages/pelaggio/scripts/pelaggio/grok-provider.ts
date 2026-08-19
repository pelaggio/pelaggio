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
// on Landlock-less hosts — but only for key auth (#279): transparent subscription auth stages
// ~/.grok/auth.json into the private HOME and therefore requires the nested Landlock jail.
// Permission prompts remain auto-allowed because confinement is external.

import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type AcpIncomingRequest, AcpRpcError, spawnAcpAgent } from "./acp-client.js";
import { CONFIG, GROK_DEFAULT_MODEL, REPO, resolveProviderBin, resolveStepSettings, type StepSettings } from "./config.js";
import { CONTAINED_LOOPBACK_PORT, ContainedFailure, type ContainedInvocation, withContainedInvocation } from "./contained-execution.js";
import { emitDecisionsFromText } from "./decisions.js";
import type { EgressAuth } from "./egress-broker.js";
import { resolveEgressPolicy } from "./egress-policies.js";
import { buildGrokArgs, detectLandlock, GROK_SANDBOX_BLOCK } from "./grok-sandbox.js";
import { classifyStepError, isRefusal, looksLikeStalledAsk, parseBlockedReason, parseWaitFlag, resolveParkReset } from "./helpers.js";
import { makeSecretScrubber } from "./secret-hygiene.js";
import type { StepProvider } from "./step-runner.js";
import { composeSystemAppend, createStepTextProjection, EDIT_LOOP_EXEMPT_STEPS, EDIT_LOOP_THRESHOLD, isWorktreePath } from "./step-runner-shared.js";
import { MUTATING_TOOLS, toolBrief } from "./tui.js";
import type { ParkSignal, ProviderCapabilities, Step, StepEvent, StepResult, TokenUsage } from "./types.js";

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

/** The sole upstream origin enforced by the reviewed Grok 0.2.103 broker policy. */
export const GROK_EGRESS_ENDPOINT = "cli-chat-proxy.grok.com";

/**
 * Grok-provider-only prompt append. Like codex, the harness owns git + the roadmap/forge effects
 * and commits the step's work afterward; grok must stay inside its worktree and not run stateful
 * git or network CLIs. The managed Grok profile enforces the filesystem/child-network boundary.
 */
export const GROK_SANDBOX_APPEND = [
	"## Sandbox: stay in the worktree; the harness owns git and network",
	"Work only inside the current working directory (a git worktree). Git metadata is intentionally unavailable. Do NOT run git commands or network/roadmap CLIs (`gh ...`, `npx pelaggio roadmap ...`). Provider traffic is brokered through the harness; tool networking has no external route. Just create and edit files — the harness commits your work automatically after this step and owns all roadmap/forge effects.",
].join("\n");

// grok bills against a flat-rate subscription; cost is reported (via costUsdTicks, nano-USD) for the
// budget gate but is not per-token metered. Fallback rough per-token rate only if ticks are absent.
const GROK_COST_PER_INPUT_TOKEN = 0.000_003;
const GROK_COST_PER_OUTPUT_TOKEN = 0.000_015;
const GROK_CONTAINMENT_TIMEOUT_HEADROOM_MS = 10_000;

export function grokTimeoutMs(turns: number): number {
	return Math.max(10 * 60_000, Math.min(30 * 60_000, turns * 60_000));
}

/** Grok reasoning effort is high|medium|low; collapse pelaggio's finer scale onto it. */
export function grokEffort(effort: StepSettings["effort"]): "low" | "medium" | "high" {
	if (effort === "low") return "low";
	if (effort === "medium") return "medium";
	return "high";
}

/** Pick the grok model to pass with `-m` from Grok's own slot only (issue #431). Never forward a
 *  Claude id (defensive — correct routing fills `grokModel`); absence → grok CLI default. */
export function selectGrokModel(settings: Pick<StepSettings, "grokModel">): string | undefined {
	const candidate = settings.grokModel;
	return candidate && !candidate.startsWith("claude-") ? candidate : undefined;
}

export async function resolveGrokExecutable(configured: string): Promise<string> {
	if (isAbsolute(configured)) return await realpath(configured);
	for (const directory of (process.env.PATH ?? "").split(":")) {
		const candidate = join(directory, configured);
		try {
			const info = await stat(candidate);
			if (info.isFile() && (info.mode & 0o111) !== 0) return await realpath(candidate);
		} catch {
			/* continue */
		}
	}
	throw new Error(`required executable not found: ${configured}`);
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
	// Separate from `text`: the rate-limit / did-not-complete / edit-loop paths below replace
	// `text` with a diagnostic string, which would otherwise discard the model's own output.
	const projection = createStepTextProjection({ assistantSeparator: "" });
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
					projection.appendAssistant(chunk);
					emitted.push({ type: "text", content: chunk });
				}
				break;
			}
			case "tool_call": {
				const title = stringField(u, "title") || stringField(nestedObject(u, "_meta") ?? {}, "name");
				const kind = stringField(u, "kind");
				const toolName = grokToolName(title, kind);
				const input = isObject(u.rawInput) ? u.rawInput : {};
				projection.appendToolInput(input);
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

export interface GrokProviderDependencies {
	contained?: typeof withContainedInvocation;
	spawnAcp?: typeof spawnAcpAgent;
	detectSandbox?: typeof detectLandlock;
	resolveExecutable?: (configured: string) => Promise<string>;
}

interface GrokContainedValue {
	updates: JsonObject[];
	resultStopReason?: string;
	resultUsage?: JsonObject;
	driveError?: Error;
	exit: Awaited<ReturnType<typeof spawnAcpAgent>["done"]>;
}

/**
 * #279 must-fix (1): transparent subscription auth reuses the operator's own OAuth credential,
 * which the contained-execution decision limits to attended, operator-initiated, single-cycle
 * local runs — unattended execution is keys-only. This gate sits where transparent auth is
 * configured so EVERY grok dispatch path passes through it. `undefined` means the dispatch path
 * never threaded `RunStepOpts.unattendedSignals` and cannot prove attendance, so it is treated
 * as unattended, fail-closed.
 */
export function transparentAuthUnattendedRefusal(unattendedSignals: readonly string[] | undefined): string | undefined {
	const keysAlternative = "unattended Grok execution requires key auth (XAI_API_KEY via security.env-allowlist) once grok's direct-key route is implemented and reviewed";
	if (unattendedSignals === undefined) {
		return `Grok transparent subscription auth refused: this dispatch path threaded no unattended-execution evidence (RunStepOpts.unattendedSignals) and is treated as unattended, fail-closed; ${keysAlternative}`;
	}
	if (unattendedSignals.length > 0) {
		return `Grok transparent subscription auth refused: unattended-execution signals present (${unattendedSignals.join("; ")}); transparent subscription auth is limited to attended local single-cycle runs — ${keysAlternative}`;
	}
	return undefined;
}

/**
 * #279 must-fix (3): without Grok's nested Landlock sandbox, the agent's shell tools share the
 * private HOME where ~/.grok/auth.json is staged — prompt-injected code could copy the OAuth
 * credential into the writable worktree, which write-set validation would accept for later
 * checkpointing. The unsandboxed fallback is therefore safe by construction only for key auth
 * (no credential file staged); transparent subscription auth requires the jail.
 */
export function unsandboxedFallbackAuthRefusal(auth: EgressAuth): string | undefined {
	if (auth.kind !== "transparent") return undefined;
	return "Grok transparent subscription auth requires the nested Landlock sandbox: under allow-unsandboxed-fallback, unsandboxed shell tools share the private HOME with the staged ~/.grok/auth.json and could copy the OAuth credential into the checkpointed worktree; the fallback may proceed only with key auth (XAI_API_KEY), which stages no credential file";
}

function confinementResult(message: string, subtype: "error_confinement" | "error_budget", emit: Parameters<StepProvider["runStep"]>[3], startedAt: number): StepResult {
	emit({ type: "sdk_error", message });
	emit({ type: "done", ok: false, subtype, cost: 0, turns: 0, elapsed: Date.now() - startedAt });
	return { ok: false, subtype, text: message, fullText: "", assistantText: "", cost: 0, costEstimated: true, turns: 0 };
}

export function createGrokRunStep(deps: GrokProviderDependencies = {}): StepProvider["runStep"] {
	return async (name, prompt, opts, emit) => {
		const resolved = resolveStepSettings(CONFIG, opts.profile, name);
		// DriverIdentity remains provider-neutral, so a pooled Grok seat's realized model
		// arrives in executionOverride.model and must be routed into Grok's own slot.
		const settings = { ...resolved, grokModel: opts.executionOverride?.model ?? resolved.grokModel };
		const { budget, turns: baseTurns, effort } = settings;
		const turns = opts.maxTurnsOverride ?? baseTurns;
		const model = selectGrokModel(settings) ?? GROK_DEFAULT_MODEL;
		emit({ type: "step_header", name, model, budget, maxTurns: turns, prompt: opts.trace ? prompt : undefined });

		const t0 = Date.now();
		if (CONFIG.review.authoring.enabled === "keys") {
			return confinementResult("Grok key authentication is unavailable: the reviewed integrated route supports only local transparent subscription auth", "error_confinement", emit, t0);
		}
		// The reviewed integrated route supports only transparent subscription auth; grok's
		// direct-key egress route is a separately reviewed item (DIRECT_KEY_AUTH_PROVIDERS).
		const auth: EgressAuth = { kind: "transparent" };
		if (auth.kind === "transparent") {
			const unattendedRefusal = transparentAuthUnattendedRefusal(opts.unattendedSignals);
			if (unattendedRefusal) return confinementResult(unattendedRefusal, "error_confinement", emit, t0);
		}
		const isWorktree = isWorktreePath(opts.cwd, REPO);
		const systemAppend = composeSystemAppend({ isWorktree, cwd: opts.cwd, repo: REPO, planBlockActive: name === "implement" });
		const finalPrompt = `${prompt}\n\n${systemAppend}\n\n${GROK_SANDBOX_APPEND}`;
		const scrub = makeSecretScrubber();
		const sandbox = await (deps.detectSandbox ?? detectLandlock)();
		if (!sandbox && !CONFIG.grokAllowUnsandboxedFallback) {
			return confinementResult(
				"Grok's nested sandbox requires Landlock, but this Linux kernel does not expose it; set providers.grok.allow-unsandboxed-fallback: true only for a supervised run (the outer contained boundary remains mandatory)",
				"error_confinement",
				emit,
				t0,
			);
		}
		if (!sandbox) {
			const fallbackRefusal = unsandboxedFallbackAuthRefusal(auth);
			if (fallbackRefusal) return confinementResult(fallbackRefusal, "error_confinement", emit, t0);
			emit({
				type: "sdk_warning",
				message: "Landlock is unavailable; the configured supervised fallback omits only Grok's nested native sandbox. The outer systemd/bubblewrap boundary and egress broker remain mandatory.",
			});
		}
		let contained: GrokContainedValue;
		try {
			resolveEgressPolicy("grok", model);
			const executable = await (deps.resolveExecutable ?? resolveGrokExecutable)(resolveProviderBin(CONFIG, "grok", "grok"));
			const authPath = join(homedir(), ".grok", "auth.json");
			const baseUrl = `http://127.0.0.1:${CONTAINED_LOOPBACK_PORT}/v1`;
			const args = buildGrokArgs({ model, reasoningEffort: grokEffort(effort), sandbox, baseUrl });
			const timeoutMs = grokTimeoutMs(turns);
			const lifecycle = await (deps.contained ?? withContainedInvocation)(
				{
					worktree: opts.cwd,
					command: { kind: "brokered-mounted-driver", source: executable, args },
					timeoutSeconds: timeoutMs / 1000,
					egress: { provider: "grok", model, auth },
					// The credential file is staged only for transparent subscription auth; a key-auth
					// run (future direct-key route) stages nothing readable worth exfiltrating (#279).
					privateHome: [
						...(auth.kind === "transparent" ? ([{ kind: "copy", source: authPath, destination: ".grok/auth.json", mode: 0o600 }] as const) : []),
						...(sandbox ? ([{ kind: "literal", content: `${GROK_SANDBOX_BLOCK}\n`, destination: ".grok/sandbox.toml", mode: 0o600 }] as const) : []),
					],
					...(isWorktree ? { mainRepo: REPO } : {}),
					...(opts.signal ? { signal: opts.signal } : {}),
				},
				async (invocation: ContainedInvocation, terminateScope) => {
					const { conn, done } = (deps.spawnAcp ?? spawnAcpAgent)({
						bin: invocation.executable,
						args: [...invocation.argv],
						cwd: invocation.cwd,
						env: invocation.env,
						timeoutMs: timeoutMs - GROK_CONTAINMENT_TIMEOUT_HEADROOM_MS,
					});
					const updates: JsonObject[] = [];
					conn.onNotification((notification) => {
						if (!isObject(notification.params)) return;
						const update = (notification.params as JsonObject).update;
						if (isObject(update)) updates.push(update);
					});
					conn.onRequest((request) => grokServerRequestResponse(request));
					let resultStopReason: string | undefined;
					let resultUsage: JsonObject | undefined;
					let driveError: Error | undefined;
					try {
						await conn.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
						const session = (await conn.request("session/new", { cwd: opts.cwd, mcpServers: [] })) as JsonObject;
						const sessionId = stringField(session, "sessionId", "session_id");
						const response = (await conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: finalPrompt }] })) as JsonObject;
						resultStopReason = stringField(response, "stopReason", "stop_reason") || undefined;
						const meta = nestedObject(response, "_meta");
						resultUsage = (meta && nestedObject(meta, "usage")) ?? meta;
					} catch (error) {
						driveError = error instanceof AcpRpcError || error instanceof Error ? error : new Error(String(error));
					}
					await terminateScope();
					const exit = await done;
					return {
						value: { updates, ...(resultStopReason ? { resultStopReason } : {}), ...(resultUsage ? { resultUsage } : {}), ...(driveError ? { driveError } : {}), exit },
						status: driveError ? 1 : 0,
						signal: null,
						stderr: exit.stderr,
					};
				},
			);
			contained = lifecycle.value;
		} catch (error) {
			const message = `Grok contained execution failed: ${error instanceof Error ? error.message : String(error)}`;
			if (error instanceof ContainedFailure && error.reason === "rate_limit") {
				contained = { updates: [], driveError: new Error(`rate limit: ${error.message}`), exit: { code: 1, signal: null, stderr: "", timedOut: false } };
			} else {
				return confinementResult(message, error instanceof ContainedFailure && error.reason === "budget" ? "error_budget" : "error_confinement", emit, t0);
			}
		}

		const built = buildGrokStepResult(name, contained.updates, {
			...(contained.resultStopReason ? { stopReason: contained.resultStopReason } : {}),
			...(contained.resultUsage ? { resultUsage: contained.resultUsage } : {}),
			stderr: scrub(contained.exit.stderr || ""),
			timedOut: contained.exit.timedOut,
			...(contained.exit.spawnError ? { spawnError: contained.exit.spawnError } : {}),
			...(contained.driveError ? { driveError: contained.driveError } : {}),
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
}

export const runStep: StepProvider["runStep"] = createGrokRunStep();

export const grokProvider: StepProvider = { name: "grok", capabilities: GROK_CAPABILITIES, runStep };
