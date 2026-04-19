import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { bearerAuth } from "../src/auth.js";

function makeApp(token: string | undefined): Hono {
	const app = new Hono();
	app.use("*", bearerAuth(token));
	app.get("/x", (c) => c.json({ ok: true }));
	return app;
}

describe("bearerAuth", () => {
	it("undefined token: every request passes (no-op)", async () => {
		const app = makeApp(undefined);
		const res = await app.request("/x");
		assert.equal(res.status, 200);
	});

	it("missing Authorization header: 401", async () => {
		const app = makeApp("secret");
		const res = await app.request("/x");
		assert.equal(res.status, 401);
		const body = (await res.json()) as { code: string };
		assert.equal(body.code, "unauthorized");
	});

	it("wrong token: 401", async () => {
		const app = makeApp("secret");
		const res = await app.request("/x", { headers: { Authorization: "Bearer nope" } });
		assert.equal(res.status, 401);
	});

	it("correct token: 200", async () => {
		const app = makeApp("secret");
		const res = await app.request("/x", { headers: { Authorization: "Bearer secret" } });
		assert.equal(res.status, 200);
	});

	it("token of different length: rejected without timingSafeEqual length crash", async () => {
		const app = makeApp("secret");
		const res = await app.request("/x", { headers: { Authorization: "Bearer hi" } });
		assert.equal(res.status, 401);
	});

	it("non-Bearer scheme: 401", async () => {
		const app = makeApp("secret");
		const res = await app.request("/x", { headers: { Authorization: "Basic abc" } });
		assert.equal(res.status, 401);
	});
});
