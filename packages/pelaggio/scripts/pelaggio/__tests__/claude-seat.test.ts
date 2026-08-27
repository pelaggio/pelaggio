import assert from "node:assert/strict";
import { type ChildProcess, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeSeatInvocation, type ClaudeSeatSpawner, HARNESS_ONLY_SOCKET_ENVS, preflightClaudeSeat, resolveClaudeSeatBwrap, resolveHarnessSocketPaths, spawnClaudeSeat } from "../claude-seat.js";

const temps: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];
const trustedSystemBwrap = (() => {
	if (process.platform !== "linux") return undefined;
	try {
		return resolveClaudeSeatBwrap();
	} catch {
		return undefined;
	}
})();

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
	}
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((done) => {
					server.close(() => done());
				}),
		),
	);
	for (const root of temps.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function tempDir(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	temps.push(root);
	return root;
}

function fakeBwrapPath(): string {
	const dir = tempDir("pelaggio-bwrap-");
	const bin = join(dir, "bwrap");
	writeFileSync(bin, "#!/bin/sh\n");
	chmodSync(bin, 0o755);
	return bin;
}

function spawnOpts(overrides: Partial<SpawnOptions> & { command?: string; args?: string[] } = {}): SpawnOptions {
	return {
		command: overrides.command ?? "/usr/bin/node",
		args: overrides.args ?? ["-e", "process.exit(0)"],
		cwd: overrides.cwd,
		env: overrides.env ?? { PATH: "/usr/bin" },
		signal: overrides.signal ?? new AbortController().signal,
	};
}

function tmpfsTargets(args: readonly string[]): string[] {
	const targets: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--tmpfs" && args[i + 1] !== undefined) targets.push(args[i + 1] as string);
	}
	return targets;
}

function afterSeparator(args: readonly string[]): string[] {
	const idx = args.indexOf("--");
	assert.notEqual(idx, -1, "invocation must separate the SDK command with --");
	return args.slice(idx + 1);
}

describe("HARNESS_ONLY_SOCKET_ENVS", () => {
	it("exports the #511 signer locator as the first supported name", () => {
		assert.deepEqual(HARNESS_ONLY_SOCKET_ENVS, ["PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET"]);
	});
});

describe("resolveClaudeSeatBwrap", () => {
	it("fails closed on a non-Linux host", () => {
		assert.throws(() => resolveClaudeSeatBwrap("/usr/bin", "darwin"), /requires Linux with Bubblewrap; switch provider or run on Linux/);
	});

	it("fails closed when no trusted system bwrap is on the harness PATH", () => {
		const empty = tempDir("pelaggio-nobwrap-");
		assert.throws(() => resolveClaudeSeatBwrap(empty, "linux"), /requires Bubblewrap in a trusted system directory on PATH/);
	});

	it("ignores a plantable PATH entry and resolves the later trusted system bwrap", { skip: trustedSystemBwrap === undefined }, () => {
		assert.ok(trustedSystemBwrap);
		const trusted = trustedSystemBwrap;
		const planted = fakeBwrapPath();
		assert.equal(resolveClaudeSeatBwrap(`${dirname(planted)}:${dirname(trusted)}`, "linux"), trusted);
	});

	it("skips a non-executable namesake", () => {
		const dir = tempDir("pelaggio-nobin-");
		writeFileSync(join(dir, "bwrap"), "not executable");
		chmodSync(join(dir, "bwrap"), 0o644);
		assert.throws(() => resolveClaudeSeatBwrap(dir, "linux"), /requires Bubblewrap in a trusted system directory on PATH/);
	});

	it("rejects Bubblewrap when the harness uid owns the filesystem root", { skip: trustedSystemBwrap === undefined }, () => {
		assert.ok(trustedSystemBwrap);
		const trusted = trustedSystemBwrap;
		const originalGeteuid = process.geteuid;
		process.geteuid = () => statSync("/").uid;
		try {
			assert.throws(() => resolveClaudeSeatBwrap(dirname(trusted), "linux"), /requires Bubblewrap in a trusted system directory on PATH/);
		} finally {
			process.geteuid = originalGeteuid;
		}
	});
});

describe("resolveHarnessSocketPaths", () => {
	it("collects nonblank harness locators and ignores spawn-env invention", () => {
		assert.deepEqual(resolveHarnessSocketPaths({}), []);
		assert.deepEqual(resolveHarnessSocketPaths({ PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET: "   " }), []);
		assert.deepEqual(resolveHarnessSocketPaths({ PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET: "/run/pelaggio-signer/sock" }), ["/run/pelaggio-signer/sock"]);
		assert.deepEqual(resolveHarnessSocketPaths({ UNRELATED: "/run/other/sock" }), []);
	});
});

describe("buildClaudeSeatInvocation", () => {
	const bwrap = "/usr/bin/bwrap";
	const cwd = "/tmp/pelaggio-seat-work/item";

	it("emits the documented argv order, detached session, device-capable root bind, fresh proc, and -- separated command/args with spaces", () => {
		const invocation = buildClaudeSeatInvocation(
			{ command: "/opt/claude code/cli", args: ["--flag", "bar baz", "a;b"], cwd },
			{ cwd, bwrap, socketPaths: ["/run/pelaggio-signer/sock"], home: "/home/operator", tmpdir: "/tmp", xdgRuntimeDir: "/run/user/1000", claudeConfigDir: "/home/operator/.claude" },
		);
		assert.equal(invocation.command, bwrap);
		assert.deepEqual(invocation.args.slice(0, 9), ["--unshare-pid", "--new-session", "--die-with-parent", "--dev-bind", "/", "/", "--proc", "/proc", "--tmpfs"]);
		assert.equal(invocation.args[9], "/run/pelaggio-signer");
		assert.deepEqual(invocation.args.slice(10), ["--chdir", resolve(cwd), "--", "/opt/claude code/cli", "--flag", "bar baz", "a;b"]);
		assert.deepEqual(afterSeparator(invocation.args), ["/opt/claude code/cli", "--flag", "bar baz", "a;b"]);
		assert.equal(invocation.cwd, resolve(cwd));
		const joined = invocation.args.join("\0");
		for (const forbidden of ["--unshare-net", "--unshare-all", "--unshare-mount", "--clearenv", "landlock", "Landlock"]) {
			assert.equal(joined.includes(forbidden), false, `must not emit ${forbidden}`);
		}
	});

	it("emits one tmpfs per unique allowed parent and keeps the outer parent when one prefixes another", () => {
		const invocation = buildClaudeSeatInvocation(
			{ command: "node", args: [], cwd },
			{
				cwd,
				bwrap,
				socketPaths: ["/run/pelaggio-signer/sock", "/run/pelaggio-signer/nested/other.sock", "/run/pelaggio-other/sock"],
				home: "/home/operator",
				tmpdir: "/tmp",
			},
		);
		assert.deepEqual(tmpfsTargets(invocation.args), ["/run/pelaggio-other", "/run/pelaggio-signer"]);
	});

	it("still emits --tmpfs when the dedicated parent does not exist on the host", () => {
		const missingParent = join(tempDir("pelaggio-missing-parent-"), "dedicated");
		const locator = join(missingParent, "sock");
		const invocation = buildClaudeSeatInvocation({ command: "node", args: [], cwd }, { cwd, bwrap, socketPaths: [locator], home: "/home/operator", tmpdir: "/tmp" });
		assert.deepEqual(tmpfsTargets(invocation.args), [missingParent]);
	});

	it("fails closed on relative, malformed, and wide protected paths", () => {
		const opts = { cwd, bwrap, home: "/home/operator", tmpdir: "/tmp", xdgRuntimeDir: "/run/user/1000", claudeConfigDir: "/home/operator/.claude" };
		assert.throws(() => buildClaudeSeatInvocation({ command: "node", args: [], cwd }, { ...opts, socketPaths: ["run/pelaggio-signer/sock"] }), /path is not absolute/);
		assert.throws(() => buildClaudeSeatInvocation({ command: "node", args: [], cwd }, { ...opts, socketPaths: ["/run/pelaggio-signer/sock\0hidden"] }), /forbidden characters/);
		assert.throws(() => buildClaudeSeatInvocation({ command: "node", args: [], cwd }, { ...opts, socketPaths: ["/run/pelaggio-signer\\sock"] }), /forbidden characters/);
		assert.throws(() => buildClaudeSeatInvocation({ command: "node", args: [], cwd }, { ...opts, socketPaths: ["/run/pelaggio-link/../pelaggio-signer/sock"] }), /reserved segments/);
		assert.throws(() => buildClaudeSeatInvocation({ command: "node", args: [], cwd }, { ...opts, socketPaths: ["/run/pelaggio-signer/./sock"] }), /reserved segments/);
		assert.throws(() => buildClaudeSeatInvocation({ command: "node", args: [], cwd }, { ...opts, socketPaths: ["/tmp/sock"] }), /too wide to mask/);
		assert.throws(() => buildClaudeSeatInvocation({ command: "node", args: [], cwd }, { ...opts, socketPaths: ["/run/sock"] }), /too wide to mask/);
		assert.throws(() => buildClaudeSeatInvocation({ command: "node", args: [], cwd }, { ...opts, socketPaths: ["/sock"] }), /too wide to mask/);
		assert.throws(() => buildClaudeSeatInvocation({ command: "node", args: [], cwd }, { ...opts, socketPaths: [join(cwd, "sock")] }), /too wide to mask/);
		assert.throws(() => buildClaudeSeatInvocation({ command: "node", args: [], cwd }, { ...opts, socketPaths: ["/home/operator/sock"] }), /too wide to mask/);
	});

	it("resolves an existing locator parent before applying the wide-parent policy", () => {
		const root = tempDir("pelaggio-seat-parent-link-");
		const linkedParent = join(root, "signer");
		symlinkSync("/", linkedParent);
		assert.throws(
			() => buildClaudeSeatInvocation({ command: "node", args: [], cwd: "/work/item" }, { cwd: "/work/item", bwrap, socketPaths: [join(linkedParent, "sock")], home: "/home/operator", tmpdir: "/var/tmp" }),
			/parent directory is too wide to mask/,
		);
	});

	it("reads locators from the harness env bag when socketPaths is omitted", () => {
		const previous = process.env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET;
		process.env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET = "/run/pelaggio-signer/from-harness.sock";
		try {
			const invocation = buildClaudeSeatInvocation({ command: "node", args: [], cwd }, { cwd, bwrap, home: "/home/operator", tmpdir: "/tmp" });
			assert.deepEqual(tmpfsTargets(invocation.args), ["/run/pelaggio-signer"]);
		} finally {
			if (previous === undefined) delete process.env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET;
			else process.env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET = previous;
		}
	});
});

describe("spawnClaudeSeat", () => {
	it("preserves ordinary SDK env while denying harness Git config, and reports only a positive wrapper PID", () => {
		const cwd = resolve(tempDir("pelaggio-seat-cwd-"));
		const env: NodeJS.ProcessEnv = {
			PATH: "/usr/bin",
			CLAUDE_FROM_SDK: "1",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
			GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic credential",
			GIT_CONFIG_PARAMETERS: "'credential.helper'='helper'",
			GIT_CONFIG: "/tmp/attacker-controlled-config",
		};
		const signal = new AbortController().signal;
		const seen: Array<{ command: string; args: readonly string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; signal?: AbortSignal } }> = [];
		const fakeStderr = new PassThrough();
		const stderrSink = new PassThrough();
		const fakeChild = { pid: 4242, stderr: fakeStderr } as unknown as ChildProcess;
		const spawnFake = ((command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; signal?: AbortSignal }) => {
			seen.push({ command, args, options });
			return fakeChild;
		}) as ClaudeSeatSpawner;
		const reported: Array<{ pid: number; cwd: string }> = [];
		const child = spawnClaudeSeat(spawnOpts({ cwd, env, signal, command: "node", args: ["--eval", "ok"] }), {
			cwd,
			bwrap: "/usr/bin/bwrap",
			socketPaths: ["/run/pelaggio-signer/sock"],
			home: "/home/operator",
			tmpdir: "/tmp",
			spawn: spawnFake,
			stderr: stderrSink,
			onChildSpawn: (info) => reported.push(info),
		});
		assert.equal(child, fakeChild);
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.command, "/usr/bin/bwrap");
		assert.equal(seen[0]?.options.cwd, cwd);
		assert.deepEqual(seen[0]?.options.env, { PATH: "/usr/bin", CLAUDE_FROM_SDK: "1" });
		assert.equal(seen[0]?.options.env === env, false, "seat filtering must not mutate the SDK env bag");
		assert.deepEqual(seen[0]?.options.stdio, ["pipe", "pipe", "pipe"]);
		assert.equal(fakeStderr.readableFlowing, true, "the wrapper must drain custom-spawn stderr");
		assert.equal(seen[0]?.options.signal, signal);
		assert.deepEqual(afterSeparator(seen[0]?.args ?? []), ["node", "--eval", "ok"]);
		assert.deepEqual(reported, [{ pid: 4242, cwd }]);
		assert.equal(env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET, undefined);
		assert.equal(env.GIT_CONFIG_VALUE_0, "AUTHORIZATION: basic credential", "the harness must retain its Git credential");
	});

	it("scrubs SDK-environment credentials from stderr even when split across chunks", async () => {
		const cwd = resolve(tempDir("pelaggio-seat-stderr-"));
		const secret = "planted-anthropic-secret-value";
		const fakeStderr = new PassThrough();
		const fakeChild = { pid: 4242, stderr: fakeStderr } as unknown as ChildProcess;
		const stderrSink = new PassThrough();
		let written = "";
		stderrSink.on("data", (chunk: Buffer) => {
			written += chunk.toString();
		});
		spawnClaudeSeat(spawnOpts({ cwd, env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: secret } }), {
			cwd,
			bwrap: "/usr/bin/bwrap",
			home: "/home/operator",
			tmpdir: "/tmp",
			spawn: (() => fakeChild) as ClaudeSeatSpawner,
			stderr: stderrSink,
		});

		fakeStderr.write("driver stderr: planted-anthropic-");
		fakeStderr.end("secret-value\n");
		await new Promise<void>((done) => setImmediate(done));

		assert.equal(written.includes(secret), false);
		assert.equal(written, "driver stderr: [REDACTED]\n");
	});

	it("does not invent harness locators onto spawnOpts.env and still wraps without onChildSpawn", () => {
		const cwd = resolve(tempDir("pelaggio-seat-no-cb-"));
		const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
		const seen: Array<{ command: string; args: readonly string[] }> = [];
		const spawnFake = ((command: string, args: readonly string[]) => {
			seen.push({ command, args });
			return { pid: undefined } as ChildProcess;
		}) as ClaudeSeatSpawner;
		const previous = process.env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET;
		process.env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET = "/run/pelaggio-signer/harness.sock";
		try {
			spawnClaudeSeat(spawnOpts({ cwd, env }), { cwd, bwrap: "/usr/bin/bwrap", home: "/home/operator", tmpdir: "/tmp", spawn: spawnFake });
		} finally {
			if (previous === undefined) delete process.env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET;
			else process.env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET = previous;
		}
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.command, "/usr/bin/bwrap");
		assert.deepEqual(tmpfsTargets(seen[0]?.args ?? []), ["/run/pelaggio-signer"]);
		assert.equal(env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET, undefined);
	});

	it("invokes onChildSpawn only for a valid positive wrapper PID", () => {
		const cwd = resolve(tempDir("pelaggio-seat-pid-"));
		for (const pid of [undefined, 0, -1]) {
			const reported: Array<{ pid: number; cwd: string }> = [];
			const spawnFake = (() => ({ pid }) as ChildProcess) as ClaudeSeatSpawner;
			spawnClaudeSeat(spawnOpts({ cwd }), { cwd, bwrap: "/usr/bin/bwrap", home: "/home/operator", tmpdir: "/tmp", spawn: spawnFake, onChildSpawn: (info) => reported.push(info) });
			assert.deepEqual(reported, []);
		}
	});
});

describe("preflightClaudeSeat", () => {
	it("returns a confinement diagnostic on non-Linux or missing Bubblewrap without using reserved error words", () => {
		const cwd = "/tmp/pelaggio-seat-work/item";
		const missing = preflightClaudeSeat({ cwd, platform: "linux", pathValue: tempDir("pelaggio-preflight-missing-") });
		assert.equal(missing.ok, false);
		if (!missing.ok) {
			assert.match(missing.message, /Bubblewrap in a trusted system directory on PATH/);
			assert.doesNotMatch(missing.message, /abort|budget|rate.?limit|usage.?limit|quota|max.*turns|turn.?limit/i);
		}
		const platform = preflightClaudeSeat({ cwd, platform: "darwin", pathValue: "/usr/bin" });
		assert.equal(platform.ok, false);
		if (!platform.ok) {
			assert.match(platform.message, /Linux with Bubblewrap/);
			assert.doesNotMatch(platform.message, /abort|budget|rate.?limit|usage.?limit|quota|max.*turns|turn.?limit/i);
		}
	});

	it("fails closed on an invalid configured locator before any spawn", { skip: trustedSystemBwrap === undefined }, () => {
		const cwd = "/tmp/pelaggio-seat-work/item";
		assert.ok(trustedSystemBwrap);
		const bwrap = trustedSystemBwrap;
		const result = preflightClaudeSeat({
			cwd,
			platform: "linux",
			pathValue: dirname(bwrap),
			env: { PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET: "/tmp/sock" },
			home: "/home/operator",
			tmpdir: "/tmp",
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /too wide to mask/);
	});

	it("reports a missing configured socket parent before the namespace probe", { skip: trustedSystemBwrap === undefined }, () => {
		assert.ok(trustedSystemBwrap);
		const bwrap = trustedSystemBwrap;
		const missingParent = join(tempDir("pelaggio-preflight-parent-"), "missing");
		let probed = false;
		const result = preflightClaudeSeat({
			cwd: tempDir("pelaggio-preflight-cwd-"),
			platform: "linux",
			pathValue: dirname(bwrap),
			env: { PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET: join(missingParent, "sock") },
			home: "/home/operator",
			tmpdir: "/tmp",
			probe: () => {
				probed = true;
				return { status: 0 };
			},
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /socket parent because it does not exist/);
		assert.equal(probed, false);
	});

	it("always mounts a private canary parent and asks the probe to reject a visible canary", { skip: trustedSystemBwrap === undefined }, () => {
		assert.ok(trustedSystemBwrap);
		const bwrap = trustedSystemBwrap;
		const cwd = tempDir("pelaggio-preflight-canary-cwd-");
		const scratch = tempDir("pelaggio-preflight-canary-tmp-");
		let canaryPath: string | undefined;
		const result = preflightClaudeSeat({
			cwd,
			platform: "linux",
			pathValue: dirname(bwrap),
			env: {},
			home: "/home/operator",
			tmpdir: scratch,
			probe: (_command, args) => {
				const commandArgs = afterSeparator(args);
				assert.equal(commandArgs[0], process.execPath);
				assert.match(commandArgs[2] ?? "", /existsSync/);
				canaryPath = commandArgs[3];
				assert.ok(canaryPath);
				assert.equal(existsSync(canaryPath), true, "the host-side canary must exist while the probe runs");
				assert.deepEqual(tmpfsTargets(args), [dirname(canaryPath)]);
				return { status: 0 };
			},
		});
		assert.deepEqual(result, { ok: true, bwrap });
		assert.ok(canaryPath);
		assert.equal(existsSync(dirname(canaryPath)), false, "the private canary directory must be removed after preflight");
	});

	it("fails closed when the mask probe can still see its host-side canary", { skip: trustedSystemBwrap === undefined }, () => {
		assert.ok(trustedSystemBwrap);
		const bwrap = trustedSystemBwrap;
		let canaryPath: string | undefined;
		const result = preflightClaudeSeat({
			cwd: tempDir("pelaggio-preflight-visible-cwd-"),
			platform: "linux",
			pathValue: dirname(bwrap),
			env: {},
			home: "/home/operator",
			tmpdir: tempDir("pelaggio-preflight-visible-tmp-"),
			probe: (_command, args, options) => {
				const commandArgs = afterSeparator(args);
				canaryPath = commandArgs[3];
				return spawnSync(commandArgs[0] as string, commandArgs.slice(1), { ...options, stdio: ["ignore", "ignore", "pipe"] });
			},
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /socket-mask probe left its host canary visible/);
		assert.ok(canaryPath);
		assert.equal(existsSync(dirname(canaryPath)), false, "a failed probe must still remove the canary directory");
	});

	it("returns the resolved absolute bwrap path when the host is ready", { skip: trustedSystemBwrap === undefined }, () => {
		assert.ok(trustedSystemBwrap);
		const bwrap = trustedSystemBwrap;
		const cwd = tempDir("pelaggio-preflight-ready-");
		const result = preflightClaudeSeat({
			cwd,
			platform: "linux",
			pathValue: dirname(bwrap),
			env: {},
			home: "/home/operator",
			tmpdir: "/tmp",
		});
		assert.deepEqual(result, { ok: true, bwrap });
	});

	it("fails closed when Bubblewrap cannot create the requested namespaces", { skip: trustedSystemBwrap === undefined }, () => {
		assert.ok(trustedSystemBwrap);
		const bwrap = trustedSystemBwrap;
		const cwd = tempDir("pelaggio-preflight-namespace-");
		const result = preflightClaudeSeat({
			cwd,
			platform: "linux",
			pathValue: dirname(bwrap),
			env: {},
			home: "/home/operator",
			tmpdir: "/tmp",
			probe: () => ({ status: 1, stderr: "Creating new namespace failed: Operation not permitted" }),
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /Bubblewrap namespace probe returned exit 1: Creating new namespace failed/);
	});

	it("fails closed when the Bubblewrap namespace probe cannot spawn", { skip: trustedSystemBwrap === undefined }, () => {
		assert.ok(trustedSystemBwrap);
		const bwrap = trustedSystemBwrap;
		const cwd = tempDir("pelaggio-preflight-spawn-");
		const result = preflightClaudeSeat({
			cwd,
			platform: "linux",
			pathValue: dirname(bwrap),
			env: {},
			home: "/home/operator",
			tmpdir: "/tmp",
			probe: () => ({ status: null, error: new Error("spawn denied") }),
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /could not run the Bubblewrap namespace probe: spawn denied/);
	});
});

describe("linux conformance", { skip: process.platform !== "linux" }, () => {
	it("proves host-proc hide, socket mask, terminal detachment, device access, worktree write, shared net, and outer PID binding", { timeout: 15_000 }, async () => {
		const bwrap = resolveClaudeSeatBwrap();
		const worktree = tempDir("pelaggio-seat-wt-");
		const socketRoot = tempDir("pelaggio-seat-sock-");
		const socketParent = join(socketRoot, "signer");
		const socketPath = join(socketParent, "sock");
		mkdirSync(socketParent, { recursive: true });

		const unixServer = createServer();
		servers.push(unixServer);
		await new Promise<void>((done, reject) => {
			unixServer.once("error", reject);
			unixServer.listen({ path: socketPath }, () => done());
		});
		unixServer.on("connection", (socket) => socket.end());

		const tcpServer = createServer();
		servers.push(tcpServer);
		const tcpPort = await new Promise<number>((done, reject) => {
			tcpServer.once("error", reject);
			tcpServer.listen(0, "127.0.0.1", () => {
				const address = tcpServer.address();
				if (address && typeof address === "object") done(address.port);
				else reject(new Error("tcp listener did not bind a port"));
			});
		});
		tcpServer.on("connection", (socket) => socket.end());

		const probe = join(worktree, "seat-probe.cjs");
		writeFileSync(
			probe,
			`
const { closeSync, openSync, readFileSync, readSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { createConnection } = require("node:net");
const { resolve } = require("node:path");
const [harnessPid, socketPath, worktree, tcpPort] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tryRead(path) {
	try { readFileSync(path); return "readable"; }
	catch (error) { return error && error.code ? error.code : String(error); }
}
function tryDevice(path) {
	let fd;
	try {
		fd = openSync(path, "r");
		readSync(fd, Buffer.alloc(1), 0, 1, null);
		return "ok";
	} catch (error) {
		return error && error.code ? error.code : String(error);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
function connect(options) {
	return new Promise((resolveP) => {
		const c = createConnection(options);
		c.once("connect", () => { c.end(); resolveP("connected"); });
		c.once("error", (error) => resolveP(error && error.code ? error.code : String(error)));
	});
}
(async () => {
	await sleep(200);
	let write = "ok";
	try { writeFileSync(resolve(worktree, "seat-probe-write.txt"), "ok"); }
	catch (error) { write = error && error.code ? error.code : String(error); }
	const result = {
		environ: tryRead("/proc/" + harnessPid + "/environ"),
		socket: await connect({ path: socketPath }),
		write,
		tcp: await connect({ host: "127.0.0.1", port: Number(tcpPort) }),
		devNull: tryDevice("/dev/null"),
		devUrandom: tryDevice("/dev/urandom"),
		devTty: tryDevice("/dev/tty"),
		ignoredStdio: spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).status === 0 ? "ok" : "failed",
	};
	process.stdout.write(JSON.stringify(result) + "\\n");
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`,
		);

		const reported: Array<{ pid: number; cwd: string }> = [];
		const child = spawnClaudeSeat(
			{
				command: process.execPath,
				args: [probe, String(process.pid), socketPath, worktree, String(tcpPort)],
				cwd: worktree,
				env: { ...process.env },
				signal: new AbortController().signal,
			},
			{
				cwd: worktree,
				bwrap,
				socketPaths: [socketPath],
				home: "/home/operator",
				tmpdir: "/tmp",
				onChildSpawn: (info) => reported.push(info),
			},
		) as unknown as ChildProcess;
		children.push(child);

		assert.equal(reported.length, 1);
		const pid = reported[0]?.pid;
		assert.ok(typeof pid === "number" && pid > 0);
		assert.equal(resolve(readlinkSync(`/proc/${pid}/cwd`)), resolve(worktree));
		assert.match(readFileSync(`/proc/${pid}/comm`, "utf8"), /bwrap/);

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const code = await new Promise<number | null>((done, reject) => {
			child.once("error", reject);
			child.once("exit", (exitCode) => done(exitCode));
		});
		assert.equal(code, 0, `probe failed (${code}): ${stderr}`);
		const result = JSON.parse(stdout.trim()) as { environ: string; socket: string; write: string; tcp: string; devNull: string; devUrandom: string; devTty: string; ignoredStdio: string };
		assert.equal(result.environ, "ENOENT", `harness environ should be hidden, got ${result.environ}`);
		assert.equal(result.socket, "ENOENT", `unix socket should be hidden, got ${result.socket}`);
		assert.equal(result.write, "ok");
		assert.equal(result.tcp, "connected");
		assert.equal(result.devNull, "ok");
		assert.equal(result.devUrandom, "ok");
		assert.equal(result.devTty, "ENXIO", `seat must not inherit a controlling terminal, got ${result.devTty}`);
		assert.equal(result.ignoredStdio, "ok");
		assert.equal(readFileSync(join(worktree, "seat-probe-write.txt"), "utf8"), "ok");
	});
});
