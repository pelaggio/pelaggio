import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { listExternalRuns } from "../external-runs.js";
import type { Registry } from "../registry.js";
import type { RoadmapCache } from "../roadmap-cache.js";
import type { Supervisor } from "../supervisor.js";
import { SupervisorError } from "../supervisor.js";
import type { ContinuousMode, PersistedRun, RunSummary, ShipTargetName } from "../types.js";

const SHIP_TARGETS: readonly ShipTargetName[] = ["direct-push", "pull-request", "auto-merge-pr"];
const CONTINUOUS_MODES: readonly ContinuousMode[] = ["drain", "watch"];

interface StartBody {
	repo?: unknown;
	item?: unknown;
	parallel?: unknown;
	cycles?: unknown;
	shipTarget?: unknown;
	mode?: unknown;
	watchDailyBudget?: unknown;
	verbose?: unknown;
}

function badRequest(c: Context, message: string): Response {
	return c.json({ error: message, code: "bad-request" }, 400);
}

function summarize(run: PersistedRun): RunSummary {
	return {
		id: run.id,
		repo: run.repo,
		...(run.item !== undefined ? { item: run.item } : {}),
		status: run.status,
		startedAt: run.startedAt,
		...(run.endedAt ? { endedAt: run.endedAt } : {}),
		...(run.mode ? { mode: run.mode } : {}),
		...(run.activity ? { activity: run.activity } : {}),
		source: "supervised",
	};
}

export interface RunRoutesDeps {
	supervisor: Supervisor;
	registry: Registry;
	roadmapCache: RoadmapCache;
}

export function registerRunRoutes(app: Hono, deps: RunRoutesDeps): void {
	const { supervisor, registry, roadmapCache } = deps;
	app.post("/runs", async (c) => {
		let body: StartBody;
		try {
			body = (await c.req.json()) as StartBody;
		} catch {
			return badRequest(c, "request body must be JSON");
		}
		if (typeof body.repo !== "string" || body.repo.trim() === "") {
			return badRequest(c, "field `repo` is required (string)");
		}

		let mode: ContinuousMode | undefined;
		if (body.mode !== undefined) {
			if (typeof body.mode !== "string" || !CONTINUOUS_MODES.includes(body.mode as ContinuousMode)) {
				return badRequest(c, `\`mode\` must be one of ${CONTINUOUS_MODES.join(", ")}`);
			}
			mode = body.mode as ContinuousMode;
		}

		if (mode) {
			if (body.item !== undefined && body.item !== null && body.item !== "") {
				return badRequest(c, "continuous mode forbids `item` (omit for auto-pick)");
			}
		} else {
			if (typeof body.item !== "string" || body.item.trim() === "") {
				return badRequest(c, "field `item` is required (string) for ordinary runs");
			}
		}

		if (body.parallel !== undefined && (typeof body.parallel !== "number" || !Number.isInteger(body.parallel) || body.parallel < 1)) {
			return badRequest(c, "`parallel` must be a positive integer");
		}
		if (body.cycles !== undefined && (typeof body.cycles !== "number" || !Number.isInteger(body.cycles) || body.cycles < 1)) {
			return badRequest(c, "`cycles` must be a positive integer");
		}
		if (body.shipTarget !== undefined && !SHIP_TARGETS.includes(body.shipTarget as ShipTargetName)) {
			return badRequest(c, `\`shipTarget\` must be one of ${SHIP_TARGETS.join(", ")}`);
		}
		if (body.verbose !== undefined && typeof body.verbose !== "boolean") {
			return badRequest(c, "`verbose` must be a boolean");
		}

		let watchDailyBudget: number | undefined;
		if (body.watchDailyBudget !== undefined) {
			if (typeof body.watchDailyBudget !== "number" || !Number.isFinite(body.watchDailyBudget) || body.watchDailyBudget <= 0) {
				return badRequest(c, "`watchDailyBudget` must be a positive finite number");
			}
			if (mode !== "watch") {
				return badRequest(c, '`watchDailyBudget` requires `mode: "watch"`');
			}
			watchDailyBudget = body.watchDailyBudget;
		}

		let run: PersistedRun;
		try {
			run = supervisor.start({
				repo: body.repo.trim(),
				...(mode ? { mode } : { item: (body.item as string).trim() }),
				...(typeof body.parallel === "number" ? { parallel: body.parallel } : {}),
				...(typeof body.cycles === "number" ? { cycles: body.cycles } : {}),
				...(body.shipTarget ? { shipTarget: body.shipTarget as ShipTargetName } : {}),
				...(watchDailyBudget !== undefined ? { watchDailyBudget } : {}),
				...(body.verbose === true ? { verbose: true } : {}),
			});
		} catch (err) {
			if (err instanceof SupervisorError && err.code === "unknown-repo") {
				return badRequest(c, err.message);
			}
			throw err;
		}
		return c.json({
			id: run.id,
			repo: run.repo,
			...(run.item !== undefined ? { item: run.item } : {}),
			...(run.mode ? { mode: run.mode } : {}),
			startedAt: run.startedAt,
			logPath: run.logPath,
		});
	});

	app.get("/runs", (c) => {
		const repoFilter = c.req.query("repo");
		const supervised = supervisor.list();
		const filteredSupervised = repoFilter ? supervised.filter((r) => r.repo === repoFilter) : supervised;
		const external = listExternalRuns({
			registry,
			supervised: filteredSupervised,
			...(repoFilter !== undefined ? { repo: repoFilter } : {}),
		});
		const summaries = [...filteredSupervised.map(summarize), ...external];
		const titlesByRepo = new Map<string, ReadonlyMap<string, string>>();
		for (const run of summaries) {
			if (!titlesByRepo.has(run.repo)) titlesByRepo.set(run.repo, roadmapCache.getTitles(run.repo));
		}
		const runs = summaries.map((run) => {
			const itemTitle = run.item === undefined ? undefined : titlesByRepo.get(run.repo)?.get(run.item);
			return { ...run, ...(itemTitle !== undefined ? { itemTitle } : {}) };
		});
		runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
		return c.json({ runs });
	});

	app.get("/runs/:id", (c) => {
		const run = supervisor.get(c.req.param("id"));
		if (!run) return c.json({ error: "run not found", code: "not-found" }, 404);
		return c.json(run);
	});

	app.post("/runs/:id/pause", (c) => {
		try {
			const run = supervisor.pause(c.req.param("id"));
			return c.json({ id: run.id, status: run.status });
		} catch (err) {
			return supervisorError(c, err);
		}
	});

	app.post("/runs/:id/resume", (c) => {
		try {
			const run = supervisor.resume(c.req.param("id"));
			return c.json({
				id: run.id,
				repo: run.repo,
				...(run.item !== undefined ? { item: run.item } : {}),
				...(run.mode ? { mode: run.mode } : {}),
				status: run.status,
				resumedFrom: run.resumedFrom,
			});
		} catch (err) {
			return supervisorError(c, err);
		}
	});

	app.post("/runs/:id/stop", async (c) => {
		try {
			const run = await supervisor.stop(c.req.param("id"));
			return c.json({ id: run.id, status: run.status });
		} catch (err) {
			return supervisorError(c, err);
		}
	});

	app.get("/runs/:id/log", (c) => {
		const id = c.req.param("id");
		const run = supervisor.get(id);
		if (!run) return c.json({ error: "run not found", code: "not-found" }, 404);
		return streamSSE(c, async (stream) => {
			let unsubscribe = () => {};
			const onLine = async (line: string) => {
				await stream.writeSSE({ data: line });
			};
			const handle = await supervisor.attachLog(id, (line) => {
				onLine(line).catch(() => {});
			});
			unsubscribe = handle.unsubscribe;
			c.req.raw.signal.addEventListener("abort", () => unsubscribe());
			if (handle.closed) {
				const exitCode = supervisor.get(id)?.exitCode ?? 0;
				await stream.writeSSE({ event: "end", data: JSON.stringify({ exitCode }) });
				unsubscribe();
				return;
			}
			await new Promise<void>((res) => {
				c.req.raw.signal.addEventListener("abort", () => res());
			});
		});
	});
}

function supervisorError(c: Context, err: unknown): Response {
	if (err instanceof SupervisorError) {
		const status = err.code === "not-found" ? 404 : err.code === "unknown-repo" ? 400 : 409;
		return c.json({ error: err.message, code: err.code }, status);
	}
	throw err;
}
