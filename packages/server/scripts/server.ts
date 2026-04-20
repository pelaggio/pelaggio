import { computeStats, getRoadmapSource, loadConfig } from "@cdhorne/claude-autopilot";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";
import { LogBroker } from "../src/log-broker.js";
import { StateStore } from "../src/state-store.js";
import { Supervisor } from "../src/supervisor.js";

const cfg = loadServerConfig();
const autopilotCfg = loadConfig({ repo: cfg.repo });
const roadmap = getRoadmapSource(autopilotCfg.roadmapSource, {
	repo: cfg.repo,
	github: autopilotCfg.roadmapGithub,
	linear: autopilotCfg.roadmapLinear,
});

const store = new StateStore(cfg.statePath);
const broker = new LogBroker();
const supervisor = new Supervisor({ store, broker, repoCwd: cfg.repo, logDir: cfg.logDir });
supervisor.bootReattach();

const app = createApp({
	supervisor,
	roadmap,
	computeStats: () => computeStats(),
	token: cfg.token,
	webDist: cfg.webDist,
});

serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
	console.log(`autopilot-server listening on http://${info.address}:${info.port} (repo: ${cfg.repo})`);
	if (cfg.webDist !== undefined) {
		console.log(`UI mounted from ${cfg.webDist}`);
	} else {
		console.log("UI not mounted (build @cdhorne/claude-autopilot-web or set AUTOPILOT_SERVER_WEB_DIST)");
	}
});
