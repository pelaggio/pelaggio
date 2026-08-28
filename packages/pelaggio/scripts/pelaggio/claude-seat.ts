import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir as systemTmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { Transform, type Writable } from "node:stream";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { buildAgentEnv, makeSecretScrubber, scopeEnvAllowlistToProvider } from "./secret-hygiene.js";
import type { Step } from "./types.js";

/**
 * Harness-only Unix-socket locators whose dedicated parent directories the Claude
 * seat must mask. Resolve from the **harness** env (`process.env`), never from
 * `spawnOpts.env` — #511 can withhold the locator from the child without starving
 * the mount mask. Import this list rather than re-stringing a locator name.
 */
export const HARNESS_ONLY_SOCKET_ENVS = ["PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET"] as const;

/** Shared host directories that must never be replaced with an empty tmpfs. */
const WIDE_SOCKET_PARENTS = new Set(["/", "/tmp", "/var", "/var/tmp", "/run", "/var/run", "/dev", "/proc", "/sys", "/home", "/root", "/usr", "/etc", "/opt"]);
const MAX_BUFFERED_STDERR_BYTES = 64 * 1024;
const SOCKET_MASK_CANARY_PREFIX = "pelaggio-claude-seat-mask-";
const SOCKET_MASK_CANARY_VISIBLE_EXIT = 73;

/** Non-secret SDK control markers installed `@anthropic-ai/claude-agent-sdk@0.3.220` writes onto SpawnOptions.env. */
const CLAUDE_SDK_CONTROL_VARS = [
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_AGENT_SDK_VERSION",
	"CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
	"CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
	"CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
	"CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
] as const;

/** Direct Anthropic token credentials that third-party provider modes must not inherit stale. */
const DIRECT_ANTHROPIC_CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/**
 * Other SDK-documented Claude CLI auth/profile inputs, including the workload-identity-federation
 * activation set (names verified against the installed `@anthropic-ai/claude-agent-sdk`
 * `sdk.mjs`/`bridge.mjs`). The spawned process *is* the API client, so every role extra-passes
 * these independently of `security.env-allowlist`. They are not forge credentials.
 */
const CLAUDE_CLI_SHARED_AUTH_VARS = [
	// Workload-identity federation (first-party auth).
	"ANTHROPIC_IDENTITY_TOKEN",
	"ANTHROPIC_IDENTITY_TOKEN_FILE",
	"ANTHROPIC_FEDERATION_RULE_ID",
	"ANTHROPIC_ORGANIZATION_ID",
	"ANTHROPIC_SERVICE_ACCOUNT_ID",
	"ANTHROPIC_WORKSPACE_ID",
	// Profile-based auth (`ant auth login` profiles).
	"ANTHROPIC_CONFIG_DIR",
	"ANTHROPIC_PROFILE",
	"ANTHROPIC_SCOPE",
] as const;
const CLAUDE_CLI_AUTH_VARS = [...DIRECT_ANTHROPIC_CREDENTIAL_VARS, ...CLAUDE_CLI_SHARED_AUTH_VARS] as const;

/** Foundry credentials pass only when the provider is selected and native auth is not skipped. */
const FOUNDRY_MODE_CREDENTIAL_VARS = ["ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN"] as const;

/** Anthropic-on-AWS API auth passes only when that mode requires native auth, not in other AWS modes. */
const ANTHROPIC_AWS_MODE_CREDENTIAL_VARS = ["ANTHROPIC_AWS_API_KEY"] as const;

/**
 * AWS credential-chain inputs: static keys, STS web-identity, container credentials, and
 * the profile/config/region handles that select among them. The CLI consumes these only in
 * an AWS-flavored provider mode, so they pass **only when a selected AWS mode has not set
 * its matching skip-auth flag** — a denied seat on a host that uses AWS for unrelated
 * purposes must not inherit live AWS credentials.
 */
const AWS_MODE_CREDENTIAL_VARS = [
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
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
] as const;

/** Google ADC locator — gated on a Google-flavored mode that has not skipped native auth. */
const GOOGLE_MODE_CREDENTIAL_VARS = ["GOOGLE_APPLICATION_CREDENTIALS"] as const;

/** Mode-gated credential names cannot be promoted to unconditional pass-through by operator config. */
const MODE_GATED_CREDENTIAL_VARS = new Set<string>([...DIRECT_ANTHROPIC_CREDENTIAL_VARS, ...FOUNDRY_MODE_CREDENTIAL_VARS, ...ANTHROPIC_AWS_MODE_CREDENTIAL_VARS, ...AWS_MODE_CREDENTIAL_VARS, ...GOOGLE_MODE_CREDENTIAL_VARS]);

const AWS_AUTH_MODES = [
	["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_SKIP_BEDROCK_AUTH"],
	["CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_SKIP_MANTLE_AUTH"],
	["CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH"],
] as const;
const GOOGLE_AUTH_MODES = [
	["CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_SKIP_VERTEX_AUTH"],
	["CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH"],
] as const;
const FOUNDRY_AUTH_MODES = [["CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH"]] as const;
const ANTHROPIC_AWS_AUTH_MODES = [["CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH"]] as const;
const AWS_MODE_SELECTORS = AWS_AUTH_MODES.map(([selector]) => selector);
const GOOGLE_MODE_SELECTORS = GOOGLE_AUTH_MODES.map(([selector]) => selector);
const FOUNDRY_MODE_SELECTORS = FOUNDRY_AUTH_MODES.map(([selector]) => selector);
const THIRD_PARTY_PROVIDER_MODE_SELECTORS = [...AWS_MODE_SELECTORS, ...GOOGLE_MODE_SELECTORS, ...FOUNDRY_MODE_SELECTORS] as const;

/** Mirrors the CLI's own env-flag truthiness (sdk.mjs `ge()`): set and, lowercased/trimmed, one of 1/true/yes/on. */
function envFlagEnabled(bag: NodeJS.ProcessEnv, name: string): boolean {
	const value = bag[name];
	return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase().trim());
}

function providerModeEnabled(bag: NodeJS.ProcessEnv, selectors: readonly string[]): boolean {
	return selectors.some((name) => envFlagEnabled(bag, name));
}

function providerAuthRequired(bag: NodeJS.ProcessEnv, modes: ReadonlyArray<readonly [selector: string, skipAuth: string]>): boolean {
	return modes.some(([selector, skipAuth]) => envFlagEnabled(bag, selector) && !envFlagEnabled(bag, skipAuth));
}

/**
 * Provider-mode selectors and non-secret configuration for the Claude CLI's third-party
 * deployments (names verified against the installed SDK's provider env lists), plus the
 * CLI config-dir handle. `buildAgentEnv` replaces the inherited environment, so omitting
 * these would start such deployments in the wrong provider mode or without their
 * region/project/endpoint configuration. Fixed, non-secret allowlist — deny-by-default is
 * unchanged; provider credentials live in the mode-gated lists above.
 * Per-model `VERTEX_REGION_CLAUDE_*` overrides are deliberately not enumerated; operators
 * add them via `security.env-allowlist`.
 */
const CLAUDE_CLI_PROVIDER_CONFIG_VARS = [
	"CLAUDE_CONFIG_DIR",
	// Provider-mode selectors.
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_MANTLE",
	"CLAUDE_CODE_USE_GATEWAY",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	"CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
	// Gateway skip-auth flags.
	"CLAUDE_CODE_SKIP_BEDROCK_AUTH",
	"CLAUDE_CODE_SKIP_VERTEX_AUTH",
	"CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
	"CLAUDE_CODE_SKIP_MANTLE_AUTH",
	"CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
	"CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
	// Endpoint overrides.
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_BEDROCK_BASE_URL",
	"ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
	"ANTHROPIC_VERTEX_BASE_URL",
	"ANTHROPIC_FOUNDRY_BASE_URL",
	"ANTHROPIC_AWS_BASE_URL",
	"ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
	"ANTHROPIC_FOUNDRY_RESOURCE",
	// Project/region/workspace configuration.
	"ANTHROPIC_VERTEX_PROJECT_ID",
	"ANTHROPIC_AWS_WORKSPACE_ID",
	"ANTHROPIC_GOOGLE_CLOUD_PROJECT",
	"ANTHROPIC_GOOGLE_CLOUD_LOCATION",
	"ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_CLOUD_QUOTA_PROJECT",
	"CLOUD_ML_REGION",
	"ANTHROPIC_BEDROCK_REGION_PREFIX",
	"ANTHROPIC_BEDROCK_SERVICE_TIER",
	"ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
] as const;

/**
 * Harness-owned pelaggio config overrides the inner `npx pelaggio ...` CLI re-reads at
 * config load (every skill-invoked subcommand — roadmap/worktree-deps/decisions — builds
 * CONFIG on import). Dropping these desynchronizes inner and outer config resolution:
 * an env-selected `PELAGGIO_WORKTREE_PREFIX` makes the inner `roadmap claim` create a
 * worktree under one prefix while the outer pipeline looks for another ("worktree
 * missing" with a stranded claim). `PELAGGIO_TAXONOMY_PUBKEY` is the operator's out-of-band
 * taxonomy trust anchor (a PUBLIC key): without it, config load rejects signed taxonomy
 * contractions and every seat-inner CLI command fails on such repos. Non-secret, fixed
 * pass-through for every role. `PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET` stays harness-only
 * by design (#511).
 */
const PELAGGIO_HARNESS_CONFIG_VARS = ["PELAGGIO_REPO", "PELAGGIO_WORKTREE_PREFIX", "PELAGGIO_AUTHORING_ENABLED", "PELAGGIO_TAXONOMY_PUBKEY"] as const;

/** Documented GitHub CLI token variables plus remote-auth / config-location handles needed by roadmap/`gh`/`git`. */
const FORGE_REMOTE_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "LINEAR_API_KEY", "SSH_AUTH_SOCK", "GH_CONFIG_DIR", "GH_HOST", "GH_ENTERPRISE_HOST"] as const;

/**
 * Git-NATIVE auth/config channels that grant equivalent forge WRITE authority even without a
 * `GH_*` token: an injected `http.<host>.extraheader = Authorization: …` (GIT_CONFIG_COUNT +
 * GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n>), an attacker-pointed config file
 * (GIT_CONFIG/GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM), the SERIALIZED `-c` channel that carries the
 * same override in one variable (GIT_CONFIG_PARAMETERS), or a credential callback
 * (GIT_ASKPASS/SSH_ASKPASS/GIT_SSH/GIT_SSH_COMMAND/GIT_PROXY_COMMAND/GIT_CREDENTIAL_HELPER).
 * Denied to non-forge roles in
 * the SAME deny-by-default spirit as FORGE_REMOTE_VARS (#554) — otherwise `security.env-allowlist`
 * could re-open forge write authority to a denied seat. The harness's OWN authenticated fetch is
 * unaffected: reviewedHeadFetchAuthEnv sets GIT_CONFIG_COUNT/KEY_0/VALUE_0 directly on the
 * pr-review CLI's fetch child, never via a seat's inherited allowlist. GIT_CONFIG_KEY_<n>/VALUE_<n>
 * are indexed, so they are matched by PREFIX (not exact name).
 */
const GIT_AUTH_CHANNEL_VARS = [
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_PARAMETERS",
	"GIT_ASKPASS",
	"SSH_ASKPASS",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"GIT_PROXY_COMMAND",
	"GIT_CREDENTIAL_HELPER",
] as const;
const GIT_AUTH_CHANNEL_PREFIXES = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"] as const;

/** True for a git-native auth/config channel var (exact name or an indexed GIT_CONFIG_KEY_/VALUE_). */
export function isGitAuthChannelVar(name: string): boolean {
	return (GIT_AUTH_CHANNEL_VARS as readonly string[]).includes(name) || GIT_AUTH_CHANNEL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Privacy / telemetry-opt-out controls the SDK reads. Non-secret and privacy-PRESERVING: a host
 * that disabled telemetry or error reporting must stay disabled inside the seat, so these pass
 * through for every role (#554 finding 2). Distinct from debug/trace controls (DEBUG,
 * TRACEPARENT/TRACESTATE), which are deliberately dropped — those add output, these suppress it.
 */
const PRIVACY_CONTROL_VARS = ["DO_NOT_TRACK", "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] as const;

/** Explicit host controls that prevent cloud SDKs from discovering credentials through metadata services. */
const METADATA_CREDENTIAL_SUPPRESSION_VARS = ["AWS_EC2_METADATA_DISABLED", "METADATA_SERVER_DETECTION"] as const;

/**
 * Union of every env name the Claude seat may forward — unconditional pass-through,
 * mode-gated cloud credentials, and role-gated forge vars. Exported ONLY for the SDK
 * env-surface conformance test (claude-seat-env-conformance.test.ts); runtime behavior
 * always flows through {@link buildClaudeSeatEnv}, never this flat union.
 */
export const CLAUDE_SEAT_PASSTHROUGH_ENV_VARS: readonly string[] = [
	...CLAUDE_SDK_CONTROL_VARS,
	...CLAUDE_CLI_AUTH_VARS,
	...CLAUDE_CLI_PROVIDER_CONFIG_VARS,
	...PELAGGIO_HARNESS_CONFIG_VARS,
	...PRIVACY_CONTROL_VARS,
	...METADATA_CREDENTIAL_SUPPRESSION_VARS,
	...FOUNDRY_MODE_CREDENTIAL_VARS,
	...ANTHROPIC_AWS_MODE_CREDENTIAL_VARS,
	...AWS_MODE_CREDENTIAL_VARS,
	...GOOGLE_MODE_CREDENTIAL_VARS,
	...FORGE_REMOTE_VARS,
];

type ClaudeSeatForgeAuthority = "forge-capable" | "denied";

/**
 * Exhaustive internal policy over `Step`. Widening `Step` cannot silently inherit forge
 * authority. Interim set: pick/ship/shipwreck retain GitHub/Linear/SSH credentials;
 * every other current role is denied. Not operator-configurable — see #572 for a broker.
 */
const CLAUDE_SEAT_FORGE_AUTHORITY = {
	pick: "forge-capable",
	plan: "denied",
	"shakedown-plan": "denied",
	implement: "denied",
	"shakedown-code": "denied",
	ship: "forge-capable",
	shipwreck: "forge-capable",
	"pr-review": "denied",
	"pr-verify": "denied",
} as const satisfies Record<Step, ClaudeSeatForgeAuthority>;

export type ClaudeSeatSpawner = typeof spawn;

export interface ClaudeSeatBuildOptions {
	cwd: string;
	bwrap: string;
	/** Required role. Compile-time catch for omitted seat construction; the exhaustive record classifies it. */
	step: Step;
	/** Explicit locators; defaults to `resolveHarnessSocketPaths()`. */
	socketPaths?: readonly string[];
	home?: string;
	tmpdir?: string;
	xdgRuntimeDir?: string;
	/** `XDG_CONFIG_HOME` for GitHub CLI config resolution; defaults to `process.env.XDG_CONFIG_HOME`. */
	xdgConfigHome?: string;
	/** `GH_CONFIG_DIR` for GitHub CLI config resolution; defaults to `process.env.GH_CONFIG_DIR`. */
	ghConfigDir?: string;
	claudeConfigDir?: string;
	/** Anthropic profile root; defaults to `process.env.ANTHROPIC_CONFIG_DIR`, then the SDK's XDG/HOME location. */
	anthropicConfigDir?: string;
}

export interface ClaudeSeatSpawnOptions extends ClaudeSeatBuildOptions {
	onChildSpawn?: (info: { pid: number; cwd: string }) => void;
	spawn?: ClaudeSeatSpawner;
	stderr?: Writable;
	/** Operator `security.env-allowlist`; applied at spawn, not in the argv builder. */
	envAllowlist?: readonly string[];
}

export interface ClaudeSeatInvocation {
	command: string;
	args: readonly string[];
	cwd: string;
	socketParents: readonly string[];
	/** Union of socket parents and existing GitHub credential directories actually mounted as `--tmpfs`. */
	maskedDirectories: readonly string[];
}

export interface ClaudeSeatPreflightOptions {
	cwd: string;
	step: Step;
	pathValue?: string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	home?: string;
	tmpdir?: string;
	xdgRuntimeDir?: string;
	xdgConfigHome?: string;
	ghConfigDir?: string;
	claudeConfigDir?: string;
	anthropicConfigDir?: string;
	envAllowlist?: readonly string[];
	probe?: ClaudeSeatProbe;
}

export type ClaudeSeatPreflight = { ok: true; bwrap: string } | { ok: false; message: string };

export type ClaudeSeatProbe = (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => { error?: Error; status: number | null; signal?: NodeJS.Signals | null; stderr?: string | Buffer | null };

function seatFailure(detail: string): Error {
	return new Error(`Claude seat isolation ${detail}`);
}

export function claudeSeatHoldsForgeAuthority(step: Step): boolean {
	return CLAUDE_SEAT_FORGE_AUTHORITY[step] === "forge-capable";
}

function copyPresent(source: NodeJS.ProcessEnv, names: readonly string[], extra: Record<string, string>): void {
	for (const name of names) {
		const value = source[name];
		if (value !== undefined) extra[name] = value;
	}
}

/**
 * Deny-by-default child environment for the unconditional Claude spawn seam.
 * Source is the SDK-built `SpawnOptions.env` bag (control markers live there), never a fresh `process.env` read.
 */
export function buildClaudeSeatEnv(source: NodeJS.ProcessEnv | undefined, step: Step, configuredAllowlist: readonly string[] = []): NodeJS.ProcessEnv {
	const bag = source ?? {};
	const extra: Record<string, string> = {};
	copyPresent(bag, CLAUDE_SDK_CONTROL_VARS, extra);
	copyPresent(bag, CLAUDE_CLI_SHARED_AUTH_VARS, extra);
	if (!providerModeEnabled(bag, THIRD_PARTY_PROVIDER_MODE_SELECTORS)) copyPresent(bag, DIRECT_ANTHROPIC_CREDENTIAL_VARS, extra);
	copyPresent(bag, CLAUDE_CLI_PROVIDER_CONFIG_VARS, extra);
	copyPresent(bag, PELAGGIO_HARNESS_CONFIG_VARS, extra);
	copyPresent(bag, PRIVACY_CONTROL_VARS, extra);
	copyPresent(bag, METADATA_CREDENTIAL_SUPPRESSION_VARS, extra);
	// Provider credential chains pass only when a matching mode is selected and its gateway
	// has not explicitly disabled native authentication.
	if (providerAuthRequired(bag, FOUNDRY_AUTH_MODES)) copyPresent(bag, FOUNDRY_MODE_CREDENTIAL_VARS, extra);
	if (providerAuthRequired(bag, ANTHROPIC_AWS_AUTH_MODES)) copyPresent(bag, ANTHROPIC_AWS_MODE_CREDENTIAL_VARS, extra);
	if (providerAuthRequired(bag, AWS_AUTH_MODES)) copyPresent(bag, AWS_MODE_CREDENTIAL_VARS, extra);
	if (providerAuthRequired(bag, GOOGLE_AUTH_MODES)) copyPresent(bag, GOOGLE_MODE_CREDENTIAL_VARS, extra);
	if (claudeSeatHoldsForgeAuthority(step)) copyPresent(bag, FORGE_REMOTE_VARS, extra);
	// Mode/auth-gated credentials are controlled only by their selector/skip-auth pairs. Granted
	// values are already in `extra`; denied values must not reopen through security.env-allowlist.
	const allow = scopeEnvAllowlistToProvider(configuredAllowlist, "claude").filter((name) => !MODE_GATED_CREDENTIAL_VARS.has(name));
	const env = buildAgentEnv({
		source: bag,
		allow,
		extra,
	});
	if (!claudeSeatHoldsForgeAuthority(step)) {
		for (const name of FORGE_REMOTE_VARS) delete env[name];
		// Deny git-native auth/config channels too — the allowlist could otherwise re-open forge
		// write authority (extraheader, attacker config, credential callback) to a denied seat.
		for (const name of Object.keys(env)) if (isGitAuthChannelVar(name)) delete env[name];
	}
	return env;
}

function isWritableByInvokingUser(filePath: string): boolean {
	try {
		accessSync(filePath, constants.W_OK);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM") return false;
		throw error;
	}
}

function isTrustedRootOwnedPath(filePath: string, rootOwnerUid: number, kind: "file" | "directory"): boolean {
	const info = statSync(filePath);
	const expectedKind = kind === "file" ? info.isFile() : info.isDirectory();
	const invokingUid = process.geteuid?.();
	// Ownership is plantability: the owner can chmod a read-only path and replace it.
	return expectedKind && info.uid === rootOwnerUid && (info.mode & 0o022) === 0 && invokingUid !== rootOwnerUid && !isWritableByInvokingUser(filePath);
}

function isTrustedBwrap(candidate: string): boolean {
	const rootOwnerUid = statSync("/").uid;
	if (!isTrustedRootOwnedPath(candidate, rootOwnerUid, "file")) return false;
	try {
		accessSync(candidate, constants.X_OK);
	} catch {
		return false;
	}

	let directory = dirname(candidate);
	for (;;) {
		if (!isTrustedRootOwnedPath(directory, rootOwnerUid, "directory")) return false;
		if (directory === "/") return true;
		directory = dirname(directory);
	}
}

/** Linux-only synchronous PATH walk of a trusted system `bwrap`. Uses the harness PATH, never `spawnOpts.env.PATH`. */
export function resolveClaudeSeatBwrap(pathValue = process.env.PATH, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "linux") {
		throw seatFailure("requires Linux with Bubblewrap; switch provider or run on Linux");
	}
	for (const directory of (pathValue ?? "").split(":")) {
		if (!directory) continue;
		const candidate = join(directory, "bwrap");
		try {
			const resolvedCandidate = realpathSync(candidate);
			if (isTrustedBwrap(resolvedCandidate)) return resolvedCandidate;
		} catch {
			/* continue */
		}
	}
	throw seatFailure("requires Bubblewrap in a trusted system directory on PATH; install the bubblewrap package or switch provider (user-writable locations are ignored)");
}

/** Collect nonblank `HARNESS_ONLY_SOCKET_ENVS` values from the harness env bag. */
export function resolveHarnessSocketPaths(env: NodeJS.ProcessEnv = process.env): string[] {
	const paths: string[] = [];
	for (const name of HARNESS_ONLY_SOCKET_ENVS) {
		const value = env[name];
		if (typeof value === "string" && value.trim() !== "") paths.push(value.trim());
	}
	return paths;
}

function pathEqualsOrPrefixes(parent: string, target: string): boolean {
	return parent === target || target.startsWith(`${parent}/`);
}

function validateAbsolutePath(value: string, kind: "harness socket locator" | "GitHub credential directory"): string {
	if (value.includes("\0") || value.includes("\\")) {
		throw seatFailure(`rejected ${kind}: path contains forbidden characters`);
	}
	if (!isAbsolute(value)) {
		throw seatFailure(`rejected ${kind}: path is not absolute`);
	}
	if (value.split("/").some((segment) => segment === "." || segment === "..")) {
		throw seatFailure(`rejected ${kind}: path contains reserved segments`);
	}
	return normalize(value);
}

function validateLocatorParent(locator: string): string {
	const normalized = validateAbsolutePath(locator, "harness socket locator");
	const parent = dirname(normalized);
	try {
		return realpathSync(parent);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return parent;
		throw seatFailure(`could not resolve harness socket parent: ${parent}`);
	}
}

function isWideOrSharedParent(parent: string, protectedRoots: readonly string[]): boolean {
	if (WIDE_SOCKET_PARENTS.has(parent)) return true;
	return protectedRoots.some((root) => root !== "" && pathEqualsOrPrefixes(parent, root));
}

function collapseMountTargets(paths: readonly string[]): string[] {
	const unique = [...new Set(paths)].sort((a, b) => a.length - b.length || a.localeCompare(b));
	const kept: string[] = [];
	for (const parent of unique) {
		if (kept.some((outer) => pathEqualsOrPrefixes(outer, parent))) continue;
		kept.push(parent);
	}
	return kept.sort((a, b) => a.localeCompare(b));
}

/** Validate locators, reject wide/shared parents, keep the shallower parent when one prefixes another. */
export function resolveProtectedSocketParents(locators: readonly string[], protectedRoots: readonly string[]): string[] {
	const parents: string[] = [];
	for (const locator of locators) {
		if (locator.trim() === "") continue;
		const parent = validateLocatorParent(locator);
		if (isWideOrSharedParent(parent, protectedRoots)) {
			throw seatFailure("rejected harness socket locator: parent directory is too wide to mask");
		}
		parents.push(parent);
	}
	return collapseMountTargets(parents);
}

function harnessField(explicit: string | undefined, fallback: string | undefined): string | undefined {
	const value = explicit ?? fallback;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function protectedRootsFrom(options: ClaudeSeatBuildOptions, cwd: string): string[] {
	const home = harnessField(options.home, process.env.HOME);
	const xdgConfigHome = harnessField(options.xdgConfigHome, process.env.XDG_CONFIG_HOME);
	const anthropicConfigDir =
		harnessField(options.anthropicConfigDir, process.env.ANTHROPIC_CONFIG_DIR) ?? (xdgConfigHome !== undefined ? join(xdgConfigHome, "anthropic") : home !== undefined ? join(home, ".config", "anthropic") : undefined);
	return [cwd, home ?? "", options.tmpdir ?? process.env.TMPDIR ?? "", options.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR ?? "", options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? "", anthropicConfigDir ?? ""].flatMap((value) => {
		const trimmed = value.trim();
		return trimmed === "" ? [] : [resolve(trimmed)];
	});
}

/**
 * Existing GitHub CLI config directories for a denied role. Missing candidates are skipped
 * (CI runners often have `GH_TOKEN` and no `~/.config/gh`). Relative `GH_CONFIG_DIR` values
 * resolve from the seat cwd as gh does; relative XDG/HOME values remain invalid and are skipped.
 * Malformed/wide targets fail closed. Harness fields only — never SDK-supplied child values.
 */
function resolveGitHubCredentialDirectories(options: ClaudeSeatBuildOptions, cwd: string, protectedRoots: readonly string[]): string[] {
	if (claudeSeatHoldsForgeAuthority(options.step)) return [];
	const home = harnessField(options.home, process.env.HOME);
	const xdgConfigHome = harnessField(options.xdgConfigHome, process.env.XDG_CONFIG_HOME);
	const ghConfigDir = harnessField(options.ghConfigDir, process.env.GH_CONFIG_DIR);
	const candidates: string[] = [];
	if (ghConfigDir !== undefined) candidates.push(isAbsolute(ghConfigDir) ? ghConfigDir : resolve(cwd, ghConfigDir));
	if (xdgConfigHome !== undefined) candidates.push(join(xdgConfigHome, "gh"));
	if (home !== undefined) candidates.push(join(home, ".config", "gh"));
	const existing: string[] = [];
	for (const candidate of candidates) {
		// XDG basedir rule: a RELATIVE value in XDG_CONFIG_HOME/HOME is invalid and must be IGNORED, not
		// fatal — throwing here would fail every denied step closed on a harmless
		// misconfiguration. Only the not-absolute verdict is downgraded to a skip; forbidden
		// characters and reserved segments in absolute paths still fail closed, and the
		// remaining absolute candidates still mask.
		let normalized: string;
		try {
			normalized = validateAbsolutePath(candidate, "GitHub credential directory");
		} catch (error) {
			if (error instanceof Error && error.message.includes("path is not absolute")) {
				process.stderr.write(`⚠ Claude seat: ignoring relative GitHub credential directory candidate ${JSON.stringify(candidate)} (XDG requires absolute paths)\n`);
				continue;
			}
			throw error;
		}
		try {
			const resolved = realpathSync(normalized);
			if (!statSync(resolved).isDirectory()) {
				// A candidate that names a FILE cannot be tmpfs-masked and is not a usable gh
				// config dir; like the relative case, a misconfiguration skips (with a
				// diagnostic) rather than bricking every denied step.
				process.stderr.write(`⚠ Claude seat: ignoring GitHub credential directory candidate that is not a directory: ${resolved}\n`);
				continue;
			}
			if (isWideOrSharedParent(resolved, protectedRoots)) {
				throw seatFailure("rejected GitHub credential directory: parent directory is too wide to mask");
			}
			existing.push(resolved);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Claude seat isolation ")) throw error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") continue;
			if (code === "ENOTDIR") {
				// E.g. XDG_CONFIG_HOME names a file, making the candidate `<file>/gh` — same
				// misconfiguration class as above: skip, keep the remaining candidates.
				process.stderr.write(`⚠ Claude seat: ignoring GitHub credential directory candidate under a non-directory path: ${normalized}\n`);
				continue;
			}
			throw seatFailure(`could not resolve GitHub credential directory: ${normalized}`);
		}
	}
	return collapseMountTargets(existing);
}

function validateSocketParentMountTargets(parents: readonly string[]): void {
	for (const parent of parents) {
		try {
			if (!statSync(parent).isDirectory()) {
				throw seatFailure(`cannot mask harness socket parent because it is not a directory: ${parent}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw seatFailure(`cannot mask harness socket parent because it does not exist: ${parent}`);
			}
			throw error;
		}
	}
}

function createScrubbedStderrStream(env: NodeJS.ProcessEnv): Transform {
	// Hold the complete bounded stream so a credential split across chunks cannot evade scrubbing.
	// Oversized output is discarded before any byte reaches the operator/CI destination.
	const chunks: Buffer[] = [];
	let size = 0;
	let overflow = false;
	const scrub = makeSecretScrubber(env);
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			if (!overflow) {
				if (size + chunk.length > MAX_BUFFERED_STDERR_BYTES) {
					overflow = true;
					chunks.length = 0;
					size = 0;
				} else {
					chunks.push(Buffer.from(chunk));
					size += chunk.length;
				}
			}
			callback();
		},
		flush(callback) {
			this.push(overflow ? `[REDACTED: Claude seat stderr exceeded ${MAX_BUFFERED_STDERR_BYTES} bytes]\n` : scrub(Buffer.concat(chunks, size).toString("utf8")));
			callback();
		},
	});
}

export function buildClaudeSeatInvocation(spawnOpts: Pick<SpawnOptions, "command" | "args" | "cwd">, options: ClaudeSeatBuildOptions): ClaudeSeatInvocation {
	if (!isAbsolute(options.bwrap) || options.bwrap.includes("\0")) {
		throw seatFailure("requires an absolute Bubblewrap path");
	}
	const cwd = resolve(spawnOpts.cwd ?? options.cwd);
	const locators = options.socketPaths ?? resolveHarnessSocketPaths();
	const protectedRoots = protectedRootsFrom(options, cwd);
	const socketParents = resolveProtectedSocketParents(locators, protectedRoots);
	const credentialDirectories = resolveGitHubCredentialDirectories(options, cwd, protectedRoots);
	const maskedDirectories = collapseMountTargets([...socketParents, ...credentialDirectories]);
	const args: string[] = ["--unshare-pid", "--new-session", "--die-with-parent", "--dev-bind", "/", "/", "--proc", "/proc"];
	for (const parent of maskedDirectories) {
		args.push("--tmpfs", parent);
	}
	args.push("--chdir", cwd, "--", spawnOpts.command, ...spawnOpts.args);
	return { command: options.bwrap, args, cwd, socketParents, maskedDirectories };
}

/**
 * Launch the SDK command under Bubblewrap. Reports the host-visible outer
 * `bwrap` PID (the #369 session-binding handle) and returns the ChildProcess
 * as the SDK's SpawnedProcess. Cancellation uses the SDK-forwarded signal.
 */
export function spawnClaudeSeat(spawnOpts: SpawnOptions, options: ClaudeSeatSpawnOptions): SpawnedProcess {
	const invocation = buildClaudeSeatInvocation(spawnOpts, options);
	const spawnFn = options.spawn ?? spawn;
	const unfilteredEnv = (spawnOpts.env ?? {}) as NodeJS.ProcessEnv;
	const childEnv = buildClaudeSeatEnv(unfilteredEnv, options.step, options.envAllowlist ?? []);
	const child: ChildProcess = spawnFn(invocation.command, [...invocation.args], {
		cwd: invocation.cwd,
		env: childEnv,
		stdio: ["pipe", "pipe", "pipe"],
		signal: spawnOpts.signal,
	});
	// Scrub from the unfiltered SDK bag so a stripped forge token that still appears on stderr is redacted.
	child.stderr?.pipe(createScrubbedStderrStream(unfilteredEnv)).pipe(options.stderr ?? process.stderr, { end: false });
	const pid = child.pid;
	if (typeof pid === "number" && pid > 0) {
		options.onChildSpawn?.({ pid, cwd: invocation.cwd });
	}
	return child as unknown as SpawnedProcess;
}

/** Sync preflight used by `claudeRunStep` before `query()` so seat setup failures cannot become `error_sdk`. */
export function preflightClaudeSeat(options: ClaudeSeatPreflightOptions): ClaudeSeatPreflight {
	let canaryRoot: string | undefined;
	try {
		const bwrap = resolveClaudeSeatBwrap(options.pathValue ?? process.env.PATH, options.platform ?? process.platform);
		// Exercise the socket-parent mask even when no operational harness socket is
		// configured. Without this canary the namespace probe's successful exit says
		// nothing about --tmpfs masking on the common unconfigured path.
		canaryRoot = mkdtempSync(join(resolve(options.tmpdir ?? process.env.TMPDIR ?? systemTmpdir()), SOCKET_MASK_CANARY_PREFIX));
		const canaryPath = join(canaryRoot, "visible-from-host");
		writeFileSync(canaryPath, "must be hidden from the Claude seat\n", { mode: 0o600 });
		const invocation = buildClaudeSeatInvocation(
			{
				command: process.execPath,
				args: ["-e", `process.exit(require("node:fs").existsSync(process.argv[1]) ? ${SOCKET_MASK_CANARY_VISIBLE_EXIT} : 0)`, canaryPath],
				cwd: options.cwd,
			},
			{
				cwd: options.cwd,
				bwrap,
				step: options.step,
				socketPaths: [...resolveHarnessSocketPaths(options.env ?? process.env), canaryPath],
				home: options.home ?? process.env.HOME,
				tmpdir: options.tmpdir ?? process.env.TMPDIR,
				xdgRuntimeDir: options.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR,
				xdgConfigHome: options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME,
				ghConfigDir: options.ghConfigDir ?? process.env.GH_CONFIG_DIR,
				claudeConfigDir: options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR,
				anthropicConfigDir: options.anthropicConfigDir ?? process.env.ANTHROPIC_CONFIG_DIR,
			},
		);
		validateSocketParentMountTargets(invocation.socketParents);
		const probe =
			options.probe ??
			((command, args, probeOptions) =>
				spawnSync(command, [...args], {
					...probeOptions,
					stdio: ["ignore", "ignore", "pipe"],
				}));
		const result = probe(invocation.command, invocation.args, {
			cwd: invocation.cwd,
			env: buildClaudeSeatEnv(options.env ?? process.env, options.step, options.envAllowlist ?? []),
		});
		if (result.error) {
			throw seatFailure(`could not run the Bubblewrap namespace probe: ${result.error.message}`);
		}
		if (result.status === SOCKET_MASK_CANARY_VISIBLE_EXIT) {
			throw seatFailure("Bubblewrap socket-mask probe left its host canary visible");
		}
		if (result.status !== 0) {
			const stderr = result.stderr?.toString().trim();
			const outcome = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? "unknown"}`;
			throw seatFailure(`Bubblewrap namespace probe returned ${outcome}${stderr ? `: ${stderr}` : ""}`);
		}
		return { ok: true, bwrap };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	} finally {
		if (canaryRoot !== undefined) rmSync(canaryRoot, { recursive: true, force: true });
	}
}
