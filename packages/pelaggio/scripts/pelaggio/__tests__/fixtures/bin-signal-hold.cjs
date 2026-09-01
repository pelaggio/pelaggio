// Test shim for bin/pelaggio.js signal forwarding, loaded into every node
// process of the spawn tree via NODE_OPTIONS --require. It acts only inside
// the routed pipeline child (argv names scripts/pelaggio.ts): it reports the
// child's pid to the log, keeps the process alive, and converts a forwarded
// control signal into a distinct exit code the wrapper must mirror.
"use strict";
const { appendFileSync } = require("node:fs");

const log = process.env.PELAGGIO_BIN_SIGNAL_LOG;
const isPipelineChild = process.argv.some((arg) => arg.includes("scripts/pelaggio.ts"));
if (log && isPipelineChild) {
	appendFileSync(log, `child ${process.pid}\n`);
	setInterval(() => {}, 1_000);
	process.on("SIGUSR2", () => {
		appendFileSync(log, "child got SIGUSR2\n");
		process.exit(42);
	});
	process.on("SIGTERM", () => {
		appendFileSync(log, "child got SIGTERM\n");
		process.exit(43);
	});
}
