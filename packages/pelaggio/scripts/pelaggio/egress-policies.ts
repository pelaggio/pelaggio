import type { EgressPolicy } from "./egress-broker.js";
import type { ProviderName } from "./types.js";

export const DEFAULT_EGRESS_LIMITS = Object.freeze({
	requestBodyBytes: 1_048_576,
	responseBodyBytes: 8_388_608,
	requestsPerWindow: 60,
	windowMs: 60_000,
	requestsPerRun: 500,
	inputTokens: 10_000_000,
	outputTokens: 1_000_000,
	spendMicroUsd: 100_000_000,
});

export const BUILTIN_EGRESS_POLICIES = {
	codex: Object.freeze({
		id: "codex-v1",
		upstreamOrigin: "https://api.openai.com",
		limits: DEFAULT_EGRESS_LIMITS,
		routes: [
			Object.freeze({
				id: "responses-v1",
				method: "POST",
				path: "/v1/responses",
				models: ["gpt-5.2-codex"],
				body: "json",
				modelField: "model",
				maxOutputTokensField: "max_output_tokens",
				inputUsageField: ["usage", "input_tokens"],
				outputUsageField: ["usage", "output_tokens"],
				inputMicroUsdPerToken: { "gpt-5.2-codex": 2 },
				outputMicroUsdPerToken: { "gpt-5.2-codex": 14 },
			}),
		],
	}) satisfies EgressPolicy,
} satisfies Partial<Record<ProviderName, EgressPolicy>>;

export type BuiltinEgressProvider = keyof typeof BUILTIN_EGRESS_POLICIES;

export function resolveEgressPolicy(provider: string, model: string): EgressPolicy {
	const policy = BUILTIN_EGRESS_POLICIES[provider as BuiltinEgressProvider];
	if (!policy) throw new Error(`unsupported egress provider: ${provider}`);
	if (!policy.routes.some((route) => route.models.includes(model))) throw new Error(`unsupported egress model for ${provider}: ${model}`);
	return { ...policy, routes: policy.routes.map((route) => ({ ...route, models: route.models.includes(model) ? [model] : [] })).filter((route) => route.models.length > 0) };
}
