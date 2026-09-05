import { spawn, spawnSync } from "node:child_process";

/** One cancellation boundary for provider and verification children owned by a local run. */
export function runLocalProcess(bin: string, args: string[], cwd: string, signal?: AbortSignal, options: { shell?: boolean } = {}): Promise<{ ok: boolean; output: string }> {
	if (signal?.aborted) return Promise.resolve({ ok: false, output: "interrupted" });
	return new Promise((resolve) => {
		const grouped = process.platform !== "win32";
		const child = spawn(bin, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: grouped, shell: options.shell ?? false });
		let output = "";
		let failure: string | undefined;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		const stop = (hard: boolean): void => {
			if (!child.pid) return;
			if (!grouped) {
				spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
				return;
			}
			try {
				process.kill(-child.pid, hard ? "SIGKILL" : "SIGINT");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = "could not stop run process group";
			}
		};
		const onAbort = (): void => {
			stop(false);
			escalation = setTimeout(() => stop(true), 1000);
		};
		const capture = (chunk: Buffer): void => {
			output = (output + chunk.toString()).slice(-16_384);
		};
		child.stdout?.on("data", capture);
		child.stderr?.on("data", capture);
		child.on("error", (error) => {
			failure = error.message;
		});
		child.on("close", (code) => {
			// A child can exit while grandchildren with independent stdio still run.
			// Kill the owned group before releasing run ownership, including on normal exit.
			if (grouped || signal?.aborted) stop(true);
			if (escalation) clearTimeout(escalation);
			signal?.removeEventListener("abort", onAbort);
			resolve({ ok: code === 0 && !signal?.aborted && !failure, output: failure ?? output });
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}
