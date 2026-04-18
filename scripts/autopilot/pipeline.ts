import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { MODEL_PROFILES, REPO, SHIP_TARGET, WORKTREE_PREFIX } from "./config.js";
import {
	appendLog as appendLogDefault,
	captureShipState,
	checkpoint,
	createMutex,
	detectResumeStep,
	ensureCheckpointed,
	expandSkill,
	filesChangedSince,
	findPlanPath,
	fmtWait,
	getHeadSha,
	hasDeliverableCommits,
	isQuickScope,
	listWorktrees as listWorktreesDefault,
	parseItemId,
	parseVerdict,
	parseWaitFlag,
	resolveWorktree,
	stepIndex,
	verifyShipLanded,
} from "./helpers.js";
import { getShipTarget, isShipTargetName, SHIP_TARGET_NAMES } from "./ship/index.js";
import { runStep as runStepDefault } from "./step-runner.js";
import { A, createStepRenderer, fmtElapsed, LiveStatus, StatusBar } from "./tui.js";
import type { CycleResult, CycleStatus, Flags, ParkSignal, PipelineOpts, Step, StepLog, StepResult } from "./types.js";

// ── Pipeline ───────────────────────────────────────────────────────────

export type RunStepFn = typeof runStepDefault;

export interface PipelineDeps {
	runStep?: RunStepFn;
	listWorktrees?: () => string[];
	appendLog?: (entry: Record<string, unknown>) => void;
	/** Override the main-repo path used for ghost-ship verification. Defaults to REPO. */
	mainRepo?: string;
}

export async function runPipeline(opts: PipelineOpts, parkSignal: ParkSignal, flags: Flags, deps: PipelineDeps = {}): Promise<CycleResult> {
	const runStep = deps.runStep ?? runStepDefault;
	const listWorktrees = deps.listWorktrees ?? listWorktreesDefault;
	const appendLog = deps.appendLog ?? appendLogDefault;
	const mainRepo = deps.mainRepo ?? REPO;
	let cost = 0;
	let profile = "standard";
	const steps: StepLog[] = [];
	const pipelineT0 = Date.now();
	let logLabel = `cycle ${opts.cycle}`;
	const log = (msg: string): void => {
		const elapsed = fmtElapsed(Date.now() - pipelineT0);
		const ts = new Date().toLocaleTimeString("en-CA", { hour12: false });
		console.log(`${A.dim(ts)} [${logLabel}] ${A.dim(elapsed)} ${msg}`);
	};

	async function step(name: Step, prompt: string, cwd: string, { attempt = 1, commitLabel }: { attempt?: number; commitLabel?: string } = {}): Promise<StepResult> {
		if (opts.dryRun) {
			log(`[dry-run] ${name}: "${prompt.slice(0, 60)}" in ${cwd}`);
			steps.push({ name, model: MODEL_PROFILES[profile]?.[name] ?? "default", cost: 0, turns: 0, ok: true, ...(attempt > 1 ? { attempt } : {}) });
			return { ok: true, subtype: "success", text: `[dry-run] ${name}`, fullText: `[dry-run] ${name}`, cost: 0, turns: 0 };
		}

		const emit = createStepRenderer({
			verbose: opts.verbose,
			trace: flags.trace,
			toFile: !!opts.logPath,
			logPath: opts.logPath,
			liveStatus: opts.liveStatus!,
			workerStatus: opts.workerStatus,
		});

		const preSha = getHeadSha(cwd);

		const result = await runStep(
			name,
			prompt,
			{
				cwd,
				profile,
				trace: flags.trace,
				itemId: itemId ?? undefined,
				parkSignal,
			},
			emit,
		);

		if (commitLabel) {
			const committed = checkpoint(cwd, commitLabel);
			log(committed ? `${commitLabel} committed` : `no changes to commit (${commitLabel})`);
			ensureCheckpointed(cwd, commitLabel, log);
		}

		const filesChanged = filesChangedSince(cwd, preSha);

		steps.push({
			name,
			model: MODEL_PROFILES[profile]?.[name] ?? "default",
			cost: result.cost,
			turns: result.turns,
			ok: result.ok,
			...(result.tokens ? { tokens: result.tokens } : {}),
			...(attempt > 1 ? { attempt } : {}),
			...(result.toolCounts ? { toolCounts: result.toolCounts } : {}),
			...(result.outputTail ? { outputTail: result.outputTail } : {}),
			...(filesChanged.length > 0 ? { filesChanged } : {}),
		});
		if (opts.workerStatus) opts.workerStatus.cost += result.cost;
		return result;
	}

	let shipwrecked = false;

	function finish(result: CycleResult): CycleResult {
		if (!opts.dryRun) {
			const parked = result.error === "parked";
			appendLog({
				ts: new Date().toISOString(),
				cycle: opts.cycle,
				item: result.itemId,
				quick: profile === "quick",
				steps,
				total_cost: Number(result.cost.toFixed(4)),
				verdict: result.verdict ?? null,
				completed: result.completed,
				error: result.error ?? null,
				parked,
				parkReason: parked ? parkSignal.limitType || null : null,
				shipwrecked,
			});
		}
		return result;
	}

	// ── Resolve item + worktree ──

	let itemId = opts.itemId ?? null;
	let worktree = opts.worktree ?? null;
	let pickText = "";
	let startFrom = opts.startFrom;
	if (itemId) logLabel = itemId;

	if (!worktree) {
		const mutex = opts.pickMutex;
		const ws = opts.workerStatus;
		if (ws && mutex) ws.step = "waiting";
		if (mutex) await mutex.acquire();
		try {
			if (parkSignal.parked) return finish({ itemId: null, completed: false, cost, error: "parked" });
			const worktreesBefore = new Set(opts.dryRun ? [] : listWorktrees());

			log(`/pick ${itemId ?? "next"}`);
			const pick = await step("pick", expandSkill("pick", itemId ?? "next"), REPO);
			cost += pick.cost;
			pickText = pick.text + "\n" + pick.fullText;

			if (!pick.ok) return finish({ itemId: null, completed: false, cost, error: "pick failed" });

			const pickAll = pick.text + "\n" + pick.fullText;
			if (!opts.dryRun && !/claimed|worktree add|successfully/i.test(pickAll)) return finish({ itemId: null, completed: false, cost, error: "nothing to pick" });

			itemId = opts.dryRun ? (itemId ?? "DRY") : (parseItemId(pick.text) ?? parseItemId(pick.fullText));
			if (!itemId) return finish({ itemId: null, completed: false, cost, error: "no item ID parsed" });

			worktree = resolveWorktree(itemId);
			if (!opts.dryRun && (!existsSync(worktree) || worktreesBefore.has(worktree))) {
				const newWt = listWorktrees().find((p) => !worktreesBefore.has(p) && p.includes(WORKTREE_PREFIX));
				if (newWt) worktree = newWt;
				else if (!existsSync(worktree)) return finish({ itemId, completed: false, cost, error: "worktree missing" });
			}
		} finally {
			mutex?.release();
		}
	} else if (!opts.dryRun && !existsSync(worktree)) {
		return finish({ itemId, completed: false, cost, error: "worktree missing" });
	}

	logLabel = itemId!;
	log(`→ ${worktree}`);

	if (opts.workerStatus) opts.workerStatus.itemId = itemId!;

	// ── Detect quick mode ──

	if (pickText && isQuickScope(pickText)) {
		profile = "quick";
		log("scope S/XS or bug — quick mode (Sonnet, skip plan+shakedown-plan)");
		startFrom ??= "implement";
	}
	startFrom ??= "plan";

	const shouldRun = (s: Step): boolean => stepIndex(startFrom!) <= stepIndex(s);

	function parkExit(): CycleResult | null {
		if (!parkSignal.parked) return null;
		if (worktree) checkpoint(worktree, "rate-limit park");
		log(`⏸ parked (${parkSignal.limitType})`);
		return finish({ itemId, completed: false, cost, error: "parked" });
	}

	// ── Plan + Shakedown-plan ──

	let verdict: "APPROVE" | "REVISE" | "RETHINK" = "APPROVE";
	let shakedownPlanText = "";

	if (shouldRun("plan")) {
		const existingPlan = findPlanPath(worktree!);
		if (existingPlan) {
			log(`plan exists at ${existingPlan} — skipping plan generation`);
		} else {
			const parked = parkExit();
			if (parked) return parked;
			log("planning...");
			const plan = await step("plan", expandSkill("plan"), worktree!);
			cost += plan.cost;
			if (!plan.ok) return parkExit() ?? finish({ itemId, completed: false, cost, error: "plan failed" });
		}
		const planPath = findPlanPath(worktree!);
		if (planPath) log(`plan: file://${planPath}`);
	}

	if (shouldRun("shakedown-plan")) {
		const MAX_SHAKEDOWN_PLAN_ATTEMPTS = 2;
		for (let attempt = 1; attempt <= MAX_SHAKEDOWN_PLAN_ATTEMPTS; attempt++) {
			const parked = parkExit();
			if (parked) return parked;
			log(attempt === 1 ? "shakedown (plan)..." : "continuing shakedown-plan (attempt 2)...");
			const shakedown = await step("shakedown-plan", expandSkill("shakedown", "autopilot plan-review"), worktree!);
			cost += shakedown.cost;

			if (shakedown.ok) {
				verdict = parseVerdict(shakedown.text);
				shakedownPlanText = shakedown.text;
				const lastStep = steps[steps.length - 1];
				if (lastStep && lastStep.name === "shakedown-plan") lastStep.verdict = verdict;
				log(`verdict: ${verdict}`);
				if (verdict === "RETHINK") return finish({ itemId, completed: false, cost, verdict, error: "plan needs rethink" });
				break;
			}

			if (shakedown.subtype === "error_rate_limit" || parkSignal.parked) {
				return parkExit() ?? finish({ itemId, completed: false, cost, error: "shakedown-plan failed" });
			}
			if (shakedown.subtype !== "error_max_turns") {
				return finish({ itemId, completed: false, cost, error: "shakedown-plan failed" });
			}
			log(`shakedown-plan hit turn limit (attempt ${attempt}/${MAX_SHAKEDOWN_PLAN_ATTEMPTS})`);
			if (attempt === MAX_SHAKEDOWN_PLAN_ATTEMPTS) return finish({ itemId, completed: false, cost, error: "shakedown-plan failed (max retries)" });
		}
	}

	// ── Implement ──

	if (shouldRun("implement")) {
		const parked = parkExit();
		if (parked) return parked;
		const planPath = findPlanPath(worktree!);
		const planRef = planPath ? `Read the plan at \`${planPath}\`.` : `Find the plan in \`${resolve(REPO, ".dev", "plans")}/\` (filename matches branch without \`feat/\` prefix).`;
		const worktreeHint = [
			`**Your working directory is**: \`${worktree}\`.`,
			`Any path the plan writes as \`foo/bar\` (project-relative) means \`${worktree}/foo/bar\` — use that absolute form when calling Edit/Write/Bash, so the worktree-isolation hook does not mistake it for a main-repo reference.`,
		].join("\n");

		const implementPrompt =
			profile === "quick"
				? `${worktreeHint}\n\nThis is a small-scope item (bug fix or scope S). Implement it directly — no formal plan needed. Read the roadmap entry for ${itemId} to understand the requirements. Edit the target files the roadmap names; do NOT create or edit a plan file.`
				: [
						worktreeHint,
						"",
						verdict === "APPROVE" ? "Plan approved." : `Shakedown requested revisions:\n${shakedownPlanText.slice(0, 2000)}${shakedownPlanText.length > 2000 ? "\n...(truncated)" : ""}\nAddress the feedback, then implement.`,
						"",
						"## Plan",
						planRef,
						"",
						"## CRITICAL — execute the plan, do not polish it",
						"The plan file is your **reference only**; it is already approved and locked. Your deliverables are the **target files the plan names** (look for a `Files to change` table or file paths under headings). Do NOT edit the plan file itself to refine wording or add detail — that is not progress, it is plan-polishing and it will fail the cycle.",
						"Before finishing, confirm `git diff --name-only main...HEAD` lists target files, not only `docs/plans/*`.",
						"",
						"## Strategy — work incrementally",
						"1. Read the full plan first. Identify the target files and the implementation order.",
						"2. Implement one logical chunk at a time (e.g., one target file, one new function, one section). For doc-only items the 'chunk' is a specific file or section edit.",
						"3. After each chunk, run the verification commands from `.claude/skills/_rubric.md`'s Verification section. Fix errors before moving on.",
						"4. If the same error persists after 3 fix attempts, commit what works, skip the problematic piece, and note it.",
						"5. Run all verification commands from the rubric before finishing.",
						"6. Do NOT implement all files first and verify at the end — that causes cascading errors.",
					].join("\n");

		const continuePrompt = [
			worktreeHint,
			"",
			"The previous implementation session ran out of turns. Code has been committed to disk.",
			"",
			"## Plan",
			planRef,
			"",
			"## CRITICAL — execute the plan, do not polish it",
			"The plan file is your **reference only**. Your deliverables are the **target files the plan names**. Do NOT edit the plan file itself to refine wording — that is not progress. Before finishing, confirm `git diff --name-only main...HEAD` lists target files, not only `docs/plans/*`.",
			"",
			"## Instructions",
			"1. Run the verification commands from `.claude/skills/_rubric.md`'s Verification section to see the current state.",
			"2. Read the plan and compare against what's already implemented.",
			"3. Identify what's missing or broken and finish the remaining work.",
			"4. Follow the same incremental strategy — one chunk at a time, verify between.",
			"5. Run all verification commands from the rubric before finishing.",
		].join("\n");

		let lastLoopFile: string | null = null;
		const MAX_ATTEMPTS = 2;
		let implOk = false;

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			log(attempt === 1 ? "implementing..." : "continuing implementation (attempt 2)...");
			const retryPrompt = lastLoopFile
				? [
						continuePrompt,
						"",
						`## ⚠ IMPORTANT: The previous session got stuck editing \`${lastLoopFile}\` in a loop.`,
						"Take a DIFFERENT approach to fix the type errors:",
						"- Read the file and the actual error message carefully before editing",
						"- Consider if the type/interface needs to change upstream instead",
						"- If a component prop type is wrong, fix the type definition, not the call site repeatedly",
						"- If stuck after 2 attempts on the same error, skip it and move on",
					].join("\n")
				: continuePrompt;
			const cpLabel = attempt === 1 ? "implementation checkpoint" : "implementation continued";
			const impl = await step("implement", attempt === 1 ? implementPrompt : retryPrompt, worktree!, { attempt, commitLabel: cpLabel });
			cost += impl.cost;

			if (impl.ok) {
				implOk = true;
				break;
			}

			if (impl.subtype === "edit_loop") {
				const match = impl.text.match(/Edit loop detected: (.+?) edited/);
				lastLoopFile = match?.[1]?.replace(/^.*[/\\]/, "") ?? null;
				log(`edit loop on ${lastLoopFile ?? "unknown file"} — will retry with fresh approach`);
			} else if (impl.subtype === "error_rate_limit" || parkSignal.parked) {
				return parkExit() ?? finish({ itemId, completed: false, cost, error: "implement failed" });
			} else if (impl.subtype !== "error_max_turns") {
				return finish({ itemId, completed: false, cost, error: "implement failed" });
			} else {
				log(`implement hit turn limit (attempt ${attempt}/${MAX_ATTEMPTS})`);
			}
		}

		if (!implOk) return finish({ itemId, completed: false, cost, error: "implement failed (max retries)" });
	}

	// ── Shakedown-code ──

	if (shouldRun("shakedown-code")) {
		const MAX_SHAKEDOWN_ATTEMPTS = 2;
		let shakedownOk = false;
		const planPath = findPlanPath(worktree!);
		const shakedownPlanRef = planPath ? `Read the plan at \`${planPath}\` and the roadmap entry for ${itemId} to understand the scope.` : `Find the plan in \`${resolve(REPO, "docs", "plans")}/\` or the roadmap entry for ${itemId}.`;

		for (let attempt = 1; attempt <= MAX_SHAKEDOWN_ATTEMPTS; attempt++) {
			const parked = parkExit();
			if (parked) return parked;
			log(attempt === 1 ? "shakedown (code)..." : "continuing shakedown (attempt 2)...");

			const shakedownPrompt =
				attempt === 1
					? expandSkill("shakedown", "autopilot code-review")
					: [
							"The previous shakedown session ran out of turns. Work has been committed to disk.",
							"",
							"## Context",
							shakedownPlanRef,
							"",
							"## Instructions",
							"1. Run the verification commands from `.claude/skills/_rubric.md`'s Verification section to see the current state.",
							"2. Check what's already been fixed vs. what remains.",
							"3. Focus on fix-now items only (type errors, test failures, lint errors, bugs).",
							"4. Skip near-term items (missing tests, i18n gaps, refactoring) — add them as deferred to the roadmap.",
							"5. Re-run the verification commands before finishing.",
						].join("\n");

			const shakedown = await step("shakedown-code", shakedownPrompt, worktree!, { attempt, commitLabel: "shakedown checkpoint" });
			cost += shakedown.cost;

			if (shakedown.ok) {
				shakedownOk = true;
				break;
			}

			if (shakedown.subtype === "error_rate_limit" || parkSignal.parked) {
				return parkExit() ?? finish({ itemId, completed: false, cost, error: "shakedown-code failed" });
			}

			if (shakedown.subtype !== "error_max_turns") {
				return finish({ itemId, completed: false, cost, error: "shakedown-code failed" });
			}

			log(`shakedown hit turn limit (attempt ${attempt}/${MAX_SHAKEDOWN_ATTEMPTS})`);
		}

		if (!shakedownOk) return finish({ itemId, completed: false, cost, error: "shakedown-code failed (max retries)" });
	}

	// ── Ship ──

	{
		const parked = parkExit();
		if (parked) return parked;
	}
	if (!opts.dryRun && !hasDeliverableCommits(worktree!)) {
		log("⚠ no deliverable commits on branch — skipping ship");
		return finish({
			itemId,
			completed: false,
			cost,
			verdict,
			error: "nothing to ship: branch only touches docs/plans/ (plan-only / no implementation)",
		});
	}
	const target = opts.shipTarget;
	const targetSuffix = target.name === "direct-push" ? "" : ` (${target.name})`;
	log(`shipping...${targetSuffix}`);
	const shipPrompt = `${expandSkill("ship", `autopilot --target=${target.name}`)}\n\n${target.buildPrompt({ itemId: itemId!, worktree: worktree! })}`;

	// Capture pre-ship git state for ghost-ship verification (direct-push only).
	const preShipState = !opts.dryRun && target.name === "direct-push" ? captureShipState(mainRepo, worktree!) : null;

	const ship = await step("ship", shipPrompt, worktree!);
	cost += ship.cost;

	// Ghost-ship check: did main actually advance after a reported-ok direct-push?
	let ghostShip = false;
	if (ship.ok && preShipState && !opts.dryRun) {
		if (!verifyShipLanded(mainRepo, preShipState.mainSha, preShipState.featSha)) {
			ghostShip = true;
			log(`⚠ ghost-ship: ship reported ok but main did not advance — output tail: ${ship.text.slice(-300)}`);
		}
	}

	const shipResult = target.interpretResult(ship);

	if ((!ship.ok || ghostShip) && ship.subtype !== "error_rate_limit" && !parkSignal.parked && target.name === "direct-push") {
		log(ghostShip ? "ghost-ship — attempting /shipwreck recovery..." : "ship failed — attempting /shipwreck recovery...");
		shipwrecked = true;
		const wreck = await step("shipwreck", expandSkill("shipwreck", itemId!), REPO);
		cost += wreck.cost;
		return finish({
			itemId,
			completed: wreck.ok,
			cost,
			verdict,
			error: wreck.ok ? undefined : ghostShip ? "ship claimed success but main did not advance (recovery also failed)" : "ship failed (recovery also failed)",
		});
	}

	return finish({
		itemId,
		completed: shipResult.completed,
		cost,
		verdict,
		error: shipResult.error,
		...(shipResult.awaitingMerge ? { awaitingMerge: true } : {}),
		...(shipResult.prUrl ? { prUrl: shipResult.prUrl } : {}),
	});
}

// ── Orchestrator ───────────────────────────────────────────────────────

function resultIcon(r: CycleResult): string {
	if (r.completed) return A.green("✓");
	if (r.error === "parked") return A.yellow("⏸");
	if (r.error === "plan needs rethink") return A.yellow("↻");
	return A.red("✗");
}

function resultStatus(r: CycleResult): "done" | "skipped" | "failed" | "parked" {
	if (r.completed) return "done";
	if (r.error === "parked") return "parked";
	if (r.error === "plan needs rethink") return "skipped";
	return "failed";
}

export async function orchestrate(flags: Flags): Promise<void> {
	const statusBar = new StatusBar();
	const liveStatus = new LiveStatus(statusBar);
	const parkSignal: ParkSignal = { parked: false, resetsAt: 0, limitType: "", triggerWorker: "" };

	// Resolve ship target: CLI --target > config SHIP_TARGET > default
	let shipTargetName = SHIP_TARGET;
	if (flags.target !== undefined) {
		if (!isShipTargetName(flags.target)) {
			console.error(`invalid --target ${JSON.stringify(flags.target)}; valid: ${SHIP_TARGET_NAMES.join(", ")}`);
			process.exit(2);
		}
		shipTargetName = flags.target;
	}
	const shipTarget = getShipTarget(shipTargetName);

	// Resume mode
	if (flags.resume) {
		const id = flags.resume.toUpperCase();
		const worktree = resolveWorktree(id);
		const startFrom = detectResumeStep(id, worktree);
		const v = flags.verbose;
		console.log(`${A.bold("resume")} ${id} from ${A.bold(startFrom)}`);

		const status: CycleStatus = { itemId: id, status: "running", cost: 0 };
		liveStatus.cycles.push(status);
		liveStatus.totalCycles = 1;
		if (v) statusBar.setup();
		const cleanup = (): void => {
			statusBar.teardown();
			process.stderr.write(A.showCursor);
		};
		process.on("exit", cleanup);
		process.on("SIGINT", () => {
			cleanup();
			process.exit(130);
		});

		const result = await runPipeline(
			{
				itemId: id,
				worktree,
				startFrom,
				cycle: 1,
				verbose: v,
				shipTarget,
				dryRun: false,
				workerStatus: status,
				liveStatus,
			},
			parkSignal,
			flags,
		);

		status.status = resultStatus(result);
		status.step = undefined;
		if (v) {
			liveStatus.render();
			statusBar.teardown();
		}
		console.log(`\n${result.completed ? A.green("✓") : A.red("✗")} ${id} — $${result.cost.toFixed(2)}`);
		process.exit(result.completed ? 0 : 1);
	}

	// Normal mode
	const requestedCycles = parseInt(flags.cycles, 10);
	const parallel = parseInt(flags.parallel, 10);
	const items =
		flags.item
			?.split(",")
			.map((s) => s.trim())
			.filter(Boolean) ?? [];
	// Auto-derive cycles to cover the full item list when --cycles isn't
	// explicitly sized for it — otherwise items beyond index `max(cycles-1,
	// parallel-1)` would silently drop off the worker queue.
	const cycles = Math.max(requestedCycles, parallel, items.length);
	const maxBudget = parseFloat(flags.budget);
	const dryRun = flags["dry-run"];
	const v = flags.verbose;
	const isParallel = parallel > 1;

	const targetBanner = shipTargetName === "direct-push" ? "" : `  ${A.dim(`target=${shipTargetName}`)}`;
	console.log(`${A.bold("autopilot")}  ${cycles} cycle(s)${isParallel ? `  ${A.dim("×")}${parallel} parallel` : ""}  ${A.dim("budget")} $${maxBudget.toFixed(2)}${targetBanner}${dryRun ? `  ${A.yellow("[DRY RUN]")}` : ""}`);
	if (isParallel && v) {
		console.log(`${A.dim("logs")}  .dev/autopilot-{N}.log`);
	}
	console.log("");

	liveStatus.totalCycles = cycles;
	liveStatus.multiline = isParallel;
	if (v) {
		const rows = process.stderr.rows || 24;
		const barLines = isParallel ? Math.min(parallel + 1, Math.floor(rows / 3)) : 2;
		statusBar.setup(barLines);
	}

	const statusInterval = isParallel && v ? setInterval(() => liveStatus.render(), 200) : null;

	const cleanup = (): void => {
		if (statusInterval) clearInterval(statusInterval);
		statusBar.teardown();
		process.stderr.write(A.showCursor);
	};
	process.on("exit", cleanup);
	process.on("SIGINT", () => {
		cleanup();
		process.exit(130);
	});

	const pickMutex = isParallel ? createMutex() : undefined;
	let nextCycle = 0;
	let totalSpent = 0;
	const results: CycleResult[] = [];
	const RECOVERABLE = new Set(["plan needs rethink", "nothing to pick", "parked"]);

	async function worker(): Promise<void> {
		while (true) {
			const cycle = ++nextCycle;
			if (cycle > cycles) return;
			if (totalSpent >= maxBudget) {
				console.log(`${A.yellow("⚠")} spend ($${totalSpent.toFixed(2)}) exceeds --budget threshold ($${maxBudget.toFixed(2)})`);
			}

			const status: CycleStatus = {
				itemId: items[cycle - 1] ?? "…",
				status: "running",
				cost: 0,
			};
			liveStatus.cycles.push(status);
			if (v) liveStatus.render();

			let logPath: string | undefined;
			if (isParallel && v) {
				mkdirSync(resolve(REPO, ".dev"), { recursive: true });
				logPath = resolve(REPO, ".dev", `autopilot-${cycle}.log`);
				appendFileSync(logPath, `${"=".repeat(60)}\nautopilot cycle ${cycle} — ${new Date().toISOString()}\n${"=".repeat(60)}\n`);
			}

			const result = await runPipeline(
				{
					itemId: items[cycle - 1],
					cycle,
					verbose: !isParallel && v,
					shipTarget,
					dryRun,
					pickMutex,
					workerStatus: status,
					logPath,
					liveStatus,
				},
				parkSignal,
				flags,
			);

			totalSpent += result.cost;
			results.push(result);

			status.itemId = result.itemId ?? "?";
			status.status = resultStatus(result);
			status.cost = result.cost;
			status.step = undefined;
			status.turns = undefined;

			const logRef = logPath ? `  ${A.dim(`→ .dev/autopilot-${cycle}.log`)}` : "";
			console.log(`${resultIcon(result)} cycle ${cycle}: ${A.bold(result.itemId ?? "?")} — $${result.cost.toFixed(2)}${result.error ? `  ${A.dim(result.error)}` : ""}${logRef}`);

			if (v) liveStatus.render();

			if (parkSignal.parked) break;
			if (!result.completed && !RECOVERABLE.has(result.error ?? "")) return;
		}
	}

	await Promise.all(Array.from({ length: Math.min(parallel, cycles) }, () => worker()));

	// ── Park-and-resume ──

	if (parkSignal.parked) {
		if (v) statusBar.teardown();
		if (statusInterval) clearInterval(statusInterval);

		const parkedItems = results.filter((r) => r.error === "parked" && r.itemId).map((r) => r.itemId!);

		if (parkedItems.length === 0) {
			console.log(`${A.yellow("⏸")} Rate limit hit but no items to resume.`);
			process.exit(1);
		}

		const maxWaitMs = parseWaitFlag(flags["max-wait"]);
		const waitMs = parkSignal.resetsAt - Date.now();
		const isWeekly = /week/i.test(parkSignal.limitType);
		const resumeCmd = `pnpm autopilot --item ${parkedItems.join(",")} --verbose`;

		if (waitMs <= 0 || !parkSignal.resetsAt) {
			console.log("");
			console.log(`${A.yellow("⏸")} ${parkSignal.limitType} limit hit — unknown reset time`);
			console.log(`  Parked: ${parkedItems.join(", ")}`);
			console.log(`  Resume: ${A.bold(resumeCmd)}`);
			process.exit(1);
		}

		if (waitMs > maxWaitMs) {
			const label = isWeekly ? "Weekly rate limit" : `${parkSignal.limitType} limit`;
			console.log("");
			console.log(`${A.yellow("⏸")} ${label} — wait ${fmtWait(waitMs)} exceeds --max-wait ${fmtWait(maxWaitMs)}`);
			console.log(`  Parked: ${parkedItems.join(", ")}`);
			console.log(`  Resume: ${A.bold(resumeCmd)}`);
			process.exit(1);
		}

		const eta = new Date(parkSignal.resetsAt + 30_000).toLocaleTimeString("en-CA", { hour12: false });
		console.log("");
		console.log(`${A.yellow("⏸")} ${A.bold("Parked")} — ${parkSignal.limitType} limit, waiting ${fmtWait(waitMs)} (ETA ${eta})`);
		console.log(`  Items: ${parkedItems.join(", ")}`);

		const countdownInterval = setInterval(() => {
			const remaining = parkSignal.resetsAt + 30_000 - Date.now();
			if (remaining > 0) {
				console.log(`  ${A.dim("⏳")} ${fmtWait(remaining)} remaining...`);
			}
		}, 5 * 60_000);

		await new Promise((r) => setTimeout(r, waitMs + 30_000));
		clearInterval(countdownInterval);

		parkSignal.parked = false;
		parkSignal.resetsAt = 0;
		parkSignal.limitType = "";
		parkSignal.triggerWorker = "";
		totalSpent = 0;

		console.log(`\n${A.green("▶")} ${A.bold("Resuming")} ${parkedItems.length} item(s)...`);

		if (v) {
			liveStatus.cycles = [];
			liveStatus.totalCycles = parkedItems.length;
			statusBar.setup();
		}

		const resumeResults = await Promise.all(
			parkedItems.map(async (id, i) => {
				const wt = resolveWorktree(id);
				const sf = detectResumeStep(id, wt);
				const st: CycleStatus = { itemId: id, status: "running", cost: 0 };
				liveStatus.cycles.push(st);
				if (v) liveStatus.render();
				const r = await runPipeline(
					{
						itemId: id,
						worktree: wt,
						startFrom: sf,
						cycle: results.length + i + 1,
						verbose: !isParallel && v,
						shipTarget,
						dryRun: false,
						workerStatus: st,
						logPath:
							isParallel && v
								? (() => {
										const lp = resolve(REPO, ".dev", `autopilot-resume-${id.toLowerCase()}.log`);
										appendFileSync(lp, `${"=".repeat(60)}\nresume ${id} — ${new Date().toISOString()}\n${"=".repeat(60)}\n`);
										return lp;
									})()
								: undefined,
						liveStatus,
					},
					parkSignal,
					flags,
				);
				st.status = resultStatus(r);
				st.cost = r.cost;
				st.step = undefined;
				if (v) liveStatus.render();
				console.log(`${resultIcon(r)} resume ${id} — $${r.cost.toFixed(2)}${r.error ? `  ${A.dim(r.error)}` : ""}`);
				return r;
			}),
		);

		results.push(...resumeResults);
		totalSpent = results.reduce((s, r) => s + r.cost, 0);
	}

	if (v) statusBar.teardown();
	if (statusInterval) clearInterval(statusInterval);
	console.log("");
	console.log(`${A.bold("summary")}  $${totalSpent.toFixed(2)} across ${results.length} cycle(s)${isParallel ? `  ${A.dim("×")}${parallel} parallel` : ""}`);
	for (const r of results) {
		let label: string;
		if (r.completed && r.awaitingMerge) {
			label = `${A.green("↗ PR opened")}${r.prUrl ? ` ${A.dim(r.prUrl)}` : ""}`;
		} else if (r.completed) {
			label = A.green("shipped");
		} else {
			label = A.dim(r.error ?? "failed");
		}
		console.log(`  ${resultIcon(r)} ${r.itemId ?? "?"}: ${label}`);
	}

	process.exit(results.every((r) => r.completed) ? 0 : 1);
}
