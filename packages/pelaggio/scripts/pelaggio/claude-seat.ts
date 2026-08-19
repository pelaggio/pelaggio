import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir as systemTmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { Transform, type Writable } from "node:stream";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { makeSecretScrubber } from "./secret-hygiene.js";

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

export type ClaudeSeatSpawner = typeof spawn;

export interface ClaudeSeatBuildOptions {
	cwd: string;
	bwrap: string;
	/** Explicit locators; defaults to `resolveHarnessSocketPaths()`. */
	socketPaths?: readonly string[];
	home?: string;
	tmpdir?: string;
	xdgRuntimeDir?: string;
	claudeConfigDir?: string;
}

export interface ClaudeSeatSpawnOptions extends ClaudeSeatBuildOptions {
	onChildSpawn?: (info: { pid: number; cwd: string }) => void;
	spawn?: ClaudeSeatSpawner;
	stderr?: Writable;
}

export interface ClaudeSeatInvocation {
	command: string;
	args: readonly string[];
	cwd: string;
	socketParents: readonly string[];
}

export interface ClaudeSeatPreflightOptions {
	cwd: string;
	pathValue?: string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	home?: string;
	tmpdir?: string;
	xdgRuntimeDir?: string;
	claudeConfigDir?: string;
	probe?: ClaudeSeatProbe;
}

export type ClaudeSeatPreflight = { ok: true; bwrap: string } | { ok: false; message: string };

export type ClaudeSeatProbe = (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => { error?: Error; status: number | null; signal?: NodeJS.Signals | null; stderr?: string | Buffer | null };

function seatFailure(detail: string): Error {
	return new Error(`Claude seat isolation ${detail}`);
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

function validateLocatorParent(locator: string): string {
	if (locator.includes("\0") || locator.includes("\\")) {
		throw seatFailure("rejected harness socket locator: path contains forbidden characters");
	}
	if (!isAbsolute(locator)) {
		throw seatFailure("rejected harness socket locator: path is not absolute");
	}
	if (locator.split("/").some((segment) => segment === "." || segment === "..")) {
		throw seatFailure("rejected harness socket locator: path contains reserved segments");
	}
	const normalized = normalize(locator);
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
	const unique = [...new Set(parents)].sort((a, b) => a.length - b.length || a.localeCompare(b));
	const kept: string[] = [];
	for (const parent of unique) {
		if (kept.some((outer) => pathEqualsOrPrefixes(outer, parent))) continue;
		kept.push(parent);
	}
	return kept.sort((a, b) => a.localeCompare(b));
}

function protectedRootsFrom(options: ClaudeSeatBuildOptions, cwd: string): string[] {
	return [cwd, options.home ?? process.env.HOME ?? "", options.tmpdir ?? process.env.TMPDIR ?? "", options.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR ?? "", options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? ""].flatMap(
		(value) => {
			const trimmed = value.trim();
			return trimmed === "" ? [] : [resolve(trimmed)];
		},
	);
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
	const socketParents = resolveProtectedSocketParents(locators, protectedRootsFrom(options, cwd));
	const args: string[] = ["--unshare-pid", "--new-session", "--die-with-parent", "--dev-bind", "/", "/", "--proc", "/proc"];
	for (const parent of socketParents) {
		args.push("--tmpfs", parent);
	}
	args.push("--chdir", cwd, "--", spawnOpts.command, ...spawnOpts.args);
	return { command: options.bwrap, args, cwd, socketParents };
}

/**
 * Launch the SDK command under Bubblewrap. Reports the host-visible outer
 * `bwrap` PID (the #369 session-binding handle) and returns the ChildProcess
 * as the SDK's SpawnedProcess. Cancellation uses the SDK-forwarded signal.
 */
export function spawnClaudeSeat(spawnOpts: SpawnOptions, options: ClaudeSeatSpawnOptions): SpawnedProcess {
	const invocation = buildClaudeSeatInvocation(spawnOpts, options);
	const spawnFn = options.spawn ?? spawn;
	const child: ChildProcess = spawnFn(invocation.command, [...invocation.args], {
		cwd: invocation.cwd,
		env: spawnOpts.env as NodeJS.ProcessEnv,
		stdio: ["pipe", "pipe", "pipe"],
		signal: spawnOpts.signal,
	});
	child.stderr?.pipe(createScrubbedStderrStream(spawnOpts.env as NodeJS.ProcessEnv)).pipe(options.stderr ?? process.stderr, { end: false });
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
				socketPaths: [...resolveHarnessSocketPaths(options.env ?? process.env), canaryPath],
				home: options.home ?? process.env.HOME,
				tmpdir: options.tmpdir ?? process.env.TMPDIR,
				xdgRuntimeDir: options.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR,
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
			env: options.env ?? process.env,
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
