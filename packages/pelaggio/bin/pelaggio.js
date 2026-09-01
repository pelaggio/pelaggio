#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAuthoringReviewMainRepo, verifyOrRepairAuthoringReviewHostDependencies } from "../scripts/pelaggio/review/seat-deps-core.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [, , sub, ...rest] = process.argv;

const HELP = `
pelaggio <command> [options]

Commands:
  init    Scaffold .claude/skills/, .pelaggio.yml, and starter docs into this project.
  sync    Diff and update installed .claude/skills/<name>/SKILL.md against the package.
  run     Run the pipeline (same flags as \`pnpm pelaggio\`: --cycles --parallel --item …).
  stats   Print the stats dashboard from .dev/pelaggio-log.jsonl.
  roadmap Adapter-backed queries (list / get / claim / plan-path / publish-plan / mark-done / create-item / archive-plan / stale-scan / stale-list / stale-resolve / source). Used by skill bodies.
  decisions Lifecycle/projection for docs/decision-log/ (resolve, archive-resolved, migrate, rebuild-index).
  taxonomy Owner ritual for the ADR-0016 safety taxonomy (verify / sign / canonical).
  pr-review  Run the CI merge-gate review of a PR (--pr <n>); posts a comment and exits non-zero on a blocking finding.
  pr-adjudicate  Local-operator clearance of a findings-terminal review after a narrow fix (--pr <n>); posts success last.
  doc-review  Provider-diverse read-only review of a document (<path>); binds the report to its sha256 and exits non-zero on a blocking finding.
  review-bench  Deterministic zero-LLM Tier A authoring-review benchmark (--replay [--json]); replays committed panel/Judge recordings and exits non-zero on golden or baseline regression.
  land    Deterministic red-merge guard + merge (--pr <n> [--admin] [--repo <owner/repo>]); refuses to merge a PR whose CI is not green.
  revise  On-demand operator revision of a red-review PR (--pr <n> [--allow-repeat]); --allow-repeat bypasses only the one-pass label.
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
	"pr-adjudicate": ["scripts/pelaggio/pr-adjudicate-cli.ts"],
	"doc-review": ["scripts/pelaggio/doc-review-cli.ts"],
	"review-bench": ["scripts/pelaggio/review-bench-cli.ts"],
	land: ["scripts/pelaggio/land-cli.ts"],
	revise: ["scripts/pelaggio/revise-cli.ts"],
	"worktree-deps": ["scripts/pelaggio/worktree-deps.ts"],
	"run-contained": ["scripts/pelaggio/run-contained-cli.ts"],
	"sessions-sweep": ["scripts/pelaggio/sessions-cli.ts"],
};

if (!sub || sub === "--help" || sub === "-h" || !routes[sub]) {
	console.log(HELP);
	process.exit(sub && sub !== "--help" && sub !== "-h" ? 1 : 0);
}

const [script, ...prefix] = routes[sub];

// Cold-start restoration guards EVERY routed subcommand: each one resolves tsx and
// the package dependencies through packages/pelaggio/node_modules, so a dangling
// link would otherwise fail pr-review/land/roadmap/… with a raw
// ERR_MODULE_NOT_FOUND instead of this typed park guidance.
{
	const mainRepo = resolveAuthoringReviewMainRepo(resolve(pkgRoot, "../.."));
	const repair = await verifyOrRepairAuthoringReviewHostDependencies(mainRepo);
	if (repair.status === "park") {
		console.error(`authoring-review host dependency restoration parked before CLI startup (${repair.reason}): ${repair.detail}`);
		console.error("preserved state: the claim worktree and MAIN links remain at the last repair state");
		console.error(`resume: ${sub === "run" ? `pnpm pelaggio ${rest.join(" ")}` : `npx pelaggio ${[sub, ...rest].join(" ")}`}`.trimEnd());
		process.exit(1);
	}
}

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

const child = spawn(process.execPath, ["--import", tsxImport, resolve(pkgRoot, script), ...prefix, ...rest], {
	stdio: "inherit",
	env: process.env,
});

// Supervised pause/stop signal this wrapper (their immediate child), not the
// pipeline it spawned: forward the control signals so they reach the run
// instead of orphaning it. SIGINT is forwarded only without a TTY — an
// interactive Ctrl+C already reaches the whole foreground process group, and a
// forwarded duplicate would read as a second interrupt.
const forwardedSignals = ["SIGTERM", "SIGUSR2", ...(process.stdin.isTTY ? [] : ["SIGINT"])];
for (const signal of forwardedSignals) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
	// Mirror how the pipeline actually ended: its exit code, or — after dropping
	// our forwarding handlers so the re-raise takes the default action — the
	// fatal signal itself.
	if (signal) {
		for (const forwarded of forwardedSignals) process.removeAllListeners(forwarded);
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
