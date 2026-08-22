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

import type { ProviderName } from "./types.js";

export const REDACTED = "[REDACTED]";

/** Canonical provider → direct-key env var contract. Single source shared by keys-mode seat
 *  validation (provider-routing) and per-launch allowlist scoping below, so the two can never
 *  disagree. Claude's SDK consumes its key in-process; it is listed so subprocess providers
 *  never receive it. */
export const PROVIDER_KEY_ENV: Readonly<Partial<Record<ProviderName, string>>> = {
	claude: "ANTHROPIC_API_KEY",
	codex: "OPENAI_API_KEY",
	grok: "XAI_API_KEY",
};

/**
 * Scope the configured `security.env-allowlist` to one subprocess provider: every OTHER
 * provider's key var is stripped, so a multi-provider run (e.g. a codex+grok review panel)
 * never hands one untrusted seat a sibling provider's credential. Fail-closed nuance: the
 * launched provider's OWN key still passes through, and non-key allowlist entries are
 * unaffected. A provider with no key contract (opencode) receives no provider key at all.
 */
export function scopeEnvAllowlistToProvider(allowlist: readonly string[], provider: ProviderName): string[] {
	const foreignKeys = new Set(
		Object.entries(PROVIDER_KEY_ENV)
			.filter(([name]) => name !== provider)
			.map(([, key]) => key),
	);
	return allowlist.filter((name) => !foreignKeys.has(name));
}

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
	// Proxy endpoints are network configuration, not credentials — dropping them strands
	// proxied operators while the cert vars above pass, so they ride the same default list.
	// URL-valued proxy vars are additionally VALUE-conditional in buildAgentEnv: a value
	// carrying URL userinfo credentials (or an unparseable value) is not forwarded by default.
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
];

/** Proxy vars whose value is a URL and can therefore embed credentials as userinfo.
 *  NO_PROXY/no_proxy is a host list, never a URL — it stays unconditional. */
const PROXY_URL_ENV_NAMES = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]);

/**
 * Best-effort userinfo of a proxy URL value, hardened against scheme-relative
 * (`//user:pass@host`) and slash-collapsed (`http:///user:pass@host`) forms: strip any
 * scheme plus ALL leading slashes, then take everything before the first `@`. Returns
 * `undefined` only for values with no `@` at all — a proxy URL has no legitimate
 * credential-free `@`, so callers treat ANY non-undefined result as credentialed
 * (conservative: an `@` we cannot positively clear is a credential).
 */
function proxyUrlUserinfo(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed.includes("@")) return undefined;
	// Strip a scheme only when slash-delimited so a scheme-less `user:pass@host` keeps its
	// full userinfo; then strip ALL leading slashes (collapsed-slash and scheme-relative forms).
	const authority = trimmed.replace(/^[A-Za-z][A-Za-z0-9+.-]*:(?=\/\/)/, "").replace(/^\/+/, "");
	return authority.split("@", 1)[0] ?? "";
}

/** Classify a URL-valued proxy var for default forwarding. Scheme-less values (`proxy.corp:3128`)
 *  are normalized before parsing so common credential-less forms keep flowing; any value
 *  containing an `@` is conservatively treated as credential-carrying. */
export function classifyProxyValue(value: string): "forward" | "credentialed" | "unparseable" {
	const trimmed = value.trim();
	if (trimmed === "") return "forward";
	if (proxyUrlUserinfo(trimmed) !== undefined) return "credentialed";
	try {
		// Side-effect-free parse for well-formedness only.
		new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
		return "forward";
	} catch {
		return "unparseable";
	}
}

export interface BuildAgentEnvOptions {
	/** Extra var names to forward beyond the default allowlist — e.g. a driver's auth var
	 *  (`OPENAI_API_KEY`, `XAI_API_KEY`) when the operator uses key auth instead of a subscription
	 *  login. Sourced from `security.env-allowlist` in config. */
	allow?: readonly string[];
	/** Explicit key=value pairs to set on the child (override any allowlisted value). */
	extra?: Record<string, string>;
	/** Env to draw from; defaults to `process.env`. Injectable for tests. */
	source?: NodeJS.ProcessEnv;
	/** Suppress the dropped-proxy / relative-XDG stderr diagnostics. The Claude seat builds its
	 *  env twice per step (preflight probe + spawn); the preflight build sets this so the drop
	 *  warning prints once per step, not twice. */
	quiet?: boolean;
}

/**
 * Construct a minimal, allowlisted environment for a spawned driver subprocess. Every var not on
 * the (default + caller + config) allowlist is dropped — the child never inherits the full parent
 * env, so credentials it was never given cannot be read or echoed out.
 */
export function buildAgentEnv(opts: BuildAgentEnvOptions = {}): NodeJS.ProcessEnv {
	const source = opts.source ?? process.env;
	const callerAllow = new Set<string>(opts.allow ?? []);
	const allow = new Set<string>([...DEFAULT_AGENT_ENV_ALLOWLIST, ...callerAllow]);
	const env: NodeJS.ProcessEnv = {};
	for (const key of allow) {
		const value = source[key];
		if (value === undefined) continue;
		// Default proxy forwarding is VALUE-conditional: URL userinfo commonly carries proxy
		// credentials, so a credentialed (or unparseable) value is dropped fail-closed unless
		// the operator explicitly opted the name in via security.env-allowlist. The scrubber
		// registers the credential either way (collectSecretEnvValues).
		if (PROXY_URL_ENV_NAMES.has(key) && !callerAllow.has(key)) {
			const verdict = classifyProxyValue(value);
			if (verdict !== "forward") {
				if (!opts.quiet)
					process.stderr.write(
						`⚠ not forwarding ${key} to the agent subprocess (${verdict === "credentialed" ? "its URL userinfo carries proxy credentials" : "its value is not a parseable proxy URL"}); add ${key} to security.env-allowlist to forward it anyway\n`,
					);
				continue;
			}
		}
		// XDG basedir rule: a relative XDG_CONFIG_HOME is invalid and ignored. The Claude seat
		// already skips it for gh-config masking; forwarding it would let the child honor a
		// directory the mask ignored, so it is skipped here under the same rule.
		if (key === "XDG_CONFIG_HOME" && value !== "" && !value.startsWith("/")) {
			if (!opts.quiet) process.stderr.write(`⚠ not forwarding relative XDG_CONFIG_HOME ${JSON.stringify(value)} to the agent subprocess (XDG requires absolute paths)\n`);
			continue;
		}
		env[key] = value;
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
/** Bare (colonless) proxy userinfo is treated as a token only past this length; shorter bare
 *  userinfo (a human username like "operator") is not registered unless the proxy was
 *  explicitly forwarded (allowlisted). Password-bearing userinfo is always a secret. */
const MIN_BARE_PROXY_TOKEN_LENGTH = 12;

export interface CollectSecretEnvOptions {
	/** Proxy var NAMES the operator explicitly forwarded via `security.env-allowlist`. An
	 *  allowlisted credentialed proxy's userinfo is sensitive by definition, so its FULL
	 *  userinfo (colon or not, any length) is registered even without a password component.
	 *  Defaults to {@link defaultForwardedProxyNames} (config-driven — see setForwardedProxyAllowlist)
	 *  so every production scrub path registers allowlisted proxy creds with no per-call-site option
	 *  to forget; tests/DI may still pass it explicitly. */
	forwardedProxyNames?: ReadonlySet<string>;
}

/** Config-driven default for {@link CollectSecretEnvOptions.forwardedProxyNames}. Set once from
 *  `CONFIG.security.envAllowlist` at config load (setForwardedProxyAllowlist) so an allowlisted
 *  proxy's userinfo is registered as a secret by default at EVERY collection site — the crash/report
 *  boundary, provider stderr, and the Claude seat — without each call passing the option. */
let defaultForwardedProxyNames: ReadonlySet<string> = new Set();

/** Register the operator's `security.env-allowlist` as the default forwarded-proxy set. Called once
 *  at config load (config.ts, after CONFIG is built). Idempotent; last call wins. */
export function setForwardedProxyAllowlist(names: Iterable<string>): void {
	defaultForwardedProxyNames = new Set(names);
}

export function collectSecretEnvValues(source: NodeJS.ProcessEnv = process.env, opts: CollectSecretEnvOptions = {}): string[] {
	const values: string[] = [];
	for (const [name, value] of Object.entries(source)) {
		if (!value) continue;
		if (value.length >= 6 && SECRET_NAME.test(name)) {
			values.push(value);
			// #554 bug 1: a token consumed after `.trim()` (forgeTokenForHost trims a padded GH_*
			// token before base64-encoding it into the fetch header) — register the TRIMMED form too
			// so its encodings match the credential actually used, not just the padded env literal.
			const trimmed = value.trim();
			if (trimmed !== value && trimmed.length >= 6) values.push(trimmed);
		}
		// Proxy URL userinfo is a credential wherever the value appears — registered regardless
		// of whether the var was forwarded, so an operator opt-in still scrubs logs/crash sinks.
		// Registration rule (#554): a PASSWORD component (`user:pass`) is ALWAYS a secret, at ANY
		// length (bug 2 — the min-length guard is not for passwords); a BARE (colonless) userinfo
		// is registered only when it is long enough to be a token (an opaque bearer token) OR the
		// proxy var was explicitly allowlisted — so a short human username like "operator" is not
		// redacted from unrelated logs. (Forwarding still drops ANY `@`-value by default unless
		// allowlisted — classifyProxyValue.)
		if (PROXY_URL_ENV_NAMES.has(name)) {
			const userinfo = proxyUrlUserinfo(value);
			if (userinfo !== undefined) {
				const forwarded = opts.forwardedProxyNames ?? defaultForwardedProxyNames;
				const allowlisted = forwarded.has(name);
				const hasPassword = userinfo.includes(":");
				const isSecret = hasPassword || allowlisted || userinfo.length >= MIN_BARE_PROXY_TOKEN_LENGTH;
				if (isSecret) {
					values.push(value);
					// Password-bearing userinfo is registered at any length (the short-literal filter
					// is exempted for it in scrubSecrets); a bare token only when ≥6 to avoid noise.
					if (hasPassword || userinfo.length >= 6) values.push(userinfo);
				}
			}
		}
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
	// Short-literal filter avoids redacting incidental substrings — but it applies ONLY to
	// colonless bare values (#554 bug 2). A value containing a colon is a deliberately-collected
	// password-bearing credential (e.g. proxy `user:pass`) and must be redacted at any length.
	const values = [...(opts.secretValues ?? [])].filter((v) => v.length >= 6 || v.includes(":")).sort((a, b) => b.length - a.length);
	for (const value of values) out = out.split(value).join(REDACTED);
	for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
	return out;
}

/**
 * Build a reusable scrubber closed over the current process's secret env values. Callers apply it
 * at every log/stderr write site (redact-before-write). Collect once at construction so the
 * per-line cost is just the replace passes.
 */
export function makeSecretScrubber(source: NodeJS.ProcessEnv = process.env, opts: CollectSecretEnvOptions = {}): (text: string) => string {
	const secretValues = collectSecretEnvValues(source, opts);
	return (text: string): string => scrubSecrets(text, { secretValues });
}

/** Per-env memo of the public-sink scrubber so a report render builds it ONCE and reuses it
 *  across every field (keyed on the env object identity — `process.env` is one stable object). */
const publicSinkScrubberCache = new WeakMap<NodeJS.ProcessEnv, (text: string) => string>();

/**
 * Build (once per env) the scrubber for any PUBLIC or durable sink that may carry
 * model-controlled or child-process text — CI stdout, a PR/adjudication comment, a commit-
 * status description, stderr diagnostics. Layers a BASE64 pass (both `base64(value)` and the
 * `base64("x-access-token:" + value)` basic-credential form, longest-first so the long form
 * is redacted before its own suffix) over {@link makeSecretScrubber}, because a re-encoded
 * credential defeats the raw value/pattern scrubber. The env's secret values and their
 * encodings are computed once and cached; per-field cost is just the replace passes.
 */
export function makePublicSinkScrubber(env: NodeJS.ProcessEnv, opts: CollectSecretEnvOptions = {}): (text: string) => string {
	// Cache only the common no-options path (the memo is keyed on env identity, and the
	// forwarded-proxy set is not part of the key); an explicit opts build is rare and cheap.
	const cacheable = opts.forwardedProxyNames === undefined;
	const cached = cacheable ? publicSinkScrubberCache.get(env) : undefined;
	if (cached) return cached;
	const base = makeSecretScrubber(env, opts);
	const encodedForms = collectSecretEnvValues(env, opts)
		.flatMap((value) => [Buffer.from(`x-access-token:${value}`).toString("base64"), Buffer.from(value).toString("base64")])
		.sort((a, b) => b.length - a.length);
	const scrubber = (text: string): string => {
		let out = base(text);
		for (const encoded of encodedForms) out = out.split(encoded).join(REDACTED);
		return out;
	};
	if (cacheable) publicSinkScrubberCache.set(env, scrubber);
	return scrubber;
}

/** One-shot convenience over {@link makePublicSinkScrubber} for a single field. */
export function scrubForPublicSink(value: string, env: NodeJS.ProcessEnv): string {
	return makePublicSinkScrubber(env)(value);
}
