// Capture server: stands in for cli-chat-proxy.grok.com to see EXACTLY what grok sends when pointed
// at a custom base URL with its subscription auth — path, method, and auth header shape (redacted).
import http from "node:http";
const PORT = 9110;
http
	.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const auth = req.headers.authorization || req.headers["x-api-key"] || "(none)";
			const authShape = auth === "(none)" ? "(none)" : `${auth.split(" ")[0]} <${auth.replace(/\s/g, "").length} chars>`;
			console.error(`[capture] ${req.method} ${req.url} host=${req.headers.host} auth=${authShape} bodyLen=${body.length}`);
			console.error(`[capture] header keys: ${Object.keys(req.headers).join(",")}`);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, note: "capture stub" }));
		});
	})
	.listen(PORT, "127.0.0.1", () => console.error(`[capture] listening on http://127.0.0.1:${PORT}`));
