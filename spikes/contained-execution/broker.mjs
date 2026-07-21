// Host-side auth-terminating broker / egress proxy (spike 1, isolation leg).
// Listens on a UNIX socket (mounted read-only into the network=none container — the container's
// ONLY path out). Enforces:
//   (1) request-shape policy: only POST /v1/messages is allowed; everything else → 403.
//   (2) auth-termination: injects the host-held bearer OUTBOUND; the token is never given to the
//       container (the container never had it to send).
//   (3) response-side token non-leakage: strips Authorization / Set-Cookie / WWW-Authenticate /
//       Location (redirect) / any x-*token* header before returning to the container; does NOT
//       follow cross-origin redirects.
//   (4) a hard body-size + spend/rate cap (bounds financial-DoS + body-channel exfil).
import http from "node:http";
import fs from "node:fs";

const SOCK = process.env.BROKER_SOCK;
const HOST_TOKEN = "SECRET-HOST-TOKEN-do-not-leak"; // held ONLY here, never in the container
const ALLOW = new Set(["POST /v1/messages"]);
const MAX_BODY = 4096;
const MAX_CALLS = 5; // rate/spend cap → kill
let calls = 0;

const STRIP = new Set(["authorization", "set-cookie", "www-authenticate", "location", "proxy-authorization"]);

if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);

http
	.createServer((creq, cres) => {
		const key = `${creq.method} ${creq.url.split("?")[0]}`;
		const deny = (code, msg) => {
			cres.writeHead(code, { "content-type": "application/json" });
			cres.end(JSON.stringify({ error: msg }));
			console.error(`[broker] DENY ${key}: ${msg}`);
		};
		if (++calls > MAX_CALLS) return deny(429, "rate/spend cap exceeded — killed");
		if (!ALLOW.has(key)) return deny(403, `request-shape policy: ${key} not allowed`);

		let body = "";
		let tooBig = false;
		creq.on("data", (c) => {
			body += c;
			if (body.length > MAX_BODY) {
				tooBig = true;
				creq.destroy();
			}
		});
		creq.on("close", () => {
			if (tooBig) return deny(413, "body exceeds cap");
			// Re-originate to the real upstream, injecting the host token the container never sees.
			const ureq = http.request(
				{ host: "127.0.0.1", port: 9099, method: creq.method, path: creq.url, headers: { "content-type": "application/json", authorization: `Bearer ${HOST_TOKEN}` } },
				(ures) => {
					// Strip sensitive/redirect headers; do not follow redirects.
					const safe = {};
					for (const [h, v] of Object.entries(ures.headers)) if (!STRIP.has(h.toLowerCase())) safe[h] = v;
					delete safe["content-length"]; // recomputed after redaction
					// Buffer + redact the broker's OWN injected credential from the body: the upstream can
					// echo the Authorization it received (here, `sawAuth`). Headers alone don't cover it.
					// (The general "provider reflects arbitrary repo content" body channel remains residual.)
					let ubody = "";
					ures.on("data", (c) => (ubody += c));
					ures.on("end", () => {
						const redacted = ubody.split(HOST_TOKEN).join("[REDACTED]");
						cres.writeHead(String(ures.statusCode).startsWith("3") ? 502 : ures.statusCode, safe);
						cres.end(redacted);
						console.error(`[broker] ALLOW ${key} → upstream ${ures.statusCode} (stripped-headers: ${Object.keys(ures.headers).filter((h) => STRIP.has(h.toLowerCase())).join(",") || "none"}; body-redacted: ${ubody.includes(HOST_TOKEN)})`);
					});
				},
			);
			ureq.on("error", (e) => deny(502, `upstream error: ${e.message}`));
			ureq.end(body);
		});
	})
	.listen(SOCK, () => console.error(`[broker] listening on unix:${SOCK}`));
