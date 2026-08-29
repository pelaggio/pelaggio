import { Worker } from "node:worker_threads";
import { REPO } from "./config.js";
import { A } from "./tui.js";
import type { Flags, RunFinishOutcome, RunMode } from "./types.js";

/** Default advertised heartbeat interval. Readers trust `run-started.heartbeatMs`, not this constant. */
export const RUN_HEARTBEAT_MS = 15_000;
const WORKER_ACK_TIMEOUT_MS = 5_000;

export interface StartRunLifecycleOptions {
	flags: Flags;
	executionId: string;
	root?: string;
	heartbeatMs?: number;
	onError?: (error: unknown) => void;
}

export interface RunLifecycle {
	finish(input: { outcome: RunFinishOutcome; exitCode: number }): void;
	stop(): void;
}

type LifecycleWorkerCommand = { type: "finish"; outcome: RunFinishOutcome; exitCode: number; acknowledgement: SharedArrayBuffer } | { type: "stop"; acknowledgement: SharedArrayBuffer };
type LifecycleWorkerCommandInput = { type: "finish"; outcome: RunFinishOutcome; exitCode: number } | { type: "stop" };

function defaultOnError(error: unknown): void {
	const msg = error instanceof Error ? error.message : String(error);
	console.log(`${A.dim(`flow-event emit failed: ${msg}`)}`);
}

function modeFromFlags(flags: Flags): RunMode | undefined {
	if (flags.preset === "drain" || flags.preset === "watch") return flags.preset;
	if (flags.continuous === true) return "drain";
	return undefined;
}

function waitForAcknowledgement(buffer: SharedArrayBuffer): boolean {
	const acknowledgement = new Int32Array(buffer);
	if (Atomics.load(acknowledgement, 0) !== 0) return Atomics.load(acknowledgement, 0) === 1;
	Atomics.wait(acknowledgement, 0, 0, WORKER_ACK_TIMEOUT_MS);
	return Atomics.load(acknowledgement, 0) === 1;
}

/**
 * Owns process-lifecycle events in a worker-thread segment. The worker's timer keeps
 * advancing while orchestration blocks the main thread in synchronous tool checks.
 */
export function startRunLifecycle(opts: StartRunLifecycleOptions): RunLifecycle {
	if (opts.flags["dry-run"]) return { finish() {}, stop() {} };
	const heartbeatMs = opts.heartbeatMs ?? RUN_HEARTBEAT_MS;
	const onError = opts.onError ?? defaultOnError;
	let reported = false;
	const report = (error: unknown): void => {
		if (reported) return;
		reported = true;
		onError(error);
	};
	const startup = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
	let worker: Worker;
	try {
		worker = new Worker(new URL("./run-lifecycle-worker.mjs", import.meta.url), {
			workerData: {
				root: opts.root ?? REPO,
				executionId: opts.executionId,
				heartbeatMs,
				itemId: opts.flags.item ?? opts.flags.resume ?? null,
				mode: modeFromFlags(opts.flags),
				resumed: opts.flags.resume !== undefined,
				startup,
			},
		});
	} catch (error) {
		report(error);
		return { finish() {}, stop() {} };
	}
	worker.unref();

	let finished = false;
	let stopped = false;
	worker.on("error", (error) => {
		stopped = true;
		report(error);
	});
	worker.on("message", (message: unknown) => {
		if (typeof message !== "object" || message === null || !("error" in message) || typeof message.error !== "string") return;
		stopped = true;
		report(new Error(message.error));
	});
	worker.on("exit", (code) => {
		if (stopped) return;
		stopped = true;
		report(new Error(`Lifecycle worker exited before completion (code ${code})`));
	});

	if (!waitForAcknowledgement(startup)) {
		stopped = true;
		void worker.terminate();
		report(new Error("Lifecycle worker failed to start"));
	}

	const send = (command: LifecycleWorkerCommandInput): void => {
		if (stopped) return;
		const acknowledgement = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
		try {
			worker.postMessage({ ...command, acknowledgement } satisfies LifecycleWorkerCommand);
		} catch (error) {
			stopped = true;
			report(error);
			return;
		}
		if (waitForAcknowledgement(acknowledgement)) return;
		stopped = true;
		void worker.terminate();
		report(new Error("Lifecycle worker failed to acknowledge command"));
	};

	return {
		finish(input: { outcome: RunFinishOutcome; exitCode: number }): void {
			if (finished) return;
			finished = true;
			send({ type: "finish", outcome: input.outcome, exitCode: input.exitCode });
			stopped = true;
		},
		stop(): void {
			if (stopped) return;
			send({ type: "stop" });
			stopped = true;
		},
	};
}
