import { type ChildProcess, spawn as childProcessSpawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ulid } from "ulid";
import { createFlowEventTailer, type FlowEventTailer } from "./flow-event-tailer.js";
import type { LogBroker, LogSubscriber } from "./log-broker.js";
import type { Registry } from "./registry.js";
import { RegistryError } from "./registry.js";
import type { StateStore } from "./state-store.js";
import type { ContinuousMode, PersistedRun, ShipTargetName } from "./types.js";

export interface SupervisorDeps {
	store: StateStore;
	broker: LogBroker;
	registry: Registry;
	logDir: string;
	spawn?: typeof childProcessSpawn;
	now?: () => Date;
}

export interface StartOpts {
	repo: string;
	/** Required for ordinary runs; must be omitted for continuous mode. */
	item?: string;
	mode?: ContinuousMode;
	watchDailyBudget?: number;
	verbose?: boolean;
	parallel?: number;
	cycles?: number;
	shipTarget?: ShipTargetName;
}

export class Supervisor {
	private readonly store: StateStore;
	private readonly broker: LogBroker;
	private readonly registry: Registry;
	private readonly logDir: string;
	private readonly spawn: typeof childProcessSpawn;
	private readonly now: () => Date;
	private readonly children = new Map<string, ChildProcess>();
	private readonly tailers = new Map<string, FlowEventTailer>();

	constructor(deps: SupervisorDeps) {
		this.store = deps.store;
		this.broker = deps.broker;
		this.registry = deps.registry;
		this.logDir = deps.logDir;
		this.spawn = deps.spawn ?? childProcessSpawn;
		this.now = deps.now ?? (() => new Date());
		mkdirSync(this.logDir, { recursive: true });
	}

	get(id: string): PersistedRun | null {
		return this.store.get(id);
	}

	list(): PersistedRun[] {
		return this.store.list();
	}

	start(opts: StartOpts, resumedFrom?: string): PersistedRun {
		const repoCwd = this.resolveRepo(opts.repo);
		const id = ulid();
		const logPath = resolve(this.logDir, `${id}.log`);
		const args = this.buildArgs(opts, resumedFrom);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PELAGGIO_REPO: repoCwd,
			PELAGGIO_PLAIN: "1",
			// Daemon-spawned children are unattended; the local subscription-auth
			// authoring-review mode must refuse this execution context.
			PELAGGIO_SUPERVISED_RUN: "1",
			PELAGGIO_EXECUTION_ID: id,
			PELAGGIO_EVENT_STREAM_ID: id,
		};
		// The daemon requires CONTROL_PLANE_TOKEN (config.ts), but nothing a run
		// executes consumes it, and children (including SDK subprocesses) inherit
		// this env; strip it so prompt-injected code in the run's subtree cannot
		// read the credential and call back into the control-plane API. Server
		// host/port vars are not credentials and pass through untouched.
		delete env.CONTROL_PLANE_TOKEN;
		const child = this.spawn("pnpm", args, {
			cwd: repoCwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const startedAt = this.now().toISOString();
		const run: PersistedRun = {
			id,
			repo: opts.repo,
			...(opts.item !== undefined ? { item: opts.item } : {}),
			status: "running",
			pid: child.pid ?? null,
			startedAt,
			logPath,
			cwd: repoCwd,
			...(opts.shipTarget ? { shipTarget: opts.shipTarget } : {}),
			...(opts.parallel ? { parallel: opts.parallel } : {}),
			...(opts.cycles ? { cycles: opts.cycles } : {}),
			...(opts.mode ? { mode: opts.mode } : {}),
			...(opts.watchDailyBudget !== undefined ? { watchDailyBudget: opts.watchDailyBudget } : {}),
			...(opts.verbose === true ? { verbose: true } : {}),
			...(resumedFrom ? { resumedFrom } : {}),
			activity: { kind: "active" },
		};
		this.store.upsert(run);
		this.children.set(id, child);
		if (child.stdout) this.broker.tee(id, logPath, child.stdout);
		if (child.stderr) this.broker.tee(id, logPath, child.stderr);
		this.startTailer(run);
		child.on("exit", (code) => this.handleExit(id, code));
		return run;
	}

	private resolveRepo(slug: string): string {
		try {
			return this.registry.path(slug);
		} catch (err) {
			if (err instanceof RegistryError) {
				throw new SupervisorError(`unknown repo ${JSON.stringify(slug)}`, "unknown-repo");
			}
			throw err;
		}
	}

	/**
	 * Build pelaggio argv.
	 * - Ordinary: `--item` or `--resume` on successor; no continuous flags.
	 * - Continuous start/resume: `--preset <mode>`; never `--item`/`--resume`.
	 * - `--verbose` only when `verbose === true`.
	 */
	buildArgs(opts: StartOpts, resumedFrom: string | undefined): string[] {
		const args = ["--filter", "pelaggio", "pelaggio"];
		if (opts.mode) {
			args.push("--preset", opts.mode);
			if (opts.watchDailyBudget !== undefined) {
				args.push("--day-budget", String(opts.watchDailyBudget));
			}
		} else if (resumedFrom) {
			args.push("--resume", opts.item ?? "");
		} else {
			args.push("--item", opts.item ?? "");
		}
		if (opts.parallel) args.push("--parallel", String(opts.parallel));
		if (opts.cycles) args.push("--cycles", String(opts.cycles));
		if (opts.shipTarget) args.push("--target", opts.shipTarget);
		if (opts.verbose === true) args.push("--verbose");
		return args;
	}

	private startTailer(run: PersistedRun): void {
		this.stopTailer(run.id);
		const tailer = createFlowEventTailer({
			runId: run.id,
			cwd: run.cwd,
			executionId: run.id,
			onActivity: (activity) => {
				const current = this.store.get(run.id);
				if (!current || (current.status !== "running" && current.status !== "paused")) return;
				this.store.upsert({ ...current, activity });
			},
		});
		this.tailers.set(run.id, tailer);
		tailer.start();
	}

	private stopTailer(id: string): void {
		const t = this.tailers.get(id);
		if (t) {
			t.stop();
			this.tailers.delete(id);
		}
	}

	private clearActivity(run: PersistedRun): PersistedRun {
		const { activity: _a, ...rest } = run;
		return rest;
	}

	pause(id: string): PersistedRun {
		const run = this.requireRun(id);
		if (run.status !== "running") {
			throw new SupervisorError(`run ${id} is ${run.status}, cannot pause`, "invalid-state");
		}
		const child = this.children.get(id);
		if (!child || child.pid === undefined) {
			throw new SupervisorError(`run ${id} has no live process`, "no-process");
		}
		child.kill("SIGUSR2");
		const updated: PersistedRun = { ...run, status: "paused" };
		return this.store.upsert(updated);
	}

	resume(id: string): PersistedRun {
		const run = this.requireRun(id);
		// Reconstruct full launch policy so continuous pause→resume is lossless.
		return this.start(
			{
				repo: run.repo,
				...(run.item !== undefined ? { item: run.item } : {}),
				...(run.mode ? { mode: run.mode } : {}),
				...(run.watchDailyBudget !== undefined ? { watchDailyBudget: run.watchDailyBudget } : {}),
				...(run.verbose === true ? { verbose: true } : {}),
				...(run.parallel ? { parallel: run.parallel } : {}),
				...(run.cycles ? { cycles: run.cycles } : {}),
				...(run.shipTarget ? { shipTarget: run.shipTarget } : {}),
			},
			id,
		);
	}

	async stop(id: string): Promise<PersistedRun> {
		const run = this.requireRun(id);
		const child = this.children.get(id);
		if (!child || child.pid === undefined) {
			const updated: PersistedRun = {
				...this.clearActivity(run),
				status: "abandoned",
				endedAt: this.now().toISOString(),
				error: "no live process",
			};
			return this.store.upsert(updated);
		}
		child.kill("SIGINT");
		await new Promise<void>((res) => {
			let settled = false;
			const onExit = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				res();
			};
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				child.kill("SIGKILL");
				res();
			}, 5000);
			child.once("exit", onExit);
		});
		this.stopTailer(id);
		const updated: PersistedRun = {
			...this.clearActivity(this.store.get(id) ?? run),
			status: "abandoned",
			endedAt: this.now().toISOString(),
		};
		return this.store.upsert(updated);
	}

	attachLog(id: string, subscriber: LogSubscriber): Promise<{ unsubscribe: () => void; closed: boolean }> {
		const run = this.requireRun(id);
		return this.broker.attach(id, run.logPath, subscriber);
	}

	bootReattach(): void {
		const runs = this.store.list();
		for (const run of runs) {
			if (run.status !== "running" && run.status !== "paused") continue;
			if (run.pid === null || !isPidAlive(run.pid)) {
				this.store.upsert({
					...this.clearActivity(run),
					status: "abandoned",
					endedAt: this.now().toISOString(),
					error: "daemon restart lost stream",
				});
			} else {
				// Activity display only — pause/stop of foreign-orphaned PIDs remains limited.
				this.startTailer(run);
			}
		}
	}

	private handleExit(id: string, code: number | null): void {
		const run = this.store.get(id);
		if (!run) return;
		this.children.delete(id);
		this.broker.close(id);
		this.stopTailer(id);
		if (run.status === "abandoned") {
			this.store.upsert({ ...this.clearActivity(run), pid: null, exitCode: code ?? undefined });
			return;
		}
		// Paused-exit: SIGUSR2 → parkExit keeps status paused; clear pid/activity.
		if (run.status === "paused") {
			this.store.upsert({
				...this.clearActivity(run),
				pid: null,
				endedAt: this.now().toISOString(),
				exitCode: code ?? undefined,
			});
			return;
		}
		const status: PersistedRun["status"] = code === 0 ? "completed" : "failed";
		this.store.upsert({
			...this.clearActivity(run),
			status,
			pid: null,
			endedAt: this.now().toISOString(),
			exitCode: code ?? undefined,
		});
	}

	private requireRun(id: string): PersistedRun {
		const run = this.store.get(id);
		if (!run) throw new SupervisorError(`run ${id} not found`, "not-found");
		return run;
	}
}

export class SupervisorError extends Error {
	constructor(
		message: string,
		readonly code: "not-found" | "invalid-state" | "no-process" | "unknown-repo",
	) {
		super(message);
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		// EPERM means the process exists but we can't signal it — still alive.
		return e.code === "EPERM";
	}
}
