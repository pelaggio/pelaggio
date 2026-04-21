import { type ChildProcess, spawn as childProcessSpawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ulid } from "ulid";
import type { LogBroker, LogSubscriber } from "./log-broker.js";
import type { StateStore } from "./state-store.js";
import type { PersistedRun, ShipTargetName } from "./types.js";

export interface SupervisorDeps {
	store: StateStore;
	broker: LogBroker;
	repoCwd: string;
	logDir: string;
	spawn?: typeof childProcessSpawn;
	now?: () => Date;
}

export interface StartOpts {
	item: string;
	parallel?: number;
	cycles?: number;
	shipTarget?: ShipTargetName;
}

export class Supervisor {
	private readonly store: StateStore;
	private readonly broker: LogBroker;
	private readonly repoCwd: string;
	private readonly logDir: string;
	private readonly spawn: typeof childProcessSpawn;
	private readonly now: () => Date;
	private readonly children = new Map<string, ChildProcess>();

	constructor(deps: SupervisorDeps) {
		this.store = deps.store;
		this.broker = deps.broker;
		this.repoCwd = deps.repoCwd;
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
		const id = ulid();
		const logPath = resolve(this.logDir, `${id}.log`);
		const args = this.buildArgs(opts, resumedFrom);
		const child = this.spawn("pnpm", args, {
			cwd: this.repoCwd,
			env: { ...process.env, CLAUDE_AUTOPILOT_REPO: this.repoCwd, CLAUDE_AUTOPILOT_PLAIN: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const startedAt = this.now().toISOString();
		const run: PersistedRun = {
			id,
			item: opts.item,
			status: "running",
			pid: child.pid ?? null,
			startedAt,
			logPath,
			cwd: this.repoCwd,
			...(opts.shipTarget ? { shipTarget: opts.shipTarget } : {}),
			...(opts.parallel ? { parallel: opts.parallel } : {}),
			...(opts.cycles ? { cycles: opts.cycles } : {}),
			...(resumedFrom ? { resumedFrom } : {}),
		};
		this.store.upsert(run);
		this.children.set(id, child);
		if (child.stdout) this.broker.tee(id, logPath, child.stdout);
		if (child.stderr) this.broker.tee(id, logPath, child.stderr);
		child.on("exit", (code) => this.handleExit(id, code));
		return run;
	}

	private buildArgs(opts: StartOpts, resumedFrom: string | undefined): string[] {
		const args = ["--filter", "@cdhorne/claude-autopilot", "autopilot"];
		if (resumedFrom) {
			args.push("--resume", opts.item);
		} else {
			args.push("--item", opts.item);
		}
		if (opts.parallel) args.push("--parallel", String(opts.parallel));
		if (opts.cycles) args.push("--cycles", String(opts.cycles));
		if (opts.shipTarget) args.push("--target", opts.shipTarget);
		args.push("--verbose");
		return args;
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
		return this.start({ item: run.item, ...(run.shipTarget ? { shipTarget: run.shipTarget } : {}) }, id);
	}

	async stop(id: string): Promise<PersistedRun> {
		const run = this.requireRun(id);
		const child = this.children.get(id);
		if (!child || child.pid === undefined) {
			const updated: PersistedRun = { ...run, status: "abandoned", endedAt: this.now().toISOString(), error: "no live process" };
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
		const updated: PersistedRun = {
			...(this.store.get(id) ?? run),
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
				this.store.upsert({ ...run, status: "abandoned", endedAt: this.now().toISOString(), error: "daemon restart lost stream" });
			}
		}
	}

	private handleExit(id: string, code: number | null): void {
		const run = this.store.get(id);
		if (!run) return;
		this.children.delete(id);
		this.broker.close(id);
		if (run.status === "abandoned") {
			this.store.upsert({ ...run, pid: null, exitCode: code ?? undefined });
			return;
		}
		const status: PersistedRun["status"] = code === 0 ? "completed" : "failed";
		this.store.upsert({
			...run,
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
		readonly code: "not-found" | "invalid-state" | "no-process",
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
