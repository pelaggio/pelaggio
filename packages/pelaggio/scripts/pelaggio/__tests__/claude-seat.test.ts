import assert from "node:assert/strict";
import { type ChildProcess, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import {
	buildClaudeSeatEnv,
	buildClaudeSeatInvocation,
	type ClaudeSeatBuildOptions,
	type ClaudeSeatSpawner,
	claudeSeatHoldsForgeAuthority,
	HARNESS_ONLY_SOCKET_ENVS,
	preflightClaudeSeat,
	resolveClaudeSeatBwrap,
	resolveHarnessSocketPaths,
	spawnClaudeSeat,
} from "../claude-seat.js";
import { STEPS } from "../config.js";
import type { Step } from "../types.js";

const temps: string[] = [];
const servers: Server[] = [];
const httpServers: Array<ReturnType<typeof createHttpServer>> = [];
const children: ChildProcess[] = [];
const ALL_STEPS: readonly Step[] = [...STEPS, "shipwreck", "pr-review", "pr-verify"];
const FORGE_CAPABLE_STEPS: readonly Step[] = ["pick", "ship", "shipwreck"];
const DENIED_STEPS: readonly Step[] = ALL_STEPS.filter((step) => !FORGE_CAPABLE_STEPS.includes(step));
const FORGE_REMOTE_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "LINEAR_API_KEY", "SSH_AUTH_SOCK", "GH_CONFIG_DIR", "GH_HOST", "GH_ENTERPRISE_HOST"] as const;
const CLAUDE_CLI_AUTH_VARS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"ANTHROPIC_FOUNDRY_AUTH_TOKEN",
	"ANTHROPIC_AWS_API_KEY",
	"ANTHROPIC_IDENTITY_TOKEN",
	"ANTHROPIC_IDENTITY_TOKEN_FILE",
	"ANTHROPIC_FEDERATION_RULE_ID",
	"ANTHROPIC_ORGANIZATION_ID",
	"ANTHROPIC_SERVICE_ACCOUNT_ID",
	"ANTHROPIC_WORKSPACE_ID",
	"ANTHROPIC_CONFIG_DIR",
	"ANTHROPIC_PROFILE",
	"ANTHROPIC_SCOPE",
] as const;
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
const GOOGLE_MODE_CREDENTIAL_VARS = ["GOOGLE_APPLICATION_CREDENTIALS"] as const;
const CLAUDE_CLI_PROVIDER_CONFIG_VARS = [
	"CLAUDE_CONFIG_DIR",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_MANTLE",
	"CLAUDE_CODE_USE_GATEWAY",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	"CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
	"CLAUDE_CODE_SKIP_BEDROCK_AUTH",
	"CLAUDE_CODE_SKIP_VERTEX_AUTH",
	"CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
	"CLAUDE_CODE_SKIP_MANTLE_AUTH",
	"CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
	"CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_BEDROCK_BASE_URL",
	"ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
	"ANTHROPIC_VERTEX_BASE_URL",
	"ANTHROPIC_FOUNDRY_BASE_URL",
	"ANTHROPIC_AWS_BASE_URL",
	"ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
	"ANTHROPIC_FOUNDRY_RESOURCE",
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
const CLAUDE_SDK_CONTROL_VARS = [
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_AGENT_SDK_VERSION",
	"CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
	"CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
	"CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
	"CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
] as const;
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
	await Promise.all([
		...servers.splice(0).map(
			(server) =>
				new Promise<void>((done) => {
					server.close(() => done());
				}),
		),
		...httpServers.splice(0).map(
			(server) =>
				new Promise<void>((done) => {
					server.close(() => done());
				}),
		),
	]);
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

function isolatedHarnessPaths(): { home: string; tmpdir: string; xdgRuntimeDir: string; xdgConfigHome: string; ghConfigDir: string; claudeConfigDir: string } {
	const root = tempDir("pelaggio-seat-iso-");
	return {
		home: join(root, "home"),
		tmpdir: join(root, "tmp"),
		xdgRuntimeDir: join(root, "run"),
		xdgConfigHome: join(root, "xdg"),
		ghConfigDir: join(root, "gh-config"),
		claudeConfigDir: join(root, "claude"),
	};
}

function deniedBuildOpts(overrides: Partial<ClaudeSeatBuildOptions> & Pick<ClaudeSeatBuildOptions, "cwd" | "bwrap">): ClaudeSeatBuildOptions {
	const isolated = isolatedHarnessPaths();
	return {
		step: "pr-review",
		home: isolated.home,
		tmpdir: isolated.tmpdir,
		xdgRuntimeDir: isolated.xdgRuntimeDir,
		xdgConfigHome: isolated.xdgConfigHome,
		ghConfigDir: isolated.ghConfigDir,
		claudeConfigDir: isolated.claudeConfigDir,
		...overrides,
	};
}

function sdkShapedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		PATH: "/usr/bin",
		HOME: "/home/agent",
		USER: "agent",
		LANG: "C",
		TMPDIR: "/tmp",
		XDG_CONFIG_HOME: "/home/agent/.config",
		GH_TOKEN: "ghp_forge_token_env_value",
		GITHUB_TOKEN: "ghs_forge_github_token",
		GH_ENTERPRISE_TOKEN: "ghe_enterprise_token_value",
		GITHUB_ENTERPRISE_TOKEN: "ghe_github_enterprise_token",
		LINEAR_API_KEY: "lin_api_key_value_xx",
		ANTHROPIC_API_KEY: "sk-ant-cli-auth-value",
		ANTHROPIC_AUTH_TOKEN: "anthropic-auth-token-value",
		CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-token-value",
		AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer-token-xx",
		ANTHROPIC_FOUNDRY_API_KEY: "foundry-api-key-value",
		ANTHROPIC_FOUNDRY_AUTH_TOKEN: "foundry-auth-token-value",
		ANTHROPIC_AWS_API_KEY: "anthropic-aws-key-value",
		ANTHROPIC_IDENTITY_TOKEN: "wif-identity-token-value",
		ANTHROPIC_IDENTITY_TOKEN_FILE: "/run/wif/identity-token",
		ANTHROPIC_FEDERATION_RULE_ID: "fedrule-01-value",
		ANTHROPIC_ORGANIZATION_ID: "org-01-value",
		ANTHROPIC_SERVICE_ACCOUNT_ID: "svcacct-01-value",
		ANTHROPIC_WORKSPACE_ID: "wrkspc-01-value",
		ANTHROPIC_CONFIG_DIR: "/home/agent/.config/anthropic",
		ANTHROPIC_PROFILE: "seat-profile",
		ANTHROPIC_SCOPE: "inference",
		// AWS credential chain: present in the bag but expected DROPPED unless an
		// AWS provider mode is selected (no CLAUDE_CODE_USE_BEDROCK/MANTLE/ANTHROPIC_AWS here).
		AWS_ACCESS_KEY_ID: "AKIAEXAMPLEKEYID0000",
		AWS_SECRET_ACCESS_KEY: "aws-secret-access-key-value",
		AWS_SESSION_TOKEN: "aws-session-token-value",
		GOOGLE_APPLICATION_CREDENTIALS: "/home/agent/gcp-adc.json",
		SSH_AUTH_SOCK: "/run/ssh-agent.sock",
		GH_CONFIG_DIR: "/home/agent/gh-config",
		GH_HOST: "github.com",
		GH_ENTERPRISE_HOST: "github.example",
		SENTINEL_SECRET: "do-not-leak-me-sentinel",
		CLAUDE_CODE_ENTRYPOINT: "sdk",
		CLAUDE_AGENT_SDK_VERSION: "0.3.220",
		CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "1",
		CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: "1",
		CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
		CLAUDE_CODE_QUESTION_PREVIEW_FORMAT: "markdown",
		CLAUDE_FAKE_SECRET: "unknown-sdk-looking-secret",
		TRACEPARENT: "00-trace-id-should-drop",
		NODE_OPTIONS: "--require /evil.js",
		MY_CUSTOM_VAR: "configured-addition",
		OPENAI_API_KEY: "sk-codex-should-not-reach-claude",
		...overrides,
	};
}

function plantGhConfig(directory: string, token: string): string {
	mkdirSync(directory, { recursive: true });
	const hosts = join(directory, "hosts.yml");
	writeFileSync(hosts, `github.com:\n    oauth_token: ${token}\n    user: planted\n`);
	return hosts;
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
			deniedBuildOpts({ cwd, bwrap, socketPaths: ["/run/pelaggio-signer/sock"], home: "/home/operator", tmpdir: "/tmp", xdgRuntimeDir: "/run/user/1000", claudeConfigDir: "/home/operator/.claude" }),
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
			deniedBuildOpts({
				cwd,
				bwrap,
				socketPaths: ["/run/pelaggio-signer/sock", "/run/pelaggio-signer/nested/other.sock", "/run/pelaggio-other/sock"],
				home: "/home/operator",
				tmpdir: "/tmp",
			}),
		);
		assert.deepEqual(tmpfsTargets(invocation.args), ["/run/pelaggio-other", "/run/pelaggio-signer"]);
	});

	it("still emits --tmpfs when the dedicated parent does not exist on the host", () => {
		const missingParent = join(tempDir("pelaggio-missing-parent-"), "dedicated");
		const locator = join(missingParent, "sock");
		const invocation = buildClaudeSeatInvocation({ command: "node", args: [], cwd }, deniedBuildOpts({ cwd, bwrap, socketPaths: [locator], home: "/home/operator", tmpdir: "/tmp" }));
		assert.deepEqual(tmpfsTargets(invocation.args), [missingParent]);
	});

	it("fails closed on relative, malformed, and wide protected paths", () => {
		const opts = deniedBuildOpts({ cwd, bwrap, home: "/home/operator", tmpdir: "/tmp", xdgRuntimeDir: "/run/user/1000", claudeConfigDir: "/home/operator/.claude" });
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
			() => buildClaudeSeatInvocation({ command: "node", args: [], cwd: "/work/item" }, deniedBuildOpts({ cwd: "/work/item", bwrap, socketPaths: [join(linkedParent, "sock")], home: "/home/operator", tmpdir: "/var/tmp" })),
			/parent directory is too wide to mask/,
		);
	});

	it("reads locators from the harness env bag when socketPaths is omitted", () => {
		const previous = process.env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET;
		process.env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET = "/run/pelaggio-signer/from-harness.sock";
		try {
			const invocation = buildClaudeSeatInvocation({ command: "node", args: [], cwd }, deniedBuildOpts({ cwd, bwrap, home: "/home/operator", tmpdir: "/tmp" }));
			assert.deepEqual(tmpfsTargets(invocation.args), ["/run/pelaggio-signer"]);
		} finally {
			if (previous === undefined) delete process.env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET;
			else process.env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET = previous;
		}
	});
});

describe("spawnClaudeSeat", () => {
	it("preserves cwd/env/stdio/signal, returns the same child, and reports only a positive wrapper PID", () => {
		const cwd = resolve(tempDir("pelaggio-seat-cwd-"));
		const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", CLAUDE_FROM_SDK: "1" };
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
			...deniedBuildOpts({ cwd, bwrap: "/usr/bin/bwrap", socketPaths: ["/run/pelaggio-signer/sock"], home: "/home/operator", tmpdir: "/tmp" }),
			spawn: spawnFake,
			stderr: stderrSink,
			onChildSpawn: (info) => reported.push(info),
		});
		assert.equal(child, fakeChild);
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.command, "/usr/bin/bwrap");
		assert.equal(seen[0]?.options.cwd, cwd);
		assert.notEqual(seen[0]?.options.env, env);
		assert.equal(seen[0]?.options.env?.PATH, "/usr/bin");
		assert.equal(seen[0]?.options.env?.CLAUDE_FROM_SDK, undefined);
		assert.deepEqual(seen[0]?.options.stdio, ["pipe", "pipe", "pipe"]);
		assert.equal(fakeStderr.readableFlowing, true, "the wrapper must drain custom-spawn stderr");
		assert.equal(seen[0]?.options.signal, signal);
		assert.deepEqual(afterSeparator(seen[0]?.args ?? []), ["node", "--eval", "ok"]);
		assert.deepEqual(reported, [{ pid: 4242, cwd }]);
		assert.equal(env.PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET, undefined);
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
		const forgeSecret = "planted-gh-token-only-in-sdk-bag";
		spawnClaudeSeat(spawnOpts({ cwd, env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: secret, GH_TOKEN: forgeSecret } }), {
			...deniedBuildOpts({ cwd, bwrap: "/usr/bin/bwrap", home: "/home/operator", tmpdir: "/tmp" }),
			spawn: (() => fakeChild) as ClaudeSeatSpawner,
			stderr: stderrSink,
		});

		fakeStderr.write("driver stderr: planted-anthropic-");
		fakeStderr.end("secret-value and planted-gh-token-only-in-sdk-bag\n");
		await new Promise<void>((done) => setImmediate(done));

		assert.equal(written.includes(secret), false);
		assert.equal(written.includes(forgeSecret), false);
		assert.equal(written, "driver stderr: [REDACTED] and [REDACTED]\n");
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
			spawnClaudeSeat(spawnOpts({ cwd, env }), { ...deniedBuildOpts({ cwd, bwrap: "/usr/bin/bwrap", home: "/home/operator", tmpdir: "/tmp" }), spawn: spawnFake });
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
			spawnClaudeSeat(spawnOpts({ cwd }), { ...deniedBuildOpts({ cwd, bwrap: "/usr/bin/bwrap", home: "/home/operator", tmpdir: "/tmp" }), spawn: spawnFake, onChildSpawn: (info) => reported.push(info) });
			assert.deepEqual(reported, []);
		}
	});
});

describe("preflightClaudeSeat", () => {
	it("returns a confinement diagnostic on non-Linux or missing Bubblewrap without using reserved error words", () => {
		const cwd = "/tmp/pelaggio-seat-work/item";
		const missing = preflightClaudeSeat({ cwd, step: "pr-review", platform: "linux", pathValue: tempDir("pelaggio-preflight-missing-") });
		assert.equal(missing.ok, false);
		if (!missing.ok) {
			assert.match(missing.message, /Bubblewrap in a trusted system directory on PATH/);
			assert.doesNotMatch(missing.message, /abort|budget|rate.?limit|usage.?limit|quota|max.*turns|turn.?limit/i);
		}
		const platform = preflightClaudeSeat({ cwd, step: "pr-review", platform: "darwin", pathValue: "/usr/bin" });
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
			step: "pr-review",
			platform: "linux",
			pathValue: dirname(bwrap),
			env: { PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET: "/tmp/sock" },
			...isolatedHarnessPaths(),
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
			step: "pr-review",
			platform: "linux",
			pathValue: dirname(bwrap),
			env: { PELAGGIO_REVIEW_EVIDENCE_SIGNER_SOCKET: join(missingParent, "sock") },
			...isolatedHarnessPaths(),
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
			step: "pr-review",
			platform: "linux",
			pathValue: dirname(bwrap),
			env: {},
			...isolatedHarnessPaths(),
			home: join(scratch, "home-missing"),
			tmpdir: scratch,
			xdgConfigHome: join(scratch, "xdg-missing"),
			ghConfigDir: join(scratch, "gh-missing"),
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
			step: "pr-review",
			platform: "linux",
			pathValue: dirname(bwrap),
			env: {},
			...isolatedHarnessPaths(),
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
			step: "pr-review",
			platform: "linux",
			pathValue: dirname(bwrap),
			env: {},
			...isolatedHarnessPaths(),
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
			step: "pr-review",
			platform: "linux",
			pathValue: dirname(bwrap),
			env: {},
			...isolatedHarnessPaths(),
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
			step: "pr-review",
			platform: "linux",
			pathValue: dirname(bwrap),
			env: {},
			...isolatedHarnessPaths(),
			home: "/home/operator",
			tmpdir: "/tmp",
			probe: () => ({ status: null, error: new Error("spawn denied") }),
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /could not run the Bubblewrap namespace probe: spawn denied/);
	});
});

describe("claude seat forge-authority policy", () => {
	it("classifies every current Step exhaustively: review/verify/author denied, pick/ship/shipwreck allowed", () => {
		assert.deepEqual(
			ALL_STEPS.map((step) => [step, claudeSeatHoldsForgeAuthority(step)]),
			[
				["pick", true],
				["plan", false],
				["shakedown-plan", false],
				["implement", false],
				["shakedown-code", false],
				["ship", true],
				["shipwreck", true],
				["pr-review", false],
				["pr-verify", false],
			],
		);
		for (const step of DENIED_STEPS) assert.equal(claudeSeatHoldsForgeAuthority(step), false, step);
		for (const step of FORGE_CAPABLE_STEPS) assert.equal(claudeSeatHoldsForgeAuthority(step), true, step);
	});
});

describe("buildClaudeSeatEnv", () => {
	const allow = ["MY_CUSTOM_VAR", "GH_TOKEN", "OPENAI_API_KEY"];
	const source = sdkShapedEnv();

	it("denied roles keep allowlisted/configured values, named SDK controls, and CLI auth, but drop forge/sentinel/unknown values", () => {
		for (const step of ["pr-review", "pr-verify", "plan", "implement"] as const) {
			const env = buildClaudeSeatEnv(source, step, allow);
			assert.equal(env.PATH, "/usr/bin");
			assert.equal(env.HOME, "/home/agent");
			assert.equal(env.MY_CUSTOM_VAR, "configured-addition");
			for (const name of CLAUDE_SDK_CONTROL_VARS) assert.equal(env[name], source[name], `${step} ${name}`);
			for (const name of CLAUDE_CLI_AUTH_VARS) assert.equal(env[name], source[name], `${step} ${name}`);
			for (const name of FORGE_REMOTE_VARS) assert.equal(name in env, false, `${step} must drop ${name}`);
			assert.equal("SENTINEL_SECRET" in env, false);
			assert.equal("CLAUDE_FAKE_SECRET" in env, false);
			assert.equal("TRACEPARENT" in env, false);
			assert.equal("NODE_OPTIONS" in env, false);
			assert.equal("OPENAI_API_KEY" in env, false);
		}
	});

	it("provider-mode selectors, provider configuration, and CLAUDE_CONFIG_DIR survive into every role's child env", () => {
		const providerSource = sdkShapedEnv(Object.fromEntries(CLAUDE_CLI_PROVIDER_CONFIG_VARS.map((name, index) => [name, `provider-config-value-${index}`])));
		for (const step of ALL_STEPS) {
			const env = buildClaudeSeatEnv(providerSource, step, allow);
			for (const name of CLAUDE_CLI_PROVIDER_CONFIG_VARS) assert.equal(env[name], providerSource[name], `${step} ${name}`);
			assert.equal("SENTINEL_SECRET" in env, false);
		}
	});

	it("harness pelaggio config (PELAGGIO_WORKTREE_PREFIX and friends) survives into every role's child env", () => {
		// Inner `npx pelaggio roadmap ...` invocations re-read these at config load; dropping the
		// prefix makes the inner claim and the outer pipeline resolve different worktree paths.
		const harnessConfig = {
			PELAGGIO_REPO: "/home/operator/repo",
			PELAGGIO_WORKTREE_PREFIX: "custom-prefix-",
			PELAGGIO_AUTHORING_ENABLED: "off",
			// The out-of-band taxonomy trust anchor (a PUBLIC key): config load rejects signed
			// taxonomy contractions without it, so seat-inner CLI commands need it too.
			PELAGGIO_TAXONOMY_PUBKEY: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----",
		} as const;
		const harnessSource = sdkShapedEnv({ ...harnessConfig });
		for (const step of ALL_STEPS) {
			const env = buildClaudeSeatEnv(harnessSource, step, allow);
			for (const [name, value] of Object.entries(harnessConfig)) assert.equal(env[name], value, `${step} ${name}`);
			assert.equal("SENTINEL_SECRET" in env, false);
		}
	});

	it("forwards proxy configuration to every role via the shared default allowlist", () => {
		const proxyConfig = {
			HTTP_PROXY: "http://proxy.corp:3128",
			HTTPS_PROXY: "http://proxy.corp:3128",
			NO_PROXY: "localhost,127.0.0.1",
			ALL_PROXY: "socks5://proxy.corp:1080",
			http_proxy: "http://proxy.corp:3128",
			https_proxy: "http://proxy.corp:3128",
			no_proxy: "localhost,127.0.0.1",
			all_proxy: "socks5://proxy.corp:1080",
		} as const;
		const proxySource = sdkShapedEnv({ ...proxyConfig });
		for (const step of ALL_STEPS) {
			const env = buildClaudeSeatEnv(proxySource, step, []);
			for (const [name, value] of Object.entries(proxyConfig)) assert.equal(env[name], value, `${step} ${name}`);
			assert.equal("SENTINEL_SECRET" in env, false);
		}
	});

	it("drops the AWS credential chain and Google ADC for every role when no matching provider mode is selected", () => {
		// sdkShapedEnv carries live-looking AWS/Google values but no truthy USE_* selector.
		for (const step of ALL_STEPS) {
			const env = buildClaudeSeatEnv(source, step, allow);
			for (const name of AWS_MODE_CREDENTIAL_VARS) assert.equal(name in env, false, `${step} must drop ${name} outside AWS provider mode`);
			for (const name of GOOGLE_MODE_CREDENTIAL_VARS) assert.equal(name in env, false, `${step} must drop ${name} outside Google provider mode`);
		}
		// A falsy or unrecognized selector value does not open the gate (mirrors the CLI's 1/true/yes/on).
		for (const value of ["0", "false", "", "off", "provider-config-value-1"]) {
			const env = buildClaudeSeatEnv(sdkShapedEnv({ CLAUDE_CODE_USE_BEDROCK: value }), "pr-review", allow);
			assert.equal("AWS_ACCESS_KEY_ID" in env, false, `selector value ${JSON.stringify(value)} must not pass AWS credentials`);
		}
	});

	it("passes the AWS credential chain (and Google ADC) to every role when the matching provider mode is selected", () => {
		const awsValues = Object.fromEntries(AWS_MODE_CREDENTIAL_VARS.map((name, index) => [name, `aws-cred-value-${index}`]));
		for (const selector of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS"]) {
			for (const truthy of ["1", "true", "YES", " on "]) {
				const bag = sdkShapedEnv({ ...awsValues, [selector]: truthy });
				for (const step of ALL_STEPS) {
					const env = buildClaudeSeatEnv(bag, step, allow);
					for (const name of AWS_MODE_CREDENTIAL_VARS) assert.equal(env[name], bag[name], `${step} ${selector}=${truthy} ${name}`);
					// Google ADC stays gated on ITS selectors, not the AWS ones.
					assert.equal("GOOGLE_APPLICATION_CREDENTIALS" in env, false, `${step} must still drop Google ADC`);
				}
			}
		}
		for (const selector of ["CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD"]) {
			const bag = sdkShapedEnv({ [selector]: "1" });
			for (const step of ALL_STEPS) {
				const env = buildClaudeSeatEnv(bag, step, allow);
				assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, bag.GOOGLE_APPLICATION_CREDENTIALS, `${step} ${selector}`);
				assert.equal("AWS_ACCESS_KEY_ID" in env, false, `${step} must still drop AWS credentials`);
			}
		}
	});

	it("forge-capable roles retain explicitly permitted forge inputs plus CLI auth names", () => {
		for (const step of FORGE_CAPABLE_STEPS) {
			const env = buildClaudeSeatEnv(source, step, allow);
			for (const name of CLAUDE_CLI_AUTH_VARS) assert.equal(env[name], source[name], `${step} ${name}`);
			assert.equal(env.GH_TOKEN, source.GH_TOKEN);
			assert.equal(env.GITHUB_TOKEN, source.GITHUB_TOKEN);
			assert.equal(env.GH_ENTERPRISE_TOKEN, source.GH_ENTERPRISE_TOKEN);
			assert.equal(env.GITHUB_ENTERPRISE_TOKEN, source.GITHUB_ENTERPRISE_TOKEN);
			assert.equal(env.LINEAR_API_KEY, source.LINEAR_API_KEY);
			assert.equal(env.SSH_AUTH_SOCK, source.SSH_AUTH_SOCK);
			assert.equal(env.GH_CONFIG_DIR, source.GH_CONFIG_DIR);
			assert.equal(env.GH_HOST, source.GH_HOST);
			assert.equal(env.GH_ENTERPRISE_HOST, source.GH_ENTERPRISE_HOST);
			assert.equal("SENTINEL_SECRET" in env, false);
			assert.equal("CLAUDE_FAKE_SECRET" in env, false);
			assert.equal("TRACEPARENT" in env, false);
			assert.equal("NODE_OPTIONS" in env, false);
		}
	});
});

describe("spawnClaudeSeat filtered environment", () => {
	it("passes a filtered copy to spawn() for denied roles and does not mutate the SDK bag", () => {
		const cwd = resolve(tempDir("pelaggio-seat-env-"));
		const env = sdkShapedEnv();
		const seen: Array<{ options: { env?: NodeJS.ProcessEnv } }> = [];
		const spawnFake = ((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
			seen.push({ options });
			return { pid: 7, stderr: new PassThrough() } as unknown as ChildProcess;
		}) as ClaudeSeatSpawner;
		spawnClaudeSeat(spawnOpts({ cwd, env }), {
			...deniedBuildOpts({ cwd, bwrap: "/usr/bin/bwrap", home: "/home/operator", tmpdir: "/tmp" }),
			step: "pr-verify",
			envAllowlist: ["MY_CUSTOM_VAR", "GH_TOKEN"],
			spawn: spawnFake,
			stderr: new PassThrough(),
		});
		assert.equal(seen.length, 1);
		const childEnv = seen[0]?.options.env ?? {};
		assert.notEqual(childEnv, env);
		assert.equal(childEnv.PATH, "/usr/bin");
		assert.equal(childEnv.MY_CUSTOM_VAR, "configured-addition");
		assert.equal(childEnv.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY);
		assert.equal(childEnv.CLAUDE_CODE_ENTRYPOINT, "sdk");
		assert.equal("GH_TOKEN" in childEnv, false);
		assert.equal("SENTINEL_SECRET" in childEnv, false);
		assert.equal("CLAUDE_FAKE_SECRET" in childEnv, false);
		assert.equal(env.GH_TOKEN, "ghp_forge_token_env_value");
	});

	it("preserves forge credentials for pick/ship/shipwreck spawn bags", () => {
		const cwd = resolve(tempDir("pelaggio-seat-forge-env-"));
		for (const step of FORGE_CAPABLE_STEPS) {
			const env = sdkShapedEnv();
			const seen: Array<{ options: { env?: NodeJS.ProcessEnv } }> = [];
			const spawnFake = ((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
				seen.push({ options });
				return { pid: 8, stderr: new PassThrough() } as unknown as ChildProcess;
			}) as ClaudeSeatSpawner;
			spawnClaudeSeat(spawnOpts({ cwd, env }), {
				...deniedBuildOpts({ cwd, bwrap: "/usr/bin/bwrap", home: "/home/operator", tmpdir: "/tmp" }),
				step,
				spawn: spawnFake,
				stderr: new PassThrough(),
			});
			assert.equal(seen[0]?.options.env?.GH_TOKEN, env.GH_TOKEN, step);
			assert.equal(seen[0]?.options.env?.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY, step);
		}
	});
});

describe("preflightClaudeSeat filtered probe env", () => {
	it("filters the probe environment the same way as production spawn", { skip: trustedSystemBwrap === undefined }, () => {
		assert.ok(trustedSystemBwrap);
		const bwrap = trustedSystemBwrap;
		const isolated = isolatedHarnessPaths();
		let probeEnv: NodeJS.ProcessEnv | undefined;
		const result = preflightClaudeSeat({
			cwd: tempDir("pelaggio-preflight-env-cwd-"),
			step: "pr-review",
			platform: "linux",
			pathValue: dirname(bwrap),
			env: sdkShapedEnv(),
			...isolated,
			tmpdir: tempDir("pelaggio-preflight-env-tmp-"),
			envAllowlist: ["MY_CUSTOM_VAR", "GH_TOKEN"],
			probe: (_command, _args, options) => {
				probeEnv = options.env;
				return { status: 0 };
			},
		});
		assert.deepEqual(result, { ok: true, bwrap });
		assert.ok(probeEnv);
		assert.equal(probeEnv.MY_CUSTOM_VAR, "configured-addition");
		assert.equal(probeEnv.ANTHROPIC_API_KEY, "sk-ant-cli-auth-value");
		assert.equal("GH_TOKEN" in probeEnv, false);
		assert.equal("SENTINEL_SECRET" in probeEnv, false);
	});
});

describe("GitHub credential-directory masks", () => {
	const bwrap = "/usr/bin/bwrap";
	const cwd = "/tmp/pelaggio-seat-work/item";

	it("denied invocations mask every existing canonical GitHub config directory once", () => {
		const homeRoot = tempDir("pelaggio-gh-home-");
		const xdgRoot = tempDir("pelaggio-gh-xdg-");
		const ghRoot = tempDir("pelaggio-gh-config-");
		const homeGh = join(homeRoot, ".config", "gh");
		const xdgGh = join(xdgRoot, "gh");
		plantGhConfig(homeGh, "planted-home-config-token");
		plantGhConfig(xdgGh, "planted-xdg-config-token");
		plantGhConfig(ghRoot, "planted-gh-config-dir-token");
		const invocation = buildClaudeSeatInvocation(
			{ command: "node", args: [], cwd },
			deniedBuildOpts({
				cwd,
				bwrap,
				step: "pr-verify",
				socketPaths: [],
				home: homeRoot,
				xdgConfigHome: xdgRoot,
				ghConfigDir: ghRoot,
				tmpdir: "/tmp",
			}),
		);
		assert.deepEqual(
			tmpfsTargets(invocation.args),
			[resolve(ghRoot), resolve(homeGh), resolve(xdgGh)].sort((a, b) => a.localeCompare(b)),
		);
		assert.deepEqual(invocation.maskedDirectories, tmpfsTargets(invocation.args));
	});

	it("forge-capable invocations do not mask GitHub credential directories", () => {
		const homeRoot = tempDir("pelaggio-gh-pick-home-");
		const ghRoot = tempDir("pelaggio-gh-pick-config-");
		plantGhConfig(join(homeRoot, ".config", "gh"), "planted-home-config-token");
		plantGhConfig(ghRoot, "planted-gh-config-dir-token");
		for (const step of FORGE_CAPABLE_STEPS) {
			const invocation = buildClaudeSeatInvocation(
				{ command: "node", args: [], cwd },
				deniedBuildOpts({
					cwd,
					bwrap,
					step,
					socketPaths: ["/run/pelaggio-signer/sock"],
					home: homeRoot,
					xdgConfigHome: join(homeRoot, "xdg-missing"),
					ghConfigDir: ghRoot,
					tmpdir: "/tmp",
				}),
			);
			assert.deepEqual(tmpfsTargets(invocation.args), ["/run/pelaggio-signer"], step);
		}
	});

	it("missing GitHub config directories are skipped rather than failing closed", () => {
		const isolated = isolatedHarnessPaths();
		const invocation = buildClaudeSeatInvocation({ command: "node", args: [], cwd }, deniedBuildOpts({ cwd, bwrap, socketPaths: ["/run/pelaggio-signer/sock"], ...isolated, home: "/home/operator", tmpdir: "/tmp" }));
		assert.deepEqual(tmpfsTargets(invocation.args), ["/run/pelaggio-signer"]);
	});

	it("ignores relative XDG/GH_CONFIG_DIR candidates instead of failing closed, keeping absolute masks (#554)", () => {
		// XDG basedir rule: a relative value is invalid-and-ignored; only that candidate is
		// skipped — the home-derived absolute candidate must still be masked.
		const homeRoot = tempDir("pelaggio-gh-relative-home-");
		const homeGh = join(homeRoot, ".config", "gh");
		plantGhConfig(homeGh, "planted-home-config-token");
		const invocation = buildClaudeSeatInvocation(
			{ command: "node", args: [], cwd },
			deniedBuildOpts({
				cwd,
				bwrap,
				socketPaths: [],
				home: homeRoot,
				xdgConfigHome: "relative/xdg-config",
				ghConfigDir: "relative/gh",
				tmpdir: "/tmp",
			}),
		);
		assert.deepEqual(invocation.maskedDirectories, [realpathSync(homeGh)]);
	});

	it("fails closed on malformed and wide GitHub credential targets", () => {
		assert.throws(() => buildClaudeSeatInvocation({ command: "node", args: [], cwd }, deniedBuildOpts({ cwd, bwrap, home: "/home/operator", tmpdir: "/tmp", ghConfigDir: "/tmp/gh\0hidden" })), /forbidden characters/);
		assert.throws(() => buildClaudeSeatInvocation({ command: "node", args: [], cwd }, deniedBuildOpts({ cwd, bwrap, home: "/home/operator", tmpdir: "/tmp", ghConfigDir: "/tmp/../etc/gh" })), /reserved segments/);
		assert.throws(() => buildClaudeSeatInvocation({ command: "node", args: [], cwd }, deniedBuildOpts({ cwd, bwrap, home: "/home/operator", tmpdir: "/tmp", ghConfigDir: "/tmp" })), /too wide to mask/);
	});

	it("skips non-directory GitHub credential candidates (misconfiguration) instead of failing every denied step (#554)", () => {
		const homeRoot = tempDir("pelaggio-gh-notdir-home-");
		const homeGh = join(homeRoot, ".config", "gh");
		plantGhConfig(homeGh, "planted-home-config-token");
		// GH_CONFIG_DIR names a FILE (not maskable, not a usable gh config dir) and
		// XDG_CONFIG_HOME names a file (candidate `<file>/gh` resolves ENOTDIR): both skip
		// with a diagnostic while the home-derived candidate still masks.
		const fileTarget = join(tempDir("pelaggio-gh-file-"), "hosts.yml");
		writeFileSync(fileTarget, "not-a-directory\n");
		const xdgFile = join(tempDir("pelaggio-gh-xdgfile-"), "xdg-as-file");
		writeFileSync(xdgFile, "file, not a directory\n");
		const invocation = buildClaudeSeatInvocation({ command: "node", args: [], cwd }, deniedBuildOpts({ cwd, bwrap, socketPaths: [], home: homeRoot, xdgConfigHome: xdgFile, ghConfigDir: fileTarget, tmpdir: "/tmp" }));
		assert.deepEqual(invocation.maskedDirectories, [realpathSync(homeGh)]);
	});

	it("fails closed when a GitHub credential directory symlink resolves to a wide root", () => {
		const root = tempDir("pelaggio-gh-link-");
		const linked = join(root, "gh");
		symlinkSync("/", linked);
		assert.throws(() => buildClaudeSeatInvocation({ command: "node", args: [], cwd }, deniedBuildOpts({ cwd, bwrap, home: "/home/operator", tmpdir: "/var/tmp", ghConfigDir: linked })), /too wide to mask/);
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
				...deniedBuildOpts({ cwd: worktree, bwrap, socketPaths: [socketPath], home: "/home/operator", tmpdir: "/tmp" }),
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

	it("denies a production-shaped status-post from pr-review and pr-verify seats", { timeout: 15_000 }, async () => {
		for (const step of ["pr-review", "pr-verify"] as const) {
			const result = await runStatusForgeryProbe(step);
			assert.deepEqual(result.hits, [], `${step} must not post a status`);
			assert.equal(result.observed.env.GH_TOKEN, null, step);
			assert.equal(result.observed.env.GITHUB_TOKEN, null, step);
			assert.equal(result.observed.env.GH_ENTERPRISE_TOKEN, null, step);
			assert.equal(result.observed.env.GITHUB_ENTERPRISE_TOKEN, null, step);
			assert.equal(result.observed.env.ANTHROPIC_API_KEY, result.anthropicKey, `${step} still receives CLI auth`);
			assert.equal(result.observed.hosts.home, "ENOENT");
			assert.equal(result.observed.hosts.xdg, "ENOENT");
			assert.equal(result.observed.hosts.ghConfig, "ENOENT");
			for (const token of result.plantedTokens) {
				assert.equal(JSON.stringify(result.observed).includes(token), false, `${step} leaked ${token}`);
			}
		}
	});

	it("preserves planted GitHub credentials for pick, ship, and shipwreck", { timeout: 15_000 }, async () => {
		for (const step of FORGE_CAPABLE_STEPS) {
			const result = await runStatusForgeryProbe(step);
			assert.equal(result.hits.length, 1, `${step} must be able to post with a planted token`);
			assert.match(result.hits[0] ?? "", /Authorization: token planted-env-gh-token-value-xx/);
			assert.equal(result.observed.env.GH_TOKEN, "planted-env-gh-token-value-xx", step);
			assert.equal(result.observed.env.ANTHROPIC_API_KEY, result.anthropicKey, step);
			assert.match(result.observed.hosts.home, /planted-home-config-token-xx/);
			assert.match(result.observed.hosts.xdg, /planted-xdg-config-token-xx/);
			assert.match(result.observed.hosts.ghConfig, /planted-gh-config-dir-token-xx/);
		}
	});
});

async function runStatusForgeryProbe(step: Step): Promise<{
	hits: string[];
	anthropicKey: string;
	plantedTokens: string[];
	observed: {
		env: { GH_TOKEN: string | null; GITHUB_TOKEN: string | null; GH_ENTERPRISE_TOKEN: string | null; GITHUB_ENTERPRISE_TOKEN: string | null; ANTHROPIC_API_KEY: string | null };
		hosts: { home: string; xdg: string; ghConfig: string };
		ghStatus: number | null;
	};
}> {
	const bwrap = resolveClaudeSeatBwrap();
	const worktree = tempDir(`pelaggio-seat-forge-${step}-`);
	const homeRoot = tempDir(`pelaggio-seat-forge-home-${step}-`);
	const xdgRoot = tempDir(`pelaggio-seat-forge-xdg-${step}-`);
	const ghRoot = tempDir(`pelaggio-seat-forge-gh-${step}-`);
	const homeHosts = plantGhConfig(join(homeRoot, ".config", "gh"), "planted-home-config-token-xx");
	const xdgHosts = plantGhConfig(join(xdgRoot, "gh"), "planted-xdg-config-token-xx");
	const ghHosts = plantGhConfig(ghRoot, "planted-gh-config-dir-token-xx");
	const anthropicKey = "sk-ant-review-seat-auth-xx";
	const plantedTokens = [
		"planted-env-gh-token-value-xx",
		"planted-env-github-token-xx",
		"planted-env-ghe-token-xx",
		"planted-env-ghe-github-token-xx",
		"planted-home-config-token-xx",
		"planted-xdg-config-token-xx",
		"planted-gh-config-dir-token-xx",
	];

	const hits: string[] = [];
	const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			hits.push(`${req.method} ${req.url} Authorization: ${req.headers.authorization ?? ""} ${Buffer.concat(chunks).toString("utf8")}`);
			res.writeHead(201);
			res.end("created");
		});
	});
	httpServers.push(httpServer);
	const mockPort = await new Promise<number>((done, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(0, "127.0.0.1", () => {
			const address = httpServer.address();
			if (address && typeof address === "object") done(address.port);
			else reject(new Error("status mock did not bind a port"));
		});
	});

	const binDir = join(worktree, "bin");
	mkdirSync(binDir, { recursive: true });
	const ghJs = join(worktree, "gh-double.cjs");
	writeFileSync(
		ghJs,
		`
const { readFileSync } = require("node:fs");
const { request } = require("node:http");
const { join } = require("node:path");
function tokenFromEnv() {
	return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN || "";
}
function tokenFromConfig() {
	const candidates = [];
	if (process.env.GH_CONFIG_DIR) candidates.push(join(process.env.GH_CONFIG_DIR, "hosts.yml"));
	if (process.env.XDG_CONFIG_HOME) candidates.push(join(process.env.XDG_CONFIG_HOME, "gh", "hosts.yml"));
	if (process.env.HOME) candidates.push(join(process.env.HOME, ".config", "gh", "hosts.yml"));
	for (const file of candidates) {
		try {
			const match = readFileSync(file, "utf8").match(/oauth_token:\\s*(\\S+)/);
			if (match) return match[1];
		} catch {}
	}
	return "";
}
const args = process.argv.slice(2);
const isStatusPost = args[0] === "api" && args.some((arg) => arg.includes("/statuses/")) && args.includes("-X") && args.includes("POST");
const token = tokenFromEnv() || tokenFromConfig();
if (!isStatusPost || !token) {
	process.stderr.write("gh: no usable GitHub credential\\n");
	process.exit(1);
}
request({ host: "127.0.0.1", port: ${mockPort}, path: "/status-forge", method: "POST", headers: { Authorization: "token " + token } }, (res) => {
	res.resume();
	res.on("end", () => process.exit(res.statusCode === 201 ? 0 : 2));
}).end("state=success&context=review");
`,
	);
	writeFileSync(join(binDir, "gh"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(ghJs)} "$@"\n`);
	chmodSync(join(binDir, "gh"), 0o755);

	const probe = join(worktree, "status-forge-probe.cjs");
	writeFileSync(
		probe,
		`
const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
function tryRead(path) {
	try { return readFileSync(path, "utf8"); }
	catch (error) { return error && error.code ? error.code : String(error); }
}
const [homeHosts, xdgHosts, ghHosts] = process.argv.slice(2);
const gh = spawnSync("gh", ["api", "repos/owner/repo/statuses/deadbeef0123456789", "-X", "POST", "-f", "state=success", "-f", "context=review"], { encoding: "utf8" });
process.stdout.write(JSON.stringify({
	env: {
		GH_TOKEN: process.env.GH_TOKEN || null,
		GITHUB_TOKEN: process.env.GITHUB_TOKEN || null,
		GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN || null,
		GITHUB_ENTERPRISE_TOKEN: process.env.GITHUB_ENTERPRISE_TOKEN || null,
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || null,
	},
	hosts: { home: tryRead(homeHosts), xdg: tryRead(xdgHosts), ghConfig: tryRead(ghHosts) },
	ghStatus: gh.status,
}) + "\\n");
`,
	);

	const child = spawnClaudeSeat(
		{
			command: process.execPath,
			args: [probe, homeHosts, xdgHosts, ghHosts],
			cwd: worktree,
			env: {
				PATH: `${binDir}:/usr/bin`,
				HOME: homeRoot,
				XDG_CONFIG_HOME: xdgRoot,
				GH_CONFIG_DIR: ghRoot,
				GH_TOKEN: "planted-env-gh-token-value-xx",
				GITHUB_TOKEN: "planted-env-github-token-xx",
				GH_ENTERPRISE_TOKEN: "planted-env-ghe-token-xx",
				GITHUB_ENTERPRISE_TOKEN: "planted-env-ghe-github-token-xx",
				ANTHROPIC_API_KEY: anthropicKey,
			},
			signal: new AbortController().signal,
		},
		deniedBuildOpts({
			cwd: worktree,
			bwrap,
			step,
			socketPaths: [],
			home: homeRoot,
			xdgConfigHome: xdgRoot,
			ghConfigDir: ghRoot,
			tmpdir: "/tmp",
		}),
	) as unknown as ChildProcess;
	children.push(child);

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
	assert.equal(code, 0, `${step} probe failed (${code}): ${stderr}\n${stdout}`);
	return {
		hits,
		anthropicKey,
		plantedTokens,
		observed: JSON.parse(stdout.trim()) as {
			env: { GH_TOKEN: string | null; GITHUB_TOKEN: string | null; GH_ENTERPRISE_TOKEN: string | null; GITHUB_ENTERPRISE_TOKEN: string | null; ANTHROPIC_API_KEY: string | null };
			hosts: { home: string; xdg: string; ghConfig: string };
			ghStatus: number | null;
		},
	};
}
