import type { DiscoveryResourceKey, DiscoverySchedulingProfile } from "../review/discovery-fleet.js";
import type { ProviderName } from "../types.js";

export const REVIEW_RESOURCE_CAPACITIES: Readonly<Record<DiscoveryResourceKey, number>> = {
	"review:claude-session": 1,
	"review:codex-session": 1,
	"review:grok-session": 1,
	"review:opencode-session": 1,
};

export const REVIEW_SCHEDULING_PROFILES = {
	claude: { claims: [{ key: "review:claude-session", units: 1 }], waitsForProviders: [] },
	codex: { claims: [{ key: "review:codex-session", units: 1 }], waitsForProviders: [] },
	grok: { claims: [{ key: "review:grok-session", units: 1 }], waitsForProviders: ["claude"] },
	opencode: { claims: [{ key: "review:opencode-session", units: 1 }], waitsForProviders: [] },
} satisfies Readonly<Record<ProviderName, DiscoverySchedulingProfile>>;
