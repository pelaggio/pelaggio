import { existsSync } from "node:fs";
import { getRoadmapSource, loadConfig } from "@cdhorne/claude-autopilot";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { LogBroker } from "../src/log-broker.js";
import { loadRegistry } from "../src/registry.js";
import { RoadmapCache } from "../src/roadmap-cache.js";
import { StateStore } from "../src/state-store.js";
import { Supervisor } from "../src/supervisor.js";

const cfg = loadServerConfig();
const registry = loadRegistry(cfg.registryPath);
const roadmapCache = new RoadmapCache({
	registry,
	factory: (repo) => {
		const autopilotCfg = loadConfig({ repo });
		return getRoadmapSource(autopilotCfg.roadmapSource, {
			repo,
			github: autopilotCfg.roadmapGithub,
			linear: autopilotCfg.roadmapLinear,
		});
	},
});

const store = new StateStore(cfg.statePath);
const broker = new LogBroker();
const supervisor = new Supervisor({ store, broker, registry, logDir: cfg.logDir });
supervisor.bootReattach();

const app = createApp({
	supervisor,
	registry,
	roadmapCache,
	token: cfg.token,
	webDist: cfg.webDist,
});

serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
	console.log(`autopilot-server listening on http://${info.address}:${info.port}`);
	console.log(`registry: ${cfg.registryPath}`);
	for (const entry of registry.entries()) {
		const status = existsSync(entry.path) ? "ok" : "missing";
		console.log(`  ${entry.slug} → ${entry.path} (${status})`);
	}
	if (cfg.webDist !== undefined) {
		console.log(`UI mounted from ${cfg.webDist}`);
	} else {
		console.log("UI not mounted (build @cdhorne/claude-autopilot-web or set AUTOPILOT_SERVER_WEB_DIST)");
	}
});
