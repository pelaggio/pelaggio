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
	token: string | undefined;
	webDist: string | undefined;
}

export function createApp(deps: AppDeps): Hono {
	const app = new Hono();

	// Health bypasses auth.
	registerHealthRoutes(app);

	const guarded = new Hono();
	guarded.use("*", bearerAuth(deps.token));
	registerRunRoutes(guarded, deps.supervisor);
	registerReposRoutes(guarded, { registry: deps.registry, roadmapCache: deps.roadmapCache });
	app.route("/", guarded);

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

	return app;
}
