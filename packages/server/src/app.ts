import { readFileSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { bearerAuth } from "./auth.js";
import type { Registry } from "./registry.js";
import type { RoadmapCache } from "./roadmap-cache.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerReposRoutes } from "./routes/repos.js";
import { registerRunRoutes } from "./routes/runs.js";
import type { Supervisor } from "./supervisor.js";

export interface AppDeps {
	supervisor: Supervisor;
	registry: Registry;
	roadmapCache: RoadmapCache;
	token: string;
	webDist: string | undefined;
	trustManifestPath?: string;
}

export function createApp(deps: AppDeps): Hono {
	const app = new Hono();
	const authenticate = bearerAuth(deps.token);

	// Health bypasses auth.
	registerHealthRoutes(app);
	app.get("/.well-known/pelaggio.trust.json", (c) => {
		if (deps.trustManifestPath === undefined) {
			return c.json({ code: "not-found", error: "trust manifest is not configured" }, 404);
		}
		try {
			const body = readFileSync(deps.trustManifestPath, "utf8");
			return c.body(body, 200, { "content-type": "application/json; charset=utf-8" });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
			return c.json({ code: code === 404 ? "not-found" : "read-error", error: "trust manifest is unavailable" }, code);
		}
	});

	// The static shell must load before the operator can enter a bearer token.
	// It carries no authority; every API route remains in guarded route families.
	if (deps.webDist !== undefined) {
		const root = deps.webDist;
		const protectShell = secureHeaders({
			contentSecurityPolicy: {
				defaultSrc: ["'self'"],
				baseUri: ["'none'"],
				connectSrc: ["'self'"],
				fontSrc: ["'self'"],
				formAction: ["'self'"],
				frameAncestors: ["'none'"],
				imgSrc: ["'self'", "data:"],
				manifestSrc: ["'self'"],
				objectSrc: ["'none'"],
				// Astro emits its island bootstrap and styles inline in the static shell.
				scriptSrc: ["'self'", "'unsafe-inline'"],
				styleSrc: ["'self'", "'unsafe-inline'"],
			},
			xFrameOptions: "DENY",
		});
		app.use("/", protectShell);
		app.use("/ui/*", protectShell);
		app.get("/", (c) => c.redirect("/ui/", 302));
		app.get(
			"/ui/*",
			serveStatic({
				root,
				rewriteRequestPath: (p) => p.replace(/^\/ui/, "") || "/",
			}),
		);
	}

	// Scope auth to the authority-bearing route families. A global guarded
	// sub-app turns every unknown URL into a misleading 401 before Hono can
	// produce its 404 fallback.
	app.use("/runs", authenticate);
	app.use("/runs/*", authenticate);
	app.use("/repos", authenticate);
	app.use("/repos/*", authenticate);
	registerRunRoutes(app, { supervisor: deps.supervisor, registry: deps.registry, roadmapCache: deps.roadmapCache });
	registerReposRoutes(app, { registry: deps.registry, roadmapCache: deps.roadmapCache });

	return app;
}
