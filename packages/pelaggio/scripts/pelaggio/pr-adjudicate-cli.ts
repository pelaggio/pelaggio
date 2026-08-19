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
import { withFileLock } from "./file-lock.js";
import { upsertMarkerComment } from "./github-posting.js";
import { createMainCheckoutDeltaObserver, FORBIDDEN_ROOT_GONE, listWorktreesIn, type MainCheckoutDeltaObserver, mainWorktree, snapshotForbiddenRoot, snapshotRepoRefState, snapshotSiblingWorktree } from "./helpers.js";
import { executionOverrideFor, trustedLocalContext, verificationPrompt } from "./pr-review-cli.js";
import { gateRecordsDir, type PrReviewGateRecord, prReviewGateRecordPath, validatePrReviewGateRecord, writePrReviewGateRecord } from "./pr-review-gate-record.js";
import {
	adjudicationSourceRecordPath,
	adjudicationSourcesDir,
	bindLiveSafetyVerification,
	buildOperatorGateRecord,
	crossCheckAdjudicationSource,
	evaluateInterdiffPolicy,
	fleetRecordDigestOf,
	isEligibleFleetGateRecord,
	type LiveSafetyRefutation,
	PR_ADJUDICATION_MARKER,
	type PrAdjudicationSourceRecordV1,
	renderOperatorAdjudicationComment,
	validateAdjudicationSourceRecord,
} from "./review/adjudication.js";
import { modelAuthoredText, parseReviewVerification, reconcileReviewVerification, reviewFindingFingerprint, type VerificationCandidate, type VerificationDisposition } from "./review/findings.js";
import { buildReviewEvidencePayload, parseReviewEvidenceDescription, resolveReviewEvidencePubKey, verifyReviewEvidence } from "./review/gate-attestation.js";
import { REVIEW_DRAIN_LOCK_STALE_MS, reviewDrainLockPath, reviewRequestsDir } from "./review-request-queue.js";
import { cleanupReviewHead, postReviewStatus, prepareReviewHead, type ReviewCandidate, readReviewStatusForSha } from "./review-sweep.js";
import { autopilotManagedState, CLAIM_BRANCH_RE } from "./revise-sweep.js";
import { defaultGhRun, type GhRunner, parseGhJson } from "./roadmap/github-issues.js";
import { type RunStepFn, runStep } from "./step-runner.js";
import type { ParkSignal, ShipTargetName } from "./types.js";

const USAGE = "usage: pelaggio pr-adjudicate --pr <number> [--profile <name>]";

/** Hard cap on the paginated PR commit list. Never silently truncate. */
const PR_COMMIT_LIST_CAP = 250;

const FRESH_REVIEW = "run a full local pr-review";

/** Review-head directory suffix (#510): keeps adjudication's checkout at `<sha>-adjudicate`,
 *  disjoint from a concurrent drain's `<sha>` checkout, so the finally-block force-remove can
 *  never tear down the drain's live worktree at the same head SHA. */
const ADJUDICATION_HEAD_SUFFIX = "-adjudicate";

/** Upsert the operator PASS comment under its own marker (#510) — never the fleet
 *  `<!-- pelaggio-pr-review -->` marker that `fetchReviewFindings` scrapes into revise prompts. */
export function upsertAdjudicationComment(gh: GhRunner, ghRepo: string, prNumber: number, body: string): boolean {
	return upsertMarkerComment(gh, ghRepo, prNumber, PR_ADJUDICATION_MARKER, body);
}

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
	reviewQueueRoot?: string;
	gateRecordsRoot: string;
	adjudicationSourcesRoot: string;
	readFileSync: typeof readFileSync;
	/** Out-of-band verification key. Tests pin a generated SPKI PEM. */
	reviewEvidencePubKey?: string;
	writeGateRecord: typeof writePrReviewGateRecord;
	prepareReviewHead: typeof prepareReviewHead;
	cleanupReviewHead: typeof cleanupReviewHead;
	runStep: RunStepFn;
	resolveVerifySettings: (profile: string) => StepSettings;
	/** #510: registered Git worktree roots — the verifier's foreign-root Write/Edit denial set. */
	listWorktrees: (repo: string) => string[];
	/** #510: porcelain snapshot of the authenticated main checkout, taken around the verifier run. */
	snapshotMainRoot: (root: string) => string;
	/** #510 round-2 (2a): HEAD + ref-state digest of the main checkout — detects clean-to-clean
	 *  mutations (an `--allow-empty` commit, a bare ref move) that porcelain cannot see. */
	snapshotRepoRefState: (root: string) => string;
	/** #510 round-2 (2b): porcelain + HEAD snapshot of a registered sibling worktree. */
	snapshotSiblingWorktree: (root: string) => string;
	/** #510: delta observer bracketing the verifier's mutating tools against the main checkout. */
	createCheckoutObserver: (root: string) => MainCheckoutDeltaObserver;
	upsertComment: typeof upsertAdjudicationComment;
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
		reviewQueueRoot: reviewRequestsDir(mainWorktree(repo)),
		gateRecordsRoot: gateRecordsDir(mainWorktree(repo)),
		adjudicationSourcesRoot: adjudicationSourcesDir(mainWorktree(repo)),
		readFileSync,
		reviewEvidencePubKey: resolveReviewEvidencePubKey(),
		writeGateRecord: writePrReviewGateRecord,
		prepareReviewHead,
		cleanupReviewHead,
		runStep,
		resolveVerifySettings: (profile) => resolveStepSettings(CONFIG, profile, "pr-verify"),
		listWorktrees: listWorktreesIn,
		snapshotMainRoot: snapshotForbiddenRoot,
		snapshotRepoRefState,
		snapshotSiblingWorktree,
		createCheckoutObserver: createMainCheckoutDeltaObserver,
		upsertComment: upsertAdjudicationComment,
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

function listPrCommits(deps: PrAdjudicateDeps, pr: number): { kind: "ok"; shas: string[] } | { kind: "error"; message: string } {
	// `--slurp` collects the `--paginate` pages into ONE top-level array-of-arrays (one element per
	// page). Without it, a PR spanning more than one API page emits as concatenated JSON arrays
	// (`[...][...]`) that `JSON.parse` rejects, so the 250-commit adjudication path was refused as
	// malformed (#511 must-fix). Flatten the pages here so every commit across every page is seen.
	const listed = deps.gh(["api", "--paginate", "--slurp", `repos/${deps.ghRepo}/pulls/${pr}/commits`]);
	if (listed.status !== 0) return { kind: "error", message: `could not list pull request commits; ${FRESH_REVIEW}` };
	let pages: unknown;
	try {
		pages = parseGhJson<unknown>(listed.stdout, (v) => Array.isArray(v));
	} catch {
		return { kind: "error", message: `malformed pull request commit list; ${FRESH_REVIEW}` };
	}
	if (!Array.isArray(pages)) return { kind: "error", message: `malformed pull request commit list; ${FRESH_REVIEW}` };
	const parsed: unknown[] = [];
	for (const page of pages) {
		if (!Array.isArray(page)) return { kind: "error", message: `malformed pull request commit list; ${FRESH_REVIEW}` };
		for (const entry of page) parsed.push(entry);
	}
	if (parsed.length === 0) return { kind: "error", message: `pull request commit list is empty; ${FRESH_REVIEW}` };
	if (parsed.length > PR_COMMIT_LIST_CAP) {
		return { kind: "error", message: `pull request has more than ${PR_COMMIT_LIST_CAP} commits; refusing to silently truncate — ${FRESH_REVIEW}` };
	}
	const shas: string[] = [];
	for (const entry of parsed) {
		if (!isObject(entry) || typeof entry.sha !== "string" || !/^[0-9a-fA-F]{40}$/.test(entry.sha)) {
			return { kind: "error", message: `malformed pull request commit list; ${FRESH_REVIEW}` };
		}
		shas.push(entry.sha);
	}
	return { kind: "ok", shas };
}

function resolveSignedRedEvidence(deps: PrAdjudicateDeps, pr: number, headSha: string): { kind: "ok"; reviewedSha: string; signature: string } | { kind: "error"; message: string } {
	const listed = listPrCommits(deps, pr);
	if (listed.kind === "error") return listed;
	const snapshotIndex = listed.shas.findIndex((sha) => sha.toLowerCase() === headSha.toLowerCase());
	if (snapshotIndex < 0) return { kind: "error", message: `snapshotted head is not in the pull request commit list; ${FRESH_REVIEW}` };
	for (let i = snapshotIndex; i >= 0; i--) {
		const sha = listed.shas[i];
		if (!sha) continue;
		const probe = readReviewStatusForSha(deps.gh, deps.ghRepo, sha);
		if (probe.kind === "error") return { kind: "error", message: `could not read review status for ${sha}; ${FRESH_REVIEW}` };
		if (probe.kind === "missing") continue;
		if (probe.state.toUpperCase() !== "FAILURE") {
			return { kind: "error", message: `nearest review status is not a signed red fleet result; ${FRESH_REVIEW}` };
		}
		const signature = parseReviewEvidenceDescription(probe.description);
		if (!signature) return { kind: "error", message: `nearest review status is not a signed red fleet result; ${FRESH_REVIEW}` };
		return { kind: "ok", reviewedSha: sha, signature };
	}
	return { kind: "error", message: `no signed red review evidence on this pull request; ${FRESH_REVIEW}` };
}

function verifyBoundEvidence(deps: PrAdjudicateDeps, pr: number, itemId: string, reviewedSha: string, signature: string): { kind: "ok"; source: PrAdjudicationSourceRecordV1 } | { kind: "error"; message: string } {
	const pubKey = deps.reviewEvidencePubKey ?? resolveReviewEvidencePubKey();
	if (!pubKey) return { kind: "error", message: `no review-evidence trust anchor is configured; set PELAGGIO_REVIEW_EVIDENCE_PUBKEY and ${FRESH_REVIEW}` };
	// #511 TOCTOU: read the exact fleet/source bytes ONCE. The signature authenticates THESE
	// buffers; every object consumed downstream (eligibility, cross-check, and the returned source
	// the caller uses for interdiff + the green status) is parsed from them — never reread from the
	// mutable path, where a concurrent writer could swap a schema-valid forgery between reads.
	let fleetBytes: Buffer;
	let sourceBytes: Buffer;
	try {
		fleetBytes = deps.readFileSync(prReviewGateRecordPath(deps.gateRecordsRoot, pr, reviewedSha));
		sourceBytes = deps.readFileSync(adjudicationSourceRecordPath(deps.adjudicationSourcesRoot, pr, reviewedSha));
	} catch {
		return { kind: "error", message: `could not read the bound fleet/source records; ${FRESH_REVIEW}` };
	}
	let payload: string;
	try {
		payload = buildReviewEvidencePayload({
			repository: deps.ghRepo,
			prNumber: pr,
			itemId,
			reviewedSha: reviewedSha.toLowerCase(),
			fleetRecordSha256: fleetRecordDigestOf(fleetBytes),
			adjudicationSourceSha256: fleetRecordDigestOf(sourceBytes),
		});
	} catch {
		return { kind: "error", message: `signed evidence identity is malformed; ${FRESH_REVIEW}` };
	}
	if (!verifyReviewEvidence(payload, pubKey, signature)) {
		return { kind: "error", message: `review evidence signature does not verify; ${FRESH_REVIEW}` };
	}
	// Parse the authenticated records from the SAME verified buffers — no filesystem round-trip.
	let latest: PrReviewGateRecord;
	let source: PrAdjudicationSourceRecordV1;
	try {
		latest = validatePrReviewGateRecord(JSON.parse(fleetBytes.toString("utf8")));
		source = validateAdjudicationSourceRecord(JSON.parse(sourceBytes.toString("utf8")));
	} catch {
		return { kind: "error", message: `bound fleet/source records are malformed; ${FRESH_REVIEW}` };
	}
	// Identity guards the SHA-keyed record readers enforce (path key ↔ record content).
	if (latest.prNumber !== pr || latest.headSha.toLowerCase() !== reviewedSha.toLowerCase()) {
		return { kind: "error", message: `bound fleet record identity does not match the signed SHA; ${FRESH_REVIEW}` };
	}
	if (source.prNumber !== pr || source.reviewedSha !== reviewedSha.toLowerCase()) {
		return { kind: "error", message: `bound source record identity does not match the signed SHA; ${FRESH_REVIEW}` };
	}
	if (!isEligibleFleetGateRecord(latest)) {
		return { kind: "error", message: `latest fleet outcome is not an adjudicable complete consensus-block; ${FRESH_REVIEW}` };
	}
	const bound = crossCheckAdjudicationSource(source, latest, fleetBytes, { prNumber: pr, itemId });
	if (!bound.ok) return { kind: "error", message: bound.reason };
	return { kind: "ok", source };
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

	// #511: forge history selects the nearest review status; the detached signature on
	// that status authenticates the exact local fleet/source bytes. `.dev` files are
	// durable evidence bytes only — no field stored solely there can authorize.
	const selected = resolveSignedRedEvidence(deps, pr, headSha);
	if (selected.kind === "error") return refuse(deps, selected.message);
	const verified = verifyBoundEvidence(deps, pr, itemId, selected.reviewedSha, selected.signature);
	if (verified.kind === "error") return refuse(deps, verified.message);
	// #511 TOCTOU: consume the source record parsed from the exact verified bytes — never a fresh
	// reread of the mutable path, which a concurrent writer could have swapped after verification.
	const source = verified.source;

	const candidate: ReviewCandidate = { prNumber: pr, itemId, branch, headSha, statusState: "missing" };
	const headRef = `refs/pelaggio-adjudicate/pr-${pr}`;
	let prepared: { diffCwd: string; baseRef: string; headRef: string } | null = null;
	try {
		prepared = deps.prepareReviewHead(deps.repo, candidate, undefined, headRef, ADJUDICATION_HEAD_SUFFIX);
		if (!prepared) return refuse(deps, "could not prepare a detached checkout of the current PR head");

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
			// #510 must-fix: the verifier consumes attacker-influenced text (finding messages, the
			// inspected PR head), so it runs under the SAME confinement the pipeline threads into
			// its pr-verify seats — never from the authenticated main checkout with allow-all tools:
			//   - cwd is the DETACHED data-only review-head checkout prepared above, so Codex's
			//     workspace-write sandbox roots there instead of in the trusted main tree;
			//   - foreignRootDenial (the step-runner's PreToolUse hook seam, pipeline.ts fan-out
			//     wiring) denies Write/Edit into main and every registered worktree, plus the
			//     sessions/decision-log registers;
			//   - a main-checkout delta observer brackets mutating tools, and before/after
			//     snapshots backstop providers without hook support: main's porcelain PLUS its
			//     HEAD + for-each-ref digest (clean-to-clean commits and ref moves), plus a
			//     porcelain + HEAD snapshot of every registered sibling worktree (#510 round-2).
			// Any observed mutation or audit failure refuses BEFORE any authorization effect
			// (record, comment, or status).
			const registeredWorktrees = deps.listWorktrees(deps.repo);
			const observer = deps.createCheckoutObserver(deps.repo);
			let mainBefore: string;
			try {
				mainBefore = deps.snapshotMainRoot(deps.repo);
			} catch (e) {
				return refuse(deps, `could not snapshot the main checkout before verification: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (mainBefore === FORBIDDEN_ROOT_GONE) return refuse(deps, "main checkout is not observable as a Git root; refusing to run the verifier");
			// #510 round-2 (2a): porcelain cannot see clean-to-clean mutations — `git -C <main>
			// commit --allow-empty` or a bare ref move leaves it identical — so also bracket the
			// verifier with main's HEAD + a digest of `git for-each-ref` (the shared ref store, so
			// branch moves made from ANY worktree are visible here).
			let mainRefsBefore: string;
			try {
				mainRefsBefore = deps.snapshotRepoRefState(deps.repo);
			} catch (e) {
				return refuse(deps, `could not snapshot the main checkout ref state before verification: ${e instanceof Error ? e.message : String(e)}`);
			}
			// #510 round-2 (2b): the foreign-root denial registers sibling worktrees, but the audit
			// previously observed only main — opaque Bash could mutate an unaudited sibling and still
			// reach the success status. Snapshot every REGISTERED worktree (the same enumeration the
			// denial uses) except the main root (audited above, more strongly) and the verifier's own
			// detached review-head cwd (its only permitted write surface). Residual: these audits
			// observe outcomes; they do not confine execution. Opaque Bash outside the hook seam —
			// providers without semantic deny, or effects beyond the audited roots — stays possible
			// until the chartered ADR-0023 execution-jail work lands.
			const mainRootAbs = resolve(deps.repo);
			const verifierCwdAbs = resolve(prepared.diffCwd);
			const auditedSiblings = [...new Set(registeredWorktrees.map((worktree) => resolve(worktree)))].filter((worktree) => worktree !== mainRootAbs && worktree !== verifierCwdAbs);
			const siblingsBefore = new Map<string, string>();
			for (const worktree of auditedSiblings) {
				try {
					siblingsBefore.set(worktree, deps.snapshotSiblingWorktree(worktree));
				} catch (e) {
					return refuse(deps, `could not snapshot sibling worktree ${worktree} before verification: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			let result: Awaited<ReturnType<RunStepFn>>;
			try {
				result = await deps.runStep(
					"pr-verify",
					verificationPrompt(candidates, localContext),
					{
						cwd: prepared.diffCwd,
						profile,
						trace: false,
						parkSignal,
						itemId,
						executionOverride: executionOverrideFor(verifySettings),
						foreignRootDenial: { mainRepo: deps.repo, registeredWorktrees },
						mainCheckoutObserver: observer,
					},
					() => {},
				);
			} catch (e) {
				return refuse(deps, `verifier execution threw: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (parkSignal.parked || result.subtype === "error_rate_limit") return refuse(deps, "verifier hit a rate limit; retry pr-adjudicate after the reset");
			if (!result.ok) return refuse(deps, `verifier run did not complete cleanly (${result.subtype})`);
			const attributed = observer.finish();
			if (attributed.kind === "error") return refuse(deps, `verifier confinement attribution failed: ${attributed.message}`);
			if (attributed.kind === "violation") return refuse(deps, "verifier mutated the main checkout; refusing without authorization effects");
			let mainAfter: string;
			try {
				mainAfter = deps.snapshotMainRoot(deps.repo);
			} catch (e) {
				return refuse(deps, `could not snapshot the main checkout after verification: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (mainAfter === FORBIDDEN_ROOT_GONE) return refuse(deps, "main checkout vanished during verification; refusing without authorization effects");
			if (mainAfter !== mainBefore) return refuse(deps, "main checkout changed during verification; refusing without authorization effects");
			let mainRefsAfter: string;
			try {
				mainRefsAfter = deps.snapshotRepoRefState(deps.repo);
			} catch (e) {
				return refuse(deps, `could not snapshot the main checkout ref state after verification: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (mainRefsAfter !== mainRefsBefore) {
				return refuse(deps, "main checkout HEAD or refs changed during verification (clean-to-clean commit or ref move); refusing without authorization effects");
			}
			for (const worktree of auditedSiblings) {
				let siblingAfter: string;
				try {
					siblingAfter = deps.snapshotSiblingWorktree(worktree);
				} catch (e) {
					return refuse(deps, `could not snapshot sibling worktree ${worktree} after verification: ${e instanceof Error ? e.message : String(e)}`);
				}
				if (siblingAfter !== siblingsBefore.get(worktree)) return refuse(deps, `sibling worktree ${worktree} changed during verification; refusing without authorization effects`);
			}
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

		let statusResult: number;
		try {
			statusResult = await withFileLock(
				reviewDrainLockPath(deps.reviewQueueRoot ?? reviewRequestsDir(deps.mainWorktree(deps.repo))),
				() => {
					const beforeStatus = snapshotPr(deps, pr);
					if (beforeStatus.kind === "error") return refuse(deps, beforeStatus.message, beforeStatus.code);
					if (beforeStatus.snapshot.headSha !== headSha) return refuse(deps, "PR head changed before status post; refusing to green a new head");
					// The forge-carried signed red is authorization input, so pin it across the
					// verifier/effect window just like the PR head. Holding the same lock as the
					// local review drain makes this freshness read atomic with the success post:
					// a same-SHA re-review cannot insert pending between them and be overwritten.
					const currentEvidence = resolveSignedRedEvidence(deps, pr, headSha);
					if (currentEvidence.kind === "error" || currentEvidence.reviewedSha.toLowerCase() !== selected.reviewedSha.toLowerCase() || currentEvidence.signature !== selected.signature) {
						return refuse(deps, `signed review status changed during adjudication; ${FRESH_REVIEW}`);
					}

					if (!deps.postStatus(deps.gh, deps.ghRepo, headSha, "success", "local pelaggio operator adjudication passed")) {
						return refuse(deps, "failed to post the review success status; retry pr-adjudicate");
					}

					const afterStatus = snapshotPr(deps, pr);
					if (afterStatus.kind === "error") return refuse(deps, afterStatus.message, afterStatus.code);
					if (afterStatus.snapshot.headSha !== headSha) return refuse(deps, "PR head changed after status post; the new head is not authorized");
					return 0;
				},
				{
					label: "review drain lock",
					staleMs: REVIEW_DRAIN_LOCK_STALE_MS,
					acquireTimeoutMs: REVIEW_DRAIN_LOCK_STALE_MS,
				},
			);
		} catch (e) {
			return refuse(deps, `could not acquire review drain lock: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (statusResult !== 0) return statusResult;

		deps.log(`adjudicated PR #${pr} ${source.reviewedSha.slice(0, 8)} → ${headSha.slice(0, 8)}`);
		return 0;
	} finally {
		// #510: prepareReviewHead's fetch creates refs/pelaggio-adjudicate/pr-<n> BEFORE its
		// readiness checks, so a null return can still have created the ref (head moved between
		// listing and fetch; worktree add failed) — gating cleanup on checkout readiness leaked
		// one ref per PR. cleanupReviewHead is best-effort and tolerates a missing worktree path
		// and a missing ref, so it runs whenever preparation was attempted.
		deps.cleanupReviewHead(deps.repo, candidate, undefined, headRef, ADJUDICATION_HEAD_SUFFIX);
	}
}

export async function main(argv: string[], overrides: Partial<PrAdjudicateDeps> = {}): Promise<number> {
	const deps: PrAdjudicateDeps = { ...defaultDeps(), ...overrides };
	if ((overrides.gh || overrides.ghRepo) && !overrides.managedState) {
		deps.managedState = (itemId) => autopilotManagedState(deps.gh, deps.ghRepo, itemId, ROADMAP_GITHUB.label);
	}
	if (overrides.repo && !overrides.gateRecordsRoot) deps.gateRecordsRoot = gateRecordsDir(deps.mainWorktree(deps.repo));
	if (overrides.repo && !overrides.adjudicationSourcesRoot) deps.adjudicationSourcesRoot = adjudicationSourcesDir(deps.mainWorktree(deps.repo));
	if (overrides.repo && !overrides.reviewQueueRoot) deps.reviewQueueRoot = reviewRequestsDir(deps.mainWorktree(deps.repo));

	const parsed = parsePrAdjudicateArgs(argv);
	if (parsed.kind === "error") return refuse(deps, parsed.message, 2);
	return runPrAdjudication(parsed.pr, parsed.profile, deps);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main(process.argv.slice(2)).then((code) => process.exit(code));
}
