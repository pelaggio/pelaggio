import { readFileSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
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
	// It carries no authority; every API route remains in the guarded sub-app.
	if (deps.webDist !== undefined) {
		const root = deps.webDist;
		app.get("/", (c) => c.redirect("/ui/", 302));
		app.get(
			"/ui/*",
			serveStatic({
				root,
				rewriteRequestPath: (p) => p.replace(/^\/ui/, "") || "/",
			}),
		);
	}

	const guarded = new Hono();
	guarded.use("*", bearerAuth(deps.token));
	registerRunRoutes(guarded, { supervisor: deps.supervisor, registry: deps.registry, roadmapCache: deps.roadmapCache });
	registerReposRoutes(guarded, { registry: deps.registry, roadmapCache: deps.roadmapCache });
	app.route("/", guarded);

	return app;
}
