// Host-side grok re-originating gateway (spike 1, subscription-CLI leg). Listens on a UNIX socket
// (the container's ONLY egress). grok — inside a --network=none container, pointed here via
// --cli-chat-proxy-base-url — sends its subscription-authed requests; the gateway enforces a
// PATH ALLOWLIST + a /responses spend cap, then forwards to the REAL cli-chat-proxy.grok.com,
// preserving grok's own headers (grok holds its token; the gateway never injects one). It is the
// sole network path out, so the token can reach nothing but the real provider.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";

const SOCK = process.env.GROK_BROKER_SOCK || "/tmp/pel-grok.sock";
const UPSTREAM = "cli-chat-proxy.grok.com";
// Bootstrap GETs grok makes on startup + the model call. Everything else (account/billing/etc.) denied.
const ALLOW = new Set(["GET /models", "GET /settings", "GET /mcp/configs", "GET /bundle/archive", "GET /feedback/config", "POST /responses", "POST /responses/cancel"]);
const MAX_RESPONSES = 8;
let responses = 0;
const log = [];

if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);

http
	.createServer((creq, cres) => {
		const path = creq.url.split("?")[0];
		const key = `${creq.method} ${path}`;
		const deny = (code, msg) => {
			cres.writeHead(code, { "content-type": "application/json" });
			cres.end(JSON.stringify({ error: msg }));
			log.push(`DENY ${key} — ${msg}`);
		};
		if (!ALLOW.has(key)) return deny(403, "path not on gateway allowlist");
		if (key === "POST /responses" && ++responses > MAX_RESPONSES) return deny(429, "responses spend cap");

		// Forward to the real provider, preserving grok's headers (its own subscription auth).
		const headers = { ...creq.headers, host: UPSTREAM };
		// grok's real default base is https://cli-chat-proxy.grok.com/v1; the override drops the /v1
		// prefix, so re-add it when forwarding to the real provider.
		const ureq = https.request({ host: UPSTREAM, port: 443, method: creq.method, path: `/v1${creq.url}`, headers }, (ures) => {
			cres.writeHead(ures.statusCode, ures.headers);
			ures.pipe(cres); // stream (─ /responses is SSE)
			log.push(`ALLOW ${key} → ${ures.statusCode}`);
		});
		ureq.on("error", (e) => deny(502, `upstream: ${e.message}`));
		creq.pipe(ureq);
	})
	.listen(SOCK, () => console.error(`[grok-broker] unix:${SOCK} → https://${UPSTREAM}`));

// Dump the decision log on exit so the run can assert the policy fired.
const dump = () => {
	fs.writeFileSync(`${SOCK}.log`, log.join("\n") + "\n");
	process.exit(0);
};
process.on("SIGTERM", dump);
process.on("SIGINT", dump);
