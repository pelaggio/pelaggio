import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PELAGGIO_LOOPBACK_PORT);
const SOCKET = process.env.PELAGGIO_EGRESS_SOCKET ?? "/run/pelaggio/egress.sock";

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
	process.stderr.write("contained bridge: invalid PELAGGIO_LOOPBACK_PORT\n");
	process.exit(2);
}

const [driver, ...args] = process.argv.slice(2);
if (!driver) {
	process.stderr.write("contained bridge: missing driver\n");
	process.exit(2);
}

let child;
let failed = false;
const connections = new Set();

function fail(message) {
	if (failed) return;
	failed = true;
	process.stderr.write(`contained bridge: ${message}\n`);
	for (const socket of connections) socket.destroy();
	child?.kill("SIGKILL");
	server.close(() => process.exit(1));
}

const server = createServer((tcp) => {
	const unix = connect(SOCKET);
	connections.add(tcp);
	connections.add(unix);
	tcp.pipe(unix);
	unix.pipe(tcp);
	const close = () => {
		connections.delete(tcp);
		connections.delete(unix);
		tcp.destroy();
		unix.destroy();
	};
	tcp.once("error", close);
	unix.once("error", (error) => {
		close();
		fail(`broker unavailable: ${error.message}`);
	});
	tcp.once("close", close);
	unix.once("close", close);
});

server.once("error", (error) => fail(`listener failed: ${error.message}`));
server.listen(PORT, HOST, () => {
	child = spawn(driver, args, { stdio: "inherit", env: process.env });
	child.once("error", (error) => fail(`driver failed: ${error.message}`));
	child.once("exit", (code, signal) => {
		for (const socket of connections) socket.destroy();
		server.close(() => {
			if (failed) return;
			if (signal) {
				process.removeAllListeners(signal);
				process.kill(process.pid, signal);
			}
			else process.exit(code ?? 1);
		});
	});
});
