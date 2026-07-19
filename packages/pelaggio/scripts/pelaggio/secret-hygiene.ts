// Secret hygiene for spawned driver subprocesses (issue #237 / TC-014).
//
// Two complementary defenses so a prompt-injected agent step cannot exfiltrate credentials:
//   1. buildAgentEnv()  — deny-by-default env allowlist: a child gets PATH/HOME + an explicit
//      allowlist, NOT the whole parent `process.env`. So `echo $SOME_SECRET` finds nothing.
//   2. scrubSecrets()    — redact-before-write: credential-shaped strings and the values of
//      secret-named parent env vars are replaced with a marker before any log/stderr write, so
//      a secret the model echoes (or a driver logs, e.g. grok's cleartext JWT) never lands on disk.
//
// Both are best-effort defense-in-depth, not a secrets broker (that is #176). The env allowlist
// is the primary control; scrubbing is the backstop for what still reaches a log stream.

export const REDACTED = "[REDACTED]";

/** Env vars a driver subprocess legitimately needs regardless of provider. Deny-by-default: only
 *  these (plus caller/config additions) are forwarded. HOME is required — codex/grok read auth
 *  from `~/.codex` / `~/.grok/auth.json`; PATH is required to resolve the binary and its tools. */
export const DEFAULT_AGENT_ENV_ALLOWLIST: readonly string[] = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"TMPDIR",
	"TZ",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
];

export interface BuildAgentEnvOptions {
	/** Extra var names to forward beyond the default allowlist — e.g. a driver's auth var
	 *  (`OPENAI_API_KEY`, `XAI_API_KEY`) when the operator uses key auth instead of a subscription
	 *  login. Sourced from `security.env-allowlist` in config. */
	allow?: readonly string[];
	/** Explicit key=value pairs to set on the child (override any allowlisted value). */
	extra?: Record<string, string>;
	/** Env to draw from; defaults to `process.env`. Injectable for tests. */
	source?: NodeJS.ProcessEnv;
}

/**
 * Construct a minimal, allowlisted environment for a spawned driver subprocess. Every var not on
 * the (default + caller + config) allowlist is dropped — the child never inherits the full parent
 * env, so credentials it was never given cannot be read or echoed out.
 */
export function buildAgentEnv(opts: BuildAgentEnvOptions = {}): NodeJS.ProcessEnv {
	const source = opts.source ?? process.env;
	const allow = new Set<string>([...DEFAULT_AGENT_ENV_ALLOWLIST, ...(opts.allow ?? [])]);
	const env: NodeJS.ProcessEnv = {};
	for (const key of allow) {
		const value = source[key];
		if (value !== undefined) env[key] = value;
	}
	if (opts.extra) for (const [k, v] of Object.entries(opts.extra)) env[k] = v;
	return env;
}

// Credential-shaped patterns. Ordered high-specificity first; each match becomes REDACTED.
const SECRET_PATTERNS: readonly RegExp[] = [
	/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT (e.g. grok OAuth) — three base64url segments
	/\bxai-[A-Za-z0-9]{16,}/g, // xAI API key
	/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, // OpenAI-style secret key
	/\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
	/\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab PAT
	/\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack token
	/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g, // Bearer <token>
];

/** Names whose *value* should be treated as a secret and redacted from logs wherever it appears.
 *  Matches the common credential suffixes/infixes (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, …). */
const SECRET_NAME = /(?:_|^)(?:API[_-]?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|SESSION)$/i;

/** Collect the values of secret-named env vars, so their literal values can be scrubbed from logs
 *  even when they don't match a known credential pattern. Short values (<6 chars) are ignored to
 *  avoid redacting incidental substrings. */
export function collectSecretEnvValues(source: NodeJS.ProcessEnv = process.env): string[] {
	const values: string[] = [];
	for (const [name, value] of Object.entries(source)) {
		if (value && value.length >= 6 && SECRET_NAME.test(name)) values.push(value);
	}
	return values;
}

export interface ScrubOptions {
	/** Literal secret values to redact by exact substring match (e.g. from {@link collectSecretEnvValues}). */
	secretValues?: readonly string[];
}

/**
 * Redact credential-shaped strings and any provided literal secret values from `text`. Idempotent
 * and safe on already-redacted text. Redact literal values first (longest-first, so a value that
 * contains another is fully covered) then apply the pattern set.
 */
export function scrubSecrets(text: string, opts: ScrubOptions = {}): string {
	if (!text) return text;
	let out = text;
	const values = [...(opts.secretValues ?? [])].filter((v) => v.length >= 6).sort((a, b) => b.length - a.length);
	for (const value of values) out = out.split(value).join(REDACTED);
	for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
	return out;
}

/**
 * Build a reusable scrubber closed over the current process's secret env values. Callers apply it
 * at every log/stderr write site (redact-before-write). Collect once at construction so the
 * per-line cost is just the replace passes.
 */
export function makeSecretScrubber(source: NodeJS.ProcessEnv = process.env): (text: string) => string {
	const secretValues = collectSecretEnvValues(source);
	return (text: string): string => scrubSecrets(text, { secretValues });
}
