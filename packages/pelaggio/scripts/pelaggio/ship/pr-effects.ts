import { execSync } from "node:child_process";
import type { ShipDecisionEffect } from "../effects.js";
import { defaultGhRun, type GhRunner, parseGhJson } from "../roadmap/github-issues.js";
import { collectLoggedAssistedByIdentities, identitiesForProviders, withAssistedBy } from "./assisted-by.js";
import type { ExecFn } from "./bookkeeping.js";
import { assertCiNotRed } from "./ci-guard.js";

export interface ShipPrEffectsDeps {
	exec?: ExecFn;
	gh?: GhRunner;
	log: (msg: string) => void;
	assistedByProviders?: import("../types.js").ProviderName[];
}

export interface ShipPrEffectsResult {
	prUrl: string;
}

interface ExistingPr {
	number: number;
	url: string;
}

const defaultExec: ExecFn = (cmd, cwd) => {
	return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
};

export async function runShipPrEffects(
	ctx: {
		cwd: string;
		itemId: string;
		decision: ShipDecisionEffect;
	},
	deps: ShipPrEffectsDeps,
): Promise<ShipPrEffectsResult> {
	const exec = deps.exec ?? defaultExec;
	const gh = deps.gh ?? defaultGhRun;
	const { cwd, decision } = ctx;
	if (decision.target === "direct-push") throw new Error("ship.ShipDecision is not supported for direct-push");
	if (decision.itemId !== ctx.itemId) throw new Error(`ship decision itemId ${decision.itemId} does not match ${ctx.itemId}`);

	const status = exec("git status --porcelain", cwd);
	if (status.trim() !== "") throw new Error("refusing PR ship with dirty worktree");

	const branch = exec("git branch --show-current", cwd).trim();
	if (branch !== decision.headBranch) throw new Error(`head branch mismatch: current ${branch || "(detached)"} does not match decision ${decision.headBranch}`);

	const mergeBase = exec("git merge-base main HEAD", cwd).trim();
	if (!mergeBase) throw new Error("cannot determine merge-base with main");
	exec(`git reset --soft ${shellQuote(mergeBase)}`, cwd);
	// Always-on Assisted-by trailers (#189): stamp realized cycle providers from the
	// cycle log when present; withAssistedBy falls back to the default identity.
	const assistedBody = withAssistedBy(decision.prBody, [...collectLoggedAssistedByIdentities(ctx.itemId), ...identitiesForProviders(deps.assistedByProviders ?? [])]);
	exec(`git commit -m ${shellQuote(decision.prTitle)} -m ${shellQuote(assistedBody)}`, cwd);

	const changed = exec("git diff --name-only main...HEAD", cwd)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("docs/plans/") && !line.startsWith("docs/decision-log/"));
	if (changed.length === 0) throw new Error("nothing to ship: branch only touches docs/plans/ and/or docs/decision-log/ after squash");

	pushBranch(exec, cwd, deps.log);
	const upserted = upsertPr(gh, decision);
	if (decision.target === "auto-merge-pr") {
		if (upserted.number === null) throw new Error("cannot enable auto-merge without a PR number");
		// Deterministic red-merge guard (#292): refuse to queue auto-merge onto a PR that
		// already has a confirmed-red check, independent of how branch protection is (or
		// isn't) configured. Pending checks are fine — `--auto` itself defers the merge.
		assertCiNotRed(gh, upserted.number);
		runGh(gh, ["pr", "merge", "--auto", "--squash", String(upserted.number)]);
		deps.log(`auto-merge enabled for ${upserted.url}`);
	}
	return { prUrl: upserted.url };
}

function pushBranch(exec: ExecFn, cwd: string, log: (msg: string) => void): void {
	try {
		exec("git push -u origin HEAD", cwd);
		return;
	} catch (e) {
		log(`push rejected; retrying with --force-with-lease (${short(e)})`);
		exec("git push --force-with-lease -u origin HEAD", cwd);
	}
}

function upsertPr(gh: GhRunner, decision: ShipDecisionEffect): { number: number | null; url: string } {
	const existingRaw = runGh(gh, ["pr", "list", "--head", decision.headBranch, "--state", "open", "--json", "number,url", "--limit", "1"]).stdout;
	const existing = parseGhJson<ExistingPr[]>(existingRaw, isExistingPrList);
	const current = existing[0];
	if (current) {
		runGh(gh, ["pr", "edit", String(current.number), "--title", decision.prTitle, "--body", decision.prBody]);
		return { number: current.number, url: current.url };
	}
	const created = runGh(gh, ["pr", "create", "--title", decision.prTitle, "--body", decision.prBody, "--head", decision.headBranch]).stdout.trim();
	if (!created) throw new Error("gh pr create did not return a PR URL");
	return { number: parsePrNumber(created), url: created };
}

function runGh(gh: GhRunner, args: string[]): { stdout: string; stderr: string; status: number } {
	const result = gh(args);
	if (result.status !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `status ${result.status}`;
		throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${detail}`);
	}
	return result;
}

function isExistingPrList(value: unknown): value is ExistingPr[] {
	return Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.number === "number" && typeof entry.url === "string");
}

function parsePrNumber(url: string): number | null {
	const match = url.match(/\/pull\/(\d+)(?:\D*)?$/);
	return match ? Number.parseInt(match[1], 10) : null;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function short(e: unknown): string {
	return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
