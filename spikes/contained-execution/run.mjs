// Orchestrator: start upstream + broker, wait for the socket, run the hostile probe in a
// --network=none podman container mounting only the broker socket, report.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const S = path.dirname(new URL(import.meta.url).pathname);
// Short host path: sockaddr_un.sun_path is capped at 108 bytes; the scratchpad dir alone exceeds it.
const SOCK = "/tmp/pel-spike.sock";
try {
	fs.unlinkSync(SOCK);
} catch {}

const up = spawn("node", [path.join(S, "upstream.mjs")], { stdio: ["ignore", "ignore", "inherit"] });
const br = spawn("node", [path.join(S, "broker.mjs")], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, BROKER_SOCK: SOCK } });
let brokerLog = "";
br.stderr.on("data", (c) => (brokerLog += c));

function waitForSock(ms) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (fs.existsSync(SOCK)) return true;
		spawnSync("sleep", ["0.1"]);
	}
	return false;
}

const cleanup = () => {
	up.kill();
	br.kill();
};

if (!waitForSock(8000)) {
	console.error("broker socket never appeared. broker log:\n" + brokerLog);
	cleanup();
	process.exit(2);
}
fs.chmodSync(SOCK, 0o777);

const res = spawnSync(
	"podman",
	["run", "--rm", "--network=none", "-v", `${SOCK}:/run/broker.sock`, "-v", `${path.join(S, "test.mjs")}:/test.mjs:ro`, "node:20-alpine", "node", "/test.mjs"],
	{ encoding: "utf-8", timeout: 90000 },
);
console.log(res.stdout || "");
if (res.stderr) console.log("[container stderr]\n" + res.stderr);
console.log(`container-exit=${res.status}`);
console.log("\n=== broker decisions ===\n" + brokerLog);
cleanup();
process.exit(res.status ?? 1);
