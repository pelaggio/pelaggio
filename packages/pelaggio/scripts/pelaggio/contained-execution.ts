import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type EgressAuth, type EgressBrokerHandle, EgressFatalError, type EgressRequester, startEgressBroker } from "./egress-broker.js";
import { resolveEgressPolicy } from "./egress-policies.js";
import { buildAgentEnv, makeSecretScrubber } from "./secret-hygiene.js";
import { ensureWorktreeDeps } from "./worktree-deps.js";

export type ContainedRunMode = { kind: "command"; argv: readonly [string, ...string[]] } | { kind: "self-test" };

export type WriteSetEntry = { kind: "create" | "modify"; path: string; digest: string } | { kind: "delete"; path: string };

export interface ContainedRunOptions {
	worktree: string;
	mode: ContainedRunMode;
	debug?: boolean;
	timeoutSeconds?: number;
	egress?: { provider: string; model: string; auth: EgressAuth };
}

export type ContainedCommand =
	| { kind: "runtime"; argv: readonly [string, ...string[]] }
	| { kind: "mounted-driver"; source: string; args: readonly string[] }
	| { kind: "brokered-mounted-driver"; source: string; args: readonly string[]; bridgeSource?: string };

export type PrivateHomeEntry = { kind: "copy"; source: string; destination: string; mode: number } | { kind: "literal"; content: string; destination: string; mode: number };

export interface ContainedLifecycleOptions {
	worktree: string;
	command: ContainedCommand;
	debug?: boolean;
	timeoutSeconds?: number;
	egress?: { provider: string; model: string; auth: EgressAuth };
	privateHome?: readonly PrivateHomeEntry[];
	mainRepo?: string;
	signal?: AbortSignal;
}

export interface ContainedRunResult {
	status: number;
	signal: NodeJS.Signals | null;
	writeSet: readonly WriteSetEntry[];
	artifactDir?: string;
}

export interface ContainedDriverResult<T> {
	value: T;
	status: number;
	signal: NodeJS.Signals | null;
	stderr: string;
}

export interface ContainedLifecycleResult<T> extends ContainedRunResult {
	value: T;
}

export type ContainedFailureReason = "rate_limit" | "budget" | "confinement";

export class ContainedFailure extends Error {
	constructor(
		message: string,
		readonly reason: ContainedFailureReason,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ContainedFailure";
	}
}

export interface SelfTestProbe {
	name: string;
	passed: boolean;
	detail?: string;
}

export interface ContainedSelfTestResult {
	passed: boolean;
	probes: readonly SelfTestProbe[];
	artifactDir?: string;
}

export interface ContainedCapabilities {
	platform: NodeJS.Platform;
	bwrap: string;
	systemdRun: string;
	systemctl: string;
	runtimeRoots: readonly string[];
}

export interface ContainedInvocation {
	executable: string;
	argv: readonly string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
	unit: string;
	kill: { executable: string; argv: readonly string[] };
}

type FileRecord = { kind: "file"; digest: string; dev: bigint; ino: bigint; size: bigint } | { kind: "symlink"; target: string; dev: bigint; ino: bigint };

const snapshotBrand: unique symbol = Symbol("WriteSnapshot");
export interface WriteSnapshot {
	readonly [snapshotBrand]: true;
	readonly worktree: string;
	readonly files: ReadonlyMap<string, FileRecord>;
	readonly gitSentinel: string;
}

export interface ContainedDependencies {
	listGitFiles?: (worktree: string) => Promise<readonly string[]>;
	spawn?: typeof spawnProcess;
	discoverCapabilities?: () => Promise<ContainedCapabilities>;
	preflight?: (invocation: ContainedInvocation) => Promise<void>;
	privateRoot?: string;
	afterPostSnapshot?: () => Promise<void>;
	startBroker?: typeof startEgressBroker;
	brokerRequester?: EgressRequester;
	runKill?: typeof spawnProcess;
	ensureDeps?: (worktree: string, mainRepo: string) => void;
	resolveDependencyTargets?: (worktree: string, mainRepo: string) => Promise<readonly string[]>;
}

const RUNTIME_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64"] as const;
const CGROUP_PROPERTIES = ["TasksMax=512", "MemoryMax=4G", "CPUQuota=200%", "KillMode=control-group"] as const;
export const CONTAINED_LOOPBACK_PORT = 43179;
export const CONTAINED_BRIDGE_PATH = fileURLToPath(new URL("./contained-loopback-bridge.mjs", import.meta.url));

type ResolvedContainedCommand =
	| { kind: "runtime"; argv: readonly [string, ...string[]] }
	| { kind: "mounted-driver"; source: string; jailPath: string; args: readonly string[] }
	| { kind: "brokered-mounted-driver"; source: string; jailPath: string; args: readonly string[]; bridgeSource: string; bridgeJailPath: string; node: string; nodeSource?: string };

function assertRelativePath(path: string): void {
	if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === ".." || part === ".git")) {
		throw new Error(`unsafe Git path: ${JSON.stringify(path)}`);
	}
}

async function gitFiles(worktree: string): Promise<readonly string[]> {
	const result = await spawnProcess("git", ["-C", worktree, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: worktree });
	if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
	return result.stdout.split("\0").filter(Boolean);
}

async function gitSentinelDigest(worktree: string): Promise<string> {
	const path = join(worktree, ".git");
	const info = await lstat(path);
	const body = info.isSymbolicLink() ? await readlink(path) : info.isFile() ? await readFile(path) : Buffer.from("");
	return createHash("sha256").update(`${info.mode}:${info.dev}:${info.ino}:`).update(body).digest("hex");
}

async function inspectPath(worktree: string, path: string): Promise<FileRecord | undefined> {
	assertRelativePath(path);
	const absolute = resolve(worktree, path);
	if (relative(worktree, absolute).startsWith(`..${sep}`)) throw new Error(`path escapes worktree: ${path}`);
	const parts = path.split("/");
	let cursor = worktree;
	for (const part of parts.slice(0, -1)) {
		cursor = join(cursor, part);
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(cursor, { bigint: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe ancestor for ${path}`);
	}
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(absolute, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (info.isSymbolicLink()) return { kind: "symlink", target: await readlink(absolute), dev: info.dev, ino: info.ino };
	if (!info.isFile()) throw new Error(`non-regular Git path: ${path}`);
	if (info.nlink !== 1n) throw new Error(`hardlinked Git path: ${path}`);
	const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.nlink !== 1n) throw new Error(`path identity changed: ${path}`);
		const digest = createHash("sha256")
			.update(await handle.readFile())
			.digest("hex");
		return { kind: "file", digest, dev: opened.dev, ino: opened.ino, size: opened.size };
	} finally {
		await handle.close();
	}
}

export async function captureWriteSnapshot(worktree: string, deps: ContainedDependencies = {}): Promise<WriteSnapshot> {
	const root = await realpath(worktree);
	const files = new Map<string, FileRecord>();
	for (const path of await (deps.listGitFiles ?? gitFiles)(root)) {
		if (files.has(path)) continue;
		const record = await inspectPath(root, path);
		if (record) files.set(path, record);
	}
	return { [snapshotBrand]: true, worktree: root, files, gitSentinel: await gitSentinelDigest(root) };
}

function sameRecord(left: FileRecord, right: FileRecord): boolean {
	return left.kind === "file" && right.kind === "file" ? left.digest === right.digest : left.kind === "symlink" && right.kind === "symlink" && left.target === right.target;
}

export async function computeWriteSet(before: WriteSnapshot, worktree: string, deps: ContainedDependencies = {}): Promise<readonly WriteSetEntry[]> {
	const root = await realpath(worktree);
	if (root !== before.worktree) throw new Error("snapshot belongs to a different worktree");
	if ((await gitSentinelDigest(root)) !== before.gitSentinel) throw new Error("Git metadata sentinel changed");
	const paths = new Set<string>([...before.files.keys(), ...(await (deps.listGitFiles ?? gitFiles)(root))]);
	const post = new Map<string, FileRecord | undefined>();
	const result: WriteSetEntry[] = [];
	for (const path of [...paths].sort()) {
		const oldRecord = before.files.get(path);
		const newRecord = await inspectPath(root, path);
		post.set(path, newRecord);
		if (oldRecord && !newRecord) result.push({ kind: "delete", path });
		else if (!oldRecord && newRecord) {
			if (newRecord.kind !== "file") throw new Error(`changed symlink rejected: ${path}`);
			result.push({ kind: "create", path, digest: newRecord.digest });
		} else if (oldRecord && newRecord && !sameRecord(oldRecord, newRecord)) {
			if (newRecord.kind !== "file") throw new Error(`changed symlink rejected: ${path}`);
			result.push({ kind: "modify", path, digest: newRecord.digest });
		}
	}
	await deps.afterPostSnapshot?.();
	for (const entry of result) {
		if (entry.kind === "delete") continue;
		const final = await inspectPath(root, entry.path);
		const captured = post.get(entry.path);
		if (final?.kind !== "file" || !captured || captured.kind !== "file" || final.digest !== entry.digest || final.dev !== captured.dev || final.ino !== captured.ino) {
			throw new Error(`path changed during validation: ${entry.path}`);
		}
	}
	return result;
}

export function buildContainedInvocation(
	options: {
		worktree: string;
		command: ResolvedContainedCommand | readonly [string, ...string[]];
		privateDir: string;
		gitMask: string;
		dependencyTargets?: readonly string[];
		egressSocket?: string;
		timeoutSeconds?: number;
	},
	capabilities: ContainedCapabilities,
): ContainedInvocation {
	if (capabilities.platform !== "linux") throw new Error("contained execution requires Linux");
	const command: ResolvedContainedCommand = Array.isArray(options.command) ? { kind: "runtime", argv: options.command as readonly [string, ...string[]] } : (options.command as ResolvedContainedCommand);
	if (command.kind === "runtime" && (!isAbsolute(command.argv[0]) || !capabilities.runtimeRoots.some((root) => command.argv[0] === root || command.argv[0].startsWith(`${root}/`)))) {
		throw new Error("command must resolve beneath a read-only runtime root");
	}
	const unit = `pelaggio-contained-${randomUUID()}.scope`;
	const jailHome = "/run/pelaggio/home";
	const source: NodeJS.ProcessEnv = Object.fromEntries(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));
	const env = buildAgentEnv({
		source,
		extra: { HOME: jailHome, XDG_CONFIG_HOME: `${jailHome}/.config`, XDG_CACHE_HOME: `${jailHome}/.cache`, XDG_DATA_HOME: `${jailHome}/.local/share`, XDG_RUNTIME_DIR: "/run/pelaggio/xdg", TMPDIR: "/run/pelaggio/tmp" },
	});
	const bwrap: string[] = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv"];
	for (const root of capabilities.runtimeRoots) bwrap.push("--ro-bind", root, root);
	bwrap.push(
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/run",
		"--tmpfs",
		"/tmp",
		"--dir",
		"/run/pelaggio",
		"--bind",
		join(options.privateDir, "home"),
		jailHome,
		"--bind",
		join(options.privateDir, "xdg"),
		"/run/pelaggio/xdg",
		"--bind",
		join(options.privateDir, "tmp"),
		"/run/pelaggio/tmp",
		"--bind",
		options.worktree,
		options.worktree,
		"--ro-bind",
		options.gitMask,
		join(options.worktree, ".git"),
	);
	if (options.egressSocket) {
		bwrap.push("--ro-bind", options.egressSocket, "/run/pelaggio/egress.sock");
		env.PELAGGIO_EGRESS_SOCKET = "/run/pelaggio/egress.sock";
	}
	if (command.kind !== "runtime") bwrap.push("--dir", "/run/pelaggio/bin", "--ro-bind", command.source, command.jailPath);
	if (command.kind === "brokered-mounted-driver") {
		bwrap.push("--ro-bind", command.bridgeSource, command.bridgeJailPath);
		if (command.nodeSource) bwrap.push("--ro-bind", command.nodeSource, command.node);
		env.PELAGGIO_EGRESS_BASE_URL = `http://127.0.0.1:${CONTAINED_LOOPBACK_PORT}`;
	}
	for (const target of options.dependencyTargets ?? []) bwrap.push("--ro-bind", target, target);
	for (const [key, value] of Object.entries(env)) if (value !== undefined) bwrap.push("--setenv", key, value);
	const driverArgv = command.kind === "runtime" ? command.argv : command.kind === "mounted-driver" ? ([command.jailPath, ...command.args] as const) : ([command.node, command.bridgeJailPath, command.jailPath, ...command.args] as const);
	bwrap.push("--chdir", options.worktree, "--", ...driverArgv);
	const timeoutSeconds = Math.min(1800, Math.max(1, Math.floor(options.timeoutSeconds ?? 1800)));
	const properties = [...CGROUP_PROPERTIES, `RuntimeMaxSec=${timeoutSeconds}`];
	const argv = ["--user", "--scope", "--wait", "--collect", "--pipe", "--quiet", "--unit", unit, ...properties.flatMap((value) => ["--property", value]), "--", capabilities.bwrap, ...bwrap];
	// `systemd-run --user` must reach the caller's user manager over D-Bus; forward only the session
	// locator vars (never secrets). The jail's own env is set separately via bwrap --clearenv/--setenv,
	// so this launcher env never reaches the contained process.
	const launcherEnv: NodeJS.ProcessEnv = Object.fromEntries(["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));
	return { executable: capabilities.systemdRun, argv, env: launcherEnv, cwd: options.worktree, unit, kill: { executable: capabilities.systemctl, argv: ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit] } };
}

interface SpawnResult {
	status: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}
async function spawnProcess(executable: string, argv: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<SpawnResult> {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(executable, argv, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs) : undefined;
		child.once("close", (status, signal) => {
			if (timer) clearTimeout(timer);
			resolvePromise({ status: status ?? 1, signal, stdout, stderr });
		});
	});
}

async function findCommand(name: string, pathValue = process.env.PATH ?? ""): Promise<string> {
	if (isAbsolute(name)) return await realpath(name);
	for (const directory of pathValue.split(":")) {
		const candidate = join(directory, name);
		try {
			const info = await stat(candidate);
			if (info.isFile() && (info.mode & 0o111) !== 0) return await realpath(candidate);
		} catch {
			/* continue */
		}
	}
	throw new Error(`required executable not found: ${name}`);
}

function assertPrivateDestination(destination: string): void {
	if (!destination || isAbsolute(destination) || destination.includes("\\") || destination.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new Error(`unsafe private-home destination: ${JSON.stringify(destination)}`);
	}
}

async function stagePrivateHome(privateDir: string, entries: readonly PrivateHomeEntry[]): Promise<void> {
	for (const entry of entries) {
		assertPrivateDestination(entry.destination);
		if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || (entry.mode & 0o077) !== 0) throw new Error(`invalid private-home mode for ${entry.destination}`);
		const destination = join(privateDir, "home", entry.destination);
		await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
		let content: Buffer | string;
		if (entry.kind === "literal") content = entry.content;
		else {
			if (!isAbsolute(entry.source)) throw new Error("private-home copy source must be absolute");
			const before = await lstat(entry.source, { bigint: true });
			if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error("private-home copy source must be a single-link regular file");
			const handle = await open(entry.source, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const opened = await handle.stat({ bigint: true });
				if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n) throw new Error("private-home copy source identity changed");
				content = await handle.readFile();
			} finally {
				await handle.close();
			}
		}
		const output = await open(destination, "wx", entry.mode);
		try {
			await output.writeFile(content);
		} finally {
			await output.close();
		}
		await chmod(destination, entry.mode);
	}
}

async function validateMountedFile(source: string, executable: boolean): Promise<string> {
	if (!isAbsolute(source)) throw new Error("mounted source must be absolute");
	const before = await lstat(source, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (executable && (before.mode & 0o111n) === 0n)) throw new Error("mounted source must be a safe regular executable");
	const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n) throw new Error("mounted source identity changed");
	} finally {
		await handle.close();
	}
	return source;
}

async function resolveContainedCommand(command: ContainedCommand, capabilities: ContainedCapabilities): Promise<ResolvedContainedCommand> {
	if (command.kind === "runtime") return { kind: "runtime", argv: [await findCommand(command.argv[0]), ...command.argv.slice(1)] };
	const source = await validateMountedFile(command.source, true);
	const jailPath = "/run/pelaggio/bin/driver";
	if (command.kind === "mounted-driver") return { kind: command.kind, source, jailPath, args: command.args };
	const bridgeSource = await validateMountedFile(command.bridgeSource ?? CONTAINED_BRIDGE_PATH, false);
	const node = await findCommand(process.execPath);
	const nodeInRuntime = capabilities.runtimeRoots.some((root) => node === root || node.startsWith(`${root}/`));
	if (!nodeInRuntime) await validateMountedFile(node, true);
	return {
		kind: command.kind,
		source,
		jailPath,
		args: command.args,
		bridgeSource,
		bridgeJailPath: "/run/pelaggio/bin/contained-loopback-bridge.mjs",
		node: nodeInRuntime ? node : "/run/pelaggio/bin/node",
		...(nodeInRuntime ? {} : { nodeSource: node }),
	};
}

function allowedDependencyTarget(target: string, mainRepo: string): boolean {
	const relativeTarget = relative(mainRepo, target);
	if (!relativeTarget || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) return false;
	const parts = relativeTarget.split(sep);
	return parts[0] === "node_modules" || (parts[0] === "packages" && parts.length >= 3 && parts[2] === "node_modules");
}

/** Prefix of `path` up to and including its outermost `node_modules` segment — the store root
 *  that carries pnpm's `.pnpm` virtual store and the top-level dependency symlinks. */
function outermostNodeModulesRoot(path: string): string | undefined {
	const parts = path.split(sep);
	const index = parts.indexOf("node_modules");
	return index === -1 ? undefined : parts.slice(0, index + 1).join(sep);
}

/**
 * Resolve the read-only dependency mounts a worktree's node_modules layout needs inside the jail.
 *
 * Two layouts exist (worktree-deps.ts): a whole-dir symlink (`node_modules` → MAIN's — mount its
 * referent) and a materialized real dir whose entries are symlinks — workspace packages into the
 * worktree itself, everything else to the ORIGINAL MAIN path (e.g. `MAIN/node_modules/<pkg>`),
 * which is in turn usually a symlink into MAIN's `.pnpm` store. Mounting only `realpath()` leaves
 * (the pre-#279 behavior) flattened that chain: the worktree symlink's original MAIN path did not
 * exist inside the jail (dangling link) and `.pnpm`'s sibling links for transitive deps could not
 * resolve. So for each materialized entry we mount the OUTERMOST MAIN `node_modules` root of both
 * hops — the immediate readlink target (the original MAIN path exists, so the worktree symlink
 * resolves) and the fully-resolved path (the shared `.pnpm` store is present, so pnpm's sibling
 * links resolve) — read-only, reproducing exactly what module resolution needs.
 *
 * Conformance-test gap: no jail-side test exercises actual module resolution through these bind
 * mounts; coverage is the unit test over the resolved mount set plus the live conformance run.
 */
export async function resolveContainedDependencyTargets(worktree: string, mainRepo: string): Promise<readonly string[]> {
	const work = await realpath(worktree);
	const roots = [join(work, "node_modules")];
	for (const name of await readdir(join(work, "packages")).catch(() => [])) roots.push(join(work, "packages", name, "node_modules"));
	const targets = new Set<string>();
	const addEntryRoots = async (entry: string): Promise<void> => {
		const resolved = await realpath(entry);
		if (resolved === work || resolved.startsWith(`${work}${sep}`)) return; // workspace package — the worktree mount covers it
		const immediate = resolve(join(entry, ".."), await readlink(entry));
		for (const hop of [immediate, resolved]) {
			if (hop === work || hop.startsWith(`${work}${sep}`)) continue;
			targets.add(outermostNodeModulesRoot(hop) ?? hop);
		}
	};
	for (const root of roots) {
		let rootInfo: Awaited<ReturnType<typeof lstat>>;
		try {
			rootInfo = await lstat(root);
		} catch {
			continue;
		}
		if (rootInfo.isSymbolicLink()) targets.add(await realpath(root));
		else if (rootInfo.isDirectory()) {
			for (const name of await readdir(root)) {
				const entry = join(root, name);
				const info = await lstat(entry);
				if (info.isSymbolicLink()) await addEntryRoots(entry);
				else if (info.isDirectory() && name.startsWith("@")) {
					for (const scopedName of await readdir(entry)) {
						const scopedEntry = join(entry, scopedName);
						if ((await lstat(scopedEntry)).isSymbolicLink()) await addEntryRoots(scopedEntry);
					}
				}
			}
		}
	}
	const main = await realpath(mainRepo);
	return [...targets]
		.filter((target) => target !== work && !target.startsWith(`${work}${sep}`))
		.map((target) => {
			if (!allowedDependencyTarget(target, main)) throw new Error(`dependency target outside expected roots: ${target}`);
			return target;
		});
}

async function defaultCapabilities(): Promise<ContainedCapabilities> {
	if (process.platform !== "linux") throw new Error("contained execution requires Linux");
	return { platform: process.platform, bwrap: await findCommand("bwrap"), systemdRun: await findCommand("systemd-run"), systemctl: await findCommand("systemctl"), runtimeRoots: RUNTIME_ROOTS };
}

async function defaultPreflight(invocation: ContainedInvocation): Promise<void> {
	const result = await spawnProcess(
		invocation.executable,
		[
			"--user",
			"--scope",
			"--wait",
			"--collect",
			"--quiet",
			"--property",
			"TasksMax=1",
			"--property",
			"MemoryMax=64M",
			"--property",
			"CPUQuota=100%",
			"--property",
			"RuntimeMaxSec=10",
			"--property",
			"KillMode=control-group",
			"--",
			"/bin/true",
		],
		{ cwd: invocation.cwd, env: invocation.env, timeoutMs: 15_000 },
	);
	if (result.status !== 0 || result.signal) throw new Error(`systemd scope preflight failed: ${result.stderr.trim()}`);
}

export function renderInvocation(invocation: ContainedInvocation): string {
	return [invocation.executable, ...invocation.argv].map((value) => JSON.stringify(value)).join(" ");
}

async function killContainedScope(invocation: ContainedInvocation, deps: ContainedDependencies, settled: () => boolean): Promise<void> {
	const kill = deps.runKill ?? spawnProcess;
	for (let attempt = 0; attempt < 3 && !settled(); attempt += 1) {
		const result = await kill(invocation.kill.executable, invocation.kill.argv, { cwd: invocation.cwd, env: invocation.env, timeoutMs: 5_000 });
		if (result.status === 0 || !/not found|not loaded/i.test(result.stderr)) break;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	}
}

function containedFailure(error: Error): ContainedFailure {
	if (error instanceof ContainedFailure) return error;
	if (error instanceof EgressFatalError) {
		return new ContainedFailure(error.message, error.reason === "rate_limit" ? "rate_limit" : error.reason === "budget" ? "budget" : "confinement", { cause: error });
	}
	return new ContainedFailure(error.message, "confinement", { cause: error });
}

export async function withContainedInvocation<T>(
	options: ContainedLifecycleOptions,
	driver: (invocation: ContainedInvocation, terminateScope: () => Promise<void>) => Promise<ContainedDriverResult<T>>,
	deps: ContainedDependencies = {},
): Promise<ContainedLifecycleResult<T>> {
	const egressPolicy = options.egress ? resolveEgressPolicy(options.egress.provider, options.egress.model) : undefined;
	const egressKey = options.egress?.auth.kind === "key" ? process.env[options.egress.auth.env] : undefined;
	if (options.egress?.auth.kind === "key" && !egressKey) throw new Error(`missing key from ${options.egress.auth.env}`);
	const worktree = await realpath(options.worktree);
	const timeoutSeconds = Math.min(1800, Math.max(1, Math.floor(options.timeoutSeconds ?? 1800)));
	const privateDir = await mkdtemp(join(deps.privateRoot ?? tmpdir(), "pelaggio-contained-"));
	const gitMask = join(privateDir, "git-mask");
	let artifactDir: string | undefined;
	let broker: EgressBrokerHandle | undefined;
	try {
		await Promise.all(["home/.config", "home/.cache", "home/.local/share", "xdg", "tmp"].map((path) => mkdir(join(privateDir, path), { recursive: true })));
		await stagePrivateHome(privateDir, options.privateHome ?? []);
		const gitEntry = await lstat(join(worktree, ".git"));
		if (!gitEntry.isFile() && !gitEntry.isDirectory()) throw new Error("worktree .git entry is not regular metadata");
		if (gitEntry.isDirectory()) await mkdir(gitMask, { mode: 0o000 });
		else await (await open(gitMask, "w", 0o000)).close();
		await chmod(gitMask, 0o000);
		const capabilities = await (deps.discoverCapabilities ?? defaultCapabilities)();
		const command = await resolveContainedCommand(options.command, capabilities);
		let dependencyTargets: readonly string[] = [];
		if (options.mainRepo) {
			(deps.ensureDeps ?? ensureWorktreeDeps)(worktree, options.mainRepo);
			dependencyTargets = await (deps.resolveDependencyTargets ?? resolveContainedDependencyTargets)(worktree, options.mainRepo);
		}
		const egressSocket = egressPolicy ? join(privateDir, "egress.sock") : undefined;
		if (egressPolicy && options.egress) {
			broker = await (deps.startBroker ?? startEgressBroker)(
				{ socketPath: egressSocket as string, policy: egressPolicy, auth: options.egress.auth, ...(egressKey ? { key: egressKey } : {}) },
				{ ...(deps.brokerRequester ? { request: deps.brokerRequester } : {}) },
			);
			await broker.ready;
		}
		const invocation = buildContainedInvocation({ worktree, command, privateDir, gitMask, dependencyTargets, timeoutSeconds, ...(egressSocket ? { egressSocket } : {}) }, capabilities);
		await (deps.preflight ?? defaultPreflight)(invocation);
		const before = await captureWriteSnapshot(worktree, deps);
		let launchSettled = false;
		const launch = driver(invocation, async () => killContainedScope(invocation, deps, () => launchSettled)).finally(() => {
			launchSettled = true;
		});
		let timer: NodeJS.Timeout | undefined;
		let removeAbort = (): void => undefined;
		const timeout = new Promise<Error>((resolvePromise) => {
			timer = setTimeout(() => resolvePromise(new ContainedFailure("contained invocation timed out", "confinement")), timeoutSeconds * 1000);
			timer.unref();
		});
		const aborted = new Promise<Error>((resolvePromise) => {
			if (!options.signal) return;
			const onAbort = () => resolvePromise(new ContainedFailure("contained invocation aborted", "confinement"));
			removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		});
		let brokerFailure: Error | undefined;
		const fatal =
			broker?.fatal.then((error) => {
				brokerFailure = error;
				return error;
			}) ?? new Promise<Error>(() => undefined);
		const winner = await Promise.race([
			launch.then(
				(execution) => ({ kind: "execution" as const, execution }),
				(error: unknown) => ({ kind: "failure" as const, error: error instanceof Error ? error : new Error(String(error)) }),
			),
			Promise.race([fatal, timeout, aborted]).then((error) => ({ kind: "failure" as const, error })),
		]);
		if (timer) clearTimeout(timer);
		removeAbort();
		if (winner.kind === "failure") {
			await killContainedScope(invocation, deps, () => launchSettled);
			await launch.catch(() => undefined);
			throw containedFailure(winner.error);
		}
		await Promise.resolve();
		if (brokerFailure) {
			await killContainedScope(invocation, deps, () => launchSettled);
			throw containedFailure(brokerFailure);
		}
		const execution = winner.execution;
		if (execution.signal) throw new Error(`contained launcher terminated by ${execution.signal}`);
		const writeSet = await computeWriteSet(before, worktree, deps);
		if (options.debug) {
			artifactDir = join(worktree, ".dev", "contained-runs", basename(privateDir));
			await mkdir(artifactDir, { recursive: true });
			await chmod(gitMask, gitEntry.isDirectory() ? 0o700 : 0o600);
			await cp(gitMask, join(artifactDir, "git-mask"), { recursive: gitEntry.isDirectory() });
			const scrub = makeSecretScrubber();
			await writeFile(join(artifactDir, "invocation.txt"), scrub(`${renderInvocation(invocation)}\n${execution.stderr.slice(0, 65_536)}`));
		}
		return { value: execution.value, status: execution.status, signal: null, writeSet, ...(artifactDir ? { artifactDir } : {}) };
	} finally {
		await broker?.close().catch(() => undefined);
		await chmod(gitMask, 0o600).catch(() => undefined);
		await rm(privateDir, { recursive: true, force: true });
	}
}

export async function runContained(options: ContainedRunOptions, deps: ContainedDependencies = {}): Promise<ContainedRunResult> {
	if (options.mode.kind !== "command") throw new Error("runContained requires command mode");
	const runner = deps.spawn ?? spawnProcess;
	const result = await withContainedInvocation(
		{
			worktree: options.worktree,
			command: { kind: "runtime", argv: options.mode.argv },
			...(options.debug !== undefined ? { debug: options.debug } : {}),
			...(options.timeoutSeconds !== undefined ? { timeoutSeconds: options.timeoutSeconds } : {}),
			...(options.egress ? { egress: options.egress } : {}),
		},
		async (invocation) => {
			const execution = await runner(invocation.executable, invocation.argv, { cwd: invocation.cwd, env: invocation.env });
			return { value: undefined, status: execution.status, signal: execution.signal, stderr: execution.stderr };
		},
		deps,
	);
	return { status: result.status, signal: result.signal, writeSet: result.writeSet, ...(result.artifactDir ? { artifactDir: result.artifactDir } : {}) };
}

export async function runContainedSelfTest(options: Omit<ContainedRunOptions, "mode">, deps: ContainedDependencies = {}): Promise<ContainedSelfTestResult> {
	const probes: SelfTestProbe[] = [];
	const cases: Array<{ name: string; script: string; expect: number }> = [
		{
			name: "environment",
			script:
				"if(process.env.PELAGGIO_SECRET_CANARY)process.exit(2);if(!process.env.HOME?.startsWith('/run/pelaggio/'))process.exit(3);for(const key of ['HOME','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR'])require('fs').writeFileSync(process.env[key]+'/.pelaggio-probe','ok')",
			expect: 0,
		},
		{ name: "git-metadata", script: "require('fs').readFileSync('.git')", expect: 1 },
		// Isolation is asserted by netns membership, not a connect attempt: nothing listens on
		// 127.0.0.1:9 on any host, so a loopback connect errors (and "passes") whether or not the jail
		// is isolated. Under `--unshare-all` the process sees only loopback, so any externally-routable
		// interface means network isolation failed — a deterministic check that catches an accidental
		// `--share-net` regression with no timers.
		{ name: "network", script: "const ext=Object.values(require('os').networkInterfaces()).flat().filter((n)=>n&&!n.internal);process.exit(ext.length?2:0)", expect: 0 },
	];
	if (options.egress) {
		const policy = resolveEgressPolicy(options.egress.provider, options.egress.model);
		const route = policy.routes.find((candidate) => candidate.kind === "accounted");
		if (route?.kind !== "accounted") throw new Error("egress self-test requires an accounted route");
		const requestBody = JSON.stringify({ [route.modelField]: options.egress.model, [route.maxOutputTokensField]: 8, [route.streamField]: route.stream });
		cases.push({
			name: "egress-conformance",
			script: `const http=require("http");const body=${JSON.stringify(requestBody)};const r=http.request({socketPath:process.env.PELAGGIO_EGRESS_SOCKET,path:${JSON.stringify(`${route.path}?redacted=1`)},method:${JSON.stringify(route.method)},headers:{"content-type":"application/json","content-length":Buffer.byteLength(body)}},x=>{x.resume();x.on("end",()=>process.exit(x.statusCode===200?0:2))});r.on("error",()=>process.exit(3));r.end(body)`,
			expect: 0,
		});
		const responseBody =
			route.response.kind === "json"
				? Buffer.from(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }))
				: Buffer.from(`event: ${route.response.terminalEvent}\ndata: ${JSON.stringify({ type: route.response.terminalEvent, response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
		deps = {
			...deps,
			brokerRequester: deps.brokerRequester ?? (async () => ({ status: 200, headers: { "content-type": route.response.kind === "json" ? "application/json" : "text/event-stream" }, body: responseBody })),
		};
	}
	for (const probe of cases) {
		try {
			const result = await runContained({ ...options, mode: { kind: "command", argv: [process.execPath, "-e", probe.script] } }, deps);
			probes.push({ name: probe.name, passed: result.status === probe.expect, detail: `exit ${result.status}` });
		} catch (error) {
			probes.push({ name: probe.name, passed: false, detail: error instanceof Error ? error.message : String(error) });
		}
	}
	return { passed: probes.every((probe) => probe.passed), probes };
}
