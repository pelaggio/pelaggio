import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { getRoadmapSource, loadConfig } from "pelaggio";
import { createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { LogBroker } from "../src/log-broker.js";
import { loadRegistry } from "../src/registry.js";
import { RoadmapCache } from "../src/roadmap-cache.js";
import { acquireStatePathLock } from "../src/state-path-lock.js";
import { StateStore } from "../src/state-store.js";
import { Supervisor } from "../src/supervisor.js";

const cfg = loadServerConfig();
// Exclusive ownership of the state path before any registry/store work so a
// duplicate instance fails before touching other files. Release on exit so
// orderly shutdown does not leave residue; crash residue is reclaimed on the
// next boot after the recorded PID is confirmed dead (or is this process).
const stateLock = acquireStatePathLock(cfg.statePath);
process.once("exit", () => stateLock.release());

const registry = loadRegistry(cfg.registryPath);
const store = new StateStore(cfg.statePath);
const broker = new LogBroker();
const supervisor = new Supervisor({ store, broker, registry, logDir: cfg.logDir });
supervisor.bootReattach();
const roadmapCache = new RoadmapCache({
	registry,
	listRoadmap: (slug) => supervisor.listRoadmap(slug),
	titleTtlMs: cfg.roadmapTitleTtlMs,
	factory: (repo) => {
		const autopilotCfg = loadConfig({ repo });
		return getRoadmapSource(autopilotCfg.roadmapSource, {
			repo,
			github: autopilotCfg.roadmapGithub,
			linear: autopilotCfg.roadmapLinear,
		});
	},
});

const app = createApp({
	supervisor,
	registry,
	roadmapCache,
	token: cfg.token,
	webDist: cfg.webDist,
	trustManifestPath: cfg.trustManifestPath,
});

serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
	console.log(`pelaggio-server listening on http://${info.address}:${info.port}`);
	console.log(`registry: ${cfg.registryPath}`);
	for (const entry of registry.entries()) {
		const status = existsSync(entry.path) ? "ok" : "missing";
		console.log(`  ${entry.slug} → ${entry.path} (${status})`);
	}
	if (cfg.webDist !== undefined) {
		console.log(`UI mounted from ${cfg.webDist}`);
	} else {
		console.log("UI not mounted (build @pelaggio/web or set AUTOPILOT_SERVER_WEB_DIST)");
	}
});
