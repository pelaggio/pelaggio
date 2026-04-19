import type { RoadmapSource } from "@cdhorne/claude-autopilot";
import type { Hono } from "hono";

export interface RoadmapDeps {
	roadmap: RoadmapSource;
}

export function registerRoadmapRoutes(app: Hono, deps: RoadmapDeps): void {
	app.get("/roadmap", async (c) => {
		const items = await deps.roadmap.listOpenItems();
		return c.json({ source: deps.roadmap.name, items });
	});
}
