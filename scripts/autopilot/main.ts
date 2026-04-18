#!/usr/bin/env tsx

import { parseArgs } from "node:util";
import { orchestrate } from "./pipeline.js";
import { runStatsCommand } from "./stats.js";
import type { Flags } from "./types.js";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		cycles: { type: "string", default: "1" },
		parallel: { type: "string", default: "1" },
		item: { type: "string" },
		resume: { type: "string" },
		verbose: { type: "boolean", default: false },
		trace: { type: "boolean", default: false },
		budget: { type: "string", default: "40" },
		"max-wait": { type: "string", default: "6h" },
		pr: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
	},
});

if (positionals[0] === "stats") {
	runStatsCommand();
	process.exit(0);
}

orchestrate(values as Flags);
