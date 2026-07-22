import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CODEX_CAPABILITIES } from "../codex-provider.js";
import { DEFAULTS, loadConfig, type ResolvedConfig } from "../config.js";
import { GROK_CAPABILITIES } from "../grok-provider.js";
import { matchEligibleProviders, resolveAuthoringReviewConfig } from "../provider-routing.js";
import { CLAUDE_CAPABILITIES } from "../step-runner.js";
import type { ProviderCapabilities, ProviderName } from "../types.js";

const ALL_CAPS: Record<ProviderName, ProviderCapabilities> = {
	claude: CLAUDE_CAPABILITIES,
	codex: CODEX_CAPABILITIES,
	grok: GROK_CAPABILITIES,
};

function baseConfig(over: Partial<ResolvedConfig["review"]["authoring"]> = {}): ResolvedConfig {
	const repo = mkdtempSync(join(tmpdir(), "pelaggio-routing-"));
	const cfg = loadConfig({ repo, configPath: join(repo, ".pelaggio.yml") });
	return {
		...cfg,
		review: {
			...cfg.review,
			authoring: {
				...cfg.review.authoring,
				enabled: true,
				reviewers: (over.reviewers ?? DEFAULTS.review.authoring.reviewers).map((s) => ({ ...s })),
				judge: over.judge ? { ...over.judge } : { ...DEFAULTS.review.authoring.judge },
				...over,
				// Re-apply arrays after spread so over.reviewers/judge win cleanly.
				...(over.reviewers ? { reviewers: over.reviewers.map((s) => ({ ...s })) } : {}),
				...(over.judge ? { judge: { ...over.judge } } : {}),
			},
		},
	};
}

describe("matchEligibleProviders — pure capability resolver", () => {
	it("hard semanticDeny over only Codex/Grok is ineligible; adding Claude admits it", () => {
		const noClaude = matchEligibleProviders({
			candidates: [
				{ provider: "codex", payload: 1 },
				{ provider: "grok", payload: 2 },
			],
			capabilities: ALL_CAPS,
			hard: { semanticDeny: true },
		});
		assert.equal(noClaude.ok, false);
		if (!noClaude.ok) assert.match(noClaude.reason, /semanticDeny/);

		const withClaude = matchEligibleProviders({
			candidates: [
				{ provider: "codex", payload: 1 },
				{ provider: "claude", payload: 0 },
				{ provider: "grok", payload: 2 },
			],
			capabilities: ALL_CAPS,
			hard: { semanticDeny: true },
		});
		assert.equal(withClaude.ok, true);
		if (withClaude.ok) {
			assert.deepEqual(
				withClaude.candidates.map((c) => c.provider),
				["claude"],
			);
			assert.equal(withClaude.realizations[0]?.mode, "native");
		}
	});

	it("isolation predicates are membership-based and incomparable", () => {
		const landlockOnly = matchEligibleProviders({
			candidates: [
				{ provider: "claude", payload: "c" },
				{ provider: "codex", payload: "x" },
				{ provider: "grok", payload: "g" },
			],
			capabilities: ALL_CAPS,
			hard: { isolation: ["landlock"] },
		});
		assert.equal(landlockOnly.ok, true);
		if (landlockOnly.ok) {
			assert.deepEqual(
				landlockOnly.candidates.map((c) => c.provider),
				["grok"],
			);
		}

		const workspaceOnly = matchEligibleProviders({
			candidates: [
				{ provider: "claude", payload: "c" },
				{ provider: "codex", payload: "x" },
				{ provider: "grok", payload: "g" },
			],
			capabilities: ALL_CAPS,
			hard: { isolation: ["workspace-write"] },
		});
		assert.equal(workspaceOnly.ok, true);
		if (workspaceOnly.ok) {
			assert.deepEqual(
				workspaceOnly.candidates.map((c) => c.provider),
				["codex"],
			);
		}

		// Neither isolation implies semanticDeny; requiring both isolation and deny fails for all three.
		const both = matchEligibleProviders({
			candidates: [
				{ provider: "claude", payload: "c" },
				{ provider: "codex", payload: "x" },
				{ provider: "grok", payload: "g" },
			],
			capabilities: ALL_CAPS,
			hard: { semanticDeny: true, isolation: ["landlock"] },
		});
		assert.equal(both.ok, false);
	});

	it("soft native preference stable-partitions without disturbing configured order", () => {
		const result = matchEligibleProviders({
			candidates: [
				{ provider: "codex", payload: "x" },
				{ provider: "claude", payload: "c" },
				{ provider: "grok", payload: "g" },
			],
			capabilities: ALL_CAPS,
			soft: { semanticDeny: true },
		});
		assert.equal(result.ok, true);
		if (result.ok) {
			// Claude is native for semanticDeny; codex then grok remain degraded in configured order.
			assert.deepEqual(
				result.candidates.map((c) => c.provider),
				["claude", "codex", "grok"],
			);
			assert.deepEqual(
				result.realizations.map((r) => r.mode),
				["native", "degraded", "degraded"],
			);
			assert.deepEqual(result.realizations[1]?.degradedAxes, ["semanticDeny"]);
			assert.deepEqual(result.realizations[2]?.degradedAxes, ["semanticDeny"]);
		}
	});

	it("preserves candidate payloads through ranking", () => {
		const result = matchEligibleProviders({
			candidates: [
				{ provider: "claude", payload: { seat: "a" } },
				{ provider: "codex", payload: { seat: "b" } },
			],
			capabilities: ALL_CAPS,
			soft: { semanticDeny: true },
		});
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.candidates[0]?.payload, { seat: "a" });
			assert.deepEqual(result.candidates[1]?.payload, { seat: "b" });
		}
	});

	it("fails closed when a required descriptor is missing", () => {
		const result = matchEligibleProviders({
			candidates: [{ provider: "claude", payload: 1 }],
			capabilities: { codex: CODEX_CAPABILITIES },
			hard: { semanticDeny: true },
		});
		assert.equal(result.ok, false);
	});
});

describe("resolveAuthoringReviewConfig — fixed-seat overlay", () => {
	it("fills reviewer models from pr-review and judge from pr-verify (not shakedown-code)", () => {
		const config = baseConfig();
		// Inject sparse profile models so we can prove inheritance sources.
		config.modelProfiles = {
			standard: {
				"pr-review": "claude-review-model",
				"pr-verify": "claude-verify-model",
				"shakedown-code": "claude-shakedown-model",
			},
		};

		const result = resolveAuthoringReviewConfig({
			config,
			profile: "standard",
			author: { provider: "claude", model: "author-model" },
			capabilities: ALL_CAPS,
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;

		// Author is claude → claude reviewer seat excluded; codex + grok remain.
		assert.deepEqual(
			result.policy.reviewers.map((r) => r.provider),
			["codex", "grok"],
		);
		// Judge inherits from pr-verify, not shakedown-code.
		assert.equal(result.policy.judge.provider, "claude");
		assert.equal(result.policy.judge.model, "claude-verify-model");
		assert.notEqual(result.policy.judge.model, "claude-shakedown-model");
	});

	it("preserves configured seat providers (no pool draw that swaps seats)", () => {
		const config = baseConfig({
			reviewers: [
				{ id: "cdx", provider: "codex", codexModel: "gpt-review" },
				{ id: "grk", provider: "grok", model: "grok-review" },
			],
			judge: { id: "judge", provider: "claude", model: "claude-judge" },
		});
		const result = resolveAuthoringReviewConfig({
			config,
			profile: "standard",
			author: { provider: "claude" },
			capabilities: ALL_CAPS,
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(
			result.policy.reviewers.map((r) => ({ id: r.id, provider: r.provider })),
			[
				{ id: "cdx", provider: "codex" },
				{ id: "grk", provider: "grok" },
			],
		);
		assert.equal(result.policy.judge.model, "claude-judge");
		const cdx = result.policy.reviewers.find((r) => r.provider === "codex");
		assert.ok(cdx && cdx.provider === "codex" && cdx.codexModel === "gpt-review");
	});

	it("excludes the artifact author from reviewer seats", () => {
		const result = resolveAuthoringReviewConfig({
			config: baseConfig(),
			profile: "standard",
			author: { provider: "codex" },
			capabilities: ALL_CAPS,
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.ok(result.policy.reviewers.every((r) => r.provider !== "codex"));
		assert.ok(result.policy.reviewers.some((r) => r.provider === "claude"));
		assert.ok(result.policy.reviewers.some((r) => r.provider === "grok"));
	});

	it("fails when no reviewer seats remain after author exclusion", () => {
		const config = baseConfig({
			reviewers: [{ id: "only-claude", provider: "claude" }],
		});
		const result = resolveAuthoringReviewConfig({
			config,
			profile: "standard",
			author: { provider: "claude" },
			capabilities: ALL_CAPS,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /no reviewer seats remain/);
	});

	it("fails closed when a fixed seat fails a hard review requirement", () => {
		const result = resolveAuthoringReviewConfig({
			config: baseConfig({
				reviewers: [
					{ id: "cdx", provider: "codex" },
					{ id: "grk", provider: "grok" },
				],
			}),
			profile: "standard",
			author: { provider: "claude" },
			capabilities: ALL_CAPS,
			reviewHard: { semanticDeny: true },
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /ineligible/);
	});

	it("fails when the assigned author is hard-ineligible (never reassigns)", () => {
		const result = resolveAuthoringReviewConfig({
			config: baseConfig(),
			profile: "standard",
			author: { provider: "codex" },
			capabilities: ALL_CAPS,
			authorHard: { semanticDeny: true },
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /assigned author/);
	});

	it("returns per-seat realizations for logging/tests", () => {
		const result = resolveAuthoringReviewConfig({
			config: baseConfig(),
			profile: "standard",
			author: { provider: "claude" },
			capabilities: ALL_CAPS,
			reviewSoft: { semanticDeny: true },
			authorSoft: { semanticDeny: true },
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		const authorR = result.realizations.find((r) => r.role === "author");
		assert.equal(authorR?.mode, "native");
		const codexR = result.realizations.find((r) => r.provider === "codex");
		assert.equal(codexR?.mode, "degraded");
		assert.ok(codexR?.degradedAxes.includes("semanticDeny"));
	});
});
