import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildContainedInvocation, captureWriteSnapshot, computeWriteSet, renderInvocation, resolveContainedDependencyTargets, runContained, runContainedSelfTest, withContainedInvocation } from "../contained-execution.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "contained-test-"));
	roots.push(root);
	await writeFile(join(root, ".git"), "gitdir: elsewhere\n");
	return root;
}

describe("contained write snapshots", () => {
	it("reports sorted creates, modifications, and deletions", async () => {
		const root = await fixture();
		await writeFile(join(root, "old.txt"), "old");
		await writeFile(join(root, "gone.txt"), "gone");
		let files = ["old.txt", "gone.txt"];
		const deps = { listGitFiles: async () => files };
		const before = await captureWriteSnapshot(root, deps);
		await writeFile(join(root, "old.txt"), "new");
		await rm(join(root, "gone.txt"));
		await writeFile(join(root, "added.txt"), "added");
		files = ["old.txt", "added.txt"];
		const result = await computeWriteSet(before, root, deps);
		assert.deepEqual(
			result.map(({ kind, path }) => ({ kind, path })),
			[
				{ kind: "create", path: "added.txt" },
				{ kind: "delete", path: "gone.txt" },
				{ kind: "modify", path: "old.txt" },
			],
		);
	});

	it("tolerates an unchanged symlink but rejects a changed symlink", async () => {
		const root = await fixture();
		await writeFile(join(root, "target"), "one");
		await symlink("target", join(root, "link"));
		const deps = { listGitFiles: async () => ["link"] };
		const before = await captureWriteSnapshot(root, deps);
		assert.deepEqual(await computeWriteSet(before, root, deps), []);
		await rm(join(root, "link"));
		await symlink("missing", join(root, "link"));
		await assert.rejects(computeWriteSet(before, root, deps), /changed symlink/);
	});

	it("rejects traversal, hardlinks, and Git metadata changes", async () => {
		const root = await fixture();
		await assert.rejects(captureWriteSnapshot(root, { listGitFiles: async () => ["../escape"] }), /unsafe Git path/);
		await writeFile(join(root, "a"), "a");
		await import("node:fs/promises").then(({ link }) => link(join(root, "a"), join(root, "b")));
		await assert.rejects(captureWriteSnapshot(root, { listGitFiles: async () => ["a"] }), /hardlinked/);
		await rm(join(root, "b"));
		const before = await captureWriteSnapshot(root, { listGitFiles: async () => ["a"] });
		await writeFile(join(root, ".git"), "changed");
		await assert.rejects(computeWriteSet(before, root, { listGitFiles: async () => ["a"] }), /sentinel changed/);
	});

	it("fails final validation when a file changes after the post snapshot", async () => {
		const root = await fixture();
		await writeFile(join(root, "a"), "before");
		const deps = { listGitFiles: async () => ["a"] };
		const before = await captureWriteSnapshot(root, deps);
		await writeFile(join(root, "a"), "after");
		await assert.rejects(computeWriteSet(before, root, { ...deps, afterPostSnapshot: async () => writeFile(join(root, "a"), "raced") }), /changed during validation/);
	});
});

describe("contained invocation", () => {
	it("is argv-oriented, deny-by-default, and includes namespace/cgroup policy", async () => {
		const root = await fixture();
		const mask = join(root, "mask");
		await writeFile(mask, "");
		await chmod(mask, 0o000);
		process.env.PELAGGIO_SECRET_CANARY = "never-forward";
		const invocation = buildContainedInvocation(
			{ worktree: root, command: ["/usr/bin/node", "hello world"], privateDir: "/tmp/private", gitMask: mask },
			{ platform: "linux", bwrap: "/usr/bin/bwrap", systemdRun: "/usr/bin/systemd-run", systemctl: "/usr/bin/systemctl", runtimeRoots: ["/usr"] },
		);
		const rendered = renderInvocation(invocation);
		for (const expected of ["--unshare-all", "--clearenv", "KillMode=control-group", "--cap-drop", "--kill-whom=all"]) assert.match(`${rendered} ${invocation.kill.argv.join(" ")}`, new RegExp(expected));
		for (const expected of [
			["--bind", "/tmp/private/home", "/run/pelaggio/home"],
			["--bind", "/tmp/private/xdg", "/run/pelaggio/xdg"],
			["--bind", "/tmp/private/tmp", "/run/pelaggio/tmp"],
		]) {
			assert.notEqual(invocation.argv.join("\0").indexOf(expected.join("\0")), -1);
		}
		assert.equal(rendered.includes("never-forward"), false);
		assert.deepEqual(invocation.argv.slice(-3), ["--", "/usr/bin/node", "hello world"]);
		delete process.env.PELAGGIO_SECRET_CANARY;
		await chmod(mask, 0o600);
		assert.equal(await readFile(mask, "utf8"), "");
	});

	it("creates private mount sources and copies debug diagnostics after unmasking the sentinel", async () => {
		const root = await fixture();
		const privateRoot = await mkdtemp(join(tmpdir(), "contained-private-test-"));
		roots.push(privateRoot);
		let invocationArgv: readonly string[] = [];
		const result = await runContained(
			{ worktree: root, mode: { kind: "command", argv: [process.execPath] }, debug: true },
			{
				privateRoot,
				listGitFiles: async () => [],
				discoverCapabilities: async () => ({ platform: "linux", bwrap: "/usr/bin/bwrap", systemdRun: "/usr/bin/systemd-run", systemctl: "/usr/bin/systemctl", runtimeRoots: [dirname(process.execPath)] }),
				preflight: async () => undefined,
				spawn: async (_executable, argv) => {
					invocationArgv = argv;
					const homeSource = argv[argv.indexOf("/run/pelaggio/home") - 1];
					const xdgSource = argv[argv.indexOf("/run/pelaggio/xdg") - 1];
					const tmpSource = argv[argv.indexOf("/run/pelaggio/tmp") - 1];
					assert.ok(homeSource && xdgSource && tmpSource);
					for (const path of [homeSource, join(homeSource, ".config"), join(homeSource, ".cache"), join(homeSource, ".local/share"), xdgSource, tmpSource]) {
						assert.equal((await stat(path)).isDirectory(), true);
					}
					return { status: 0, signal: null, stdout: "", stderr: "diagnostic" };
				},
			},
		);
		assert.ok(invocationArgv.includes("/run/pelaggio/home"));
		assert.ok(result.artifactDir);
		assert.equal(await readFile(join(result.artifactDir, "git-mask"), "utf8"), "");
		assert.match(await readFile(join(result.artifactDir, "invocation.txt"), "utf8"), /diagnostic/);
	});

	it("mounts only the broker socket and exposes only its locator", async () => {
		const root = await fixture();
		const invocation = buildContainedInvocation(
			{ worktree: root, command: ["/usr/bin/node"], privateDir: "/tmp/private", gitMask: join(root, ".git"), egressSocket: "/tmp/private/egress.sock" },
			{ platform: "linux", bwrap: "/usr/bin/bwrap", systemdRun: "/usr/bin/systemd-run", systemctl: "/usr/bin/systemctl", runtimeRoots: ["/usr"] },
		);
		const rendered = renderInvocation(invocation);
		assert.match(rendered, /egress\.sock/);
		assert.match(rendered, /PELAGGIO_EGRESS_SOCKET/);
		assert.equal(rendered.includes("api.openai.com"), false);
	});

	it("stages private-home files and builds an interactive brokered-driver invocation", async () => {
		const root = await fixture();
		const privateRoot = await mkdtemp(join(tmpdir(), "contained-private-test-"));
		roots.push(privateRoot);
		const driver = join(root, "grok");
		const bridge = join(root, "bridge.mjs");
		const auth = join(root, "auth.json");
		await writeFile(driver, "driver", { mode: 0o700 });
		await writeFile(bridge, "bridge", { mode: 0o600 });
		await writeFile(auth, "secret", { mode: 0o600 });
		let sawStaged = false;
		const result = await withContainedInvocation(
			{
				worktree: root,
				command: { kind: "brokered-mounted-driver", source: driver, bridgeSource: bridge, args: ["agent", "stdio"] },
				privateHome: [
					{ kind: "copy", source: auth, destination: ".grok/auth.json", mode: 0o600 },
					{ kind: "literal", content: "profile", destination: ".grok/sandbox.toml", mode: 0o600 },
				],
			},
			async (invocation) => {
				const homeSource = invocation.argv[invocation.argv.indexOf("/run/pelaggio/home") - 1];
				assert.ok(homeSource);
				assert.equal(await readFile(join(homeSource, ".grok", "auth.json"), "utf8"), "secret");
				assert.equal(await readFile(join(homeSource, ".grok", "sandbox.toml"), "utf8"), "profile");
				assert.notEqual(invocation.argv.indexOf(driver), -1);
				assert.notEqual(invocation.argv.indexOf(bridge), -1);
				assert.notEqual(invocation.argv.join("\0").indexOf(["--setenv", "PELAGGIO_LOOPBACK_PORT", "43179"].join("\0")), -1);
				assert.equal(invocation.argv.includes("PELAGGIO_EGRESS_BASE_URL"), false);
				assert.deepEqual(invocation.argv.slice(-5), [process.execPath, "/run/pelaggio/bin/contained-loopback-bridge.mjs", "/run/pelaggio/bin/driver", "agent", "stdio"]);
				sawStaged = true;
				return { value: "ok", status: 0, signal: null, stderr: "" };
			},
			{
				privateRoot,
				listGitFiles: async () => [],
				discoverCapabilities: async () => ({ platform: "linux", bwrap: "/usr/bin/bwrap", systemdRun: "/usr/bin/systemd-run", systemctl: "/usr/bin/systemctl", runtimeRoots: [dirname(process.execPath)] }),
				preflight: async () => undefined,
			},
		);
		assert.equal(result.value, "ok");
		assert.equal(sawStaged, true);
	});

	it("uses a directory-form Git mask for a main checkout", async () => {
		const root = await mkdtemp(join(tmpdir(), "contained-main-checkout-test-"));
		const privateRoot = await mkdtemp(join(tmpdir(), "contained-private-test-"));
		roots.push(root, privateRoot);
		await mkdir(join(root, ".git"));
		let sawDirectoryMask = false;
		const result = await withContainedInvocation(
			{ worktree: root, command: { kind: "runtime", argv: [process.execPath] }, debug: true },
			async (invocation) => {
				const gitTarget = join(root, ".git");
				const mask = invocation.argv[invocation.argv.indexOf(gitTarget) - 1];
				assert.ok(mask);
				sawDirectoryMask = (await stat(mask)).isDirectory();
				return { value: undefined, status: 0, signal: null, stderr: "" };
			},
			{
				privateRoot,
				listGitFiles: async () => [],
				discoverCapabilities: async () => ({ platform: "linux", bwrap: "/usr/bin/bwrap", systemdRun: "/usr/bin/systemd-run", systemctl: "/usr/bin/systemctl", runtimeRoots: [dirname(process.execPath)] }),
				preflight: async () => undefined,
			},
		);
		assert.equal(sawDirectoryMask, true);
		assert.ok(result.artifactDir);
		assert.equal((await stat(join(result.artifactDir, "git-mask"))).isDirectory(), true);
	});

	it("rejects unsafe staged-home sources and destinations", async () => {
		const root = await fixture();
		const privateRoot = await mkdtemp(join(tmpdir(), "contained-private-test-"));
		roots.push(privateRoot);
		const target = join(root, "target");
		const link = join(root, "link");
		await writeFile(target, "secret");
		await symlink(target, link);
		for (const entry of [
			{ kind: "copy" as const, source: link, destination: ".grok/auth.json", mode: 0o600 },
			{ kind: "literal" as const, content: "x", destination: "../escape", mode: 0o600 },
			{ kind: "literal" as const, content: "x", destination: ".grok/public", mode: 0o644 },
		]) {
			await assert.rejects(
				withContainedInvocation({ worktree: root, command: { kind: "runtime", argv: [process.execPath] }, privateHome: [entry] }, async () => ({ value: undefined, status: 0, signal: null, stderr: "" }), { privateRoot }),
				/private-home/,
			);
		}
	});

	it("resolves only exact dependency targets beneath the main repository dependency roots", async () => {
		const root = await fixture();
		const main = await mkdtemp(join(tmpdir(), "contained-main-test-"));
		roots.push(main);
		await import("node:fs/promises").then(({ mkdir }) => mkdir(join(main, "node_modules", "tsx"), { recursive: true }));
		await symlink(join(main, "node_modules", "tsx"), join(root, "node_modules"));
		assert.deepEqual(await resolveContainedDependencyTargets(root, main), [join(main, "node_modules", "tsx")]);
	});

	it("mounts the outermost MAIN node_modules roots for the materialized per-package layout (#279)", async () => {
		const root = await fixture();
		const main = await mkdtemp(join(tmpdir(), "contained-main-test-"));
		roots.push(main);
		const { mkdir } = await import("node:fs/promises");
		// MAIN pnpm layout: top-level entries are symlinks into the shared .pnpm virtual store.
		await mkdir(join(main, "node_modules", ".pnpm", "tsx@4.0.0", "node_modules", "tsx"), { recursive: true });
		await mkdir(join(main, "node_modules", ".pnpm", "yaml@2.0.0", "node_modules", "yaml"), { recursive: true });
		await symlink(join(main, "node_modules", ".pnpm", "tsx@4.0.0", "node_modules", "tsx"), join(main, "node_modules", "tsx"));
		await mkdir(join(main, "packages", "pelaggio", "node_modules"), { recursive: true });
		await symlink(join(main, "node_modules", ".pnpm", "yaml@2.0.0", "node_modules", "yaml"), join(main, "packages", "pelaggio", "node_modules", "yaml"));
		// Worktree materialized layout (worktree-deps.ts): real dirs whose external entries are
		// absolute symlinks to the ORIGINAL MAIN paths — not the resolved .pnpm leaves — plus a
		// workspace self-link into the worktree.
		await mkdir(join(root, "node_modules"), { recursive: true });
		await mkdir(join(root, "packages", "pelaggio", "node_modules"), { recursive: true });
		await symlink(join(main, "node_modules", "tsx"), join(root, "node_modules", "tsx"));
		await symlink(join(main, "node_modules", ".pnpm"), join(root, "node_modules", ".pnpm"));
		await symlink(join(root, "packages", "pelaggio"), join(root, "node_modules", "pelaggio"));
		await symlink(join(main, "packages", "pelaggio", "node_modules", "yaml"), join(root, "packages", "pelaggio", "node_modules", "yaml"));
		const targets = await resolveContainedDependencyTargets(root, main);
		// Both hops of every symlink chain stay resolvable inside the jail: mounting the outermost
		// node_modules roots keeps the original MAIN paths present (no dangling worktree symlink)
		// and includes the .pnpm store (transitive sibling links resolve). Leaf-only mounts —
		// the pre-#279 behavior — must not come back.
		assert.deepEqual([...targets].sort(), [join(main, "node_modules"), join(main, "packages", "pelaggio", "node_modules")].sort());
	});

	it("kills the contained scope and fails closed when the broker seals", async () => {
		const root = await fixture();
		const privateRoot = await mkdtemp(join(tmpdir(), "contained-broker-test-"));
		roots.push(privateRoot);
		let fatalResolve!: (error: Error) => void;
		const fatal = new Promise<Error>((resolve) => {
			fatalResolve = resolve;
		});
		let releaseLaunch!: () => void;
		const launched = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		let killArgv: readonly string[] = [];
		let closed = false;
		const run = runContained(
			{ worktree: root, mode: { kind: "command", argv: [process.execPath] }, egress: { provider: "codex", model: "gpt-5.2-codex", auth: { kind: "transparent" } } },
			{
				privateRoot,
				listGitFiles: async () => [],
				discoverCapabilities: async () => ({ platform: "linux", bwrap: "/usr/bin/bwrap", systemdRun: "/usr/bin/systemd-run", systemctl: "/usr/bin/systemctl", runtimeRoots: [dirname(process.execPath)] }),
				preflight: async () => undefined,
				startBroker: async () => ({
					ready: Promise.resolve(),
					decisions: [],
					fatal,
					close: async () => {
						closed = true;
					},
				}),
				spawn: async () => {
					await launched;
					return { status: 0, signal: null, stdout: "", stderr: "" };
				},
				runKill: async (_executable, argv) => {
					killArgv = argv;
					releaseLaunch();
					return { status: 0, signal: null, stdout: "", stderr: "" };
				},
			},
		);
		fatalResolve(new Error("egress hard cap exceeded"));
		await assert.rejects(run, /egress hard cap exceeded/);
		assert.deepEqual(killArgv.slice(0, 3), ["--user", "kill", "--kill-whom=all"]);
		assert.equal(killArgv[3], "--signal=SIGKILL");
		assert.match(killArgv[4] ?? "", /^pelaggio-contained-.*\.scope$/);
		assert.ok(closed);
	});

	it("self-test fails closed when the jail cannot be established", async () => {
		const root = await fixture();
		const result = await runContainedSelfTest(
			{ worktree: root },
			{
				discoverCapabilities: async () => {
					throw new Error("no bwrap on this host");
				},
			},
		);
		assert.equal(result.passed, false);
		assert.equal(result.probes.length, 3);
		assert.ok(result.probes.every((probe) => !probe.passed));
		assert.match(result.probes[0]?.detail ?? "", /no bwrap/);
	});

	it("fails closed on unsupported platforms and commands outside runtime roots", async () => {
		const root = await fixture();
		const base = { worktree: root, command: ["/evil"] as [string], privateDir: "/tmp/p", gitMask: join(root, ".git") };
		assert.throws(() => buildContainedInvocation(base, { platform: "darwin", bwrap: "b", systemdRun: "s", systemctl: "c", runtimeRoots: ["/usr"] }), /Linux/);
		assert.throws(() => buildContainedInvocation(base, { platform: "linux", bwrap: "b", systemdRun: "s", systemctl: "c", runtimeRoots: ["/usr"] }), /runtime root/);
	});
});
