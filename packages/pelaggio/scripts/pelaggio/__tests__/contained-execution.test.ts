import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildContainedInvocation, captureWriteSnapshot, computeWriteSet, renderInvocation, runContained, runContainedSelfTest } from "../contained-execution.js";

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
			{ worktree: root, mode: { kind: "command", argv: ["/usr/bin/node"] }, command: ["/usr/bin/node", "hello world"], privateDir: "/tmp/private", gitMask: mask },
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
		const base = { worktree: root, mode: { kind: "command" as const, argv: ["/evil"] as [string] }, command: ["/evil"] as [string], privateDir: "/tmp/p", gitMask: join(root, ".git") };
		assert.throws(() => buildContainedInvocation(base, { platform: "darwin", bwrap: "b", systemdRun: "s", systemctl: "c", runtimeRoots: ["/usr"] }), /Linux/);
		assert.throws(() => buildContainedInvocation(base, { platform: "linux", bwrap: "b", systemdRun: "s", systemctl: "c", runtimeRoots: ["/usr"] }), /runtime root/);
	});
});
