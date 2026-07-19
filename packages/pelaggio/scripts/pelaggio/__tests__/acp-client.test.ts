import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AcpConnection, AcpRpcError } from "../acp-client.js";

// A connection whose outbound frames are captured, and a helper to parse them back to objects.
function makeConn() {
	const sent: string[] = [];
	const diagnostics: string[] = [];
	const conn = new AcpConnection({ send: (line) => sent.push(line), onDiagnostic: (m) => diagnostics.push(m) });
	const sentObjects = (): Array<Record<string, unknown>> => sent.map((l) => JSON.parse(l.trim()));
	return { conn, sent, sentObjects, diagnostics };
}

describe("AcpConnection — request/response", () => {
	it("correlates a response to its request by id and resolves the result", async () => {
		const { conn, sentObjects } = makeConn();
		const p = conn.request("initialize", { protocolVersion: 1 });
		const [frame] = sentObjects();
		assert.equal(frame.method, "initialize");
		assert.equal(frame.jsonrpc, "2.0");
		assert.deepEqual(frame.params, { protocolVersion: 1 });
		conn.receive(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1, ok: true } })}\n`);
		assert.deepEqual(await p, { protocolVersion: 1, ok: true });
	});

	it("assigns monotonically increasing ids", () => {
		const { conn, sentObjects } = makeConn();
		conn.request("a");
		conn.request("b");
		const [a, b] = sentObjects();
		assert.equal(Number(b.id), Number(a.id) + 1);
	});

	it("omits params when none are given", () => {
		const { conn, sentObjects } = makeConn();
		conn.request("ping");
		assert.equal("params" in sentObjects()[0], false);
	});

	it("rejects with an AcpRpcError on a JSON-RPC error response", async () => {
		const { conn, sentObjects } = makeConn();
		const p = conn.request("session/prompt");
		const id = sentObjects()[0].id;
		conn.receive(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "boom", data: { x: 1 } } })}\n`);
		await assert.rejects(p, (err: unknown) => {
			assert.ok(err instanceof AcpRpcError);
			assert.equal(err.code, -32000);
			assert.equal(err.message, "boom");
			assert.deepEqual(err.data, { x: 1 });
			return true;
		});
	});

	it("resolves concurrent requests to the correct promise regardless of response order", async () => {
		const { conn, sentObjects } = makeConn();
		const p1 = conn.request("one");
		const p2 = conn.request("two");
		const [f1, f2] = sentObjects();
		// Respond out of order.
		conn.receive(`${JSON.stringify({ jsonrpc: "2.0", id: f2.id, result: "R2" })}\n`);
		conn.receive(`${JSON.stringify({ jsonrpc: "2.0", id: f1.id, result: "R1" })}\n`);
		assert.equal(await p1, "R1");
		assert.equal(await p2, "R2");
	});
});

describe("AcpConnection — notifications", () => {
	it("routes a method-only message to the notification handler", () => {
		const { conn } = makeConn();
		const seen: Array<{ method: string; params: unknown }> = [];
		conn.onNotification((n) => seen.push(n));
		conn.receive(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionUpdate: "agent_message_chunk" } })}\n`);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].method, "session/update");
		assert.deepEqual(seen[0].params, { sessionUpdate: "agent_message_chunk" });
	});

	it("does not throw when no notification handler is registered", () => {
		const { conn } = makeConn();
		assert.doesNotThrow(() => conn.receive(`${JSON.stringify({ jsonrpc: "2.0", method: "x" })}\n`));
	});
});

describe("AcpConnection — server→client requests", () => {
	it("routes a request-with-id to the request handler and writes back the result", async () => {
		const { conn, sentObjects } = makeConn();
		conn.onRequest(async (req) => {
			assert.equal(req.method, "session/request_permission");
			return { outcome: { outcome: "selected", optionId: "allow" } };
		});
		conn.receive(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { toolCall: {} } })}\n`);
		await new Promise((r) => setTimeout(r, 0));
		const reply = sentObjects().at(-1)!;
		assert.equal(reply.id, 7);
		assert.deepEqual(reply.result, { outcome: { outcome: "selected", optionId: "allow" } });
	});

	it("answers with a method-not-found error when no handler is registered", () => {
		const { conn, sentObjects } = makeConn();
		conn.receive(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "session/request_permission" })}\n`);
		const reply = sentObjects().at(-1)!;
		assert.equal(reply.id, 9);
		assert.equal((reply.error as { code: number }).code, -32601);
	});

	it("converts a thrown handler error into a JSON-RPC error response", async () => {
		const { conn, sentObjects } = makeConn();
		conn.onRequest(() => {
			throw new Error("denied");
		});
		conn.receive(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "whatever" })}\n`);
		await new Promise((r) => setTimeout(r, 0));
		const reply = sentObjects().at(-1)!;
		assert.equal(reply.id, 3);
		assert.equal((reply.error as { message: string }).message, "denied");
	});
});

describe("AcpConnection — framing", () => {
	it("buffers a response split across multiple receive() calls", async () => {
		const { conn, sentObjects } = makeConn();
		const p = conn.request("m");
		const id = sentObjects()[0].id;
		const full = `${JSON.stringify({ jsonrpc: "2.0", id, result: "ok" })}\n`;
		const mid = Math.floor(full.length / 2);
		conn.receive(full.slice(0, mid));
		conn.receive(full.slice(mid));
		assert.equal(await p, "ok");
	});

	it("dispatches multiple messages delivered in a single chunk", () => {
		const { conn } = makeConn();
		const seen: string[] = [];
		conn.onNotification((n) => seen.push(n.method));
		conn.receive(`${JSON.stringify({ jsonrpc: "2.0", method: "a" })}\n${JSON.stringify({ jsonrpc: "2.0", method: "b" })}\n`);
		assert.deepEqual(seen, ["a", "b"]);
	});

	it("skips a malformed line but still processes the valid line after it", () => {
		const { conn, diagnostics } = makeConn();
		const seen: string[] = [];
		conn.onNotification((n) => seen.push(n.method));
		conn.receive(`{not json\n${JSON.stringify({ jsonrpc: "2.0", method: "good" })}\n`);
		assert.deepEqual(seen, ["good"]);
		assert.equal(diagnostics.length, 1);
	});

	it("ignores blank lines", () => {
		const { conn } = makeConn();
		const seen: string[] = [];
		conn.onNotification((n) => seen.push(n.method));
		conn.receive(`\n\n${JSON.stringify({ jsonrpc: "2.0", method: "x" })}\n\n`);
		assert.deepEqual(seen, ["x"]);
	});

	it("ignores a response for an unknown id without throwing", () => {
		const { conn, diagnostics } = makeConn();
		assert.doesNotThrow(() => conn.receive(`${JSON.stringify({ jsonrpc: "2.0", id: 999, result: "orphan" })}\n`));
		assert.equal(diagnostics.length, 1);
	});
});

describe("AcpConnection — lifecycle", () => {
	it("rejects all pending requests when the connection fails", async () => {
		const { conn } = makeConn();
		const p1 = conn.request("a");
		const p2 = conn.request("b");
		conn.fail(new Error("child exited"));
		await assert.rejects(p1, /child exited/);
		await assert.rejects(p2, /child exited/);
		assert.equal(conn.isClosed, true);
	});

	it("rejects a request issued after close", async () => {
		const { conn } = makeConn();
		conn.fail(new Error("gone"));
		await assert.rejects(conn.request("late"), /closed/);
	});

	it("is a no-op to notify() after close", () => {
		const { conn, sent } = makeConn();
		conn.fail(new Error("gone"));
		conn.notify("x");
		assert.equal(sent.length, 0);
	});

	it("fail() is idempotent", () => {
		const { conn } = makeConn();
		conn.fail(new Error("first"));
		assert.doesNotThrow(() => conn.fail(new Error("second")));
	});
});
