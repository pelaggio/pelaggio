/**
 * The `pick` prologue (module-architecture follow-up): claim or resolve the item, find its
 * worktree, register the session record, and detect quick mode. Moved verbatim from
 * `runPipeline`; the cycle keeps the git-binding snapshot that `finish()` reads. Returns the
 * bindings every later step depends on.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { WORKTREE_PREFIX } from "../config.js";
import type { SessionController } from "../confinement/sessions.js";
import { classifyOutcome } from "../cycle-outcome.js";
import { parsePickItem, parsePickResult, pickDivergedFromPin } from "../pick-parse.js";
import { ensureMainCheckoutOnBranch } from "../ship/freshness.js";
import { expandSkill } from "../skills.js";
import { ALL_STEPS, STEPS } from "../step-names.js";
import type { Flags, ParkSignal, PipelineEntryDecision, PipelineEntryReason, PipelineOpts, Step } from "../types.js";
import type { CycleHelpers, StepOutcome } from "./context.js";

/** The cycle bindings `runPick` reads — data only, built by the cycle at the call site. */
export interface PickInput {
	readonly flags: Flags;
	readonly parkSignal: ParkSignal;
	readonly mainRepo: string;
	/** A pinned item id; absent for auto-pick. */
	readonly itemId?: string;
	/** A resume with a known worktree skips the claim. */
	readonly worktree?: string;
	/** A `Step` name (`--from`); typed as a string because Input admits data types only — validated against ALL_STEPS at entry. */
	readonly startFrom?: string;
	readonly profile: string;
}
/** Exactly the cycle helpers `runPick` calls. */
export type PickDeps = Pick<CycleHelpers, "roadmap" | "log" | "finish" | "step" | "itemRunIdFor" | "cost" | "addCost" | "setLogLabel" | "listWorktrees" | "resolveWorktree" | "createSessionController" | "isQuickScope"> & {
	/** Run options carry callbacks (`pickMutex`, `workerStatus`, `signal`), so they ride as a Dep. */
	readonly opts: PipelineOpts;
};

export interface PickOutcome {
	readonly itemId: string;
	readonly worktree: string;
	readonly startFrom: Step;
	readonly profile: string;
	/** Set when the claim published a cross-process session record; `finish()` disposes it. */
	readonly sessionController: SessionController | undefined;
	/** Computed after quick-scope classification; pipeline persists it via `finish()`. */
	readonly entryDecision: PipelineEntryDecision;
}

export async function runPick(ctx: PickInput, helpers: PickDeps): Promise<StepOutcome<PickOutcome>> {
	const { flags, parkSignal, mainRepo } = ctx;
	const { opts, roadmap, log, finish, step, itemRunIdFor, cost, addCost, setLogLabel, listWorktrees, resolveWorktree, createSessionController, isQuickScope } = helpers;
	let itemId: string | null = ctx.itemId ?? null;
	let worktree: string | null = ctx.worktree ?? null;
	let { profile } = ctx;
	if (ctx.startFrom !== undefined && !(ALL_STEPS as readonly string[]).includes(ctx.startFrom)) throw new Error(`--from names an unknown step: ${ctx.startFrom}`);
	let startFrom = ctx.startFrom as Step | undefined;
	let sessionController: SessionController | undefined;
	let pickAssistantText = "";
	if (itemId) setLogLabel(itemId);

	if (!worktree) {
		const mutex = opts.pickMutex;
		const ws = opts.workerStatus;
		if (ws && mutex) ws.step = "waiting";
		if (mutex) await mutex.acquire();
		try {
			if (parkSignal.parked) return { kind: "terminal", result: finish({ itemId: null, completed: false, cost: cost(), error: "parked" }) };

			// Worktree-isolated claims branch off the literal `main` ref (git-claim.ts), so a
			// detached/off-branch mainRepo can't corrupt a *new* claim — but it does break an
			// operator's between-cycle `git merge --ff-only origin/main` and misleads `git log
			// -1` there (issue #216). --no-worktree mode legitimately leaves mainRepo on the
			// prior claim's feature branch (or a CI-provided checkout), so it's exempt.
			if (!opts.dryRun && !opts.noWorktree && !ensureMainCheckoutOnBranch(mainRepo, "main", log)) {
				return { kind: "terminal", result: finish({ itemId: null, completed: false, cost: cost(), error: "main checkout is not on main and could not be reattached" }) };
			}
			const worktreesBefore = new Set(opts.dryRun ? [] : listWorktrees());

			if (!opts.dryRun && itemId && roadmap.isCharterPickRace(itemId)) {
				return { kind: "terminal", result: finish({ itemId, completed: false, cost: cost(), error: "pick:unknown-id" }) };
			}
			log(`/pick ${itemId ?? "next"}`);
			const pickArgs = itemId ? (opts.noWorktree ? `${itemId} --no-worktree` : itemId) : "next";
			const pick = await step("pick", expandSkill("pick", pickArgs), mainRepo);
			addCost(pick.cost);
			pickAssistantText = pick.assistantText;

			if (!pick.ok) {
				const err = classifyOutcome(pick) === "blocked" ? `pick blocked: ${pick.text}` : "pick failed";
				return { kind: "terminal", result: finish({ itemId: null, completed: false, cost: cost(), error: err }) };
			}

			if (!opts.dryRun) {
				const reason = parsePickResult(pickAssistantText);
				if (reason !== "claimed") {
					return { kind: "terminal", result: finish({ itemId: null, completed: false, cost: cost(), error: `pick:${reason ?? "unknown"}` }) };
				}
			}

			// #332: an explicit `--item <N>` pin is a DETERMINISTIC gate, not a hint. The /pick skill's
			// contract is to claim exactly the requested id (or report `already-done`/`blocked`) — never
			// substitute a different ready item. For a PINNED claimed pick, resolve the id ONLY from the
			// authoritative `pick-item:` marker (SKILL.md declares it authoritative precisely to avoid
			// ambiguous free-text) — never fall back to `parseItemId(pick.text)`, or free text narrating
			// the requested id could mask an actual divert. A missing/malformed marker on a claimed pin is
			// itself a contract violation → fail closed. Auto-pick (no pin) keeps the free-text fallback.
			if (opts.dryRun) {
				itemId = itemId ?? "DRY";
			} else if (opts.itemId) {
				itemId = parsePickItem(pickAssistantText);
				if (!itemId) return { kind: "terminal", result: finish({ itemId: null, completed: false, cost: cost(), error: "pick:unparsed-marker" }) };
				if (await pickDivergedFromPin(opts.itemId, itemId, (text) => roadmap.parseItemId(text))) {
					log(`⚠ pick diverted: requested ${opts.itemId} but /pick claimed ${itemId} — refusing (a pinned --item must resolve exactly; the stray claim needs cleanup)`);
					return { kind: "terminal", result: finish({ itemId, completed: false, cost: cost(), error: "pick:diverted" }) };
				}
			} else {
				itemId = parsePickItem(pickAssistantText) ?? (await roadmap.parseItemId(pick.text)) ?? (await roadmap.parseItemId(pick.fullText));
				if (!itemId) return { kind: "terminal", result: finish({ itemId: null, completed: false, cost: cost(), error: "no item ID parsed" }) };
			}

			if (opts.noWorktree) {
				// In no-worktree mode, the feature branch was checked out in-place.
				worktree = mainRepo;
			} else {
				worktree = resolveWorktree(itemId);
				if (!opts.dryRun && (!existsSync(worktree) || worktreesBefore.has(worktree))) {
					// Match on the basename prefix, not a path substring: a parent/main-repo path can
					// contain WORKTREE_PREFIX (e.g. a checkout whose dir basename is the prefix root) and
					// must not be mistaken for the freshly-created sibling worktree.
					const newWt = listWorktrees().find((p) => !worktreesBefore.has(p) && (p.split(/[/\\]/).pop() ?? "").startsWith(WORKTREE_PREFIX));
					if (newWt) worktree = newWt;
					else if (!existsSync(worktree)) {
						const idLower = itemId.toLowerCase();
						const expected = `${WORKTREE_PREFIX}${idLower}`;
						const all = listWorktrees();
						const nested = all.filter((p) => {
							const base = p.split(/[/\\]/).pop() ?? "";
							return base === expected || base.startsWith(`${expected}-`);
						});
						if (nested.length === 1) {
							const chosen = nested[0];
							if (!chosen) return { kind: "terminal", result: finish({ itemId, completed: false, cost: cost(), error: `worktree missing for ${itemId}: expected ${expected}` }) };
							const base = chosen.split(/[/\\]/).pop() ?? "";
							const extendedId = (base.startsWith(WORKTREE_PREFIX) ? base.slice(WORKTREE_PREFIX.length) : base).toUpperCase();
							log(`expected ${worktree}, using ${chosen} for in-flight ${extendedId}`);
							worktree = chosen;
						} else if (nested.length > 1) return { kind: "terminal", result: finish({ itemId, completed: false, cost: cost(), error: `worktree ambiguous: ${nested.join(", ")}` }) };
						else {
							const summary = all.map((p) => p.split(/[/\\]/).pop()).join(", ");
							return { kind: "terminal", result: finish({ itemId, completed: false, cost: cost(), error: `worktree missing for ${itemId}: expected ${expected}; git worktree list (${all.length} entries): ${summary}` }) };
						}
					}
				}
			}
		} finally {
			mutex?.release();
		}
	} else if (!opts.dryRun && !existsSync(worktree)) {
		return { kind: "terminal", result: finish({ itemId, completed: false, cost: cost(), error: "worktree missing" }) };
	}

	setLogLabel(itemId!);
	log(`→ ${worktree}`);

	// Register this cycle's worktree as an active peer so concurrent siblings exempt it
	// from their whole-tree confinement snapshot (see `forbiddenRootsForStep`). Resolved to
	// match the audit's absolute-path comparison. `finish()` removes it on every exit path.
	// `--no-worktree` cycles run in mainRepo (never registered — main stays hard-gated) and
	// `--parallel > 1` is disallowed there, so there is no peer to exempt.
	if (worktree && worktree !== mainRepo) opts.activeWorktrees?.add(resolve(worktree));

	// #369: publish a cross-process session record once the item worktree + claim are known
	// (same window as activeWorktrees). Claude steps later refresh the binding pid; Codex/Grok
	// still register so inventory fallback works for earlier evaluators. finish() disposes.
	if (!opts.dryRun && worktree && worktree !== mainRepo && itemId) {
		let claimBranch = "";
		try {
			claimBranch = execSync("git branch --show-current", { cwd: worktree, encoding: "utf-8" }).trim();
		} catch {
			claimBranch = "";
		}
		if (claimBranch.startsWith("feat/")) {
			const sessionId = itemRunIdFor(itemId);
			try {
				sessionController = createSessionController({
					mainRepo,
					sessionId,
					claimedItem: itemId,
					claimBranch,
					worktreePath: resolve(worktree),
				});
				// Best-effort process-level cleanup for the window before finish() returns
				// (SIGINT between steps). finish() is also idempotent; drop listeners on dispose.
				const disposeOnce = (): void => {
					process.removeListener("SIGINT", disposeOnce);
					if (opts.signal) opts.signal.removeEventListener("abort", disposeOnce);
					try {
						sessionController?.dispose();
					} catch {
						// ignore
					}
				};
				process.once("SIGINT", disposeOnce);
				if (opts.signal) {
					if (opts.signal.aborted) disposeOnce();
					else opts.signal.addEventListener("abort", disposeOnce, { once: true });
				}
				// Wrap controller dispose so normal finish() also drops the SIGINT listener.
				const inner = sessionController;
				sessionController = {
					sessionId: inner.sessionId,
					identity: inner.identity,
					updateChild: (pid) => inner.updateChild(pid),
					dispose: () => {
						process.removeListener("SIGINT", disposeOnce);
						if (opts.signal) opts.signal.removeEventListener("abort", disposeOnce);
						inner.dispose();
					},
				};
			} catch (e) {
				log(`⚠ session record registration failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	if (opts.workerStatus) opts.workerStatus.itemId = itemId!;

	// ── Detect quick mode ──
	// A pinned --profile (issue #247) suppresses the automatic downgrade: the operator has taken
	// explicit control of the profile, so keep the step set and backend identical to the pin.
	const requestedStart = startFrom ?? null;
	const requestedSource = flags.from ? "from-flag" : flags["review-findings"] ? "review-findings" : ctx.startFrom !== undefined ? "supplied" : "default";
	let automaticQuick = false;
	let reason: PipelineEntryReason = flags.profile ? "profile-pin" : "standard";
	let excludedQuickSteps: PipelineEntryDecision["excludedQuickSteps"] = [];

	if (!flags.profile) {
		const quickItem = !opts.dryRun && itemId ? await roadmap.getItem(itemId).catch(() => null) : null;
		if (isQuickScope({ item: quickItem, summaryText: pickAssistantText })) {
			profile = "quick";
			automaticQuick = true;
			excludedQuickSteps = ["plan", "shakedown-plan"];
			log("scope S/XS or bug — quick mode (Sonnet, skip plan+shakedown-plan)");
			const implementIndex = STEPS.indexOf("implement");
			const requestedIndex = startFrom === undefined ? -1 : (STEPS as readonly string[]).indexOf(startFrom);
			if (startFrom === undefined) {
				startFrom = "implement";
				reason = "automatic-quick-fresh";
			} else if (requestedIndex !== -1 && requestedIndex < implementIndex) {
				startFrom = "implement";
				reason = "automatic-quick-clamped";
			} else {
				reason = "automatic-quick-kept";
			}
		}
	}
	startFrom ??= "plan";
	const entryDecision: PipelineEntryDecision = {
		requestedStart,
		requestedSource,
		profile,
		automaticQuick,
		effectiveStart: startFrom,
		excludedQuickSteps,
		reason,
	};
	log(`entry requested=${requestedStart ?? "default"} source=${requestedSource} effective=${startFrom} reason=${reason} profile=${profile}`);
	return { kind: "continue", itemId: itemId!, worktree: worktree!, startFrom, profile, sessionController, entryDecision };
}
