import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findLoggedArtifactAuthor } from "../flow-events.js";

describe("findLoggedArtifactAuthor", () => {
	it("scans across entries and validates realized attribution", () => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-author-log-"));
		const path = join(dir, "log.jsonl");
		writeFileSync(path, `${JSON.stringify({ item: "245", steps: [{ name: "plan", ok: true }] })}\n${JSON.stringify({ item: "245", steps: [{ name: "implement", ok: true, provider: "codex", model: "gpt-5" }] })}\n`);
		assert.deepEqual(findLoggedArtifactAuthor("245", "implement", path), { provider: "codex", codexModel: "gpt-5" });
		assert.equal(findLoggedArtifactAuthor("245", "plan", path), undefined);
	});

	// #431: a Grok/OpenCode step now logs its own realized model; recovery must round-trip it into
	// the generic `model` field so it can be reused as an execution override.
	it("recovers a realized grok model from the generic model field", () => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-author-log-"));
		const path = join(dir, "log.jsonl");
		writeFileSync(path, `${JSON.stringify({ item: "431", steps: [{ name: "plan", ok: true, provider: "grok", model: "grok-code-fast-1" }] })}\n`);
		assert.deepEqual(findLoggedArtifactAuthor("431", "plan", path), { provider: "grok", model: "grok-code-fast-1" });
	});

	it("recovers a realized opencode model, and treats a logged default as an absent model", () => {
		const dir = mkdtempSync(join(tmpdir(), "pelaggio-author-log-"));
		const path = join(dir, "log.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify({ item: "431", steps: [{ name: "implement", ok: true, provider: "opencode", model: "openrouter/qwen" }] })}\n${JSON.stringify({ item: "432", steps: [{ name: "implement", ok: true, provider: "opencode", model: "default" }] })}\n`,
		);
		assert.deepEqual(findLoggedArtifactAuthor("431", "implement", path), { provider: "opencode", model: "openrouter/qwen" });
		assert.deepEqual(findLoggedArtifactAuthor("432", "implement", path), { provider: "opencode" });
	});
});
