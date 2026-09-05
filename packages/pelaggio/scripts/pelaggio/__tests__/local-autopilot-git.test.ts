import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { continueRun, startRun } from "../local-autopilot/engine.js";
import { resolveExecutionAssurance } from "../local-autopilot/execution-policy.js";
import { localGit } from "../local-autopilot/git.js";
import { eventsPath } from "../local-autopilot/paths.js";
import { runLocalProcess } from "../local-autopilot/process.js";
import { runWorktreeGit, validateRunWorktree } from "../local-autopilot/run-worktree.js";

const directories: string[] = [];
after(() => {
	for (const path of directories) rmSync(path, { recursive: true, force: true });
});
function consumer(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pelaggio-git-identity-"));
	directories.push(cwd);
	localGit(cwd, ["init", "-b", "main"]);
	localGit(cwd, ["config", "user.name", "Test"]);
	localGit(cwd, ["config", "user.email", "test@example.invalid"]);
	writeFileSync(join(cwd, "README.md"), "original\n");
	localGit(cwd, ["add", "README.md"]);
	localGit(cwd, ["commit", "-m", "initial"]);
	mkdirSync(join(cwd, ".pelaggio"));
	writeFileSync(
		join(cwd, ".pelaggio", "pelaggio.yml"),
		JSON.stringify({
			harness: { adapter: "fake", fake: { script: [{ action: "decision", code: "choose", message: "Choose" }, { action: "complete" }] } },
			execution: { mode: "host" },
			autopilot: { maxRepairs: 0, verification: { command: "git diff --check HEAD" } },
		}),
	);
	return cwd;
}
function mainIdentity(cwd: string): string[] {
	return [localGit(cwd, ["rev-parse", "HEAD"]), localGit(cwd, ["ls-files", "--stage"]), readFileSync(join(cwd, "README.md"), "utf8")];
}

for (const corruption of ["missing-marker", "redirected-marker", "wrong-branch"] as const) {
	it(`refuses ${corruption} before resume or harness Git can touch main`, async () => {
		const cwd = consumer();
		const paused = await startRun(cwd, { task: { text: "task" }, nonInteractive: true });
		assert.ok(paused.ok, JSON.stringify(paused));
		if (!paused.ok) return;
		assert.ok(paused.value.worktree?.path);
		const worktree = paused.value.worktree.path;
		const marker = join(worktree, ".git");
		if (corruption === "missing-marker") rmSync(marker);
		else if (corruption === "redirected-marker") writeFileSync(marker, `gitdir: ${join(cwd, ".git")}\n`);
		else localGit(worktree, ["checkout", "-b", "wrong-branch"]);
		const before = mainIdentity(cwd);
		const journal = readFileSync(eventsPath(cwd, paused.value.runId), "utf8");
		const resumed = await continueRun(cwd, paused.value.runId, {
			adapters: {
				fake: {
					name: "fake",
					async next() {
						assert.fail("provider must not run with wrong Git ownership");
					},
				},
			},
		});
		assert.equal(resumed.ok, false);
		if (!resumed.ok) assert.equal(resumed.problem.code, "worktree");
		assert.throws(() => runWorktreeGit(cwd, paused.value.runId, ["add", "-A"]));
		assert.deepEqual(mainIdentity(cwd), before);
		assert.equal(readFileSync(eventsPath(cwd, paused.value.runId), "utf8"), journal);
	});
}

it("rechecks ownership after the provider returns, before a requested write", async () => {
	const cwd = consumer();
	const before = mainIdentity(cwd);
	let target = "";
	const result = await startRun(
		cwd,
		{ task: { text: "task" }, nonInteractive: true },
		{
			adapters: {
				fake: {
					name: "fake",
					async next(ctx) {
						target = join(ctx.worktree, "new-file");
						rmSync(join(ctx.worktree, ".git"));
						return { action: { kind: "write", path: "new-file", content: "must not write" }, cursor: 1 };
					},
				},
			},
		},
	);
	assert.equal(result.ok, false);
	assert.equal(existsSync(target), false);
	assert.deepEqual(mainIdentity(cwd), before);
});

it("normal worktrees retain their repository identity across resume", async () => {
	const cwd = consumer();
	const paused = await startRun(cwd, { task: { text: "task" }, nonInteractive: true });
	assert.ok(paused.ok);
	if (!paused.ok) return;
	assert.equal(validateRunWorktree(cwd, paused.value.runId), paused.value.worktree?.path);
	const resumed = await continueRun(cwd, paused.value.runId);
	assert.ok(resumed.ok, JSON.stringify(resumed));
	if (resumed.ok) assert.equal(resumed.value.disposition, "ready_for_review");
});

it("ignores inherited Git repository and index routing for provenance and execution", async () => {
	const cwd = consumer();
	const foreign = consumer();
	localGit(cwd, ["add", ".pelaggio/pelaggio.yml"]);
	const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
	const prior = names.map((name) => process.env[name]);
	try {
		process.env.GIT_DIR = join(foreign, ".git");
		process.env.GIT_WORK_TREE = foreign;
		process.env.GIT_INDEX_FILE = join(foreign, "empty-index");
		process.env.GIT_CONFIG_COUNT = "1";
		process.env.GIT_CONFIG_KEY_0 = "core.worktree";
		process.env.GIT_CONFIG_VALUE_0 = foreign;
		assert.equal(localGit(cwd, ["rev-parse", "--show-toplevel"]).trim(), cwd);
		const policy = resolveExecutionAssurance(cwd, { harness: { adapter: "fake" }, execution: { mode: "host" } }, false);
		assert.equal(policy.ok, false);
		if (!policy.ok) assert.equal(policy.problem.code, "host-consent-required");
		const child = await runLocalProcess(process.execPath, ["-e", 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(key => key.startsWith("GIT_"))))'], cwd);
		assert.equal(child.ok, true, child.output);
		assert.deepEqual(JSON.parse(child.output), []);
	} finally {
		for (const [i, name] of names.entries()) {
			if (prior[i] === undefined) delete process.env[name];
			else process.env[name] = prior[i];
		}
	}
});

it("rejects verification that destroys Git ownership before recording readiness", async () => {
	const cwd = consumer();
	const before = mainIdentity(cwd);
	const script = join(cwd, "verify.cjs");
	writeFileSync(script, 'require("node:fs").rmSync(".git");');
	const policyPath = join(cwd, ".pelaggio", "pelaggio.yml");
	const policy = JSON.parse(readFileSync(policyPath, "utf8")) as { autopilot: { verification: { command: string } } };
	policy.autopilot.verification.command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
	writeFileSync(policyPath, JSON.stringify(policy));
	const result = await startRun(
		cwd,
		{ task: { text: "task" }, nonInteractive: true },
		{
			adapters: {
				fake: {
					name: "fake",
					async next() {
						return { action: { kind: "complete" }, cursor: 1 };
					},
				},
			},
		},
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.problem.code, "run-execution");
	assert.deepEqual(mainIdentity(cwd), before);
});
