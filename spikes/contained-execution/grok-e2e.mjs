// Full contained end-to-end: subscription grok, inside a --network=none container, making a REAL
// model call through the host gateway. Proves the subscription-CLI leg with no API key.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const S = path.dirname(new URL(import.meta.url).pathname);
const SOCK = "/tmp/pel-grok.sock";

async function main() {
	const { spawnAcpAgent } = await import("/home/chris/workspace/claude-autopilot/packages/pelaggio/scripts/pelaggio/acp-client.ts");
	try {
		fs.unlinkSync(SOCK);
	} catch {}
	try {
		fs.unlinkSync(`${SOCK}.log`);
	} catch {}

	const broker = spawn("node", [path.join(S, "grok-broker.mjs")], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, GROK_BROKER_SOCK: SOCK } });
	for (let i = 0; i < 50 && !fs.existsSync(SOCK); i++) spawnSync("sleep", ["0.1"]);
	if (!fs.existsSync(SOCK)) throw new Error("broker socket never appeared");
	fs.chmodSync(SOCK, 0o777);

	const inner = "socat TCP-LISTEN:8080,fork,reuseaddr UNIX-CONNECT:/run/broker.sock 2>/dev/null & sleep 0.6; exec grok agent --cli-chat-proxy-base-url http://127.0.0.1:8080 stdio";
	const args = ["run", "--rm", "-i", "--network=none", "-v", "grok-auth:/root/.grok", "-v", `${SOCK}:/run/broker.sock`, "localhost/pelaggio-grok", "sh", "-c", inner];

	const { conn, done, kill } = spawnAcpAgent({ bin: "podman", args, cwd: "/tmp", timeoutMs: 90_000, onDiagnostic: () => {} });
	conn.onRequest(() => ({ outcome: { outcome: "selected", optionId: "allow" } }));
	let answer = "";
	conn.onNotification((n) => {
		if (n.method !== "session/update") return;
		const u = n.params?.update;
		if (u?.sessionUpdate === "agent_message_chunk") answer += u.content?.text ?? "";
	});

	let stopReason;
	try {
		const init = await conn.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
		console.log("initialize ok — agentVersion:", init?._meta?.agentVersion);
		const sess = await conn.request("session/new", { cwd: "/work", mcpServers: [] });
		console.log("session/new ok — sessionId:", sess?.sessionId);
		const res = await conn.request("session/prompt", { sessionId: sess.sessionId, prompt: [{ type: "text", text: "Reply with exactly the word PONG and nothing else. Do not use any tools." }] });
		stopReason = res?.stopReason;
	} catch (e) {
		console.log("drive error:", String(e).slice(0, 200));
	}
	kill();
	const exit = await done;
	broker.kill("SIGTERM");
	spawnSync("sleep", ["0.3"]);

	console.log("--- RESULT ---");
	console.log("stopReason:", stopReason);
	console.log("answer:", JSON.stringify(answer.trim()));
	console.log("container stderr (tail):", (exit.stderr || "").split("\n").slice(-4).join(" | ").slice(0, 300));
	console.log("=== gateway decisions ===");
	try {
		console.log(fs.readFileSync(`${SOCK}.log`, "utf-8"));
	} catch {
		console.log("(no gateway log)");
	}
	const pass = /PONG/.test(answer) && stopReason === "end_turn";
	console.log("VERDICT:", pass ? "PASS ✓ — real subscription grok call through the contained gateway" : "CHECK ✗");
	process.exit(pass ? 0 : 1);
}
main().catch((e) => {
	console.error("FAILED", e);
	process.exit(1);
});
