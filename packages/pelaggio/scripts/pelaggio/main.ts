#!/usr/bin/env tsx

import { parseCli } from "./cli.js";
import { orchestrate } from "./orchestrator.js";
import { runStatsCommand } from "./stats.js";

const intent = parseCli(process.argv.slice(2));

switch (intent.kind) {
	case "stats":
		runStatsCommand({ json: intent.json, usage: intent.usage });
		process.exit(0);
		break;
	case "error":
		console.error(intent.message);
		process.exit(intent.exitCode);
		break;
	case "run":
		orchestrate(intent.flags);
		break;
}
