import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type EgressAuth, type EgressBrokerHandle, type EgressRequester, startEgressBroker } from "./egress-broker.js";
import { resolveEgressPolicy } from "./egress-policies.js";
import { registerPath } from "./registers.js";
import { buildAgentEnv, makeSecretScrubber } from "./secret-hygiene.js";

export type ContainedRunMode = { kind: "command"; argv: readonly [string, ...string[]] } | { kind: "self-test" };

export type WriteSetEntry = { kind: "create" | "modify"; path: string; digest: string } | { kind: "delete"; path: string };

export interface ContainedRunOptions {
	worktree: string;
	mode: ContainedRunMode;
	debug?: boolean;
	timeoutSeconds?: number;
	egress?: { provider: string; model: string; auth: EgressAuth };
}

export interface ContainedRunResult {
	status: number;
	signal: NodeJS.Signals | null;
	writeSet: readonly WriteSetEntry[];
	artifactDir?: string;
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
}

const RUNTIME_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64"] as const;
const CGROUP_PROPERTIES = ["TasksMax=512", "MemoryMax=4G", "CPUQuota=200%", "RuntimeMaxSec=1800", "KillMode=control-group"] as const;

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
	options: ContainedRunOptions & { command: readonly [string, ...string[]]; privateDir: string; gitMask: string; dependencyTargets?: readonly string[]; egressSocket?: string },
	capabilities: ContainedCapabilities,
): ContainedInvocation {
	if (capabilities.platform !== "linux") throw new Error("contained execution requires Linux");
	const command = options.command[0];
	if (!isAbsolute(command) || !capabilities.runtimeRoots.some((root) => command === root || command.startsWith(`${root}/`))) throw new Error("command must resolve beneath a read-only runtime root");
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
	for (const target of options.dependencyTargets ?? []) bwrap.push("--ro-bind", target, target);
	for (const [key, value] of Object.entries(env)) if (value !== undefined) bwrap.push("--setenv", key, value);
	bwrap.push("--chdir", options.worktree, "--", ...options.command);
	const argv = ["--user", "--scope", "--wait", "--collect", "--pipe", "--quiet", "--unit", unit, ...CGROUP_PROPERTIES.flatMap((value) => ["--property", value]), "--", capabilities.bwrap, ...bwrap];
	// `systemd-run --user` must reach the caller's user manager over D-Bus; forward only the session
	// locator vars (never secrets). The jail's own env is set separately via bwrap --clearenv/--setenv,
	// so this launcher env never reaches the contained process.
	const launcherEnv: NodeJS.ProcessEnv = Object.fromEntries(["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));
	return { executable: capabilities.systemdRun, argv, env: launcherEnv, cwd: options.worktree, unit, kill: { executable: capabilities.systemctl, argv: ["--user", "kill", "--kill-whom=all", unit] } };
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

export async function runContained(options: ContainedRunOptions, deps: ContainedDependencies = {}): Promise<ContainedRunResult> {
	if (options.mode.kind !== "command") throw new Error("runContained requires command mode");
	const egressPolicy = options.egress ? resolveEgressPolicy(options.egress.provider, options.egress.model) : undefined;
	const egressKey = options.egress?.auth.kind === "key" ? process.env[options.egress.auth.env] : undefined;
	if (options.egress?.auth.kind === "key" && !egressKey) throw new Error(`missing key from ${options.egress.auth.env}`);
	const worktree = await realpath(options.worktree);
	const privateDir = await mkdtemp(join(deps.privateRoot ?? tmpdir(), "pelaggio-contained-"));
	const gitMask = join(privateDir, "git-mask");
	await Promise.all(["home/.config", "home/.cache", "home/.local/share", "xdg", "tmp"].map((path) => mkdir(join(privateDir, path), { recursive: true })));
	const gitEntry = await lstat(join(worktree, ".git"));
	if (!gitEntry.isFile() && !gitEntry.isDirectory()) throw new Error("worktree .git entry is not regular metadata");
	await (await open(gitMask, "w", 0o000)).close();
	await chmod(gitMask, 0o000);
	let artifactDir: string | undefined;
	let broker: EgressBrokerHandle | undefined;
	try {
		const capabilities = await (deps.discoverCapabilities ?? defaultCapabilities)();
		const command = await findCommand(options.mode.argv[0], process.env.PATH);
		const egressSocket = egressPolicy ? join(privateDir, "egress.sock") : undefined;
		if (egressPolicy && options.egress) {
			broker = await (deps.startBroker ?? startEgressBroker)(
				{ socketPath: egressSocket as string, policy: egressPolicy, auth: options.egress.auth, ...(egressKey ? { key: egressKey } : {}) },
				{ ...(deps.brokerRequester ? { request: deps.brokerRequester } : {}) },
			);
			await broker.ready;
		}
		const invocation = buildContainedInvocation({ ...options, worktree, command: [command, ...options.mode.argv.slice(1)], privateDir, gitMask, ...(egressSocket ? { egressSocket } : {}) }, capabilities);
		await (deps.preflight ?? defaultPreflight)(invocation);
		const before = await captureWriteSnapshot(worktree, deps);
		const runner = deps.spawn ?? spawnProcess;
		let launchSettled = false;
		const launch = runner(invocation.executable, invocation.argv, { cwd: invocation.cwd, env: invocation.env, timeoutMs: (options.timeoutSeconds ?? 1800) * 1000 }).finally(() => {
			launchSettled = true;
		});
		let brokerFailure: Error | undefined;
		const watcher = broker
			? broker.fatal.then(async (error) => {
					brokerFailure = error;
					const kill = deps.runKill ?? spawnProcess;
					for (let attempt = 0; attempt < 3 && !launchSettled; attempt += 1) {
						const result = await kill(invocation.kill.executable, invocation.kill.argv, { cwd: invocation.cwd, env: invocation.env, timeoutMs: 5_000 });
						if (result.status === 0 || !/not found|not loaded/i.test(result.stderr)) break;
						await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
					}
				})
			: undefined;
		const execution = await launch;
		if (brokerFailure) throw brokerFailure;
		void watcher?.catch(() => undefined);
		if (execution.signal) throw new Error(`contained launcher terminated by ${execution.signal}`);
		const writeSet = await computeWriteSet(before, worktree, deps);
		if (options.debug) {
			artifactDir = registerPath(worktree, "contained-runs", basename(privateDir));
			await mkdir(artifactDir, { recursive: true });
			await chmod(gitMask, 0o600);
			await cp(gitMask, join(artifactDir, "git-mask"));
			const scrub = makeSecretScrubber();
			await writeFile(join(artifactDir, "invocation.txt"), scrub(`${renderInvocation(invocation)}\n${execution.stderr.slice(0, 65_536)}`));
		}
		return { status: execution.status, signal: null, writeSet, ...(artifactDir ? { artifactDir } : {}) };
	} finally {
		await broker?.close().catch(() => undefined);
		await chmod(gitMask, 0o600).catch(() => undefined);
		await rm(privateDir, { recursive: true, force: true });
	}
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
		cases.push({
			name: "egress-conformance",
			script: `const http=require("http");const body=JSON.stringify({model:${JSON.stringify(options.egress.model)},max_output_tokens:8,stream:false});const r=http.request({socketPath:process.env.PELAGGIO_EGRESS_SOCKET,path:"/v1/responses?redacted=1",method:"POST",headers:{"content-type":"application/json","content-length":Buffer.byteLength(body)}},x=>{x.resume();x.on("end",()=>process.exit(x.statusCode===200?0:2))});r.on("error",()=>process.exit(3));r.end(body)`,
			expect: 0,
		});
		deps = {
			...deps,
			brokerRequester: deps.brokerRequester ?? (async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"usage":{"input_tokens":1,"output_tokens":1}}') })),
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
