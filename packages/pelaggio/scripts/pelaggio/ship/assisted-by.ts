/**
 * Assisted-by commit-trailer provenance tier (#189).
 *
 * Lightweight, always-on attribution for AI-assisted landings. The harness stamps
 * `Assisted-by:` trailers on the ship squash (PR path) and skill-owned ship commits
 * (direct-push). This is forensic git-native provenance, not a signed attestation
 * (#186–188) and not a merge gate.
 *
 * Prefer `Assisted-by` over `Co-Authored-By`: the model assists; the human/operator
 * (via DCO `Signed-off-by`) remains the commit author.
 */
import { existsSync, readFileSync } from "node:fs";
import { LOG_PATH } from "../config.js";
import type { ProviderName } from "../types.js";

export interface AssistedByIdentity {
	/** Display name in the trailer value (e.g. "Claude"). */
	name: string;
	/** Stable machine-parseable address (noreply identity, not a personal seat). */
	email: string;
}

/** Trailer token as written (git trailers are case-insensitive on the key). */
export const ASSISTED_BY_TOKEN = "Assisted-by";

const PROVIDER_IDENTITY: Record<ProviderName, AssistedByIdentity> = {
	claude: { name: "Claude", email: "noreply@anthropic.com" },
	codex: { name: "Codex", email: "noreply@openai.com" },
	grok: { name: "Grok", email: "noreply@x.ai" },
};

/** Fallback when the cycle log has no realized authorship providers for the item. */
export const DEFAULT_ASSISTED_BY: AssistedByIdentity = PROVIDER_IDENTITY.claude;

const AI_NOREPLY_EMAILS = new Set(Object.values(PROVIDER_IDENTITY).map((id) => id.email.toLowerCase()));

/** Authorship-bearing pipeline steps whose realized provider contributes to the trailer set. */
const AUTHORSHIP_STEPS = new Set(["plan", "implement", "shakedown-plan", "shakedown-code", "ship"]);

export function identityForProvider(provider: ProviderName): AssistedByIdentity {
	return PROVIDER_IDENTITY[provider];
}

export function identitiesForProviders(providers: readonly ProviderName[]): AssistedByIdentity[] {
	return dedupeIdentities(providers.map(identityForProvider));
}

export function formatAssistedByLine(identity: AssistedByIdentity): string {
	return `${ASSISTED_BY_TOKEN}: ${identity.name} <${identity.email}>`;
}

/**
 * Append missing `Assisted-by` trailers to a commit body. Always-on: when
 * `identities` is empty, stamps {@link DEFAULT_ASSISTED_BY}.
 *
 * Idempotent: existing `Assisted-by` lines (any email) are preserved; only
 * missing identities are added. Strips AI-shaped `Co-Authored-By` lines that
 * duplicate the same noreply identities so ship does not double-claim.
 */
export function withAssistedBy(body: string, identities: readonly AssistedByIdentity[] = []): string {
	const toStamp = dedupeIdentities(identities.length > 0 ? identities : [DEFAULT_ASSISTED_BY]);
	const lines = body.replace(/\s+$/, "").split("\n");
	const kept: string[] = [];
	const existingEmails = new Set<string>();

	for (const line of lines) {
		const assisted = parseAssistedByLine(line);
		if (assisted) {
			existingEmails.add(assisted.email.toLowerCase());
			kept.push(line);
			continue;
		}
		const coauthored = parseCoAuthoredByLine(line);
		if (coauthored && AI_NOREPLY_EMAILS.has(coauthored.email.toLowerCase())) {
			// Drop AI Co-Authored-By — Assisted-by is the provenance trailer for those identities.
			continue;
		}
		kept.push(line);
	}

	const missing = toStamp.filter((id) => !existingEmails.has(id.email.toLowerCase()));
	if (missing.length === 0) {
		return kept.join("\n").replace(/\s+$/, "") + (kept.length > 0 ? "\n" : "");
	}

	// Ensure a blank line before trailers when the body has content and does not already end blank.
	while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
	if (kept.length > 0) kept.push("");
	for (const id of missing) kept.push(formatAssistedByLine(id));
	return `${kept.join("\n")}\n`;
}

/**
 * Unique providers that successfully ran authorship-bearing steps for `itemId`
 * in the cycle log (latest matching cycle entry, oldest-step order). Empty when
 * the log is missing or has no matching records — callers fall back via
 * {@link withAssistedBy}.
 */
export function collectLoggedAssistedByIdentities(itemId: string, logPath = LOG_PATH): AssistedByIdentity[] {
	if (!existsSync(logPath)) return [];
	try {
		const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
		for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
			const entry: unknown = JSON.parse(lines[lineIndex]);
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			if (typeof record.item !== "string" || record.item.toUpperCase() !== itemId.toUpperCase()) continue;
			if (!Array.isArray(record.steps)) continue;
			const providers: ProviderName[] = [];
			const seen = new Set<ProviderName>();
			for (const value of record.steps) {
				if (!value || typeof value !== "object") continue;
				const step = value as Record<string, unknown>;
				if (step.ok !== true) continue;
				if (typeof step.name !== "string" || !AUTHORSHIP_STEPS.has(step.name)) continue;
				const provider = step.provider;
				if (provider === "claude" || provider === "codex" || provider === "grok") {
					if (!seen.has(provider)) {
						seen.add(provider);
						providers.push(provider);
					}
				}
			}
			return providers.map(identityForProvider);
		}
	} catch {
		return [];
	}
	return [];
}

function dedupeIdentities(identities: readonly AssistedByIdentity[]): AssistedByIdentity[] {
	const out: AssistedByIdentity[] = [];
	const seen = new Set<string>();
	for (const id of identities) {
		const key = id.email.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(id);
	}
	return out;
}

function parseAssistedByLine(line: string): AssistedByIdentity | null {
	const m = line.match(/^\s*Assisted-by:\s*(.+?)\s*<([^>]+)>\s*$/i);
	if (!m) return null;
	return { name: m[1].trim(), email: m[2].trim() };
}

function parseCoAuthoredByLine(line: string): AssistedByIdentity | null {
	const m = line.match(/^\s*Co-Authored-By:\s*(.+?)\s*<([^>]+)>\s*$/i);
	if (!m) return null;
	return { name: m[1].trim(), email: m[2].trim() };
}
