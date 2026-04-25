import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Supervisor } from "../supervisor.js";
import { SupervisorError } from "../supervisor.js";
import type { PersistedRun, ShipTargetName } from "../types.js";

const SHIP_TARGETS: readonly ShipTargetName[] = ["direct-push", "pull-request", "auto-merge-pr"];

interface StartBody {
	repo?: unknown;
	item?: unknown;
	parallel?: unknown;
	cycles?: unknown;
	shipTarget?: unknown;
}

function badRequest(c: Context, message: string): Response {
	return c.json({ error: message, code: "bad-request" }, 400);
}

function summarize(run: PersistedRun) {
	return {
		id: run.id,
		repo: run.repo,
		item: run.item,
		status: run.status,
		startedAt: run.startedAt,
		...(run.endedAt ? { endedAt: run.endedAt } : {}),
	};
}

export function registerRunRoutes(app: Hono, supervisor: Supervisor): void {
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
		if (typeof body.item !== "string" || body.item.trim() === "") {
			return badRequest(c, "field `item` is required (string)");
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
		let run: PersistedRun;
		try {
			run = supervisor.start({
				repo: body.repo.trim(),
				item: body.item.trim(),
				...(typeof body.parallel === "number" ? { parallel: body.parallel } : {}),
				...(typeof body.cycles === "number" ? { cycles: body.cycles } : {}),
				...(body.shipTarget ? { shipTarget: body.shipTarget as ShipTargetName } : {}),
			});
		} catch (err) {
			if (err instanceof SupervisorError && err.code === "unknown-repo") {
				return badRequest(c, err.message);
			}
			throw err;
		}
		return c.json({ id: run.id, repo: run.repo, item: run.item, startedAt: run.startedAt, logPath: run.logPath });
	});

	app.get("/runs", (c) => {
		const repoFilter = c.req.query("repo");
		const runs = supervisor.list();
		const filtered = repoFilter ? runs.filter((r) => r.repo === repoFilter) : runs;
		return c.json({ runs: filtered.map(summarize) });
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
			return c.json({ id: run.id, repo: run.repo, item: run.item, status: run.status, resumedFrom: run.resumedFrom });
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
