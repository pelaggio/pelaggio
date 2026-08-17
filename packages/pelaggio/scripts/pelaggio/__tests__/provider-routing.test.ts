import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CODEX_CAPABILITIES } from "../codex-provider.js";
import { DEFAULTS, loadConfig, type ResolvedConfig } from "../config.js";
import { grokCapabilities } from "../grok-provider.js";
import { OPENCODE_CAPABILITIES } from "../opencode-provider.js";
import { detectUnattendedSignals, matchEligibleProviders, matchesCapabilityPredicate, OPERATOR_ATTESTED_TTY_SUPPRESSION, resolveAuthoringReviewConfig, resolveAuthoringReviewExecution, softDegradedAxes } from "../provider-routing.js";
import { CLAUDE_CAPABILITIES } from "../step-runner.js";
import type { ProviderCapabilities, ProviderName } from "../types.js";

const ALL_CAPS: Record<ProviderName, ProviderCapabilities> = {
	claude: CLAUDE_CAPABILITIES,
	codex: CODEX_CAPABILITIES,
	// Routing matrix tests exercise the fail-closed configuration where Landlock
	// is required; fallback-mode descriptor honesty is covered in step-runner tests.
	grok: grokCapabilities(false),
	opencode: OPENCODE_CAPABILITIES,
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
				enabled: "local",
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
	it("rejects unknown hard and soft predicate axes at runtime", () => {
		const unknown = { futureAxis: true } as unknown as import("../types.js").CapabilityPredicate;
		assert.equal(matchesCapabilityPredicate(ALL_CAPS.claude, unknown), false);
		assert.throws(() => softDegradedAxes(ALL_CAPS.claude, unknown), /unknown capability axis: futureAxis/);
		const hard = matchEligibleProviders({ candidates: [{ provider: "claude", payload: 1 }], capabilities: ALL_CAPS, hard: unknown });
		assert.deepEqual(hard, { ok: false, reason: "unknown capability axis: futureAxis" });
		const soft = matchEligibleProviders({ candidates: [{ provider: "claude", payload: 1 }], capabilities: ALL_CAPS, soft: unknown });
		assert.deepEqual(soft, { ok: false, reason: "unknown capability axis: futureAxis" });
	});
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

	it("fills a non-Codex seat from the provider's own slot, never the Claude model (#431)", () => {
		const config = baseConfig({
			reviewers: [
				{ id: "grk", provider: "grok" },
				{ id: "oc", provider: "opencode" },
			],
			judge: { id: "judge", provider: "opencode" },
		});
		// Distinct per-provider slots at pr-review + pr-verify prove the seat reads its own slot.
		config.modelProfiles = { standard: { "pr-review": "claude-review", "pr-verify": "claude-verify" } };
		config.profileGrokModels = { standard: { "pr-review": "grok-review" } };
		config.profileOpenCodeModels = { standard: { "pr-review": "oc-review", "pr-verify": "oc-verify" } };
		const result = resolveAuthoringReviewConfig({ config, profile: "standard", author: { provider: "claude", model: "author" }, capabilities: ALL_CAPS });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		const grk = result.policy.reviewers.find((r) => r.provider === "grok");
		const oc = result.policy.reviewers.find((r) => r.provider === "opencode");
		assert.ok(grk && grk.provider === "grok" && grk.model === "grok-review");
		assert.ok(oc && oc.provider === "opencode" && oc.model === "oc-review");
		// Judge (opencode) inherits from pr-verify's opencode slot — not the Claude pr-verify id.
		assert.ok(result.policy.judge.provider === "opencode" && result.policy.judge.model === "oc-verify");
	});

	it("lets an explicit slot-level model win over the provider default (#431)", () => {
		const config = baseConfig({
			reviewers: [{ id: "grk", provider: "grok", model: "grok-explicit" }],
			judge: { id: "judge", provider: "claude" },
		});
		config.profileGrokModels = { standard: { "pr-review": "grok-default" } };
		const result = resolveAuthoringReviewConfig({ config, profile: "standard", author: { provider: "claude" }, capabilities: ALL_CAPS });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		const grk = result.policy.reviewers.find((r) => r.provider === "grok");
		assert.ok(grk && grk.provider === "grok" && grk.model === "grok-explicit");
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
		const judge = result.policy.judge;
		assert.ok(judge.provider !== "codex");
		assert.equal(judge.model, "claude-judge");
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

describe("resolveAuthoringReviewExecution — auth context gate (#276)", () => {
	it("allows local mode only for attended execution (no unattended signals)", () => {
		const policy = { ...baseConfig().review.authoring, enabled: "local" as const };
		assert.equal(resolveAuthoringReviewExecution(policy, { unattendedSignals: [] }).ok, true);
		const unattended = resolveAuthoringReviewExecution(policy, { unattendedSignals: ["CI/single-shot (--no-worktree)"] });
		assert.equal(unattended.ok, false);
		if (!unattended.ok) assert.match(unattended.reason, /CI\/single-shot/);
	});

	it("local mode refusal names every detected unattended signal", () => {
		const policy = { ...baseConfig().review.authoring, enabled: "local" as const };
		const { signals } = detectUnattendedSignals({ singleShot: false, multiCycle: true, env: { PELAGGIO_SUPERVISED_RUN: "1" }, stdoutIsTTY: false });
		const result = resolveAuthoringReviewExecution(policy, { unattendedSignals: signals });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.reason, /PELAGGIO_SUPERVISED_RUN=1/);
			assert.match(result.reason, /multi-cycle/);
			assert.match(result.reason, /interactive TTY/);
			assert.match(result.reason, /use keys or off/);
		}
	});

	it("key mode rejects a panel when every reviewer lacks an integrated key route", () => {
		const policy = {
			...baseConfig().review.authoring,
			enabled: "keys" as const,
			reviewers: [
				{ id: "codex", provider: "codex" as const },
				{ id: "grok", provider: "grok" as const },
			],
			judge: { id: "judge", provider: "claude" as const },
		};
		const result = resolveAuthoringReviewExecution(policy, {
			unattendedSignals: ["CI/single-shot (--no-worktree)"],
			author: { provider: "claude" },
			env: { ANTHROPIC_API_KEY: "anthropic-key", XAI_API_KEY: "xai-key" },
			envAllowlist: ["XAI_API_KEY"],
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /no key-authenticated reviewer.*codex.*OPENAI_API_KEY.*grok.*no integrated direct-key authentication route/);
	});

	it("key mode fails closed without a key-authenticated Judge or reviewer", () => {
		const policy = {
			...baseConfig().review.authoring,
			enabled: "keys" as const,
			reviewers: [{ id: "codex", provider: "codex" as const }],
			judge: { id: "judge", provider: "claude" as const },
		};
		const noJudge = resolveAuthoringReviewExecution(policy, { unattendedSignals: ["CI/single-shot (--no-worktree)"], author: { provider: "claude" }, env: { OPENAI_API_KEY: "openai-key" }, envAllowlist: ["OPENAI_API_KEY"] });
		assert.equal(noJudge.ok, false);
		if (!noJudge.ok) assert.match(noJudge.reason, /Judge.*ANTHROPIC_API_KEY/);
		const noReviewer = resolveAuthoringReviewExecution(policy, { unattendedSignals: ["CI/single-shot (--no-worktree)"], author: { provider: "claude" }, env: { ANTHROPIC_API_KEY: "anthropic-key", OPENAI_API_KEY: "openai-key" } });
		assert.equal(noReviewer.ok, false);
		if (!noReviewer.ok) assert.match(noReviewer.reason, /no key-authenticated reviewer.*env-allowlist/);
	});

	it("key mode fails closed when the author revision seat has no provider key (reviewer + Judge keys present)", () => {
		const policy = {
			...baseConfig().review.authoring,
			enabled: "keys" as const,
			reviewers: [{ id: "grok", provider: "grok" as const }],
			judge: { id: "judge", provider: "claude" as const },
		};
		const result = resolveAuthoringReviewExecution(policy, {
			unattendedSignals: ["CI/single-shot (--no-worktree)"],
			author: { provider: "codex" },
			env: { ANTHROPIC_API_KEY: "anthropic-key", XAI_API_KEY: "xai-key" },
			envAllowlist: ["XAI_API_KEY"],
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /author seat \(codex\) requires key auth: OPENAI_API_KEY is not set/);
	});

	it("key mode fails closed when the author seat's key is set but not forwarded by the env allowlist", () => {
		const policy = {
			...baseConfig().review.authoring,
			enabled: "keys" as const,
			reviewers: [{ id: "grok", provider: "grok" as const }],
			judge: { id: "judge", provider: "claude" as const },
		};
		const result = resolveAuthoringReviewExecution(policy, {
			unattendedSignals: ["CI/single-shot (--no-worktree)"],
			author: { provider: "codex" },
			env: { ANTHROPIC_API_KEY: "anthropic-key", XAI_API_KEY: "xai-key", OPENAI_API_KEY: "openai-key" },
			envAllowlist: ["XAI_API_KEY"],
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /author seat \(codex\).*OPENAI_API_KEY is not forwarded by security\.env-allowlist/);
	});

	it("key mode fails closed when the author identity is missing at resolution", () => {
		const policy = {
			...baseConfig().review.authoring,
			enabled: "keys" as const,
			reviewers: [{ id: "grok", provider: "grok" as const }],
			judge: { id: "judge", provider: "claude" as const },
		};
		const result = resolveAuthoringReviewExecution(policy, {
			unattendedSignals: ["CI/single-shot (--no-worktree)"],
			env: { ANTHROPIC_API_KEY: "anthropic-key", XAI_API_KEY: "xai-key" },
			envAllowlist: ["XAI_API_KEY"],
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /author seat requires key auth: author identity was not provided/);
	});
});

describe("detectUnattendedSignals — unattended-execution evidence (#276)", () => {
	const attended = { singleShot: false, multiCycle: false, env: {} as NodeJS.ProcessEnv, stdoutIsTTY: true };

	it("returns no signals (and no suppressions) for an attended interactive single-cycle run", () => {
		assert.deepEqual(detectUnattendedSignals(attended), { signals: [], suppressed: [] });
	});

	it("flags CI/single-shot execution", () => {
		const { signals } = detectUnattendedSignals({ ...attended, singleShot: true });
		assert.equal(signals.length, 1);
		assert.match(signals[0]!, /CI\/single-shot/);
	});

	it("flags daemon-spawned runs via PELAGGIO_SUPERVISED_RUN=1 and ignores other values", () => {
		const { signals } = detectUnattendedSignals({ ...attended, env: { PELAGGIO_SUPERVISED_RUN: "1" } });
		assert.equal(signals.length, 1);
		assert.match(signals[0]!, /daemon-spawned.*PELAGGIO_SUPERVISED_RUN=1/);
		assert.deepEqual(detectUnattendedSignals({ ...attended, env: { PELAGGIO_SUPERVISED_RUN: "0" } }).signals, []);
		assert.deepEqual(detectUnattendedSignals({ ...attended, env: { PELAGGIO_SUPERVISED_RUN: "" } }).signals, []);
	});

	it("flags multi-cycle campaigns", () => {
		const { signals } = detectUnattendedSignals({ ...attended, multiCycle: true });
		assert.equal(signals.length, 1);
		assert.match(signals[0]!, /multi-cycle/);
	});

	it("flags headless execution (no interactive TTY)", () => {
		const { signals } = detectUnattendedSignals({ ...attended, stdoutIsTTY: false });
		assert.equal(signals.length, 1);
		assert.match(signals[0]!, /interactive TTY/);
	});

	it("each signal alone fails local mode closed", () => {
		const policy = { ...baseConfig().review.authoring, enabled: "local" as const };
		const contexts = [
			{ ...attended, singleShot: true },
			{ ...attended, env: { PELAGGIO_SUPERVISED_RUN: "1" } },
			{ ...attended, multiCycle: true },
			{ ...attended, stdoutIsTTY: false },
		];
		for (const context of contexts) {
			const result = resolveAuthoringReviewExecution(policy, { unattendedSignals: detectUnattendedSignals(context).signals });
			assert.equal(result.ok, false);
		}
	});
});

describe("PELAGGIO_OPERATOR_ATTENDED — attestable headless/TTY signal (#276)", () => {
	const piped = { singleShot: false, multiCycle: false, env: {} as NodeJS.ProcessEnv, stdoutIsTTY: false };
	const localPolicy = () => ({ ...baseConfig().review.authoring, enabled: "local" as const });

	it("attested piped single-cycle run: TTY signal suppressed, local allowed, suppression carried for the cycle log", () => {
		const report = detectUnattendedSignals({ ...piped, env: { PELAGGIO_OPERATOR_ATTENDED: "1" } });
		assert.deepEqual(report, { signals: [], suppressed: [OPERATOR_ATTESTED_TTY_SUPPRESSION] });
		const result = resolveAuthoringReviewExecution(localPolicy(), { unattendedSignals: report.signals, suppressedSignals: report.suppressed });
		assert.equal(result.ok, true);
		if (!result.ok || !result.enabled) return;
		assert.deepEqual(result.suppressedSignals, [OPERATOR_ATTESTED_TTY_SUPPRESSION]);
	});

	it("unattested piped run is refused (headless signal fires)", () => {
		const report = detectUnattendedSignals(piped);
		assert.deepEqual(report.suppressed, []);
		const result = resolveAuthoringReviewExecution(localPolicy(), { unattendedSignals: report.signals, suppressedSignals: report.suppressed });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /interactive TTY/);
	});

	it('only the exact value "1" attests — "0", "true", "yes", and empty all fail closed', () => {
		for (const value of ["0", "true", "yes", ""]) {
			const report = detectUnattendedSignals({ ...piped, env: { PELAGGIO_OPERATOR_ATTENDED: value } });
			assert.equal(report.signals.length, 1, `value ${JSON.stringify(value)} must not attest`);
			assert.match(report.signals[0]!, /interactive TTY/);
			assert.deepEqual(report.suppressed, []);
		}
	});

	it("attestation is a disambiguation, not an override: attested + multi-cycle (cycles > 2) still refuses", () => {
		const report = detectUnattendedSignals({ ...piped, multiCycle: true, env: { PELAGGIO_OPERATOR_ATTENDED: "1" } });
		assert.deepEqual(
			report.signals.map((s) => /multi-cycle/.test(s)),
			[true],
		);
		assert.deepEqual(report.suppressed, [OPERATOR_ATTESTED_TTY_SUPPRESSION]);
		const result = resolveAuthoringReviewExecution(localPolicy(), { unattendedSignals: report.signals, suppressedSignals: report.suppressed });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.reason, /multi-cycle/);
			assert.match(result.reason, /suppressed by PELAGGIO_OPERATOR_ATTENDED attestation/);
			assert.match(result.reason, /never overrides other signals/);
		}
	});

	it("attestation never suppresses CI/single-shot or the daemon marker", () => {
		const ci = detectUnattendedSignals({ ...piped, singleShot: true, env: { PELAGGIO_OPERATOR_ATTENDED: "1" } });
		assert.deepEqual(
			ci.signals.map((s) => /CI\/single-shot/.test(s)),
			[true],
		);
		const daemon = detectUnattendedSignals({ ...piped, env: { PELAGGIO_OPERATOR_ATTENDED: "1", PELAGGIO_SUPERVISED_RUN: "1" } });
		assert.deepEqual(
			daemon.signals.map((s) => /daemon-spawned/.test(s)),
			[true],
		);
		for (const report of [ci, daemon]) {
			const result = resolveAuthoringReviewExecution(localPolicy(), { unattendedSignals: report.signals, suppressedSignals: report.suppressed });
			assert.equal(result.ok, false);
		}
	});

	it("attestation is inert on an interactive TTY (nothing to suppress, nothing recorded)", () => {
		const report = detectUnattendedSignals({ singleShot: false, multiCycle: false, env: { PELAGGIO_OPERATOR_ATTENDED: "1" }, stdoutIsTTY: true });
		assert.deepEqual(report, { signals: [], suppressed: [] });
	});
});
