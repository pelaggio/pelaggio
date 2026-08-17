import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULTS, type StepSettings } from "../config.js";
import { FORBIDDEN_ROOT_GONE, type MainCheckoutDeltaResult } from "../helpers.js";
import { main, type PrAdjudicateDeps, parsePrAdjudicateArgs } from "../pr-adjudicate-cli.js";
import { listPrReviewGateRecords, type NewPrReviewFleetGateRecord, readPrReviewGateRecord, writePrReviewGateRecord } from "../pr-review-gate-record.js";
import { type PrAdjudicationSourceRecordV1, type PrAdjudicationSurvivorEntry, readAdjudicationSourceRecord, writeAdjudicationSourceRecord } from "../review/adjudication.js";
import { materializeAuthoringFinding, type ReviewFinding, reviewFindingFingerprint } from "../review/findings.js";
import { BASELINE_TAXONOMY, tierOf } from "../review/taxonomy.js";
import type { GhRunner } from "../roadmap/github-issues.js";
import type { RunStepFn } from "../step-runner.js";
import type { ParkSignal, StepResult } from "../types.js";

const savedEnv: Record<string, string | undefined> = {};
before(() => {
	for (const key of ["CI", "PELAGGIO_SINGLE_SHOT"]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});
after(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const REVIEWED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NEW_HEAD = "cccccccccccccccccccccccccccccccccccccccc";
const dirs: string[] = [];

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "pr-adjudicate-cli-"));
	dirs.push(dir);
	return dir;
}

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
	return { severity: "must-fix", message: "Null deref in the parser.", path: "src/a.ts", line: 10, ...over };
}

function survivor(over: Partial<PrAdjudicationSurvivorEntry> = {}): PrAdjudicationSurvivorEntry {
	const base = over.finding ?? finding();
	const materialized = materializeAuthoringFinding(base, { changedFiles: ["src/a.ts"] }, BASELINE_TAXONOMY);
	return {
		finding: base,
		fingerprint: reviewFindingFingerprint(base),
		class: materialized.class,
		classification: materialized.classification,
		tier: tierOf(materialized.class, BASELINE_TAXONOMY),
		verification: { id: "C1", decision: "survives", rationale: "Confirmed against the inspected head." },
		hunk: { path: "src/a.ts", start: 8, end: 14 },
		...over,
	};
}

function fleet(over: Partial<NewPrReviewFleetGateRecord> = {}): NewPrReviewFleetGateRecord {
	return {
		producer: "fleet",
		prNumber: 497,
		headSha: REVIEWED,
		itemId: "497",
		gate: "block",
		ok: true,
		subtype: "consensus-block",
		agreement: "consensus-block",
		survivorCount: 1,
		cost: 1,
		costEstimated: false,
		turns: 4,
		runner: "local",
		reviewedAt: "2026-08-13T12:00:00.000Z",
		...over,
	};
}

function replacementDiff(): string {
	return ["diff --git a/src/a.ts b/src/a.ts", "index 1111111..2222222 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,1 +10,1 @@", "-old", "+new", ""].join("\n");
}

function prJson(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		state: "OPEN",
		isDraft: false,
		headRefName: "feat/issue-497-fix",
		headRefOid: HEAD,
		headRepository: { nameWithOwner: "o/r" },
		...over,
	});
}

function verification(decisions: unknown[], overrides: Partial<StepResult> = {}): StepResult {
	const text = `REVIEW_VERIFICATION\n${JSON.stringify({ schemaVersion: 1, decisions })}\nEND_REVIEW_VERIFICATION`;
	return { ok: true, subtype: "success", cost: 1, turns: 2, text, fullText: text, assistantText: text, ...overrides };
}

function verifySettings(): StepSettings {
	return {
		budget: DEFAULTS.budgets["pr-verify"],
		turns: DEFAULTS.turnLimits["pr-verify"],
		effort: DEFAULTS.effort["pr-verify"],
		model: "claude-opus-4-8",
		codexModel: "gpt-5-codex",
		grokModel: "grok-code-fast-1",
		openCodeModel: "openrouter/qwen",
		provider: "claude",
	};
}

interface Harness {
	deps: PrAdjudicateDeps;
	effects: string[];
	stepCalls: Array<{
		name: string;
		prompt: string;
		cwd: string;
		parkSignal: ParkSignal;
		executionOverride?: { provider: string; model?: string };
		foreignRootDenial?: { mainRepo: string; registeredWorktrees: readonly string[]; ownWorktree?: string };
		hasObserver: boolean;
	}>;
	logs: string[];
	errs: string[];
	repo: string;
	gateRoot: string;
	sourceRoot: string;
	heads: string[];
}

function seedEvidence(gateRoot: string, sourceRoot: string, entry: PrAdjudicationSurvivorEntry = survivor()): { digest: string } {
	const path = writePrReviewGateRecord(gateRoot, fleet());
	const bytes = readFileSync(path);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const record: PrAdjudicationSourceRecordV1 = {
		schemaVersion: 1,
		prNumber: 497,
		itemId: "497",
		reviewedSha: REVIEWED,
		agreement: "consensus-block",
		requiredCells: 1,
		completedCells: 1,
		survivorCount: 1,
		survivors: [entry],
		fleetRecordDigest: digest,
	};
	writeAdjudicationSourceRecord(sourceRoot, record);
	return { digest };
}

function harness(
	over: {
		prJson?: string | string[];
		user?: string;
		userStatus?: number;
		managed?: "managed" | "unmanaged" | "unknown";
		ghRepo?: string;
		shipTargetName?: "direct-push" | "pull-request" | "auto-merge-pr";
		reviewRunner?: "ci" | "local";
		isCi?: boolean;
		isSingleShot?: boolean;
		mainWorktree?: string;
		seed?: boolean;
		survivor?: PrAdjudicationSurvivorEntry;
		interdiff?: string;
		ancestor?: boolean;
		prepareOk?: boolean;
		verify?: StepResult | Error;
		commentOk?: boolean;
		statusOk?: boolean;
		writeGateOk?: boolean;
		prViewFail?: boolean;
		/** #510 confinement seams: successive main-checkout snapshots (last one repeats) and the
		 *  observer's finish() result. Defaults: clean snapshots, clean observer. */
		mainSnapshots?: string[];
		observerFinish?: MainCheckoutDeltaResult;
		/** #510 round-2 seams: successive HEAD+ref-state snapshots (last one repeats), extra
		 *  registered worktrees appended after the main root, and per-sibling snapshot queues. */
		refStateSnapshots?: string[];
		extraWorktrees?: string[];
		siblingSnapshots?: Record<string, string[]>;
	} = {},
): Harness {
	const repo = tmp();
	const gateRoot = join(repo, "gates");
	const sourceRoot = join(repo, "sources");
	if (over.seed !== false) seedEvidence(gateRoot, sourceRoot, over.survivor);
	const effects: string[] = [];
	const stepCalls: Harness["stepCalls"] = [];
	const logs: string[] = [];
	const errs: string[] = [];
	const heads = Array.isArray(over.prJson) ? [...over.prJson] : [];
	const silentGh: GhRunner = (args) => {
		effects.push(`gh:${args[0]}:${args[1] ?? ""}`);
		if (args[0] === "pr" && args[1] === "view") {
			if (over.prViewFail) return { stdout: "", stderr: "boom", status: 1 };
			const next = heads.length > 0 ? heads.shift()! : typeof over.prJson === "string" ? over.prJson : prJson();
			return { stdout: next, stderr: "", status: 0 };
		}
		if (args[0] === "api" && args[1] === "user") return { stdout: `${over.user ?? "operator"}\n`, stderr: "", status: over.userStatus ?? 0 };
		throw new Error(`unexpected gh call: ${args.join(" ")}`);
	};
	const runStep: RunStepFn = async (name, prompt, stepOpts) => {
		effects.push(`step:${name}`);
		stepCalls.push({
			name,
			prompt,
			cwd: stepOpts.cwd,
			parkSignal: stepOpts.parkSignal,
			executionOverride: stepOpts.executionOverride,
			foreignRootDenial: stepOpts.foreignRootDenial,
			hasObserver: stepOpts.mainCheckoutObserver !== undefined,
		});
		const next = over.verify ?? verification([{ candidateId: "C1", decision: "refuted", rationale: "Fixed in the current head." }]);
		if (next instanceof Error) throw next;
		if (next.subtype === "error_rate_limit") stepOpts.parkSignal.parked = true;
		return next;
	};
	const mainSnapshots = [...(over.mainSnapshots ?? [""])];
	const refStateSnapshots = [...(over.refStateSnapshots ?? ["head\nrefs-digest"])];
	const siblingQueues = new Map(Object.entries(over.siblingSnapshots ?? {}).map(([root, snaps]) => [root, [...snaps]]));
	const deps: PrAdjudicateDeps = {
		repo,
		ghRepo: over.ghRepo ?? "o/r",
		shipTargetName: over.shipTargetName ?? "pull-request",
		reviewRunner: over.reviewRunner ?? "local",
		gh: silentGh,
		execFileSync: ((cmd: string, args: readonly string[]) => {
			effects.push(`git:${args[0]}`);
			assert.equal(cmd, "git");
			if (args[0] === "merge-base") {
				if (over.ancestor === false) throw new Error("not ancestor");
				return "";
			}
			if (args[0] === "diff") return over.interdiff ?? replacementDiff();
			throw new Error(`unexpected git: ${args.join(" ")}`);
		}) as typeof import("node:child_process").execFileSync,
		log: (msg) => {
			logs.push(msg);
		},
		err: (msg) => {
			errs.push(msg);
		},
		now: () => Date.parse("2026-08-13T13:00:00Z"),
		mainWorktree: (cwd) => over.mainWorktree ?? cwd,
		listGateRecords: listPrReviewGateRecords,
		gateRecordsRoot: gateRoot,
		adjudicationSourcesRoot: sourceRoot,
		readAdjudicationSource: (root, prNumber, sha) => {
			effects.push(`read-source:${prNumber}:${sha}`);
			return readAdjudicationSourceRecord(root, prNumber, sha);
		},
		readFileSync,
		writeGateRecord: (root, record) => {
			effects.push(`write-gate:${record.producer}`);
			if (over.writeGateOk === false) throw new Error("record write failed");
			return writePrReviewGateRecord(root, record);
		},
		prepareReviewHead: (_repo, candidate, _exec, headRef, pathSuffix) => {
			effects.push(`prepare:${headRef ?? "default"}:${candidate.headSha}:${pathSuffix ?? ""}`);
			if (over.prepareOk === false) return null;
			return { diffCwd: "/tmp/adjudicate-head", baseRef: "origin/main", headRef: headRef ?? `refs/pelaggio-review/pr-${candidate.prNumber}` };
		},
		cleanupReviewHead: (_repo, _candidate, _exec, headRef, pathSuffix) => {
			effects.push(`cleanup:${headRef ?? "default"}:${pathSuffix ?? ""}`);
		},
		runStep,
		resolveVerifySettings: () => verifySettings(),
		listWorktrees: (forRepo) => {
			effects.push("list-worktrees");
			return [forRepo, ...(over.extraWorktrees ?? [])];
		},
		snapshotMainRoot: () => {
			effects.push("snapshot-main");
			const next = mainSnapshots.length > 1 ? mainSnapshots.shift()! : mainSnapshots[0]!;
			return next;
		},
		snapshotRepoRefState: () => {
			effects.push("snapshot-refs");
			return refStateSnapshots.length > 1 ? refStateSnapshots.shift()! : refStateSnapshots[0]!;
		},
		snapshotSiblingWorktree: (root) => {
			effects.push(`snapshot-sibling:${root}`);
			const queue = siblingQueues.get(root);
			if (!queue || queue.length === 0) return "\n@head";
			return queue.length > 1 ? queue.shift()! : queue[0]!;
		},
		createCheckoutObserver: () => {
			effects.push("observer:create");
			return {
				beforeTool: () => ({ kind: "clean" as const }),
				afterTool: () => ({ kind: "clean" as const }),
				finish: () => {
					effects.push("observer:finish");
					return over.observerFinish ?? { kind: "clean" as const };
				},
			};
		},
		upsertComment: (_gh, _repo, prNumber, _body) => {
			effects.push(`comment:${prNumber}`);
			return over.commentOk !== false;
		},
		postStatus: (_gh, _repo, sha, state) => {
			effects.push(`status:${state}:${sha}`);
			return over.statusOk !== false;
		},
		managedState: (itemId) => {
			effects.push(`managed:${itemId}`);
			return over.managed ?? "managed";
		},
		isCi: over.isCi ?? false,
		isSingleShot: over.isSingleShot ?? false,
	};
	return { deps, effects, stepCalls, logs, errs, repo, gateRoot, sourceRoot, heads };
}

describe("parsePrAdjudicateArgs", () => {
	it("parses --pr and defaults --profile to standard", () => {
		assert.deepEqual(parsePrAdjudicateArgs(["--pr", "497"]), { kind: "run", pr: 497, profile: "standard" });
		assert.deepEqual(parsePrAdjudicateArgs(["--pr", "12", "--profile", "fast"]), { kind: "run", pr: 12, profile: "fast" });
	});

	it("errors on missing or non-positive --pr", () => {
		assert.equal(parsePrAdjudicateArgs([]).kind, "error");
		assert.equal(parsePrAdjudicateArgs(["--pr", "nope"]).kind, "error");
		assert.equal(parsePrAdjudicateArgs(["--pr", "0"]).kind, "error");
	});
});

describe("pr-adjudicate CLI config and eligibility", () => {
	it("validates args and config with no network, filesystem, or model effects", async () => {
		const h = harness({ seed: false });
		h.deps.gh = () => {
			throw new Error("gh must not be called");
		};
		assert.equal(await main(["--pr"], h.deps), 2);
		assert.equal(await main(["--pr", "497"], { ...h.deps, ghRepo: "" }), 2);
		assert.equal(await main(["--pr", "497"], { ...h.deps, reviewRunner: "ci" }), 2);
		assert.equal(await main(["--pr", "497"], { ...h.deps, shipTargetName: "direct-push" }), 2);
		assert.equal(await main(["--pr", "497"], { ...h.deps, isCi: true }), 2);
		assert.equal(await main(["--pr", "497"], { ...h.deps, isSingleShot: true }), 2);
		assert.equal(await main(["--pr", "497"], { ...h.deps, mainWorktree: () => "/other" }), 2);
		assert.ok(!h.effects.some((e) => e.startsWith("step:") || e.startsWith("comment:") || e.startsWith("status:")));
	});

	it("stops before verification and posting on PR, managed-item, actor, and evidence failures", async () => {
		assert.equal(await main(["--pr", "497"], harness({ prJson: prJson({ isDraft: true }) }).deps), 1);
		assert.equal(await main(["--pr", "497"], harness({ managed: "unmanaged" }).deps), 1);
		assert.equal(await main(["--pr", "497"], harness({ user: "", userStatus: 1 }).deps), 1);
		assert.equal(await main(["--pr", "497"], harness({ seed: false }).deps), 1);
		const noSource = harness({ seed: false });
		writePrReviewGateRecord(noSource.gateRoot, fleet());
		assert.equal(await main(["--pr", "497"], noSource.deps), 1);
		assert.ok(!noSource.effects.some((e) => e.startsWith("step:") || e.startsWith("comment:") || e.startsWith("status:")));
	});

	it("refuses ambiguous fleet evidence naming the conflicting files, never picking by reviewedAt (#510 1b)", async () => {
		const h = harness();
		// A second fleet record for the same PR with a FUTURE model-supplied timestamp — under
		// newest-wins this forged record would steer adjudication; now any second record refuses.
		writePrReviewGateRecord(h.gateRoot, fleet({ headSha: NEW_HEAD, reviewedAt: "2027-01-01T00:00:00.000Z" }));
		assert.equal(await main(["--pr", "497"], h.deps), 1);
		assert.ok(h.errs.some((e) => e.includes(`497-${REVIEWED}.json`) && e.includes(`497-${NEW_HEAD}.json`)));
		assert.ok(!h.effects.some((e) => e.startsWith("read-source:") || e.startsWith("step:") || e.startsWith("comment:") || e.startsWith("status:")));
	});

	it("ignores fleet evidence for a different item before checking ambiguity (#514)", async () => {
		const h = harness();
		writePrReviewGateRecord(h.gateRoot, fleet({ itemId: "500", headSha: NEW_HEAD }));
		assert.equal(await main(["--pr", "497"], h.deps), 0);
		assert.ok(h.effects.includes("write-gate:operator-adjudication"));
		assert.ok(h.effects.includes(`status:success:${HEAD}`));
	});
});

describe("pr-adjudicate CLI verification and effects", () => {
	it("skips the model for a stored judgment-only survivor set", async () => {
		const judged = survivor({
			tier: "judgment",
			class: "judgment",
			classification: { kind: "matched", class: "judgment", signal: "ruleId", ruleId: "rule-judgment-docs" },
		});
		const h = harness({ survivor: judged });
		assert.equal(await main(["--pr", "497"], h.deps), 0);
		assert.ok(!h.effects.some((e) => e.startsWith("step:")));
		assert.ok(h.effects.includes("write-gate:operator-adjudication"));
		assert.ok(h.effects.includes("comment:497"));
		assert.ok(h.effects.includes(`status:success:${HEAD}`));
	});

	it("sends every safety survivor in one pr-verify call with original locations", async () => {
		const h = harness();
		assert.equal(await main(["--pr", "497"], h.deps), 0);
		assert.equal(h.stepCalls.length, 1);
		assert.equal(h.stepCalls[0]?.name, "pr-verify");
		// #510 must-fix: the verifier's cwd is the DETACHED data-only review-head checkout — never
		// the authenticated main checkout — with the pipeline's confinement wiring threaded in.
		assert.equal(h.stepCalls[0]?.cwd, "/tmp/adjudicate-head");
		assert.deepEqual(h.stepCalls[0]?.foreignRootDenial, { mainRepo: h.repo, registeredWorktrees: [h.repo] });
		assert.equal(h.stepCalls[0]?.hasObserver, true);
		assert.deepEqual(h.stepCalls[0]?.executionOverride, { provider: "claude", model: "claude-opus-4-8" });
		assert.match(h.stepCalls[0]?.prompt ?? "", /"candidateId":"C1"/);
		assert.match(h.stepCalls[0]?.prompt ?? "", /Null deref in the parser/);
		assert.match(h.stepCalls[0]?.prompt ?? "", /"line":10/);
		assert.match(h.stepCalls[0]?.prompt ?? "", /\/tmp\/adjudicate-head/);
	});

	it("refuses on verifier confinement violations without authorization effects (#510)", async () => {
		// Observer-attributed main-checkout mutation.
		const violated = harness({ observerFinish: { kind: "violation", roots: ["/main"] } });
		assert.equal(await main(["--pr", "497"], violated.deps), 1);
		assert.ok(violated.errs.some((e) => /verifier mutated the main checkout/.test(e)));
		assert.ok(!violated.effects.some((e) => e.startsWith("write-gate:operator") || e.startsWith("comment:") || e.startsWith("status:")));
		// Attribution audit failure fails closed.
		const attributionError = harness({ observerFinish: { kind: "error", message: "unclosed invocation" } });
		assert.equal(await main(["--pr", "497"], attributionError.deps), 1);
		assert.ok(attributionError.errs.some((e) => /confinement attribution failed/.test(e)));
		assert.ok(!attributionError.effects.some((e) => e.startsWith("write-gate:operator") || e.startsWith("comment:") || e.startsWith("status:")));
		// Snapshot delta on the main checkout (catches non-hook providers).
		const delta = harness({ mainSnapshots: ["", " M src/a.ts"] });
		assert.equal(await main(["--pr", "497"], delta.deps), 1);
		assert.ok(delta.errs.some((e) => /main checkout changed during verification/.test(e)));
		assert.ok(!delta.effects.some((e) => e.startsWith("write-gate:operator") || e.startsWith("comment:") || e.startsWith("status:")));
		// An unobservable main root refuses BEFORE spending the verifier.
		const gone = harness({ mainSnapshots: [FORBIDDEN_ROOT_GONE] });
		assert.equal(await main(["--pr", "497"], gone.deps), 1);
		assert.ok(!gone.effects.some((e) => e.startsWith("step:")));
		assert.ok(!gone.effects.some((e) => e.startsWith("write-gate:operator") || e.startsWith("comment:") || e.startsWith("status:")));
	});

	it("refuses clean-to-clean main mutations — HEAD/ref moves porcelain cannot see (#510 round-2 2a)", async () => {
		// Porcelain stays clean at both ends; only the HEAD+for-each-ref digest changes, the
		// `git -C ../../.. commit --allow-empty` shape from the verified finding.
		const h = harness({ refStateSnapshots: ["h1\nrefs-digest", "h2\nrefs-digest"] });
		assert.equal(await main(["--pr", "497"], h.deps), 1);
		assert.ok(h.errs.some((e) => /HEAD or refs changed during verification/.test(e)));
		assert.ok(!h.effects.some((e) => e.startsWith("write-gate:operator") || e.startsWith("comment:") || e.startsWith("status:")));
	});

	it("refuses sibling-worktree deltas and exempts only the verifier's own review-head cwd (#510 round-2 2b)", async () => {
		// The registered enumeration includes the verifier's own review-head checkout and a true
		// sibling: only the sibling is audited, and its porcelain/HEAD delta refuses.
		const sibling = "/wt/pelaggio-extra";
		const dirty = harness({
			extraWorktrees: ["/tmp/adjudicate-head", sibling],
			siblingSnapshots: { [sibling]: ["\n@h1", " M src/a.ts\n@h1"] },
		});
		assert.equal(await main(["--pr", "497"], dirty.deps), 1);
		assert.ok(dirty.errs.some((e) => e.includes(`sibling worktree ${sibling} changed during verification`)));
		assert.ok(!dirty.effects.some((e) => e === "snapshot-sibling:/tmp/adjudicate-head"));
		assert.ok(!dirty.effects.some((e) => e.startsWith("write-gate:operator") || e.startsWith("comment:") || e.startsWith("status:")));

		// A detached-HEAD commit in a clean sibling (porcelain identical, HEAD moved) refuses too.
		const headMoved = harness({
			extraWorktrees: [sibling],
			siblingSnapshots: { [sibling]: ["\n@h1", "\n@h2"] },
		});
		assert.equal(await main(["--pr", "497"], headMoved.deps), 1);
		assert.ok(headMoved.errs.some((e) => e.includes(`sibling worktree ${sibling} changed during verification`)));
		assert.ok(!headMoved.effects.some((e) => e.startsWith("write-gate:operator") || e.startsWith("comment:") || e.startsWith("status:")));

		// Unchanged siblings pass through to the normal success path.
		const clean = harness({ extraWorktrees: [sibling], siblingSnapshots: { [sibling]: ["\n@h1"] } });
		assert.equal(await main(["--pr", "497"], clean.deps), 0);
		assert.ok(clean.effects.filter((e) => e === `snapshot-sibling:${sibling}`).length === 2);
		assert.ok(clean.effects.includes(`status:success:${HEAD}`));
	});

	it("refuses non-ok, thrown, malformed, example, missing, and surviving verification without effects", async () => {
		const cases: Array<StepResult | Error> = [
			{ ok: false, subtype: "error_max_turns", text: "", fullText: "", assistantText: "", cost: 0, turns: 0 },
			new Error("verifier crashed"),
			{ ok: true, subtype: "success", text: "not a report", fullText: "not a report", assistantText: "not a report", cost: 0, turns: 0 },
			verification([{ candidateId: "C1", decision: "refuted", rationale: "Concrete single-line repository evidence." }]),
			verification([]),
			verification([{ candidateId: "C1", decision: "survives", rationale: "Still there." }]),
		];
		for (const verify of cases) {
			const h = harness({ verify });
			assert.equal(await main(["--pr", "497"], h.deps), 1);
			assert.ok(!h.effects.some((e) => e.startsWith("write-gate:operator") || e.startsWith("comment:") || e.startsWith("status:")));
			assert.ok(h.effects.includes("cleanup:refs/pelaggio-adjudicate/pr-497:-adjudicate"));
		}
	});

	it("persists the live adjudication-time rationale, never the stale red-review survives text", async () => {
		// Stored (stale) verification: "Confirmed against the inspected head."; live verifier
		// (harness default): "Fixed in the current head." — the durable record must quote the live
		// evidence and name its pass (#497 must-fix: provenance was quoting the pre-fix text as
		// repair confirmation).
		const h = harness();
		assert.equal(await main(["--pr", "497"], h.deps), 0);
		const stored = readPrReviewGateRecord(h.gateRoot, 497, HEAD);
		assert.ok(stored && stored.schemaVersion === 2 && stored.producer === "operator-adjudication");
		const rationale = stored.dispositions[reviewFindingFingerprint(finding())]?.rationale ?? "";
		assert.match(rationale, /Fixed in the current head\./);
		assert.doesNotMatch(rationale, /Confirmed against the inspected head/);
		assert.doesNotMatch(rationale, /confirmed the repair/);
		assert.match(rationale, /adjudication-time/);
	});

	it("orders record → comment → status and writes a valid v2 operator record", async () => {
		const h = harness();
		assert.equal(await main(["--pr", "497"], h.deps), 0);
		const writes = h.effects.filter((e) => e.startsWith("write-gate:") || e.startsWith("comment:") || e.startsWith("status:"));
		assert.deepEqual(writes, ["write-gate:operator-adjudication", "comment:497", `status:success:${HEAD}`]);
		const stored = readPrReviewGateRecord(h.gateRoot, 497, HEAD);
		assert.ok(stored && stored.schemaVersion === 2 && stored.producer === "operator-adjudication");
		assert.equal(stored.reviewedSourceSha, REVIEWED);
		assert.equal(stored.adjudicator, "operator");
		assert.equal(stored.interdiffDigest, createHash("sha256").update(replacementDiff()).digest("hex"));
		assert.equal(stored.dispositions[reviewFindingFingerprint(finding())]?.disposition, "fixed");
		assert.ok(h.effects.includes("prepare:refs/pelaggio-adjudicate/pr-497:" + HEAD + ":-adjudicate"));
		assert.ok(h.effects.includes("cleanup:refs/pelaggio-adjudicate/pr-497:-adjudicate"));
		assert.ok(!h.effects.some((e) => e.includes("refs/pelaggio-review/pr-497")));
	});

	it("stops later effects when record, comment, or status fails", async () => {
		const recordFail = harness({ writeGateOk: false });
		assert.equal(await main(["--pr", "497"], recordFail.deps), 1);
		assert.ok(!recordFail.effects.some((e) => e.startsWith("comment:") || e.startsWith("status:")));

		const commentFail = harness({ commentOk: false });
		assert.equal(await main(["--pr", "497"], commentFail.deps), 1);
		assert.ok(commentFail.effects.includes("write-gate:operator-adjudication"));
		assert.ok(!commentFail.effects.some((e) => e.startsWith("status:")));

		const statusFail = harness({ statusOk: false });
		assert.equal(await main(["--pr", "497"], statusFail.deps), 1);
		assert.ok(statusFail.effects.includes("write-gate:operator-adjudication"));
		assert.ok(statusFail.effects.includes("comment:497"));
		assert.ok(readPrReviewGateRecord(statusFail.gateRoot, 497, HEAD));
	});

	it("reads the head before inspection, before effects, before status, and after status", async () => {
		const h = harness();
		assert.equal(await main(["--pr", "497"], h.deps), 0);
		assert.deepEqual(
			h.effects.filter((e) => e.startsWith("gh:pr:view")),
			["gh:pr:view", "gh:pr:view", "gh:pr:view", "gh:pr:view"],
		);
	});

	it("writes nothing when the head changes before effects, and does not green a later head", async () => {
		const pre = harness({ prJson: [prJson(), prJson({ headRefOid: NEW_HEAD })] });
		assert.equal(await main(["--pr", "497"], pre.deps), 1);
		assert.ok(!pre.effects.some((e) => e.startsWith("write-gate:operator") || e.startsWith("comment:") || e.startsWith("status:")));

		const late = harness({ prJson: [prJson(), prJson(), prJson({ headRefOid: NEW_HEAD })] });
		assert.equal(await main(["--pr", "497"], late.deps), 1);
		assert.ok(late.effects.includes("write-gate:operator-adjudication"));
		assert.ok(late.effects.includes("comment:497"));
		assert.ok(!late.effects.some((e) => e.startsWith("status:")));

		const after = harness({ prJson: [prJson(), prJson(), prJson(), prJson({ headRefOid: NEW_HEAD })] });
		assert.equal(await main(["--pr", "497"], after.deps), 1);
		assert.ok(after.effects.includes(`status:success:${HEAD}`));
		assert.ok(!after.effects.some((e) => e === `status:success:${NEW_HEAD}`));
	});

	it("cleans up the adjudication ref even when preparation fails after the fetch created it (#510 leaked ref)", async () => {
		// prepareReviewHead fetches refs/pelaggio-adjudicate/pr-<n> BEFORE its readiness checks, so
		// a null return can still have created the ref — cleanup must run regardless of readiness.
		const h = harness({ prepareOk: false });
		assert.equal(await main(["--pr", "497"], h.deps), 1);
		assert.ok(h.effects.includes("prepare:refs/pelaggio-adjudicate/pr-497:" + HEAD + ":-adjudicate"));
		assert.ok(h.effects.includes("cleanup:refs/pelaggio-adjudicate/pr-497:-adjudicate"));
	});
});
