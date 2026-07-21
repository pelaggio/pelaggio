// Drive `grok agent stdio --cli-chat-proxy-base-url http://127.0.0.1:9110` via the ACP client, so
// the capture server sees EXACTLY what grok sends to its "provider" with subscription auth: does it
// accept an http base URL, what path/method, and what auth header. Prompt will fail (stub upstream)
// — we only need the captured outbound request.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

async function main() {
	const { spawnAcpAgent } = await import("/home/chris/workspace/claude-autopilot/packages/pelaggio/scripts/pelaggio/acp-client.ts");
	const bin = join(homedir(), ".grok/bin/grok");
	const { conn, done, kill } = spawnAcpAgent({
		bin,
		args: ["agent", "--cli-chat-proxy-base-url", "http://127.0.0.1:9110", "stdio"],
		cwd: "/tmp",
		timeoutMs: 40000,
		onDiagnostic: () => {},
	});
	conn.onRequest(() => ({ outcome: { outcome: "selected", optionId: "allow" } }));
	let sawText = "";
	conn.onNotification((n) => {
		if (n.method === "session/update") {
			const u = n.params?.update;
			if (u?.sessionUpdate === "agent_message_chunk") sawText += u.content?.text ?? "";
		}
	});
	try {
		await conn.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
		const sess = await conn.request("session/new", { cwd: "/tmp", mcpServers: [] });
		const res = await conn.request("session/prompt", { sessionId: sess.sessionId, prompt: [{ type: "text", text: "say hi" }] });
		console.log("prompt stopReason:", res?.stopReason);
	} catch (e) {
		console.log("prompt errored (expected against stub):", String(e).slice(0, 120));
	}
	console.log("agent_message text:", JSON.stringify(sawText).slice(0, 120));
	kill();
	await done;
}
main().then(
	() => process.exit(0),
	(e) => {
		console.error("FAILED", e);
		process.exit(1);
	},
);
