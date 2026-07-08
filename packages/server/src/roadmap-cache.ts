import type { RoadmapSource } from "pelaggio";
import type { Registry } from "./registry.js";

export type RoadmapFactory = (repoPath: string) => RoadmapSource;

export interface RoadmapCacheDeps {
	registry: Registry;
	factory: RoadmapFactory;
}

export class RoadmapCache {
	private readonly registry: Registry;
	private readonly factory: RoadmapFactory;
	private readonly cache = new Map<string, RoadmapSource>();

	constructor(deps: RoadmapCacheDeps) {
		this.registry = deps.registry;
		this.factory = deps.factory;
	}

	get(slug: string): RoadmapSource {
		const repoPath = this.registry.path(slug);
		const cached = this.cache.get(slug);
		if (cached) return cached;
		const source = this.factory(repoPath);
		this.cache.set(slug, source);
		return source;
	}
}
