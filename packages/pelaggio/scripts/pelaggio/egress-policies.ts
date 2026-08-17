import type { EgressPolicy, EgressRoute, FixedEgressRoute } from "./egress-broker.js";
import type { ProviderName } from "./types.js";

export const DEFAULT_EGRESS_LIMITS = Object.freeze({
	requestBodyBytes: 1_048_576,
	responseBodyBytes: 8_388_608,
	requestsPerWindow: 60,
	windowMs: 60_000,
	rateLimitRetryBudget: 20,
	requestsPerRun: 500,
	inputTokens: 10_000_000,
	outputTokens: 1_000_000,
	spendMicroUsd: 100_000_000,
});

const codexRoutes: readonly EgressRoute[] = [
	{
		id: "responses-v1",
		kind: "accounted",
		method: "POST",
		path: "/v1/responses",
		requestHeaders: ["accept", "content-type", "user-agent"],
		models: ["gpt-5.2-codex"],
		body: "json",
		modelField: "model",
		maxOutputTokensField: "max_output_tokens",
		streamField: "stream",
		stream: false,
		response: { kind: "json" },
		inputUsageField: ["usage", "input_tokens"],
		outputUsageField: ["usage", "output_tokens"],
		inputMicroUsdPerToken: { "gpt-5.2-codex": 2 },
		outputMicroUsdPerToken: { "gpt-5.2-codex": 14 },
	},
];

function fixedGrokRoute(id: string, method: "GET" | "POST", path: string, body: "none" | "json"): FixedEgressRoute {
	return { kind: "fixed", id, method, path, body, requestHeaders: ["accept", "content-type", "user-agent"] };
}

const fixedGrokRoutes: readonly EgressRoute[] = [
	fixedGrokRoute("models-v1", "GET", "/v1/models", "none"),
	fixedGrokRoute("settings-v1", "GET", "/v1/settings", "none"),
	fixedGrokRoute("mcp-configs-v1", "GET", "/v1/mcp/configs", "none"),
	fixedGrokRoute("bundle-archive-v1", "GET", "/v1/bundle/archive", "none"),
	fixedGrokRoute("feedback-config-v1", "GET", "/v1/feedback/config", "none"),
	fixedGrokRoute("responses-cancel-v1", "POST", "/v1/responses/cancel", "json"),
];

const grokRoutes: readonly EgressRoute[] = [
	...fixedGrokRoutes,
	{
		kind: "accounted",
		id: "responses-v1",
		method: "POST",
		path: "/v1/responses",
		requestHeaders: ["accept", "accept-encoding", "content-type", "user-agent", "x-stainless-arch", "x-stainless-lang", "x-stainless-os", "x-stainless-package-version", "x-stainless-runtime", "x-stainless-runtime-version"],
		models: ["grok-4.5"],
		body: "json",
		modelField: "model",
		maxOutputTokensField: "max_output_tokens",
		streamField: "stream",
		stream: true,
		response: { kind: "sse", terminalEvent: "response.completed" },
		inputUsageField: ["response", "usage", "input_tokens"],
		outputUsageField: ["response", "usage", "output_tokens"],
		inputMicroUsdPerToken: { "grok-4.5": 3 },
		outputMicroUsdPerToken: { "grok-4.5": 15 },
	},
];

export const BUILTIN_EGRESS_POLICIES = {
	codex: { id: "codex-v1", upstreamOrigin: "https://api.openai.com", limits: DEFAULT_EGRESS_LIMITS, routes: codexRoutes },
	grok: { id: "grok-v1", upstreamOrigin: "https://cli-chat-proxy.grok.com", limits: DEFAULT_EGRESS_LIMITS, routes: grokRoutes },
} satisfies Partial<Record<ProviderName, EgressPolicy>>;

export type BuiltinEgressProvider = keyof typeof BUILTIN_EGRESS_POLICIES;

export function resolveEgressPolicy(provider: string, model: string): EgressPolicy {
	const policy: EgressPolicy | undefined = BUILTIN_EGRESS_POLICIES[provider as BuiltinEgressProvider];
	if (!policy) throw new Error(`unsupported egress provider: ${provider}`);
	if (!policy.routes.some((route) => route.kind === "accounted" && route.models.includes(model))) throw new Error(`unsupported egress model for ${provider}: ${model}`);
	const routes: EgressRoute[] = [];
	for (const route of policy.routes) {
		if (route.kind === "fixed") routes.push(route);
		else if (route.models.includes(model)) routes.push({ ...route, models: [model] });
	}
	return {
		...policy,
		routes,
	};
}
