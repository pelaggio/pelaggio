import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAgentEnv, classifyProxyValue, collectSecretEnvValues, makeSecretScrubber, PROVIDER_KEY_ENV, REDACTED, scopeEnvAllowlistToProvider, scrubSecrets } from "../secret-hygiene.js";

describe("buildAgentEnv (#237) — deny-by-default env allowlist", () => {
	const source: NodeJS.ProcessEnv = {
		PATH: "/usr/bin",
		HOME: "/home/agent",
		OPENAI_API_KEY: "sk-super-secret-value-123456",
		AWS_SECRET_ACCESS_KEY: "aws-top-secret-abcdef",
		SENTINEL_SECRET: "do-not-leak-me",
		SOME_RANDOM: "harmless",
	};

	it("forwards allowlisted vars (PATH, HOME) and DROPS everything else", () => {
		const env = buildAgentEnv({ source });
		assert.equal(env.PATH, "/usr/bin");
		assert.equal(env.HOME, "/home/agent");
		// The acceptance criterion: a sentinel secret is NOT present in the child's env.
		assert.equal("SENTINEL_SECRET" in env, false);
		assert.equal("OPENAI_API_KEY" in env, false);
		assert.equal("AWS_SECRET_ACCESS_KEY" in env, false);
		assert.equal("SOME_RANDOM" in env, false);
	});

	it("forwards extra allowlisted vars when configured (e.g. a driver auth var)", () => {
		const env = buildAgentEnv({ source, allow: ["OPENAI_API_KEY"] });
		assert.equal(env.OPENAI_API_KEY, "sk-super-secret-value-123456");
		assert.equal("AWS_SECRET_ACCESS_KEY" in env, false);
	});

	it("omits allowlisted vars that are absent from the source", () => {
		const env = buildAgentEnv({ source: { PATH: "/bin" } });
		assert.equal("HOME" in env, false);
	});

	it("applies explicit `extra` overrides", () => {
		const env = buildAgentEnv({ source, extra: { PATH: "/override" } });
		assert.equal(env.PATH, "/override");
	});

	it("forwards credential-less proxy values but drops credentialed or unparseable ones by default (#554)", () => {
		const clean = buildAgentEnv({ source: { PATH: "/bin", HTTP_PROXY: "http://proxy.corp:3128", https_proxy: "proxy.corp:3128", NO_PROXY: "localhost,127.0.0.1" } });
		assert.equal(clean.HTTP_PROXY, "http://proxy.corp:3128");
		assert.equal(clean.https_proxy, "proxy.corp:3128");
		// NO_PROXY is a host list, never a URL — unconditional.
		assert.equal(clean.NO_PROXY, "localhost,127.0.0.1");
		const stderrWrites: string[] = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderrWrites.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const credentialed = buildAgentEnv({ source: { PATH: "/bin", HTTPS_PROXY: "https://user:proxy-pass-1@proxy.corp:3128", ALL_PROXY: "http:// bad url" } });
			assert.equal("HTTPS_PROXY" in credentialed, false, "a userinfo-carrying proxy URL must not be forwarded by default");
			assert.equal("ALL_PROXY" in credentialed, false, "an unparseable proxy value must not be forwarded");
		} finally {
			process.stderr.write = originalWrite;
		}
		const diagnostics = stderrWrites.join("");
		assert.match(diagnostics, /not forwarding HTTPS_PROXY .*userinfo carries proxy credentials.*security\.env-allowlist/);
		assert.match(diagnostics, /not forwarding ALL_PROXY .*not a parseable proxy URL/);
		// The diagnostic itself must not echo the credential.
		assert.equal(diagnostics.includes("proxy-pass-1"), false);
	});

	it("security.env-allowlist opt-in forwards a credentialed proxy value (still scrubbed in sinks)", () => {
		const value = "https://user:proxy-pass-2@proxy.corp:3128";
		const env = buildAgentEnv({ source: { PATH: "/bin", HTTPS_PROXY: value }, allow: ["HTTPS_PROXY"] });
		assert.equal(env.HTTPS_PROXY, value);
		// Regardless of forwarding, the scrubber registers the userinfo and the full URL.
		const scrub = makeSecretScrubber({ HTTPS_PROXY: value });
		const scrubbed = scrub(`connecting via ${value} (auth user:proxy-pass-2)`);
		assert.equal(scrubbed.includes("proxy-pass-2"), false);
		assert.equal(scrubbed.includes(value), false);
		assert.match(scrubbed, /\[REDACTED\]/);
	});

	it("catches scheme-relative and slash-collapsed credentialed proxy forms; any @ is conservatively credentialed (#554)", () => {
		const originalWrite = process.stderr.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			// The two verified bypass shapes: no scheme (`//u:p@h`) and collapsed slashes (`http:///u:p@h`).
			for (const value of ["//user:bypass-pass-3@proxy.corp:3128", "http:///user:bypass-pass-4@proxy.corp:3128"]) {
				assert.equal(classifyProxyValue(value), "credentialed", value);
				const env = buildAgentEnv({ source: { PATH: "/bin", HTTPS_PROXY: value } });
				assert.equal("HTTPS_PROXY" in env, false, `${value} must not be forwarded by default`);
				const scrubbed = makeSecretScrubber({ HTTPS_PROXY: value })(`via ${value} and creds user:${value.match(/bypass-pass-\d/)?.[0]}`);
				assert.equal(scrubbed.includes("bypass-pass"), false, `${value} credentials must be scrubbed`);
				assert.match(scrubbed, /\[REDACTED\]/);
			}
			// Any @ that cannot be positively cleared is credentialed — even in a path segment.
			assert.equal(classifyProxyValue("http://proxy.corp/path@segment"), "credentialed");
			const weird = buildAgentEnv({ source: { PATH: "/bin", ALL_PROXY: "http://proxy.corp/path@segment" } });
			assert.equal("ALL_PROXY" in weird, false);
		} finally {
			process.stderr.write = originalWrite;
		}
		// Credential-free forms keep flowing untouched.
		assert.equal(classifyProxyValue("http://host:8080"), "forward");
		assert.equal(classifyProxyValue("host:8080"), "forward");
		const plain = buildAgentEnv({ source: { PATH: "/bin", HTTP_PROXY: "http://host:8080", https_proxy: "host:8080" } });
		assert.equal(plain.HTTP_PROXY, "http://host:8080");
		assert.equal(plain.https_proxy, "host:8080");
	});

	it("registers only password-carrying proxy userinfo as a secret; a bare username is not redacted (#554)", () => {
		const bare = "http://operator@proxy.corp:3128";
		const originalWrite = process.stderr.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			// Any @ still drops the value from default forwarding (conservative)...
			const env = buildAgentEnv({ source: { PATH: "/bin", HTTPS_PROXY: bare } });
			assert.equal("HTTPS_PROXY" in env, false);
		} finally {
			process.stderr.write = originalWrite;
		}
		// ...but a SHORT bare username is not a secret: unrelated mentions survive scrubbing.
		assert.deepEqual(collectSecretEnvValues({ HTTPS_PROXY: bare }), []);
		assert.equal(makeSecretScrubber({ HTTPS_PROXY: bare })("operator restarted the proxy"), "operator restarted the proxy");
		// Password-carrying userinfo (and its full URL) stays registered.
		const credentialed = "http://operator:proxy-pass-9@proxy.corp:3128";
		const values = collectSecretEnvValues({ HTTPS_PROXY: credentialed });
		assert.ok(values.includes(credentialed));
		assert.ok(values.includes("operator:proxy-pass-9"));
	});

	it("registers a long bare (colonless) proxy token, and any allowlisted proxy userinfo, as a secret (#554)", () => {
		// A long opaque bearer token in userinfo has no colon but IS a credential (≥12 chars).
		const opaque = "http://gho_longopaquebearertoken1234@proxy.corp:3128";
		const opaqueValues = collectSecretEnvValues({ HTTPS_PROXY: opaque });
		assert.ok(opaqueValues.includes(opaque), "the full opaque-token URL must be registered");
		assert.ok(opaqueValues.includes("gho_longopaquebearertoken1234"), "the long bare token must be registered");
		assert.match(makeSecretScrubber({ HTTPS_PROXY: opaque })("using gho_longopaquebearertoken1234"), /\[REDACTED\]/);
		// A SHORT bare token is registered too once the proxy var is explicitly ALLOWLISTED —
		// an allowlisted credentialed proxy's userinfo is sensitive by definition (the hole the
		// password-only rule left). Non-allowlisted short bare userinfo stays unregistered.
		const shortTok = "http://shorttoken@proxy.corp:3128"; // "shorttoken" = 10 chars, below the ≥12 bare-token bar
		const forwarded = new Set(["HTTPS_PROXY"]);
		assert.deepEqual(collectSecretEnvValues({ HTTPS_PROXY: shortTok }), []);
		const allowlisted = collectSecretEnvValues({ HTTPS_PROXY: shortTok }, { forwardedProxyNames: forwarded });
		assert.ok(allowlisted.includes(shortTok));
		assert.ok(allowlisted.includes("shorttoken"));
		assert.match(makeSecretScrubber({ HTTPS_PROXY: shortTok }, { forwardedProxyNames: forwarded })("token shorttoken used"), /\[REDACTED\]/);
	});

	it("drops a relative XDG_CONFIG_HOME (XDG-invalid) while forwarding an absolute one", () => {
		const absolute = buildAgentEnv({ source: { PATH: "/bin", XDG_CONFIG_HOME: "/home/agent/.config" } });
		assert.equal(absolute.XDG_CONFIG_HOME, "/home/agent/.config");
		const originalWrite = process.stderr.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			const relative = buildAgentEnv({ source: { PATH: "/bin", XDG_CONFIG_HOME: "relative/config" } });
			assert.equal("XDG_CONFIG_HOME" in relative, false, "a relative XDG_CONFIG_HOME must not be forwarded (the seat mask ignores it too)");
		} finally {
			process.stderr.write = originalWrite;
		}
	});
});

describe("scopeEnvAllowlistToProvider (#276) — per-provider key scoping", () => {
	// The configured global allowlist for a keys-mode multi-provider review.
	const globalAllowlist = ["OPENAI_API_KEY", "XAI_API_KEY", "ANTHROPIC_API_KEY", "NODE_EXTRA_CA_CERTS", "MY_CUSTOM_VAR"];
	const source: NodeJS.ProcessEnv = {
		PATH: "/usr/bin",
		HOME: "/home/agent",
		OPENAI_API_KEY: "sk-codex-key-0123456789",
		XAI_API_KEY: "xai-grok-key-0123456789",
		ANTHROPIC_API_KEY: "sk-ant-claude-key-0123456789",
		MY_CUSTOM_VAR: "harmless-but-wanted",
	};

	it("codex launch env contains the codex key but not grok's or claude's", () => {
		const env = buildAgentEnv({ source, allow: scopeEnvAllowlistToProvider(globalAllowlist, "codex") });
		assert.equal(env.OPENAI_API_KEY, "sk-codex-key-0123456789");
		assert.equal("XAI_API_KEY" in env, false);
		assert.equal("ANTHROPIC_API_KEY" in env, false);
	});

	it("grok launch env contains the grok key but not codex's or claude's", () => {
		const env = buildAgentEnv({ source, allow: scopeEnvAllowlistToProvider(globalAllowlist, "grok") });
		assert.equal(env.XAI_API_KEY, "xai-grok-key-0123456789");
		assert.equal("OPENAI_API_KEY" in env, false);
		assert.equal("ANTHROPIC_API_KEY" in env, false);
	});

	it("opencode (no direct-key contract) receives no provider key at all", () => {
		const scoped = scopeEnvAllowlistToProvider(globalAllowlist, "opencode");
		for (const key of Object.values(PROVIDER_KEY_ENV)) assert.equal(scoped.includes(key as string), false);
	});

	it("non-key allowlist entries are unaffected for every provider", () => {
		for (const provider of ["codex", "grok", "opencode"] as const) {
			const env = buildAgentEnv({ source, allow: scopeEnvAllowlistToProvider(globalAllowlist, provider) });
			assert.equal(env.MY_CUSTOM_VAR, "harmless-but-wanted");
			const scoped = scopeEnvAllowlistToProvider(globalAllowlist, provider);
			assert.ok(scoped.includes("NODE_EXTRA_CA_CERTS"));
		}
	});
});

describe("collectSecretEnvValues (#237)", () => {
	it("collects values of secret-named vars and ignores plain ones", () => {
		const values = collectSecretEnvValues({
			GITHUB_TOKEN: "ghp_aaaaaaaaaaaaaaaaaaaa",
			MY_API_KEY: "key-abcdef-123456",
			DB_PASSWORD: "hunter2hunter2",
			HOME: "/home/agent",
			LANG: "en_US.UTF-8",
		});
		assert.ok(values.includes("ghp_aaaaaaaaaaaaaaaaaaaa"));
		assert.ok(values.includes("key-abcdef-123456"));
		assert.ok(values.includes("hunter2hunter2"));
		assert.equal(values.includes("/home/agent"), false);
		assert.equal(values.includes("en_US.UTF-8"), false);
	});

	it("ignores short values to avoid redacting incidental substrings", () => {
		assert.deepEqual(collectSecretEnvValues({ X_TOKEN: "abc" }), []);
	});
});

describe("scrubSecrets (#237) — redact-before-write", () => {
	it("redacts a JWT (grok OAuth shape)", () => {
		const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
		const out = scrubSecrets(`token=${jwt} done`);
		assert.equal(out.includes(jwt), false);
		assert.ok(out.includes(REDACTED));
	});

	it("redacts provider API-key shapes (OpenAI, xAI, GitHub)", () => {
		for (const key of ["sk-abcdef0123456789ABCDEF", "xai-abcdef0123456789ABCDEF", "ghp_abcdefghijklmnopqrst"]) {
			assert.equal(scrubSecrets(`k=${key}`).includes(key), false);
		}
	});

	it("redacts a configured secret value even when it matches no known pattern", () => {
		const secret = "totally-bespoke-passphrase-42";
		const out = scrubSecrets(`the model echoed ${secret} oops`, { secretValues: [secret] });
		assert.equal(out.includes(secret), false);
		assert.ok(out.includes(REDACTED));
	});

	it("leaves ordinary text untouched", () => {
		const text = "Ran 42 tests, all passed. Nothing to see here.";
		assert.equal(scrubSecrets(text), text);
	});

	it("is idempotent", () => {
		const once = scrubSecrets("sk-abcdef0123456789ABCDEF");
		assert.equal(scrubSecrets(once), once);
	});
});

describe("makeSecretScrubber (#237) — end-to-end log capture", () => {
	it("redacts a planted secret value from a captured log line (acceptance)", () => {
		const scrub = makeSecretScrubber({ MY_SERVICE_TOKEN: "planted-secret-value-xyz", HOME: "/home/agent" });
		const raw = "stderr: connecting with token planted-secret-value-xyz to endpoint";
		const scrubbed = scrub(raw);
		// The acceptance criterion: the raw secret never appears in captured/emitted logs.
		assert.equal(scrubbed.includes("planted-secret-value-xyz"), false);
		assert.ok(scrubbed.includes(REDACTED));
	});
});
