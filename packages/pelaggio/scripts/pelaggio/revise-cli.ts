#!/usr/bin/env tsx

/**
 * `pelaggio revise --pr <n> [--allow-repeat]` — on-demand operator entry to the
 * findings-driven resume seam (issue #498).
 *
 * Resolves a Pelaggio-managed red-review PR, acquires the per-item execution
 * lease (`acquireReviseExecution`) for the pre-flight — so a first pass and an
 * `--allow-repeat` repeat can never race the label claim, audit, findings
 * fetch, or worktree restore for the same item — atomically claims the
 * one-pass label (cross-process with the in-run revise sweep —
 * `claimRevisionExclusive`), records the accepted-pass audit comment only
 * after that claim, fetches the marked findings, restores the claim worktree
 * and verifies its branch + HEAD against the PR head OID, then RELEASES the
 * lease and calls `runOrchestrator` in-process with `--resume` +
 * `--review-findings` in `operator-revision` mode. The orchestrator owns
 * execution exclusivity from there (#507 round 3): every revision attempt —
 * the first one and every post-park resume, including the advertised manual
 * `--resume <id> --review-findings <path>` continuation — reacquires the lease
 * before touching the worktree and releases it when the attempt ends, so a
 * park never pins the lease across a reset sleep. A crashed pass leaves the
 * lease in place; recovery is manual (the refusal names the lease file).
 * Exit codes: 0 success, 1 refused/unavailable, 2 usage / ambient single-shot
 * / non-PR ship target.
 */

import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseCli } from "./cli.js";
import { REPO, ROADMAP_GITHUB, SHIP_TARGET } from "./config.js";
import { resolveWorktree } from "./helpers.js";
import { type OrchestratorDeps, runOrchestrator } from "./pipeline.js";
import {
	type AcquireReviseExecutionResult,
	acquireReviseExecution,
	autopilotManagedState,
	type ClaimRevisionOutcome,
	claimRevisionExclusive,
	ensureReviseWorktree,
	fetchReviewFindings,
	type ResolveReviseTargetResult,
	type ReviseInvocationDisposition,
	recordReviseInvocation,
	resolveReviseTarget,
	reviseExecLeaseRoot,
	reviseFindingsPath,
	verifyReviseWorktreeBinding,
} from "./revise-sweep.js";
import { defaultGhRun, type GhRunner } from "./roadmap/github-issues.js";
import type { ShipTargetName } from "./types.js";

const USAGE = "usage: pelaggio revise --pr <number> [--allow-repeat]";

export interface ReviseCliDeps {
	gh: GhRunner;
	repo: string;
	ghRepo: string;
	shipTargetName: ShipTargetName;
	log: (msg: string) => void;
	err: (msg: string) => void;
	resolveTarget: (pr: number) => ResolveReviseTargetResult;
	managedState: (itemId: string) => "managed" | "unmanaged" | "unknown";
	/** Atomic cross-process claim (`claimRevisionExclusive`) — serializes against the in-run sweep. */
	claimRevision: (prNumber: number) => Promise<ClaimRevisionOutcome>;
	/** Execution lease (`acquireReviseExecution`) held for the pre-flight (claim/audit/fetch/restore/verify), then released so the orchestrator can reacquire it per revision attempt (#507 round 3). Serializes ALL revision passes per item, including `--allow-repeat` repeats that bypass the one-pass label. */
	acquireExecution: (itemId: string) => Promise<AcquireReviseExecutionResult>;
	fetchFindings: (prNumber: number, findingsPath: string) => boolean;
	ensureWorktree: (worktreePath: string, branch: string) => string | null;
	/** Bind the checkout to the PR head (branch + OID) before orchestrating (`verifyReviseWorktreeBinding`). */
	verifyWorktreeBinding: (worktreePath: string, branch: string, headOid: string) => { ok: true } | { ok: false; reason: string };
	recordInvocation: (prNumber: number, disposition: ReviseInvocationDisposition, allowRepeat: boolean) => boolean;
	runOrchestrator: typeof runOrchestrator;
	resolveWorktree: (itemId: string) => string;
}

function isPrShipTarget(name: string): name is "pull-request" | "auto-merge-pr" {
	return name === "pull-request" || name === "auto-merge-pr";
}

function defaultDeps(): ReviseCliDeps {
	const gh = defaultGhRun;
	const ghRepo = ROADMAP_GITHUB.ghRepo;
	return {
		gh,
		repo: REPO,
		ghRepo,
		shipTargetName: SHIP_TARGET,
		log: (msg) => {
			console.log(msg);
		},
		err: (msg) => {
			console.error(msg);
		},
		resolveTarget: (pr) => resolveReviseTarget(gh, ghRepo, pr),
		managedState: (itemId) => autopilotManagedState(gh, ghRepo, itemId, ROADMAP_GITHUB.label),
		claimRevision: (prNumber) => claimRevisionExclusive(gh, ghRepo, REPO, prNumber),
		acquireExecution: (itemId) => acquireReviseExecution(reviseExecLeaseRoot(REPO), itemId),
		fetchFindings: (prNumber, findingsPath) => fetchReviewFindings(gh, ghRepo, prNumber, findingsPath),
		ensureWorktree: (worktreePath, branch) => ensureReviseWorktree(worktreePath, branch, { repo: REPO }),
		verifyWorktreeBinding: (worktreePath, branch, headOid) => verifyReviseWorktreeBinding(worktreePath, branch, headOid),
		recordInvocation: (prNumber, disposition, allowRepeat) => recordReviseInvocation(gh, ghRepo, prNumber, disposition, allowRepeat),
		runOrchestrator,
		resolveWorktree,
	};
}

function parseReviseArgs(argv: string[]): { kind: "run"; pr: number; allowRepeat: boolean } | { kind: "error"; message: string } {
	let values: { pr?: string; "allow-repeat"?: boolean };
	try {
		({ values } = parseArgs({
			args: argv,
			options: { pr: { type: "string" }, "allow-repeat": { type: "boolean" } },
			allowPositionals: false,
		}));
	} catch (e) {
		return { kind: "error", message: `${e instanceof Error ? e.message : String(e)}\n${USAGE}` };
	}
	const prRaw = values.pr;
	if (!prRaw || !/^\d+$/.test(prRaw) || Number(prRaw) <= 0) return { kind: "error", message: USAGE };
	return { kind: "run", pr: Number(prRaw), allowRepeat: !!values["allow-repeat"] };
}

export async function main(argv: string[], overrides: Partial<ReviseCliDeps> = {}): Promise<number> {
	const deps: ReviseCliDeps = { ...defaultDeps(), ...overrides };
	// Re-bind primitives that close over gh/ghRepo/repo when the caller overrode those
	// seams but not the primitive itself — production defaults already close over the
	// real values; tests inject the primitives they care about.
	if (overrides.gh || overrides.ghRepo) {
		const gh = deps.gh;
		const ghRepo = deps.ghRepo;
		if (!overrides.resolveTarget) deps.resolveTarget = (pr) => resolveReviseTarget(gh, ghRepo, pr);
		if (!overrides.managedState) deps.managedState = (itemId) => autopilotManagedState(gh, ghRepo, itemId, ROADMAP_GITHUB.label);
		if (!overrides.fetchFindings) deps.fetchFindings = (prNumber, findingsPath) => fetchReviewFindings(gh, ghRepo, prNumber, findingsPath);
		if (!overrides.recordInvocation) deps.recordInvocation = (prNumber, disposition, allowRepeat) => recordReviseInvocation(gh, ghRepo, prNumber, disposition, allowRepeat);
	}
	// claimRevisionExclusive closes over gh, ghRepo, AND repo (its lock lives in <repo>/.dev).
	if ((overrides.gh || overrides.ghRepo || overrides.repo) && !overrides.claimRevision) {
		const gh = deps.gh;
		const ghRepo = deps.ghRepo;
		const repo = deps.repo;
		deps.claimRevision = (prNumber) => claimRevisionExclusive(gh, ghRepo, repo, prNumber);
	}
	if (overrides.repo && !overrides.ensureWorktree) {
		deps.ensureWorktree = (worktreePath, branch) => ensureReviseWorktree(worktreePath, branch, { repo: deps.repo });
	}
	// The execution-lease register lives in <repo>/.dev, like the claim lock.
	if (overrides.repo && !overrides.acquireExecution) {
		deps.acquireExecution = (itemId) => acquireReviseExecution(reviseExecLeaseRoot(deps.repo), itemId);
	}

	const parsed = parseReviseArgs(argv);
	if (parsed.kind === "error") {
		deps.err(parsed.message);
		return 2;
	}
	const { pr, allowRepeat } = parsed;

	if (!deps.ghRepo) {
		deps.err("no GitHub repo configured — set roadmap.github.repo in .pelaggio.yml");
		return 2;
	}
	if (!isPrShipTarget(deps.shipTargetName)) {
		deps.err(`pelaggio revise requires a PR ship target (got ${deps.shipTargetName})`);
		return 2;
	}
	if (process.env.CI === "true" || process.env.PELAGGIO_SINGLE_SHOT === "1") {
		deps.err("pelaggio revise refuses CI / PELAGGIO_SINGLE_SHOT (would write the revision into the main checkout)");
		return 2;
	}

	const resolved = deps.resolveTarget(pr);
	if (resolved.kind === "unavailable") {
		deps.err(resolved.reason);
		return 1;
	}
	if (resolved.kind === "ineligible") {
		deps.err(resolved.reason);
		return 1;
	}
	const { target } = resolved;

	const managed = deps.managedState(target.itemId);
	if (managed === "unknown") {
		deps.err("could not determine whether the linked issue is pelaggio-managed (github lookup failed); retry");
		return 1;
	}
	if (managed === "unmanaged") {
		deps.err("linked issue is not a pelaggio-managed item");
		return 1;
	}

	const findingsPath = reviseFindingsPath(deps.repo, target.itemId);
	const parkedResume = `pnpm pelaggio --resume ${target.itemId} --review-findings ${findingsPath}`;

	if (target.alreadyRevised && !allowRepeat) {
		// A pure refusal executes nothing, so it needs no lease — but it IS durably audited.
		if (!deps.recordInvocation(pr, "refused-repeat", allowRepeat)) {
			deps.err("failed to record revise invocation comment");
			return 1;
		}
		deps.err(`PR #${pr} already has the autopilot:revised label. Pass --allow-repeat to start a new revision pass. A parked in-flight pass continues with: ${parkedResume}`);
		return 1;
	}
	const disposition: ReviseInvocationDisposition = target.alreadyRevised ? "accepted-repeat" : "accepted-first-pass";

	// Execution-scoped exclusion, acquired BEFORE the one-pass label claim and held for the
	// pre-flight: the label is a one-shot entitlement, not an execution guard — a repeat pass
	// (`--allow-repeat`) bypasses it entirely, so without this lease a repeat could run
	// concurrently with an in-flight first pass (or another repeat) in the same claim
	// worktree, racing findings writes, commits, and pushes. Acquiring before the claim also
	// means a refused invocation never consumes the label. Fail closed on anything but
	// `acquired` (see `acquireReviseExecution` for the guard class and crash semantics).
	// Released just before handing off to the orchestrator, which reacquires it per revision
	// attempt (#507 round 3) — a same-process hold would make that reacquisition refuse.
	const exec = await deps.acquireExecution(target.itemId);
	if (exec.kind === "held") {
		deps.err(`a revision for item ${target.itemId} (PR #${pr}) is already in flight — refusing a concurrent pass in the same claim worktree (${exec.holder}). A parked in-flight pass continues with: ${parkedResume}`);
		return 1;
	}
	if (exec.kind !== "acquired") {
		deps.err("failed to acquire the revise execution lease");
		return 1;
	}
	try {
		if (!target.alreadyRevised) {
			// Atomic one-pass claim: re-checks the label under the cross-process revise-claim
			// lock (`claimRevisionExclusive`), so this command and the in-run sweep — or two
			// operator invocations — can never both start a paid pass off the same stale
			// "unlabeled" read. `already-claimed` means a concurrent caller won between
			// `resolveTarget` and here; fail closed on anything but `claimed`.
			const claim = await deps.claimRevision(pr);
			if (claim === "already-claimed") {
				deps.err(`PR #${pr} was claimed by a concurrent revise caller (the in-run sweep or another operator invocation) — refusing a duplicate pass. A parked in-flight pass continues with: ${parkedResume}`);
				return 1;
			}
			if (claim !== "claimed") {
				deps.err("failed to claim the autopilot:revised label");
				return 1;
			}
		}

		// The accepted-* audit is recorded only after the pass is actually ours (label claimed /
		// lease held) — a losing racer must never leave an audit record for a pass it never ran.
		if (!deps.recordInvocation(pr, disposition, allowRepeat)) {
			deps.err("failed to record revise invocation comment");
			return 1;
		}

		if (!deps.fetchFindings(pr, findingsPath)) {
			deps.err("no marked review findings comment, or findings file could not be written");
			return 1;
		}

		const wt = deps.ensureWorktree(deps.resolveWorktree(target.itemId), target.branch);
		if (!wt) {
			deps.err("failed to restore the claim worktree");
			return 1;
		}

		// Bind the checkout to THIS PR before any work: the path is item-derived, so an
		// existing directory may hold another branch or a stale HEAD. Fail closed — never
		// auto-reset or checkout over an existing tree (it may hold parked work).
		const binding = deps.verifyWorktreeBinding(wt, target.branch, target.headOid);
		if (!binding.ok) {
			deps.err(`PR #${pr}: ${binding.reason}`);
			return 1;
		}

		deps.log(`revising PR #${pr} (item ${target.itemId}, ${disposition})`);
		const absFindingsPath = isAbsolute(findingsPath) ? findingsPath : resolve(findingsPath);
		const intent = parseCli(["--resume", target.itemId, "--review-findings", absFindingsPath]);
		if (intent.kind !== "run") {
			deps.err(intent.kind === "error" ? intent.message : USAGE);
			return 2;
		}
		// Hand execution exclusivity to the orchestrator: every attempt (the first one and
		// every post-park resume) reacquires the per-item lease and releases it when the
		// attempt ends, so a park never pins the lease across a reset sleep (#507 round 3).
		// Released here first because the orchestrator acquires the same register — a
		// same-process hold would refuse as "held by pid <self>". The in-process handoff gap
		// is fail-closed: a concurrent acquirer makes the orchestrator refuse loudly, naming
		// the holder; it can never produce an unleased run.
		await exec.lease.release();
		const orchDeps: OrchestratorDeps = { mode: "operator-revision" };
		const { exitCode } = await deps.runOrchestrator(intent.flags, orchDeps);
		return exitCode;
	} finally {
		await exec.lease.release(); // idempotent — covers every pre-flight failure return
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main(process.argv.slice(2)).then((code) => process.exit(code));
}
