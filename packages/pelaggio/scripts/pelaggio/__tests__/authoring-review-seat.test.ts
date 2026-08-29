import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { authoringReviewSeatPath, authoringReviewSeatsRoot, cleanupAuthoringReviewSeat, cleanupAuthoringReviewSeatsForSha, type GitExec, prepareAuthoringReviewSeat } from "../review/seats.js";
import { repairMainNodeModules } from "../worktree-deps.js";

const HOST_DEPENDENCIES = ["@anthropic-ai/claude-agent-sdk", "@linear/sdk", "diff", "tsx", "ulid", "yaml"] as const;

interface Fixture {
	root: string;
	host: string;
	key: { sha: string; seatId: string; pass: number };
	seat: string;
	links: Map<string, { name: string; target: string }>;
	binPath: string;
	binContents: string;
	yamlResolution: string;
}

function plantPackage(path: string, name: string): void {
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
	writeFileSync(join(path, "index.js"), `module.exports = ${JSON.stringify(name)};\n`);
}

function makeFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "authoring-review-seat-ac-"));
	const host = resolve(root, "host");
	const packageRoot = resolve(host, "packages", "pelaggio");
	const packageNodeModules = resolve(packageRoot, "node_modules");
	const store = resolve(host, "node_modules", ".pnpm");
	mkdirSync(packageNodeModules, { recursive: true });
	writeFileSync(resolve(host, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	writeFileSync(
		resolve(packageRoot, "package.json"),
		JSON.stringify({
			name: "pelaggio",
			private: true,
			dependencies: Object.fromEntries(HOST_DEPENDENCIES.filter((name) => name !== "@linear/sdk").map((name) => [name, "1.0.0"])),
			peerDependencies: { "@linear/sdk": ">=1" },
		}),
	);

	const links = new Map<string, { name: string; target: string }>();
	for (const name of HOST_DEPENDENCIES) {
		const packagePath = resolve(store, `${name.replace("/", "+")}@1.0.0`, "node_modules", name);
		plantPackage(packagePath, name);
		const linkPath = resolve(packageNodeModules, name);
		const target = relative(resolve(linkPath, ".."), packagePath);
		mkdirSync(resolve(linkPath, ".."), { recursive: true });
		symlinkSync(target, linkPath, "dir");
		links.set(linkPath, { name, target });
	}
	const binPath = resolve(packageNodeModules, ".bin", "tsx");
	const binContents = `#!/bin/sh\nexec ${resolve(packageNodeModules, "tsx", "index.js")} "$@"\n`;
	mkdirSync(resolve(binPath, ".."), { recursive: true });
	writeFileSync(binPath, binContents);

	const key = { sha: "abc1234def", seatId: "grok", pass: 1 };
	return {
		root,
		host,
		key,
		seat: authoringReviewSeatPath(host, key),
		links,
		binPath,
		binContents,
		yamlResolution: createRequire(resolve(packageRoot, "package.json")).resolve("yaml"),
	};
}

function fakeGit(fx: Fixture): GitExec {
	return (args) => {
		if (args[0] === "worktree" && args[1] === "add") {
			mkdirSync(fx.seat, { recursive: true });
			return "";
		}
		if (args[0] === "worktree" && args[1] === "list") {
			return existsSync(fx.seat) ? `worktree ${fx.seat}\nHEAD ${fx.key.sha}\ndetached\n` : `worktree ${fx.host}\n`;
		}
		if (args[0] === "rev-parse") return `${fx.key.sha}\n`;
		if (args[0] === "status") return "";
		if (args[0] === "worktree" && args[1] === "remove") {
			rmSync(args[3] ?? fx.seat, { recursive: true, force: true });
			return "";
		}
		return "";
	};
}

function rewriteHostLinksIntoSeat(fx: Fixture): void {
	for (const [linkPath, { name }] of fx.links) {
		const seatPackage = resolve(fx.seat, "node_modules", ".pnpm", `${name.replace("/", "+")}@poisoned`, "node_modules", name);
		plantPackage(seatPackage, `seat-${name}`);
		rmSync(linkPath, { recursive: true, force: true });
		symlinkSync(seatPackage, linkPath, "dir");
	}
}

function assertHostLinksRestored(fx: Fixture): void {
	for (const [linkPath, { target }] of fx.links) {
		assert.ok(lstatSync(linkPath).isSymbolicLink(), `${linkPath} is a symlink`);
		assert.equal(readlinkSync(linkPath), target, `${linkPath} target`);
	}
	const packageJson = resolve(fx.host, "packages", "pelaggio", "package.json");
	assert.equal(createRequire(packageJson).resolve("yaml"), fx.yamlResolution);
	assert.equal(createRequire(packageJson)("yaml"), "yaml");
}

describe("authoring review seat host dependency restoration (#647)", () => {
	it("restores every direct importer dependency link on teardown", async () => {
		const fx = makeFixture();
		const git = fakeGit(fx);
		try {
			prepareAuthoringReviewSeat(fx.host, fx.key, git);
			rewriteHostLinksIntoSeat(fx);
			await cleanupAuthoringReviewSeat(fx.host, fx.key, git);
			assertHostLinksRestored(fx);

			const errorKey = { ...fx.key, pass: 2 };
			fx.key = errorKey;
			fx.seat = authoringReviewSeatPath(fx.host, errorKey);
			prepareAuthoringReviewSeat(fx.host, errorKey, git);
			try {
				rewriteHostLinksIntoSeat(fx);
				throw new Error("reviewer failed");
			} catch (error) {
				assert.match(error instanceof Error ? error.message : String(error), /reviewer failed/);
			} finally {
				await cleanupAuthoringReviewSeat(fx.host, errorKey, git);
			}
			assertHostLinksRestored(fx);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("a pruned seat directory does not dangle a host checkout", async () => {
		const fx = makeFixture();
		const git = fakeGit(fx);
		try {
			prepareAuthoringReviewSeat(fx.host, fx.key, git);
			rewriteHostLinksIntoSeat(fx);
			rmSync(resolve(authoringReviewSeatsRoot(fx.host), fx.key.sha), { recursive: true, force: true });

			await cleanupAuthoringReviewSeatsForSha(fx.host, fx.key.sha, git);
			assertHostLinksRestored(fx);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("parallel SHAs share one canonical restoration snapshot", async () => {
		const fx = makeFixture();
		const git = fakeGit(fx);
		const first = fx.key;
		try {
			prepareAuthoringReviewSeat(fx.host, first, git);
			rewriteHostLinksIntoSeat(fx);

			const second = { sha: "fedcba9876", seatId: "codex", pass: 1 };
			fx.key = second;
			fx.seat = authoringReviewSeatPath(fx.host, second);
			prepareAuthoringReviewSeat(fx.host, second, git);

			await cleanupAuthoringReviewSeat(fx.host, first, git);
			assertHostLinksRestored(fx);
			rewriteHostLinksIntoSeat(fx);
			await cleanupAuthoringReviewSeat(fx.host, second, git);
			assertHostLinksRestored(fx);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("does not overwrite a concurrent healthy pnpm target", async () => {
		const fx = makeFixture();
		const git = fakeGit(fx);
		try {
			prepareAuthoringReviewSeat(fx.host, fx.key, git);
			const yamlLink = resolve(fx.host, "packages", "pelaggio", "node_modules", "yaml");
			const updatedPackage = resolve(fx.host, "node_modules", ".pnpm", "yaml@2.0.0", "node_modules", "yaml");
			plantPackage(updatedPackage, "yaml");
			const updatedTarget = relative(resolve(fx.host, "packages", "pelaggio", "node_modules"), updatedPackage);
			rmSync(yamlLink);
			symlinkSync(updatedTarget, yamlLink, "dir");

			await cleanupAuthoringReviewSeat(fx.host, fx.key, git);
			assert.equal(readlinkSync(yamlLink), updatedTarget);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("a skipped teardown is repaired from the durable snapshot under the main repair lock", async () => {
		const fx = makeFixture();
		const git = fakeGit(fx);
		const lockPaths: string[] = [];
		const runnerCalls: string[] = [];
		try {
			prepareAuthoringReviewSeat(fx.host, fx.key, git);
			rewriteHostLinksIntoSeat(fx);
			const report = await repairMainNodeModules(fx.host, { run: (cmd) => runnerCalls.push(cmd) }, async (path, fn) => {
				lockPaths.push(path);
				return fn();
			});
			assert.equal(report.ranInstall, false);
			assert.equal(report.repaired.length, HOST_DEPENDENCIES.length);
			assert.deepEqual(lockPaths, [resolve(fx.host, ".dev", "node-modules-repair.lock")]);
			assert.deepEqual(runnerCalls, []);
			assertHostLinksRestored(fx);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("leaves a healthy main checkout untouched without invoking pnpm", async () => {
		const fx = makeFixture();
		const git = fakeGit(fx);
		const calls: Array<{ cmd: string; cwd: string }> = [];
		try {
			prepareAuthoringReviewSeat(fx.host, fx.key, git);
			const report = await repairMainNodeModules(fx.host, {
				run: (cmd, cwd) => calls.push({ cmd, cwd }),
			});
			assert.deepEqual(report, { ranInstall: false, repaired: [] });
			assert.deepEqual(calls, []);
			assertHostLinksRestored(fx);
		} finally {
			await cleanupAuthoringReviewSeat(fx.host, fx.key, git);
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("detects and regenerates poisoned package .bin shims", async () => {
		const fx = makeFixture();
		const git = fakeGit(fx);
		const calls: Array<{ cmd: string; cwd: string }> = [];
		const lockPaths: string[] = [];
		try {
			prepareAuthoringReviewSeat(fx.host, fx.key, git);
			writeFileSync(fx.binPath, `#!/bin/sh\nexec ${resolve(fx.seat, "packages", "pelaggio", "node_modules", "tsx", "index.js")} "$@"\n`);

			await cleanupAuthoringReviewSeat(fx.host, fx.key, git, (main) =>
				repairMainNodeModules(
					main,
					{
						run: (cmd, cwd) => {
							calls.push({ cmd, cwd });
							writeFileSync(fx.binPath, fx.binContents);
						},
					},
					async (path, fn) => {
						lockPaths.push(path);
						return fn();
					},
				),
			);

			assert.deepEqual(calls, [{ cmd: "pnpm install --frozen-lockfile --ignore-scripts", cwd: fx.host }]);
			assert.deepEqual(lockPaths, [resolve(fx.host, ".dev", "node-modules-repair.lock")]);
			assert.equal(readFileSync(fx.binPath, "utf8"), fx.binContents);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("does not throw from teardown when locked dependency repair fails", async () => {
		const fx = makeFixture();
		const git = fakeGit(fx);
		try {
			prepareAuthoringReviewSeat(fx.host, fx.key, git);
			await assert.doesNotReject(() =>
				cleanupAuthoringReviewSeat(fx.host, fx.key, git, async () => {
					throw new Error("repair lock unavailable");
				}),
			);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	it("a stale snapshot runs main repair instead of restoring the old lockfile target", async () => {
		const fx = makeFixture();
		const git = fakeGit(fx);
		const calls: Array<{ cmd: string; cwd: string }> = [];
		const yamlLink = resolve(fx.host, "packages", "pelaggio", "node_modules", "yaml");
		try {
			prepareAuthoringReviewSeat(fx.host, fx.key, git);
			writeFileSync(resolve(fx.host, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# updated\n");
			rmSync(yamlLink);

			const report = await repairMainNodeModules(
				fx.host,
				{
					run: (cmd, cwd) => {
						calls.push({ cmd, cwd });
						const updatedPackage = resolve(fx.host, "node_modules", ".pnpm", "yaml@2.0.0", "node_modules", "yaml");
						plantPackage(updatedPackage, "yaml");
						symlinkSync(relative(resolve(fx.host, "packages", "pelaggio", "node_modules"), updatedPackage), yamlLink, "dir");
					},
				},
				async (_path, fn) => fn(),
			);

			assert.equal(report.ranInstall, true);
			assert.deepEqual(calls, [{ cmd: "pnpm install --frozen-lockfile --ignore-scripts", cwd: fx.host }]);
			assert.match(readlinkSync(yamlLink), /yaml@2\.0\.0/);
			assert.notEqual(readlinkSync(yamlLink), fx.links.get(yamlLink)?.target, "the stale snapshot target was not resurrected");
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});
});
