/**
 * Claude auth-identity derivation (pool id, L3 helper): reads credential env vars and
 * credential files ONLY to derive non-secret digests. Secret values never escape this
 * module. Kept separate from claude.ts so the provider prompt/log paths audited by
 * trust claim TC-001 stay free of secret env-var handling.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { fstatSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import type { ApiKeySource } from "@anthropic-ai/claude-agent-sdk";
import { claudeAuthRealmInputs, claudeUsesThirdPartyProvider } from "../claude-seat.js";

const CLAUDE_API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
const CLAUDE_API_KEY_FILE_VARS = ["ANTHROPIC_API_KEY_FILE", "ANTHROPIC_AUTH_TOKEN_FILE", "CLAUDE_CODE_HOST_CREDS_FILE"] as const;
export const CLAUDE_ACCOUNT_ID_VARS = ["CLAUDE_CODE_ACCOUNT_UUID", "CLAUDE_CODE_ORGANIZATION_UUID", "CLAUDE_CODE_USER_EMAIL"] as const;
const CLAUDE_AUTH_REALM_FILE_VARS = new Set(["ANTHROPIC_IDENTITY_TOKEN_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "GOOGLE_APPLICATION_CREDENTIALS"]);
const CLAUDE_AUTH_REALM_IDENTITY_VARS = new Set([
	"ANTHROPIC_IDENTITY_TOKEN",
	"ANTHROPIC_IDENTITY_TOKEN_FILE",
	"ANTHROPIC_ORGANIZATION_ID",
	"ANTHROPIC_SERVICE_ACCOUNT_ID",
	"ANTHROPIC_WORKSPACE_ID",
	"ANTHROPIC_PROFILE",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"ANTHROPIC_FOUNDRY_AUTH_TOKEN",
	"ANTHROPIC_AWS_API_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_ROLE_ARN",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
	"AWS_PROFILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_CONFIG_FILE",
	"GOOGLE_APPLICATION_CREDENTIALS",
]);
const CLAUDE_DIRECT_API_KEY_VAR_NAMES = new Set<string>(CLAUDE_API_KEY_VARS);
const POOL_ID_HMAC_KEY = "pelaggio.poolId.v1";
const CLAUDE_AUTH_PROCESS_EPOCH = randomUUID();

function poolDigest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function credentialDigest(value: string): string {
	return createHmac("sha256", POOL_ID_HMAC_KEY).update(value).digest("hex").slice(0, 12);
}

function readCredentialFile(path: string | undefined): string | undefined {
	if (!path) return undefined;
	try {
		const value = readFileSync(path, "utf8").trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

function readCredentialFileDescriptor(value: string | undefined): string | undefined {
	if (!value || !/^\d+$/.test(value)) return undefined;
	try {
		const fd = Number.parseInt(value, 10);
		const size = fstatSync(fd).size;
		if (size <= 0) return undefined;
		const bytes = Buffer.alloc(size);
		const read = readSync(fd, bytes, 0, size, 0);
		const credential = bytes.subarray(0, read).toString("utf8").trim();
		return credential || undefined;
	} catch {
		// A non-seekable descriptor must stay untouched so the SDK can consume it.
		return undefined;
	}
}

function firstApiCredential(env: NodeJS.ProcessEnv): string | undefined {
	for (const name of CLAUDE_API_KEY_VARS) {
		if (env[name]) return env[name];
	}
	const descriptorCredential = readCredentialFileDescriptor(env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR);
	if (descriptorCredential) return descriptorCredential;
	for (const name of CLAUDE_API_KEY_FILE_VARS) {
		const credential = readCredentialFile(env[name]);
		if (credential) return credential;
	}
	return undefined;
}

function oauthProfileDigest(env: NodeJS.ProcessEnv): string | undefined {
	const descriptorCredential = readCredentialFileDescriptor(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR);
	const configDir = env.CLAUDE_CONFIG_DIR ?? (env.HOME ? join(env.HOME, ".claude") : undefined);
	const profileContents = descriptorCredential ?? env.CLAUDE_CODE_OAUTH_TOKEN ?? readCredentialFile(env.CLAUDE_CODE_HOST_CREDS_FILE) ?? (configDir ? readCredentialFile(join(configDir, ".credentials.json")) : undefined);
	return profileContents ? createHash("sha256").update(profileContents).digest("hex") : undefined;
}

function authConfigEpoch(env: NodeJS.ProcessEnv, sdkSource?: ApiKeySource): string {
	const inputs = claudeAuthRealmInputs(env)
		.filter(([name]) => sdkSource !== "oauth" || !CLAUDE_DIRECT_API_KEY_VAR_NAMES.has(name))
		.map(([name, value]) => {
			const fileContents = CLAUDE_AUTH_REALM_FILE_VARS.has(name) ? readCredentialFile(value) : undefined;
			return [name, credentialDigest(fileContents ?? value)] as const;
		});
	const source = sdkSource ? `sdk:${sdkSource}` : "none";
	const hasResolvedIdentity = inputs.some(([name]) => CLAUDE_AUTH_REALM_IDENTITY_VARS.has(name));
	const epoch = sdkSource === "oauth" || !hasResolvedIdentity ? CLAUDE_AUTH_PROCESS_EPOCH : "resolved";
	return credentialDigest(JSON.stringify([source, epoch, inputs]));
}

/**
 * Account/subscription realm identity for the `a:` pool channel. The subscription tier is part
 * of the realm: a subscription switch must invalidate the pool (provider-quota.md), so an
 * upgrade/downgrade on the same account never merges observations across subscription realms.
 */
export function claudeAccountRealmId(account: { organization?: string; email?: string; subscriptionType?: string }): string | undefined {
	const base = account.organization ?? account.email;
	return base ? `${base}|${account.subscriptionType ?? ""}` : undefined;
}

/**
 * Non-secret auth-realm discriminator. Credential values never leave this derivation.
 *
 * Realm-fidelity contract (mirrors provider-quota.md): EXACT realm fidelity is scoped to the
 * channels this deployment exercises — OAuth account identity plus subscription tier, and the
 * resolved direct-key digest. Outside those channels poolId is best-effort epoch identity, not
 * an exact realm claim. Accepted known limits (full realm fidelity across the open
 * auth-configuration set is a chartered follow-up):
 * - Multi-credential rotation: only the first configured direct credential is hashed, so
 *   rotating ANTHROPIC_AUTH_TOKEN while ANTHROPIC_API_KEY remains set leaves poolId unchanged.
 * - Organization-scoped OAuth collapse: organization, when present, supersedes email, so users
 *   sharing an organization and subscription tier share a poolId.
 * - Selector-only profiles: AWS_PROFILE / ANTHROPIC_PROFILE values are treated as resolved
 *   identities; repointing the same profile name to another account keeps the poolId.
 * - Credential-file / fd rotation: file and descriptor credentials are digested at spawn;
 *   rotation behind an unchanged path or descriptor is not re-observed within a process epoch.
 */
export function deriveClaudePoolId(env: NodeJS.ProcessEnv = process.env, sdkSource?: ApiKeySource, accountOrSubscriptionId?: string): string {
	const usesThirdPartyProvider = claudeUsesThirdPartyProvider(env);
	if (sdkSource !== "oauth" && !usesThirdPartyProvider) {
		const credential = firstApiCredential(env);
		if (credential) return `k:${credentialDigest(credential)}`;
	}
	// For OAuth, only live SDK accountInfo may supply account metadata. Ambient account
	// variables can be stale relative to the spawned seat's token/profile and must not
	// collapse distinct credential realms when accountInfo is unavailable.
	const accountId = accountOrSubscriptionId ?? (usesThirdPartyProvider || sdkSource === "oauth" ? undefined : CLAUDE_ACCOUNT_ID_VARS.map((name) => env[name]).find(Boolean));
	if (accountId) return `a:${poolDigest(accountId)}`;
	if (sdkSource === "oauth" || env.CLAUDE_CODE_OAUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR) {
		const profileDigest = oauthProfileDigest(env);
		if (profileDigest) return `a:${credentialDigest(profileDigest)}`;
	}
	return `e:${authConfigEpoch(env, sdkSource)}`;
}
