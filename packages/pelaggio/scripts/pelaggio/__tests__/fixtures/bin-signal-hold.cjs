// Test shim for bin/pelaggio.js signal forwarding, loaded into every node
// process of the spawn tree via NODE_OPTIONS --require. It acts only inside
// the routed pipeline child (argv names scripts/pelaggio.ts): it reports the
// child's pid to the log, then makes the child deterministic — self-exit
// paths (process.exit, fatal errors) are intercepted so ONLY the forwarded
// control signal can end it, converting that signal into a distinct exit code
// the wrapper must mirror. Without this, the routed script can finish booting
// and exit on its own before a pending forwarded signal gets a loop turn
// (observed on slower CI runners), making the assertion racy.
"use strict";
const { appendFileSync } = require("node:fs");

const log = process.env.PELAGGIO_BIN_SIGNAL_LOG;
const isPipelineChild = process.argv.some((arg) => arg.includes("scripts/pelaggio.ts"));
if (log && isPipelineChild) {
	const realExit = process.exit.bind(process);
	process.exit = (code) => {
		appendFileSync(log, `child exit(${code ?? ""}) intercepted\n`);
		return undefined;
	};
	process.on("uncaughtException", (error) => {
		appendFileSync(log, `child uncaught intercepted: ${error?.message ?? error}\n`);
	});
	process.on("unhandledRejection", (reason) => {
		appendFileSync(log, `child rejection intercepted: ${reason?.message ?? reason}\n`);
	});
	process.on("SIGUSR2", () => {
		appendFileSync(log, "child got SIGUSR2\n");
		realExit(42);
	});
	process.on("SIGTERM", () => {
		appendFileSync(log, "child got SIGTERM\n");
		realExit(43);
	});
	setInterval(() => {}, 1_000);
	appendFileSync(log, `child ${process.pid}\n`);
}
