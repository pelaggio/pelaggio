/** Provider registry (L3): the only place that knows every provider. `step-runner` dispatches through it. */

import type { ProviderName } from "../types.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";
import { grokProvider } from "./grok.js";
import { opencodeProvider } from "./opencode.js";
import type { StepProvider } from "./types.js";

// Keyed by `ProviderName` so the map is exhaustive over the union — #80's widening
// surfaces a compile error here until it registers the new provider.
const PROVIDERS: Record<ProviderName, StepProvider> = {
	claude: claudeProvider,
	codex: codexProvider,
	grok: grokProvider,
	opencode: opencodeProvider,
};

export const REGISTERED_PROVIDERS: readonly ProviderName[] = Object.freeze(Object.keys(PROVIDERS) as ProviderName[]);

/** Look up a registered provider. Throws on an unknown name — defense-in-depth for
 *  #80 (a misconfigured provider fails loudly rather than silently defaulting). */
export function getProvider(name: ProviderName): StepProvider {
	const provider = PROVIDERS[name];
	if (!provider) throw new Error(`unknown step provider: ${name}`);
	return provider;
}
