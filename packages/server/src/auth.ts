import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export function bearerAuth(token: string): MiddlewareHandler {
	if (token.trim() === "") {
		throw new Error("bearer token must not be empty");
	}
	const expected = Buffer.from(token, "utf-8");
	return async (c, next) => {
		const header = c.req.header("Authorization") ?? "";
		const match = header.match(/^Bearer\s+(.+)$/);
		if (!match) {
			return c.json({ error: "missing bearer token", code: "unauthorized" }, 401);
		}
		const provided = Buffer.from(match[1].trim(), "utf-8");
		// timingSafeEqual requires equal-length buffers; bail on mismatch first.
		if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
			return c.json({ error: "invalid bearer token", code: "unauthorized" }, 401);
		}
		await next();
	};
}
