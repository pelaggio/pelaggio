import { parentPort, workerData } from "node:worker_threads";
import { createEventWriter } from "./flow-events.js";
import type { RunFinishOutcome, RunMode } from "./types.js";

interface LifecycleWorkerData {
	root: string;
	executionId: string;
	heartbeatMs: number;
	itemId: string | null;
	mode?: RunMode;
	resumed: boolean;
	startup: SharedArrayBuffer;
}

type LifecycleWorkerCommand = { type: "finish"; outcome: RunFinishOutcome; exitCode: number; acknowledgement: SharedArrayBuffer } | { type: "stop"; acknowledgement: SharedArrayBuffer };

function acknowledge(buffer: SharedArrayBuffer, ok: boolean): void {
	const acknowledgement = new Int32Array(buffer);
	Atomics.store(acknowledgement, 0, ok ? 1 : -1);
	Atomics.notify(acknowledgement, 0);
}

const data = workerData as LifecycleWorkerData;
const startup = data.startup;

try {
	const writer = createEventWriter({ root: data.root, executionId: data.executionId });
	writer.append({
		type: "pelaggio.run-started",
		itemId: data.itemId,
		heartbeatMs: data.heartbeatMs,
		...(data.mode ? { mode: data.mode } : {}),
		...(data.resumed ? { resumed: true as const } : {}),
	});
	const timer = setInterval(() => {
		try {
			writer.append({ type: "pelaggio.run-heartbeat" });
		} catch (error) {
			clearInterval(timer);
			parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
			parentPort?.close();
		}
	}, data.heartbeatMs);

	parentPort?.on("message", (command: LifecycleWorkerCommand) => {
		let ok = true;
		try {
			clearInterval(timer);
			if (command.type === "finish") writer.append({ type: "pelaggio.run-finished", outcome: command.outcome, exitCode: command.exitCode });
		} catch {
			ok = false;
		} finally {
			acknowledge(command.acknowledgement, ok);
			parentPort?.close();
		}
	});
	acknowledge(startup, true);
} catch {
	acknowledge(startup, false);
	parentPort?.close();
}
