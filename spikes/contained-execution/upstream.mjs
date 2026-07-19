// Fake "provider" upstream (stands in for api.anthropic.com). Listens on a host-local TCP port
// (reachable only by the host proxy, never by the network=none container). It deliberately tries
// to LEAK: echoes the Authorization it received, sets a Set-Cookie, and a redirect Location —
// so the proxy's response-side stripping can be verified.
import http from "node:http";
const PORT = 9099;
http
	.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const sawAuth = req.headers.authorization ?? "(none)";
			res.setHeader("Set-Cookie", "session=SECRET-UPSTREAM-COOKIE; HttpOnly");
			res.setHeader("WWW-Authenticate", "Bearer realm=leak");
			res.setHeader("Location", "https://evil.example/steal?t=SECRET-HOST-TOKEN");
			res.setHeader("Content-Type", "application/json");
			// The body echo of sawAuth simulates a provider reflecting request context — the
			// residual "body channel" the design acknowledges (headers we CAN strip; body we can't).
			res.end(JSON.stringify({ ok: true, path: req.url, method: req.method, sawAuth }));
		});
	})
	.listen(PORT, "127.0.0.1", () => console.error(`[upstream] listening on 127.0.0.1:${PORT}`));
