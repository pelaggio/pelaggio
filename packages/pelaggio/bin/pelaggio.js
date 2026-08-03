#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [, , sub, ...rest] = process.argv;

const HELP = `
pelaggio <command> [options]

Commands:
  init    Scaffold .claude/skills/, .pelaggio.yml, and starter docs into this project.
  sync    Diff and update installed .claude/skills/<name>/SKILL.md against the package.
  run     Run the pipeline (same flags as \`pnpm pelaggio\`: --cycles --parallel --item …).
  stats   Print the stats dashboard from .dev/pelaggio-log.jsonl.
  roadmap Adapter-backed queries (list / get / claim / plan-path / publish-plan / mark-done / create-item / archive-plan / source). Used by skill bodies.
  decisions Resolve or archive rows in docs/decisions.md.
  taxonomy Owner ritual for the ADR-0016 safety taxonomy (verify / sign / canonical).
  pr-review  Run the CI merge-gate review of a PR (--pr <n>); posts a comment and exits non-zero on a blocking finding.
  land    Deterministic red-merge guard + merge (--pr <n> [--admin] [--repo <owner/repo>]); refuses to merge a PR whose CI is not green.
  worktree-deps  Symlink/install node_modules for a worktree (called by /pick).
  run-contained  Run one command in the Linux contained-execution jail, or verify it with --self-test.
  sessions-sweep  Remove content-expired cross-process session records under .dev/sessions/ (called by /tidy).

See README for full options.
`.trim();

const routes = {
	init: ["scripts/pelaggio/init.ts"],
	sync: ["scripts/pelaggio/sync.ts"],
	run: ["scripts/pelaggio.ts"],
	stats: ["scripts/pelaggio.ts", "stats"],
	roadmap: ["scripts/pelaggio/roadmap-cli.ts"],
	decisions: ["scripts/pelaggio/decisions-cli.ts"],
	taxonomy: ["scripts/pelaggio/taxonomy-cli.ts"],
	"pr-review": ["scripts/pelaggio/pr-review-cli.ts"],
	land: ["scripts/pelaggio/land-cli.ts"],
	"worktree-deps": ["scripts/pelaggio/worktree-deps.ts"],
	"run-contained": ["scripts/pelaggio/run-contained-cli.ts"],
	"sessions-sweep": ["scripts/pelaggio/sessions-cli.ts"],
};

if (!sub || sub === "--help" || sub === "-h" || !routes[sub]) {
	console.log(HELP);
	process.exit(sub && sub !== "--help" && sub !== "-h" ? 1 : 0);
}

const [script, ...prefix] = routes[sub];

// Run the target script through tsx by loading tsx as a Node import hook via
// `node --import`, rather than spawning the `node_modules/.bin/tsx` shim. On
// Windows that shim is `tsx.CMD`, and post-CVE-2024-27980 Node refuses to spawn
// a `.cmd` without `shell: true` — and a shell would then mangle passthrough
// args that contain spaces (e.g. `--title "Flow 1: …"`). Driving tsx through
// the real `node` binary keeps the arg array intact on every platform.
let tsxImport;
try {
	tsxImport = import.meta.resolve("tsx");
} catch {
	tsxImport = "tsx"; // fall back to a bare specifier resolved from cwd
}

spawn(process.execPath, ["--import", tsxImport, resolve(pkgRoot, script), ...prefix, ...rest], {
	stdio: "inherit",
	env: process.env,
}).on("exit", (code) => process.exit(code ?? 1));
