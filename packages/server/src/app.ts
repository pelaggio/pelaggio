import type { RoadmapSource, Stats } from "@cdhorne/claude-autopilot";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bearerAuth } from "./auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerRoadmapRoutes } from "./routes/roadmap.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerStatsRoutes } from "./routes/stats.js";
import type { Supervisor } from "./supervisor.js";

export interface AppDeps {
	supervisor: Supervisor;
	roadmap: RoadmapSource;
	computeStats: () => Stats;
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
	registerStatsRoutes(guarded, { computeStats: deps.computeStats });
	registerRoadmapRoutes(guarded, { roadmap: deps.roadmap });
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
