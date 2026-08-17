import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { CONTAINED_BRIDGE_PATH } from "../contained-execution.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function freePort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

it("forwards loopback HTTP to the Unix broker while preserving child stdio", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "pelaggio-bridge-test-"));
	roots.push(root);
	const socketPath = join(root, "broker.sock");
	const broker = createHttpServer((_request, response) => response.end("broker-ok"));
	try {
		await new Promise<void>((resolve, reject) => broker.listen(socketPath, resolve).once("error", reject));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip("sandbox forbids Unix listeners");
		throw error;
	}
	const port = await freePort();
	const driver = join(root, "driver.mjs");
	await writeFile(
		driver,
		'import http from "node:http";process.stdin.setEncoding("utf8");process.stdin.once("data",d=>process.stdout.write("ACP:"+d.trim()+"\\n"));http.get("http://127.0.0.1:"+process.env.TEST_PORT+"/probe",r=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>process.stdout.write("HTTP:"+b+"\\n"))}).on("error",e=>{process.stderr.write(e.message);process.exit(2)});',
	);
	const child = spawn(process.execPath, [CONTAINED_BRIDGE_PATH, process.execPath, driver], {
		env: { ...process.env, PELAGGIO_EGRESS_SOCKET: socketPath, PELAGGIO_LOOPBACK_PORT: String(port), TEST_PORT: String(port) },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.stdin.end("frame\n");
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	await new Promise<void>((resolve) => broker.close(() => resolve()));
	assert.deepEqual(exit, { code: 0, signal: null }, stderr);
	assert.match(stdout, /^ACP:frame\nHTTP:broker-ok\n$|^HTTP:broker-ok\nACP:frame\n$/);
});

it("fails the driver run when the Unix broker is unavailable", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "pelaggio-bridge-test-"));
	roots.push(root);
	let port: number;
	try {
		port = await freePort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip("sandbox forbids loopback listeners");
		throw error;
	}
	const driver = join(root, "driver.mjs");
	await writeFile(driver, 'import http from "node:http";http.get("http://127.0.0.1:"+process.env.TEST_PORT+"/probe",r=>r.resume()).on("error",()=>{});setInterval(()=>{},1000);');
	const child = spawn(process.execPath, [CONTAINED_BRIDGE_PATH, process.execPath, driver], {
		env: { ...process.env, PELAGGIO_EGRESS_SOCKET: join(root, "missing.sock"), PELAGGIO_LOOPBACK_PORT: String(port), TEST_PORT: String(port) },
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	assert.equal(code, 1);
	assert.match(stderr, /broker unavailable/);
});
