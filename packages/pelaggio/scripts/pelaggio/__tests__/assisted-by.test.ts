import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ASSISTED_BY_TOKEN, collectLoggedAssistedByIdentities, DEFAULT_ASSISTED_BY, formatAssistedByLine, identitiesForProviders, identityForProvider, withAssistedBy } from "../ship/assisted-by.js";

describe("assisted-by trailers (#189)", () => {
	it("formats a stable Assisted-by line", () => {
		assert.equal(formatAssistedByLine(DEFAULT_ASSISTED_BY), "Assisted-by: Claude <noreply@anthropic.com>");
		assert.equal(formatAssistedByLine(identityForProvider("codex")), "Assisted-by: Codex <noreply@openai.com>");
		assert.equal(formatAssistedByLine(identityForProvider("grok")), "Assisted-by: Grok <noreply@x.ai>");
		assert.equal(ASSISTED_BY_TOKEN, "Assisted-by");
	});

	it("always-on: empty identity list stamps the default Claude identity", () => {
		const out = withAssistedBy("Body line");
		assert.match(out, /Body line/);
		assert.match(out, /Assisted-by: Claude <noreply@anthropic\.com>/);
		assert.ok(!/Co-Authored-By:/i.test(out));
	});

	it("stamps each unique provider and is idempotent on re-application", () => {
		const ids = [identityForProvider("claude"), identityForProvider("codex"), identityForProvider("claude")];
		const once = withAssistedBy("Summary\n\n- bullet", ids);
		assert.match(once, /Assisted-by: Claude <noreply@anthropic\.com>/);
		assert.match(once, /Assisted-by: Codex <noreply@openai\.com>/);
		const twice = withAssistedBy(once, ids);
		assert.equal(twice, once);
		assert.equal((twice.match(/Assisted-by:/gi) ?? []).length, 2);
	});

	it("maps and deduplicates realized providers", () => {
		assert.deepEqual(
			identitiesForProviders(["codex", "claude", "codex"]).map((id) => id.email),
			["noreply@openai.com", "noreply@anthropic.com"],
		);
	});

	it("preserves existing Assisted-by and only appends missing identities", () => {
		const body = "Body\n\nAssisted-by: Claude <noreply@anthropic.com>\n";
		const out = withAssistedBy(body, [identityForProvider("claude"), identityForProvider("grok")]);
		assert.equal((out.match(/Assisted-by: Claude/g) ?? []).length, 1);
		assert.match(out, /Assisted-by: Grok <noreply@x\.ai>/);
	});

	it("strips AI-shaped Co-Authored-By lines in favor of Assisted-by", () => {
		const body = "Body\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n";
		const out = withAssistedBy(body, [identityForProvider("claude")]);
		assert.ok(!/Co-Authored-By:/i.test(out));
		assert.match(out, /Assisted-by: Claude <noreply@anthropic\.com>/);
	});

	it("keeps non-AI Co-Authored-By lines", () => {
		const body = "Body\n\nCo-Authored-By: Alice <alice@example.com>\n";
		const out = withAssistedBy(body, [identityForProvider("claude")]);
		assert.match(out, /Co-Authored-By: Alice <alice@example\.com>/);
		assert.match(out, /Assisted-by: Claude <noreply@anthropic\.com>/);
	});

	it("collectLoggedAssistedByIdentities reads unique authorship providers from the cycle log", () => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-assisted-by-"));
		const logPath = join(dir, "pelaggio-log.jsonl");
		const entry = {
			item: "189",
			steps: [
				{ name: "pick", ok: true, provider: "claude" },
				{ name: "implement", ok: true, provider: "codex" },
				{ name: "shakedown-code", ok: true, provider: "grok" },
				{ name: "implement", ok: false, provider: "claude" },
				{ name: "ship", ok: true, provider: "claude" },
			],
		};
		writeFileSync(logPath, `${JSON.stringify(entry)}\n`);
		const ids = collectLoggedAssistedByIdentities("189", logPath);
		assert.deepEqual(
			ids.map((id) => id.email),
			["noreply@openai.com", "noreply@x.ai", "noreply@anthropic.com"],
		);
	});

	it("collectLoggedAssistedByIdentities returns [] when the item is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-assisted-by-empty-"));
		const logPath = join(dir, "pelaggio-log.jsonl");
		writeFileSync(logPath, `${JSON.stringify({ item: "1", steps: [{ name: "implement", ok: true, provider: "claude" }] })}\n`);
		assert.deepEqual(collectLoggedAssistedByIdentities("189", logPath), []);
	});
});
