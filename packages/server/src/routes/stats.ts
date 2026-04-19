import type { Stats } from "@cdhorne/claude-autopilot";
import type { Hono } from "hono";

export interface StatsDeps {
	computeStats: () => Stats;
}

export function registerStatsRoutes(app: Hono, deps: StatsDeps): void {
	app.get("/stats", (c) => c.json(deps.computeStats()));
}
