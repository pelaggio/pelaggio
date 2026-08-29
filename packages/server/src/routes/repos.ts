import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { computeStats, loadConfig } from "pelaggio";
import type { Registry } from "../registry.js";
import { RegistryError } from "../registry.js";
import type { RoadmapCache } from "../roadmap-cache.js";
import type { RepoEntry, StatsResponse } from "../types.js";

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
		const stats = computeStats({ logPath });
		const titles = deps.roadmapCache.getTitles(slug);
		const response: StatsResponse = {
			...stats,
			itemsDelivered: stats.itemsDelivered.map((item) => {
				const itemTitle = titles.get(item.id);
				return { ...item, ...(itemTitle !== undefined ? { itemTitle } : {}) };
			}),
			recentFailures: stats.recentFailures.map((failure) => {
				const itemTitle = failure.item === null ? undefined : titles.get(failure.item);
				return { ...failure, ...(itemTitle !== undefined ? { itemTitle } : {}) };
			}),
		};
		return c.json(response);
	});

	/** Narrow config projection for StartForm prefill (issue #83). No full ResolvedConfig. */
	app.get("/repos/:slug/config", (c) => {
		const slug = c.req.param("slug");
		let repoPath: string;
		try {
			repoPath = deps.registry.path(slug);
		} catch (err) {
			if (err instanceof RegistryError) return notFound(c, slug);
			throw err;
		}
		try {
			const cfg = loadConfig({ repo: repoPath });
			return c.json({
				watchDailyBudget: cfg.watch.dailyBudget ?? null,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return c.json({ error: message, code: "config-error" }, 500);
		}
	});
}
