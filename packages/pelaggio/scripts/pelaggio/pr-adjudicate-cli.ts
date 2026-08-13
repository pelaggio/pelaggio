#!/usr/bin/env tsx

/**
 * `pelaggio pr-adjudicate --pr <n> [--profile <name>]` — local-operator clearance of a
 * findings-terminal review gate after a narrowly fixed PR revision (#497).
 *
 * Fail-closed: the deterministic interdiff predicate and the pinned-SHA `review=success`
 * status are the authorization. Effects are record → required comment → status last.
 * Exit codes: 0 success, 1 refused / failed effect, 2 usage / config.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CONFIG, REPO, REVIEW_CONFIG, ROADMAP_GITHUB, resolveStepSettings, SHIP_TARGET, type StepSettings } from "./config.js";
import { mainWorktree } from "./helpers.js";
import { executionOverrideFor, trustedLocalContext, verificationPrompt } from "./pr-review-cli.js";
import { gateRecordsDir, listPrReviewGateRecords, type PrReviewGateRecord, writePrReviewGateRecord } from "./pr-review-gate-record.js";
import {
	adjudicationSourcesDir,
	bindLiveSafetyVerification,
	buildOperatorGateRecord,
	crossCheckAdjudicationSource,
	evaluateInterdiffPolicy,
	isEligibleFleetGateRecord,
	type LiveSafetyRefutation,
	readAdjudicationSourceRecord,
	renderOperatorAdjudicationComment,
	selectLatestFleetGateRecord,
} from "./review/adjudication.js";
import { modelAuthoredText, parseReviewVerification, reconcileReviewVerification, reviewFindingFingerprint, type VerificationCandidate, type VerificationDisposition } from "./review/findings.js";
import { cleanupReviewHead, postReviewStatus, prepareReviewHead, type ReviewCandidate, upsertReviewComment } from "./review-sweep.js";
import { autopilotManagedState, CLAIM_BRANCH_RE } from "./revise-sweep.js";
import { defaultGhRun, type GhRunner, parseGhJson } from "./roadmap/github-issues.js";
import { type RunStepFn, runStep } from "./step-runner.js";
import type { ParkSignal, ShipTargetName } from "./types.js";

const USAGE = "usage: pelaggio pr-adjudicate --pr <number> [--profile <name>]";

export interface PrAdjudicateDeps {
	repo: string;
	ghRepo: string;
	shipTargetName: ShipTargetName;
	reviewRunner: "ci" | "local";
	gh: GhRunner;
	execFileSync: typeof execFileSync;
	log: (msg: string) => void;
	err: (msg: string) => void;
	now: () => number;
	mainWorktree: (repo: string) => string;
	listGateRecords: typeof listPrReviewGateRecords;
	gateRecordsRoot: string;
	adjudicationSourcesRoot: string;
	readAdjudicationSource: typeof readAdjudicationSourceRecord;
	readFileSync: typeof readFileSync;
	writeGateRecord: typeof writePrReviewGateRecord;
	prepareReviewHead: typeof prepareReviewHead;
	cleanupReviewHead: typeof cleanupReviewHead;
	runStep: RunStepFn;
	resolveVerifySettings: (profile: string) => StepSettings;
	upsertComment: typeof upsertReviewComment;
	postStatus: typeof postReviewStatus;
	managedState: (itemId: string) => "managed" | "unmanaged" | "unknown";
	isCi: boolean;
	isSingleShot: boolean;
}

export type ParsedPrAdjudicateArgs = { kind: "run"; pr: number; profile: string } | { kind: "error"; message: string };

interface PrSnapshot {
	itemId: string;
	branch: string;
	headSha: string;
}

function isPrShipTarget(name: string): name is "pull-request" | "auto-merge-pr" {
	return name === "pull-request" || name === "auto-merge-pr";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameRepo(pr: { headRepository?: { nameWithOwner?: string; owner?: { login?: string }; name?: string } | null; headRepositoryOwner?: { login?: string } | null }, ghRepo: string): boolean {
	if (pr.headRepository?.nameWithOwner) return pr.headRepository.nameWithOwner.toLowerCase() === ghRepo.toLowerCase();
	const [owner, repo] = ghRepo.split("/");
	const headOwner = pr.headRepositoryOwner?.login ?? pr.headRepository?.owner?.login;
	const headName = pr.headRepository?.name;
	return !!headOwner && !!headName && headOwner.toLowerCase() === owner?.toLowerCase() && headName.toLowerCase() === repo?.toLowerCase();
}

function defaultDeps(): PrAdjudicateDeps {
	const gh = defaultGhRun;
	const ghRepo = ROADMAP_GITHUB.ghRepo;
	const repo = REPO;
	return {
		repo,
		ghRepo,
		shipTargetName: SHIP_TARGET,
		reviewRunner: REVIEW_CONFIG.runner,
		gh,
		execFileSync,
		log: (msg) => {
			console.log(msg);
		},
		err: (msg) => {
			console.error(msg);
		},
		now: () => Date.now(),
		mainWorktree,
		listGateRecords: listPrReviewGateRecords,
		gateRecordsRoot: gateRecordsDir(mainWorktree(repo)),
		adjudicationSourcesRoot: adjudicationSourcesDir(mainWorktree(repo)),
		readAdjudicationSource: readAdjudicationSourceRecord,
		readFileSync,
		writeGateRecord: writePrReviewGateRecord,
		prepareReviewHead,
		cleanupReviewHead,
		runStep,
		resolveVerifySettings: (profile) => resolveStepSettings(CONFIG, profile, "pr-verify"),
		upsertComment: upsertReviewComment,
		postStatus: postReviewStatus,
		managedState: (itemId) => autopilotManagedState(gh, ghRepo, itemId, ROADMAP_GITHUB.label),
		isCi: process.env.CI === "true",
		isSingleShot: process.env.PELAGGIO_SINGLE_SHOT === "1",
	};
}

export function parsePrAdjudicateArgs(argv: string[]): ParsedPrAdjudicateArgs {
	let values: { pr?: string; profile?: string };
	try {
		({ values } = parseArgs({
			args: argv,
			options: { pr: { type: "string" }, profile: { type: "string" } },
			allowPositionals: false,
		}));
	} catch (e) {
		return { kind: "error", message: `${e instanceof Error ? e.message : String(e)}\n${USAGE}` };
	}
	const prRaw = values.pr;
	if (!prRaw || !/^\d+$/.test(prRaw) || Number(prRaw) <= 0) return { kind: "error", message: USAGE };
	return { kind: "run", pr: Number(prRaw), profile: values.profile ?? "standard" };
}

function snapshotPr(deps: PrAdjudicateDeps, pr: number): { kind: "ok"; snapshot: PrSnapshot } | { kind: "error"; code: 1; message: string } {
	const viewed = deps.gh(["pr", "view", String(pr), "--repo", deps.ghRepo, "--json", "state,isDraft,headRefName,headRefOid,headRepository,headRepositoryOwner"]);
	if (viewed.status !== 0) return { kind: "error", code: 1, message: `could not load pull request #${pr}` };
	let payload: {
		state?: string;
		isDraft?: boolean;
		headRefName?: string;
		headRefOid?: string;
		headRepository?: { nameWithOwner?: string; owner?: { login?: string }; name?: string } | null;
		headRepositoryOwner?: { login?: string } | null;
	};
	try {
		payload = parseGhJson(viewed.stdout, isObject);
	} catch {
		return { kind: "error", code: 1, message: "malformed pull request payload" };
	}
	if (payload.isDraft) return { kind: "error", code: 1, message: "pull request is a draft" };
	if ((payload.state ?? "").toUpperCase() !== "OPEN") return { kind: "error", code: 1, message: "pull request is not open" };
	if (!sameRepo(payload, deps.ghRepo)) return { kind: "error", code: 1, message: "pull request head is from another repository" };
	const branch = payload.headRefName ?? "";
	const itemId = branch.match(CLAIM_BRANCH_RE)?.[1];
	if (!itemId) return { kind: "error", code: 1, message: "head branch is not a pelaggio claim branch" };
	const headSha = payload.headRefOid ?? "";
	if (!/^[0-9a-fA-F]{40}$/.test(headSha)) return { kind: "error", code: 1, message: "pull request head OID unavailable" };
	return { kind: "ok", snapshot: { itemId, branch, headSha } };
}

function refuse(deps: PrAdjudicateDeps, message: string, code: 1 | 2 = 1): number {
	deps.err(message);
	return code;
}

function emptyParkSignal(): ParkSignal {
	return { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };
}

function fleetFilePath(root: string, record: PrReviewGateRecord): string {
	return resolve(root, `${record.prNumber}-${record.headSha}.json`);
}

export async function runPrAdjudication(pr: number, profile: string, deps: PrAdjudicateDeps): Promise<number> {
	if (!deps.ghRepo) return refuse(deps, "no GitHub repo configured — set roadmap.github.repo in .pelaggio.yml", 2);
	if (deps.reviewRunner !== "local") return refuse(deps, "pelaggio pr-adjudicate requires review.runner: local", 2);
	if (!isPrShipTarget(deps.shipTargetName)) return refuse(deps, `pelaggio pr-adjudicate requires a PR ship target (got ${deps.shipTargetName})`, 2);
	if (deps.isCi || deps.isSingleShot) return refuse(deps, "pelaggio pr-adjudicate refuses CI / PELAGGIO_SINGLE_SHOT", 2);
	if (deps.mainWorktree(deps.repo) !== deps.repo) return refuse(deps, "pelaggio pr-adjudicate must run from the main checkout", 2);

	const first = snapshotPr(deps, pr);
	if (first.kind === "error") return refuse(deps, first.message, first.code);
	const { itemId, branch, headSha } = first.snapshot;

	const managed = deps.managedState(itemId);
	if (managed === "unknown") return refuse(deps, "could not determine whether the linked issue is pelaggio-managed (github lookup failed); retry");
	if (managed === "unmanaged") return refuse(deps, "linked issue is not a pelaggio-managed item");

	const actor = deps.gh(["api", "user", "--jq", ".login"]);
	const adjudicator = actor.stdout.trim();
	if (actor.status !== 0 || adjudicator.length === 0) return refuse(deps, "could not resolve the authenticated adjudicator");

	const latest = selectLatestFleetGateRecord(deps.listGateRecords(deps.gateRecordsRoot), pr);
	if (!latest) return refuse(deps, "no local fleet review record for this PR; run a full pr-review first");
	if (!isEligibleFleetGateRecord(latest)) {
		return refuse(deps, "latest fleet outcome is not an adjudicable complete consensus-block; run a full pr-review");
	}

	const source = deps.readAdjudicationSource(deps.adjudicationSourcesRoot, pr, latest.headSha);
	if (!source) return refuse(deps, "no typed adjudication source evidence for the reviewed SHA; run a full local pr-review (legacy and CI-only reviews cannot be reconstructed)");
	let fleetBytes: Buffer;
	try {
		fleetBytes = deps.readFileSync(fleetFilePath(deps.gateRecordsRoot, latest));
	} catch {
		return refuse(deps, "could not read the bound fleet gate record");
	}
	const bound = crossCheckAdjudicationSource(source, latest, fleetBytes, { prNumber: pr, itemId });
	if (!bound.ok) return refuse(deps, bound.reason);

	const candidate: ReviewCandidate = { prNumber: pr, itemId, branch, headSha, statusState: "missing" };
	const headRef = `refs/pelaggio-adjudicate/pr-${pr}`;
	let prepared: { diffCwd: string; baseRef: string; headRef: string } | null = null;
	let checkoutReady = false;
	try {
		prepared = deps.prepareReviewHead(deps.repo, candidate, undefined, headRef);
		if (!prepared) return refuse(deps, "could not prepare a detached checkout of the current PR head");
		checkoutReady = true;

		let isAncestor = false;
		try {
			deps.execFileSync("git", ["merge-base", "--is-ancestor", source.reviewedSha, headSha], { cwd: deps.repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
			isAncestor = true;
		} catch {
			isAncestor = false;
		}
		let interdiff: Buffer;
		try {
			const raw = deps.execFileSync("git", ["diff", "--no-ext-diff", "--binary", "--unified=0", `${source.reviewedSha}..${headSha}`, "--"], {
				cwd: deps.repo,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			interdiff = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf8");
		} catch (e) {
			return refuse(deps, `could not compute the interdiff: ${e instanceof Error ? e.message : String(e)}`);
		}

		const churn = evaluateInterdiffPolicy({ isAncestor, interdiff, survivors: source.survivors });
		if (churn.kind === "refused") return refuse(deps, churn.reason);
		// Durable dispositions: containment rationales from the churn predicate, with safety-tier
		// entries rebound below to the LIVE adjudication-time verification evidence — never the
		// stale red-review "survives" text (#497 must-fix).
		let finalDispositions = churn.dispositions;

		const safety = source.survivors.filter((entry) => entry.tier === "safety");
		if (safety.length > 0) {
			const candidates: VerificationCandidate[] = safety.map((entry, index) => ({ id: `C${index + 1}`, finding: entry.finding }));
			const parkSignal = emptyParkSignal();
			const verifySettings = deps.resolveVerifySettings(profile);
			const localContext = trustedLocalContext({ diffCwd: prepared.diffCwd, diffBaseRef: prepared.baseRef, diffHeadRef: prepared.headRef });
			let result: Awaited<ReturnType<RunStepFn>>;
			try {
				result = await deps.runStep("pr-verify", verificationPrompt(candidates, localContext), { cwd: deps.repo, profile, trace: false, parkSignal, itemId, executionOverride: executionOverrideFor(verifySettings) }, () => {});
			} catch (e) {
				return refuse(deps, `verifier execution threw: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (parkSignal.parked || result.subtype === "error_rate_limit") return refuse(deps, "verifier hit a rate limit; retry pr-adjudicate after the reset");
			if (!result.ok) return refuse(deps, `verifier run did not complete cleanly (${result.subtype})`);
			let dispositions: VerificationDisposition[];
			try {
				dispositions = reconcileReviewVerification(candidates, parseReviewVerification(modelAuthoredText(result)));
			} catch (e) {
				return refuse(deps, `invalid verification report: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (dispositions.some((entry) => entry.decision === "survives")) return refuse(deps, "safety verifier reported a surviving finding; run a full pr-review");
			if (!dispositions.every((entry) => entry.decision === "refuted")) return refuse(deps, "safety verification was incomplete");
			const live = new Map<string, LiveSafetyRefutation>();
			for (const entry of dispositions) {
				if (entry.decision !== "refuted") continue;
				live.set(reviewFindingFingerprint(entry.finding), { id: entry.id, decision: "refuted", rationale: entry.rationale });
			}
			try {
				finalDispositions = bindLiveSafetyVerification(source.survivors, churn.dispositions, live);
			} catch (e) {
				return refuse(deps, `could not bind live verification evidence: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		const beforeEffects = snapshotPr(deps, pr);
		if (beforeEffects.kind === "error") return refuse(deps, beforeEffects.message, beforeEffects.code);
		if (beforeEffects.snapshot.headSha !== headSha) return refuse(deps, "PR head changed after inspection; refusing without authorization effects");

		const operatorRecord = buildOperatorGateRecord({
			prNumber: pr,
			itemId,
			headSha,
			reviewedSourceSha: source.reviewedSha,
			interdiffDigest: churn.digest,
			adjudicator,
			dispositions: finalDispositions,
			reviewedAt: new Date(deps.now()).toISOString(),
		});
		try {
			deps.writeGateRecord(deps.gateRecordsRoot, operatorRecord);
		} catch (e) {
			return refuse(deps, `could not persist operator gate record: ${e instanceof Error ? e.message : String(e)}`);
		}

		const body = renderOperatorAdjudicationComment({
			prNumber: pr,
			sourceSha: source.reviewedSha,
			headSha,
			interdiffDigest: churn.digest,
			adjudicator,
			survivors: source.survivors,
			dispositions: finalDispositions,
		});
		if (!deps.upsertComment(deps.gh, deps.ghRepo, pr, body)) return refuse(deps, "failed to upsert the operator adjudication comment");

		const beforeStatus = snapshotPr(deps, pr);
		if (beforeStatus.kind === "error") return refuse(deps, beforeStatus.message, beforeStatus.code);
		if (beforeStatus.snapshot.headSha !== headSha) return refuse(deps, "PR head changed before status post; refusing to green a new head");

		if (!deps.postStatus(deps.gh, deps.ghRepo, headSha, "success", "local pelaggio operator adjudication passed")) {
			return refuse(deps, "failed to post the review success status; retry pr-adjudicate");
		}

		const afterStatus = snapshotPr(deps, pr);
		if (afterStatus.kind === "error") return refuse(deps, afterStatus.message, afterStatus.code);
		if (afterStatus.snapshot.headSha !== headSha) return refuse(deps, "PR head changed after status post; the new head is not authorized");

		deps.log(`adjudicated PR #${pr} ${source.reviewedSha.slice(0, 8)} → ${headSha.slice(0, 8)}`);
		return 0;
	} finally {
		if (checkoutReady) deps.cleanupReviewHead(deps.repo, candidate, undefined, headRef);
	}
}

export async function main(argv: string[], overrides: Partial<PrAdjudicateDeps> = {}): Promise<number> {
	const deps: PrAdjudicateDeps = { ...defaultDeps(), ...overrides };
	if ((overrides.gh || overrides.ghRepo) && !overrides.managedState) {
		deps.managedState = (itemId) => autopilotManagedState(deps.gh, deps.ghRepo, itemId, ROADMAP_GITHUB.label);
	}
	if (overrides.repo && !overrides.gateRecordsRoot) deps.gateRecordsRoot = gateRecordsDir(deps.mainWorktree(deps.repo));
	if (overrides.repo && !overrides.adjudicationSourcesRoot) deps.adjudicationSourcesRoot = adjudicationSourcesDir(deps.mainWorktree(deps.repo));

	const parsed = parsePrAdjudicateArgs(argv);
	if (parsed.kind === "error") return refuse(deps, parsed.message, 2);
	return runPrAdjudication(parsed.pr, parsed.profile, deps);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main(process.argv.slice(2)).then((code) => process.exit(code));
}
