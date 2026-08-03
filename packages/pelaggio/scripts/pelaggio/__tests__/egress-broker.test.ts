import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type EgressBrokerHandle, type EgressPolicy, type OutboundResponse, startEgressBroker, validateEgressPolicy } from "../egress-broker.js";
import { resolveEgressPolicy } from "../egress-policies.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function exchange(socketPath: string, path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> {
	return new Promise((resolve, reject) => {
		const outbound = request({ socketPath, method: "POST", path, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...headers } }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString() }));
		});
		outbound.once("error", reject);
		outbound.end(body);
	});
}

describe("egress broker", () => {
	it("rejects unsafe policies and unknown model selections", () => {
		const policy = resolveEgressPolicy("codex", "gpt-5.2-codex");
		assert.throws(() => validateEgressPolicy({ ...policy, upstreamOrigin: "http://api.openai.com" }), /HTTPS origin/);
		assert.throws(() => validateEgressPolicy({ ...policy, routes: [...policy.routes, policy.routes[0] as never] }), /duplicate/);
		assert.throws(() => resolveEgressPolicy("codex", "unpriced"), /unsupported egress model/);
	});

	it("enforces exact routes, key replacement, response filtering, and redacted decisions", async (context) => {
		const root = await mkdtemp(join(tmpdir(), "egress-test-"));
		roots.push(root);
		const socketPath = join(root, "broker.sock");
		let captured: import("node:http").RequestOptions | undefined;
		const upstream = async (options: import("node:http").RequestOptions): Promise<OutboundResponse> => {
			captured = options;
			return { status: 200, headers: { "content-type": "application/json", authorization: "leak", "set-cookie": ["leak"], connection: "close" }, body: Buffer.from('{"usage":{"input_tokens":1,"output_tokens":1}}') };
		};
		let handle: EgressBrokerHandle;
		try {
			handle = await startEgressBroker({ socketPath, policy: resolveEgressPolicy("codex", "gpt-5.2-codex"), auth: { kind: "key", env: "TEST_KEY", header: "authorization", scheme: "Bearer" }, key: "secret-canary" }, { request: upstream });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip("sandbox forbids Unix listeners");
			throw error;
		}
		const body = '{"model":"gpt-5.2-codex","max_output_tokens":8,"stream":false}';
		const allowed = await exchange(socketPath, "/v1/responses?benign=secret-query", body, { authorization: "Bearer client-leak" });
		assert.equal(allowed.status, 200);
		assert.equal(allowed.headers.authorization, undefined);
		assert.equal(allowed.headers["set-cookie"], undefined);
		assert.equal((captured?.headers as Record<string, string> | undefined)?.authorization, "Bearer secret-canary");
		assert.equal((await exchange(socketPath, "/v1/other", body)).status, 400);
		const serialized = JSON.stringify(handle.decisions);
		for (const secret of ["secret-canary", "client-leak", "secret-query", "api.openai.com", body]) assert.equal(serialized.includes(secret), false);
		await handle.close();
		await assert.rejects(readFile(socketPath), /ENOENT/);
	});

	it("forwards transparent authorization and seals on an accounting failure", async (context) => {
		const root = await mkdtemp(join(tmpdir(), "egress-test-"));
		roots.push(root);
		const socketPath = join(root, "broker.sock");
		let authorization: unknown;
		let handle: EgressBrokerHandle;
		try {
			handle = await startEgressBroker(
				{ socketPath, policy: resolveEgressPolicy("codex", "gpt-5.2-codex"), auth: { kind: "transparent" } },
				{
					request: async (options) => {
						authorization = (options.headers as Record<string, string>).authorization;
						return { status: 200, headers: {}, body: Buffer.from("{}") };
					},
				},
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip("sandbox forbids Unix listeners");
			throw error;
		}
		const response = await exchange(socketPath, "/v1/responses", '{"model":"gpt-5.2-codex","max_output_tokens":8}', { authorization: "Bearer subscription" });
		assert.equal(response.status, 502);
		assert.equal(authorization, "Bearer subscription");
		assert.match((await handle.fatal).message, /accounting/);
		assert.equal((await exchange(socketPath, "/v1/responses", "{}")).status, 503);
		await handle.close();
	});

	it("soft-throttles rate-limit breaches with Retry-After and recovers once the caller backs off", async (context) => {
		const root = await mkdtemp(join(tmpdir(), "egress-test-"));
		roots.push(root);
		const socketPath = join(root, "broker.sock");
		let clock = 0;
		const basePolicy = resolveEgressPolicy("codex", "gpt-5.2-codex");
		const policy: EgressPolicy = { ...basePolicy, limits: { ...basePolicy.limits, requestsPerWindow: 1, windowMs: 1000, rateLimitRetryBudget: 5 } };
		let handle: EgressBrokerHandle;
		try {
			handle = await startEgressBroker({ socketPath, policy, auth: { kind: "transparent" } }, { request: async () => ({ status: 200, headers: {}, body: Buffer.from('{"usage":{"input_tokens":1,"output_tokens":1}}') }), now: () => clock });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip("sandbox forbids Unix listeners");
			throw error;
		}
		const body = '{"model":"gpt-5.2-codex","max_output_tokens":8,"stream":false}';
		const headers = { authorization: "Bearer x" };
		const first = await exchange(socketPath, "/v1/responses", body, headers);
		assert.equal(first.status, 200);
		const throttled = await exchange(socketPath, "/v1/responses", body, headers);
		assert.equal(throttled.status, 429);
		assert.equal(throttled.headers["retry-after"], "1");
		assert.equal(
			handle.decisions.some((decision) => decision.outcome === "fatal"),
			false,
		);
		clock = 1000;
		const recovered = await exchange(socketPath, "/v1/responses", body, headers);
		assert.equal(recovered.status, 200);
		assert.equal(
			handle.decisions.some((decision) => decision.outcome === "fatal"),
			false,
		);
		await handle.close();
	});

	it("seals the broker once a client ignores backoff past the rate-limit retry budget", async (context) => {
		const root = await mkdtemp(join(tmpdir(), "egress-test-"));
		roots.push(root);
		const socketPath = join(root, "broker.sock");
		const basePolicy = resolveEgressPolicy("codex", "gpt-5.2-codex");
		const policy: EgressPolicy = { ...basePolicy, limits: { ...basePolicy.limits, requestsPerWindow: 1, windowMs: 1000, rateLimitRetryBudget: 1 } };
		let handle: EgressBrokerHandle;
		try {
			handle = await startEgressBroker({ socketPath, policy, auth: { kind: "transparent" } }, { request: async () => ({ status: 200, headers: {}, body: Buffer.from('{"usage":{"input_tokens":1,"output_tokens":1}}') }), now: () => 0 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip("sandbox forbids Unix listeners");
			throw error;
		}
		const body = '{"model":"gpt-5.2-codex","max_output_tokens":8,"stream":false}';
		const headers = { authorization: "Bearer x" };
		assert.equal((await exchange(socketPath, "/v1/responses", body, headers)).status, 200);
		assert.equal((await exchange(socketPath, "/v1/responses", body, headers)).status, 429);
		assert.equal((await exchange(socketPath, "/v1/responses", body, headers)).status, 429);
		assert.match((await handle.fatal).message, /retry budget/);
		assert.equal((await exchange(socketPath, "/v1/responses", body, headers)).status, 503);
		await handle.close();
	});

	it("recomputes content-length from the body instead of trusting the upstream header", async (context) => {
		const root = await mkdtemp(join(tmpdir(), "egress-test-"));
		roots.push(root);
		const socketPath = join(root, "broker.sock");
		let handle: EgressBrokerHandle;
		try {
			handle = await startEgressBroker(
				{ socketPath, policy: resolveEgressPolicy("codex", "gpt-5.2-codex"), auth: { kind: "transparent" } },
				{ request: async () => ({ status: 200, headers: { "content-type": "application/json", "content-length": "999999" }, body: Buffer.from('{"usage":{"input_tokens":1,"output_tokens":1}}') }) },
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip("sandbox forbids Unix listeners");
			throw error;
		}
		const body = '{"model":"gpt-5.2-codex","max_output_tokens":8,"stream":false}';
		const response = await exchange(socketPath, "/v1/responses", body, { authorization: "Bearer x" });
		assert.equal(response.status, 200);
		assert.equal(response.headers["content-length"], String(Buffer.byteLength(response.body)));
		await handle.close();
	});

	it("pins the complete built-in request shape", async () => {
		const fixture = JSON.parse(await readFile(new URL("./fixtures/egress/codex-v1.json", import.meta.url), "utf8"));
		const policy: EgressPolicy = resolveEgressPolicy("codex", "gpt-5.2-codex");
		assert.deepEqual(
			policy.routes.map((route) => ({
				policy: policy.id,
				method: route.method,
				path: route.path,
				models: route.models,
				modelField: route.modelField,
				maxOutputTokensField: route.maxOutputTokensField,
				inputUsageField: route.inputUsageField,
				outputUsageField: route.outputUsageField,
				authHeader: "authorization",
				authScheme: "Bearer",
				streaming: false,
			})),
			fixture,
		);
	});
});
