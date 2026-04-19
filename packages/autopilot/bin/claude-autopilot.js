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
  sync    Diff and update installed .claude/skills/<name>/SKILL.md against the package.
  run     Run the pipeline (same flags as \`pnpm autopilot\`: --cycles --parallel --item …).
  stats   Print the stats dashboard from .dev/autopilot-log.jsonl.
  roadmap Adapter-backed queries (list / get / claim / plan-path / publish-plan / mark-done / create-item / archive-plan / source). Used by skill bodies.
  worktree-deps  Symlink/install node_modules for a worktree (called by /pick).

See README for full options.
`.trim();

const routes = {
	init: ["scripts/autopilot/init.ts"],
	sync: ["scripts/autopilot/sync.ts"],
	run: ["scripts/autopilot.ts"],
	stats: ["scripts/autopilot.ts", "stats"],
	roadmap: ["scripts/autopilot/roadmap-cli.ts"],
	"worktree-deps": ["scripts/autopilot/worktree-deps.ts"],
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
