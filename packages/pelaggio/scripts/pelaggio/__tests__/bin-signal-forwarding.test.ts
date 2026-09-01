import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BIN = resolve(PACKAGE_ROOT, "bin", "pelaggio.js");
const HOLD_SHIM = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "bin-signal-hold.cjs");

function readLog(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

async function pollUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	return predicate();
}

/**
 * End-to-end contract for the wrapper the workspace `pelaggio` script routes
 * through (#699 roll 16): a control signal sent to the wrapper — the only
 * process the supervisor's pause/stop can see — must reach the routed pipeline
 * child, and the wrapper must mirror how the child ended. The hold shim rides
 * NODE_OPTIONS into the child, reports its pid, keeps it alive, and converts
 * the forwarded signal into a distinct exit code the wrapper must reproduce;
 * an unforwarded wrapper dies signaled itself and orphans the child, failing
 * both assertions.
 */
async function assertSignalReachesPipeline(signal: "SIGUSR2" | "SIGTERM", mirroredCode: number): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pelaggio-bin-signal-"));
	const log = join(root, "signal.log");
	let wrapper: ChildProcess | undefined;
	try {
		writeFileSync(log, "");
		wrapper = spawn(process.execPath, [BIN, "run", "--help"], {
			cwd: root,
			stdio: "ignore",
			env: {
				...process.env,
				NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${HOLD_SHIM}`.trim(),
				PELAGGIO_BIN_SIGNAL_LOG: log,
			},
		});
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
			wrapper?.on("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
		});

		assert.ok(await pollUntil(() => /^child \d+$/m.test(readLog(log)), 30_000), "the routed pipeline child never reported in — bin spawn failed");
		assert.ok(wrapper.kill(signal), "signal not delivered to the wrapper");

		const outcome = await exited;
		assert.match(readLog(log), new RegExp(`child got ${signal}`), `${signal} sent to the wrapper never reached the pipeline child`);
		assert.equal(outcome.signal, null, "the wrapper must mirror the child's exit, not die of the signal itself");
		assert.equal(outcome.code, mirroredCode, "the wrapper must mirror the child's exit code");
	} finally {
		// Belt: reap any straggler by numeric pid from the log, then the wrapper.
		const pid = Number.parseInt(/^child (\d+)$/m.exec(readLog(log))?.[1] ?? "", 10);
		if (Number.isFinite(pid)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone — the expected case.
			}
		}
		try {
			wrapper?.kill("SIGKILL");
		} catch {
			// Already gone.
		}
		rmSync(root, { recursive: true, force: true });
	}
}

describe("bin/pelaggio.js signal forwarding (#647)", () => {
	it("forwards SIGUSR2 (supervisor pause) to the pipeline child and mirrors its exit", async () => {
		await assertSignalReachesPipeline("SIGUSR2", 42);
	});

	it("forwards SIGTERM (supervisor stop) to the pipeline child and mirrors its exit", async () => {
		await assertSignalReachesPipeline("SIGTERM", 43);
	});
});
