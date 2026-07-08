import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { LogBroker } from "../src/log-broker.js";
import { Registry } from "../src/registry.js";
import { StateStore } from "../src/state-store.js";
import { Supervisor, SupervisorError } from "../src/supervisor.js";

interface FakeChild extends EventEmitter {
	pid: number;
	stdout: PassThrough;
	stderr: PassThrough;
	signals: NodeJS.Signals[];
	kill(sig: NodeJS.Signals): boolean;
}

function makeFakeChild(pid: number): FakeChild {
	const ee = new EventEmitter() as FakeChild;
	ee.pid = pid;
	ee.stdout = new PassThrough();
	ee.stderr = new PassThrough();
	ee.signals = [];
	ee.kill = (sig: NodeJS.Signals): boolean => {
		ee.signals.push(sig);
		return true;
	};
	return ee;
}

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "supervisor-"));
	const store = new StateStore(join(dir, "state.json"));
	const broker = new LogBroker();
	const spawned: Array<{ cmd: string; args: string[]; opts: { cwd: string; env: Record<string, string> }; child: FakeChild }> = [];
	let nextPid = 1000;
	const spawn = ((cmd: string, args: string[], opts: unknown) => {
		const child = makeFakeChild(nextPid++);
		spawned.push({ cmd, args, opts: opts as { cwd: string; env: Record<string, string> }, child });
		return child as unknown as ChildProcess;
	}) as unknown as typeof import("node:child_process").spawn;
	const registry = new Registry([{ slug: "main", path: dir }]);
	const supervisor = new Supervisor({
		store,
		broker,
		registry,
		logDir: join(dir, "logs"),
		spawn,
		now: () => new Date("2026-04-19T00:00:00.000Z"),
	});
	return { dir, store, broker, spawn, spawned, supervisor, registry };
}

describe("Supervisor.start", () => {
	it("spawns pnpm with the expected argv and records status: running", () => {
		const { dir, supervisor, spawned } = setup();
		const run = supervisor.start({ repo: "main", item: "TOOL-1", parallel: 2, cycles: 3, shipTarget: "pull-request" });
		assert.equal(spawned.length, 1);
		assert.equal(spawned[0].cmd, "pnpm");
		assert.deepEqual(spawned[0].args, ["--filter", "pelaggio", "pelaggio", "--item", "TOOL-1", "--parallel", "2", "--cycles", "3", "--target", "pull-request", "--verbose"]);
		assert.equal(run.status, "running");
		assert.equal(run.item, "TOOL-1");
		assert.equal(run.repo, "main");
		assert.equal(run.pid, 1000);
		assert.equal(spawned[0].opts.cwd, dir);
		assert.equal(spawned[0].opts.env.PELAGGIO_REPO, dir);
		assert.equal(spawned[0].opts.env.PELAGGIO_PLAIN, "1");
	});

	it("throws SupervisorError(unknown-repo) when slug is not registered", () => {
		const { supervisor } = setup();
		assert.throws(
			() => supervisor.start({ repo: "missing", item: "TOOL-1" }),
			(err: unknown) => err instanceof SupervisorError && err.code === "unknown-repo",
		);
	});
});

describe("Supervisor.pause", () => {
	it("sends SIGUSR2 to the child and updates status to paused", () => {
		const { supervisor, spawned } = setup();
		const run = supervisor.start({ repo: "main", item: "TOOL-1" });
		const updated = supervisor.pause(run.id);
		assert.equal(updated.status, "paused");
		assert.deepEqual(spawned[0].child.signals, ["SIGUSR2"]);
	});

	it("throws on unknown id", () => {
		const { supervisor } = setup();
		assert.throws(() => supervisor.pause("missing"), SupervisorError);
	});
});

describe("Supervisor.stop", () => {
	it("sends SIGINT then escalates to SIGKILL after 5s, marks abandoned", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { supervisor, spawned } = setup();
		const run = supervisor.start({ repo: "main", item: "TOOL-1" });
		const stopPromise = supervisor.stop(run.id);
		// child does not exit on SIGINT — let timer expire
		t.mock.timers.tick(5001);
		const updated = await stopPromise;
		assert.equal(updated.status, "abandoned");
		assert.deepEqual(spawned[0].child.signals, ["SIGINT", "SIGKILL"]);
	});

	it("returns once child exits before grace expires", async () => {
		const { supervisor, spawned } = setup();
		const run = supervisor.start({ repo: "main", item: "TOOL-1" });
		const stopPromise = supervisor.stop(run.id);
		setImmediate(() => spawned[0].child.emit("exit", 130));
		const updated = await stopPromise;
		assert.equal(updated.status, "abandoned");
		assert.deepEqual(spawned[0].child.signals, ["SIGINT"]);
	});
});

describe("Supervisor.resume", () => {
	it("starts a new child with --resume args and records resumedFrom", () => {
		const { dir, supervisor, spawned } = setup();
		const original = supervisor.start({ repo: "main", item: "TOOL-1", shipTarget: "auto-merge-pr" });
		const resumed = supervisor.resume(original.id);
		assert.equal(spawned.length, 2);
		assert.deepEqual(spawned[1].args, ["--filter", "pelaggio", "pelaggio", "--resume", "TOOL-1", "--target", "auto-merge-pr", "--verbose"]);
		assert.equal(resumed.resumedFrom, original.id);
		assert.notEqual(resumed.id, original.id);
		// Re-uses original repo slug → same cwd
		assert.equal(spawned[1].opts.cwd, dir);
		assert.equal(resumed.repo, "main");
	});
});

describe("Supervisor.bootReattach", () => {
	it("marks dead-PID running runs as abandoned", () => {
		const { dir, supervisor, store } = setup();
		// Pre-populate state with a "running" entry whose PID is dead.
		store.upsert({
			id: "stale",
			repo: "main",
			item: "TOOL-X",
			status: "running",
			pid: 999_999, // unlikely to exist
			startedAt: "2026-04-18T00:00:00.000Z",
			logPath: join(dir, "stale.log"),
			cwd: dir,
		});
		supervisor.bootReattach();
		const updated = store.get("stale");
		assert.equal(updated?.status, "abandoned");
	});

	it("leaves running runs whose PID is alive untouched", () => {
		const { dir, supervisor, store } = setup();
		store.upsert({
			id: "live",
			repo: "main",
			item: "TOOL-Y",
			status: "running",
			pid: process.pid,
			startedAt: "2026-04-18T00:00:00.000Z",
			logPath: join(dir, "live.log"),
			cwd: dir,
		});
		supervisor.bootReattach();
		const updated = store.get("live");
		assert.equal(updated?.status, "running");
	});
});

describe("Supervisor child exit", () => {
	it("status becomes completed on exit code 0", async () => {
		const { supervisor, spawned } = setup();
		const run = supervisor.start({ repo: "main", item: "TOOL-1" });
		spawned[0].child.emit("exit", 0);
		await new Promise(setImmediate);
		const updated = supervisor.get(run.id);
		assert.equal(updated?.status, "completed");
		assert.equal(updated?.exitCode, 0);
	});

	it("status becomes failed on non-zero exit", async () => {
		const { supervisor, spawned } = setup();
		const run = supervisor.start({ repo: "main", item: "TOOL-1" });
		spawned[0].child.emit("exit", 1);
		await new Promise(setImmediate);
		const updated = supervisor.get(run.id);
		assert.equal(updated?.status, "failed");
		assert.equal(updated?.exitCode, 1);
	});
});
