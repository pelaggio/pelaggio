import type { RoadmapSource } from "pelaggio";
import type { Registry } from "./registry.js";

export type RoadmapFactory = (repoPath: string) => RoadmapSource;
export type RoadmapList = (slug: string) => Promise<string>;

const DEFAULT_TITLE_TTL_MS = 60_000;

export interface RoadmapCacheDeps {
	registry: Registry;
	factory: RoadmapFactory;
	listRoadmap: RoadmapList;
	/** Test seams for expiry behavior. */
	now?: () => number;
	titleTtlMs?: number;
}

interface TitleSnapshot {
	titles: ReadonlyMap<string, string>;
	refreshAfter: number;
	inFlight?: Promise<void>;
}

function parseTitles(output: string): ReadonlyMap<string, string> {
	const value: unknown = JSON.parse(output);
	if (!Array.isArray(value)) throw new Error("roadmap list returned non-array JSON");
	const titles = new Map<string, string>();
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const { id, title } = item as { id?: unknown; title?: unknown };
		if (typeof id === "string" && typeof title === "string" && title.trim() !== "") {
			titles.set(id, title);
		}
	}
	return titles;
}

export class RoadmapCache {
	private readonly registry: Registry;
	private readonly factory: RoadmapFactory;
	private readonly listRoadmap: RoadmapList;
	private readonly now: () => number;
	private readonly titleTtlMs: number;
	private readonly cache = new Map<string, RoadmapSource>();
	private readonly titleSnapshots = new Map<string, TitleSnapshot>();

	constructor(deps: RoadmapCacheDeps) {
		this.registry = deps.registry;
		this.factory = deps.factory;
		this.listRoadmap = deps.listRoadmap;
		this.now = deps.now ?? Date.now;
		this.titleTtlMs = deps.titleTtlMs ?? DEFAULT_TITLE_TTL_MS;
	}

	get(slug: string): RoadmapSource {
		const repoPath = this.registry.path(slug);
		const cached = this.cache.get(slug);
		if (cached) return cached;
		const source = this.factory(repoPath);
		this.cache.set(slug, source);
		return source;
	}

	/**
	 * Return the current per-repo title snapshot immediately. A stale snapshot is
	 * refreshed in the background, with one in-flight list command per repo.
	 * Title coverage is bounded by RoadmapSource.listItems's window; widening it
	 * is #528. IDs absent from that window intentionally render bare.
	 */
	getTitles(slug: string): ReadonlyMap<string, string> {
		if (!this.registry.has(slug)) return new Map();
		let snapshot = this.titleSnapshots.get(slug);
		if (!snapshot) {
			snapshot = { titles: new Map(), refreshAfter: 0 };
			this.titleSnapshots.set(slug, snapshot);
		}
		if (snapshot.refreshAfter <= this.now() && snapshot.inFlight === undefined) {
			this.refreshTitles(slug, snapshot);
		}
		return snapshot.titles;
	}

	private refreshTitles(slug: string, snapshot: TitleSnapshot): void {
		const refresh = Promise.resolve()
			.then(() => this.listRoadmap(slug))
			.then((output) => {
				snapshot.titles = parseTitles(output);
			})
			.catch(() => {
				// Cosmetic enrichment fails open and retains the last good snapshot.
			})
			.finally(() => {
				snapshot.refreshAfter = this.now() + this.titleTtlMs;
				delete snapshot.inFlight;
			});
		snapshot.inFlight = refresh;
	}
}
