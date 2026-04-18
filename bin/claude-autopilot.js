#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [, , sub, ...rest] = process.argv;

const HELP = `
claude-autopilot <command> [options]

Commands:
  init    Scaffold .claude/skills/, .autopilot.yml, and starter docs into this project.
  run     Run the pipeline (same flags as \`pnpm autopilot\`: --cycles --parallel --item …).
  stats   Print the stats dashboard from .dev/autopilot-log.jsonl.

See README for full options.
`.trim();

const routes = {
	init: ["scripts/autopilot/init.ts"],
	run: ["scripts/autopilot.ts"],
	stats: ["scripts/autopilot.ts", "stats"],
};

if (!sub || sub === "--help" || sub === "-h" || !routes[sub]) {
	console.log(HELP);
	process.exit(sub && sub !== "--help" && sub !== "-h" ? 1 : 0);
}

const [script, ...prefix] = routes[sub];
const localTsx = resolve(pkgRoot, "node_modules/.bin/tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

spawn(tsx, [resolve(pkgRoot, script), ...prefix, ...rest], {
	stdio: "inherit",
	env: process.env,
}).on("exit", (code) => process.exit(code ?? 1));
