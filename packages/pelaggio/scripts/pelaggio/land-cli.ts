#!/usr/bin/env tsx

/**
 * `pelaggio land --pr <n> [--admin] [--repo <owner/repo>]` — the deterministic
 * red-merge guard for the out-of-band supervised-run "Land" step (issue #292).
 *
 * Neither `gh pr merge` (deferred `--auto` in the pipeline path) nor a raw
 * `gh pr merge --admin` (the operator's manual out-of-band path) is on its own
 * a guarantee that a red PR cannot land — `--admin` in particular bypasses
 * branch protection entirely, including required CI checks. This CLI confirms
 * CI is green (`assertCiGreen`, `ship/ci-guard.ts`) before ever invoking `gh pr
 * merge`, so `--admin` bypasses only the review-pin (the `app=None`
 * local-subscription-review mismatch against the pinned reviewing app) — it
 * never bypasses the CI-green requirement. Exit codes: 0 merged, 1
 * refused/gh error, 2 usage.
 */

import { fileURLToPath } from "node:url";
import { ROADMAP_GITHUB } from "./config.js";
import { defaultGhRun, type GhRunner } from "./roadmap/github-issues.js";
import { assertCiGreen } from "./ship/ci-guard.js";

export interface LandOptions {
	pr: number;
	admin: boolean;
	ghRepo: string;
}

export interface LandDeps {
	gh: GhRunner;
	log: (msg: string) => void;
}

export type ParsedLandArgs = { kind: "run"; pr: number; admin: boolean; ghRepo?: string } | { kind: "error"; message: string };

export function parseLandArgs(argv: string[]): ParsedLandArgs {
	let pr: number | undefined;
	let admin = false;
	let ghRepo: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--pr") {
			pr = Number.parseInt(argv[++i] ?? "", 10);
			continue;
		}
		if (a === "--admin") {
			admin = true;
			continue;
		}
		if (a === "--repo") {
			ghRepo = argv[++i];
			continue;
		}
		return { kind: "error", message: `unknown argument: ${a}` };
	}
	if (pr === undefined || !Number.isInteger(pr) || pr <= 0) return { kind: "error", message: "usage: pelaggio land --pr <number> [--admin] [--repo <owner/repo>]" };
	return { kind: "run", pr, admin, ghRepo };
}

/**
 * Runs the guard, then the merge. `assertCiGreen` is fail-closed (see
 * ci-guard.ts): an empty rollup, a still-pending check, a red check, or a
 * gh/parse error all refuse the merge rather than let it through.
 */
export function runLand(options: LandOptions, deps: LandDeps): number {
	try {
		assertCiGreen(deps.gh, options.pr, options.ghRepo);
	} catch (e) {
		deps.log(e instanceof Error ? e.message : String(e));
		return 1;
	}
	const args = ["pr", "merge", String(options.pr), "--repo", options.ghRepo, "--squash", "--delete-branch", ...(options.admin ? ["--admin"] : [])];
	const result = deps.gh(args);
	if (result.status !== 0) {
		deps.log(`merge failed: ${result.stderr.trim() || result.stdout.trim() || `status ${result.status}`}`);
		return 1;
	}
	deps.log(`merged PR #${options.pr}${options.admin ? " (--admin bypassed only the review-pin; CI-green was still required)" : ""}`);
	return 0;
}

export function main(argv: string[], deps: LandDeps = { gh: defaultGhRun, log: (msg) => console.error(msg) }): number {
	const parsed = parseLandArgs(argv);
	if (parsed.kind === "error") {
		deps.log(parsed.message);
		return 2;
	}
	const ghRepo = parsed.ghRepo ?? ROADMAP_GITHUB.ghRepo;
	if (!ghRepo) {
		deps.log("no GitHub repo configured — pass --repo <owner/repo> or set roadmap.github.repo in .pelaggio.yml");
		return 2;
	}
	return runLand({ pr: parsed.pr, admin: parsed.admin, ghRepo }, deps);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exit(main(process.argv.slice(2)));
}
