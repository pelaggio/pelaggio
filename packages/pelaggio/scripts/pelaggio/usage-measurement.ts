import { randomUUID } from "node:crypto";

export type PromptBoundary = "dispatcher-input" | "adapter-assembled";

/** Diagnostic measurements only. Budget/quota accounting continues to use its existing inputs. */
export interface UsageMeasurement {
	schemaVersion: 1;
	observationId?: string;
	basis: "claude-sdk-v1" | "codex-cli-v1" | "unverified";
	/** Total input includes cache reads and writes; breakdowns must never be added to it. */
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
	/** UTF-8 bytes supplied by the harness, not the full provider-managed context. */
	promptBytes?: number;
	promptBoundary?: PromptBoundary;
	/** Numeric evidence retained when the provider's overlap semantics are not established. */
	rawCounters?: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "reasoning", number>>;
}

const COUNTERS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "promptBytes"] as const;
const RAW_COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Copy only bounded numeric metadata. Unknown versions, text, and raw provider payloads stay out. */
export function readUsageMeasurement(value: unknown): UsageMeasurement | undefined {
	const row = object(value);
	if (row.schemaVersion !== 1 || typeof row.basis !== "string" || !["claude-sdk-v1", "codex-cli-v1", "unverified"].includes(row.basis)) return undefined;
	const out: UsageMeasurement = { schemaVersion: 1, basis: row.basis as UsageMeasurement["basis"] };
	if (typeof row.observationId === "string" && /^[a-f0-9-]{36}$/.test(row.observationId)) out.observationId = row.observationId;
	for (const key of COUNTERS) {
		const n = count(row[key]);
		if (n !== undefined && (out.basis !== "unverified" || key === "promptBytes")) out[key] = n;
	}
	if (out.promptBytes !== undefined && (row.promptBoundary === "dispatcher-input" || row.promptBoundary === "adapter-assembled")) out.promptBoundary = row.promptBoundary;
	const raw = object(row.rawCounters);
	for (const key of RAW_COUNTERS) {
		const n = count(raw[key]);
		if (n !== undefined) {
			out.rawCounters ??= {};
			out.rawCounters[key] = n;
		}
	}
	// Inconsistent breakdowns are unavailable, never a >100% cache ratio.
	if (out.inputTokens !== undefined) {
		if ((out.cacheReadTokens ?? 0) + (out.cacheWriteTokens ?? 0) > out.inputTokens) {
			delete out.cacheReadTokens;
			delete out.cacheWriteTokens;
		}
	}
	if (out.outputTokens !== undefined && (out.reasoningTokens ?? 0) > out.outputTokens) delete out.reasoningTokens;
	return out;
}

/** Native numeric counters, before legacy adapter coercion/default-zero/cost estimation. */
export function measureUsage(provider: string, value: unknown): UsageMeasurement {
	const u = object(value);
	const cache = object(u.cache);
	const input = count(u.input_tokens ?? u.inputTokens ?? u.input);
	const output = count(u.output_tokens ?? u.outputTokens ?? u.output);
	const read = count(u.cache_read_input_tokens ?? u.cached_input_tokens ?? u.cachedInputTokens ?? u.cachedReadTokens ?? u.cached_read_tokens ?? cache.read);
	const write = count(u.cache_creation_input_tokens ?? u.cacheWrite ?? u.cache_write_tokens ?? cache.write);
	const reasoning = count(u.reasoning_output_tokens ?? u.reasoningOutputTokens ?? u.reasoningTokens ?? u.reasoning_tokens ?? u.reasoning);
	const rawCounters = { input, output, cacheRead: read, cacheWrite: write, reasoning };
	let out: UsageMeasurement;
	if (provider === "claude") {
		// Claude reports uncached input separately. Do not assume absent cache counters are zero.
		const total = input !== undefined && read !== undefined && write !== undefined ? count(input + read + write) : undefined;
		out = { schemaVersion: 1, basis: "claude-sdk-v1", inputTokens: total, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write };
	} else if (provider === "codex") {
		out = { schemaVersion: 1, basis: "codex-cli-v1", inputTokens: input, outputTokens: output, cacheReadTokens: read, reasoningTokens: reasoning };
	} else {
		// Retain facts without guessing how this provider combines cache/reasoning counters.
		out = { schemaVersion: 1, basis: "unverified", rawCounters };
	}
	return readUsageMeasurement(out) ?? { schemaVersion: 1, basis: "unverified" };
}

export function measurePrompt(prompt: string, promptBoundary: PromptBoundary, usage?: UsageMeasurement): UsageMeasurement {
	return { ...(readUsageMeasurement(usage) ?? { schemaVersion: 1, basis: "unverified" }), observationId: randomUUID(), promptBytes: Buffer.byteLength(prompt, "utf8"), promptBoundary };
}

/** Measurement availability must never decide whether a consumer harness runs. */
export function measurePromptSafely(prompt: string, boundary: PromptBoundary): UsageMeasurement | undefined {
	try {
		return measurePrompt(prompt, boundary);
	} catch {
		return undefined;
	}
}
