import type { ParseResult, Problem } from "./types.js";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CAMEL_KEY = /^[a-z][a-zA-Z0-9]*$/;
const EVENT_TYPE = /^pelaggio\.local-autopilot\.[a-z][a-z0-9.-]*$/;
const ARTIFACT_KIND = /^[a-z][a-z0-9-]*$/;
const PROBLEM_CODE = /^[a-z][a-z0-9._-]*$/;

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpaqueId(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= 128 && OPAQUE_ID.test(value);
}

export function isUtcTimestamp(value: unknown): value is string {
	return typeof value === "string" && UTC.test(value);
}

export function isSha256(value: unknown): value is string {
	return typeof value === "string" && SHA256.test(value);
}

export function isEventType(value: unknown): value is string {
	return typeof value === "string" && value.length <= 96 && EVENT_TYPE.test(value);
}

export function isArtifactKind(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && ARTIFACT_KIND.test(value);
}

export function isProblemCode(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && PROBLEM_CODE.test(value);
}

export function isNonNegativeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Runtime diagnostics enter the frozen Problem grammar here; input parsers still reject malformed wire data. */
export function makeProblem(input: Omit<Problem, "schemaVersion">): Problem {
	const mapped = input.code
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z]+/, "")
		.slice(0, 64);
	let message = "";
	let length = 0;
	for (const point of input.message) {
		if (length++ === 2000) break;
		message += point;
	}
	return { schemaVersion: 1, type: input.type, code: mapped || "runtime-problem", message: message || "No diagnostic message was supplied", retryable: input.retryable, ...(isOpaqueId(input.runId) ? { runId: input.runId } : {}) };
}

export function protocolProblem(code: string, message: string): Problem {
	return makeProblem({ type: "protocol", code, message, retryable: false });
}

export function configProblem(code: string, message: string): Problem {
	return makeProblem({ type: "config", code, message, retryable: false });
}

export function conflictProblem(code: string, message: string): Problem {
	return makeProblem({ type: "conflict", code, message, retryable: false });
}

/** Inputs reject unknown fields. Every own key must be in `allowed`. */
export function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): ParseResult<Record<string, unknown>> {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) return { ok: false, problem: protocolProblem("unknown-field", `${label} rejects unknown field "${key}"`) };
	}
	return { ok: true, value };
}

export function requireCamelCaseKeys(value: Record<string, unknown>, label: string): ParseResult<Record<string, unknown>> {
	for (const key of Object.keys(value)) {
		if (!CAMEL_KEY.test(key)) return { ok: false, problem: protocolProblem("field-name", `${label} field "${key}" must be camelCase`) };
	}
	return { ok: true, value };
}

/** Drop keys whose value is `undefined`. Used when encoding JSON stdout. */
export function omitUndefined<T extends Record<string, unknown>>(value: T): T {
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value)) {
		if (v !== undefined) out[key] = v;
	}
	return out as T;
}

/**
 * `--json` writes exactly one schema-valid object to stdout, with a trailing newline
 * and no pretty-print whitespace that would invite a second value.
 */
export function encodeJsonStdout(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

export function looksLikeAnsi(text: string): boolean {
	return text.includes("\u001b[");
}
