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

/**
 * SDK-documented Claude CLI auth names. The spawned process *is* the API client, so every
 * role extra-passes these independently of `security.env-allowlist`. They are not forge credentials.
 */
const CLAUDE_CLI_AUTH_VARS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"AWS_BEARER_TOKEN_BEDROCK",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"ANTHROPIC_FOUNDRY_AUTH_TOKEN",
	"ANTHROPIC_AWS_API_KEY",
	// Standard AWS credential chain for Bedrock deployments authenticated via env.
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
] as const;

/**
 * Provider-mode selectors and configuration documented for the Claude CLI's Bedrock /
 * Vertex / Foundry deployments, plus the CLI config-dir handle. `buildAgentEnv` replaces
 * the inherited environment, so omitting these would start such deployments in the wrong
 * provider mode or without their region/project/endpoint configuration. Fixed, non-secret
 * allowlist — deny-by-default is unchanged. Per-model `VERTEX_REGION_CLAUDE_*` overrides
 * are deliberately not enumerated; operators add them via `security.env-allowlist`.
 */
const CLAUDE_CLI_PROVIDER_CONFIG_VARS = [
	"CLAUDE_CONFIG_DIR",
	// Provider-mode selectors.
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_MANTLE",
	// Gateway skip-auth flags.
	"CLAUDE_CODE_SKIP_BEDROCK_AUTH",
	"CLAUDE_CODE_SKIP_VERTEX_AUTH",
	"CLAUDE_CODE_SKIP_MANTLE_AUTH",
	// Endpoint overrides.
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_BEDROCK_BASE_URL",
	"ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
	"ANTHROPIC_VERTEX_BASE_URL",
	"ANTHROPIC_FOUNDRY_BASE_URL",
	"ANTHROPIC_FOUNDRY_RESOURCE",
	// Vertex project/region + ADC locator.
	"ANTHROPIC_VERTEX_PROJECT_ID",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"CLOUD_ML_REGION",
	// AWS region/profile + config-file locators.
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_PROFILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_CONFIG_FILE",
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
 * missing" with a stranded claim). Non-secret, fixed pass-through for every role.
 * `PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET` stays harness-only by design (#511).
 */
const PELAGGIO_HARNESS_CONFIG_VARS = ["PELAGGIO_REPO", "PELAGGIO_WORKTREE_PREFIX", "PELAGGIO_AUTHORING_ENABLED"] as const;

/** Documented GitHub CLI token variables plus remote-auth / config-location handles needed by roadmap/`gh`/`git`. */
const FORGE_REMOTE_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "LINEAR_API_KEY", "SSH_AUTH_SOCK", "GH_CONFIG_DIR", "GH_HOST", "GH_ENTERPRISE_HOST"] as const;

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
	copyPresent(bag, CLAUDE_CLI_AUTH_VARS, extra);
	copyPresent(bag, CLAUDE_CLI_PROVIDER_CONFIG_VARS, extra);
	copyPresent(bag, PELAGGIO_HARNESS_CONFIG_VARS, extra);
	if (claudeSeatHoldsForgeAuthority(step)) copyPresent(bag, FORGE_REMOTE_VARS, extra);
	const env = buildAgentEnv({
		source: bag,
		allow: scopeEnvAllowlistToProvider(configuredAllowlist, "claude"),
		extra,
	});
	if (!claudeSeatHoldsForgeAuthority(step)) {
		for (const name of FORGE_REMOTE_VARS) delete env[name];
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
	return [cwd, options.home ?? process.env.HOME ?? "", options.tmpdir ?? process.env.TMPDIR ?? "", options.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR ?? "", options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? ""].flatMap(
		(value) => {
			const trimmed = value.trim();
			return trimmed === "" ? [] : [resolve(trimmed)];
		},
	);
}

/**
 * Existing GitHub CLI config directories for a denied role. Missing candidates are skipped
 * (CI runners often have `GH_TOKEN` and no `~/.config/gh`). Malformed/relative/non-directory/wide
 * targets fail closed. Harness fields only — never SDK-supplied child values.
 */
function resolveGitHubCredentialDirectories(options: ClaudeSeatBuildOptions, protectedRoots: readonly string[]): string[] {
	if (claudeSeatHoldsForgeAuthority(options.step)) return [];
	const home = harnessField(options.home, process.env.HOME);
	const xdgConfigHome = harnessField(options.xdgConfigHome, process.env.XDG_CONFIG_HOME);
	const ghConfigDir = harnessField(options.ghConfigDir, process.env.GH_CONFIG_DIR);
	const candidates: string[] = [];
	if (ghConfigDir !== undefined) candidates.push(ghConfigDir);
	if (xdgConfigHome !== undefined) candidates.push(join(xdgConfigHome, "gh"));
	if (home !== undefined) candidates.push(join(home, ".config", "gh"));
	const existing: string[] = [];
	for (const candidate of candidates) {
		const normalized = validateAbsolutePath(candidate, "GitHub credential directory");
		try {
			const resolved = realpathSync(normalized);
			if (!statSync(resolved).isDirectory()) {
				throw seatFailure(`cannot mask GitHub credential directory because it is not a directory: ${resolved}`);
			}
			if (isWideOrSharedParent(resolved, protectedRoots)) {
				throw seatFailure("rejected GitHub credential directory: parent directory is too wide to mask");
			}
			existing.push(resolved);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Claude seat isolation ")) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
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
	const credentialDirectories = resolveGitHubCredentialDirectories(options, protectedRoots);
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
