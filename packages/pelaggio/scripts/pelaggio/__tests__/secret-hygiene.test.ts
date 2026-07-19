import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAgentEnv, collectSecretEnvValues, makeSecretScrubber, REDACTED, scrubSecrets } from "../secret-hygiene.js";

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
