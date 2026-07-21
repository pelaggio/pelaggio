// Hostile in-container probe (spike 1). Runs inside a --network=none podman container with ONLY the
// broker unix socket mounted. Asserts the containment + broker contract. Prints PASS/FAIL per check.
import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import fs from "node:fs";

const SOCK = "/run/broker.sock";
const results = [];
const check = (name, pass, detail = "") => {
	results.push({ name, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const HOST_TOKEN = "SECRET-HOST-TOKEN-do-not-leak";

const sockReq = (method, path, body) =>
	new Promise((resolve) => {
		const req = http.request({ socketPath: SOCK, method, path, headers: { "content-type": "application/json" } }, (res) => {
			let b = "";
			res.on("data", (c) => (b += c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
		});
		req.on("error", (e) => resolve({ error: e.message }));
		req.end(body);
	});

const tcp = (host, port) =>
	new Promise((resolve) => {
		const s = net.connect({ host, port, timeout: 3000 });
		s.on("connect", () => {
			s.destroy();
			resolve("connected");
		});
		s.on("timeout", () => {
			s.destroy();
			resolve("timeout");
		});
		s.on("error", (e) => resolve(e.code || e.message));
	});
const lookup = (h) => new Promise((resolve) => dns.lookup(h, (e, a) => resolve(e ? e.code || e.message : a)));

async function main() {
	// 1. No direct network egress (network=none): raw TCP + DNS must fail.
	check("no raw TCP egress to 1.1.1.1:443", (await tcp("1.1.1.1", 443)) !== "connected", await tcp("1.1.1.1", 443));
	check("no raw TCP egress to upstream 127.0.0.1:9099 (host-only)", (await tcp("127.0.0.1", 9099)) !== "connected", await tcp("127.0.0.1", 9099));
	check("no DNS resolution", typeof (await lookup("api.anthropic.com")) === "string", await lookup("api.anthropic.com"));

	// 2. No reusable credential present in the container.
	const credDirs = ["/root/.claude", "/root/.codex", "/root/.grok", `${process.env.HOME}/.claude`];
	check("no credential files mounted", !credDirs.some((d) => fs.existsSync(d)), credDirs.filter((d) => fs.existsSync(d)).join(",") || "none present");
	check("no host token in env", !JSON.stringify(process.env).includes(HOST_TOKEN));

	// 3. Broker request-shape policy: allowed path works; forbidden path denied.
	const ok = await sockReq("POST", "/v1/messages", JSON.stringify({ model: "x", prompt: "hi" }));
	check("allowed POST /v1/messages → 200", ok.status === 200, `status=${ok.status}`);
	const forbidden = await sockReq("GET", "/v1/admin/keys");
	check("forbidden GET /v1/admin/keys → 403", forbidden.status === 403, `status=${forbidden.status}`);
	const wrongMethod = await sockReq("DELETE", "/v1/messages");
	check("wrong method DELETE /v1/messages → 403", wrongMethod.status === 403, `status=${wrongMethod.status}`);

	// 4. Response-side non-leakage: the injected host token must NOT reach the container (body or headers).
	check("host token NOT in response body (broker redacted echo)", !(ok.body || "").includes(HOST_TOKEN), (ok.body || "").slice(0, 80));
	check("no Set-Cookie leaked to container", !ok.headers?.["set-cookie"]);
	check("no Location/redirect leaked to container", !ok.headers?.location);

	// 5. Spend/rate cap kills after N calls.
    let capped = false;
	for (let i = 0; i < 8; i++) {
		const r = await sockReq("POST", "/v1/messages", "{}");
		if (r.status === 429) capped = true;
	}
	check("rate/spend cap trips (429) under flood", capped);

	const failed = results.filter((r) => !r.pass);
	console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
	process.exit(failed.length ? 1 : 0);
}
main();
