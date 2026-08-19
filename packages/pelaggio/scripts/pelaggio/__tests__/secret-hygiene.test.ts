import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REVIEW_EVIDENCE_PRIVATE_KEY_ENV, REVIEW_EVIDENCE_SIGNER_SOCKET_ENV, REVIEW_EVIDENCE_SIGNER_TOKEN_ENV, REVIEW_EVIDENCE_SIGNER_TOKEN_FILE_ENV } from "../review/gate-attestation.js";
import { buildAgentEnv, collectSecretEnvValues, makeSecretScrubber, PROVIDER_KEY_ENV, REDACTED, scopeEnvAllowlistToProvider, scrubSecrets } from "../secret-hygiene.js";

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

	it("excludes the review-evidence signing key even when explicitly allowlisted or extra", () => {
		const pem = "-----BEGIN PRIVATE KEY-----\nfixture-pem-not-a-real-key\n-----END PRIVATE KEY-----";
		const withKey: NodeJS.ProcessEnv = { ...source, [REVIEW_EVIDENCE_PRIVATE_KEY_ENV]: pem };
		assert.equal(REVIEW_EVIDENCE_PRIVATE_KEY_ENV in buildAgentEnv({ source: withKey }), false);
		assert.equal(REVIEW_EVIDENCE_PRIVATE_KEY_ENV in buildAgentEnv({ source: withKey, allow: [REVIEW_EVIDENCE_PRIVATE_KEY_ENV] }), false);
		assert.equal(
			REVIEW_EVIDENCE_PRIVATE_KEY_ENV in
				buildAgentEnv({
					source,
					allow: [REVIEW_EVIDENCE_PRIVATE_KEY_ENV],
					extra: { [REVIEW_EVIDENCE_PRIVATE_KEY_ENV]: pem },
				}),
			false,
		);
	});

	it("excludes the review-evidence signer-socket path even when explicitly allowlisted or extra", () => {
		const sock = "/run/pelaggio/evidence-signer.sock";
		const withSock: NodeJS.ProcessEnv = { ...source, [REVIEW_EVIDENCE_SIGNER_SOCKET_ENV]: sock };
		assert.equal(REVIEW_EVIDENCE_SIGNER_SOCKET_ENV in buildAgentEnv({ source: withSock }), false);
		assert.equal(REVIEW_EVIDENCE_SIGNER_SOCKET_ENV in buildAgentEnv({ source: withSock, allow: [REVIEW_EVIDENCE_SIGNER_SOCKET_ENV] }), false);
		assert.equal(
			REVIEW_EVIDENCE_SIGNER_SOCKET_ENV in
				buildAgentEnv({
					source,
					allow: [REVIEW_EVIDENCE_SIGNER_SOCKET_ENV],
					extra: { [REVIEW_EVIDENCE_SIGNER_SOCKET_ENV]: sock },
				}),
			false,
		);
	});

	it("excludes the review-evidence signer token and token-file path even when explicitly allowlisted or extra", () => {
		const token = "a".repeat(32);
		const file = "/run/pelaggio/evidence-signer.token";
		const withAuth: NodeJS.ProcessEnv = {
			...source,
			[REVIEW_EVIDENCE_SIGNER_TOKEN_ENV]: token,
			[REVIEW_EVIDENCE_SIGNER_TOKEN_FILE_ENV]: file,
		};
		for (const name of [REVIEW_EVIDENCE_SIGNER_TOKEN_ENV, REVIEW_EVIDENCE_SIGNER_TOKEN_FILE_ENV]) {
			assert.equal(name in buildAgentEnv({ source: withAuth }), false);
			assert.equal(name in buildAgentEnv({ source: withAuth, allow: [name] }), false);
			assert.equal(
				name in
					buildAgentEnv({
						source,
						allow: [name],
						extra: { [name]: name === REVIEW_EVIDENCE_SIGNER_TOKEN_ENV ? token : file },
					}),
				false,
			);
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

	it("redacts a review-evidence private-key fixture from diagnostic text", () => {
		const pem = "-----BEGIN PRIVATE KEY-----\nfixture-pem-not-a-real-key\n-----END PRIVATE KEY-----";
		const scrub = makeSecretScrubber({ [REVIEW_EVIDENCE_PRIVATE_KEY_ENV]: pem });
		assert.equal(scrub(`spawn failed: ${pem}`).includes(pem), false);
		assert.ok(scrub(`spawn failed: ${pem}`).includes(REDACTED));
	});
});
