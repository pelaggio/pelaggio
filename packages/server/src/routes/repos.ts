import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { computeStats } from "pelaggio";
import type { Registry } from "../registry.js";
import { RegistryError } from "../registry.js";
import type { RoadmapCache } from "../roadmap-cache.js";
import type { RepoEntry } from "../types.js";

export interface ReposDeps {
	registry: Registry;
	roadmapCache: RoadmapCache;
}

function notFound(c: Context, slug: string): Response {
	return c.json({ error: `unknown repo ${JSON.stringify(slug)}`, code: "not-found" }, 404);
}

export function registerReposRoutes(app: Hono, deps: ReposDeps): void {
	app.get("/repos", (c) => {
		const entries: RepoEntry[] = deps.registry.entries().map((e) => ({
			slug: e.slug,
			path: e.path,
			exists: existsSync(e.path),
		}));
		return c.json({ repos: entries });
	});

	app.get("/repos/:slug/roadmap", async (c) => {
		const slug = c.req.param("slug");
		try {
			const source = deps.roadmapCache.get(slug);
			const items = await source.listOpenItems();
			return c.json({ source: source.name, items });
		} catch (err) {
			if (err instanceof RegistryError) return notFound(c, slug);
			throw err;
		}
	});

	app.get("/repos/:slug/stats", (c) => {
		const slug = c.req.param("slug");
		let repoPath: string;
		try {
			repoPath = deps.registry.path(slug);
		} catch (err) {
			if (err instanceof RegistryError) return notFound(c, slug);
			throw err;
		}
		const logPath = join(repoPath, ".dev", "pelaggio-log.jsonl");
		return c.json(computeStats({ logPath }));
	});
}
